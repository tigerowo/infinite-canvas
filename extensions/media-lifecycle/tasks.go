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

const taskLeaseMillis = int64(2 * time.Minute / time.Millisecond)

func BackfillTaskAttempts(db *gorm.DB) error {
	var entities []Entity
	if err := db.Table("ext_media_lifecycle_entities e").Select("e.*").Where("e.kind IN ? AND e.state = ? AND NOT EXISTS (SELECT 1 FROM ext_media_lifecycle_task_attempts a WHERE a.id = e.entity_key)", []string{"image-task", "audio-task", "video-task"}, Active).Find(&entities).Error; err != nil {
		return err
	}
	for _, entity := range entities {
		err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
			attempt := TaskAttempt{ID: entity.Key, Owner: entity.Owner, Kind: entity.Kind, TaskID: entity.ID, Epoch: entity.Epoch, Started: entity.Created, State: "queued"}
			row, err := decodeTask(attempt)
			if err != nil {
				return err
			}
			if err := tx.Where("id = ? AND user_id = ?", entity.ID, entity.Owner).First(row).Error; err != nil {
				if notFound(err) {
					return nil
				}
				return err
			}
			if task, ok := row.(*model.VideoTask); ok && (task.UpstreamTaskID != "" || task.UpstreamVideoID != "") {
				attempt.State = "polling"
			}
			if terminal(taskStatus(row)) {
				attempt.State = "done"
			}
			var created string
			switch task := row.(type) {
			case *model.CanvasImageTask:
				created = task.CreatedAt
			case *model.CanvasAudioTask:
				created = task.CreatedAt
			case *model.VideoTask:
				created = task.CreatedAt
			}
			if start, err := time.Parse(time.RFC3339Nano, created); err == nil {
				attempt.Started = start.UnixMilli()
			}
			var existing TaskAttempt
			if err := tx.First(&existing, "id = ?", attempt.ID).Error; err == nil {
				return nil
			} else if !notFound(err) {
				return err
			}
			return tx.Create(&attempt).Error
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// Task metadata always carries the creation epoch, including after a restart.
func taskAttempt(tx *gorm.DB, p Policy, owner, kind, id string) (TaskAttempt, error) {
	var entity Entity
	if err := tx.First(&entity, "entity_key = ?", Key(owner, kind, id)).Error; err != nil {
		return TaskAttempt{}, err
	}
	if entity.State != Active {
		return TaskAttempt{}, ErrConflict
	}
	if err := guard(p, entity.Epoch); err != nil {
		return TaskAttempt{}, err
	}
	var attempt TaskAttempt
	err := tx.First(&attempt, "id = ?", entity.Key).Error
	if notFound(err) {
		attempt = TaskAttempt{ID: entity.Key, Owner: owner, Kind: kind, TaskID: id, Epoch: entity.Epoch, Started: entity.Created, State: "queued"}
		err = tx.Create(&attempt).Error
	}
	return attempt, err
}

func LoadTaskAttempt(db *gorm.DB, owner, kind, id string) (TaskAttempt, error) {
	var result TaskAttempt
	err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
		var err error
		result, err = taskAttempt(tx, *p, owner, kind, id)
		return err
	})
	return result, err
}

func BeginTaskPoll(db *gorm.DB, owner, id string) (TaskAttempt, error) {
	var attempt TaskAttempt
	err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
		var err error
		attempt, err = taskAttempt(tx, *p, owner, "video-task", id)
		if err != nil {
			return err
		}
		if (attempt.State != "polling" && attempt.State != "queued") || attempt.LeaseUntil > timestamp() || attempt.Started+Day <= timestamp() {
			return ErrConflict
		}
		attempt.State = "polling"
		attempt.Worker = ID()
		attempt.LeaseUntil = timestamp() + taskLeaseMillis
		return tx.Save(&attempt).Error
	})
	return attempt, err
}
func EndTaskPoll(db *gorm.DB, attempt TaskAttempt) error {
	return db.Model(&TaskAttempt{}).Where("id = ? AND worker = ?", attempt.ID, attempt.Worker).Updates(map[string]any{"worker": "", "lease_until": 0}).Error
}

