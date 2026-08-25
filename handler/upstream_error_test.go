package handler

import (
	"net/http"
	"strings"
	"testing"
)

func TestReadUpstreamAIErrorMessageMapsStatus(t *testing.T) {
	cases := map[int]string{
		http.StatusUnauthorized:        "鉴权失败",
		http.StatusForbidden:           "拒绝访问",
		http.StatusTooManyRequests:     "限流",
		http.StatusInternalServerError: "暂时不可用",
		http.StatusBadGateway:          "暂时不可用",
	}
	for status, expected := range cases {
		if actual := readUpstreamAIErrorMessage([]byte(`{"error":{"message":"unsafe detail"}}`), status); !strings.Contains(actual, expected) {
			t.Fatalf("status=%d message=%q，期望包含 %q", status, actual, expected)
		}
	}
}

func TestReadUpstreamAIErrorMessageRedactsPayload(t *testing.T) {
	message := readUpstreamAIErrorMessage([]byte(`{"error":{"message":"request failed with sk-1234567890abcdef"}}`), http.StatusBadRequest)
	if strings.Contains(message, "sk-1234567890abcdef") || !strings.Contains(message, "[redacted]") {
		t.Fatalf("错误消息未脱敏：%s", message)
	}
}

func TestVideoTaskPollBudgetStatus(t *testing.T) {
	if got := videoTaskPollBudgetStatus("视频任务轮询超过 30 分钟总体 deadline"); got != "timed_out" {
		t.Fatalf("deadline status=%s", got)
	}
	if got := videoTaskPollBudgetStatus("视频任务轮询超过 360 次限制"); got != "failed" {
		t.Fatalf("poll limit status=%s", got)
	}
}
