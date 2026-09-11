package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/studio-b12/gowebdav"
	"github.com/tigerowo/infinite-canvas/model"
)

type storageContextTransport struct {
	context context.Context
	base    http.RoundTripper
}

func (t storageContextTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return t.base.RoundTrip(r.WithContext(t.context))
}

func newWebDAVClient(provider model.StorageProvider, requestContext ...context.Context) (*gowebdav.Client, error) {
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
	if len(requestContext) > 0 {
		transport := SafeProxyHTTPClient().Transport
		if transport == nil {
			transport = http.DefaultTransport
		}
		client.SetTransport(storageContextTransport{context: requestContext[0], base: transport})
	}
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

func putWebDAVObject(provider model.StorageProvider, objectKey string, data []byte, requestContext ...context.Context) error {
	client, err := newWebDAVClient(provider, requestContext...)
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

func deleteWebDAVObject(provider model.StorageProvider, objectKey string, requestContext ...context.Context) error {
	client, err := newWebDAVClient(provider, requestContext...)
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

func measureWebDAVProvider(provider model.StorageProvider) (int64, error) {
	client, err := newWebDAVClient(provider)
	if err != nil {
		return 0, err
	}
	root, err := cleanStoragePath(provider.PathPrefix)
	if err != nil {
		return 0, err
	}
	bytes, err := measureWebDAVDirectory(client, root)
	if gowebdav.IsErrNotFound(err) {
		return 0, nil
	}
	return bytes, err
}

func measureWebDAVDirectory(client *gowebdav.Client, directory string) (int64, error) {
	items, err := client.ReadDir(directory)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, item := range items {
		child := path.Join(directory, item.Name())
		if item.IsDir() {
			bytes, err := measureWebDAVDirectory(client, child)
			if err != nil {
				return 0, err
			}
			total += bytes
			continue
		}
		total += item.Size()
	}
	return total, nil
}
