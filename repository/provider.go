package repository

import (
	"errors"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func ListProviders(ownerUserID string, kind model.ProviderKind) ([]model.Provider, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	items := []model.Provider{}
	tx := db.Where("owner_user_id = ?", ownerUserID)
	if kind != "" {
		tx = tx.Where("kind = ?", kind)
	}
	err = tx.Order("kind asc, sort_order asc, created_at asc").Find(&items).Error
	return items, err
}

func GetProvider(ownerUserID string, id string) (model.Provider, bool, error) {
	db, err := DB()
	if err != nil {
		return model.Provider{}, false, err
	}
	var item model.Provider
	err = db.Where("owner_user_id = ? AND id = ?", ownerUserID, id).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.Provider{}, false, nil
	}
	return item, err == nil, err
}

func SaveProvider(item model.Provider) (model.Provider, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	return item, db.Save(&item).Error
}

func NextProviderSortOrder(ownerUserID string, kind model.ProviderKind) (int, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	var maximum int
	if err := db.Model(&model.Provider{}).Where("owner_user_id = ? AND kind = ?", ownerUserID, kind).Select("COALESCE(MAX(sort_order), -1)").Scan(&maximum).Error; err != nil {
		return 0, err
	}
	return maximum + 1, nil
}

func DeleteProvider(ownerUserID string, id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Where("owner_user_id = ? AND id = ?", ownerUserID, id).Delete(&model.Provider{}).Error
}

func SetDefaultProvider(ownerUserID string, id string, kind model.ProviderKind) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.Provider{}).Where("owner_user_id = ? AND kind = ?", ownerUserID, kind).Update("is_default", false).Error; err != nil {
			return err
		}
		return tx.Model(&model.Provider{}).Where("owner_user_id = ? AND id = ? AND kind = ?", ownerUserID, id, kind).Update("is_default", true).Error
	})
}

func ProviderReferenceCount(ownerUserID string, providerID string) (int64, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	var total int64
	for _, table := range []string{"video_tasks", "canvas_image_tasks", "canvas_audio_tasks", "ai_call_logs"} {
		var count int64
		if err := db.Table(table).Where("user_id = ? AND channel_id = ?", ownerUserID, providerID).Count(&count).Error; err != nil {
			return 0, err
		}
		total += count
	}
	return total, nil
}

// ImportProvidersAndUserConfig atomically imports providers and optionally rewrites
// the user's legacy model config after credentials have been encrypted by service.
func ImportProvidersAndUserConfig(items []model.Provider, config *model.UserConfig) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		for _, item := range items {
			if err := tx.Create(&item).Error; err != nil {
				return err
			}
		}
		if config == nil {
			return nil
		}
		config.UpdatedAt = userConfigTimestamp()
		return tx.Save(config).Error
	})
}
