package medialifecycle

import "context"

type epochKey struct{}

func WithEpoch(ctx context.Context, epoch int64) context.Context {
	return context.WithValue(ctx, epochKey{}, epoch)
}
func Epoch(ctx context.Context) int64 { value, _ := ctx.Value(epochKey{}).(int64); return value }
