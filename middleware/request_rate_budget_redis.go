package middleware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const sharedConcurrencyLease = time.Hour

var (
	sharedRequestBudgetMu sync.RWMutex
	sharedRequestBudget   *redisRequestBudget
	rateBudgetScript      = redis.NewScript(`local count=redis.call('INCR',KEYS[1]); if count==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; local ttl=redis.call('PTTL',KEYS[1]); if count>tonumber(ARGV[2]) then return {0,ttl} end; return {1,0}`)
	acquireBudgetScript   = redis.NewScript(`local count=tonumber(redis.call('GET',KEYS[1]) or '0'); if count>=tonumber(ARGV[1]) then return 0 end; count=redis.call('INCR',KEYS[1]); redis.call('PEXPIRE',KEYS[1],ARGV[2]); return 1`)
	releaseBudgetScript   = redis.NewScript(`local count=tonumber(redis.call('GET',KEYS[1]) or '0'); if count<=1 then redis.call('DEL',KEYS[1]); return 0 end; return redis.call('DECR',KEYS[1])`)
)

type redisRequestBudget struct {
	client *redis.Client
	prefix string
}

func ConfigureSharedRequestBudget(rawURL string, prefix string) error {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		setSharedRequestBudget(nil)
		return nil
	}
	options, err := redis.ParseURL(rawURL)
	if err != nil {
		return errors.New("共享请求预算 Redis 配置无效")
	}
	client := redis.NewClient(options)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return errors.New("共享请求预算 Redis 不可用")
	}
	setSharedRequestBudget(&redisRequestBudget{client: client, prefix: strings.Trim(strings.TrimSpace(prefix), ":")})
	return nil
}

func setSharedRequestBudget(next *redisRequestBudget) {
	sharedRequestBudgetMu.Lock()
	previous := sharedRequestBudget
	sharedRequestBudget = next
	sharedRequestBudgetMu.Unlock()
	if previous != nil && previous != next {
		_ = previous.client.Close()
	}
}

func currentSharedRequestBudget() *redisRequestBudget {
	sharedRequestBudgetMu.RLock()
	defer sharedRequestBudgetMu.RUnlock()
	return sharedRequestBudget
}

func (budget *redisRequestBudget) allow(ctx context.Context, name string, principal string, limit int, window time.Duration) (bool, time.Duration, error) {
	values, err := rateBudgetScript.Run(ctx, budget.client, []string{budget.key("rate", name, principal)}, window.Milliseconds(), limit).Int64Slice()
	if err != nil || len(values) != 2 {
		return false, 0, firstBudgetError(err)
	}
	return values[0] == 1, time.Duration(max(values[1], 0)) * time.Millisecond, nil
}

func (budget *redisRequestBudget) acquire(ctx context.Context, name string, principal string, limit int) (func(), bool, error) {
	key := budget.key("concurrent", name, principal)
	allowed, err := acquireBudgetScript.Run(ctx, budget.client, []string{key}, limit, sharedConcurrencyLease.Milliseconds()).Int64()
	if err != nil {
		return nil, false, err
	}
	if allowed != 1 {
		return nil, false, nil
	}
	return func() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = releaseBudgetScript.Run(releaseCtx, budget.client, []string{key}).Err()
	}, true, nil
}

func (budget *redisRequestBudget) key(kind string, name string, principal string) string {
	digest := sha256.Sum256([]byte(principal))
	prefix := budget.prefix
	if prefix == "" {
		prefix = "infinite-canvas:request-budget"
	}
	return prefix + ":" + kind + ":" + name + ":" + hex.EncodeToString(digest[:])
}

func firstBudgetError(err error) error {
	if err != nil {
		return err
	}
	return errors.New("共享请求预算响应无效")
}
