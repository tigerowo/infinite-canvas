package service

import (
	"net"
	"testing"
)

func TestIsBlockedIP(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1":        true,
		"10.0.0.1":         true,
		"192.168.1.1":      true,
		"172.16.0.1":       true,
		"169.254.169.254":  true,
		"0.0.0.0":          true,
		"8.8.8.8":          false,
		"1.1.1.1":          false,
		"::1":              true,
	}
	for raw, want := range cases {
		ip := net.ParseIP(raw)
		if got := isBlockedIP(ip); got != want {
			t.Fatalf("isBlockedIP(%s)=%v want %v", raw, got, want)
		}
	}
}

func TestValidatePublicHTTPURLRejectsPrivate(t *testing.T) {
	for _, raw := range []string{
		"http://127.0.0.1/health",
		"http://localhost/x",
		"http://169.254.169.254/latest/meta-data",
		"file:///etc/passwd",
		"ftp://example.com/a",
		"",
	} {
		if err := ValidatePublicHTTPURL(raw); err == nil {
			t.Fatalf("expected reject for %q", raw)
		}
	}
}

func TestValidatePublicHTTPURLAcceptsPublicLiteral(t *testing.T) {
	// Use a public IP literal to avoid flaky DNS in CI.
	if err := ValidatePublicHTTPURL("https://1.1.1.1/"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
