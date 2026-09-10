package storageaccess

import (
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestValidateProviderChangesPreservesReferencedProvider(t *testing.T) {
	previous := []model.StorageProvider{{
		ID: "oss-old", Name: "旧 OSS", Type: "s3", Endpoint: "https://s3.example.test", Region: "cn-east-1",
		Bucket: "old-bucket", AccessKeyID: "old-key", SecretAccessKey: "old-secret", Enabled: true,
	}}
	usage := func(ids []string) (map[string]int64, error) {
		if len(ids) != 1 || ids[0] != "oss-old" {
			t.Fatalf("unexpected provider usage query: %#v", ids)
		}
		return map[string]int64{"oss-old": 1}, nil
	}

	if err := validateProviderChanges(previous, nil, usage); err == nil {
		t.Fatal("allowed deleting a provider still referenced by an object")
	} else if !strings.Contains(err.Error(), "新增新的 OSS") {
		t.Fatalf("unexpected deletion error: %v", err)
	}

	stopped := previous[0]
	stopped.Enabled = false
	if err := validateProviderChanges(previous, []model.StorageProvider{stopped}, usage); err != nil {
		t.Fatalf("rejected disabling an unchanged provider: %v", err)
	}

	newProvider := model.StorageProvider{ID: "oss-new", Name: "新 OSS", Type: "s3", Endpoint: "https://s3.new.test", Bucket: "new-bucket", Enabled: true}
	if err := validateProviderChanges(previous, []model.StorageProvider{stopped, newProvider}, usage); err != nil {
		t.Fatalf("rejected add-new-disable-old migration: %v", err)
	}

	changed := previous[0]
	changed.Endpoint = "https://s3.changed.test"
	if err := validateProviderChanges(previous, []model.StorageProvider{changed}, usage); err == nil {
		t.Fatal("allowed repointing a provider still referenced by an object")
	}
}

func TestProviderConnectionKeyIncludesCredentials(t *testing.T) {
	base := model.StorageProvider{Type: "s3", Endpoint: "https://s3.example.test", Region: "auto", Bucket: "bucket", AccessKeyID: "key", SecretAccessKey: "secret"}
	changed := base
	changed.SecretAccessKey = "rotated-secret"
	if providerConnectionKey(base) == providerConnectionKey(changed) {
		t.Fatal("credential changes were not treated as provider connection changes")
	}
}

func TestProviderConnectionKeyAllowsPublicBaseURLChanges(t *testing.T) {
	base := model.StorageProvider{Type: "s3", Endpoint: "https://s3.example.test", Region: "auto", Bucket: "bucket", AccessKeyID: "key", SecretAccessKey: "secret", PublicBaseURL: "https://old.example.test"}
	changed := base
	changed.PublicBaseURL = "https://cdn.example.test"
	if providerConnectionKey(base) != providerConnectionKey(changed) {
		t.Fatal("public access URL changes were treated as connection changes")
	}
}
