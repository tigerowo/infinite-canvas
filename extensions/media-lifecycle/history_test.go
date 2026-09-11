package medialifecycle

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func historyFixture(t *testing.T, kind string) (*gorm.DB, func(string, string, string, string) any) {
	t.Helper()
	db := testDB(t)
	if err := db.AutoMigrate(&model.ImageGenerationLog{}, &model.VideoGenerationLog{}); err != nil {
		t.Fatal(err)
	}
	return db, func(owner, id, task, status string) any {
		raw := fmt.Sprintf(`{"id":%q,"status":%q}`, id, status)
		if kind == "image-history" {
			return &model.ImageGenerationLog{ID: id, UserID: owner, TaskID: task, Status: status, PayloadJSON: raw}
		}
		return &model.VideoGenerationLog{ID: id, UserID: owner, TaskID: task, Status: status, PayloadJSON: raw}
	}
}

func TestHistoryOwnershipDeletionAndTerminalState(t *testing.T) {
	for _, kind := range []string{"image-history", "video-history"} {
		t.Run(kind, func(t *testing.T) {
			db, row := historyFixture(t, kind)
			if err := SaveHistory(db, "a", kind, []any{row("a", "log", "task", "成功")}, 1); err != nil {
				t.Fatal(err)
			}
			if err := SaveHistory(db, "b", kind, []any{row("b", "log", "other-task", "生成中")}, 1); !errors.Is(err, ErrForbidden) {
				t.Fatalf("cross-account primary key accepted: %v", err)
			}
			if err := SaveHistory(db, "a", kind, []any{row("a", "log", "task", "生成中")}, 1); err != nil {
				t.Fatal(err)
			}
			table, _, _ := historyTable(kind)
			var stored map[string]any
			db.Table(table).Where("id = ?", "log").Take(&stored)
			if columnString(stored["status"]) != "成功" {
				t.Fatal("stale progress replaced terminal result")
			}
			if err := DeleteHistory(db, "a", kind, []string{"task"}, time.Now().UTC().Format(time.RFC3339Nano), 1); err != nil {
				t.Fatal(err)
			}
			if err := SaveHistory(db, "a", kind, []any{row("a", "replacement-id", "task", "成功")}, 1); err != nil {
				t.Fatal(err)
			}
			var count int64
			db.Table(table).Where("deleted_at = ?", "").Count(&count)
			if count != 0 {
				t.Fatal("alias replay revived a deleted task history")
			}
			db.Model(&Entity{}).Where("owner = ? AND kind = ? AND state = ?", "a", kind, Active).Count(&count)
			if count != 0 {
				t.Fatal("history references stayed active after deletion")
			}
		})
	}
}

func TestHistoryConcurrentSaveAndDeleteCannotRevive(t *testing.T) {
	db, row := historyFixture(t, "image-history")
	if err := SaveHistory(db, "a", "image-history", []any{row("a", "log", "task", "成功")}, 1); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 9)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- SaveHistory(db, "a", "image-history", []any{row("a", "log", "task", "成功")}, 1)
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		errs <- DeleteHistory(db, "a", "image-history", []string{"task"}, "deleted", 1)
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var count int64
	db.Model(&model.ImageGenerationLog{}).Where("deleted_at = ?", "").Count(&count)
	if count != 0 {
		t.Fatal("concurrent save revived deleted history")
	}
}

func TestHistoryQueryErrorAndOldEpochCannotWrite(t *testing.T) {
	db, row := historyFixture(t, "image-history")
	if err := db.Callback().Query().Before("gorm:query").Register("history_lookup_failure", func(tx *gorm.DB) {
		if tx.Statement.Table == "image_generation_logs" {
			tx.AddError(errors.New("injected query outage"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	if err := SaveHistory(db, "a", "image-history", []any{row("a", "log", "task", "成功")}, 1); err == nil {
		t.Fatal("query failure treated as missing row")
	}
	db.Callback().Query().Remove("history_lookup_failure")
	db.Model(&Policy{}).Where("id = ?", 1).Update("epoch", 2)
	for _, epoch := range []int64{0, 1} {
		if err := SaveHistory(db, "a", "image-history", []any{row("a", "old", "task", "成功")}, epoch); !errors.Is(err, ErrConflict) {
			t.Fatal(err)
		}
	}
	if err := SaveHistory(db, "a", "image-history", []any{row("a", "new", "new-task", "成功")}, 2); err != nil {
		t.Fatal(err)
	}
}

func TestLegacyHistoryMigrationPreservesConcurrentAccountConfiguration(t *testing.T) {
	db, row := historyFixture(t, "image-history")
	original := `{"logs":[{"id":"old","status":"成功"}]}`
	if err := db.Create(&model.UserConfig{UserID: "a", ModelConfig: `{"key":"current"}`, StorageProvider: `{"storage":"current"}`, ImageHistory: original}).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLegacyImageHistory(db, "a", "outdated copy", []any{row("a", "old", "task", "成功")}, 1); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if err := MigrateLegacyImageHistory(db, "a", original, []any{row("a", "old", "task", "成功")}, 1); err != nil {
		t.Fatal(err)
	}
	var current model.UserConfig
	db.First(&current, "user_id = ?", "a")
	if current.ImageHistory != "" || current.ModelConfig != `{"key":"current"}` || current.StorageProvider != `{"storage":"current"}` {
		t.Fatal("migration changed unrelated configuration")
	}
}