// BeginTaskSubmission is a durable fence before calling any paid provider.
func BeginTaskSubmission(db *gorm.DB, owner, kind, id string) (TaskAttempt, error) {
	var attempt TaskAttempt
	err := WithLock(db, func(tx *gorm.DB, p *Policy) error {
		var err error
		attempt, err = taskAttempt(tx, *p, owner, kind, id)
		if err != nil {
			return err
		}
		if attempt.State != "queued" || timestamp() >= attempt.Started+Day {
			return ErrConflict
		}
		attempt.State = "submitting"
		attempt.Worker = ID()
		attempt.LeaseUntil = timestamp() + taskLeaseMillis
		return tx.Save(&attempt).Error
	})
	return attempt, err
}

// KeepTaskSubmission runs only while a live provider call is in flight. It does
// not renew retention, and cannot extend the total execution deadline.
func KeepTaskSubmission(ctx context.Context, db *gorm.DB, attempt TaskAttempt) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			until := min(timestamp()+taskLeaseMillis, attempt.Started+Day)
			if err := db.Model(&TaskAttempt{}).Where("id = ? AND worker = ? AND state = ?", attempt.ID, attempt.Worker, "submitting").Update("lease_until", until).Error; err != nil {
				return
			}
		}
	}
}

// StageTaskResult stores the result before applying it to the public task row.
// A storage retry consumes this saved result and never calls a generation API.
func StageTaskResult(db *gorm.DB, row any, lease ...TaskAttempt) error {
	input, ok := RecordUse(row)
	if !ok || !strings.HasSuffix(input.Kind, "-task") {
		return Error("任务类型无效")
	}
	raw, err := json.Marshal(row)
	if err != nil {
		return err
	}
	err = WithLock(db, func(tx *gorm.DB, p *Policy) error {
		attempt, err := taskAttempt(tx, *p, input.Owner, input.Kind, input.ID)
		if err != nil {
			return err
		}
		if len(lease) > 0 && (lease[0].ID != attempt.ID || lease[0].Epoch != attempt.Epoch || lease[0].Worker == "" || lease[0].Worker != attempt.Worker || attempt.LeaseUntil <= timestamp()) {
			return ErrConflict
		}
		if attempt.State == "done" || attempt.State == "unknown" || attempt.State == "archive_failed" {
			return ErrConflict
		}
		if attempt.ResultJSON != "" {
			if attempt.ResultJSON == string(raw) {
				return nil
			}
			return ErrConflict
		}
		attempt.ResultJSON = string(raw)
		attempt.State = "result"
		attempt.Worker = ""
		attempt.LeaseUntil = 0
		attempt.NextAttempt = timestamp()
		return tx.Save(&attempt).Error
	})
	if err != nil {
		return err
	}
	if taskStatus(row) == "completed" {
		pendingArchive(row, "内容已生成，正在保存到 OSS")
		return SaveRecord(db, row)
	}
	// Publish cheap progress/failure updates immediately. The first transaction
	// remains available to recovery if this business write fails.
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		attempt, err := taskAttempt(tx, *p, input.Owner, input.Kind, input.ID)
		if err != nil {
			return err
		}
		if attempt.State != "result" || attempt.Worker != "" {
			return ErrConflict
		}
		if err := SaveRecord(tx, row, attempt.Epoch); err != nil {
			return err
		}
		attempt.State = "polling"
		if terminal(taskStatus(row)) {
			attempt.State = "done"
		}
		if err := settleTaskResult(tx, attempt, row, false, attempt.State); err != nil {
			return err
		}
		attempt.ResultJSON = ""
		return tx.Save(&attempt).Error
	})
}

func settleTaskResult(tx *gorm.DB, attempt TaskAttempt, row any, generated bool, state string) error {
	if generated {
		return SettlementState(tx, attempt.Owner, attempt.TaskID, "settled")
	}
	if state == "unknown" {
		return SettlementState(tx, attempt.Owner, attempt.TaskID, "unknown")
	}
	if task, ok := row.(*model.VideoTask); ok && task.Status == "failed" {
		var settlement Settlement
		err := tx.First(&settlement, "id = ?", Key(task.UserID, task.ID)).Error
		if notFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if settlement.State == "pending" {
			return Refund(tx, task.UserID, task.ID, task.Model, "/videos", settlement.Amount)
		}
	}
	return nil
}

