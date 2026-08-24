package handler

import (
	"net/http/httptest"
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
