package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestCLICompanionAuthorizationIsSignedAndSingleUse(t *testing.T) {
	secret := bytes.Repeat([]byte{0x42}, 32)
	current := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	handler := &cliCompanionHandler{
		secret: secret,
		now:    func() time.Time { return current },
		execute: func(_ context.Context, action string, protocol string) (CLIHelperResult, model.ProviderStatus) {
			if action != cliCompanionActionVersion {
				t.Fatalf("action=%q", action)
			}
			return CLIHelperResult{Available: true, Protocol: protocol, Version: "test-version", Message: "CLI 检测成功"}, model.ProviderStatusConnected
		},
		seen: map[string]time.Time{},
	}
	body, _ := json.Marshal(cliCompanionActionRequest{Action: "version", UserID: "user-1", ProviderID: "provider-1", Protocol: "codex"})
	timestamp := strconv.FormatInt(current.Unix(), 10)
	nonce := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x24}, 24))
	request := cliCompanionTestRequest(t, body, timestamp, nonce, secret)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	signature, err := base64.RawURLEncoding.DecodeString(recorder.Header().Get(cliCompanionResponseHeader))
	if err != nil || !bytes.Equal(signature, cliCompanionResponseSignature(secret, nonce, recorder.Body.Bytes())) {
		t.Fatal("response signature is invalid")
	}
	replay := cliCompanionTestRequest(t, body, timestamp, nonce, secret)
	replayRecorder := httptest.NewRecorder()
	handler.ServeHTTP(replayRecorder, replay)
	if replayRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("replay status=%d", replayRecorder.Code)
	}
}

func TestCLICompanionRejectsExpiredOrTamperedAuthorization(t *testing.T) {
	secret := bytes.Repeat([]byte{0x31}, 32)
	current := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	handler := &cliCompanionHandler{secret: secret, now: func() time.Time { return current }, execute: executeCLICompanionAction, seen: map[string]time.Time{}}
	body, _ := json.Marshal(cliCompanionActionRequest{Action: "version", UserID: "user-1", ProviderID: "provider-1", Protocol: "codex"})
	nonce := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x25}, 24))
	expired := cliCompanionTestRequest(t, body, strconv.FormatInt(current.Add(-time.Minute).Unix(), 10), nonce, secret)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, expired)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expired status=%d", recorder.Code)
	}
	tampered := cliCompanionTestRequest(t, body, strconv.FormatInt(current.Unix(), 10), nonce, secret)
	tampered.Body = io.NopCloser(bytes.NewReader(append(body, ' ')))
	tamperedRecorder := httptest.NewRecorder()
	handler.ServeHTTP(tamperedRecorder, tampered)
	if tamperedRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("tampered status=%d", tamperedRecorder.Code)
	}
}

func TestRequestCLICompanionUsesPrivateUnixSocket(t *testing.T) {
	directory := t.TempDir()
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(directory, "helper.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.Chmod(socketPath, 0o600); err != nil {
		t.Fatal(err)
	}
	secret := bytes.Repeat([]byte{0x51}, 32)
	handler := &cliCompanionHandler{
		secret: secret,
		now:    time.Now,
		execute: func(_ context.Context, action string, protocol string) (CLIHelperResult, model.ProviderStatus) {
			if action != cliCompanionActionVersion {
				t.Fatalf("action=%q", action)
			}
			return CLIHelperResult{Available: true, Protocol: protocol, Version: "test-version", Message: "CLI 检测成功"}, model.ProviderStatusConnected
		},
		seen: map[string]time.Time{},
	}
	server := &http.Server{Handler: handler}
	defer server.Close()
	go func() { _ = server.Serve(listener) }()
	previousSocket := config.Cfg.CLIHelperSocket
	previousSecret := config.Cfg.CLIHelperSecret
	config.Cfg.CLIHelperSocket = socketPath
	config.Cfg.CLIHelperSecret = base64.StdEncoding.EncodeToString(secret)
	t.Cleanup(func() {
		config.Cfg.CLIHelperSocket = previousSocket
		config.Cfg.CLIHelperSecret = previousSecret
	})
	result, status, err := requestCLICompanion(context.Background(), "user-1", "provider-1", "codex")
	if err != nil || status != model.ProviderStatusConnected || !result.Available || result.Version != "test-version" {
		t.Fatalf("result=%#v status=%s error=%v", result, status, err)
	}
}

func TestCLICompanionAuthStatusActionIsBoundToAuthorization(t *testing.T) {
	secret := bytes.Repeat([]byte{0x61}, 32)
	current := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	handler := &cliCompanionHandler{
		secret: secret,
		now:    func() time.Time { return current },
		execute: func(_ context.Context, action string, protocol string) (CLIHelperResult, model.ProviderStatus) {
			if action != cliCompanionActionAuthStatus || protocol != "codex" {
				t.Fatalf("action=%q protocol=%q", action, protocol)
			}
			return CLIHelperResult{Available: true, Protocol: protocol, AuthStatus: "authenticated", Message: "Codex CLI 已登录"}, model.ProviderStatusConnected
		},
		seen: map[string]time.Time{},
	}
	body, _ := json.Marshal(cliCompanionActionRequest{Action: cliCompanionActionAuthStatus, UserID: "user-1", ProviderID: "provider-1", Protocol: "codex"})
	nonce := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x62}, 24))
	request := cliCompanionTestRequest(t, body, strconv.FormatInt(current.Unix(), 10), nonce, secret)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var response cliCompanionActionResponse
	if json.Unmarshal(recorder.Body.Bytes(), &response) != nil || response.Result.AuthStatus != "authenticated" {
		t.Fatalf("response=%#v", response)
	}
}

func TestCLICompanionLoginStartActionIsBoundToAuthorization(t *testing.T) {
	secret := bytes.Repeat([]byte{0x71}, 32)
	current := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	handler := &cliCompanionHandler{
		secret:   secret,
		now:      func() time.Time { return current },
		lifetime: context.Background(),
		execute: func(_ context.Context, action string, protocol string) (CLIHelperResult, model.ProviderStatus) {
			if action != cliCompanionActionLoginStart || protocol != "codex" {
				t.Fatalf("action=%q protocol=%q", action, protocol)
			}
			return CLIHelperResult{Available: true, Protocol: protocol, ActionStatus: "started", Message: "Codex 登录已启动"}, model.ProviderStatusConnected
		},
		seen: map[string]time.Time{},
	}
	body, _ := json.Marshal(cliCompanionActionRequest{Action: cliCompanionActionLoginStart, UserID: "user-1", ProviderID: "provider-1", Protocol: "codex"})
	nonce := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x72}, 24))
	request := cliCompanionTestRequest(t, body, strconv.FormatInt(current.Unix(), 10), nonce, secret)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var response cliCompanionActionResponse
	if json.Unmarshal(recorder.Body.Bytes(), &response) != nil || response.Result.ActionStatus != "started" {
		t.Fatalf("response=%#v", response)
	}
}

func cliCompanionTestRequest(t *testing.T, body []byte, timestamp string, nonce string, secret []byte) *http.Request {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "http://unix"+cliCompanionActionPath, bytes.NewReader(body))
	request.Header.Set(cliCompanionTimestampHeader, timestamp)
	request.Header.Set(cliCompanionNonceHeader, nonce)
	request.Header.Set(cliCompanionSignatureHeader, base64.RawURLEncoding.EncodeToString(cliCompanionRequestSignature(secret, timestamp, nonce, body)))
	return request
}