type ArchivedTaskMedia struct {
	URL, StorageKey, MimeType string
	Bytes                     int64
}
type TaskArchiveFunc func(context.Context, string, string, string) (ArchivedTaskMedia, error)

// Explicit recovery schedules one extra archive attempt within the 24-hour
// deadline, without resetting automatic counters or submitting generation.
func RetryTaskArchive(db *gorm.DB, owner, kind, id, operation string, epoch int64) error {
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		if err := guard(*p, epoch); err != nil {
			return err
		}
		attempt, err := taskAttempt(tx, *p, owner, kind, id)
		if err != nil {
			return err
		}
		var previous Operation
		opID := Key(owner, "archive-retry", operation)
		if err := tx.First(&previous, "id = ?", opID).Error; err == nil {
			if previous.EntityKey != attempt.ID {
				return ErrConflict
			}
			return nil
		} else if !notFound(err) {
			return err
		}
		if attempt.State != "archive_failed" && attempt.State != "result" {
			return Error("该任务没有可恢复的归档结果")
		}
		if attempt.Started+Day <= timestamp() {
			return Error("任务保护期已结束，请重新上传可用的本机原件；未重新生成")
		}
		if attempt.LeaseUntil > timestamp() {
			return Error("素材正在保存，请稍后查看结果")
		}
		if attempt.ManualRetry {
			return Error("已安排重新保存，请稍后查看结果")
		}
		row, err := decodeTask(attempt)
		if err != nil {
			return err
		}
		if taskStatus(row) != "completed" {
			return Error("该任务没有已生成的素材")
		}
		pendingArchive(row, "内容已生成，正在重新保存到 OSS")
		recoveryAt := time.Now().UTC().Format(time.RFC3339Nano)
		taskUpdatedAt(row, recoveryAt)
		input, _ := RecordUse(row)
		var entity Entity
		if err := tx.First(&entity, "entity_key = ? AND state = ?", attempt.ID, Active).Error; err != nil {
			return err
		}
		// Retrying storage is not a new content activity. Advance only the public
		// recovery fence, retaining the original activity and execution deadline.
		entity.Version++
		entity.Fingerprint = Key(input.Payload)
		if err := tx.Save(&entity).Error; err != nil {
			return err
		}
		if err := tx.Save(row).Error; err != nil {
			return err
		}
		attempt.State = "result"
		attempt.ManualRetry = true
		attempt.RecoveryVersion = entity.Version
		attempt.RecoveryAt = recoveryAt
		attempt.NextAttempt = timestamp()
		if err := tx.Save(&attempt).Error; err != nil {
			return err
		}
		receipt, _ := json.Marshal(map[string]int64{"version": attempt.RecoveryVersion})
		return tx.Create(&Operation{ID: opID, Owner: owner, EntityKey: attempt.ID, Result: string(receipt), Created: timestamp(), Epoch: p.Epoch}).Error
	})
}

func TaskArchiveRetryReceipt(db *gorm.DB, owner, operation string) (map[string]int64, error) {
	var op Operation
	if err := db.First(&op, "id = ? AND owner = ?", Key(owner, "archive-retry", operation), owner).Error; err != nil {
		return nil, err
	}
	var receipt map[string]int64
	if json.Unmarshal([]byte(op.Result), &receipt) != nil || receipt["version"] <= 0 {
		return nil, ErrConflict
	}
	return receipt, nil
}

// An older public snapshot must never borrow a newer recovery revision.
func TaskRecoveryVersion(db *gorm.DB, owner, kind, id, updatedAt string) (int64, error) {
	var attempt TaskAttempt
	if err := db.Select("recovery_version", "recovery_at").First(&attempt, "id = ?", Key(owner, kind, id)).Error; err != nil {
		if notFound(err) {
			return 0, nil
		}
		return 0, err
	}
	updated, err := time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return 0, nil
	}
	started, err := time.Parse(time.RFC3339Nano, attempt.RecoveryAt)
	if err != nil || updated.Before(started) {
		return 0, nil
	}
	return attempt.RecoveryVersion, nil
}

