package handler

import (
	"fmt"
	"io"
)

const (
	storageUploadMaxBytes        = int64(256 * 1024 * 1024)
	storageUploadRequestMaxBytes = storageUploadMaxBytes + 1024*1024
	canvasTaskRequestMaxBytes    = int64(maxAIRequestBytes)
	adapterReferenceMaxBytes     = int64(32 * 1024 * 1024)
)

func readLimitedRequestBody(reader io.Reader, label string, limit int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("%s超过 %s 限制", label, formatByteLimit(limit))
	}
	return body, nil
}
