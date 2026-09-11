package medialifecycle

import (
	"context"
	"errors"
	"testing"

	"gorm.io/gorm"
)

func TestLateSourceIndexCannotSurviveAClear(t *testing.T) {
	db := testDB(t)
	fileID := upload(t, db, "a", "indexed-file")
	writes := 0
	save := func(*gorm.DB) error { writes++; return nil }
	if err := SaveFileIndex(db, "a", fileID, 1, save); err != nil {
		t.Fatal(err)
	}
	if err := SaveFileIndex(db, "b", fileID, 1, save); err == nil {
		t.Fatal("unauthorized index writer")
	}
	db.Model(&Policy{}).Where("id = ?", 1).Update("epoch", 2)
	if err := SaveFileIndex(db, "a", fileID, 1, save); err == nil {
		t.Fatal("old epoch published source index")
	}
	if writes != 1 {
		t.Fatal(writes)
	}
}

func TestSourceIndexRemainsOnDeleteFailureAndLeavesAfterConfirmation(t *testing.T) {
	db := testDB(t)
	if err := db.Exec("CREATE TABLE ext_media_archive_sources (id varchar(64) PRIMARY KEY, object_id varchar(64))").Error; err != nil {
		t.Fatal(err)
	}
	fileID := upload(t, db, "a", "source-cleanup")
	if err := db.Exec("INSERT INTO ext_media_archive_sources (id, object_id) VALUES (?, ?)", "source", fileID).Error; err != nil {
		t.Fatal(err)
	}
	preview, err := PreviewCleanup(db, "clear")
	if err != nil {
		t.Fatal(err)
	}
	if err := StartBatch(db, preview.Batch.ID, "清空业务数据"); err != nil {
		t.Fatal(err)
	}
	if err := RunBatch(context.Background(), db, preview.Batch.ID, func(context.Context, File) error { return errors.New("delete timeout") }); err != nil {
		t.Fatal(err)
	}
	var count int64
	db.Table("ext_media_archive_sources").Count(&count)
	if count != 1 {
		t.Fatal("source location lost before deletion confirmed")
	}
	if err := RunBatch(context.Background(), db, preview.Batch.ID, func(context.Context, File) error { return nil }); err != nil {
		t.Fatal(err)
	}
	db.Table("ext_media_archive_sources").Count(&count)
	if count != 0 {
		t.Fatal("source index accumulated after deletion")
	}
}
