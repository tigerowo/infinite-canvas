package repository

import (
	"github.com/glebarez/sqlite"
	medialifecycle "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"path/filepath"
	"sync"
	"testing"
)

func TestFinishedCleanupKeepsArchivedVideoForClosedBrowser(t *testing.T) {
	oldDB, oldOnce, oldErr := db, dbOnce, dbErr
	testDB, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "tasks.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := testDB.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	if err := testDB.AutoMigrate(&model.VideoTask{}, &model.StorageObject{}); err != nil {
		t.Fatal(err)
	}
	if err := medialifecycle.Migrate(testDB); err != nil {
		t.Fatal(err)
	}
	db, dbOnce, dbErr = testDB, sync.Once{}, nil
	dbOnce.Do(func() {})
	defer func() { db, dbOnce, dbErr = oldDB, oldOnce, oldErr }()
	for _, task := range []model.VideoTask{
		{ID: "archived", UserID: "owner", Status: "completed", CompletedAt: "2026-01-01", VideoURL: "/api/files/object/content"},
		{ID: "legacy", UserID: "owner", Status: "completed", CompletedAt: "2026-01-01"},
		{ID: "failed", UserID: "owner", Source: "video-workbench", Status: "failed", Error: "504 Gateway Time-out", CompletedAt: "2026-01-01"},
	} {
		if _, err := CreateVideoTask(task); err != nil {
			t.Fatal(err)
		}
	}
	if err := DeleteFinishedVideoTasksBefore("2026-01-02"); err != nil {
		t.Fatal(err)
	}
	if _, found, err := GetUserVideoTask("owner", "archived"); err != nil || !found {
		t.Fatalf("archive lost: %v", err)
	}
	if _, found, _ := GetUserVideoTask("other", "archived"); found {
		t.Fatal("cross-account access")
	}
	if _, found, _ := GetVideoTask("legacy"); !found {
		t.Fatal("legacy timer bypassed unified retention")
	}
	if task, found, err := GetUserVideoTask("owner", "failed"); err != nil || !found || task.Error != "504 Gateway Time-out" {
		t.Fatalf("failure not recoverable: %+v %v", task, err)
	}
	tasks, err := ListUserVideoTasks("owner", "video-workbench", 100)
	if err != nil || len(tasks) != 3 {
		t.Fatalf("workbench must recover terminal tasks: %+v %v", tasks, err)
	}
}
