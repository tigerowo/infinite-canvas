package storageaccess

import (
	"github.com/glebarez/sqlite"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"path/filepath"
	"testing"
	"time"
)

func TestTypeAOfficialVector(t *testing.T) {
	cfg := Config{CDNBaseURL: "https://example.com", TokenKey: "aliyuncdnexp1234"}
	now := time.Unix(1444435200, 0)
	got, expires, err := signTypeA(cfg, "video/standard/test.mp4", now)
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://example.com/video/standard/test.mp4?auth_key=1444435200-0-0-23bf85053008f5c0e791667a313e28ce" {
		t.Fatal(got)
	}
	if !expires.Equal(now.Add(300 * time.Second)) {
		t.Fatal(expires)
	}
	for _, key := range []string{"../secret", "a//b", "a\\b", "/file", ""} {
		if _, _, err := signTypeA(cfg, key, now); err == nil {
			t.Fatalf("accepted %q", key)
		}
	}
}

func TestDefaultSelectionSurvivesProviderChanges(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "default.db")), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	defer sqlDB.Close()
	if err = db.AutoMigrate(&configRow{}); err != nil {
		t.Fatal(err)
	}
	a := model.StorageProvider{ID: "tos", Type: "s3", Enabled: true, Endpoint: "https://s3.fixture.invalid", Bucket: "tos", AccessKeyID: "test", SecretAccessKey: "fixture-only"}
	b := a
	b.ID = "qiniu"
	b.Bucket = "qiniu"
	cfg := Config{Delivery: "s3", DefaultUpload: true}
	if _, err = saveProviderConfigs(db, []model.StorageProvider{a, b}, []providerConfigInput{{ProviderID: a.ID, Config: cfg}}); err != nil {
		t.Fatal(err)
	}
	if id, err := defaultUploadID(db); err != nil || id != a.ID {
		t.Fatalf("default %q %v", id, err)
	}
	a.Endpoint = "https://changed.invalid"
	loaded, err := loadConfig(db, a)
	if err != nil || loaded.TokenKey != "" {
		t.Fatal("connection scope failed")
	}
	if id, _ := defaultUploadID(db); id != a.ID {
		t.Fatal("default lost on connection change")
	}
	if _, err = saveProviderConfigs(db, []model.StorageProvider{a, b}, []providerConfigInput{{ProviderID: a.ID, Config: cfg}, {ProviderID: b.ID, Config: cfg}}); err == nil {
		t.Fatal("multiple defaults accepted")
	}
	b.Enabled = false
	if _, err = saveProviderConfigs(db, []model.StorageProvider{a, b}, []providerConfigInput{{ProviderID: b.ID, Config: cfg}}); err == nil {
		t.Fatal("disabled default accepted")
	}
	if id, _ := defaultUploadID(db); id != a.ID {
		t.Fatal("failed save changed default")
	}
}
