package medialifecycle

import "gorm.io/gorm"

// The source lookup is published only while its uploaded object is still valid
// in the same epoch. This closes the PUT -> index -> clear race without a new PUT.
func SaveFileIndex(db *gorm.DB, owner, fileID string, epoch int64, save func(*gorm.DB) error) error {
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if err := guard(*p, epoch); err != nil {
			return err
		}
		var file File
		if err := tx.First(&file, "id = ?", fileID).Error; err != nil {
			return err
		}
		if file.Epoch != p.Epoch {
			return ErrConflict
		}
		if err := canUse(tx, owner, file); err != nil {
			return err
		}
		return save(tx)
	})
}

func deleteOptionalIndex(tx *gorm.DB, table, condition string, args ...any) error {
	// These existing extensions are registered after the lifecycle backfill.
	if !tx.Migrator().HasTable(table) {
		return nil
	}
	return tx.Table(table).Where(condition, args...).Delete(map[string]any{}).Error
}
