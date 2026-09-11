package medialifecycle

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	db := lifecycleTestDB(t, filepath.Join(t.TempDir(), "lifecycle.db"))
	if err := db.AutoMigrate(&model.StorageObject{}, &model.CanvasProject{}, &model.User{}, &model.UserConfig{}, &model.CreditLog{}); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&Policy{}).Where("id = ?", 1).Updates(map[string]any{"migrated_at": timestamp(), "storage_reviewed": true, "execution": "enforce"}).Error; err != nil {
		t.Fatal(err)
	}
	return db
}

func TestBackfillAILogUsesOriginalCreationTime(t *testing.T) {
	fallback := time.Now().UTC().UnixMilli()
	created := time.Now().UTC().Add(-40 * 24 * time.Hour).Truncate(time.Millisecond)
	activity, createdAt := backfillRecordTimes(&model.AICallLog{CreatedAt: created.Format(time.RFC3339Nano)}, fallback)
	if activity != created.UnixMilli() || createdAt != created.UnixMilli() {
		t.Fatalf("AI log backfill used the migration time: activity=%d created=%d", activity, createdAt)
	}
}

func TestCleanupDeletesAnonymousAILogRow(t *testing.T) {
	db := testDB(t)
	if err := db.AutoMigrate(&model.AICallLog{}); err != nil {
		t.Fatal(err)
	}
	policy, err := GetPolicy(db)
	if err != nil {
		t.Fatal(err)
	}
	item := model.AICallLog{ID: "anonymous-log", CreatedAt: time.Now().UTC().Add(-40 * 24 * time.Hour).Format(time.RFC3339Nano)}
	if err := CreateRecord(db, &item, policy.Epoch); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&Entity{}).Where("entity_key = ?", Key("@anonymous", "ai-log", item.ID)).Update("activity", time.Now().UTC().Add(-40*24*time.Hour).UnixMilli()).Error; err != nil {
		t.Fatal(err)
	}
	preview, err := PreviewCleanup(db, "expiry")
	if err != nil {
		t.Fatal(err)
	}
	if preview.Records != 1 {
		t.Fatalf("anonymous AI log missing from preview: %+v", preview)
	}
	if err := StartBatch(db, preview.Batch.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := RunBatch(context.Background(), db, preview.Batch.ID, nil); err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := db.Model(&model.AICallLog{}).Where("id = ?", item.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("anonymous AI log database row still exists")
	}
}

