package middleware

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func TestRedisRequestBudgetIsSharedAcrossInstances(t *testing.T) {
	server := miniredis.RunT(t)
	first := redisRequestBudget{client: redis.NewClient(&redis.Options{Addr: server.Addr()}), prefix: "test-budget"}
	second := redisRequestBudget{client: redis.NewClient(&redis.Options{Addr: server.Addr()}), prefix: "test-budget"}
	t.Cleanup(func() { _ = first.client.Close(); _ = second.client.Close() })

	ctx := context.Background()
	if allowed, _, err := first.allow(ctx, "generation", "user:one", 1, time.Minute); err != nil || !allowed {
		t.Fatalf("first allow=%v err=%v", allowed, err)
	}
	if allowed, retry, err := second.allow(ctx, "generation", "user:one", 1, time.Minute); err != nil || allowed || retry <= 0 {
		t.Fatalf("second allow=%v retry=%v err=%v", allowed, retry, err)
	}

	release, allowed, err := first.acquire(ctx, "generation", "user:one", 1)
	if err != nil || !allowed {
		t.Fatalf("first acquire=%v err=%v", allowed, err)
	}
	if _, allowed, err := second.acquire(ctx, "generation", "user:one", 1); err != nil || allowed {
		t.Fatalf("second acquire=%v err=%v", allowed, err)
	}
	release()
	if releaseAgain, allowed, err := second.acquire(ctx, "generation", "user:one", 1); err != nil || !allowed {
		t.Fatalf("acquire after release=%v err=%v", allowed, err)
	} else {
		releaseAgain()
	}
}

func TestRedisRequestBudgetHashesPrincipal(t *testing.T) {
	budget := redisRequestBudget{prefix: "test-budget"}
	key := budget.key("rate", "auth", "ip:127.0.0.1")
	if strings.Contains(key, "127.0.0.1") {
		t.Fatalf("principal leaked in key: %s", key)
	}
}
