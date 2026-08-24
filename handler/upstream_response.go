package handler

import (
	"context"
	"fmt"
	"io"
	"time"
)

const (
	structuredAdapterResponseLimit = int64(8 * 1024 * 1024)
	mimoTTSResponseLimit           = int64(128 * 1024 * 1024)
	generatedMediaResponseLimit    = int64(512 * 1024 * 1024)
	pollResponseLimit              = int64(512 * 1024)
	pollResponseTotalLimit         = int64(32 * 1024 * 1024)
	pollRequestLimit               = 300
	pollDeadline                   = 10 * time.Minute
)

type upstreamResponseBudget struct {
	ctx         context.Context
	cancel      context.CancelFunc
	label       string
	maxRequests int
	requests    int
	maxBytes    int64
	bytes       int64
}

func newUpstreamResponseBudget(parent context.Context, label string, maxRequests int, maxBytes int64, deadline time.Duration) *upstreamResponseBudget {
	if parent == nil {
		parent = context.Background()
	}
	ctx := parent
	cancel := func() {}
	if deadline > 0 {
		ctx, cancel = context.WithTimeout(parent, deadline)
	}
	return &upstreamResponseBudget{
		ctx:         ctx,
		cancel:      cancel,
		label:       label,
		maxRequests: maxRequests,
		maxBytes:    maxBytes,
	}
}

func (budget *upstreamResponseBudget) Close() {
	if budget != nil && budget.cancel != nil {
		budget.cancel()
	}
}

func (budget *upstreamResponseBudget) Context() context.Context {
	if budget == nil || budget.ctx == nil {
		return context.Background()
	}
	return budget.ctx
}

func (budget *upstreamResponseBudget) NextRequest() error {
	if err := budget.Context().Err(); err != nil {
		return fmt.Errorf("%s 超过总体 deadline: %w", budget.label, err)
	}
	if budget.maxRequests > 0 && budget.requests >= budget.maxRequests {
		return fmt.Errorf("%s 超过总请求数限制 %d", budget.label, budget.maxRequests)
	}
	budget.requests++
	return nil
}

func (budget *upstreamResponseBudget) ReadAll(reader io.Reader, perResponseLimit int64) ([]byte, error) {
	if err := budget.Context().Err(); err != nil {
		return nil, fmt.Errorf("%s 超过总体 deadline: %w", budget.label, err)
	}
	limit := perResponseLimit
	if budget.maxBytes > 0 {
		remaining := budget.maxBytes - budget.bytes
		if remaining <= 0 {
			return nil, fmt.Errorf("%s 超过累计响应体 %s 限制", budget.label, formatByteLimit(budget.maxBytes))
		}
		if limit <= 0 || remaining < limit {
			limit = remaining
		}
	}
	if limit <= 0 {
		return nil, fmt.Errorf("%s 响应体读取限制无效", budget.label)
	}
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	budget.bytes += int64(len(body))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		if budget.maxBytes > 0 && budget.bytes > budget.maxBytes {
			return nil, fmt.Errorf("%s 超过累计响应体 %s 限制", budget.label, formatByteLimit(budget.maxBytes))
		}
		return nil, fmt.Errorf("%s 单次响应体超过 %s 限制", budget.label, formatByteLimit(perResponseLimit))
	}
	return body, nil
}

func readLimitedUpstreamResponse(reader io.Reader, label string, limit int64) ([]byte, error) {
	budget := newUpstreamResponseBudget(context.Background(), label, 1, limit, 0)
	defer budget.Close()
	if err := budget.NextRequest(); err != nil {
		return nil, err
	}
	return budget.ReadAll(reader, limit)
}

func copyLimitedUpstreamResponse(writer io.Writer, reader io.Reader, limit int64) (int64, bool, error) {
	if limit < 0 {
		return 0, false, fmt.Errorf("响应体读取限制无效")
	}
	buffer := make([]byte, 32*1024)
	var total int64
	for {
		remaining := limit - total
		readBuffer := buffer
		if remaining < int64(len(buffer)) {
			readBuffer = buffer[:remaining+1]
		}
		n, readErr := reader.Read(readBuffer)
		if n > 0 {
			writeBytes := n
			if int64(writeBytes) > remaining {
				writeBytes = int(remaining)
			}
			written, writeErr := writer.Write(buffer[:writeBytes])
			total += int64(written)
			if writeErr != nil {
				return total, false, writeErr
			}
			if written != writeBytes {
				return total, false, io.ErrShortWrite
			}
			if writeBytes < n {
				return total, true, nil
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				return total, false, nil
			}
			return total, false, readErr
		}
	}
}

func formatByteLimit(bytes int64) string {
	if bytes%(1024*1024) == 0 {
		return fmt.Sprintf("%d MiB", bytes/(1024*1024))
	}
	if bytes%1024 == 0 {
		return fmt.Sprintf("%d KiB", bytes/1024)
	}
	return fmt.Sprintf("%d bytes", bytes)
}
