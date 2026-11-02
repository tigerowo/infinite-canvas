package repository

import (
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func SaveFailedTranslatedVideoTask(task model.VideoTask, refundLog model.CreditLog) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		updated := tx.Model(&model.VideoTask{}).Where("id = ? AND status NOT IN ?", task.ID, []string{"completed", "failed", "cancelled", "canceled"}).Select("*").Omit("RequestBody", "ResponseBody", "WorkflowRef").Updates(&task)
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected == 0 || refundLog.Amount <= 0 {
			return nil
		}
		user, found, err := refundUserCredits(tx, task.UserID, refundLog.Amount, refundLog.CreatedAt)
		if err != nil {
			return err
		}
		if !found {
			return gorm.ErrRecordNotFound
		}
		refundLog.Balance = user.Credits
		return tx.Create(&refundLog).Error
	})
}

func SaveVideoTask(task model.VideoTask) (model.VideoTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}
	if err := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&task).Error; err != nil {
		return task, err
	}
	update := db.Model(&model.VideoTask{}).Where("user_id = ? AND id = ? AND status <> ?", task.UserID, task.ID, "cancelled").Select("*").Updates(&task)
	if update.Error == nil && update.RowsAffected == 0 {
		update = db.First(&task, "user_id = ? AND id = ?", task.UserID, task.ID)
	}
	return task, update.Error
}

func UpdateVideoTask(task model.VideoTask) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.VideoTask{}).
		Where("id = ? AND status <> ?", task.ID, "cancelled").
		Select(
			"UpstreamTaskID", "Status", "Progress", "Seconds", "Size",
			"VideoURL", "Error", "ErrorDetail",
			"ParameterTranslationSnapshot", "LastResponse",
			"UpdatedAt", "LastPolledAt", "CompletedAt",
		).
		Updates(&task).Error
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
		Where("status IN ?", []string{"queued", "in_progress", "processing", "running"}).
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
	err = db.Omit("RequestBody", "ResponseBody", "WorkflowRef").Where("status IN ?", []string{"queued", "in_progress", "processing", "running", "unknown"}).Where("(workflow_ref = '' OR workflow_ref IS NULL)").
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
		Where("status IN ?", []string{"completed", "failed", "cancelled", "canceled"}).
		Delete(&model.VideoTask{}).Error
}
