package medialifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

const (
	cleanupLeaseDuration      = 5 * time.Minute
	cleanupLeaseRenewInterval = time.Minute
)

type Preview struct {
	Batch     Batch    `json:"batch"`
	Files     int      `json:"files"`
	Records   int      `json:"records"`
	Bytes     int64    `json:"bytes"`
	Preserved []string `json:"preserved"`
}

func UpdatePolicy(db *gorm.DB, input Policy, previewID ...string) (Policy, error) {
	var saved Policy
	err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if p.Clearing {
			return ErrClearing
		}
		if p.Version != input.Version {
			return ErrConflict
		}
		if err := validatePolicyInput(input); err != nil {
			return err
		}
		if input.Execution == "enforce" && (!input.StorageReviewed || p.MigratedAt == 0) {
			return Error("请先完成旧数据登记并核对存储范围和桶生命周期")
		}
		if err := verifyPolicyPreview(tx, *p, input, previewID); err != nil {
			return err
		}
		p.Mode = input.Mode
		p.Days = input.Days
		p.Execution = input.Execution
		p.StorageReviewed = input.StorageReviewed
		p.Version++
		saved = *p
		return tx.Save(p).Error
	})
	return saved, err
}

func PreviewCleanup(db *gorm.DB, kind string) (Preview, error) {
	result := Preview{Preserved: []string{"账号、权限及余额", "必要账务状态", "系统和账号配置", "系统预设 Skill 和公共提示词"}}
	if kind != "expiry" && kind != "clear" {
		return result, Error("清理类型无效")
	}
	err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if p.Clearing {
			return ErrClearing
		}
		if p.MigratedAt == 0 {
			return Error("旧数据登记尚未完成，不能预览清理")
		}
		now := timestamp()
		batch := Batch{ID: ID(), Kind: kind, State: "preview", PolicyVersion: p.Version, Epoch: p.Epoch, Created: now, Updated: now}
		if err := tx.Create(&batch).Error; err != nil {
			return err
		}
		var entities []Entity
		if err := tx.Where("state = ?", Active).Find(&entities).Error; err != nil {
			return err
		}
		for _, e := range entities {
			if kind != "clear" && !expired(e.Activity, e.Protection, now, *p) {
				continue
			}
			if err := tx.Create(&BatchItem{BatchID: batch.ID, Kind: "entity", Target: e.Key, Version: e.Version, State: "pending"}).Error; err != nil {
				return err
			}
			result.Records++
		}
		var files []File
		if err := tx.Where("state IN ?", []string{Active, Uploading, Deleting}).Find(&files).Error; err != nil {
			return err
		}
		for _, f := range files {
			if kind != "clear" && f.State != Deleting {
				if !expired(f.Activity, f.Protection, now, *p) {
					continue
				}
				protected, err := hasLiveDependency(tx, *p, f.ID, now)
				if err != nil {
					return err
				}
				if protected {
					continue
				}
			}
			if err := tx.Create(&BatchItem{BatchID: batch.ID, Kind: "file", Target: f.ID, Version: f.Version, State: "pending", Bytes: f.Bytes}).Error; err != nil {
				return err
			}
			result.Files++
			result.Bytes += f.Bytes
		}
		result.Batch = batch
		return nil
	})
	return result, err
}
func hasLiveDependency(tx *gorm.DB, p Policy, fileID string, now int64) (bool, error) {
	var records []Entity
	err := tx.Table("ext_media_lifecycle_entities AS e").Select("e.*").Joins("JOIN ext_media_lifecycle_references AS r ON r.entity_key = e.entity_key").Where("r.file_id = ? AND e.state = ?", fileID, Active).Find(&records).Error
	if err != nil {
		return false, err
	}
	for _, e := range records {
		if !expired(e.Activity, e.Protection, now, p) {
			return true, nil
		}
	}
	return false, nil
}

