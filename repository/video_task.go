package repository

import "github.com/tigerowo/infinite-canvas/model"

var activeVideoTaskStatuses = []string{"queued", "in_progress", "processing", "running"}

func SaveVideoTask(task model.VideoTask) (model.VideoTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}
	return task, db.Save(&task).Error
}

func UpdateActiveVideoTask(task model.VideoTask) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.VideoTask{}).
		Where("id = ? AND status IN ?", task.ID, activeVideoTaskStatuses).
		Select("*").
		Updates(&task).Error
}

func CancelUserVideoTask(userID string, id string, completedAt string) (model.VideoTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.VideoTask{}, false, err
	}
	result := db.Model(&model.VideoTask{}).
		Where("user_id = ? AND (id = ? OR upstream_task_id = ? OR upstream_video_id = ?)", userID, id, id, id).
		Where("status IN ?", activeVideoTaskStatuses).
		Updates(map[string]any{"status": "cancelled", "error": "任务已取消", "completed_at": completedAt, "updated_at": completedAt})
	if result.Error != nil || result.RowsAffected == 0 {
		return model.VideoTask{}, false, result.Error
	}
	task, found, err := GetUserVideoTask(userID, id)
	return task, found, err
}

func GetVideoTask(id string) (model.VideoTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.VideoTask{}, false, err
	}
	var task model.VideoTask
	err = db.First(&task, "id = ?", id).Error
	if err != nil {
		return model.VideoTask{}, false, nil
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
		return model.VideoTask{}, false, nil
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
		Where("status IN ?", activeVideoTaskStatuses).
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
	return db.Where("user_id = ? AND (id = ? OR upstream_task_id = ? OR upstream_video_id = ?)", userID, id, id, id).Delete(&model.VideoTask{}).Error
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
	err = db.Where("status IN ?", activeVideoTaskStatuses).
		Order("created_at ASC").
		Limit(limit).
		Find(&tasks).Error
	return tasks, err
}

func DeleteFinishedVideoTasksBefore(before string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.
		Where("completed_at <> ? AND completed_at < ?", "", before).
		Where("status IN ?", []string{"succeeded", "completed", "failed", "cancelled", "canceled", "timed_out"}).
		Delete(&model.VideoTask{}).Error
}
