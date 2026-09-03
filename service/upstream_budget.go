package service

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"
)

type upstreamReadLimits struct {
	MaxRequests int
	MaxBytes    int64
	Deadline    time.Duration
}

type upstreamReadBudget struct {
	label    string
	limits   upstreamReadLimits
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	requests int
	bytes    int64
}

type upstreamBudgetError struct {
	message string
}

func (e *upstreamBudgetError) Error() string       { return e.message }
func (e *upstreamBudgetError) SafeMessage() string { return e.message }

func newUpstreamReadBudget(parent context.Context, label string, limits upstreamReadLimits) *upstreamReadBudget {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, limits.Deadline)
	return &upstreamReadBudget{label: label, limits: limits, ctx: ctx, cancel: cancel}
}

func (b *upstreamReadBudget) Close() {
	b.cancel()
}

func (b *upstreamReadBudget) Context() context.Context {
	return b.ctx
}

func (b *upstreamReadBudget) Check() error {
	if b.ctx.Err() != nil {
		return &upstreamBudgetError{message: b.label + "超过总体时间限制"}
	}
	return nil
}

func (b *upstreamReadBudget) Transport(base http.RoundTripper) http.RoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	return &upstreamBudgetTransport{base: base, budget: b}
}

func (b *upstreamReadBudget) HTTPClient(base *http.Client) *http.Client {
	client := *base
	client.Transport = b.Transport(base.Transport)
	return &client
}

func (b *upstreamReadBudget) takeRequest() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.requests >= b.limits.MaxRequests {
		return &upstreamBudgetError{message: b.label + "超过总请求数限制"}
	}
	b.requests++
	return nil
}

func (b *upstreamReadBudget) remainingBytes() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.limits.MaxBytes - b.bytes
}

func (b *upstreamReadBudget) addBytes(count int64) {
	b.mu.Lock()
	b.bytes += count
	b.mu.Unlock()
}

func normalizeUpstreamBudgetError(err error) error {
	if err == nil {
		return nil
	}
	var budgetError *upstreamBudgetError
	if errors.As(err, &budgetError) {
		return budgetError
	}
	return err
}

func isUpstreamBudgetError(err error) bool {
	var budgetError *upstreamBudgetError
	return errors.As(err, &budgetError)
}

type upstreamBudgetTransport struct {
	base   http.RoundTripper
	budget *upstreamReadBudget
}

func (t *upstreamBudgetTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if err := t.budget.Check(); err != nil {
		return nil, err
	}
	if err := t.budget.takeRequest(); err != nil {
		return nil, err
	}
	response, err := t.base.RoundTrip(request.Clone(t.budget.Context()))
	if err != nil {
		if budgetErr := t.budget.Check(); budgetErr != nil {
			return nil, budgetErr
		}
		return nil, err
	}
	remaining := t.budget.remainingBytes()
	if response.ContentLength > remaining && response.ContentLength >= 0 {
		_ = response.Body.Close()
		return nil, &upstreamBudgetError{message: t.budget.label + "超过累计响应大小限制"}
	}
	response.Body = &upstreamBudgetBody{ReadCloser: response.Body, budget: t.budget}
	return response, nil
}

type upstreamBudgetBody struct {
	io.ReadCloser
	budget *upstreamReadBudget
}

func (r *upstreamBudgetBody) Read(buffer []byte) (int, error) {
	if len(buffer) == 0 {
		return 0, nil
	}
	if err := r.budget.Check(); err != nil {
		return 0, err
	}
	remaining := r.budget.remainingBytes()
	if remaining <= 0 {
		var probe [1]byte
		count, err := r.ReadCloser.Read(probe[:])
		if count == 0 && errors.Is(err, io.EOF) {
			return 0, io.EOF
		}
		return 0, &upstreamBudgetError{message: r.budget.label + "超过累计响应大小限制"}
	}
	if int64(len(buffer)) > remaining {
		buffer = buffer[:remaining]
	}
	count, err := r.ReadCloser.Read(buffer)
	if count > 0 {
		r.budget.addBytes(int64(count))
	}
	return count, err
}
