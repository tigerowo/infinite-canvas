package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestRequestRateLimiter(t *testing.T) {
	limiter := requestRateLimiter{entries: map[string]requestRateEntry{}}
	now := time.Now()
	for index := 0; index < 2; index++ {
		if allowed, _ := limiter.allow("user", now, 2, time.Minute); !allowed {
			t.Fatalf("request %d unexpectedly rejected", index+1)
		}
	}
	if allowed, retry := limiter.allow("user", now, 2, time.Minute); allowed || retry <= 0 {
		t.Fatalf("third request allowed=%v retry=%v", allowed, retry)
	}
	if allowed, _ := limiter.allow("user", now.Add(time.Minute), 2, time.Minute); !allowed {
		t.Fatal("request after window reset was rejected")
	}
}

func TestRequestConcurrencyLimiter(t *testing.T) {
	limiter := requestConcurrencyLimiter{entries: map[string]int{}}
	release, ok := limiter.acquire("user", 1)
	if !ok {
		t.Fatal("first acquire rejected")
	}
	if _, ok := limiter.acquire("user", 1); ok {
		t.Fatal("second acquire unexpectedly allowed")
	}
	release()
	if releaseAgain, ok := limiter.acquire("user", 1); !ok {
		t.Fatal("acquire after release rejected")
	} else {
		releaseAgain()
	}
}

func TestApplyRequestBudgetReturns429AndRetryAfter(t *testing.T) {
	gin.SetMode(gin.TestMode)
	budget := newRequestBudget(1, time.Minute, 1)
	router := gin.New()
	router.Use(func(c *gin.Context) { applyRequestBudget(c, budget, "test") })
	router.GET("/test", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	first := httptest.NewRecorder()
	router.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/test", nil))
	if first.Code != http.StatusNoContent {
		t.Fatalf("first status=%d", first.Code)
	}
	second := httptest.NewRecorder()
	router.ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/test", nil))
	if second.Code != http.StatusTooManyRequests || second.Header().Get("Retry-After") == "" {
		t.Fatalf("second status=%d retry=%q body=%s", second.Code, second.Header().Get("Retry-After"), second.Body.String())
	}
}
