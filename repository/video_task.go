package repository

import (
	"errors"
	medialifecycle "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func SaveVideoTask(task model.VideoTask) (model.VideoTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}
	return task, medialifecycle.SaveRecord(db, &task)
}

func CreateVideoTask(task model.VideoTask, epoch ...int64) (model.VideoTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}
	return task, medialifecycle.CreateRecord(db, &task, epoch...)
}

func GetVideoTask(id string) (model.VideoTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.VideoTask{}, false, err
	}
	var task model.VideoTask
	err = db.First(&task, "id = ?", id).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return model.VideoTask{}, false, nil
		}
		return model.VideoTask{}, false, err
	}
	return task, true, nil
}

func GetUserVideoTask(userID string, id string) (model.VideoTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.VideoTask{}, false, err
	}
	var task model.VideoTask
	err = db.First(&task, "user_id = ? AND (id = ? OR upstream_task_id = ? OR upstream_video_id = ?)", userID, id, id, id).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return model.VideoTask{}, false, nil
		}
		return model.VideoTask{}, false, err
	}
	return task, true, nil
}

func ListUserVideoTasks(userID string, source string, limit int) ([]model.VideoTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 100
	}
	var tasks []model.VideoTask
	query := db.Where("user_id = ?", userID)
	if source != "" {
		if source == "video-workbench" {
			query = query.Where("(source = ? OR source = '' OR source IS NULL)", source)
		} else {
			query = query.Where("source = ?", source)
		}
	}
	err = query.
		Order("created_at DESC").
		Limit(limit).
		Find(&tasks).Error
	return tasks, err
}

func DeleteUserVideoTask(userID string, id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	var task model.VideoTask
	if err := db.Where("user_id = ? AND (id = ? OR upstream_task_id = ? OR upstream_video_id = ?)", userID, id, id, id).First(&task).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	return medialifecycle.Release(db, userID, "video-task", task.ID, 0, func(tx *gorm.DB) error {
		return tx.Where("user_id = ? AND id = ?", userID, task.ID).Delete(&model.VideoTask{}).Error
	})
}

func ListDueVideoTasks(limit int) ([]model.VideoTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 100
	}
	var tasks []model.VideoTask
	err = db.Where("status IN ?", []string{"queued", "in_progress", "processing", "running"}).
		Where("NOT EXISTS (SELECT 1 FROM ext_media_lifecycle_task_attempts a WHERE a.task_id = video_tasks.id AND a.owner = video_tasks.user_id AND a.state IN ?)", []string{"submitting", "result", "archive_failed", "unknown"}).
		Order("created_at ASC").
		Limit(limit).
		Find(&tasks).Error
	return tasks, err
}

func DeleteFinishedVideoTasksBefore(before string) error {
	// EXT-0045: all terminal history now follows the unified retention policy.
	return nil
}
