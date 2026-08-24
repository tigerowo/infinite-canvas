package middleware

import (
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/service"
)

const requestBudgetMaxPrincipals = 10000

type requestRateEntry struct {
	count int
	reset time.Time
}

type requestRateLimiter struct {
	mu      sync.Mutex
	entries map[string]requestRateEntry
}

type requestConcurrencyLimiter struct {
	mu      sync.Mutex
	entries map[string]int
}

type requestBudget struct {
	rate        requestRateLimiter
	concurrent  requestConcurrencyLimiter
	requests    int
	window      time.Duration
	concurrency int
}

var (
	authRequestBudget       = newRequestBudget(20, time.Minute, 4)
	generationRequestBudget = newRequestBudget(60, time.Minute, 4)
	heavyRequestBudget      = newRequestBudget(30, time.Minute, 2)
	uploadRequestBudget     = newRequestBudget(30, time.Minute, 2)
	proxyRequestBudget      = newRequestBudget(60, time.Minute, 4)
	downloadRequestBudget   = newRequestBudget(120, time.Minute, 4)
)

func newRequestBudget(requests int, window time.Duration, concurrency int) *requestBudget {
	return &requestBudget{
		rate:        requestRateLimiter{entries: map[string]requestRateEntry{}},
		concurrent:  requestConcurrencyLimiter{entries: map[string]int{}},
		requests:    requests,
		window:      window,
		concurrency: concurrency,
	}
}

func AuthRequestBudget(c *gin.Context) {
	applyRequestBudget(c, authRequestBudget, "ip:"+c.ClientIP())
}

func GenerationRequestBudget(c *gin.Context) {
	applyRequestBudget(c, generationRequestBudget, requestBudgetPrincipal(c))
}

func HeavyRequestBudget(c *gin.Context) {
	applyRequestBudget(c, heavyRequestBudget, requestBudgetPrincipal(c))
}

func UploadRequestBudget(c *gin.Context) {
	applyRequestBudget(c, uploadRequestBudget, requestBudgetPrincipal(c))
}

func ProxyRequestBudget(c *gin.Context) {
	applyRequestBudget(c, proxyRequestBudget, "ip:"+c.ClientIP())
}

func DownloadRequestBudget(c *gin.Context) {
	applyRequestBudget(c, downloadRequestBudget, requestBudgetPrincipal(c))
}

func applyRequestBudget(c *gin.Context, budget *requestBudget, key string) {
	allowed, retryAfter := budget.rate.allow(key, time.Now(), budget.requests, budget.window)
	if !allowed {
		c.Header("Retry-After", strconv.Itoa(max(1, int(retryAfter.Seconds()+0.999))))
		handler.FailWithStatus(c.Writer, http.StatusTooManyRequests, "请求过于频繁，请稍后重试")
		c.Abort()
		return
	}
	release, ok := budget.concurrent.acquire(key, budget.concurrency)
	if !ok {
		c.Header("Retry-After", "1")
		handler.FailWithStatus(c.Writer, http.StatusTooManyRequests, "并发请求过多，请稍后重试")
		c.Abort()
		return
	}
	defer release()
	c.Next()
}

func requestBudgetPrincipal(c *gin.Context) string {
	if user, ok := service.UserFromContext(c.Request.Context()); ok && user.ID != "" {
		return "user:" + user.ID
	}
	return "ip:" + c.ClientIP()
}

func (limiter *requestRateLimiter) allow(key string, current time.Time, limit int, window time.Duration) (bool, time.Duration) {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	entry, ok := limiter.entries[key]
	if !ok || !current.Before(entry.reset) {
		if !ok && len(limiter.entries) >= requestBudgetMaxPrincipals {
			limiter.removeExpired(current)
			if len(limiter.entries) >= requestBudgetMaxPrincipals {
				return false, window
			}
		}
		limiter.entries[key] = requestRateEntry{count: 1, reset: current.Add(window)}
		return true, 0
	}
	if entry.count >= limit {
		return false, entry.reset.Sub(current)
	}
	entry.count++
	limiter.entries[key] = entry
	return true, 0
}

func (limiter *requestRateLimiter) removeExpired(current time.Time) {
	for key, entry := range limiter.entries {
		if !current.Before(entry.reset) {
			delete(limiter.entries, key)
		}
	}
}

func (limiter *requestConcurrencyLimiter) acquire(key string, limit int) (func(), bool) {
	limiter.mu.Lock()
	if limiter.entries[key] >= limit {
		limiter.mu.Unlock()
		return nil, false
	}
	limiter.entries[key]++
	limiter.mu.Unlock()
	return func() {
		limiter.mu.Lock()
		limiter.entries[key]--
		if limiter.entries[key] <= 0 {
			delete(limiter.entries, key)
		}
		limiter.mu.Unlock()
	}, true
}
