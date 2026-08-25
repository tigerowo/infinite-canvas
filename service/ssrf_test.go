package service

import (
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestIsBlockedProxyIP(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1":       true,
		"10.0.0.1":        true,
		"172.16.0.1":      true,
		"192.168.1.1":     true,
		"169.254.169.254": true,
		"100.100.100.200": true,
		"0.0.0.0":         true,
		"::1":             true,
		"fc00::1":         true,
		"fe80::1":         true,
		"1.1.1.1":         false,
		"8.8.8.8":         false,
	}
	for raw, expected := range cases {
		actual := isBlockedProxyIP(net.ParseIP(raw))
		if actual != expected {
			t.Fatalf(
				"isBlockedProxyIP(%q) = %v，期望 %v",
				raw,
				actual,
				expected,
			)
		}
	}
}

func TestSafeProxyHTTPClientForBaseURLRejectsCrossOriginRedirect(t *testing.T) {
	client := SafeProxyHTTPClientForBaseURL("https://api.example.com/v1", time.Second)
	request, err := http.NewRequest(http.MethodGet, "https://cdn.example.com/result", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.CheckRedirect(request, []*http.Request{{}}); err == nil || !strings.Contains(err.Error(), "其他来源") {
		t.Fatalf("跨来源重定向应被拒绝：%v", err)
	}
	sameOrigin, err := http.NewRequest(http.MethodGet, "https://api.example.com/v2/models", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.CheckRedirect(sameOrigin, []*http.Request{{}}); err != nil {
		t.Fatalf("同源重定向不应被拒绝：%v", err)
	}
}

func TestSafeProxyHTTPClientRedirectLimit(t *testing.T) {
	client := SafeProxyHTTPClient()
	request, err := http.NewRequest(
		http.MethodGet,
		"https://example.com/image.png",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.CheckRedirect(
		request,
		make([]*http.Request, 5),
	); err != nil {
		t.Fatalf("第 5 次重定向不应被拒绝：%v", err)
	}
	if err := client.CheckRedirect(
		request,
		make([]*http.Request, 6),
	); err == nil {
		t.Fatal("超过 5 次重定向应被拒绝")
	}
}
