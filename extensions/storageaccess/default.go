package storageaccess

import (
	"errors"
	"github.com/tigerowo/infinite-canvas/repository"
	"gorm.io/gorm"
)

const defaultUploadRow = "__default_upload_provider__"

func defaultUploadID(db *gorm.DB) (string, error) {
	var row configRow
	err := db.First(&row, "provider_id = ?", defaultUploadRow).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", nil
	}
	return row.Value, err
}

// Missing extension tables are legacy installations; the caller chooses the first usable provider.
func DefaultUploadID() (string, error) {
	db, err := repository.DB()
	if err != nil {
		return "", err
	}
	if !db.Migrator().HasTable(&configRow{}) {
		return "", nil
	}
	return defaultUploadID(db)
}
