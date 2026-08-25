package service

import (
	"strings"
	"testing"
)

func TestRedactSensitiveText(t *testing.T) {
	secretValues := []string{"secret-bearer", "secret-header", "secret-query", "sk-1234567890abcdef", "AIza1234567890abcdef"}
	cleaned := RedactSensitiveText(`Authorization: Bearer secret-bearer {"api_key":"secret-header"} https://example.com/v1?token=secret-query sk-1234567890abcdef AIza1234567890abcdef`)
	for _, secret := range secretValues {
		if strings.Contains(cleaned, secret) {
			t.Fatalf("脱敏结果仍包含密钥 %q：%s", secret, cleaned)
		}
	}
	if strings.Count(cleaned, "[redacted]") < 5 {
		t.Fatalf("脱敏标记不足：%s", cleaned)
	}
}

func TestSanitizeAIStoredPayloadRedactsEmbeddedImageData(t *testing.T) {
	payload := `{"choices":[{"message":{"content":"![generated image](data:image/png;base64,` + strings.Repeat("A", 600) + `)"}}]}`
	cleaned := SanitizeAIStoredPayload(payload)
	if strings.Contains(cleaned, strings.Repeat("A", 100)) {
		t.Fatalf("任务详情仍包含长 Base64：%s", cleaned)
	}
	if !strings.Contains(cleaned, "redacted") {
		t.Fatalf("任务详情缺少脱敏标记：%s", cleaned)
	}
}
