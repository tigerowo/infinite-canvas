package service

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/model"
)

// Opt-in check: only the newly created diagnostic object is written and deleted.
func TestS3LiveRoundTrip(t *testing.T) {
	databasePath := os.Getenv("EXT_S3_LIVE_DB")
	if databasePath == "" {
		t.Skip("set EXT_S3_LIVE_DB to explicitly test the configured TOS provider")
	}
	db, err := sql.Open("sqlite", "file:"+databasePath+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var raw []byte
	if err := db.QueryRow("SELECT value FROM settings WHERE key = ?", "private").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var settings model.PrivateSetting
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatal(err)
	}
	var provider model.StorageProvider
	for _, candidate := range settings.Storage.Providers {
		if candidate.Enabled && strings.Contains(candidate.Endpoint, ".volces.com") {
			provider = candidate
			break
		}
	}
	if provider.Bucket == "" {
		t.Fatal("no enabled TOS provider")
	}
	image, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	key := strings.Trim(provider.PathPrefix, "/") + "/diagnostics/" + uuid.NewString() + ".png"
	if err := putS3Object(provider, key, "image/png", image); err != nil {
		t.Fatalf("diagnostic upload failed: %v", err)
	}
	t.Cleanup(func() {
		if err := deleteS3Object(provider, key); err != nil {
			t.Errorf("diagnostic object cleanup failed: %v", err)
		}
	})
	stream, err := getS3ObjectStream(provider, key, "")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	got, err := io.ReadAll(stream.Body)
	if err != nil || !bytes.Equal(got, image) {
		t.Fatalf("uploaded image round trip mismatch: %v", err)
	}
	t.Log("TOS upload and byte-for-byte image read passed")
}
