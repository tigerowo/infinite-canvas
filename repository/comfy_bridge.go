package repository

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrComfyBridgeLeaseLost = errors.New("Bridge 请求租约已失效")

func SaveComfyBridge(bridge model.ComfyBridge) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Create(&bridge).Error
}

func UpdateComfyBridgeHeartbeat(bridge model.ComfyBridge) error {
	db, err := DB()
	if err != nil {
		return err
	}
	updated := db.Model(&model.ComfyBridge{}).Where("id = ? AND enabled = ?", bridge.ID, true).Updates(map[string]any{"last_seen_at": bridge.LastSeenAt, "capabilities_json": bridge.CapabilitiesJSON, "updated_at": bridge.UpdatedAt})
	if updated.Error != nil {
		return updated.Error
	}
	if updated.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func ListComfyBridges(scope, ownerID string) ([]model.ComfyBridge, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var bridges []model.ComfyBridge
	err = db.Where("owner_scope = ? AND owner_id = ?", scope, ownerID).Order("created_at DESC").Find(&bridges).Error
	return bridges, err
}

func GetComfyBridge(id string) (model.ComfyBridge, error) {
	db, err := DB()
	if err != nil {
		return model.ComfyBridge{}, err
	}
	var bridge model.ComfyBridge
	err = db.First(&bridge, "id = ?", id).Error
	return bridge, err
}

func GetComfyBridgeByTokenHash(hash string) (model.ComfyBridge, error) {
	db, err := DB()
	if err != nil {
		return model.ComfyBridge{}, err
	}
	var bridge model.ComfyBridge
	err = db.First(&bridge, "token_hash = ? AND enabled = ?", hash, true).Error
	return bridge, err
}

func clearComfyBridgeReference(raw []byte, channelsKey, bridgeID string) (json.RawMessage, bool, error) {
	if len(raw) == 0 {
		return raw, false, nil
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, false, err
	}
	rawChannels, ok := data[channelsKey]
	if !ok {
		return raw, false, nil
	}
	var channels []map[string]json.RawMessage
	if err := json.Unmarshal(rawChannels, &channels); err != nil {
		return nil, false, err
	}
	changed := false
	for _, channel := range channels {
		var protocol, currentBridgeID string
		_ = json.Unmarshal(channel["protocol"], &protocol)
		_ = json.Unmarshal(channel["bridgeId"], &currentBridgeID)
		if protocol == "comfyui" && currentBridgeID == bridgeID {
			delete(channel, "bridgeId")
			changed = true
		}
	}
	if !changed {
		return raw, false, nil
	}
	encodedChannels, err := json.Marshal(channels)
	if err != nil {
		return nil, false, err
	}
	data[channelsKey] = encodedChannels
	encoded, err := json.Marshal(data)
	return encoded, true, err
}

func DeleteComfyBridge(id, scope, ownerID string) ([]string, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var taskIDs []string
	now := time.Now()
	err = db.Transaction(func(tx *gorm.DB) error {
		deleted := tx.Where("id = ? AND owner_scope = ? AND owner_id = ?", id, scope, ownerID).Delete(&model.ComfyBridge{})
		if deleted.Error != nil {
			return deleted.Error
		}
		if deleted.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		switch scope {
		case "system":
			var setting model.Setting
			err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where(map[string]any{"key": model.SettingKeyPrivate}).First(&setting).Error
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			if err == nil {
				value, changed, err := clearComfyBridgeReference(setting.Value, "channels", id)
				if err != nil {
					return err
				}
				if changed {
					setting.Value, setting.UpdatedAt = value, userConfigTimestamp()
					if err := tx.Select("Value", "UpdatedAt").Save(&setting).Error; err != nil {
						return err
					}
				}
			}
		case "personal":
			var config model.UserConfig
			err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&config, "user_id = ?", ownerID).Error
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			if err == nil {
				value, changed, err := clearComfyBridgeReference([]byte(config.ModelConfig), "localChannels", id)
				if err != nil {
					return err
				}
				if changed {
					config.ModelConfig, config.UpdatedAt = string(value), userConfigTimestamp()
					if err := tx.Select("ModelConfig", "UpdatedAt").Save(&config).Error; err != nil {
						return err
					}
				}
			}
		default:
			return errors.New("Bridge 归属类型无效")
		}
		activeStatuses := []string{"pending", "claimed"}
		var requests []model.ComfyBridgeRequest
		if err := tx.Model(&model.ComfyBridgeRequest{}).
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Select("id", "task_id").
			Where("bridge_id = ? AND status IN ?", id, activeStatuses).
			Find(&requests).Error; err != nil {
			return err
		}
		inspectIDs := make([]string, 0)
		for _, request := range requests {
			taskIDs = append(taskIDs, request.TaskID)
			if request.TaskID == "" {
				inspectIDs = append(inspectIDs, request.ID)
			}
		}
		if err := tx.Model(&model.ComfyBridgeRequest{}).
			Where(
				"bridge_id = ? AND status IN ? AND cleanup_ready_at IS NULL",
				id,
				[]string{"succeeded", "failed"},
			).
			Updates(map[string]any{
				"cleanup_ready_at": now,
				"updated_at":       now,
			}).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.ComfyBridgeRequest{}).
			Where("bridge_id = ? AND status IN ?", id, activeStatuses).
			Updates(map[string]any{
				"status":       "failed",
				"error":        "Bridge 设备已删除",
				"completed_at": now,
				"updated_at":   now,
			}).Error; err != nil {
			return err
		}
		if len(inspectIDs) == 0 {
			return nil
		}
		return tx.Model(&model.ComfyBridgeRequest{}).
			Where("id IN ?", inspectIDs).
			Updates(map[string]any{
				"cleanup_ready_at": now,
				"updated_at":       now,
			}).Error
	})
	return taskIDs, err
}

