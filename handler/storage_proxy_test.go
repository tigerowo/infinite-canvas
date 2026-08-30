package handler

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestProxyMediaAllowsVideo(t *testing.T) {
	data := []byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 'm', 'p', '4', '2'}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write(data)
	}))
	defer upstream.Close()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/proxy-media?url="+url.QueryEscape(upstream.URL), nil)
	proxyMedia(recorder, request, upstream.Client(), 1024)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Content-Type") != "video/mp4" {
		t.Fatalf("content type = %q", recorder.Header().Get("Content-Type"))
	}
	if recorder.Body.String() != string(data) {
		t.Fatal("proxied video body does not match upstream")
	}
}

func TestProxyMediaRejectsHTMLAndOversizedBodies(t *testing.T) {
	tests := []struct {
		name     string
		body     string
		maxBytes int64
		message  string
	}{
		{name: "html", body: "<html>not media</html>", maxBytes: 1024, message: "没有返回安全媒体"},
		{name: "oversized", body: strings.Repeat("x", 5), maxBytes: 4, message: "超过 256 MiB 限制"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "video/mp4")
				_, _ = w.Write([]byte(test.body))
			}))
			defer upstream.Close()

			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/proxy-media?url="+url.QueryEscape(upstream.URL), nil)
			proxyMedia(recorder, request, upstream.Client(), test.maxBytes)

			if recorder.Code != http.StatusBadGateway {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			if !strings.Contains(recorder.Body.String(), test.message) {
				t.Fatalf("body = %q, want message %q", recorder.Body.String(), test.message)
			}
		})
	}
}
