package medialifecycle

import (
	"context"
	"errors"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"testing"
)

func TestClearIncludesAnEarlierUnconfirmedDeletion(t *testing.T) {
	db := testDB(t)
	id := upload(t, db, "a", "expiry-failed")
	age(t, db)
	preview, err := PreviewCleanup(db, "expiry")
	if err != nil {
		t.Fatal(err)
	}
	if err := StartBatch(db, preview.Batch.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := RunBatch(context.Background(), db, preview.Batch.ID, func(context.Context, File) error { return errors.New("delete timeout") }); err != nil {
		t.Fatal(err)
	}
	clear, err := PreviewCleanup(db, "clear")
	if err != nil {
		t.Fatal(err)
	}
	if clear.Files != 1 {
		t.Fatalf("unconfirmed object escaped clear: %+v", clear)
	}
	if err := StartBatch(db, clear.Batch.ID, "清空业务数据"); err != nil {
		t.Fatal(err)
	}
	var deleted []string
	if err := RunBatch(context.Background(), db, clear.Batch.ID, func(_ context.Context, f File) error { deleted = append(deleted, f.ID); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(deleted) != 1 || deleted[0] != id {
		t.Fatal(deleted)
	}
	policy, _ := GetPolicy(db)
	if policy.Clearing {
		t.Fatal("successful recovery left clear locked")
	}
}

func TestDirectRegistrationAndSameMillisecondWriteInvalidateClear(t *testing.T) {
	db := testDB(t)
	preview, err := PreviewCleanup(db, "clear")
	if err != nil {
		t.Fatal(err)
	}
	object := model.StorageObject{ID: "direct-after-migration", ObjectKey: "owner/direct", CreatedBy: "a", Bytes: 12}
	if err := RegisterObject(db, object, "user-scope", 1); err != nil {
		t.Fatal(err)
	}
	// A timestamp-only boundary would miss this record.
	db.Model(&File{}).Where("id = ?", object.ID).Update("activity", preview.Batch.Created)
	db.Model(&Entity{}).Where("owner = ?", "a").Update("activity", preview.Batch.Created)
	if err := StartBatch(db, preview.Batch.ID, "清空业务数据"); err == nil {
		t.Fatal("new object escaped the immutable preview")
	}
	current, err := PreviewCleanup(db, "clear")
	if err != nil {
		t.Fatal(err)
	}
	if current.Files != 1 || current.Records != 1 {
		t.Fatalf("direct registration absent from graph: %+v", current)
	}
}

func TestUploadRenewalKeepsIdentityButNeverRevivesAnExpiredLease(t *testing.T) {
	db := testDB(t)
	lease, err := ReserveUpload(db, "platform", "renewal", "image/png", 12, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := RenewUpload(db, lease); err != nil {
		t.Fatal(err)
	}
	if _, err := ReserveUpload(db, "platform", "renewal", "image/png", 12, 1); !errors.Is(err, ErrUploading) {
		t.Fatal(err)
	}
	object := model.StorageObject{ID: lease.File.ID, ObjectKey: "test/original", CreatedBy: "a"}
	if err := PrepareUpload(db, lease, object); err != nil {
		t.Fatal(err)
	}
	db.Model(&Dedup{}).Where("file_id = ?", lease.File.ID).Update("lease_until", 0)
	if err := RenewUpload(db, lease); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if err := PrepareUpload(db, lease, object); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	var file File
	db.First(&file, "id = ?", lease.File.ID)
	if file.ObjectJSON == "" {
		t.Fatal("lost coordinates for an interrupted upload")
	}
}

func TestMarkMissingRejectsStaleFileSnapshot(t *testing.T) {
	db := testDB(t)
	id := upload(t, db, "a", "missing-race")
	var stale File
	if err := db.First(&stale, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&File{}).Where("id = ?", id).Update("version", stale.Version+1).Error; err != nil {
		t.Fatal(err)
	}
	if err := MarkMissing(db, stale); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale file snapshot changed lifecycle state: %v", err)
	}
	var current File
	if err := db.First(&current, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	if current.State != Active {
		t.Fatalf("stale missing result marked current file %q", current.State)
	}
}

func TestReleaseLockedRejectsAnotherEpochBeforeSideEffects(t *testing.T) {
	db := testDB(t)
	entity := Entity{Key: Key("a", "video-task", "task"), Owner: "a", Kind: "video-task", ID: "task", State: Active, Epoch: 2, Version: 1}
	if err := db.Create(&entity).Error; err != nil {
		t.Fatal(err)
	}
	attempt := TaskAttempt{ID: entity.Key, Owner: "a", Kind: entity.Kind, TaskID: entity.ID, Epoch: entity.Epoch}
	if err := db.Create(&attempt).Error; err != nil {
		t.Fatal(err)
	}
	removeCalled := false
	err := db.Transaction(func(tx *gorm.DB) error {
		return ReleaseLocked(tx, Policy{Epoch: 1}, entity.Owner, entity.Kind, entity.ID, func(*gorm.DB) error {
			removeCalled = true
			return nil
		})
	})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("cross-epoch release was accepted: %v", err)
	}
	if removeCalled {
		t.Fatal("business removal ran before the epoch conflict was detected")
	}
	var count int64
	if err := db.Model(&TaskAttempt{}).Where("id = ?", attempt.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("task recovery state was removed by a stale release")
	}
}

func TestExpiredCleanupWorkerCannotCommitAfterTakeover(t *testing.T) {
	db := testDB(t)
	id := upload(t, db, "a", "takeover")
	age(t, db)
	preview, err := PreviewCleanup(db, "expiry")
	if err != nil {
		t.Fatal(err)
	}
	if err := StartBatch(db, preview.Batch.ID, ""); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- RunBatch(context.Background(), db, preview.Batch.ID, func(context.Context, File) error { close(entered); <-release; return nil })
	}()
	<-entered
	// Simulate a stopped process losing its execution lease to a successor.
	if err := db.Model(&Batch{}).Where("id = ?", preview.Batch.ID).Updates(map[string]any{"worker": "successor", "lease_until": timestamp() + Day}).Error; err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; err == nil {
		t.Fatal("stale worker reported completion")
	}
	var file File
	db.First(&file, "id = ?", id)
	if file.State != Deleting || file.ObjectJSON == "" {
		t.Fatal("stale worker destroyed recovery coordinates")
	}
	var item BatchItem
	db.First(&item, "batch_id = ? AND kind = ? AND target = ?", preview.Batch.ID, "file", id)
	if item.State != "locked" {
		t.Fatalf("stale worker changed successor item: %s", item.State)
	}
}

func TestTwoBatchesCannotDeleteOneFileConcurrently(t *testing.T) {
	db := testDB(t)
	upload(t, db, "a", "two-batches")
	age(t, db)
	a, err := PreviewCleanup(db, "expiry")
	if err != nil {
		t.Fatal(err)
	}
	b, err := PreviewCleanup(db, "expiry")
	if err != nil {
		t.Fatal(err)
	}
	if err := StartBatch(db, a.Batch.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := StartBatch(db, b.Batch.ID, ""); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- RunBatch(context.Background(), db, a.Batch.ID, func(context.Context, File) error { close(entered); <-release; return nil })
	}()
	<-entered
	calls := 0
	err = RunBatch(context.Background(), db, b.Batch.ID, func(context.Context, File) error { calls++; return nil })
	close(release)
	if first := <-done; first != nil {
		t.Fatal(first)
	}
	if calls != 0 {
		t.Fatal("second batch also deleted the leased file")
	}
	if err != nil && !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
}

func TestCleanupFinalizerFailureKeepsClearRetryable(t *testing.T) {
	db := testDB(t)
	preview, err := PreviewCleanup(db, "clear")
	if err != nil {
		t.Fatal(err)
	}
	if err := StartBatch(db, preview.Batch.ID, "清空业务数据"); err != nil {
		t.Fatal(err)
	}
	finalizerErr := errors.New("log directory unavailable")
	if err := RunBatchWithFinalizer(context.Background(), db, preview.Batch.ID, nil, func(context.Context, Batch) error { return finalizerErr }); !errors.Is(err, finalizerErr) {
		t.Fatalf("finalizer failure was hidden: %v", err)
	}
	var batch Batch
	if err := db.First(&batch, "id = ?", preview.Batch.ID).Error; err != nil {
		t.Fatal(err)
	}
	if batch.State != "failed" || batch.Error == "" {
		t.Fatalf("finalizer failure was reported as complete: %+v", batch)
	}
	policy, err := GetPolicy(db)
	if err != nil {
		t.Fatal(err)
	}
	if !policy.Clearing {
		t.Fatal("clear lock was released before the log file cleanup succeeded")
	}
}
