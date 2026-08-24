package service

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/studio-b12/gowebdav"
	"github.com/tigerowo/infinite-canvas/model"
)

var storageMeasureReadLimits = upstreamReadLimits{
	MaxRequests: 256,
	MaxBytes:    64 * 1024 * 1024,
	Deadline:    2 * time.Minute,
}

func newWebDAVClient(provider model.StorageProvider) (*gowebdav.Client, error) {
	parsed, err := url.Parse(strings.TrimSpace(provider.Endpoint))
	if err != nil || parsed.Host == "" {
		return nil, errors.New("WebDAV 地址无效")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("WebDAV 地址只支持 HTTP 或 HTTPS")
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return nil, errors.New("WebDAV 地址不能包含账号、密码或片段")
	}
	client := gowebdav.NewClient(strings.TrimRight(parsed.String(), "/"), provider.Username, provider.Password)
	client.SetTransport(SafeProxyHTTPClient().Transport)
	client.SetTimeout(5 * time.Minute)
	return client, nil
}

func cleanStoragePath(value string) (string, error) {
	parts := strings.Split(strings.Trim(value, "/"), "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return "", errors.New("远程目录格式不正确")
		}
	}
	return strings.Join(parts, "/"), nil
}

func putWebDAVObject(provider model.StorageProvider, objectKey string, data []byte) error {
	client, err := newWebDAVClient(provider)
	if err != nil {
		return err
	}
	remotePath, err := cleanStoragePath(objectKey)
	if err != nil {
		return err
	}
	if err := client.MkdirAll(path.Dir(remotePath), 0o755); err != nil {
		return err
	}
	return client.Write(remotePath, data, 0o644)
}

func getWebDAVObjectStream(provider model.StorageProvider, objectKey string, size int64, rangeHeader string) (storageObjectStream, error) {
	client, err := newWebDAVClient(provider)
	if err != nil {
		return storageObjectStream{}, err
	}
	remotePath, err := cleanStoragePath(objectKey)
	if err != nil {
		return storageObjectStream{}, err
	}
	if byteRange, ok := parseStorageByteRange(rangeHeader, size); ok {
		stream, rangeErr := client.ReadStreamRange(remotePath, byteRange.offset, byteRange.length)
		if rangeErr == nil {
			return storageObjectStream{
				Body: stream, StatusCode: 206, ContentLength: byteRange.length,
				ContentRange: fmt.Sprintf("bytes %d-%d/%d", byteRange.offset, byteRange.offset+byteRange.length-1, size), AcceptRanges: true,
			}, nil
		}
	}
	stream, err := client.ReadStream(remotePath)
	if err != nil {
		return storageObjectStream{}, err
	}
	return storageObjectStream{Body: stream, StatusCode: 200, ContentLength: size, AcceptRanges: true}, nil
}

func deleteWebDAVObject(provider model.StorageProvider, objectKey string) error {
	client, err := newWebDAVClient(provider)
	if err != nil {
		return err
	}
	remotePath, err := cleanStoragePath(objectKey)
	if err != nil {
		return err
	}
	if err := client.Remove(remotePath); err != nil && !gowebdav.IsErrNotFound(err) {
		return err
	}

	root, err := cleanStoragePath(provider.PathPrefix)
	if err != nil {
		return err
	}
	for directory := path.Dir(remotePath); directory != root && strings.HasPrefix(directory, root+"/"); directory = path.Dir(directory) {
		items, err := client.ReadDir(directory)
		if err != nil || len(items) != 0 {
			break
		}
		if err := client.Remove(directory); err != nil {
			break
		}
	}
	return nil
}

func measureWebDAVProvider(ctx context.Context, provider model.StorageProvider) (int64, error) {
	budget := newUpstreamReadBudget(ctx, "WebDAV 容量统计", storageMeasureReadLimits)
	defer budget.Close()
	client, err := newWebDAVClient(provider)
	if err != nil {
		return 0, err
	}
	client.SetTransport(budget.Transport(SafeProxyHTTPClient().Transport))
	root, err := cleanStoragePath(provider.PathPrefix)
	if err != nil {
		return 0, err
	}
	bytes, err := measureWebDAVDirectory(budget, client, root)
	if gowebdav.IsErrNotFound(err) {
		return 0, nil
	}
	return bytes, normalizeUpstreamBudgetError(err)
}

func measureWebDAVDirectory(budget *upstreamReadBudget, client *gowebdav.Client, root string) (int64, error) {
	pending := []string{root}
	seen := map[string]bool{root: true}
	var total int64
	for len(pending) > 0 {
		if err := budget.Check(); err != nil {
			return 0, err
		}
		directory := pending[0]
		pending = pending[1:]
		items, err := client.ReadDir(directory)
		if err != nil {
			return 0, err
		}
		if err := budget.Check(); err != nil {
			return 0, err
		}
		for _, item := range items {
			name := strings.TrimSpace(item.Name())
			if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\") {
				return 0, errors.New("WebDAV 返回了无效对象路径")
			}
			child := path.Join(directory, name)
			if item.IsDir() {
				if !seen[child] {
					seen[child] = true
					pending = append(pending, child)
				}
				continue
			}
			if item.Size() < 0 || total > math.MaxInt64-item.Size() {
				return 0, errors.New("WebDAV 返回了无效容量")
			}
			if item.Size() > 0 {
				total += item.Size()
			}
		}
	}
	if err := budget.Check(); err != nil {
		return 0, err
	}
	return total, nil
}
