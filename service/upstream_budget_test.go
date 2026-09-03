package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestUpstreamReadBudgetLimitsAggregateRequests(t *testing.T) {
	var calls atomic.Int32
	base := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("ok")), ContentLength: 2, Header: http.Header{}}, nil
	})}
	budget := newUpstreamReadBudget(context.Background(), "测试读取", upstreamReadLimits{MaxRequests: 2, MaxBytes: 32, Deadline: time.Second})
	defer budget.Close()
	client := budget.HTTPClient(base)
	for index := 0; index < 2; index++ {
		response, err := client.Get("https://example.test/data")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.ReadAll(response.Body)
		_ = response.Body.Close()
	}
	if _, err := client.Get("https://example.test/data"); !isUpstreamBudgetError(err) || !strings.Contains(err.Error(), "总请求数") {
		t.Fatalf("third request error = %v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("underlying calls = %d, want 2", calls.Load())
	}
}

func TestUpstreamReadBudgetLimitsAggregateBytes(t *testing.T) {
	base := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("abcd")), ContentLength: -1, Header: http.Header{}}, nil
	})}
	budget := newUpstreamReadBudget(context.Background(), "测试读取", upstreamReadLimits{MaxRequests: 2, MaxBytes: 3, Deadline: time.Second})
	defer budget.Close()
	response, err := budget.HTTPClient(base).Get("https://example.test/data")
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if string(data) != "abc" || !isUpstreamBudgetError(err) || !strings.Contains(err.Error(), "累计响应大小") {
		t.Fatalf("data=%q error=%v", data, err)
	}
}

func TestUpstreamReadBudgetAllowsExactByteLimit(t *testing.T) {
	base := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("abc")), ContentLength: -1, Header: http.Header{}}, nil
	})}
	budget := newUpstreamReadBudget(context.Background(), "测试读取", upstreamReadLimits{MaxRequests: 1, MaxBytes: 3, Deadline: time.Second})
	defer budget.Close()
	response, err := budget.HTTPClient(base).Get("https://example.test/data")
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || string(data) != "abc" {
		t.Fatalf("data=%q error=%v", data, err)
	}
}

func TestUpstreamReadBudgetHonorsParentCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	budget := newUpstreamReadBudget(ctx, "测试读取", upstreamReadLimits{MaxRequests: 1, MaxBytes: 1, Deadline: time.Minute})
	defer budget.Close()
	if err := budget.Check(); !isUpstreamBudgetError(err) || !strings.Contains(err.Error(), "总体时间") {
		t.Fatalf("budget check error = %v", err)
	}
}

func TestMeasureS3ProviderStopsAtTotalRequestBudget(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := calls.Add(1)
		w.Header().Set("Content-Type", "application/xml")
		_, _ = io.WriteString(w, `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>page-`+string(rune('0'+call))+`</NextContinuationToken><Contents><Size>5</Size></Contents></ListBucketResult>`)
	}))
	defer server.Close()

	previousClient := safeProxyHTTPClient
	previousLimits := storageMeasureReadLimits
	safeProxyHTTPClient = server.Client()
	storageMeasureReadLimits = upstreamReadLimits{MaxRequests: 2, MaxBytes: 4096, Deadline: time.Second}
	t.Cleanup(func() {
		safeProxyHTTPClient = previousClient
		storageMeasureReadLimits = previousLimits
	})

	_, err := measureS3Provider(context.Background(), model.StorageProvider{
		Endpoint: server.URL, Bucket: "bucket", Region: "auto",
		AccessKeyID: "test-access", SecretAccessKey: "test-credential",
	})
	if !isUpstreamBudgetError(err) || !strings.Contains(err.Error(), "总请求数") {
		t.Fatalf("measure error = %v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("server calls = %d, want 2", calls.Load())
	}
}

func TestMeasureWebDAVProviderStopsAtTotalRequestBudget(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		child := strings.TrimRight(r.URL.Path, "/") + "/child/"
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusMultiStatus)
		_, _ = fmt.Fprintf(w, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>%s/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getcontentlength>0</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>%s</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getcontentlength>0</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, strings.TrimRight(r.URL.Path, "/"), child)
	}))
	defer server.Close()

	previousClient := safeProxyHTTPClient
	previousLimits := storageMeasureReadLimits
	safeProxyHTTPClient = server.Client()
	storageMeasureReadLimits = upstreamReadLimits{MaxRequests: 2, MaxBytes: 4096, Deadline: time.Second}
	t.Cleanup(func() {
		safeProxyHTTPClient = previousClient
		storageMeasureReadLimits = previousLimits
	})

	_, err := measureWebDAVProvider(context.Background(), model.StorageProvider{
		Endpoint: server.URL + "/webdav", PathPrefix: "root",
		Username: "test-user", Password: "test-credential",
	})
	if !isUpstreamBudgetError(err) || !strings.Contains(err.Error(), "总请求数") {
		t.Fatalf("measure error = %v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("server calls = %d, want 2", calls.Load())
	}
}

func TestPromptFetchesShareOneTotalBudget(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "prompt")
	}))
	defer server.Close()
	previousClient := safeProxyHTTPClient
	safeProxyHTTPClient = server.Client()
	t.Cleanup(func() { safeProxyHTTPClient = previousClient })

	budget := newUpstreamReadBudget(context.Background(), "提示词同步", upstreamReadLimits{MaxRequests: 1, MaxBytes: 64, Deadline: time.Second})
	defer budget.Close()
	if data, err := fetchText(budget, server.URL, "first"); err != nil || data != "prompt" {
		t.Fatalf("first fetch data=%q error=%v", data, err)
	}
	if _, err := fetchText(budget, server.URL, "second"); !isUpstreamBudgetError(err) || !strings.Contains(err.Error(), "总请求数") {
		t.Fatalf("second fetch error = %v", err)
	}
}

func TestNormalizeUpstreamBudgetErrorUnwrapsHTTPError(t *testing.T) {
	want := &upstreamBudgetError{message: "预算耗尽"}
	wrapped := &urlErrorForTest{err: want}
	if got := normalizeUpstreamBudgetError(wrapped); !errors.Is(got, want) {
		t.Fatalf("normalized error = %v", got)
	}
}

type urlErrorForTest struct {
	err error
}

func (e *urlErrorForTest) Error() string { return "wrapped: " + e.err.Error() }
func (e *urlErrorForTest) Unwrap() error { return e.err }
