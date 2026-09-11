package medialifecycle

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// RecordUse is the explicit inventory of business persistence units. Account
// configuration and system presets never enter the cleanup graph.
func RecordUse(row any) (Use, bool) {
	var input Use
	switch r := row.(type) {
	case *model.CanvasProject:
		input = Use{Owner: r.UserID, Kind: "canvas", ID: r.ID, Payload: r.ProjectData}
	case *model.VideoTask:
		input = Use{Owner: r.UserID, Kind: "video-task", ID: r.ID}
		input.Protection = taskProtection(r.CreatedAt, r.Status)
	case *model.CanvasImageTask:
		input = Use{Owner: r.UserID, Kind: "image-task", ID: r.ID}
		input.Protection = taskProtection(r.CreatedAt, r.Status)
	case *model.CanvasAudioTask:
		input = Use{Owner: r.UserID, Kind: "audio-task", ID: r.ID}
		input.Protection = taskProtection(r.CreatedAt, r.Status)
	case *model.VideoGenerationLog:
		input = Use{Owner: r.UserID, Kind: "video-history", ID: r.ID, Payload: r.PayloadJSON}
	case *model.ImageGenerationLog:
		input = Use{Owner: r.UserID, Kind: "image-history", ID: r.ID, Payload: r.PayloadJSON}
	case *model.AICallLog:
		owner := strings.TrimSpace(r.UserID)
		if owner == "" {
			owner = "@anonymous"
		}
		input = Use{Owner: owner, Kind: "ai-log", ID: r.ID}
	case *model.Asset:
		input = Use{Owner: "@admin-assets", Kind: "asset", ID: r.ID}
	case *model.CreativeWorkflow:
		input = Use{Owner: r.OwnerUserID, Kind: "workflow", ID: r.ID}
	case *model.AgentSkill:
		if r.Source != model.AgentSkillSourceUser {
			return input, false
		}
		input = Use{Owner: r.OwnerUserID, Kind: "skill", ID: r.ID}
	default:
		return input, false
	}
	if input.Owner == "" {
		input.Owner = "@anonymous"
	}
	if input.Payload == "" {
		raw, _ := json.Marshal(row)
		input.Payload = string(raw)
	}
	input.Files = ExtractFiles(input.Payload)
	input.Payload = activityPayload(input.Payload, strings.HasSuffix(input.Kind, "-task"))
	return input, true
}
func taskProtection(created, status string) int64 {
	if terminal(status) {
		return 0
	}
	start, err := time.Parse(time.RFC3339Nano, created)
	if err != nil {
		return timestamp() + Day
	}
	return start.UnixMilli() + Day
}
func terminal(status string) bool {
	switch status {
	case "completed", "succeeded", "success", "failed", "cancelled", "canceled", "timeout":
		return true
	}
	return false
}
func activityPayload(raw string, task bool) string {
	var payload map[string]any
	if json.Unmarshal([]byte(raw), &payload) != nil {
		return raw
	}
	for _, key := range []string{"updatedAt", "lastPolledAt", "lastResponse", "responseBody"} {
		delete(payload, key)
	}
	if task {
		delete(payload, "errorDetail")
	}
	bytes, err := json.Marshal(payload)
	if err != nil {
		return raw
	}
	return string(bytes)
}

func SaveRecord(db *gorm.DB, row any, epoch ...int64) error {
	input, tracked := RecordUse(row)
	if !tracked {
		return db.Save(row).Error
	}
	if len(epoch) > 0 {
		input.Epoch = epoch[0]
	}
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if err := guard(*p, input.Epoch); err != nil {
			return err
		}
		if strings.HasSuffix(input.Kind, "-task") {
			var entity Entity
			if err := tx.First(&entity, "entity_key = ?", Key(input.Owner, input.Kind, input.ID)).Error; err != nil {
				if notFound(err) {
					return ErrUnavailable
				}
				return err
			}
			if err := guard(*p, entity.Epoch); err != nil {
				return err
			}
			if entity.State != Active {
				return ErrConflict
			}
			var current map[string]any
			err := tx.Model(row).Where("id = ?", input.ID).Take(&current).Error
			if err != nil {
				if notFound(err) {
					return ErrUnavailable
				}
				return err
			}
			if err == nil {
				if fmt.Sprint(current["user_id"]) != input.Owner {
					return ErrForbidden
				}
				var incoming map[string]any
				raw, _ := json.Marshal(row)
				_ = json.Unmarshal(raw, &incoming)
				if terminal(fmt.Sprint(current["status"])) && fmt.Sprint(current["status"]) != fmt.Sprint(incoming["status"]) {
					return ErrConflict
				}
				if terminal(fmt.Sprint(current["status"])) {
					if entity.Fingerprint == Key(input.Payload) {
						return nil
					}
					return ErrConflict
				}
				storedAt, storedErr := time.Parse(time.RFC3339Nano, fmt.Sprint(current["updated_at"]))
				incomingAt, incomingErr := time.Parse(time.RFC3339Nano, fmt.Sprint(incoming["updatedAt"]))
				if storedErr == nil && incomingErr == nil && storedAt.After(incomingAt) {
					return ErrConflict
				}
			}
		}
		var result UseResult
		return saveUse(tx, *p, input, func(tx *gorm.DB) error { return tx.Save(row).Error }, &result)
	})
}

