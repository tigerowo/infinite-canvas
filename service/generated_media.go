package service

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const LocalGeneratedMediaProviderID = "local-generated-media"

const (
	generatedImageMaxBytes int64 = 96 << 20
	generatedVideoMaxBytes int64 = 2 << 30
	generatedAudioMaxBytes int64 = 256 << 20
)

var unsafeGeneratedMediaPathChars = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

// ApplicationDataDir returns the writable application data directory shared by
// the backend and the container data mount.
func ApplicationDataDir() string {
	driver := strings.ToLower(strings.TrimSpace(config.Cfg.StorageDriver))
	dsn := strings.TrimSpace(config.Cfg.DatabaseDSN)
	if (driver == "" || driver == "sqlite") && dsn != "" && dsn != ":memory:" && !strings.HasPrefix(dsn, "file:") {
		pathPart := dsn
		if index := strings.Index(pathPart, "?"); index >= 0 {
			pathPart = pathPart[:index]
		}
		if filepath.IsAbs(pathPart) {
			return filepath.Dir(pathPart)
		}
	}
	if _, err := os.Stat("/app/data"); err == nil {
		return "/app/data"
	}
	return "data"
}

func generatedMediaRoot() string {
	return filepath.Join(ApplicationDataDir(), "generated-media")
}

// LocalGeneratedMediaPath resolves a local generated-media object to its file.
// The containment check prevents a corrupted database row from escaping the
// generated-media directory.
func LocalGeneratedMediaPath(object model.StorageObject) (string, bool) {
	if object.ProviderID != LocalGeneratedMediaProviderID {
		return "", false
	}
	root, err := filepath.Abs(generatedMediaRoot())
	if err != nil {
		return "", false
	}
	target, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(object.ObjectKey)))
	if err != nil {
		return "", false
	}
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return target, true
}

// SaveGeneratedMediaBytes persists generated media on the server even when no
// S3/WebDAV provider is configured. Generated results therefore have a stable,
// same-origin URL instead of a large data URL or an expiring provider URL.
func SaveGeneratedMediaBytes(userID, filename, contentType string, data []byte, width, height int) (UploadedStorageObject, error) {
	if len(data) == 0 {
		return UploadedStorageObject{}, errors.New("生成媒体为空")
	}
	contentType = normalizeGeneratedMediaContentType(contentType, data)
	maxBytes := generatedMediaMaxBytes(contentType)
	if int64(len(data)) > maxBytes {
		return UploadedStorageObject{}, fmt.Errorf("生成媒体超过大小限制: %d", maxBytes)
	}
	return saveGeneratedMediaReader(userID, filename, contentType, bytesReader(data), int64(len(data)), maxBytes, width, height)
}

// CacheRemoteGeneratedMedia downloads a provider result exactly once and
// exposes it through the local immutable file endpoint. The long timeout is
// intentional because some provider output hosts are slow or unreliable.
func CacheRemoteGeneratedMedia(ctx context.Context, userID, rawURL, mediaKind string) (UploadedStorageObject, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return UploadedStorageObject{}, errors.New("生成媒体地址无效")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return UploadedStorageObject{}, err
	}
	request.Header.Set("User-Agent", "Mozilla/5.0 InfiniteCanvas/1.0")
	request.Header.Set("Accept", mediaAcceptHeader(mediaKind))
	client := *SafeProxyHTTPClient()
	client.Timeout = 30 * time.Minute
	response, err := client.Do(request)
	if err != nil {
		return UploadedStorageObject{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return UploadedStorageObject{}, fmt.Errorf("下载生成媒体失败: %s %s", response.Status, strings.TrimSpace(string(body)))
	}
	reader := bufio.NewReader(response.Body)
	peek, _ := reader.Peek(512)
	contentType := normalizeGeneratedMediaContentType(response.Header.Get("Content-Type"), peek)
	if !generatedMediaKindMatches(mediaKind, contentType) {
		return UploadedStorageObject{}, fmt.Errorf("生成媒体类型不匹配: %s", contentType)
	}
	maxBytes := generatedMediaMaxBytes(contentType)
	if response.ContentLength > maxBytes {
		return UploadedStorageObject{}, fmt.Errorf("生成媒体超过大小限制: %d", maxBytes)
	}
	filename := filepath.Base(parsed.Path)
	return saveGeneratedMediaReader(userID, filename, contentType, reader, response.ContentLength, maxBytes, 0, 0)
}

