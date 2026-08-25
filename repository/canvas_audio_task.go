package repository

import (
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
)

func SaveCanvasAudioTask(task model.CanvasAudioTask) (model.CanvasAudioTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}
	return task, db.Save(&task).Error
}

func UpdateCanvasAudioTask(task model.CanvasAudioTask) (model.CanvasAudioTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}

	return task, db.Model(&model.CanvasAudioTask{}).
		Where("user_id = ? AND id = ? AND status IN ?", task.UserID, task.ID, activeCanvasTaskStatuses).
		Select("*").
		Updates(&task).Error
}

func CancelUserCanvasAudioTask(userID string, id string, completedAt string) (model.CanvasAudioTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.CanvasAudioTask{}, false, err
	}
	result := db.Model(&model.CanvasAudioTask{}).
		Where("user_id = ? AND id = ? AND status IN ?", userID, strings.TrimSpace(id), activeCanvasTaskStatuses).
		Updates(map[string]any{"status": "cancelled", "error": "任务已取消", "completed_at": completedAt, "updated_at": completedAt})
	if result.Error != nil || result.RowsAffected == 0 {
		return model.CanvasAudioTask{}, false, result.Error
	}
	task, found, err := GetUserCanvasAudioTask(userID, id)
	return task, found, err
}

func GetUserCanvasAudioTask(userID string, id string) (model.CanvasAudioTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.CanvasAudioTask{}, false, err
	}
	var task model.CanvasAudioTask
	err = db.First(&task, "user_id = ? AND id = ?", userID, id).Error
	if err != nil {
		return model.CanvasAudioTask{}, false, nil
	}
	return task, true, nil
}
