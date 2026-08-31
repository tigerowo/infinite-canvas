package repository

import (
	"encoding/json"
	"errors"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func ListEnabledSystemAgentSkills() ([]model.AgentSkill, error) {
	items, err := listAgentSkills("source = ? AND enabled = ?", model.AgentSkillSourceSystem, true)
	if err != nil {
		return nil, err
	}
	return markAgentSkillsWithFiles(items)
}

func ListSystemAgentSkills() ([]model.AgentSkill, error) {
	items, err := listAgentSkills("source = ?", model.AgentSkillSourceSystem)
	if err != nil {
		return nil, err
	}
	return markAgentSkillsWithFiles(items)
}

func ListUserAgentSkills(userID string) ([]model.AgentSkill, error) {
	return listAgentSkills("source = ? AND owner_user_id = ?", model.AgentSkillSourceUser, userID)
}

func GetAgentSkill(id string) (model.AgentSkill, bool, error) {
	db, err := DB()
	if err != nil {
		return model.AgentSkill{}, false, err
	}
	var item model.AgentSkill
	err = db.First(&item, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.AgentSkill{}, false, nil
	}
	return item, err == nil, err
}

func SaveAgentSkill(item model.AgentSkill) (model.AgentSkill, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	return item, db.Save(&item).Error
}

func ListAgentSkillFiles(skillID string) ([]model.AgentSkillFile, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	items := make([]model.AgentSkillFile, 0)
	err = db.Where("skill_id = ?", skillID).Order("sort asc, path asc").Find(&items).Error
	return items, err
}

func GetAgentSkillFile(skillID string, filePath string) (model.AgentSkillFile, bool, error) {
	db, err := DB()
	if err != nil {
		return model.AgentSkillFile{}, false, err
	}
	var item model.AgentSkillFile
	err = db.First(&item, "skill_id = ? AND path = ? AND kind = ?", skillID, filePath, model.AgentSkillFileKindFile).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.AgentSkillFile{}, false, nil
	}
	return item, err == nil, err
}

func SaveAgentSkillPackage(item model.AgentSkill, files []model.AgentSkillFile) (model.AgentSkill, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	err = db.Transaction(func(tx *gorm.DB) error { return saveAgentSkillPackage(tx, &item, files) })
	for _, file := range files {
		if file.Kind == model.AgentSkillFileKindFile {
			item.HasFiles = true
			break
		}
	}
	item.Files = files
	return item, err
}

func InitializeAgentSkills(items []model.AgentSkill, files [][]model.AgentSkillFile, current string) error {
	if len(items) != len(files) {
		return errors.New("Skill 与文件包数量不一致")
	}
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		for index := range items {
			if err := saveAgentSkillPackage(tx, &items[index], files[index]); err != nil {
				return err
			}
		}
		return markAgentSkillsInitialized(tx, current)
	})
}

func DeleteUserAgentSkill(id string, userID string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.AgentSkill{}, "id = ? AND source = ? AND owner_user_id = ?", id, model.AgentSkillSourceUser, userID).Error
}

func DeleteSystemAgentSkill(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Delete(&model.AgentSkillFile{}, "skill_id = ?", id).Error; err != nil {
			return err
		}
		return tx.Delete(&model.AgentSkill{}, "id = ? AND source = ?", id, model.AgentSkillSourceSystem).Error
	})
}

func AgentSkillsInitialized() (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	var count int64
	err = db.Model(&model.Setting{}).Where("key = ?", model.SettingKeyAgentSkillsInitialized).Count(&count).Error
	return count > 0, err
}

func MarkAgentSkillsInitialized(current string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return markAgentSkillsInitialized(db, current)
}

func saveAgentSkillPackage(db *gorm.DB, item *model.AgentSkill, files []model.AgentSkillFile) error {
	if err := db.Save(item).Error; err != nil {
		return err
	}
	if err := db.Delete(&model.AgentSkillFile{}, "skill_id = ?", item.ID).Error; err != nil {
		return err
	}
	if len(files) > 0 {
		return db.Create(&files).Error
	}
	return nil
}

func markAgentSkillsInitialized(db *gorm.DB, current string) error {
	item := model.Setting{Key: model.SettingKeyAgentSkillsInitialized, Value: json.RawMessage("true"), CreatedAt: current, UpdatedAt: current}
	return db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "key"}}, DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"})}).Create(&item).Error
}

func listAgentSkills(query string, args ...any) ([]model.AgentSkill, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.AgentSkill
	err = db.Where(query, args...).Order("sort asc, updated_at desc").Find(&items).Error
	return items, err
}

func markAgentSkillsWithFiles(items []model.AgentSkill) ([]model.AgentSkill, error) {
	if len(items) == 0 {
		return items, nil
	}
	db, err := DB()
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(items))
	for index := range items {
		ids[index] = items[index].ID
	}
	var fileSkillIDs []string
	if err := db.Model(&model.AgentSkillFile{}).Distinct("skill_id").Where("skill_id IN ? AND kind = ?", ids, model.AgentSkillFileKindFile).Pluck("skill_id", &fileSkillIDs).Error; err != nil {
		return nil, err
	}
	hasFiles := make(map[string]struct{}, len(fileSkillIDs))
	for _, id := range fileSkillIDs {
		hasFiles[id] = struct{}{}
	}
	for index := range items {
		_, items[index].HasFiles = hasFiles[items[index].ID]
	}
	return items, nil
}
