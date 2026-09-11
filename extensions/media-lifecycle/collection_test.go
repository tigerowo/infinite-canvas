package medialifecycle

import (
	"encoding/json"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func assetPayload(t *testing.T, raw, assets string) string {
	t.Helper()
	snapshot, err := AssetCollectionSnapshot(raw)
	if err != nil {
		t.Fatal(err)
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal(snapshot, &data); err != nil {
		t.Fatal(err)
	}
	data["assets"] = json.RawMessage(assets)
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestAssetCollectionRejectsStaleOverwriteAndPreservesSettings(t *testing.T) {
	db := testDB(t)
	if err := db.Create(&model.UserConfig{UserID: "a", ModelConfig: `{"model":"preserved"}`}).Error; err != nil {
		t.Fatal(err)
	}
	first := assetPayload(t, "", `[{"id":"first","kind":"text"}]`)
	stale := assetPayload(t, "", `[{"id":"second","kind":"text"}]`)
	if err := SaveConfigField(db, "a", "asset_data", first, 1); err != nil {
		t.Fatal(err)
	}
	if err := SaveConfigField(db, "a", "asset_data", stale, 1); err == nil {
		t.Fatal("stale collection erased another browser's asset")
	}
	var config model.UserConfig
	db.First(&config, "user_id = ?", "a")
	if config.ModelConfig != `{"model":"preserved"}` {
		t.Fatal("configuration changed")
	}
	merged := assetPayload(t, config.AssetData, `[{"id":"first","kind":"text"},{"id":"second","kind":"text"}]`)
	if err := SaveConfigField(db, "a", "asset_data", merged, 1); err != nil {
		t.Fatal(err)
	}
	db.First(&config, "user_id = ?", "a")
	deleted := assetPayload(t, config.AssetData, `[]`)
	if err := SaveConfigField(db, "a", "asset_data", deleted, 1); err != nil {
		t.Fatal(err)
	}
	if err := SaveConfigField(db, "a", "asset_data", merged, 1); err == nil {
		t.Fatal("stale save resurrected deleted assets")
	}
}

func TestAssetCollectionRejectsInvalidOrUnversionedPayload(t *testing.T) {
	for _, raw := range []string{`{}`, `{"assets":{}}`, `{"assets":[{"kind":"text"}]}`, `{"assets":[{"id":"a"},{"id":"a"}]}`} {
		if _, err := AssetCollectionSnapshot(raw); err == nil {
			t.Fatal(raw)
		}
	}
	if _, err := compareAssetCollection("", `{"assets":[]}`); err == nil {
		t.Fatal("unversioned writer accepted")
	}
}
