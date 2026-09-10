package repository

import (
	"path/filepath"
	"sync"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestListPromptsStablePaginationOrder(t *testing.T) {
	oldDB, oldOnce, oldErr := db, dbOnce, dbErr
	testDB, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "prompts.db")), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := testDB.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	if err := testDB.AutoMigrate(&model.Prompt{}); err != nil {
		t.Fatal(err)
	}
	db, dbOnce, dbErr = testDB, sync.Once{}, nil
	dbOnce.Do(func() {})
	defer func() { db, dbOnce, dbErr = oldDB, oldOnce, oldErr }()

	for _, item := range []model.Prompt{
		{ID: "d", Title: "d", Prompt: "d", Category: "system", UpdatedAt: "2026-01-01T00:00:00Z"},
		{ID: "b", Title: "b", Prompt: "b", Category: "system", UpdatedAt: "2026-01-01T00:00:00Z"},
		{ID: "c", Title: "c", Prompt: "c", Category: "system", UpdatedAt: "2026-01-01T00:00:00Z"},
		{ID: "a", Title: "a", Prompt: "a", Category: "system", UpdatedAt: "2026-01-01T00:00:00Z"},
	} {
		if err := testDB.Create(&item).Error; err != nil {
			t.Fatal(err)
		}
	}
	first, _, err := ListPrompts(model.Query{Page: 1, PageSize: 2})
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := ListPrompts(model.Query{Page: 2, PageSize: 2})
	if err != nil {
		t.Fatal(err)
	}
	if got := []string{first[0].ID, first[1].ID, second[0].ID, second[1].ID}; len(got) != 4 || got[0] != "a" || got[1] != "b" || got[2] != "c" || got[3] != "d" {
		t.Fatalf("unexpected stable order: %#v", got)
	}
}