func StartBatch(db *gorm.DB, id, confirmation string) error {
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if p.Clearing {
			return ErrClearing
		}
		var b Batch
		if err := tx.First(&b, "id = ?", id).Error; err != nil {
			return err
		}
		if b.State != "preview" || b.PolicyVersion != p.Version || b.Epoch != p.Epoch || timestamp()-b.Created > int64(15*time.Minute/time.Millisecond) {
			return ErrConflict
		}
		if b.Kind == "expiry" && (p.Execution != "enforce" || p.Mode == "forever") {
			return Error("观察模式不执行自动删除")
		}
		if b.Kind == "clear" && confirmation != "清空业务数据" {
			return Error("请输入“清空业务数据”确认本批次")
		}
		if !p.StorageReviewed {
			return Error("请先核对应用存储范围与桶生命周期")
		}
		if b.Kind == "clear" {
			var inFlight int64
			if err := tx.Model(&Batch{}).Where("lease_until > ?", timestamp()).Count(&inFlight).Error; err != nil {
				return err
			}
			if inFlight > 0 {
				return Error("仍有清理执行器运行，请等待完成后重新预览")
			}
			if err := tx.Model(&Dedup{}).Where("lease_until > ? AND file_id IN (SELECT id FROM ext_media_lifecycle_files WHERE state = ?)", timestamp(), Uploading).Count(&inFlight).Error; err != nil {
				return err
			}
			if inFlight > 0 {
				return Error("仍有素材上传正在执行，请等待完成后重新预览")
			}
			if err := tx.Model(&RequestLease{}).Where("until > ?", timestamp()).Count(&inFlight).Error; err != nil {
				return err
			}
			if inFlight > 0 {
				return Error("仍有提交或保存请求正在执行，请等待这些请求结束后重新预览清空")
			}
			// Compare identities and versions, including writes within the same
			// millisecond as the preview. Wall-clock comparison alone loses them.
			var newer int64
			if err := tx.Model(&Entity{}).Where("state = ? AND NOT EXISTS (SELECT 1 FROM ext_media_lifecycle_batch_items i WHERE i.batch_id = ? AND i.kind = ? AND i.target = ext_media_lifecycle_entities.entity_key AND i.version = ext_media_lifecycle_entities.version)", Active, b.ID, "entity").Count(&newer).Error; err != nil {
				return err
			}
			if newer > 0 {
				return Error("预览后业务数据已变化，请重新预览")
			}
			if err := tx.Model(&File{}).Where("state <> ? AND NOT EXISTS (SELECT 1 FROM ext_media_lifecycle_batch_items i WHERE i.batch_id = ? AND i.kind = ? AND i.target = ext_media_lifecycle_files.id AND i.version = ext_media_lifecycle_files.version)", Deleted, b.ID, "file").Count(&newer).Error; err != nil {
				return err
			}
			if newer > 0 {
				return Error("预览后素材已变化，请重新预览")
			}
			p.Clearing = true
			p.Epoch++
			p.Version++
			if err := tx.Save(p).Error; err != nil {
				return err
			}
		}
		b.State = "running"
		b.Updated = timestamp()
		return tx.Save(&b).Error
	})
}

// RunBatch uses durable per-object state. deleteFile must report success only
// after the exact object is absent; errors leave the file locked for retry.
func RunBatch(ctx context.Context, db *gorm.DB, id string, deleteFile func(context.Context, File) error) error {
	return RunBatchWithFinalizer(ctx, db, id, deleteFile, nil)
}