// CreateRecord is reserved for first submissions. It never overwrites a task
// belonging to another account, nor restarts an existing paid task.
func CreateRecord(db *gorm.DB, row any, epoch ...int64) error {
	input, ok := RecordUse(row)
	if !ok {
		return db.Create(row).Error
	}
	if len(epoch) > 0 {
		input.Epoch = epoch[0]
	}
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if input.Epoch == 0 && p.Epoch > 1 {
			return ErrConflict
		}
		if err := guard(*p, input.Epoch); err != nil {
			return err
		}
		var result UseResult
		if err := saveUse(tx, *p, input, func(tx *gorm.DB) error { return tx.Create(row).Error }, &result); err != nil {
			return err
		}
		if strings.HasSuffix(input.Kind, "-task") {
			state := "queued"
			if task, ok := row.(*model.VideoTask); ok && (task.UpstreamTaskID != "" || task.UpstreamVideoID != "") {
				state = "polling"
			}
			if terminal(taskStatus(row)) {
				state = "done"
			}
			return tx.Create(&TaskAttempt{ID: Key(input.Owner, input.Kind, input.ID), Owner: input.Owner, Kind: input.Kind, TaskID: input.ID, Started: timestamp(), Epoch: p.Epoch, State: state}).Error
		}
		return nil
	})
}

// TrackRecord must run in a WithLock transaction, after a successful business
// write. Failure rolls back that write as well as the dependency changes.
func TrackRecord(tx *gorm.DB, p Policy, row any) error {
	input, ok := RecordUse(row)
	if !ok {
		return nil
	}
	if err := guard(p, input.Epoch); err != nil {
		return err
	}
	var result UseResult
	return saveUse(tx, p, input, nil, &result)
}

// Backfill registers existing data once. It does not copy objects, change
// business bodies, or treat read/poll timestamps as proof of user activity.
func Backfill(db *gorm.DB) error {
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if p.MigratedAt != 0 {
			return nil
		}
		now := timestamp()
		var objects []model.StorageObject
		if err := tx.Where("deleted_at = ?", "").Find(&objects).Error; err != nil {
			return err
		}
		for _, object := range objects {
			if _, err := ensureFile(tx, *p, object.ID); err != nil {
				return err
			}
		}
		register := func(row any) error {
			input, ok := RecordUse(row)
			if !ok {
				return nil
			}
			activity, createdAt := backfillRecordTimes(row, now)
			e := Entity{Key: Key(input.Owner, input.Kind, input.ID), Owner: input.Owner, Kind: input.Kind, ID: input.ID, State: Active, Activity: activity, Created: createdAt, Fingerprint: Key(input.Payload), Protection: input.Protection, Version: 1, Epoch: p.Epoch}
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&e).Error; err != nil {
				return err
			}
			for _, id := range input.Files {
				f, err := ensureFile(tx, *p, id)
				if err == ErrUnavailable {
					continue
				}
				if err != nil {
					return err
				}
				if err := canUse(tx, input.Owner, f); err != nil {
					if err == ErrForbidden {
						continue
					}
					return err
				}
				if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&Reference{EntityKey: e.Key, FileID: id}).Error; err != nil {
					return err
				}
			}
			return nil
		}
		// Each source is explicitly mapped, including JSON-backed business data.
		var canvases []model.CanvasProject
		if err := tx.Where("deleted_at = ?", "").Find(&canvases).Error; err != nil {
			return err
		}
		for i := range canvases {
			if err := register(&canvases[i]); err != nil {
				return err
			}
		}
		var videos []model.VideoTask
		if err := tx.Find(&videos).Error; err != nil {
			return err
		}
		for i := range videos {
			if err := register(&videos[i]); err != nil {
				return err
			}
		}
		var images []model.CanvasImageTask
		if err := tx.Find(&images).Error; err != nil {
			return err
		}
		for i := range images {
			if err := register(&images[i]); err != nil {
				return err
			}
		}
		var audios []model.CanvasAudioTask
		if err := tx.Find(&audios).Error; err != nil {
			return err
		}
		for i := range audios {
			if err := register(&audios[i]); err != nil {
				return err
			}
		}
		var videoLogs []model.VideoGenerationLog
		if err := tx.Where("deleted_at = ?", "").Find(&videoLogs).Error; err != nil {
			return err
		}
		for i := range videoLogs {
			if err := register(&videoLogs[i]); err != nil {
				return err
			}
		}
		var imageLogs []model.ImageGenerationLog
		if err := tx.Where("deleted_at = ?", "").Find(&imageLogs).Error; err != nil {
			return err
		}
		for i := range imageLogs {
			if err := register(&imageLogs[i]); err != nil {
				return err
			}
		}
		var logs []model.AICallLog
		if err := tx.Find(&logs).Error; err != nil {
			return err
		}
		for i := range logs {
			if err := register(&logs[i]); err != nil {
				return err
			}
		}
		var assets []model.Asset
		if err := tx.Find(&assets).Error; err != nil {
			return err
		}
		for i := range assets {
			if err := register(&assets[i]); err != nil {
				return err
			}
		}
		var skills []model.AgentSkill
		if err := tx.Where("source = ?", model.AgentSkillSourceUser).Find(&skills).Error; err != nil {
			return err
		}
		for i := range skills {
			if err := register(&skills[i]); err != nil {
				return err
			}
		}
		var workflows []model.CreativeWorkflow
		if err := tx.Find(&workflows).Error; err != nil {
			return err
		}
		for i := range workflows {
			if err := register(&workflows[i]); err != nil {
				return err
			}
		}
		var configs []model.UserConfig
		if err := tx.Find(&configs).Error; err != nil {
			return err
		}
		for _, config := range configs {
			for _, entry := range []struct{ kind, field, collection string }{{"user-assets", config.AssetData, "assets"}, {"legacy-history", config.ImageHistory, "logs"}} {
				for _, input := range collectionUses(config.UserID, entry.kind, entry.collection, entry.field) {
					e := Entity{Key: Key(input.Owner, input.Kind, input.ID), Owner: input.Owner, Kind: input.Kind, ID: input.ID, State: Active, Activity: now, Created: now, Fingerprint: Key(input.Payload), Version: 1, Epoch: p.Epoch}
					if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&e).Error; err != nil {
						return err
					}
					for _, id := range ExtractFiles(input.Payload) {
						f, err := ensureFile(tx, *p, id)
						if err == ErrUnavailable {
							continue
						}
						if err != nil {
							return err
						}
						if canUse(tx, input.Owner, f) != nil {
							continue
						}
						if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&Reference{EntityKey: e.Key, FileID: id}).Error; err != nil {
							return err
						}
					}
				}
			}
		}
		p.MigratedAt = now
		return tx.Save(p).Error
	})
}

