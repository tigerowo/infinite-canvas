package service

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestProviderAdapterModelContracts(t *testing.T) {
	tests := []struct {
		name, protocol, path, header, value, response string
		want                                          []string
		headers                                       map[string]string
	}{
		{name: "openai compatible", protocol: "openai", path: "/v1/models", header: "Authorization", value: "Bearer test-key", response: `{"data":[{"id":"gpt-test"}]}`, want: []string{"gpt-test"}},
		{name: "gemini", protocol: "gemini", path: "/v1beta/models", header: "x-goog-api-key", value: "test-key", response: `{"models":[{"name":"models/gemini-test","supportedGenerationMethods":["generateContent"]}]}`, want: []string{"gemini-test"}},
		{name: "generic http", protocol: "http", path: "/models", header: "Authorization", value: "Token custom", response: `{"models":[{"id":"custom-video"},{"name":"custom-image"}]}`, want: []string{"custom-image", "custom-video"}, headers: map[string]string{"Authorization": "Token custom"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != test.path || r.Header.Get(test.header) != test.value {
					http.Error(w, "contract mismatch", http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(test.response))
			}))
			defer server.Close()

			got, err := FetchModelChannelModels(model.ModelChannel{Protocol: test.protocol, BaseURL: server.URL, APIKey: "test-key", Headers: test.headers, Timeout: 2})
			if err != nil {
				t.Fatal(err)
			}
			if strings.Join(got, ",") != strings.Join(test.want, ",") {
				t.Fatalf("models = %v, want %v", got, test.want)
			}
		})
	}
}

func TestProviderAdapterModelFailures(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		body    string
		delay   time.Duration
		timeout int
	}{
		{name: "invalid json", status: http.StatusOK, body: "not-json", timeout: 2},
		{name: "authentication rejected", status: http.StatusUnauthorized, body: `{"error":{"message":"unauthorized"}}`, timeout: 2},
		{name: "response too large", status: http.StatusOK, body: strings.Repeat("x", 8*1024*1024+1), timeout: 2},
		{name: "timeout", status: http.StatusOK, body: `{"models":[]}`, delay: 200 * time.Millisecond, timeout: 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			previousClient := adminModelHTTPClient
			if test.delay > 0 {
				adminModelHTTPClient = &http.Client{Timeout: 50 * time.Millisecond}
			}
			defer func() { adminModelHTTPClient = previousClient }()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				time.Sleep(test.delay)
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			}))
			defer server.Close()
			if _, err := FetchModelChannelModels(model.ModelChannel{Protocol: "http", BaseURL: server.URL, Headers: map[string]string{"X-Test-Key": "configured"}, Timeout: test.timeout}); err == nil {
				t.Fatal("expected adapter failure")
			}
		})
	}
}
