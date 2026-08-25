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
