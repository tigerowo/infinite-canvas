package service

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestProviderCredentialsEncryptedRoundTrip(t *testing.T) {
	previous := config.Cfg.JWTSecret
	config.Cfg.JWTSecret = "provider-test-secret"
	t.Cleanup(func() { config.Cfg.JWTSecret = previous })

	want := providerCredentials{
		APIKey:  "sk-secret-value",
		Headers: map[string]string{"X-Project-ID": "project-secret"},
	}
	ciphertext, err := encryptProviderCredentials(want)
	if err != nil {
		t.Fatal(err)
	}
	if ciphertext == "" || ciphertext == want.APIKey {
		t.Fatal("凭据必须以非明文形式保存")
	}
	got, err := decryptProviderCredentials(ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("解密结果 = %#v，期望 %#v", got, want)
	}
}

func TestLegacyProviderMigrationPreviewDoesNotExposeSecrets(t *testing.T) {
	raw := `{"timeout":"90","localChannels":[{"id":"legacy-main","protocol":"openai","name":"旧主渠道","baseUrl":"https://api.example.com/v1?token=hidden","apiKey":"sk-legacy-secret","models":["gpt-image-2","gpt-5"]}]}`
	candidates, err := buildLegacyProviderMigration(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	preview := providerMigrationPreview(candidates)
	if preview.Importable != 1 || preview.PlaintextSecrets != 1 {
		t.Fatalf("preview = %#v", preview)
	}
	encoded, err := json.Marshal(preview)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "sk-legacy-secret") || strings.Contains(string(encoded), "token=hidden") {
		t.Fatal("迁移预览不得暴露密钥或 URL 查询参数")
	}
}

func TestLegacyProviderMigrationReusesExactEncryptedProvider(t *testing.T) {
	previous := config.Cfg.JWTSecret
	config.Cfg.JWTSecret = "provider-migration-test-secret"
	t.Cleanup(func() { config.Cfg.JWTSecret = previous })
	ciphertext, err := encryptProviderCredentials(providerCredentials{APIKey: "same-secret"})
	if err != nil {
		t.Fatal(err)
	}
	existing := []model.Provider{{
		ID: "provider-existing", Kind: model.ProviderKindAPI, Protocol: "openai",
		Name: "旧主渠道", BaseURL: "https://api.example.com/v1",
		CredentialsCiphertext: ciphertext,
	}}
	raw := `{"localChannels":[{"id":"legacy-main","protocol":"openai","name":"旧主渠道","baseUrl":"https://api.example.com/v1/","apiKey":"same-secret","models":["gpt-5"]}]}`
	candidates, err := buildLegacyProviderMigration(raw, existing)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].Action != "reuse" || candidates[0].TargetID != "provider-existing" {
		t.Fatalf("candidate = %#v", candidates)
	}
}

