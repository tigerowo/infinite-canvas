package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
)

const MaxCanvasAnalysisVideoBytes = 100_000_000

var (
	ErrCanvasVideoSourceUnavailable = errors.New("Go 无法直接读取该视频来源")
	ErrCanvasVideoAnalysisNotFound  = errors.New("视频分析已结束或不存在")
	ErrCanvasVideoAnalysisBusy      = errors.New("该视频分析任务正在取帧，请稍后再试")
	ErrCanvasVideoTooLarge          = errors.New("视频文件超过 100 MB")
	ErrCanvasVideoSourceForm        = errors.New("每次分析只提交一个视频来源")
	ErrCanvasVideoNoDecoder         = errors.New("服务端未能准备视频分析所需的精简 FFmpeg")
	canvasVideoAnalyses             sync.Map
	canvasVideoContentPath          = regexp.MustCompile(`^/api/files/([a-zA-Z0-9_-]+)/content$`)
)

type CanvasVideoAnalysis struct {
	ID         string `json:"id"`
	DurationMs int64  `json:"durationMs"`
}

type canvasVideoAnalysis struct {
	owner      string
	dir        string
	input      string
	ffmpeg     string
	durationMs int64
	ctx        context.Context
	cancel     context.CancelFunc
	mu         sync.Mutex
}

func StartCanvasVideoAnalysis(
	ctx context.Context, upload io.Reader, videoURL string, verifyUploadEnd func() error,
) (CanvasVideoAnalysis, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return CanvasVideoAnalysis{}, ErrCanvasVideoAnalysisNotFound
	}
	ffmpeg, err := PrepareCanvasVideoFFmpeg(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return CanvasVideoAnalysis{}, ctx.Err()
		}
		return CanvasVideoAnalysis{}, fmt.Errorf("%w: %v", ErrCanvasVideoNoDecoder, err)
	}
	dir, err := os.MkdirTemp("", "canvas-video-analysis-")
	if err != nil {
		return CanvasVideoAnalysis{}, errors.New("无法创建视频分析临时目录")
	}
	published := false
	defer func() {
		if !published {
			_ = os.RemoveAll(dir)
		}
	}()

	input := filepath.Join(dir, "input.media")
	if upload == nil {
		source, err := openCanvasVideoAnalysisURL(ctx, videoURL)
		if err != nil {
			return CanvasVideoAnalysis{}, err
		}
		defer source.Close()
		stop := context.AfterFunc(ctx, func() { _ = source.Close() })
		defer stop()
		upload = source
	}

	file, err := os.Create(input)
	if err != nil {
		return CanvasVideoAnalysis{}, errors.New("无法写入视频分析临时文件")
	}
	bytes, copyErr := io.Copy(file, io.LimitReader(upload, MaxCanvasAnalysisVideoBytes+1))
	closeErr := file.Close()
	if copyErr != nil {
		var diskErr *os.PathError
		if videoURL != "" && ctx.Err() == nil && !errors.As(copyErr, &diskErr) {
			return CanvasVideoAnalysis{}, ErrCanvasVideoSourceUnavailable
		}
		return CanvasVideoAnalysis{}, copyErr
	}
	if closeErr != nil || bytes == 0 {
		return CanvasVideoAnalysis{}, errors.New("视频文件为空或写入失败")
	}
	if bytes > MaxCanvasAnalysisVideoBytes {
		return CanvasVideoAnalysis{}, ErrCanvasVideoTooLarge
	}
	if verifyUploadEnd != nil {
		if err := verifyUploadEnd(); err != nil {
			return CanvasVideoAnalysis{}, err
		}
	}

	deadline := time.Now().Add(20 * time.Minute)
	probeCtx, cancelProbe := context.WithDeadline(ctx, deadline)
	durationMs, err := readCanvasVideoDuration(probeCtx, ffmpeg, input)
	cancelProbe()
	if err != nil {
		return CanvasVideoAnalysis{}, err
	}
	if err := ctx.Err(); err != nil {
		return CanvasVideoAnalysis{}, err
	}

	taskCtx, cancel := context.WithDeadline(context.Background(), deadline)
	if err := taskCtx.Err(); err != nil {
		cancel()
		return CanvasVideoAnalysis{}, err
	}
	id := uuid.NewString()
	task := &canvasVideoAnalysis{
		owner: user.ID, dir: dir, input: input, ffmpeg: ffmpeg, durationMs: durationMs,
		ctx: taskCtx, cancel: cancel,
	}
	canvasVideoAnalyses.Store(id, task)
	published = true
	context.AfterFunc(taskCtx, func() { task.close(id) })
	return CanvasVideoAnalysis{ID: id, DurationMs: durationMs}, nil
}