func DeleteLocalGeneratedMedia(object model.StorageObject) error {
	path, ok := LocalGeneratedMediaPath(object)
	if !ok {
		return errors.New("本地生成媒体路径无效")
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return repository.DeleteStorageObjectRecord(object.ID)
}

func saveGeneratedMediaReader(userID, filename, contentType string, reader io.Reader, expectedBytes, maxBytes int64, width, height int) (UploadedStorageObject, error) {
	objectID := uuid.NewString()
	ext := generatedMediaExtension(filename, contentType)
	createdBy := strings.TrimSpace(userID)
	if createdBy == "" {
		createdBy = "anonymous"
	}
	owner := sanitizeGeneratedMediaPathPart(createdBy)
	if owner == "" {
		owner = "anonymous"
	}
	objectKey := filepath.ToSlash(filepath.Join(owner, time.Now().UTC().Format("2006/01/02"), objectID+ext))
	object := model.StorageObject{
		ID:         objectID,
		ProviderID: LocalGeneratedMediaProviderID,
		ObjectKey:  objectKey,
		MimeType:   contentType,
		Width:      width,
		Height:     height,
		CreatedBy:  createdBy,
		CreatedAt:  now(),
	}
	targetPath, ok := LocalGeneratedMediaPath(object)
	if !ok {
		return UploadedStorageObject{}, errors.New("生成媒体路径无效")
	}
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return UploadedStorageObject{}, err
	}
	tempPath := targetPath + ".part-" + uuid.NewString()
	target, err := os.OpenFile(tempPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return UploadedStorageObject{}, err
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(target, hash), io.LimitReader(reader, maxBytes+1))
	closeErr := target.Close()
	if copyErr != nil || closeErr != nil || written <= 0 || written > maxBytes {
		_ = os.Remove(tempPath)
		if copyErr != nil {
			return UploadedStorageObject{}, copyErr
		}
		if closeErr != nil {
			return UploadedStorageObject{}, closeErr
		}
		if written > maxBytes {
			return UploadedStorageObject{}, fmt.Errorf("生成媒体超过大小限制: %d", maxBytes)
		}
		return UploadedStorageObject{}, errors.New("生成媒体为空")
	}
	if expectedBytes > 0 && written != expectedBytes {
		_ = os.Remove(tempPath)
		return UploadedStorageObject{}, fmt.Errorf("生成媒体下载不完整: expected=%d actual=%d", expectedBytes, written)
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		_ = os.Remove(tempPath)
		return UploadedStorageObject{}, err
	}
	object.Bytes = written
	object.SHA256 = hex.EncodeToString(hash.Sum(nil))
	if _, err := repository.SaveStorageObject(object); err != nil {
		_ = os.Remove(targetPath)
		return UploadedStorageObject{}, err
	}
	return UploadedStorageObject{
		ID:         objectID,
		URL:        "/api/files/" + objectID + "/content",
		StorageKey: "server:" + objectID,
		Bytes:      written,
		MimeType:   contentType,
	}, nil
}

func normalizeGeneratedMediaContentType(contentType string, sample []byte) string {
	contentType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(sample), ";")[0]))
	if strings.HasPrefix(detected, "image/") || strings.HasPrefix(detected, "video/") || strings.HasPrefix(detected, "audio/") {
		contentType = detected
	} else if contentType == "" || contentType == "application/octet-stream" || contentType == "binary/octet-stream" {
		contentType = detected
	}
	switch contentType {
	case "image/jpg":
		return "image/jpeg"
	case "audio/mp3":
		return "audio/mpeg"
	case "video/mov":
		return "video/quicktime"
	}
	return contentType
}

func generatedMediaExtension(filename, contentType string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	if normalized := extensionForContentType(contentType); normalized != ".bin" {
		return normalized
	}
	if len(ext) > 1 && len(ext) <= 8 && unsafeGeneratedMediaPathChars.ReplaceAllString(ext, "") == ext {
		return ext
	}
	return ".bin"
}

func generatedMediaMaxBytes(contentType string) int64 {
	switch {
	case strings.HasPrefix(contentType, "video/"):
		return generatedVideoMaxBytes
	case strings.HasPrefix(contentType, "audio/"):
		return generatedAudioMaxBytes
	default:
		return generatedImageMaxBytes
	}
}

func generatedMediaKindMatches(kind, contentType string) bool {
	kind = strings.ToLower(strings.TrimSpace(kind))
	if kind == "" || kind == "media" {
		return strings.HasPrefix(contentType, "image/") || strings.HasPrefix(contentType, "video/") || strings.HasPrefix(contentType, "audio/")
	}
	return strings.HasPrefix(contentType, kind+"/")
}

func mediaAcceptHeader(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image":
		return "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.9,*/*;q=0.1"
	case "video":
		return "video/mp4,video/quicktime,video/*;q=0.9,*/*;q=0.1"
	case "audio":
		return "audio/*;q=0.9,*/*;q=0.1"
	default:
		return "*/*"
	}
}

func sanitizeGeneratedMediaPathPart(value string) string {
	value = unsafeGeneratedMediaPathChars.ReplaceAllString(strings.TrimSpace(value), "-")
	return strings.Trim(value, ".-")
}

// bytesReader keeps the generated-media writer testable without exposing its
// internal path layout.
func bytesReader(data []byte) io.Reader {
	return bytes.NewReader(data)
}
