package repository

import (
	"context"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

func CountActiveGenerationTasks(ctx context.Context, userID string) (int64, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	activeStatuses := []string{"queued", "in_progress", "processing", "running"}
	cutoff := time.Now().UTC().Add(-30 * time.Minute).Format(time.RFC3339Nano)
	models := []any{&model.VideoTask{}, &model.CanvasImageTask{}, &model.CanvasAudioTask{}}
	var total int64
	for _, item := range models {
		var count int64
		if err := db.WithContext(ctx).Model(item).Where("user_id = ? AND status IN ? AND created_at >= ?", userID, activeStatuses, cutoff).Count(&count).Error; err != nil {
			return 0, err
		}
		total += count
	}
	return total, nil
}
