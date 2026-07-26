package service

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ValidatePublicHTTPURL rejects non-http(s) schemes and hosts that resolve to private/link-local/metadata addresses.
func ValidatePublicHTTPURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("url 参数不能为空")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return fmt.Errorf("无效的 url")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return fmt.Errorf("仅允许 http/https")
	}
	if parsed.User != nil {
		return fmt.Errorf("url 不允许包含用户信息")
	}
	host := parsed.Hostname()
	if host == "" {
		return fmt.Errorf("无效的 url")
	}
	if isBlockedHostname(host) {
		return fmt.Errorf("禁止访问内网或本地地址")
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		// literal IP parse fallback
		if ip := net.ParseIP(host); ip != nil {
			if isBlockedIP(ip) {
				return fmt.Errorf("禁止访问内网或本地地址")
			}
			return nil
		}
		return fmt.Errorf("无法解析目标主机")
	}
	if len(ips) == 0 {
		return fmt.Errorf("无法解析目标主机")
	}
	for _, ip := range ips {
		if isBlockedIP(ip) {
			return fmt.Errorf("禁止访问内网或本地地址")
		}
	}
	return nil
}

func isBlockedHostname(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	switch h {
	case "localhost", "localhost.localdomain", "metadata", "metadata.google.internal":
		return true
	}
	if strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return isBlockedIP(ip)
	}
	return false
}

func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return true
	}
	// CGNAT / common cloud metadata ranges
	if ip4 := ip.To4(); ip4 != nil {
		if ip4[0] == 169 && ip4[1] == 254 {
			return true
		}
		if ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127 {
			return true
		}
		if ip4[0] == 0 {
			return true
		}
	}
	return false
}

// SafeImageProxyClient returns an HTTP client for image proxying with short timeout and no redirects.
func SafeImageProxyClient() *http.Client {
	return &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}
