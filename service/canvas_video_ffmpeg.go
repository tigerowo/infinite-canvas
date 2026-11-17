package service

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

//go:embed canvas_ffmpeg_assets.txt
var canvasFFmpegAssets string

var canvasFFmpegPreparation = make(chan struct{}, 1)

func PrepareCanvasVideoFFmpeg(ctx context.Context) (string, error) {
	if bundled := os.Getenv("CANVAS_VIDEO_FFMPEG_PATH"); bundled != "" {
		if !filepath.IsAbs(bundled) {
			return "", errors.New("镜像内 FFmpeg 必须使用绝对路径")
		}
		return exec.LookPath(bundled)
	}

	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case canvasFFmpegPreparation <- struct{}{}:
		defer func() { <-canvasFFmpegPreparation }()
	}
	return installCanvasVideoFFmpeg(ctx)
}

func installCanvasVideoFFmpeg(ctx context.Context) (string, error) {
	platform := runtime.GOOS + "/" + runtime.GOARCH
	var asset []string
	for line := range strings.SplitSeq(canvasFFmpegAssets, "\n") {
		if fields := strings.Fields(line); len(fields) == 4 && fields[0] == platform {
			asset = fields
			break
		}
	}
	if asset == nil {
		return "", fmt.Errorf("没有适用于 %s 的精简 FFmpeg", platform)
	}
	size, err := strconv.ParseInt(asset[1], 10, 64)
	if err != nil || size <= 0 {
		return "", errors.New("FFmpeg 发布文件大小无效")
	}
	digest, downloadURL := asset[2], asset[3]
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(cache, "infinite-canvas", "ffmpeg")
	target := filepath.Join(dir, path.Base(downloadURL))
	if canvasFFmpegFileMatches(target, size, digest) {
		if executable, err := exec.LookPath(target); err == nil {
			return executable, nil
		}
		return target, os.Chmod(target, 0700)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return "", err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("下载精简 FFmpeg 返回 HTTP %d", response.StatusCode)
	}

	file, err := os.CreateTemp(dir, ".ffmpeg-*")
	if err != nil {
		return "", err
	}
	temp := file.Name()
	defer os.Remove(temp)
	_, copyErr := io.Copy(file, io.LimitReader(response.Body, size+1))
	if err := errors.Join(copyErr, file.Close()); err != nil {
		return "", err
	}
	if !canvasFFmpegFileMatches(temp, size, digest) {
		return "", errors.New("精简 FFmpeg 发布文件校验失败")
	}
	if err := os.Chmod(temp, 0700); err != nil {
		return "", err
	}
	if err := os.Rename(temp, target); err != nil && !canvasFFmpegFileMatches(target, size, digest) {
		return "", err
	}
	return exec.LookPath(target)
}

func canvasFFmpegFileMatches(filename string, size int64, digest string) bool {
	info, err := os.Stat(filename)
	if err != nil || !info.Mode().IsRegular() || info.Size() != size {
		return false
	}
	file, err := os.Open(filename)
	if err != nil {
		return false
	}
	defer file.Close()
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(file, size+1))
	return err == nil && written == size && fmt.Sprintf("%x", hash.Sum(nil)) == digest
}