func taskUpdatedAt(row any, value string) {
	switch task := row.(type) {
	case *model.CanvasImageTask:
		task.UpdatedAt = value
	case *model.CanvasAudioTask:
		task.UpdatedAt = value
	case *model.VideoTask:
		task.UpdatedAt = value
	}
}

func decodeTask(attempt TaskAttempt) (any, error) {
	var row any
	switch attempt.Kind {
	case "image-task":
		row = &model.CanvasImageTask{}
	case "audio-task":
		row = &model.CanvasAudioTask{}
	case "video-task":
		row = &model.VideoTask{}
	default:
		return nil, Error("任务类型无效")
	}
	if attempt.ResultJSON != "" {
		if err := json.Unmarshal([]byte(attempt.ResultJSON), row); err != nil {
			return nil, err
		}
	}
	return row, nil
}

func taskStatus(row any) string {
	switch task := row.(type) {
	case *model.CanvasImageTask:
		return task.Status
	case *model.CanvasAudioTask:
		return task.Status
	case *model.VideoTask:
		return task.Status
	}
	return ""
}
func failTask(row any, message string) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	switch task := row.(type) {
	case *model.CanvasImageTask:
		task.Status = "failed"
		task.Error = message
		task.ErrorDetail = message
		task.CompletedAt = now
		task.UpdatedAt = now
	case *model.CanvasAudioTask:
		task.Status = "failed"
		task.Error = message
		task.ErrorDetail = message
		task.CompletedAt = now
		task.UpdatedAt = now
	case *model.VideoTask:
		task.Status = "failed"
		task.Error = message
		task.ErrorDetail = message
		task.CompletedAt = now
		task.UpdatedAt = now
	}
}
func pendingArchive(row any, message string) {
	switch task := row.(type) {
	case *model.CanvasImageTask:
		task.Status = "processing"
		task.Progress = 99
		task.CompletedAt = ""
		task.Error = ""
		task.ErrorDetail = message
	case *model.CanvasAudioTask:
		task.Status = "processing"
		task.Progress = 99
		task.CompletedAt = ""
		task.Error = ""
		task.ErrorDetail = message
	case *model.VideoTask:
		task.Status = "processing"
		task.Progress = 99
		task.CompletedAt = ""
		task.Error = ""
		task.ErrorDetail = message
	}
}

func archiveTask(ctx context.Context, attempt TaskAttempt, row any, archive TaskArchiveFunc) error {
	if taskStatus(row) != "completed" {
		return nil
	}
	if archive == nil {
		return Error("未配置素材归档")
	}
	save := func(source, filename string) (ArchivedTaskMedia, error) {
		if strings.HasPrefix(source, "/api/files/") {
			return ArchivedTaskMedia{URL: source, StorageKey: "server:" + strings.TrimSuffix(strings.TrimPrefix(source, "/api/files/"), "/content")}, nil
		}
		if source == "" {
			return ArchivedTaskMedia{}, Error("上游未返回可归档的素材")
		}
		return archive(ctx, attempt.Owner, source, filename)
	}
	switch task := row.(type) {
	case *model.CanvasImageTask:
		urls := task.ImageURLs
		if len(urls) == 0 {
			urls = []string{task.ImageURL}
		}
		for i, source := range urls {
			result, err := save(source, fmt.Sprintf("generated-%s-%d.png", task.ID, i))
			if err != nil {
				return err
			}
			urls[i] = result.URL
			if i == 0 {
				task.ImageURL = result.URL
				task.StorageKey = result.StorageKey
				if result.MimeType != "" {
					task.MimeType = result.MimeType
				}
				if result.Bytes > 0 {
					task.Bytes = result.Bytes
				}
			}
		}
		if len(task.ImageURLs) > 0 {
			task.ImageURLs = urls
		}
		task.ResponseBody = "[archived image]"
	case *model.CanvasAudioTask:
		result, err := save(task.AudioURL, "generated-"+task.ID+".audio")
		if err != nil {
			return err
		}
		task.AudioURL = result.URL
		task.StorageKey = result.StorageKey
		if result.MimeType != "" {
			task.MimeType = result.MimeType
		}
		if result.Bytes > 0 {
			task.Bytes = result.Bytes
		}
		task.ResponseBody = "[archived audio]"
	case *model.VideoTask:
		result, err := save(task.VideoURL, "generated-"+task.ID+".mp4")
		if err != nil {
			return err
		}
		task.VideoURL = result.URL
	}
	return nil
}