func openCanvasVideoAnalysisURL(ctx context.Context, raw string) (io.ReadCloser, error) {
	if match := canvasVideoContentPath.FindStringSubmatch(raw); match != nil {
		object, err := DownloadStorageObject(match[1], "")
		if err != nil {
			return nil, ErrCanvasVideoSourceUnavailable
		}
		return object.Stream, nil
	}

	address, err := url.Parse(raw)
	if err != nil || address.Host == "" || address.User != nil ||
		(address.Scheme != "http" && address.Scheme != "https") {
		return nil, errors.New("仅支持有效的 HTTP(S) 视频地址")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address.String(), nil)
	if err != nil {
		return nil, ErrCanvasVideoSourceUnavailable
	}
	response, err := SafeProxyHTTPClient().Do(request)
	if err != nil {
		return nil, ErrCanvasVideoSourceUnavailable
	}
	if response.StatusCode != http.StatusOK {
		_ = response.Body.Close()
		return nil, ErrCanvasVideoSourceUnavailable
	}
	if response.ContentLength > MaxCanvasAnalysisVideoBytes {
		_ = response.Body.Close()
		return nil, ErrCanvasVideoTooLarge
	}
	return response.Body, nil
}

func CanUseCanvasVideoAnalysis(id string, userID string) bool {
	value, exists := canvasVideoAnalyses.Load(id)
	if !exists {
		return false
	}
	task := value.(*canvasVideoAnalysis)
	return task.owner == userID && task.ctx.Err() == nil
}

func CloseCanvasVideoAnalysis(ctx context.Context, id string) {
	user, ok := UserFromContext(ctx)
	value, exists := canvasVideoAnalyses.Load(id)
	if ok && exists && value.(*canvasVideoAnalysis).owner == user.ID {
		value.(*canvasVideoAnalysis).close(id)
	}
}

func (task *canvasVideoAnalysis) close(id string) {
	if !canvasVideoAnalyses.CompareAndDelete(id, task) {
		return
	}
	task.cancel()
	task.mu.Lock()
	defer task.mu.Unlock()
	_ = os.RemoveAll(task.dir)
}

var canvasVideoDuration = regexp.MustCompile(`(?m)^  Duration: (\d+):(\d{2}):(\d{2}\.\d{2}),`)

func readCanvasVideoDuration(ctx context.Context, ffmpeg, input string) (int64, error) {
	cmd := exec.CommandContext(ctx, ffmpeg,
		"-hide_banner", "-nostdin", "-loglevel", "info", "-xerror", "-nostats",
		"-protocol_whitelist", "file", "-format_whitelist", "mov", "-i", input,
		"-map", "0:V:0", "-an", "-sn", "-dn", "-c:v", "copy", "-frames:v", "0",
		"-f", "null", "-",
	)
	var logs bytes.Buffer
	cmd.Stderr = &logs
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		if errors.Is(err, os.ErrNotExist) {
			return 0, ErrCanvasVideoNoDecoder
		}
		return 0, errors.New("无法读取视频轨或当前视频编码不受支持")
	}

	match := canvasVideoDuration.FindStringSubmatch(logs.String())
	if match == nil {
		return 0, errors.New("无法读取视频时长")
	}
	duration, err := time.ParseDuration(match[1] + "h" + match[2] + "m" + match[3] + "s")
	if err != nil {
		return 0, errors.New("视频时长无效")
	}
	// FFmpeg 四舍五入到百分之一秒。留出 5 毫秒，避免舍入向下时少取末帧。
	return duration.Milliseconds() + 5, nil
}

type CanvasVideoFrameWindow struct {
	StartMs         int64  `json:"startMs"`
	EndMs           int64  `json:"endMs"`
	Original        bool   `json:"original"`
	Detailed        bool   `json:"detailed"`
	PreviousFrameUs *int64 `json:"previousFrameUs"`
}

type CanvasVideoAnalysisFrame struct {
	TimestampMs int64  `json:"timestampMs"`
	JPEG        []byte `json:"jpeg"`
	Digest      string `json:"digest"`
}

type CanvasVideoAnalysisBatch struct {
	Frames      []CanvasVideoAnalysisFrame `json:"frames"`
	NextMs      *int64                     `json:"nextMs"`
	LastFrameUs *int64                     `json:"lastFrameUs"`
}

func ReadCanvasVideoAnalysisFrames(
	ctx context.Context, id string, window CanvasVideoFrameWindow,
) (CanvasVideoAnalysisBatch, error) {
	user, ok := UserFromContext(ctx)
	value, exists := canvasVideoAnalyses.Load(id)
	if !ok || !exists || value.(*canvasVideoAnalysis).owner != user.ID {
		return CanvasVideoAnalysisBatch{}, ErrCanvasVideoAnalysisNotFound
	}
	task := value.(*canvasVideoAnalysis)
	if window.StartMs < 0 || window.EndMs <= window.StartMs ||
		window.EndMs > task.durationMs || window.EndMs-window.StartMs > 4000 ||
		(window.Original && window.EndMs-window.StartMs > 250) ||
		(window.PreviousFrameUs != nil && *window.PreviousFrameUs < 0) {
		return CanvasVideoAnalysisBatch{}, errors.New("无效的视频取帧区间")
	}
	if !task.mu.TryLock() {
		return CanvasVideoAnalysisBatch{}, ErrCanvasVideoAnalysisBusy
	}
	defer task.mu.Unlock()
	if task.ctx.Err() != nil {
		return CanvasVideoAnalysisBatch{}, ErrCanvasVideoAnalysisNotFound
	}
	return task.extractFrames(ctx, window)
}