func RunBatchWithFinalizer(ctx context.Context, db *gorm.DB, id string, deleteFile func(context.Context, File) error, finalize func(context.Context, Batch) error) error {
	var b Batch
	worker := ID()
	if err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if err := tx.First(&b, "id = ?", id).Error; err != nil {
			return err
		}
		if b.Kind == "expiry" && (p.Clearing || b.Epoch != p.Epoch) {
			return ErrConflict
		}
		if b.State != "running" && b.State != "failed" {
			return Error("批次尚未确认或已完成")
		}
		if b.LeaseUntil > timestamp() {
			return Error("批次正在其他执行器中处理")
		}
		b.Worker = worker
		b.LeaseUntil = timestamp() + int64(cleanupLeaseDuration/time.Millisecond)
		return tx.Save(&b).Error
	}); err != nil {
		return err
	}
	defer db.Model(&Batch{}).Where("id = ? AND worker = ?", id, worker).Updates(map[string]any{"worker": "", "lease_until": 0})
	var items []BatchItem
	if err := db.Where("batch_id = ? AND state IN ?", id, []string{"pending", "locked", "failed"}).Order("kind ASC").Find(&items).Error; err != nil {
		return err
	}
	for _, item := range items {
		if err := ctx.Err(); err != nil {
			return err
		}
		lease := db.Model(&Batch{}).Where("id = ? AND worker = ? AND lease_until > ?", id, worker, timestamp()).Update("lease_until", timestamp()+int64(cleanupLeaseDuration/time.Millisecond))
		if lease.Error != nil {
			return lease.Error
		}
		if lease.RowsAffected != 1 {
			return ErrConflict
		}
		var file File
		shouldDelete := false
		err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
			if err := cleanupWorker(tx, id, worker); err != nil {
				return err
			}
			var current BatchItem
			if err := tx.First(&current, "batch_id = ? AND kind = ? AND target = ?", id, item.Kind, item.Target).Error; err != nil {
				return err
			}
			if current.State == "done" || current.State == "skipped" {
				return nil
			}
			now := timestamp()
			if item.Kind == "entity" {
				var e Entity
				if err := tx.First(&e, "entity_key = ?", item.Target).Error; err != nil {
					if notFound(err) {
						return setItem(tx, item, "done", "")
					}
					return err
				}
				if e.State != Active {
					return setItem(tx, item, "done", "")
				}
				if b.Kind == "expiry" && (p.Execution != "enforce" || p.Version != b.PolicyVersion || e.Version != item.Version || !expired(e.Activity, e.Protection, now, *p)) {
					return setItem(tx, item, "skipped", "")
				}
				if err := deleteBusiness(tx, e); err != nil {
					return err
				}
				e.State = Deleted
				e.Version++
				e.Fingerprint = ""
				e.Activity = now
				if err := tx.Save(&e).Error; err != nil {
					return err
				}
				if err := tx.Where("entity_key = ?", e.Key).Delete(&Reference{}).Error; err != nil {
					return err
				}
				return setItem(tx, item, "done", "")
			}
			if err := tx.First(&file, "id = ?", item.Target).Error; err != nil {
				if notFound(err) {
					return setItem(tx, item, "done", "")
				}
				return err
			}
			if file.State == Deleted {
				return setItem(tx, item, "done", "")
			}
			if file.State == Uploading {
				var active int64
				if err := tx.Model(&Dedup{}).Where("file_id = ? AND lease_until > ?", file.ID, now).Count(&active).Error; err != nil {
					return err
				}
				if active > 0 {
					return Error("文件上传租约仍有效，请等待上传结束")
				}
				// PrepareUpload persists coordinates before any PUT. No coordinates
				// plus an expired slot means that no network write was started.
				if file.ObjectJSON == "" {
					if err := tx.Model(&file).Updates(map[string]any{"state": Deleted, "version": gorm.Expr("version + 1")}).Error; err != nil {
						return err
					}
					if err := tx.Where("file_id = ?", file.ID).Delete(&Dedup{}).Error; err != nil {
						return err
					}
					return setItem(tx, item, "done", "")
				}
			}
			if file.DeleteWorker != "" && file.DeleteUntil > now {
				return Error("该文件正在其他清理执行器中处理")
			}
			if file.State != Deleting && b.Kind == "expiry" {
				if p.Execution != "enforce" || p.Version != b.PolicyVersion || file.Version != item.Version || !expired(file.Activity, file.Protection, now, *p) {
					return setItem(tx, item, "skipped", "")
				}
				protected, err := hasLiveDependency(tx, *p, file.ID, now)
				if err != nil {
					return err
				}
				if protected {
					return setItem(tx, item, "skipped", "")
				}
			}
			if file.State != Deleting {
				file.State = Deleting
				file.Version++
			}
			file.DeleteWorker = worker
			file.DeleteUntil = now + int64(3*time.Minute/time.Millisecond)
			if err := tx.Save(&file).Error; err != nil {
				return err
			}
			shouldDelete = true
			return setItem(tx, item, "locked", "")
		})
		if err == nil && shouldDelete {
			if deleteFile == nil {
				err = Error("未配置存储删除执行器")
			} else {
				deleteCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
				err = deleteFile(deleteCtx, file)
				if err == nil {
					err = deleteCtx.Err()
				}
				cancel()
			}
			if err == nil {
				err = WithLock(db, func(tx *gorm.DB, p *Policy) error {
					if err := cleanupWorker(tx, id, worker); err != nil {
						return err
					}
					result := tx.Model(&File{}).Where("id = ? AND state = ? AND delete_worker = ? AND delete_until > ?", file.ID, Deleting, worker, timestamp()).Updates(map[string]any{"state": Deleted, "object_json": "", "delete_worker": "", "delete_until": 0, "version": gorm.Expr("version + 1")})
					if result.Error != nil {
						return result.Error
					}
					if result.RowsAffected != 1 {
						return ErrConflict
					}
					if err := tx.Where("id = ?", file.ID).Delete(&model.StorageObject{}).Error; err != nil {
						return err
					}
					if err := deleteOptionalIndex(tx, "ext_media_archive_sources", "object_id = ?", file.ID); err != nil {
						return err
					}
					if err := tx.Where("file_id = ?", file.ID).Delete(&Material{}).Error; err != nil {
						return err
					}
					if err := tx.Where("file_id = ?", file.ID).Delete(&Reference{}).Error; err != nil {
						return err
					}
					if err := tx.Where("file_id = ?", file.ID).Delete(&Dedup{}).Error; err != nil {
						return err
					}
					return setItem(tx, item, "done", "")
				})
			}
		}
		if err != nil {
			if saveErr := WithLock(db, func(tx *gorm.DB, p *Policy) error {
				if leaseErr := cleanupWorker(tx, id, worker); leaseErr != nil {
					return leaseErr
				}
				if shouldDelete {
					if leaseErr := tx.Model(&File{}).Where("id = ? AND delete_worker = ?", file.ID, worker).Updates(map[string]any{"delete_worker": "", "delete_until": 0}).Error; leaseErr != nil {
						return leaseErr
					}
				}
				return setItem(tx, item, "failed", err.Error())
			}); saveErr != nil {
				return saveErr
			}
		}
	}
	var finalizeErr error
	if finalize != nil {
		finalizeErr = runCleanupFinalizer(ctx, db, id, worker, b, finalize)
	}
	stateErr := WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if err := cleanupWorker(tx, id, worker); err != nil {
			return err
		}
		var current Batch
		if err := tx.First(&current, "id = ? AND worker = ?", id, worker).Error; err != nil {
			return err
		}
		var remaining int64
		if err := tx.Model(&BatchItem{}).Where("batch_id = ? AND state NOT IN ?", id, []string{"done", "skipped"}).Count(&remaining).Error; err != nil {
			return err
		}
		state := "complete"
		message := ""
		if b.Kind == "clear" {
			var files, entities int64
			if err := tx.Model(&File{}).Where("state <> ? AND epoch <= ?", Deleted, b.Epoch).Count(&files).Error; err != nil {
				return err
			}
			if err := tx.Model(&Entity{}).Where("state = ? AND epoch <= ?", Active, b.Epoch).Count(&entities).Error; err != nil {
				return err
			}
			remaining = max(remaining, files+entities)
		}
		if remaining > 0 {
			state = "failed"
			message = fmt.Sprintf("仍有 %d 项未完成，可重试", remaining)
		}
		if finalizeErr != nil {
			state = "failed"
			message = "业务日志文件清理失败，可重试：" + finalizeErr.Error()
		}
		if err := tx.Model(&Batch{}).Where("id = ?", id).Updates(map[string]any{"state": state, "updated": timestamp(), "error": message}).Error; err != nil {
			return err
		}
		if state == "complete" && b.Kind == "clear" {
			p.Clearing = false
			return tx.Save(p).Error
		}
		return nil
	})
	if stateErr != nil {
		return stateErr
	}
	return finalizeErr
}

