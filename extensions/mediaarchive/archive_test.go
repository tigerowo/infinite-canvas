package mediaarchive

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
	"gorm.io/gorm"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestArchiveRetryIsolationAndRecovery(t *testing.T) {
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: ":memory:"}
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	if err := Register(gin.New().Group("/archive")); err != nil {
		t.Fatal(err)
	}
	provider := model.StorageProvider{ID: "fixture", Type: "s3", Endpoint: "https://s3.example", Bucket: "fixture", AccessKeyID: "fixture", SecretAccessKey: "fixture", Enabled: true}
	settings := model.Settings{Private: model.PrivateSetting{Storage: model.PrivateStorageSetting{Providers: []model.StorageProvider{provider}, AllowUserGlobalProvider: true}}}
	if _, err := repository.SaveSettings(settings, "fixture"); err != nil {
		t.Fatal(err)
	}
	client := service.SafeProxyHTTPClient()
	previous := client.Transport
	defer func() { client.Transport = previous }()
	var mu sync.Mutex
	gets, puts := 0, 0
	paths := map[string]bool{}
	client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == "PUT" {
			puts++
			paths[r.URL.Path] = true
		} else if r.Method == "GET" {
			gets++
		} else {
			return nil, errors.New("unexpected network method")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: io.NopCloser(bytes.NewBufferString("fixture"))}, nil
	})
	ctx := service.WithUser(context.Background(), model.AuthUser{ID: "a", Role: "admin"})
	var wg sync.WaitGroup
	results := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			saved, err := importRemote(ctx, db, client, "a", "https://source.example/result.png", "result.png")
			if err != nil {
				t.Error(err)
				return
			}
			results <- saved.StorageKey
		}()
	}
	wg.Wait()
	close(results)
	var identity string
	for key := range results {
		if identity != "" && key != identity {
			t.Fatal("duplicate identity")
		}
		identity = key
	}
	if identity == "" || gets != 1 || puts != 1 {
		t.Fatalf("network counts: GET=%d PUT=%d", gets, puts)
	}
	// A later request (including a lost response/reloaded browser) uses the durable source row.
	if _, err := importRemote(ctx, db, client, "a", "https://source.example/result.png", "another-name.png"); err != nil {
		t.Fatal(err)
	}
	if gets != 1 || puts != 1 {
		t.Fatal("repeated source downloaded/uploaded again")
	}
	otherCtx := service.WithUser(context.Background(), model.AuthUser{ID: "b", Role: "admin"})
	other, err := service.UploadStorageObject(otherCtx, "other.png", "image/png", []byte("fixture"))
	if err != nil || other.StorageKey == identity {
		t.Fatalf("owner isolation: %v", err)
	}
	// Recovery must match both the exact origin/path and the authenticated owner.
	router := gin.New()
	router.Use(func(c *gin.Context) {
		if owner := c.GetHeader("X-Fixture-User"); owner != "" {
			c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), model.AuthUser{ID: owner, Role: "user"}))
		}
	})
	if err := Register(router.Group("/archive")); err != nil {
		t.Fatal(err)
	}
	object, err := service.StorageObjectInfo(strings.TrimPrefix(identity, "server:"))
	if err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		owner, origin string
		status        int
		match         bool
	}{
		{"a", "https://s3.example/fixture", 200, true},
		{"b", "https://s3.example/fixture", 200, false},
		{"a", "https://evil.example/fixture", 200, false},
		{"", "https://s3.example/fixture", 401, false},
	} {
		request := httptest.NewRequest("POST", "/archive/resolve", strings.NewReader(`{"url":"`+fixture.origin+"/"+object.ObjectKey+`?X-Amz-Signature=expired"}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Fixture-User", fixture.owner)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != fixture.status || strings.Contains(recorder.Body.String(), identity) != fixture.match {
			t.Fatalf("resolve owner=%q origin=%q: %d %s", fixture.owner, fixture.origin, recorder.Code, recorder.Body.String())
		}
	}
	// Fail indexing after OSS has accepted bytes, then retry with a different filename.
	failed := false
	if err := db.Callback().Create().Before("gorm:create").Register("fixture_index_failure", func(tx *gorm.DB) {
		if tx.Statement.Table == "storage_objects" && !failed {
			failed = true
			tx.AddError(errors.New("fixture database failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	beforePaths := len(paths)
	_, err = service.UploadStorageObject(ctx, "first.png", "image/png", []byte("recovery"))
	if err == nil {
		t.Fatal("expected database failure")
	}
	recovered, err := service.UploadStorageObject(ctx, "retry.png", "image/png", []byte("recovery"))
	if err != nil || recovered.ID == "" || len(paths) != beforePaths+1 {
		t.Fatalf("recovery created another path: %v", err)
	}
	if err := db.Callback().Create().Remove("fixture_index_failure"); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{"file:///fixture", "https://user:password@example.com/file"} {
		if _, err := importRemote(ctx, db, client, "a", source, "bad"); err == nil {
			t.Fatal("accepted invalid source")
		}
	}
}

func TestSourceIdentityKeepsVariantsAndOwner(t *testing.T) {
	a := sourceIdentity("a", "https://s3.example/object?X-Amz-Signature=one&X-Amz-Date=old&variant=1")
	b := sourceIdentity("a", "https://s3.example/object?X-Amz-Signature=two&X-Amz-Date=new&variant=1")
	if a != b {
		t.Fatal("signature refresh changed identity")
	}
	if a == sourceIdentity("b", "https://s3.example/object?variant=1") || a == sourceIdentity("a", "https://s3.example/object?variant=2") {
		t.Fatal("owner/variant collision")
	}
	if strings.Contains(a, "example") {
		t.Fatal("persisted source URL")
	}
}
