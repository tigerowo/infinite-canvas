package repository

import (
	"path/filepath"
	"sync"
	"testing"

	"github.com/glebarez/sqlite"
	medialifecycle "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func TestCanvasCompareAndSavePreventsStaleOverwriteAndResurrection(t *testing.T) {
	oldDB, oldOnce, oldErr := db, dbOnce, dbErr
	testDB, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "canvas.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := testDB.DB()
	defer sqlDB.Close()
	if err := testDB.AutoMigrate(&model.CanvasProject{}); err != nil {
		t.Fatal(err)
	}
	if err:=medialifecycle.Migrate(testDB);err!=nil{t.Fatal(err)}
	db, dbOnce, dbErr = testDB, sync.Once{}, nil
	dbOnce.Do(func() {})
	defer func() { db, dbOnce, dbErr = oldDB, oldOnce, oldErr }()
	base := ""
	first := model.CanvasProject{ID: "p", UserID: "owner", CreatedAt: "1", UpdatedAt: "1", ProjectData: `{"nodes":["video","image"]}`}
	if _, err := SaveUserCanvasProject(first, &base); err != nil {
		t.Fatal(err)
	}
	base = "1"
	if _, err := SaveUserCanvasProject(first, &base); err == nil {
		t.Fatal("save reused the same revision")
	}
	edited := first
	edited.UpdatedAt, edited.ProjectData = "2", `{"nodes":["video"]}`
	if _, err := SaveUserCanvasProject(edited, &base); err != nil {
		t.Fatal(err)
	}
	stale := first
	stale.UpdatedAt = "3"
	if _, err := SaveUserCanvasProject(stale, &base); err == nil {
		t.Fatal("stale browser overwrote deletion")
	}
	projects, _ := ListUserCanvasProjects("owner")
	if len(projects) != 1 || projects[0].ProjectData != edited.ProjectData {
		t.Fatal("remote content changed")
	}
	if err := SoftDeleteUserCanvasProjects("owner", []string{"p"}, "4"); err != nil {
		t.Fatal(err)
	}
	base = "2"
	if _, err := SaveUserCanvasProject(stale, &base); err == nil {
		t.Fatal("deleted project resurrected")
	}
	projects, _ = ListUserCanvasProjects("owner")
	if len(projects) != 0 {
		t.Fatal("deleted project listed")
	}
	if err := CleanupDeletedCanvasProjects("9"); err != nil {
		t.Fatal(err)
	}
	if _, err := SaveUserCanvasProjects("owner", []model.CanvasProject{stale}); err != nil {
		t.Fatal(err)
	}
	projects, _ = ListUserCanvasProjects("owner")
	if len(projects) != 0 {
		t.Fatal("expired deletion marker allowed an old browser to resurrect the project")
	}
	other := first
	other.UserID = "other"
	base = ""
	if _, err := SaveUserCanvasProject(other, &base); err != nil {
		t.Fatal("other account's project affected", err)
	}
}