func runCleanupFinalizer(ctx context.Context, db *gorm.DB, id, worker string, batch Batch, finalize func(context.Context, Batch) error) error {
	finalizerCtx, cancel := context.WithCancel(ctx)
	heartbeatDone := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(cleanupLeaseRenewInterval)
		defer ticker.Stop()
		for {
			select {
			case <-finalizerCtx.Done():
				heartbeatDone <- nil
				return
			case <-ticker.C:
				now := timestamp()
				result := db.Model(&Batch{}).
					Where("id = ? AND worker = ? AND lease_until > ?", id, worker, now).
					Update("lease_until", now+int64(cleanupLeaseDuration/time.Millisecond))
				if result.Error != nil {
					cancel()
					heartbeatDone <- result.Error
					return
				}
				if result.RowsAffected != 1 {
					cancel()
					heartbeatDone <- ErrConflict
					return
				}
			}
		}
	}()
	finalizeErr := finalize(finalizerCtx, batch)
	cancel()
	return errors.Join(finalizeErr, <-heartbeatDone)
}

func cleanupWorker(tx *gorm.DB, id, worker string) error {
	var count int64
	if err := tx.Model(&Batch{}).Where("id = ? AND worker = ? AND lease_until > ?", id, worker, timestamp()).Count(&count).Error; err != nil {
		return err
	}
	if count != 1 {
		return ErrConflict
	}
	return nil
}
func setItem(tx *gorm.DB, item BatchItem, state, message string) error {
	return tx.Model(&BatchItem{}).Where("batch_id = ? AND kind = ? AND target = ?", item.BatchID, item.Kind, item.Target).Updates(map[string]any{"state": state, "error": message}).Error
}

