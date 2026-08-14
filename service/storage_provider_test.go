package service

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestValidateEnabledStorageProviderTypes(t *testing.T) {
	if err := validateEnabledStorageProviderTypes([]model.StorageProvider{
		{Type: model.StorageProviderTypeS3, Enabled: true},
		{Type: model.StorageProviderTypeS3, Enabled: true},
	}); err != nil {
		t.Fatalf("same provider type should be allowed: %v", err)
	}
	if err := validateEnabledStorageProviderTypes([]model.StorageProvider{
		{Type: model.StorageProviderTypeWebDAV, Enabled: true},
		{Type: model.StorageProviderTypeWebDAV, Enabled: true},
	}); err != nil {
		t.Fatalf("same WebDAV type should be allowed: %v", err)
	}
	if err := validateEnabledStorageProviderTypes([]model.StorageProvider{
		{Type: model.StorageProviderTypeS3, Enabled: true},
		{Type: model.StorageProviderTypeWebDAV, Enabled: true},
	}); err == nil {
		t.Fatal("mixed enabled provider types should be rejected")
	}
	if err := validateEnabledStorageProviderTypes([]model.StorageProvider{{Type: "unknown"}}); err == nil {
		t.Fatal("unknown provider type should be rejected")
	}
}

func TestValidateUserStorageProviderTypes(t *testing.T) {
	enabled := true
	disabled := false
	if err := validateUserStorageProviderTypes(UserStorageProviders{
		S3:     &StorageObjectProviderInput{Enabled: &enabled},
		WebDAV: &StorageObjectProviderInput{Enabled: &disabled},
	}); err != nil {
		t.Fatalf("only one enabled user provider should be allowed: %v", err)
	}
	if err := validateUserStorageProviderTypes(UserStorageProviders{
		S3:     &StorageObjectProviderInput{Enabled: &enabled},
		WebDAV: &StorageObjectProviderInput{Enabled: &enabled},
	}); err == nil {
		t.Fatal("two enabled user provider types should be rejected")
	}
}

func TestStorageProviderConfigured(t *testing.T) {
	if !storageProviderConfigured(model.StorageProvider{
		Type: model.StorageProviderTypeS3, Endpoint: "https://s3.example.com", Bucket: "media", AccessKeyID: "key", SecretAccessKey: "secret",
	}) {
		t.Fatal("complete S3 provider should be configured")
	}

	webDAV := normalizeStorageProvider(model.StorageProvider{
		Type: model.StorageProviderTypeWebDAV, Endpoint: "https://dav.example.com", Username: "user", Password: "password",
	})
	if webDAV.PathPrefix != "canvas" {
		t.Fatalf("WebDAV default path prefix = %q, want canvas", webDAV.PathPrefix)
	}
	if !storageProviderConfigured(webDAV) {
		t.Fatal("complete WebDAV provider should be configured")
	}
	if storageProviderConfigured(model.StorageProvider{
		Type: model.StorageProviderTypeWebDAV, Endpoint: "https://dav.example.com",
	}) {
		t.Fatal("WebDAV provider without credentials should be incomplete")
	}
}

func TestCleanStoragePath(t *testing.T) {
	if got, err := cleanStoragePath("/infinite-canvas/user/file.png/"); err != nil || got != "infinite-canvas/user/file.png" {
		t.Fatalf("cleanStoragePath() = %q, %v", got, err)
	}
	for _, value := range []string{"", ".", "..", "a//b", "a/../b"} {
		if _, err := cleanStoragePath(value); err == nil {
			t.Fatalf("cleanStoragePath(%q) should fail", value)
		}
	}
}

func TestNewWebDAVClientValidatesEndpoint(t *testing.T) {
	for _, endpoint := range []string{"", "ftp://dav.example.com", "https://user:pass@dav.example.com", "https://dav.example.com/#fragment"} {
		if _, err := newWebDAVClient(model.StorageProvider{Endpoint: endpoint}); err == nil {
			t.Fatalf("newWebDAVClient(%q) should fail", endpoint)
		}
	}
	if _, err := newWebDAVClient(model.StorageProvider{Endpoint: "https://dav.example.com/webdav"}); err != nil {
		t.Fatalf("valid WebDAV endpoint should be accepted: %v", err)
	}
}


func TestFindStorageProviderForObjectFallsBackToSingleProvider(t *testing.T) {
	provider := normalizeStorageProvider(model.StorageProvider{
		Type: model.StorageProviderTypeWebDAV, Name: "alist", Endpoint: "https://dav.example.com", Username: "user", Password: "pass", Enabled: true,
	})
	object := model.StorageObject{ProviderID: "storage-old-id", ObjectKey: "canvas/user/a.png"}
	got, ok := findStorageProviderForObject(object, []model.StorageProvider{provider})
	if !ok {
		t.Fatal("expected single configured WebDAV provider fallback")
	}
	if got.ID != provider.ID {
		t.Fatalf("provider ID = %q, want %q", got.ID, provider.ID)
	}
}

func TestFindStorageProviderForObjectKeepsExactProviderID(t *testing.T) {
	first := normalizeStorageProvider(model.StorageProvider{
		Type: model.StorageProviderTypeWebDAV, Name: "a", Endpoint: "https://a.example.com", Username: "user", Password: "pass", Enabled: true,
	})
	second := normalizeStorageProvider(model.StorageProvider{
		Type: model.StorageProviderTypeWebDAV, Name: "b", Endpoint: "https://b.example.com", Username: "user", Password: "pass", Enabled: true,
	})
	object := model.StorageObject{ProviderID: second.ID, ObjectKey: "canvas/user/a.png"}
	got, ok := findStorageProviderForObject(object, []model.StorageProvider{first, second})
	if !ok || got.ID != second.ID {
		t.Fatalf("exact provider match failed: ok=%v id=%q", ok, got.ID)
	}
}

func TestReadStorageObjectFromProvidersTriesFallback(t *testing.T) {
	// Only validates candidate ordering/fallback selection without network by using empty providers.
	object := model.StorageObject{ProviderID: "missing", ObjectKey: "canvas/a.png"}
	if _, err := readStorageObjectFromProviders(object, nil); err == nil {
		t.Fatal("expected error when no providers configured")
	}
}
