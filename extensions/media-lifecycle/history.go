package medialifecycle

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func historyTable(kind string) (string, string, error) {
	switch kind {
	case "image-history":
		return "image_generation_logs", "image_id", nil
	case "video-history":
		return "video_generation_logs", "video_id", nil
	}
	return "", "", Error("历史类型无效")
}
func historyTerminal(status string) bool {
	return terminal(status) || status == "成功" || status == "失败" || status == "error"
}
func historyRevision(raw string) int64 {
	var value struct {
		ArchiveRecovery int64 `json:"archiveRecovery"`
	}
	_ = json.Unmarshal([]byte(raw), &value)
	return value.ArchiveRecovery
}
func columnString(value any) string {
	if value == nil {
		return ""
	}
	if bytes, ok := value.([]byte); ok {
		return string(bytes)
	}
	return fmt.Sprint(value)
}

// History upserts and deletion use the same metadata lock as cleanup. Queries,
// aliases, tombstones, the business row and dependency graph commit together.
func SaveHistory(db *gorm.DB, owner, kind string, rows []any, epoch int64) error {
	table, output, err := historyTable(kind)
	if err != nil {
		return err
	}
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if epoch == 0 && p.Epoch > 1 {
			return ErrConflict
		}
		if err := guard(*p, epoch); err != nil {
			return err
		}
		for _, row := range rows {
			input, ok := RecordUse(row)
			if !ok || input.Owner != owner || input.Kind != kind || strings.TrimSpace(input.ID) == "" {
				return Error("历史记录无效")
			}
			var taskID, outputID, status, payload string
			switch log := row.(type) {
			case *model.ImageGenerationLog:
				taskID, outputID, status, payload = log.TaskID, log.ImageID, log.Status, log.PayloadJSON
			case *model.VideoGenerationLog:
				taskID, outputID, status, payload = log.TaskID, log.VideoID, log.Status, log.PayloadJSON
			}
			keys := unique([]string{input.ID, taskID, outputID})
			var removed int64
			if err := tx.Model(&Entity{}).Where("owner = ? AND kind = ? AND id IN ? AND state <> ?", owner, kind, keys, Active).Count(&removed).Error; err != nil {
				return err
			}
			if removed > 0 {
				continue
			}
			if err := tx.Table(table).Where("user_id = ? AND deleted_at <> ? AND (id IN ? OR task_id IN ? OR "+output+" IN ?)", owner, "", keys, keys, keys).Count(&removed).Error; err != nil {
				return err
			}
			if removed > 0 {
				continue
			}
			var current map[string]any
			err := tx.Table(table).Where("id = ?", input.ID).Take(&current).Error
			if err != nil && !notFound(err) {
				return err
			}
			found := err == nil
			if found && columnString(current["user_id"]) != owner {
				return ErrForbidden
			}
			if !found && (taskID != "" || outputID != "") {
				err = tx.Table(table).Where("user_id = ? AND ((task_id = ? AND task_id <> '') OR ("+output+" = ? AND "+output+" <> ''))", owner, taskID, outputID).Order("created_at ASC").Take(&current).Error
				if err != nil && !notFound(err) {
					return err
				}
				found = err == nil
			}
			if found {
				if columnString(current["deleted_at"]) != "" {
					continue
				}
				previousRevision, nextRevision := historyRevision(columnString(current["payload_json"])), historyRevision(payload)
				if nextRevision < previousRevision || (nextRevision == previousRevision && historyTerminal(columnString(current["status"])) && !historyTerminal(status)) {
					continue
				}
				input.ID = columnString(current["id"])
			}
			var content map[string]any
			if json.Unmarshal([]byte(payload), &content) != nil || content == nil {
				return Error("历史内容格式无效")
			}
			content["id"] = input.ID
			raw, err := json.Marshal(content)
			if err != nil {
				return err
			}
			switch log := row.(type) {
			case *model.ImageGenerationLog:
				log.ID, log.DeletedAt, log.PayloadJSON = input.ID, "", string(raw)
			case *model.VideoGenerationLog:
				log.ID, log.DeletedAt, log.PayloadJSON = input.ID, "", string(raw)
			}
			input, _ = RecordUse(row)
			var result UseResult
			if err := saveUse(tx, *p, input, func(tx *gorm.DB) error { return tx.Save(row).Error }, &result); err != nil {
				return err
			}
		}
		return nil
	})
}

func DeleteHistory(db *gorm.DB, owner, kind string, ids []string, deletedAt string, epoch int64) error {
	table, output, err := historyTable(kind)
	if err != nil {
		return err
	}
	keys := unique(ids)
	if len(keys) == 0 {
		return nil
	}
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if epoch == 0 && p.Epoch > 1 {
			return ErrConflict
		}
		if err := guard(*p, epoch); err != nil {
			return err
		}
		var rows []map[string]any
		if err := tx.Table(table).Where("user_id = ? AND (id IN ? OR task_id IN ? OR "+output+" IN ?)", owner, keys, keys, keys).Find(&rows).Error; err != nil {
			return err
		}
		all := append([]string{}, keys...)
		for _, row := range rows {
			id := columnString(row["id"])
			all = append(all, id, columnString(row["task_id"]), columnString(row[output]))
			if err := tx.Table(table).Where("user_id = ? AND id = ?", owner, id).Updates(map[string]any{"deleted_at": deletedAt, "updated_at": deletedAt, "payload_json": ""}).Error; err != nil {
				return err
			}
		}
		for _, id := range unique(all) {
			if err := ReleaseLocked(tx, *p, owner, kind, id, nil); err != nil {
				return err
			}
		}
		return nil
	})
}

func MigrateLegacyImageHistory(db *gorm.DB, owner, original string, rows []any, epoch int64) error {
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if epoch == 0 && p.Epoch > 1 {
			return ErrConflict
		}
		if err := guard(*p, epoch); err != nil {
			return err
		}
		var config model.UserConfig
		if err := tx.First(&config, "user_id = ?", owner).Error; err != nil {
			return err
		}
		if config.ImageHistory == "" {
			return nil
		}
		if config.ImageHistory != original {
			return ErrConflict
		}
		if err := SaveHistory(tx, owner, "image-history", rows, epoch); err != nil {
			return err
		}
		var previous []Entity
		if err := tx.Where("owner = ? AND kind = ? AND state = ?", owner, "legacy-history", Active).Find(&previous).Error; err != nil {
			return err
		}
		for _, e := range previous {
			if err := ReleaseLocked(tx, *p, owner, e.Kind, e.ID, nil); err != nil {
				return err
			}
		}
		return tx.Model(&model.UserConfig{}).Where("user_id = ?", owner).Update("image_history", "").Error
	})
}