var canvasVideoFramePTS = regexp.MustCompile(`\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:`)

func (task *canvasVideoAnalysis) extractFrames(
	ctx context.Context, window CanvasVideoFrameWindow,
) (CanvasVideoAnalysisBatch, error) {
	const maxFrames = 24
	const maxFrameBytes = 512 << 10
	const maxBatchBytes = 12 << 20
	spacingUs := 1_000_000
	if window.Detailed {
		spacingUs = 500_000
	}
	first := "1"
	if window.PreviousFrameUs != nil {
		first = fmt.Sprintf("gte(pts-%d,%d)", *window.PreviousFrameUs, spacingUs)
	}
	pick := fmt.Sprintf("if(isnan(prev_selected_pts),%s,gte(pts-prev_selected_pts,%d))", first, spacingUs)
	if !window.Original {
		pick += "*(isnan(prev_selected_pts)+gte(scene,0.1))"
	}
	start := strconv.FormatInt(window.StartMs, 10) + "ms"
	end := strconv.FormatInt(window.EndMs, 10) + "ms"
	// Match the requested millisecond boundaries on FFmpeg's microsecond time base.
	filter := fmt.Sprintf(
		"settb=AVTB,trim=start=%s:end=%s,select='%s',trim=end_frame=%d,scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p,showinfo=checksum=0",
		start, end, pick, maxFrames+1,
	)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(task.ctx, cancel)
	defer stop()
	cmd := exec.CommandContext(ctx, task.ffmpeg,
		"-hide_banner", "-nostdin", "-loglevel", "info", "-xerror", "-nostats",
		"-copyts", "-start_at_zero", "-protocol_whitelist", "file",
		"-format_whitelist", "mov", "-threads", "2",
		"-ss", start, "-i", task.input,
		"-map", "0:V:0", "-an", "-sn", "-dn", "-filter_threads", "1",
		"-vf", filter, "-fps_mode", "passthrough",
		"-c:v", "mjpeg", "-threads", "2", "-q:v", "5",
		"-f", "mpjpeg", "-boundary_tag", "canvas_frame", "pipe:1",
	)

	var logs bytes.Buffer
	cmd.Stderr = &logs
	output, err := cmd.StdoutPipe()
	if err != nil {
		return CanvasVideoAnalysisBatch{}, err
	}
	if err = cmd.Start(); err != nil {
		_ = output.Close()
		return CanvasVideoAnalysisBatch{}, err
	}
	waited := false
	defer func() {
		if !waited {
			cancel()
			_ = output.Close()
			_ = cmd.Wait()
		}
	}()

	reader := multipart.NewReader(output, "canvas_frame")
	frames := make([]CanvasVideoAnalysisFrame, 0, maxFrames+1)
	totalBytes := 0
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return CanvasVideoAnalysisBatch{}, errors.New("FFmpeg 图片输出异常")
		}
		jpeg, err := io.ReadAll(io.LimitReader(part, maxFrameBytes+1))
		if err != nil {
			return CanvasVideoAnalysisBatch{}, err
		}
		totalBytes += len(jpeg)
		if len(jpeg) < 4 || len(jpeg) > maxFrameBytes ||
			totalBytes > maxBatchBytes || len(frames) > maxFrames {
			return CanvasVideoAnalysisBatch{}, errors.New("视频帧超过单批输出限制")
		}
		frames = append(frames, CanvasVideoAnalysisFrame{
			JPEG:   jpeg,
			Digest: fmt.Sprintf("%x", sha256.Sum256(jpeg)),
		})
	}
	err = cmd.Wait()
	waited = true
	if err != nil {
		if ctx.Err() != nil {
			return CanvasVideoAnalysisBatch{}, ctx.Err()
		}
		return CanvasVideoAnalysisBatch{}, errors.New("FFmpeg 取帧失败")
	}

	timestamps := canvasVideoFramePTS.FindAllStringSubmatch(logs.String(), -1)
	if len(timestamps) != len(frames) {
		return CanvasVideoAnalysisBatch{}, errors.New("视频帧与时间戳数量不匹配")
	}
	batch := CanvasVideoAnalysisBatch{Frames: frames}
	for index, match := range timestamps {
		pts, err := strconv.ParseInt(match[1], 10, 64)
		if err != nil || pts < 0 {
			return CanvasVideoAnalysisBatch{}, errors.New("视频帧时间戳无效")
		}
		frames[index].TimestampMs = pts / 1_000
		if index == min(len(frames), maxFrames)-1 {
			batch.LastFrameUs = &pts
		}
	}

	if len(frames) > maxFrames {
		nextMs := frames[maxFrames].TimestampMs
		if nextMs <= window.StartMs || nextMs >= window.EndMs {
			return CanvasVideoAnalysisBatch{}, errors.New("视频帧需要更小的取帧区间")
		}
		batch.Frames = frames[:maxFrames]
		batch.NextMs = &nextMs
	}
	return batch, nil
}
