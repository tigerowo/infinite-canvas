package taskidentity

import (
	"errors"
	"sync"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Identity struct {
	TaskID string `gorm:"primaryKey"`
	UserID string `gorm:"primaryKey"`
	Source string
}

func (Identity) TableName() string { return "ext_video_task_identity" }

var migrationMu sync.Mutex
var migrated = map[*gorm.DB]bool{}

func ensure(db *gorm.DB) error {
	migrationMu.Lock()
	defer migrationMu.Unlock()
	if migrated[db] {
		return nil
	}
	if err := db.AutoMigrate(&Identity{}); err != nil {
		return err
	}
	migrated[db] = true
	return nil
}

func Save(db *gorm.DB, taskID, userID, source string) error {
	if err := ensure(db); err != nil {
		return err
	}
	if source != "user" && source != "admin" && source != "local" {
		return errors.New("无效的视频任务凭证来源")
	}
	return db.Clauses(clause.OnConflict{DoNothing: true}).Create(&Identity{TaskID: taskID, UserID: userID, Source: source}).Error
}

func Load(db *gorm.DB, taskID, userID string) (string, error) {
	if err := ensure(db); err != nil {
		return "", err
	}
	var row Identity
	err := db.First(&row, "task_id = ? AND user_id = ?", taskID, userID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", nil
	}
	return row.Source, err
}
