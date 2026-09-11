package repository

import (
	"errors"
	medialifecycle "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func SaveCanvasAudioTask(task model.CanvasAudioTask, epoch ...int64) (model.CanvasAudioTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}
	return task, medialifecycle.CreateRecord(db, &task, epoch...)
}

func UpdateCanvasAudioTask(task model.CanvasAudioTask) (model.CanvasAudioTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}

	return task, medialifecycle.SaveRecord(db, &task)
}

func GetUserCanvasAudioTask(userID string, id string) (model.CanvasAudioTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.CanvasAudioTask{}, false, err
	}
	var task model.CanvasAudioTask
	err = db.First(&task, "user_id = ? AND id = ?", userID, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.CanvasAudioTask{}, false, nil
	}
	if err != nil {
		return model.CanvasAudioTask{}, false, err
	}
	return task, true, nil
}
