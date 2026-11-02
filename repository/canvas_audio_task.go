package repository

import "github.com/tigerowo/infinite-canvas/model"

func SaveCanvasAudioTask(task model.CanvasAudioTask) (model.CanvasAudioTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}
	return task, db.Create(&task).Error
}

func UpdateCanvasAudioTask(task model.CanvasAudioTask) (model.CanvasAudioTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}

	return task, db.Model(&model.CanvasAudioTask{}).
		Where("user_id = ? AND id = ? AND status <> ?", task.UserID, task.ID, "cancelled").
		Select(
			"Status", "Progress", "ResponseBody", "Error", "ErrorDetail",
			"AudioURL", "StorageKey", "MimeType", "Bytes",
			"UpdatedAt", "StartedAt", "CompletedAt",
		).
		Updates(&task).Error
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

func HasActiveCanvasAudioTasks() (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	var task model.CanvasAudioTask
	query := db.Model(&model.CanvasAudioTask{}).Select("id").
		Where("status IN ?", []string{"queued", "processing", "running", "in_progress"}).
		Limit(1).
		Find(&task)
	return query.RowsAffected > 0, query.Error
}

func DeleteFinishedCanvasAudioTasksBefore(before string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Where("completed_at <> ? AND completed_at < ?", "", before).
		Where("status IN ?", []string{"completed", "failed", "cancelled"}).
		Delete(&model.CanvasAudioTask{}).Error
}