func SaveComfyBridgeRequest(request model.ComfyBridgeRequest) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if request.TaskID != "" {
			task := map[string]any{"image": &model.CanvasImageTask{}, "video": &model.VideoTask{}, "audio": &model.CanvasAudioTask{}}[request.Kind]
			var state struct{ Status string }
			if err := tx.Model(task).Clauses(clause.Locking{Strength: "UPDATE"}).Select("status").Where("id = ?", request.TaskID).Take(&state).Error; err != nil {
				return err
			}
			if state.Status == "cancelled" {
				current := time.Now()
				request.Status, request.Error = "failed", "用户停止"
				request.CompletedAt, request.CleanupReadyAt = &current, &current
			}
		}
		var bridge model.ComfyBridge
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND owner_scope = ? AND owner_id = ? AND enabled = ?", request.BridgeID, request.OwnerScope, request.OwnerID, true).First(&bridge).Error; err != nil {
			return errors.New("Bridge 不存在或无权使用")
		}
		return tx.Create(&request).Error
	})
}

func GetComfyBridgeRequest(id string) (model.ComfyBridgeRequest, error) {
	db, err := DB()
	if err != nil {
		return model.ComfyBridgeRequest{}, err
	}
	var request model.ComfyBridgeRequest
	err = db.First(&request, "id = ?", id).Error
	return request, err
}

func DeleteComfyBridgeInspectRequest(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Where("id = ? AND kind = ?", id, "inspect_workflow").
		Delete(&model.ComfyBridgeRequest{}).Error
}

func GetComfyBridgeRequestByTaskID(taskID string) (model.ComfyBridgeRequest, bool, error) {
	db, err := DB()
	if err != nil {
		return model.ComfyBridgeRequest{}, false, err
	}
	var request model.ComfyBridgeRequest
	err = db.Where("task_id = ?", taskID).First(&request).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.ComfyBridgeRequest{}, false, nil
	}
	return request, err == nil, err
}