func TestCleanupLegacyProviderConfigKeepsUnknownAndInvalidEntries(t *testing.T) {
	raw := `{"apiKey":"root-secret","customFlag":true,"imageChannelId":"legacy-main","localChannels":[{"id":"legacy-main","protocol":"openai","name":"主渠道","baseUrl":"https://api.example.com","apiKey":"channel-secret","models":["gpt-5"]},{"id":"legacy-invalid","protocol":"unknown","apiKey":"keep-for-repair"}]}`
	candidates, err := buildLegacyProviderMigration(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	cleaned, cleanedCount, err := cleanupLegacyProviderConfig(raw, candidates)
	if err != nil {
		t.Fatal(err)
	}
	if cleanedCount != 2 || strings.Contains(cleaned, "root-secret") || strings.Contains(cleaned, "channel-secret") {
		t.Fatalf("cleanedCount=%d config=%s", cleanedCount, cleaned)
	}
	if !strings.Contains(cleaned, "keep-for-repair") || !strings.Contains(cleaned, `"customFlag":true`) {
		t.Fatal("无效渠道与未知配置字段必须保留")
	}
	var payload struct {
		ImageChannelID string `json:"imageChannelId"`
		LocalChannels  []struct {
			ID      string `json:"id"`
			APIKey  string `json:"apiKey"`
			Managed bool   `json:"managed"`
		} `json:"localChannels"`
	}
	if err := json.Unmarshal([]byte(cleaned), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.ImageChannelID == "legacy-main" || len(payload.LocalChannels) != 2 || !payload.LocalChannels[0].Managed || payload.LocalChannels[0].APIKey != "" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestValidateProviderInputRejectsUnsafeURLShape(t *testing.T) {
	for _, baseURL := range []string{"https://user:password@example.com/v1", "https://example.com/v1#internal"} {
		input := normalizeProviderInput(ProviderInput{
			Kind: model.ProviderKindAPI, Protocol: "openai", Name: "测试",
			BaseURL: baseURL, Timeout: 30,
		})
		if err := validateProviderInput(input); err == nil {
			t.Fatalf("不安全 Base URL 应被拒绝：%s", baseURL)
		}
	}
}

func TestApplyTrustedCLIProviderModelsRejectsUserSuppliedCatalog(t *testing.T) {
	saved := model.Provider{Kind: model.ProviderKindCLI, Protocol: "gemini-cli", Models: []string{"gemini-3.5-flash-low"}}
	input := ProviderInput{ID: "provider-antigravity", Kind: model.ProviderKindCLI, Protocol: "gemini-cli", Capabilities: []string{"image"}, Models: []string{"user-supplied-model"}, DefaultModel: "gemini-3.5-flash-low"}
	if err := applyTrustedCLIProviderModels(saved, &input); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(input.Models, saved.Models) {
		t.Fatalf("models = %#v", input.Models)
	}
	if !reflect.DeepEqual(input.Capabilities, []string{"text"}) {
		t.Fatalf("capabilities = %#v", input.Capabilities)
	}
	input.DefaultModel = "user-supplied-model"
	if err := applyTrustedCLIProviderModels(saved, &input); err == nil {
		t.Fatal("CLI default model must come from the detected catalog")
	}
}

func TestUpdateSavedProviderConnectionStatusKeepsConnectedCLIOnOrdinarySave(t *testing.T) {
	item := model.Provider{
		Kind:             model.ProviderKindCLI,
		Enabled:          true,
		ConnectionStatus: model.ProviderStatusConnected,
		StatusMessage:    "CLI 检测成功",
		LastCheckedAt:    "checked-at",
	}
	updateSavedProviderConnectionStatus(&item, false)
	if item.ConnectionStatus != model.ProviderStatusConnected || item.StatusMessage != "CLI 检测成功" || item.LastCheckedAt != "checked-at" {
		t.Fatalf("普通保存不应重置 CLI 连接状态：%#v", item)
	}

	updateSavedProviderConnectionStatus(&item, true)
	if item.ConnectionStatus != model.ProviderStatusUnavailable || item.StatusMessage != "本地 CLI helper 尚未连接" || item.LastCheckedAt != "" {
		t.Fatalf("连接配置变化后应要求重新检测 CLI：%#v", item)
	}
}

func TestNormalizeProviderHeadersRejectsHeaderInjection(t *testing.T) {
	headers := normalizeProviderHeaders(map[string]string{
		"X-Safe": "configured",
		"X-Bad":  "value\r\nX-Injected: secret",
	})
	if headers["X-Safe"] != "configured" || headers["X-Bad"] != "" {
		t.Fatalf("headers=%#v", headers)
	}
}

func TestValidateProviderInputRestrictsRunningHubCredentialDestination(t *testing.T) {
	unsafe := normalizeProviderInput(ProviderInput{
		Kind: model.ProviderKindAPI, Protocol: "runninghub", Name: "RunningHub",
		BaseURL: "https://runninghub-proxy.example.test", Models: []string{"workflow:2058824859437850625"}, Timeout: 30,
	})
	if err := validateProviderInput(unsafe); err == nil {
		t.Fatal("RunningHub credentials must not be sent to an arbitrary host")
	}
	safe := unsafe
	safe.BaseURL = "https://www.runninghub.ai"
	if err := validateProviderInput(safe); err != nil {
		t.Fatalf("official RunningHub URL should be accepted: %v", err)
	}
}

func TestGenericHTTPProviderAcceptsHeaderAuthentication(t *testing.T) {
	previous := config.Cfg.JWTSecret
	config.Cfg.JWTSecret = "provider-http-test-secret"
	t.Cleanup(func() { config.Cfg.JWTSecret = previous })
	ciphertext, err := encryptProviderCredentials(providerCredentials{Headers: map[string]string{"X-API-Key": "configured"}})
	if err != nil {
		t.Fatal(err)
	}
	channel, err := modelChannelFromProvider(model.Provider{
		ID: "provider-http", Kind: model.ProviderKindAPI, Protocol: "http", Name: "通用 HTTP",
		BaseURL: "https://api.example.test", CredentialsCiphertext: ciphertext, Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !IsGenericHTTPChannel(channel) || channel.Headers["X-API-Key"] != "configured" {
		t.Fatalf("channel = %#v", channel)
	}
}

func TestLegacyGenericHTTPProviderCanMigrate(t *testing.T) {
	raw := `{"localChannels":[{"id":"legacy-http","protocol":"http","name":"旧通用接口","baseUrl":"https://api.example.test","apiKey":"legacy-secret","models":["custom-model"]}]}`
	candidates, err := buildLegacyProviderMigration(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].Action != "import" || candidates[0].Input.Protocol != "http" {
		t.Fatalf("candidates = %#v", candidates)
	}
}

func TestHTTPClientForRestrictedChannelUsesSafeTransport(t *testing.T) {
	client := HTTPClientForChannel(model.ModelChannel{Restricted: true, Timeout: 12})
	if client.Transport == nil {
		t.Fatal("用户渠道必须使用显式安全 transport")
	}
	if client.Timeout.Seconds() != 12 {
		t.Fatalf("timeout = %v，期望 12 秒", client.Timeout)
	}
}
