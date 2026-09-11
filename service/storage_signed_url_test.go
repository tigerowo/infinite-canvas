package service

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func TestPrivateStorageOwnership(t *testing.T) {
	object := model.StorageObject{ID:"private-owner-test",ObjectKey:"private-owner-test",CreatedBy: "owner"}
	if _,err:=repository.SaveStorageObject(object);err!=nil{t.Fatal(err)}
	if err := requireStorageObjectOwner(context.Background(), object); err == nil {
		t.Fatal("anonymous read allowed")
	}
	for _, item := range []struct {
		id      string
		role    model.UserRole
		allowed bool
	}{
		{"owner", "user", true}, {"other", "user", false}, {"admin", "admin", true}, {"owner", "guest", false},
	} {
		ctx := WithUser(context.Background(), model.AuthUser{ID: item.id, Role: item.role})
		if (requireStorageObjectOwner(ctx, object) == nil) != item.allowed {
			t.Fatalf("incorrect access for %s/%s", item.id, item.role)
		}
	}
	object.DeletedAt = "deleted"
	if err := requireStorageObjectOwner(WithUser(context.Background(), model.AuthUser{ID: "admin", Role: "admin"}), object); err == nil {
		t.Fatal("deleted object can still be signed")
	}
}

func TestPresignS3GetURL(t *testing.T) {
	provider := model.StorageProvider{Type: model.StorageProviderTypeS3, Endpoint: "https://s3.example.test", Region: "us-east-1", Bucket: "private", AccessKeyID: "AKIAEXAMPLE", SecretAccessKey: "secret"}
	signed, err := presignS3GetURL(provider, "folder/中文 file.mp4", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(signed)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	for _, key := range []string{"X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-SignedHeaders", "X-Amz-Signature"} {
		if query.Get(key) == "" {
			t.Fatalf("missing %s", key)
		}
	}
	if query.Get("X-Amz-Expires") != "300" {
		t.Fatalf("unexpected expiry: %s", query.Get("X-Amz-Expires"))
	}
	if !strings.Contains(parsed.Path, "/private/folder/") || !strings.Contains(parsed.Path, "file.mp4") {
		t.Fatalf("unexpected path: %s", parsed.Path)
	}
}

func TestPresignS3GetURLRejectsInvalidInputs(t *testing.T) {
	provider := model.StorageProvider{Type: model.StorageProviderTypeS3, Endpoint: "https://s3.example.test", Bucket: "private", AccessKeyID: "key", SecretAccessKey: "secret"}
	if _, err := presignS3GetURL(provider, "file", 6*time.Minute); err == nil {
		t.Fatal("expected expiry validation error")
	}
	if _, err := presignS3GetURL(provider, "", time.Minute); err == nil {
		t.Fatal("expected object key validation error")
	}
	provider.Type = model.StorageProviderTypeWebDAV
	if _, err := presignS3GetURL(provider, "file", time.Minute); err == nil {
		t.Fatal("expected incomplete S3 configuration error")
	}
}
