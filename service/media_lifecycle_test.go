package service

import (
	medialifecycle "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"
	"github.com/tigerowo/infinite-canvas/model"
	"testing"
)

func TestLifecycleDeleteRequiresAnImmutableStorageLocation(t *testing.T) {
	provider := model.StorageProvider{ID: "s3", Type: model.StorageProviderTypeS3, Endpoint: "https://original.invalid", Bucket: "bucket", PathPrefix: "canvas"}
	object := model.StorageObject{ID: "object", ProviderID: provider.ID, Bucket: provider.Bucket, ObjectKey: "canvas/object", CreatedBy: "owner"}
	file := medialifecycle.File{ID: object.ID, Scope: medialifecycle.StorageScope(provider, "")}
	if err := validateLifecycleLocation(file, object, provider); err != nil {
		t.Fatal(err)
	}
	for _, change := range []string{"endpoint", "prefix", "bucket", "provider", "legacy", "object"} {
		t.Run(change, func(t *testing.T) {
			p, f := provider, file
			switch change {
			case "endpoint":
				p.Endpoint = "https://replacement.invalid"
			case "prefix":
				p.PathPrefix = "another-app"
			case "bucket":
				p.Bucket = "other"
			case "provider":
				p.ID = "replacement"
			case "legacy":
				f.Scope = medialifecycle.Key("legacy", object.ProviderID, object.Bucket)
			case "object":
				f.ID = "different-object"
			}
			err := validateLifecycleLocation(f, object, p)
			if change == "legacy" {
				if err != nil { t.Fatalf("legacy scope with matching immutable object should be accepted: %v", err) }
			} else if err == nil { t.Fatal("unverified deletion allowed") }
		})
	}
}

func TestLifecycleDeleteAcceptsWebDAVLocation(t *testing.T) {
	provider := model.StorageProvider{ID: "dav", Type: model.StorageProviderTypeWebDAV, Endpoint: "https://dav.example.test", PathPrefix: "canvas", Username: "user", Password: "secret"}
	object := model.StorageObject{ID: "object", ProviderID: provider.ID, ObjectKey: "canvas/object.mp4", CreatedBy: "owner"}
	file := medialifecycle.File{ID: object.ID, Scope: medialifecycle.StorageScope(provider, object.CreatedBy)}
	if err := validateLifecycleLocation(file, object, provider); err != nil {
		t.Fatalf("webdav lifecycle location should be accepted: %v", err)
	}
}