// RecoverTaskResults can run in more than one process. Each network attempt is
// leased, bounded by the task deadline and fenced again before committing.
func RecoverTaskResults(ctx context.Context, db *gorm.DB, archive TaskArchiveFunc) error {
	var candidates []TaskAttempt
	err := db.Where("(state = ? OR (state IN ? AND started <= ?) OR (state = ? AND started <= ?)) AND next_attempt <= ? AND lease_until <= ?", "result", []string{"queued", "submitting"}, timestamp()-taskLeaseMillis, "polling", timestamp()-Day, timestamp(), timestamp()).Order("started ASC").Limit(100).Find(&candidates).Error
	if err != nil {
		return err
	}
	var failures []error
	for _, candidate := range candidates {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		err := recoverTaskCandidate(ctx, db, candidate, archive)
		if err != nil {
			failures = append(failures, fmt.Errorf("task %s: %w", candidate.TaskID, err))
		}
	}
	return errors.Join(failures...)
}

func recoverTaskCandidate(ctx context.Context, db *gorm.DB, candidate TaskAttempt, archive TaskArchiveFunc) error {
	if (candidate.State == "queued" || candidate.State == "submitting") && candidate.Started+taskLeaseMillis > timestamp() {
		return nil
	}
	attempt := candidate
	row, err := decodeTask(candidate)
	if err != nil {
		return errors.Join(err, quarantineTaskResult(db, candidate))
	}
	generated := taskStatus(row) == "completed"
	canArchive := false
	err = WithLock(db, func(tx *gorm.DB, p *Policy) error {
		var err error
		attempt, err = taskAttempt(tx, *p, candidate.Owner, candidate.Kind, candidate.TaskID)
		if err != nil {
			return err
		}
		if attempt.State != candidate.State || attempt.ResultJSON != candidate.ResultJSON || attempt.RecoveryVersion != candidate.RecoveryVersion || attempt.LeaseUntil > timestamp() || attempt.NextAttempt > timestamp() {
			return ErrConflict
		}
		attempt.Worker = ID()
		attempt.LeaseUntil = timestamp() + taskLeaseMillis
		if generated {
			if attempt.ArchiveStarted == 0 {
				attempt.ArchiveStarted = timestamp()
			}
			deadline := min(attempt.Started+Day, attempt.ArchiveStarted+Day/4)
			canArchive = (attempt.ArchiveAttempts < 12 && timestamp() < deadline) || (attempt.ManualRetry && timestamp() < attempt.Started+Day)
			if canArchive {
				attempt.ArchiveAttempts++
			}
		}
		return tx.Save(&attempt).Error
	})
	if errors.Is(err, ErrConflict) || errors.Is(err, ErrClearing) {
		return nil
	}
	if err != nil {
		return err
	}
	state := "done"
	if attempt.Kind == "video-task" && !terminal(taskStatus(row)) && attempt.ResultJSON != "" {
		state = "polling"
	}
	archiveErr := error(nil)
	if attempt.ResultJSON == "" {
		if err := db.Where("id = ? AND user_id = ?", attempt.TaskID, attempt.Owner).First(row).Error; err != nil {
			return err
		}
		failTask(row, "任务提交已中断，上游结果需核对；系统未自动重新生成")
		state = "unknown"
	} else if generated {
		deadline := min(attempt.Started+Day, attempt.ArchiveStarted+int64(6*time.Hour/time.Millisecond))
		if attempt.ManualRetry {
			deadline = attempt.Started + Day
		}
		if !canArchive {
			archiveErr = Error("归档重试窗口已结束，请保留本机原件并核对上游素材")
		} else {
			archiveCtx, cancel := context.WithDeadline(WithEpoch(ctx, attempt.Epoch), time.UnixMilli(min(deadline, timestamp()+taskLeaseMillis-1000)))
			archiveErr = archiveTask(archiveCtx, attempt, row, archive)
			cancel()
		}
		if archiveErr != nil {
			message := "内容已生成，保存到 OSS 失败：" + archiveErr.Error()
			attempt.LastError = message
			if attempt.ArchiveAttempts >= 12 || timestamp() >= min(attempt.Started+Day, attempt.ArchiveStarted+Day/4) {
				state = "archive_failed"
				failTask(row, message+"；未重新生成")
			} else {
				state = "result"
				pendingArchive(row, message+"；后台将仅重试归档")
			}
			attempt.NextAttempt = timestamp() + min(int64(1<<min(attempt.ArchiveAttempts, 10))*5000, int64(15*time.Minute/time.Millisecond))
		}
	}
	err = WithLock(db, func(tx *gorm.DB, p *Policy) error {
		current, err := taskAttempt(tx, *p, attempt.Owner, attempt.Kind, attempt.TaskID)
		if err != nil {
			return err
		}
		if current.Worker != attempt.Worker || current.LeaseUntil < timestamp() {
			return ErrConflict
		}
		// Re-read the actual row: a terminal result cannot be overwritten by a
		// response from an earlier attempt or another worker.
		var actual map[string]any
		if err := tx.Model(row).Where("id = ? AND user_id = ?", attempt.TaskID, attempt.Owner).Take(&actual).Error; err != nil {
			return err
		}
		if terminal(fmt.Sprint(actual["status"])) {
			attempt.State = "done"
			attempt.ResultJSON = ""
		} else {
			taskUpdatedAt(row, time.Now().UTC().Format(time.RFC3339Nano))
			input, _ := RecordUse(row)
			input.Epoch = attempt.Epoch
			var result UseResult
			if err := saveUse(tx, *p, input, func(tx *gorm.DB) error { return tx.Save(row).Error }, &result); err != nil {
				return err
			}
			attempt.State = state
			if state == "done" || state == "unknown" || state == "polling" {
				attempt.ResultJSON = ""
			}
		}
		if err := settleTaskResult(tx, attempt, row, generated, state); err != nil {
			return err
		}
		attempt.Worker = ""
		attempt.LeaseUntil = 0
		attempt.ManualRetry = false
		return tx.Save(&attempt).Error
	})
	if errors.Is(err, ErrConflict) || errors.Is(err, ErrClearing) {
		return nil
	}
	if err != nil {
		return err
	}
	return nil
}