func deleteBusiness(tx *gorm.DB, e Entity) error {
	if e.Kind == "video-task" {
		if err := deleteOptionalIndex(tx, "ext_video_task_identity", "task_id = ? AND user_id = ?", e.ID, e.Owner); err != nil {
			return err
		}
	}
	if strings.HasSuffix(e.Kind, "-task") {
		if err := tx.Where("id = ?", e.Key).Delete(&TaskAttempt{}).Error; err != nil {
			return err
		}
		if err := tx.Model(&Settlement{}).Where("id = ? AND state = ?", Key(e.Owner, e.ID), "pending").Update("state", "unknown").Error; err != nil {
			return err
		}
	}
	tables := map[string]string{"canvas": "canvas_projects", "image-task": "canvas_image_tasks", "audio-task": "canvas_audio_tasks", "video-task": "video_tasks", "image-history": "image_generation_logs", "video-history": "video_generation_logs", "ai-log": "ai_call_logs", "asset": "assets", "skill": "agent_skills", "workflow": "creative_workflows"}
	if table, ok := tables[e.Kind]; ok {
		query := tx.Table(table).Where("id = ?", e.ID)
		switch e.Kind {
		case "asset", "ai-log":
		case "skill":
			query = query.Where("owner_user_id = ? AND source = ?", e.Owner, "user")
		case "workflow":
			query = query.Where("owner_user_id = ?", e.Owner)
		default:
			query = query.Where("user_id = ?", e.Owner)
		}
		if e.Kind == "skill" {
			if err := tx.Where("skill_id = ?", e.ID).Delete(&model.AgentSkillFile{}).Error; err != nil {
				return err
			}
		}
		return query.Delete(map[string]any{}).Error
	}
	if e.Kind == "user-assets" || e.Kind == "legacy-history" {
		column := "asset_data"
		collection := "assets"
		if e.Kind == "legacy-history" {
			column = "image_history"
			collection = "logs"
		}
		var config model.UserConfig
		if err := tx.First(&config, "user_id = ?", e.Owner).Error; err != nil {
			return err
		}
		raw := config.AssetData
		if column == "image_history" {
			raw = config.ImageHistory
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return err
		}
		var entries []map[string]any
		if err := json.Unmarshal(payload[collection], &entries); err != nil {
			return err
		}
		kept := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			if fmt.Sprint(entry["id"]) != e.ID {
				kept = append(kept, entry)
			}
		}
		data, err := json.Marshal(kept)
		if err != nil {
			return err
		}
		payload[collection] = data
		data, err = json.Marshal(payload)
		if err != nil {
			return err
		}
		return tx.Model(&model.UserConfig{}).Where("user_id = ?", e.Owner).Update(column, string(data)).Error
	}
	if e.Kind == "upload" || e.Kind == "library" {
		return tx.Model(&Material{}).Where("owner = ? AND file_id = ?", e.Owner, e.ID).Update("state", "revoked").Error
	}
	if e.Kind == "draft" || e.Kind == "request" {
		return nil
	}
	return Error("未登记业务清理方式，已停止该项删除")
}
