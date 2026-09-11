package repository

import (
	"errors"
	medialifecycle "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func SaveCanvasImageTask(task model.CanvasImageTask, epoch ...int64) (model.CanvasImageTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}
	return task, medialifecycle.CreateRecord(db, &task, epoch...)
}

func UpdateCanvasImageTask(task model.CanvasImageTask) (model.CanvasImageTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}

	return task, medialifecycle.SaveRecord(db, &task)
}

func GetUserCanvasImageTask(userID string, id string) (model.CanvasImageTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.CanvasImageTask{}, false, err
	}
	var task model.CanvasImageTask
	err = db.First(&task, "user_id = ? AND id = ?", userID, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.CanvasImageTask{}, false, nil
	}
	if err != nil {
		return model.CanvasImageTask{}, false, err
	}
	return task, true, nil
}

func ListUserCanvasImageTasks(userID string, sources []string, limit int) ([]model.CanvasImageTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 100
	}
	var tasks []model.CanvasImageTask
	query := db.Where("user_id = ?", userID)
	if len(sources) > 0 {
		query = query.Where("source IN ?", sources)
	}
	err = query.
		Order("created_at DESC").
		Limit(limit).
		Find(&tasks).Error
	return tasks, err
}

func BatchUserCanvasImageTasks(userID string, ids []string) ([]model.CanvasImageTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	keys := uniqueTrimmedValues(ids...)
	if len(keys) == 0 {
		return []model.CanvasImageTask{}, nil
	}
	var tasks []model.CanvasImageTask
	err = db.Where("user_id = ? AND id IN ?", userID, keys).Find(&tasks).Error
	return tasks, err
}

func DeleteUserCanvasImageTask(userID string, id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return medialifecycle.Release(db, userID, "image-task", strings.TrimSpace(id), 0, func(tx *gorm.DB) error {
		return tx.Where("user_id = ? AND id = ?", userID, strings.TrimSpace(id)).Delete(&model.CanvasImageTask{}).Error
	})
}

func DeleteUserCanvasTasks(userID string, sourceID string, nodeIDs []string) error {
	db, err := DB()
	if err != nil {
		return err
	}

	nodeIDs = uniqueTrimmedValues(nodeIDs...)

	return medialifecycle.WithLock(db, func(tx *gorm.DB, p *medialifecycle.Policy) error {
		if err := medialifecycle.GuardEpoch(*p, 0); err != nil {
			return err
		}
		deleteTasks := func(task any, kind string) error {
			query := tx.Where(
				"user_id = ? AND source = ? AND source_id = ?",
				userID,
				"canvas",
				sourceID,
			)
			if len(nodeIDs) > 0 {
				query = query.Where("node_id IN ?", nodeIDs)
			}
			var ids []string
			if err := query.Model(task).Pluck("id", &ids).Error; err != nil {
				return err
			}
			for _, id := range ids {
				if err := medialifecycle.ReleaseLocked(tx, *p, userID, kind, id, nil); err != nil {
					return err
				}
			}
			return query.Delete(task).Error
		}

		if err := deleteTasks(&model.CanvasImageTask{}, "image-task"); err != nil {
			return err
		}
		if err := deleteTasks(&model.CanvasAudioTask{}, "audio-task"); err != nil {
			return err
		}
		return deleteTasks(&model.VideoTask{}, "video-task")
	})
}

func uniqueTrimmedValues(values ...string) []string {
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