func ClaimComfyBridgeRequest(bridgeID, queue, leaseToken string, leaseExpiresAt time.Time) (*model.ComfyBridgeRequest, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var claimed *model.ComfyBridgeRequest
	err = db.Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		var request model.ComfyBridgeRequest
		query := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where(
			"bridge_id = ? AND expires_at > ? AND (status = ? OR (status = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))",
			bridgeID,
			now,
			"pending",
			"claimed",
			now,
		)
		if queue == "inspect" {
			query = query.Where("kind = ?", "inspect_workflow")
		} else {
			query = query.Where("kind <> ?", "inspect_workflow")
		}
		if err := query.Order("created_at ASC").First(&request).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		update := tx.Model(&model.ComfyBridgeRequest{}).Where(
			"id = ? AND expires_at > ? AND (status = ? OR (status = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))",
			request.ID,
			now,
			"pending",
			"claimed",
			now,
		)
		if queue == "inspect" {
			update = update.Where("kind = ?", "inspect_workflow")
		} else {
			update = update.Where("kind <> ?", "inspect_workflow")
		}
		update = update.Updates(map[string]any{
			"status":           "claimed",
			"claimed_at":       now,
			"lease_token":      leaseToken,
			"lease_expires_at": leaseExpiresAt,
			"updated_at":       now,
		})
		if update.Error != nil {
			return update.Error
		}
		if update.RowsAffected == 1 {
			request.Status = "claimed"
			request.ClaimedAt = &now
			request.LeaseToken = leaseToken
			request.LeaseExpiresAt = &leaseExpiresAt
			claimed = &request
		}
		return nil
	})
	return claimed, err
}

func UpdateComfyBridgeLease(id, bridgeID, leaseToken string, leaseExpiresAt time.Time, checkpointJSON *string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	now := time.Now()
	values := map[string]any{"lease_expires_at": leaseExpiresAt, "updated_at": now}
	if checkpointJSON != nil {
		values["checkpoint_json"] = *checkpointJSON
	}
	update := db.Model(&model.ComfyBridgeRequest{}).Where(
		"id = ? AND bridge_id = ? AND status = ? AND lease_token = ? AND expires_at > ?",
		id,
		bridgeID,
		"claimed",
		leaseToken,
		now,
	).Updates(values)
	return update.RowsAffected == 1, update.Error
}

func CompleteComfyBridgeRequest(id, bridgeID, leaseToken, status, result, failure string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	completed := false
	err = db.Transaction(func(tx *gorm.DB) error {
		var request model.ComfyBridgeRequest
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND bridge_id = ?", id, bridgeID).First(&request).Error; err != nil {
			return err
		}
		if request.LeaseToken == "" || request.LeaseToken != leaseToken {
			return ErrComfyBridgeLeaseLost
		}
		switch request.Status {
		case "claimed":
			now := time.Now()
			if !request.ExpiresAt.After(now) {
				return fmt.Errorf("%w：请求已超时", ErrComfyBridgeLeaseLost)
			}
			updates := map[string]any{
				"status":       status,
				"result_json":  result,
				"error":        failure,
				"completed_at": now,
				"updated_at":   now,
			}
			if request.Kind == "inspect_workflow" {
				updates["cleanup_ready_at"] = now
			}
			update := tx.Model(&model.ComfyBridgeRequest{}).Where(
				"id = ? AND bridge_id = ? AND status = ? AND lease_token = ? AND expires_at > ?",
				id,
				bridgeID,
				"claimed",
				leaseToken,
				now,
			).Updates(updates)
			if update.Error != nil {
				return update.Error
			}
			if update.RowsAffected != 1 {
				return ErrComfyBridgeLeaseLost
			}
		case status:
			if request.ResultJSON != result || request.Error != failure {
				return fmt.Errorf("%w：重复回传的结果不一致", ErrComfyBridgeLeaseLost)
			}
		default:
			return fmt.Errorf("%w：请求状态不允许回传", ErrComfyBridgeLeaseLost)
		}
		completed = true
		return nil
	})
	return completed, err
}