func quarantineTaskResult(db *gorm.DB, candidate TaskAttempt) error {
	return WithLock(db, func(tx *gorm.DB, p *Policy) error {
		attempt, err := taskAttempt(tx, *p, candidate.Owner, candidate.Kind, candidate.TaskID)
		if err != nil {
			return err
		}
		if attempt.ResultJSON != candidate.ResultJSON || attempt.State != candidate.State || attempt.LeaseUntil > timestamp() {
			return ErrConflict
		}
		row, err := decodeTask(TaskAttempt{Kind: attempt.Kind})
		if err != nil {
			return err
		}
		if err := tx.Where("id = ? AND user_id = ?", attempt.TaskID, attempt.Owner).First(row).Error; err != nil {
			return err
		}
		if !terminal(taskStatus(row)) {
			failTask(row, "任务恢复记录异常，请核对原始结果；系统未重新生成")
			if err := SaveRecord(tx, row, attempt.Epoch); err != nil {
				return err
			}
		}
		attempt.State = "unknown"
		attempt.LastError = "任务结果记录无法解析，保留原文等待核对"
		attempt.Worker = ""
		attempt.LeaseUntil = 0
		if err := SettlementState(tx, attempt.Owner, attempt.TaskID, "unknown"); err != nil {
			return err
		}
		return tx.Save(&attempt).Error
	})
}