func backfillRecordTimes(row any, fallback int64) (int64, int64) {
	if logEntry, ok := row.(*model.AICallLog); ok {
		if created, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(logEntry.CreatedAt)); err == nil {
			value := created.UTC().UnixMilli()
			return value, value
		}
	}
	return fallback, fallback
}
func collectionUses(owner, kind, collection, raw string) []Use {
	var payload map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &payload) != nil {
		return nil
	}
	var entries []map[string]any
	if json.Unmarshal(payload[collection], &entries) != nil {
		return nil
	}
	result := []Use{}
	for _, entry := range entries {
		id, ok := entry["id"].(string)
		if !ok || id == "" {
			continue
		}
		data, err := json.Marshal(entry)
		if err == nil {
			result = append(result, Use{Owner: owner, Kind: kind, ID: id, Payload: activityPayload(string(data), false), Files: ExtractFiles(string(data))})
		}
	}
	return result
}

// SaveConfigField avoids a stale whole-row save overwriting another browser's
// model/storage configuration or resurrecting business collections after clear.
func SaveConfigField(db *gorm.DB, owner, column, raw string, epoch int64) error {
	allowed := map[string]string{"model_config": "", "storage_provider": "", "asset_data": "user-assets", "image_history": "legacy-history"}
	kind, ok := allowed[column]
	if !ok {
		return Error("配置字段无效")
	}
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if kind != "" {
			if err := guard(*p, epoch); err != nil {
				return err
			}
		}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.UserConfig{UserID: owner, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}).Error; err != nil {
			return err
		}
		if column == "asset_data" {
			var config model.UserConfig
			if err := tx.First(&config, "user_id = ?", owner).Error; err != nil {
				return err
			}
			var err error
			raw, err = compareAssetCollection(config.AssetData, raw)
			if err != nil {
				return err
			}
		}
		if kind != "" {
			collection := "assets"
			if kind == "legacy-history" {
				collection = "logs"
			}
			var decoded map[string]json.RawMessage
			if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
				return Error("业务数据格式无效")
			}
			inputs := collectionUses(owner, kind, collection, raw)
			keep := map[string]bool{}
			for _, input := range inputs {
				var result UseResult
				if err := saveUse(tx, *p, input, nil, &result); err != nil {
					return err
				}
				keep[input.ID] = true
			}
			var previous []Entity
			if err := tx.Where("owner = ? AND kind = ? AND state = ?", owner, kind, Active).Find(&previous).Error; err != nil {
				return err
			}
			for _, e := range previous {
				if !keep[e.ID] {
					e.State = Deleted
					e.Version++
					e.Activity = timestamp()
					if err := tx.Save(&e).Error; err != nil {
						return err
					}
					if err := tx.Where("entity_key = ?", e.Key).Delete(&Reference{}).Error; err != nil {
						return err
					}
				}
			}
		}
		return tx.Model(&model.UserConfig{}).Where("user_id = ?", owner).Updates(map[string]any{column: raw, "updated_at": time.Now().UTC().Format(time.RFC3339Nano)}).Error
	})
}