func ConfirmComfyBridgeRequestCleanup(
	id, bridgeID, leaseToken string,
) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	confirmed := false
	err = db.Transaction(func(tx *gorm.DB) error {
		var request model.ComfyBridgeRequest
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ? AND bridge_id = ?", id, bridgeID).
			First(&request).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			confirmed = true
			return nil
		}
		if err != nil {
			return err
		}
		if request.LeaseToken == "" || request.LeaseToken != leaseToken {
			return ErrComfyBridgeLeaseLost
		}
		if request.Status != "succeeded" && request.Status != "failed" {
			return fmt.Errorf("%w：请求尚未完成", ErrComfyBridgeLeaseLost)
		}
		if request.CleanupReadyAt == nil {
			now := time.Now()
			update := tx.Model(&model.ComfyBridgeRequest{}).
				Where(
					"id = ? AND bridge_id = ? AND lease_token = ? AND status IN ?",
					id,
					bridgeID,
					leaseToken,
					[]string{"succeeded", "failed"},
				).
				Updates(map[string]any{
					"cleanup_ready_at": now,
					"updated_at":       now,
				})
			if update.Error != nil {
				return update.Error
			}
			if update.RowsAffected != 1 {
				return ErrComfyBridgeLeaseLost
			}
		}
		confirmed = true
		return nil
	})
	return confirmed, err
}

func MarkComfyBridgeRequestCleanupReadyByTaskID(
	taskID string,
) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	now := time.Now()
	update := db.Model(&model.ComfyBridgeRequest{}).
		Where(
			"task_id = ? AND status IN ? AND cleanup_ready_at IS NULL",
			taskID,
			[]string{"succeeded", "failed"},
		).
		Updates(map[string]any{
			"cleanup_ready_at": now,
			"updated_at":       now,
		})
	return update.RowsAffected > 0, update.Error
}

func CleanupComfyBridgeRequests(before, inspectBefore time.Time) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Where(
		"status IN ? AND cleanup_ready_at IS NOT NULL AND ((kind = ? AND cleanup_ready_at <= ?) OR (kind <> ? AND cleanup_ready_at <= ?))",
		[]string{"succeeded", "failed"},
		"inspect_workflow",
		inspectBefore,
		"inspect_workflow",
		before,
	).Delete(&model.ComfyBridgeRequest{}).Error
}

func ExpireComfyBridgeRequests(bridgeID string) ([]string, bool, error) {
	db, err := DB()
	if err != nil {
		return nil, false, err
	}
	var taskIDs []string
	hasActive := false
	err = db.Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		var requests []model.ComfyBridgeRequest
		expired := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where(
			"status IN ? AND expires_at <= ?",
			[]string{"pending", "claimed"},
			now,
		)
		if bridgeID != "" {
			expired = expired.Where("bridge_id = ?", bridgeID)
		}
		if err := expired.Find(&requests).Error; err != nil {
			return err
		}
		if len(requests) > 0 {
			requestIDs := make([]string, 0, len(requests))
			inspectIDs := make([]string, 0)
			for _, request := range requests {
				requestIDs = append(requestIDs, request.ID)
				taskIDs = append(taskIDs, request.TaskID)
				if request.TaskID == "" {
					inspectIDs = append(inspectIDs, request.ID)
				}
			}
			if err := tx.Model(&model.ComfyBridgeRequest{}).Where("id IN ? AND status IN ?", requestIDs, []string{"pending", "claimed"}).Updates(map[string]any{"status": "failed", "error": "Bridge 请求超时", "completed_at": now, "updated_at": now}).Error; err != nil {
				return err
			}
			if len(inspectIDs) > 0 {
				if err := tx.Model(&model.ComfyBridgeRequest{}).
					Where("id IN ?", inspectIDs).
					Updates(map[string]any{
						"cleanup_ready_at": now,
						"updated_at":       now,
					}).Error; err != nil {
					return err
				}
			}
		}
		active := tx.Model(&model.ComfyBridgeRequest{}).Where(
			"status IN ?",
			[]string{"pending", "claimed"},
		)
		if bridgeID != "" {
			active = active.Where("bridge_id = ?", bridgeID)
		}
		var count int64
		if err := active.Count(&count).Error; err != nil {
			return err
		}
		hasActive = count > 0
		return nil
	})
	return taskIDs, hasActive, err
}
