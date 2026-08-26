package handler

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLoopbackWebRequest(t *testing.T) {
	request := httptest.NewRequest("POST", "http://127.0.0.1:8080/api/v1/providers/id/cli/detect", nil)
	request.RemoteAddr = "[::1]:55000"
	request.Host = "127.0.0.1:8080"
	if !isLoopbackWebRequest(request) {
		t.Fatal("loopback request should be allowed")
	}
	request.Header.Set("X-Forwarded-For", "203.0.113.8")
	if isLoopbackWebRequest(request) {
		t.Fatal("non-loopback forwarded client should be rejected")
	}
}

func TestCLIProviderLoginRequiresExplicitConfirmation(t *testing.T) {
	request := httptest.NewRequest("POST", "http://127.0.0.1:8080/api/v1/providers/id/cli/login", strings.NewReader(`{"confirmed":false}`))
	request.RemoteAddr = "127.0.0.1:55000"
	request.Host = "127.0.0.1:8080"
	recorder := httptest.NewRecorder()
	StartUserCLIProviderLogin(recorder, request, "provider-1")
	if !strings.Contains(recorder.Body.String(), "请明确确认后再启动 Codex 登录") {
		t.Fatalf("body=%s", recorder.Body.String())
	}
}

func TestCLIModelProbeRequiresExplicitConfirmation(t *testing.T) {
	request := httptest.NewRequest("POST", "http://127.0.0.1:8080/api/v1/providers/id/cli/model-probe", strings.NewReader(`{"confirmed":false}`))
	request.RemoteAddr = "127.0.0.1:55000"
	request.Host = "127.0.0.1:8080"
	recorder := httptest.NewRecorder()
	StartUserCLIModelProbe(recorder, request, "provider-1")
	if !strings.Contains(recorder.Body.String(), "请明确确认后再执行 Codex 最小调用") {
		t.Fatalf("body=%s", recorder.Body.String())
	}
}
