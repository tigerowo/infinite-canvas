package repository

import (
	medialifecycle "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
)

func ListVideoGenerationLogs(userID string, limit int) ([]model.VideoGenerationLog, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 500
	}
	var logs []model.VideoGenerationLog
	err = db.Where("user_id = ? AND deleted_at = ?", userID, "").Order("created_at DESC").Limit(limit).Find(&logs).Error
	return logs, err
}

func HasAnyVideoGenerationLog(userID string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	var count int64
	err = db.Model(&model.VideoGenerationLog{}).Where("user_id = ?", userID).Count(&count).Error
	return count > 0, err
}

func UpsertVideoGenerationLogs(userID string, logs []model.VideoGenerationLog, epoch ...int64) error {
	db, err := DB()
	if err != nil {
		return err
	}
	rows := make([]any, 0, len(logs))
	for i := range logs {
		logs[i].UserID = userID
		rows = append(rows, &logs[i])
	}
	return medialifecycle.SaveHistory(db, userID, "video-history", rows, generationLogEpoch(epoch))
}

func SoftDeleteVideoGenerationLog(userID string, id string, deletedAt string, epoch ...int64) error {
	return SoftDeleteVideoGenerationLogs(userID, []string{id}, deletedAt, epoch...)
}

func SoftDeleteVideoGenerationLogs(userID string, ids []string, deletedAt string, epoch ...int64) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return medialifecycle.DeleteHistory(db, userID, "video-history", generationLogIdentityValues(ids...), deletedAt, generationLogEpoch(epoch))
}

func CleanupDeletedVideoGenerationLogs(before string) error {
	// Tombstones are compacted together with the lifecycle sync boundary.
	return nil
}

func ListImageGenerationLogs(userID string, limit int) ([]model.ImageGenerationLog, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 500
	}
	var logs []model.ImageGenerationLog
	err = db.Where("user_id = ? AND deleted_at = ?", userID, "").Order("created_at DESC").Limit(limit).Find(&logs).Error
	return logs, err
}

func HasAnyImageGenerationLog(userID string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	var count int64
	err = db.Model(&model.ImageGenerationLog{}).Where("user_id = ?", userID).Count(&count).Error
	return count > 0, err
}

func UpsertImageGenerationLogs(userID string, logs []model.ImageGenerationLog, epoch ...int64) error {
	db, err := DB()
	if err != nil {
		return err
	}
	rows := make([]any, 0, len(logs))
	for i := range logs {
		logs[i].UserID = userID
		rows = append(rows, &logs[i])
	}
	return medialifecycle.SaveHistory(db, userID, "image-history", rows, generationLogEpoch(epoch))
}

func SoftDeleteImageGenerationLog(userID string, id string, deletedAt string, epoch ...int64) error {
	return SoftDeleteImageGenerationLogs(userID, []string{id}, deletedAt, epoch...)
}

func SoftDeleteImageGenerationLogs(userID string, ids []string, deletedAt string, epoch ...int64) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return medialifecycle.DeleteHistory(db, userID, "image-history", generationLogIdentityValues(ids...), deletedAt, generationLogEpoch(epoch))
}

func CleanupDeletedImageGenerationLogs(before string) error {
	return nil
}

func generationLogIdentityValues(values ...string) []string {
	result := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !seen[value] {
			result = append(result, value)
			seen[value] = true
		}
	}
	return result
}

func generationLogEpoch(epoch []int64) int64 {
	if len(epoch) > 0 {
		return epoch[0]
	}
	return 0
}