func TestSettlementRollbackAndDuplicateRefund(t *testing.T) {
	db := testDB(t)
	if err := db.Create(&model.User{ID: "account", Username: "account", AffCode: "account", Credits: 100}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Callback().Create().Before("gorm:create").Register("fail_credit_log", func(tx *gorm.DB) {
		if tx.Statement.Table == "credit_logs" {
			tx.AddError(errors.New("audit unavailable"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	if err := Debit(db, "account", "operation", "test", "/test", 10); err == nil {
		t.Fatal("expected audit failure")
	}
	var user model.User
	db.First(&user, "id = ?", "account")
	if user.Credits != 100 {
		t.Fatal("partial debit")
	}
	if err := db.Callback().Create().Remove("fail_credit_log"); err != nil {
		t.Fatal(err)
	}
	if err := Debit(db, "account", "operation", "test", "/test", 10); err != nil {
		t.Fatal(err)
	}
	if err := Debit(db, "account", "operation", "test", "/test", 10); err == nil {
		t.Fatal("duplicate submission permitted")
	}
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- Refund(db, "account", "operation", "test", "/test", 10) }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	db.First(&user, "id = ?", "account")
	if user.Credits != 100 {
		t.Fatalf("duplicate refund: %d", user.Credits)
	}
	var count int64
	db.Model(&model.CreditLog{}).Count(&count)
	if count != 2 {
		t.Fatalf("audit count %d", count)
	}
	if err := Debit(db, "account", "unknown", "test", "/test", 10); err != nil {
		t.Fatal(err)
	}
	if err := SettlementState(db, "account", "unknown", "unknown"); err != nil {
		t.Fatal(err)
	}
	if err := Refund(db, "account", "unknown", "test", "/test", 10); err == nil {
		t.Fatal("unknown provider outcome was refunded")
	}
}
func upload(t *testing.T, db *gorm.DB, owner, hash string) string {
	t.Helper()
	lease, err := ReserveUpload(db, "platform", hash, "image/png", 12, 1)
	if err != nil {
		t.Fatal(err)
	}
	object := model.StorageObject{ID: lease.File.ID, ObjectKey: "test/" + lease.File.ID, CreatedBy: owner, MimeType: "image/png", Bytes: 12}
	if err := CompleteUpload(db, lease, owner, "test", object); err != nil {
		t.Fatal(err)
	}
	return lease.File.ID
}
func age(t *testing.T, db *gorm.DB) {
	t.Helper()
	old := timestamp() - 31*Day
	for _, row := range []any{&File{}, &Entity{}, &Material{}} {
		if err := db.Session(&gorm.Session{AllowGlobalUpdate: true}).Model(row).Update("activity", old).Error; err != nil {
			t.Fatal(err)
		}
	}
}

func TestCrossAccountDedupAndIndependentShare(t *testing.T) {
	db := testDB(t)
	id := upload(t, db, "a", "same")
	if next := upload(t, db, "b", "same"); next != id {
		t.Fatal("same content was duplicated")
	}
	share, err := Share(db, "a", id)
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := Claim(db, "c", share.ID, Use{Kind: "draft", ID: "draft", OperationID: "paste", Epoch: 1})
	if err != nil {
		t.Fatal(err)
	}
	if claimed.ID == share.ID {
		t.Fatal("recipient must receive independent share ID")
	}
	if err := Detach(db, "a", id); err != nil {
		t.Fatal(err)
	}
	if _, err := Claim(db, "d", share.ID, Use{Kind: "draft", ID: "draft", OperationID: "paste", Epoch: 1}); err != ErrUnavailable {
		t.Fatalf("revoked share accepted: %v", err)
	}
	if err := CheckAccess(db, "b", id); err != nil {
		t.Fatal(err)
	}
	if err := CheckAccess(db, "c", id); err != nil {
		t.Fatal(err)
	}
	if err := CheckAccess(db, "stranger", id); err != ErrForbidden {
		t.Fatalf("private locator grants access: %v", err)
	}
	var count int64
	db.Model(&File{}).Count(&count)
	if count != 1 {
		t.Fatalf("files=%d", count)
	}
}

func TestRenewalSkipsOldCleanupWithoutRenewingOtherCanvas(t *testing.T) {
	db := testDB(t)
	id := upload(t, db, "a", "same")
	upload(t, db, "b", "same")
	for _, owner := range []string{"a", "b"} {
		_, err := SaveUse(db, Use{Owner: owner, Kind: "canvas", ID: "canvas", Payload: `{"image":"server:` + id + `"}`}, nil)
		if err != nil {
			t.Fatal(err)
		}
	}
	age(t, db)
	preview, err := PreviewCleanup(db, "expiry")
	if err != nil {
		t.Fatal(err)
	}
	if err := StartBatch(db, preview.Batch.ID, ""); err != nil {
		t.Fatal(err)
	}
	result, err := SaveUse(db, Use{Owner: "b", Kind: "canvas", ID: "canvas", OperationID: "open", Epoch: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.ExpiresAt < timestamp()+29*Day {
		t.Fatal("renewal window too short")
	}
	deletes := 0
	if err := RunBatch(context.Background(), db, preview.Batch.ID, func(context.Context, File) error { deletes++; return nil }); err != nil {
		t.Fatal(err)
	}
	if deletes != 0 {
		t.Fatal("renewed shared file was deleted")
	}
	var a, b Entity
	db.First(&a, "entity_key = ?", Key("a", "canvas", "canvas"))
	db.First(&b, "entity_key = ?", Key("b", "canvas", "canvas"))
	if a.State != Deleted || b.State != Active {
		t.Fatalf("a=%s b=%s", a.State, b.State)
	}
}

func TestDeletionFailureLocksRenewalAndCanResume(t *testing.T) {
	db := testDB(t)
	id := upload(t, db, "a", "same")
	age(t, db)
	preview, err := PreviewCleanup(db, "expiry")
	if err != nil {
		t.Fatal(err)
	}
	if err := StartBatch(db, preview.Batch.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := RunBatch(context.Background(), db, preview.Batch.ID, func(context.Context, File) error { return errors.New("network timeout") }); err != nil {
		t.Fatal(err)
	}
	if _, err := SaveUse(db, Use{Owner: "a", Kind: "draft", ID: "new", Files: []string{id}, OperationID: "use"}, nil); err != ErrUnavailable {
		t.Fatalf("locked file renewed: %v", err)
	}
	var b Batch
	db.First(&b, "id = ?", preview.Batch.ID)
	if b.State != "failed" {
		t.Fatalf("state=%s", b.State)
	}
	if err := RunBatch(context.Background(), db, b.ID, func(context.Context, File) error { return nil }); err != nil {
		t.Fatal(err)
	}
	newID := upload(t, db, "a", "same")
	if newID == id {
		t.Fatal("new object reused a deleted identity")
	}
}

func TestSaveAndReferenceRollbackTogether(t *testing.T) {
	db := testDB(t)
	id := upload(t, db, "a", "same")
	age(t, db)
	_, err := SaveUse(db, Use{Owner: "a", Kind: "canvas", ID: "new", Files: []string{id}, OperationID: "save"}, func(tx *gorm.DB) error {
		if err := tx.Create(&model.CanvasProject{ID: "new", UserID: "a", ProjectData: "{}"}).Error; err != nil {
			return err
		}
		return errors.New("write failed")
	})
	if err == nil {
		t.Fatal("expected rollback")
	}
	var f File
	db.First(&f, "id = ?", id)
	if f.Activity > timestamp()-30*Day {
		t.Fatal("failed save renewed file")
	}
	var count int64
	db.Model(&model.CanvasProject{}).Count(&count)
	if count != 0 {
		t.Fatal("partial business save")
	}
}

func TestMaintenanceIsNotActivityAndOperationsAreIdempotent(t *testing.T) {
	db := testDB(t)
	id := upload(t, db, "a", "same")
	input := Use{Owner: "a", Kind: "canvas", ID: "x", Payload: `{"image":"server:` + id + `"}`}
	if _, err := SaveUse(db, input, nil); err != nil {
		t.Fatal(err)
	}
	age(t, db)
	if _, err := SaveUse(db, input, nil); err != nil {
		t.Fatal(err)
	}
	var f File
	db.First(&f, "id = ?", id)
	if f.Activity > timestamp()-30*Day {
		t.Fatal("unchanged save renewed file")
	}
	input.OperationID = "open"
	if _, err := SaveUse(db, input, nil); err != nil {
		t.Fatal(err)
	}
	db.First(&f, "id = ?", id)
	version := f.Version
	if _, err := SaveUse(db, input, nil); err != nil {
		t.Fatal(err)
	}
	db.First(&f, "id = ?", id)
	if f.Version != version {
		t.Fatal("retry renewed again")
	}
}

func TestClearPreservesConfigurationAndRejectsOldEpoch(t *testing.T) {
	db := testDB(t)
	upload(t, db, "a", "same")
	if err := db.Create(&model.UserConfig{UserID: "a", ModelConfig: `{"key":"test"}`, StorageProvider: `{"bucket":"test"}`}).Error; err != nil {
		t.Fatal(err)
	}
	preview, err := PreviewCleanup(db, "clear")
	if err != nil {
		t.Fatal(err)
	}
	if err := StartBatch(db, preview.Batch.ID, "wrong"); err == nil {
		t.Fatal("clear accepted without confirmation")
	}
	if err := StartBatch(db, preview.Batch.ID, "清空业务数据"); err != nil {
		t.Fatal(err)
	}
	if _, err := SaveUse(db, Use{Owner: "a", Kind: "draft", ID: "late", Epoch: 1}, nil); err != ErrClearing {
		t.Fatal(err)
	}
	if err := RunBatch(context.Background(), db, preview.Batch.ID, func(context.Context, File) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := SaveUse(db, Use{Owner: "a", Kind: "draft", ID: "late", Epoch: 1}, nil); err != ErrConflict {
		t.Fatal(err)
	}
	var config model.UserConfig
	db.First(&config, "user_id = ?", "a")
	if config.ModelConfig == "" || config.StorageProvider == "" {
		t.Fatal("configuration lost")
	}
}

func TestUploadLeaseAndContentExtraction(t *testing.T) {
	db := testDB(t)
	first, err := ReserveUpload(db, "platform", "hash", "image/png", 12, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ReserveUpload(db, "platform", "hash", "image/png", 12, 1); err != ErrUploading {
		t.Fatal(err)
	}
	db.Model(&Dedup{}).Where("file_id = ?", first.File.ID).Update("lease_until", 0)
	second, err := ReserveUpload(db, "platform", "hash", "image/png", 12, 1)
	if err != nil {
		t.Fatal(err)
	}
	if second.File.ID == first.File.ID {
		t.Fatal("expired lease reused identity")
	}
	if err := CompleteUpload(db, first, "a", "", model.StorageObject{ID: first.File.ID}); err != ErrConflict {
		t.Fatal(err)
	}
	files := ExtractFiles(`{"nested":"{\"key\":\"server:abc\"}","url":"/api/files/abc/content","hash":"abc"}`)
	if len(files) != 1 || files[0] != "abc" {
		t.Fatal(files)
	}
}

func TestRemovedMaterialCanBeUploadedAgainWithoutCopy(t *testing.T) {
	db := testDB(t)
	id := upload(t, db, "a", "same")
	previous, err := Share(db, "a", id)
	if err != nil {
		t.Fatal(err)
	}
	if err := Detach(db, "a", id); err != nil {
		t.Fatal(err)
	}
	if next := upload(t, db, "a", "same"); next != id {
		t.Fatal("reupload duplicated the object")
	}
	if _, err := Resolve(db, previous.ID); err != ErrUnavailable {
		t.Fatalf("old share revived: %v", err)
	}
	if err := CheckAccess(db, "a", id); err != nil {
		t.Fatal(err)
	}
}

func TestOnlyOneCleanupWorkerDeletesTheObject(t *testing.T) {
	db := testDB(t)
	upload(t, db, "a", "same")
	age(t, db)
	preview, err := PreviewCleanup(db, "expiry")
	if err != nil {
		t.Fatal(err)
	}
	if err := StartBatch(db, preview.Batch.ID, ""); err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- RunBatch(context.Background(), db, preview.Batch.ID, func(context.Context, File) error { close(entered); <-release; return nil })
	}()
	<-entered
	called := false
	err = RunBatch(context.Background(), db, preview.Batch.ID, func(context.Context, File) error { called = true; return nil })
	close(release)
	if first := <-done; first != nil {
		t.Fatal(first)
	}
	if err == nil || called {
		t.Fatalf("second worker ran deletion: %v", err)
	}
}
