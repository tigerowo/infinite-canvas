package repository

import (
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// SaveStorageObject 保存存储对象记录。
func SaveStorageObject(object model.StorageObject) (model.StorageObject, error) {
	db, err := DB()
	if err != nil {
		return model.StorageObject{}, err
	}
	return object, db.Save(&object).Error
}

// GetStorageObject 根据 ID 获取存储对象。
func GetStorageObject(id string) (model.StorageObject, error) {
	db, err := DB()
	if err != nil {
		return model.StorageObject{}, err
	}
	var object model.StorageObject
	err = db.First(&object, "id = ?", id).Error
	return object, err
}

// DeleteStorageObjectRecord 删除存储对象记录（软删除）。
func DeleteStorageObjectRecord(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.StorageObject{}, "id = ?", id).Error
}

// GetStorageUsage 读取 Provider 在指定自然月内由本应用产生的操作计数。
func GetStorageUsage(providerID string, period string) (model.StorageUsage, error) {
	db, err := DB()
	if err != nil {
		return model.StorageUsage{}, err
	}
	var usage model.StorageUsage
	err = db.First(&usage, "provider_id = ? AND period = ?", providerID, period).Error
	if err == gorm.ErrRecordNotFound {
		return model.StorageUsage{ProviderID: providerID, Period: period}, nil
	}
	return usage, err
}

// IncrementStorageUsage 原子增加 Provider 的月度 A 类或 B 类操作计数。
func IncrementStorageUsage(providerID string, period string, operationClass string, updatedAt string) error {
	if providerID == "" {
		return nil
	}
	usage := model.StorageUsage{ProviderID: providerID, Period: period, UpdatedAt: updatedAt}
	column := "class_a_operations"
	usage.ClassAOperations = 1
	if operationClass == "b" {
		column = "class_b_operations"
		usage.ClassAOperations = 0
		usage.ClassBOperations = 1
	}
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "provider_id"}, {Name: "period"}},
		DoUpdates: clause.Assignments(map[string]any{
			column:       gorm.Expr(column+" + ?", 1),
			"updated_at": updatedAt,
		}),
	}).Create(&usage).Error
}
