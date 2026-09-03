package handler

import (
	"strings"
	"testing"
)

func TestReadLimitedRequestBody(t *testing.T) {
	body, err := readLimitedRequestBody(strings.NewReader("1234"), "测试请求", 4)
	if err != nil || string(body) != "1234" {
		t.Fatalf("body=%q err=%v", body, err)
	}
	if _, err := readLimitedRequestBody(strings.NewReader("12345"), "测试请求", 4); err == nil || !strings.Contains(err.Error(), "4 bytes") {
		t.Fatalf("expected size limit error, got %v", err)
	}
}
