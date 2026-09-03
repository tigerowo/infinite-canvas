package service

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
)

func TestCLIProxyModelAllowlist(t *testing.T) {
	if !cliProxyTextModel(cliChatGPTProxyProtocol, cliChatGPTProxyTextModel) || cliProxyTextModel(cliChatGPTProxyProtocol, "gpt-4o") {
		t.Fatal("ChatGPT subscription proxy text allowlist is incorrect")
	}
	if !cliProxyImageModel(cliChatGPTProxyProtocol, cliChatGPTProxyImageModel) || cliProxyImageModel(cliChatGPTProxyProtocol, "dall-e-3") {
		t.Fatal("ChatGPT subscription proxy image allowlist is incorrect")
	}
	if !cliProxyTextModel(cliAntigravityProxyProtocol, cliAntigravityProxyTextModel) || !cliProxyImageModel(cliAntigravityProxyProtocol, cliAntigravityProxyImageModel) {
		t.Fatal("Antigravity subscription proxy allowlist is incorrect")
	}
}

func TestCLIProxyImageRequestValidation(t *testing.T) {
	valid := cliCompanionActionRequest{Action: cliCompanionActionGenerationStart, Protocol: cliChatGPTProxyProtocol, Model: cliChatGPTProxyImageModel, GenerationType: "image", Prompt: "blue dot", Ratio: "1:1", Resolution: "low"}
	if !validSubscriptionImageGenerationRequest(valid) {
		t.Fatal("expected allowlisted subscription proxy image request")
	}
	valid.Model = cliChatGPTProxyTextModel
	if validSubscriptionImageGenerationRequest(valid) {
		t.Fatal("text model must not be accepted for image generation")
	}
}

func TestSubscriptionImageSizeMapsAspectRatioDirection(t *testing.T) {
	for ratio, expected := range map[string]string{"21:9": "1536x1024", "4:3": "1536x1024", "3:4": "1024x1536", "1:1": "1024x1024"} {
		if actual := subscriptionImageSize(ratio); actual != expected {
			t.Fatalf("unexpected size for %s: %s", ratio, actual)
		}
	}
}

func TestCLIProxyAPIKeyRequiresPrivateExternalFile(t *testing.T) {
	previousEnabled, previousPath := config.Cfg.CLIProxyEnabled, config.Cfg.CLIProxyAPIKeyFile
	defer func() {
		config.Cfg.CLIProxyEnabled = previousEnabled
		config.Cfg.CLIProxyAPIKeyFile = previousPath
	}()
	path := filepath.Join(t.TempDir(), "proxy-key")
	if err := os.WriteFile(path, []byte("local-test-key-1234567890"), 0o644); err != nil {
		t.Fatal(err)
	}
	config.Cfg.CLIProxyEnabled = true
	config.Cfg.CLIProxyAPIKeyFile = path
	if _, err := cliProxyAPIKey(); err == nil {
		t.Fatal("world-readable proxy key must be rejected")
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if key, err := cliProxyAPIKey(); err != nil || key != "local-test-key-1234567890" {
		t.Fatalf("expected private proxy key file: %q %v", key, err)
	}
}

func TestCLIProxyImageFailureUsesProxyIdentity(t *testing.T) {
	if message := subscriptionImageFailureMessage(cliAntigravityProxyProtocol, "HTTP Unauthorized"); message != "Antigravity 订阅代理本地访问密钥无效或上游登录已失效" {
		t.Fatalf("unexpected proxy failure message: %q", message)
	}
}

func TestWriteCLIProxyImageRejectsRemoteURL(t *testing.T) {
	if _, _, err := writeCLIProxyImage(t.TempDir(), "https://example.com/image.png"); err == nil {
		t.Fatal("remote image URL must be rejected")
	}
}

func TestWriteCLIProxyImageUsesPrivateFile(t *testing.T) {
	directory := t.TempDir()
	pngHeader := []byte{'\x89', 'P', 'N', 'G', '\r', '\n', '\x1a', '\n', 0, 0, 0, 0}
	path, contentType, err := writeCLIProxyImage(directory, "data:image/png;base64,"+base64.StdEncoding.EncodeToString(pngHeader))
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "image/png" || filepath.Dir(path) != directory {
		t.Fatalf("unexpected image output: %q %q", path, contentType)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("image output must use 0600 permissions: %v", err)
	}
}
