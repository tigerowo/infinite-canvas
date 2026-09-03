package handler

import "testing"

func TestUnsafeAIResponseContentType(t *testing.T) {
	cases := map[string]bool{
		"text/html; charset=utf-8": true,
		"application/xhtml+xml":    true,
		"image/svg+xml":            true,
		"application/xml":          true,
		"application/json":         false,
		"text/event-stream":        false,
		"image/png":                false,
		"video/mp4":                false,
	}
	for contentType, expected := range cases {
		if actual := unsafeAIResponseContentType(contentType); actual != expected {
			t.Fatalf("unsafeAIResponseContentType(%q) = %v，期望 %v", contentType, actual, expected)
		}
	}
}
