package storageaccess

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestTypeBOfficialVector(t *testing.T) {
	// Tencent's published example, not a real credential.
	cfg := Config{CDNBaseURL: "https://www.example.com", TokenKey: "DvYmqE81E1F9R791H6lmht"}
	now := time.Date(2024, 7, 15, 7, 33, 50, 0, time.UTC)
	got, expires, err := signTypeB(cfg, "foo.jpg", now)
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://www.example.com/202407151533/d1f0b51c6894231fc12e054fcc7f0b3e/foo.jpg" {
		t.Fatalf("official vector mismatch: %s", got)
	}
	if !expires.Equal(time.Date(2024, 7, 15, 7, 38, 0, 0, time.UTC)) {
		t.Fatal("expiry must be based on signed minute, not signing second")
	}
	for _, key := range []string{"../secret", "a/../secret", "/file", "a\\b", ""} {
		if _, _, err := signTypeB(cfg, key, now); err == nil {
			t.Fatalf("accepted invalid path %q", key)
		}
	}
	got, _, err = signTypeB(cfg, "canvas/中文 +%.mp4", now)
	if err != nil || !strings.HasSuffix(got, "/canvas/%E4%B8%AD%E6%96%87%20%2B%25.mp4") {
		t.Fatal("object path was not escaped exactly once")
	}
}

func TestConfigValidationAndSecretRedaction(t *testing.T) {
	previous := Config{TokenKey: "fixture-secret"}
	cfg := Config{Delivery: "edgeone-b", CDNBaseURL: "https://cdn.example.com/", AllowedOrigins: []string{"https://canvas.example.com/", "https://canvas.example.com", "http://localhost:3000", ""}}
	got, err := validateConfig(cfg, previous)
	if err != nil {
		t.Fatal(err)
	}
	if got.TokenKey != previous.TokenKey || len(got.AllowedOrigins) != 2 {
		t.Fatal("secret preservation or origins normalization failed")
	}
	masked := redact(got)
	if masked.TokenKey != "" || !masked.HasTokenKey || got.TokenKey == "" {
		t.Fatal("redaction corrupted source or disclosed secret")
	}
	for _, origin := range []string{"*", "https://*.example.com", "https://example.com/path", "https://example.com?token=secret", "https://user:pass@example.com", "null"} {
		bad := cfg
		bad.AllowedOrigins = []string{origin}
		if _, err := validateConfig(bad, previous); err == nil {
			t.Fatalf("accepted origin %q", origin)
		}
	}
	for _, domain := range []string{"http://cdn.example.com", "https://cdn.example.com/path", "https://cdn.example.com?x=1", "https://user:pass@cdn.example.com"} {
		bad := cfg
		bad.CDNBaseURL = domain
		if _, err := validateConfig(bad, previous); err == nil {
			t.Fatalf("accepted CDN base %q", domain)
		}
	}
}

func TestRequiresAtLeastOneUsableOSS(t *testing.T) {
	p := model.StorageProvider{Type: "s3", Enabled: true, Endpoint: "https://s3.example.test", Bucket: "private", AccessKeyID: "test", SecretAccessKey: "test-secret"}
	if RequireOSS(nil) == nil {
		t.Fatal("accepted no OSS")
	}
	if RequireOSS([]model.StorageProvider{p, p}) != nil {
		t.Fatal("rejected multiple OSS")
	}
	for _, change := range []func(*model.StorageProvider){
		func(p *model.StorageProvider) { p.Enabled = false },
		func(p *model.StorageProvider) { p.SecretAccessKey = "" },
		func(p *model.StorageProvider) { p.Type = "webdav" },
		func(p *model.StorageProvider) { p.Endpoint = "s3.example.test" },
		func(p *model.StorageProvider) { p.CapacityExceeded = true },
	} {
		bad := p
		change(&bad)
		if RequireOSS([]model.StorageProvider{bad}) == nil {
			t.Fatal("accepted unusable OSS")
		}
		if RequireOSS([]model.StorageProvider{bad, p}) != nil {
			t.Fatal("rejected one usable OSS")
		}
	}
}

