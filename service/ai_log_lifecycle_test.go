package service

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/tigerowo/infinite-canvas/config"
	medialifecycle "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func TestAILogFilesFollowTheUnifiedRetentionBatch(t *testing.T) {
	dir := t.TempDir()
	previous := config.Cfg.AILogDir
	config.Cfg.AILogDir = dir
	t.Cleanup(func() { config.Cfg.AILogDir = previous })

	created := time.Now().Add(-40 * 24 * time.Hour)
	item := model.AICallLog{ID: "old-log", UserID: "account", Model: "test", CreatedAt: created.Format(time.RFC3339)}
	recent := model.AICallLog{ID: "recent-log", UserID: "account", Model: "test", CreatedAt: time.Now().Format(time.RFC3339)}
	encoded, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	recentEncoded, err := json.Marshal(recent)
	if err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(dir, "ai-calls-"+created.Format("2006-01-02")+".log")
	contents := append(append(append([]byte{}, encoded...), '\n'), recentEncoded...)
	contents = append(contents, '\n')
	if err := os.WriteFile(logPath, contents, 0644); err != nil {
		t.Fatal(err)
	}

	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "ai-log-lifecycle.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.AICallLog{}); err != nil {
		t.Fatal(err)
	}
	if err := medialifecycle.Migrate(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&medialifecycle.Policy{}).Where("id = ?", 1).Updates(map[string]any{"migrated_at": time.Now().UnixMilli(), "storage_reviewed": true, "execution": "enforce"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := SyncAICallLogsToDatabase(db); err != nil {
		t.Fatal(err)
	}
	var entity medialifecycle.Entity
	if err := db.First(&entity, "entity_key = ?", medialifecycle.Key("account", "ai-log", item.ID)).Error; err != nil {
		t.Fatal(err)
	}
	if entity.Activity >= time.Now().Add(-30*24*time.Hour).UnixMilli() {
		t.Fatal("legacy log received a new retention window instead of its original activity time")
	}

	preview, err := medialifecycle.PreviewCleanup(db, "expiry")
	if err != nil {
		t.Fatal(err)
	}
	if preview.Records != 1 {
		t.Fatalf("AI log missing from cleanup preview: %+v", preview)
	}
	if err := medialifecycle.StartBatch(db, preview.Batch.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := medialifecycle.RunBatchWithFinalizer(context.Background(), db, preview.Batch.ID, nil, func(ctx context.Context, batch medialifecycle.Batch) error {
		return ReconcileAILogFiles(ctx, db, batch)
	}); err != nil {
		t.Fatal(err)
	}
	remaining, err := readAICallLogFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 1 || remaining[0].ID != recent.ID {
		t.Fatalf("AI log rewrite did not preserve only the active row: %+v", remaining)
	}
	var count int64
	if err := db.Model(&model.AICallLog{}).Where("id = ?", item.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("expired AI log database row still exists")
	}
	if err := db.Model(&model.AICallLog{}).Where("id = ?", recent.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("active AI log database row was removed")
	}
}

func TestAILogReplacementRecoveryRestoresInterruptedFile(t *testing.T) {
	dir := t.TempDir()
	previous := config.Cfg.AILogDir
	config.Cfg.AILogDir = dir
	t.Cleanup(func() { config.Cfg.AILogDir = previous })

	logPath := filepath.Join(dir, "ai-calls-2026-09-11.log")
	backupPath := logPath + ".cleanup-backup"
	if err := os.WriteFile(backupPath, []byte("original\n"), 0644); err != nil {
		t.Fatal(err)
	}
	files, err := aiLogFiles()
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0] != logPath {
		t.Fatalf("interrupted replacement was not recovered: %v", files)
	}
	contents, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "original\n" {
		t.Fatalf("recovered content changed: %q", contents)
	}
}
