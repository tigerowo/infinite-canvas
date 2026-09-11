package medialifecycle

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func imageTask(t *testing.T, db *gorm.DB, id string) model.CanvasImageTask {
	t.Helper()
	if err := db.AutoMigrate(&model.CanvasImageTask{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	task := model.CanvasImageTask{ID: id, UserID: "a", Status: "queued", CreatedAt: now, UpdatedAt: now}
	if err := CreateRecord(db, &task, 1); err != nil {
		t.Fatal(err)
	}
	return task
}

func TestArchiveAttemptIsReservedBeforeIOAndRetriesSavedResult(t *testing.T) {
	db := testDB(t)
	task := imageTask(t, db, "image")
	file := upload(t, db, "a", "generated")
	task.Status = "completed"
	task.ImageURL = "https://provider.invalid/result.png"
	if err := StageTaskResult(db, &task); err != nil {
		t.Fatal(err)
	}
	calls := 0
	archive := func(ctx context.Context, owner, source, name string) (ArchivedTaskMedia, error) {
		calls++
		var attempt TaskAttempt
		db.First(&attempt, "id = ?", Key("a", "image-task", "image"))
		if attempt.ArchiveAttempts != calls {
			t.Fatalf("attempt was not reserved before IO: %d", attempt.ArchiveAttempts)
		}
		if Epoch(ctx) != 1 {
			t.Fatal("archive lost creation epoch")
		}
		if source != "https://provider.invalid/result.png" {
			t.Fatal(source)
		}
		if calls == 1 {
			return ArchivedTaskMedia{}, errors.New("temporary storage failure")
		}
		return ArchivedTaskMedia{URL: "/api/files/" + file + "/content", StorageKey: "server:" + file}, nil
	}
	if err := RecoverTaskResults(context.Background(), db, archive); err != nil {
		t.Fatal(err)
	}
	var pending model.CanvasImageTask
	db.First(&pending, "id = ?", task.ID)
	if pending.Status != "processing" || pending.Progress != 99 || pending.Error != "" {
		t.Fatalf("archive failure misreported: %+v", pending)
	}
	db.Model(&TaskAttempt{}).Where("id = ?", Key("a", "image-task", task.ID)).Update("next_attempt", 0)
	if err := RecoverTaskResults(context.Background(), db, archive); err != nil {
		t.Fatal(err)
	}
	db.First(&pending, "id = ?", task.ID)
	if calls != 2 || pending.Status != "completed" || pending.StorageKey != "server:"+file {
		t.Fatalf("recovery failed: calls=%d %+v", calls, pending)
	}
}

func TestResultSurvivesBusinessWriteFailure(t *testing.T) {
	db := testDB(t)
	task := imageTask(t, db, "persist")
	task.Status = "failed"
	task.Error = "provider rejected request"
	if err := db.Callback().Update().Before("gorm:update").Register("fail_task_update", func(tx *gorm.DB) {
		if tx.Statement.Table == "canvas_image_tasks" {
			tx.AddError(errors.New("database temporarily unavailable"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	if err := StageTaskResult(db, &task); err == nil {
		t.Fatal("expected injected update failure")
	}
	var attempt TaskAttempt
	db.First(&attempt, "id = ?", Key("a", "image-task", task.ID))
	if attempt.ResultJSON == "" {
		t.Fatal("durable result lost")
	}
	db.Callback().Update().Remove("fail_task_update")
	db.Model(&attempt).Update("lease_until", 0)
	if err := RecoverTaskResults(context.Background(), db, nil); err != nil {
		t.Fatal(err)
	}
	var recovered model.CanvasImageTask
	db.First(&recovered, "id = ?", task.ID)
	if recovered.Status != "failed" || recovered.Error != task.Error {
		t.Fatalf("result not recovered: %+v", recovered)
	}
}

func TestInterruptedSubmissionBecomesUnknownWithoutResubmission(t *testing.T) {
	db := testDB(t)
	task := imageTask(t, db, "interrupted")
	if _, err := BeginTaskSubmission(db, "a", "image-task", task.ID); err != nil {
		t.Fatal(err)
	}
	db.Model(&TaskAttempt{}).Where("task_id = ?", task.ID).Updates(map[string]any{"started": timestamp() - Day, "lease_until": 0})
	if err := RecoverTaskResults(context.Background(), db, func(context.Context, string, string, string) (ArchivedTaskMedia, error) {
		t.Fatal("resubmitted interrupted task")
		return ArchivedTaskMedia{}, nil
	}); err != nil {
		t.Fatal(err)
	}
	var recovered model.CanvasImageTask
	db.First(&recovered, "id = ?", task.ID)
	if recovered.Status != "failed" || recovered.Error == "" {
		t.Fatal("task stuck after restart")
	}
	var attempt TaskAttempt
	db.First(&attempt, "id = ?", Key("a", "image-task", task.ID))
	if attempt.State != "unknown" {
		t.Fatal(attempt.State)
	}
}

func TestArchiveStopsAtBoundAndOldEpochCannotStage(t *testing.T) {
	for _, limit := range []string{"attempts", "archive-age", "task-age"} {
		t.Run(limit, func(t *testing.T) {
			db := testDB(t)
			task := imageTask(t, db, "limit")
			task.Status = "completed"
			task.ImageURL = "https://provider.invalid/file"
			if err := StageTaskResult(db, &task); err != nil {
				t.Fatal(err)
			}
			patch := map[string]any{"archive_started": timestamp(), "archive_attempts": 1}
			switch limit {
			case "attempts":
				patch["archive_attempts"] = 12
			case "archive-age":
				patch["archive_started"] = timestamp() - Day/4
			case "task-age":
				patch["started"] = timestamp() - Day
			}
			db.Model(&TaskAttempt{}).Where("task_id = ?", task.ID).Updates(patch)
			if err := RecoverTaskResults(context.Background(), db, func(context.Context, string, string, string) (ArchivedTaskMedia, error) {
				t.Fatal("archive exceeded bound")
				return ArchivedTaskMedia{}, nil
			}); err != nil {
				t.Fatal(err)
			}
			var attempt TaskAttempt
			db.First(&attempt, "id = ?", Key("a", "image-task", task.ID))
			if attempt.State != "archive_failed" {
				t.Fatal(attempt.State)
			}
		})
	}
	db := testDB(t)
	task := imageTask(t, db, "old")
	db.Model(&Policy{}).Where("id = ?", 1).Update("epoch", 2)
	task.Status = "completed"
	if err := StageTaskResult(db, &task); err != ErrConflict {
		t.Fatal(err)
	}
	if err := SaveRecord(db, &task); err != ErrConflict {
		t.Fatal(err)
	}
}

func TestManualArchiveRetryDoesNotResetAutomaticBudget(t *testing.T) {
	db := testDB(t)
	task := imageTask(t, db, "manual")
	file := upload(t, db, "a", "manual-result")
	task.Status = "completed"
	task.ImageURL = "https://provider.invalid/result"
	if err := StageTaskResult(db, &task); err != nil {
		t.Fatal(err)
	}
	db.Model(&TaskAttempt{}).Where("task_id = ?", task.ID).Updates(map[string]any{"archive_attempts": 12, "archive_started": timestamp() - Day/3})
	if err := RecoverTaskResults(context.Background(), db, nil); err != nil {
		t.Fatal(err)
	}
	if err := RetryTaskArchive(db, "a", "image-task", task.ID, "retry", 1); err != nil {
		t.Fatal(err)
	}
	calls := 0
	if err := RecoverTaskResults(context.Background(), db, func(context.Context, string, string, string) (ArchivedTaskMedia, error) {
		calls++
		return ArchivedTaskMedia{URL: "/api/files/" + file + "/content", StorageKey: "server:" + file}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := RetryTaskArchive(db, "a", "image-task", task.ID, "retry", 1); err != nil {
		t.Fatal(err)
	}
	var attempt TaskAttempt
	db.First(&attempt, "id = ?", Key("a", "image-task", task.ID))
	if calls != 1 || attempt.ArchiveAttempts != 13 || attempt.State != "done" {
		t.Fatalf("manual retry changed automatic budget or replayed: calls=%d %+v", calls, attempt)
	}
}

func TestArchiveRecoveryReceiptDoesNotBorrowANewerRevision(t *testing.T) {
	db := testDB(t)
	task := imageTask(t, db, "receipt")
	task.Status, task.ImageURL = "completed", "https://provider.invalid/result"
	if err := StageTaskResult(db, &task); err != nil {
		t.Fatal(err)
	}
	oldSnapshot := task.UpdatedAt
	if err := RetryTaskArchive(db, "a", "image-task", task.ID, "first", 1); err != nil {
		t.Fatal(err)
	}
	first, err := TaskArchiveRetryReceipt(db, "a", "first")
	if err != nil {
		t.Fatal(err)
	}
	if version, err := TaskRecoveryVersion(db, "a", "image-task", task.ID, oldSnapshot); err != nil || version != 0 {
		t.Fatalf("old snapshot borrowed recovery: %d %v", version, err)
	}
	var public model.CanvasImageTask
	if err := db.First(&public, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if version, err := TaskRecoveryVersion(db, "a", "image-task", task.ID, public.UpdatedAt); err != nil || version != first["version"] {
		t.Fatalf("new snapshot lost recovery: %d %v", version, err)
	}
	if err := RetryTaskArchive(db, "a", "image-task", task.ID, "duplicate-pending", 1); err == nil {
		t.Fatal("scheduled manual retry accepted twice")
	}
	if err := RecoverTaskResults(context.Background(), db, nil); err != nil {
		t.Fatal(err)
	}
	var before Entity
	if err := db.First(&before, "entity_key = ?", Key("a", "image-task", task.ID)).Error; err != nil {
		t.Fatal(err)
	}
	if err := RetryTaskArchive(db, "a", "image-task", task.ID, "second", 1); err != nil {
		t.Fatal(err)
	}
	second, err := TaskArchiveRetryReceipt(db, "a", "second")
	if err != nil {
		t.Fatal(err)
	}
	if second["version"] <= first["version"] {
		t.Fatal("new recovery did not advance")
	}
	var after Entity
	if err := db.First(&after, "entity_key = ?", before.Key).Error; err != nil {
		t.Fatal(err)
	}
	if after.Activity != before.Activity || after.Protection != before.Protection {
		t.Fatal("manual retry renewed content or execution deadline")
	}
	if err := RetryTaskArchive(db, "a", "image-task", task.ID, "first", 1); err != nil {
		t.Fatal(err)
	}
	replayed, err := TaskArchiveRetryReceipt(db, "a", "first")
	if err != nil || replayed["version"] != first["version"] {
		t.Fatalf("receipt changed: %+v %v", replayed, err)
	}
	if _, err := TaskArchiveRetryReceipt(db, "b", "first"); err == nil {
		t.Fatal("another account read receipt")
	}
}

func TestOldTaskLeaseCannotPublishProgressOrAResult(t *testing.T) {
	db := testDB(t)
	task := imageTask(t, db, "stale-worker")
	lease, err := BeginTaskSubmission(db, "a", "image-task", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&TaskAttempt{}).Where("id = ?", lease.ID).Update("worker", "replacement").Error; err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"processing", "completed", "failed"} {
		task.Status = status
		if err := StageTaskResult(db, &task, lease); !errors.Is(err, ErrConflict) {
			t.Fatalf("stale %s accepted: %v", status, err)
		}
	}
	var current model.CanvasImageTask
	db.First(&current, "id = ?", task.ID)
	if current.Status != "queued" {
		t.Fatal("old worker changed public task")
	}
}

func TestBrokenRecoveryRecordDoesNotBlockOtherTasks(t *testing.T) {
	db := testDB(t)
	broken := imageTask(t, db, "broken-record")
	good := imageTask(t, db, "recoverable")
	good.Status = "failed"
	good.Error = "provider declined"
	if err := StageTaskResult(db, &good); err != nil {
		t.Fatal(err)
	}
	// Preserve a valid result for a different task while the oldest is corrupt.
	db.Model(&TaskAttempt{}).Where("task_id = ?", broken.ID).Updates(map[string]any{"state": "result", "result_json": "{broken", "started": timestamp() - Day})
	var task model.CanvasImageTask
	task = imageTask(t, db, "second-result")
	task.Status = "completed"
	task.ImageURL = "https://upstream.invalid/image"
	if err := StageTaskResult(db, &task); err != nil {
		t.Fatal(err)
	}
	file := upload(t, db, "a", "recovered")
	calls := 0
	err := RecoverTaskResults(context.Background(), db, func(context.Context, string, string, string) (ArchivedTaskMedia, error) {
		calls++
		return ArchivedTaskMedia{URL: "/api/files/" + file + "/content", StorageKey: "server:" + file}, nil
	})
	if err == nil {
		t.Fatal("corrupt record error was hidden")
	}
	var actual model.CanvasImageTask
	db.First(&actual, "id = ?", task.ID)
	if calls != 1 || actual.Status != "completed" {
		t.Fatalf("unrelated recovery blocked: %d %s", calls, actual.Status)
	}
}