func TestStorageAccessRoundTripAndProviderIsolation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "access.db")), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	if err := db.AutoMigrate(&configRow{}); err != nil {
		t.Fatal(err)
	}
	p := model.StorageProvider{ID: "oss-1", Name: "test", Type: "s3", Endpoint: "https://s3.example.test", Bucket: "private"}
	settings := model.Settings{Private: model.PrivateSetting{Storage: model.PrivateStorageSetting{Providers: []model.StorageProvider{p}}}}
	router := gin.New()
	admin := router.Group("/api/extensions", func(c *gin.Context) {
		if c.GetHeader("Authorization") != "Bearer test-admin" {
			c.AbortWithStatus(401)
			return
		}
		c.Next()
	})
	registerHandlers(admin, db, func() (model.Settings, error) { return settings, nil })
	request := func(method, path, body, auth string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", auth)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	path := "/api/extensions/storage-access/oss-1"
	body := `{"delivery":"edgeone-b","cdnBaseUrl":"https://cdn.example.test","tokenKey":"fixture-secret","allowedOrigins":["https://canvas.example.test"]}`
	if got := request(http.MethodPut, path, body, ""); got.Code != 401 {
		t.Fatal("unauthenticated write was allowed")
	}
	got := request(http.MethodPut, path, body, "Bearer test-admin")
	if got.Code != 200 || strings.Contains(got.Body.String(), "fixture-secret") || got.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unsafe save response: %d", got.Code)
	}
	got = request(http.MethodPut, path, strings.Replace(body, "fixture-secret", "", 1), "Bearer test-admin")
	if got.Code != 200 {
		t.Fatal("masked round trip failed")
	}
	stored, err := loadConfig(db, p)
	if err != nil || stored.TokenKey != "fixture-secret" {
		t.Fatal("saved key was lost")
	}
	got = request(http.MethodGet, "/api/extensions/storage-access", "", "Bearer test-admin")
	if got.Code != 200 || strings.Contains(got.Body.String(), "fixture-secret") {
		t.Fatal("GET exposed key")
	}
	var payload struct {
		Data []providerView `json:"data"`
	}
	if err := json.Unmarshal(got.Body.Bytes(), &payload); err != nil || len(payload.Data) != 1 || !payload.Data[0].Config.HasTokenKey {
		t.Fatal("missing masked configuration")
	}
	p2 := model.StorageProvider{ID: "oss-2", Name: "second", Type: "s3", Endpoint: "https://s3.second.test", Bucket: "private-second"}
	settings.Private.Storage.Providers = append(settings.Private.Storage.Providers, p2)
	batchBody := `{"providers":[{"providerId":"oss-1","delivery":"edgeone-b","cdnBaseUrl":"https://cdn.example.test","tokenKey":"","allowedOrigins":["https://canvas.example.test"]},{"providerId":"oss-2","delivery":"s3","allowedOrigins":[],"tokenKey":""}]}`
	got = request(http.MethodPut, "/api/extensions/storage-access", batchBody, "Bearer test-admin")
	if got.Code != 200 || strings.Contains(got.Body.String(), "fixture-secret") {
		t.Fatalf("unsafe batch save response: %d", got.Code)
	}
	var batchPayload struct {
		Data []providerView `json:"data"`
	}
	if err := json.Unmarshal(got.Body.Bytes(), &batchPayload); err != nil || len(batchPayload.Data) != 2 || !batchPayload.Data[0].Config.HasTokenKey {
		t.Fatal("batch save did not return redacted provider configurations")
	}
	if got := request(http.MethodPut, strings.Replace(path, "oss-1", "missing", 1), body, "Bearer test-admin"); got.Code != 404 {
		t.Fatal("accepted an unknown provider")
	}
	settings.Private.Storage.Providers[0].PublicBaseURL = "https://public.example.test"
	if got := request(http.MethodPut, path, body, "Bearer test-admin"); got.Code != 400 {
		t.Fatal("accepted private CDN with public URL bypass")
	}
	p.Bucket = "another-bucket"
	changed, err := loadConfig(db, p)
	if err != nil || changed.Delivery != "s3" || changed.TokenKey != "" {
		t.Fatal("reused secret for different bucket")
	}
}
