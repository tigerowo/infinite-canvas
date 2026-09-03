package router_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/router"
)

type migrationAPIResponse struct {
	Code int             `json:"code"`
	Data json.RawMessage `json:"data"`
	Msg  string          `json:"msg"`
}

func TestProviderMigrationHTTPRehearsal(t *testing.T) {
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "migration-rehearsal.db")
	config.Cfg.JWTSecret = "migration-test-" + uuid.NewString()
	config.Cfg.JWTExpireHours = 1
	server := httptest.NewServer(router.New())
	defer server.Close()

	username := "migration-" + uuid.NewString()
	password := "test-" + uuid.NewString()
	registration := migrationRequest(t, server, http.MethodPost, "/api/auth/register", "", map[string]any{"username": username, "password": password})
	var session struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(registration.Data, &session); err != nil || session.Token == "" {
		t.Fatalf("registration response invalid: %v", err)
	}

	legacySecret := "legacy-" + uuid.NewString()
	legacyConfig := map[string]any{
		"apiKey":         legacySecret,
		"imageChannelId": "legacy-main",
		"localChannels": []map[string]any{{
			"id": "legacy-main", "protocol": "openai", "name": "迁移演练渠道",
			"baseUrl": "https://api.example.test/v1", "apiKey": legacySecret, "models": []string{"test-model"},
		}},
	}
	migrationRequest(t, server, http.MethodPost, "/api/v1/user-config/model", session.Token, map[string]any{"config": legacyConfig})
	preview := migrationRequest(t, server, http.MethodGet, "/api/v1/providers/migration-preview", session.Token, nil)
	if bytes.Contains(preview.Data, []byte(legacySecret)) {
		t.Fatal("migration preview exposed legacy secret")
	}
	var previewData struct {
		Total            int `json:"total"`
		Importable       int `json:"importable"`
		PlaintextSecrets int `json:"plaintextSecrets"`
	}
	if err := json.Unmarshal(preview.Data, &previewData); err != nil || previewData.Total != 1 || previewData.Importable != 1 || previewData.PlaintextSecrets != 2 {
		t.Fatalf("preview=%#v error=%v", previewData, err)
	}

	result := migrationRequest(t, server, http.MethodPost, "/api/v1/providers/migrate", session.Token, map[string]any{"cleanupLegacy": true})
	if bytes.Contains(result.Data, []byte(legacySecret)) {
		t.Fatal("migration result exposed legacy secret")
	}
	var resultData struct {
		ImportedCount  int `json:"importedCount"`
		CleanedSecrets int `json:"cleanedSecrets"`
		Providers      []struct {
			HasAPIKey bool `json:"hasApiKey"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(result.Data, &resultData); err != nil || resultData.ImportedCount != 1 || resultData.CleanedSecrets != 2 || len(resultData.Providers) != 1 || !resultData.Providers[0].HasAPIKey {
		t.Fatalf("result=%#v error=%v", resultData, err)
	}

	stored := migrationRequest(t, server, http.MethodGet, "/api/v1/user-config", session.Token, nil)
	if bytes.Contains(stored.Data, []byte(legacySecret)) || !bytes.Contains(stored.Data, []byte(`"managed":true`)) {
		t.Fatal("cleaned user config did not replace the plaintext legacy channel")
	}
	secondPreview := migrationRequest(t, server, http.MethodGet, "/api/v1/providers/migration-preview", session.Token, nil)
	var secondPreviewData struct {
		PlaintextSecrets int `json:"plaintextSecrets"`
		Reusable         int `json:"reusable"`
	}
	if err := json.Unmarshal(secondPreview.Data, &secondPreviewData); err != nil || secondPreviewData.PlaintextSecrets != 0 || secondPreviewData.Reusable != 0 {
		t.Fatalf("second preview=%#v error=%v", secondPreviewData, err)
	}
}

func migrationRequest(t *testing.T, server *httptest.Server, method string, path string, token string, payload any) migrationAPIResponse {
	t.Helper()
	var body *bytes.Reader
	if payload == nil {
		body = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, server.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result migrationAPIResponse
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode >= http.StatusBadRequest || result.Code != 0 {
		t.Fatalf("%s %s failed: status=%d code=%d msg=%s", method, path, response.StatusCode, result.Code, strings.TrimSpace(result.Msg))
	}
	return result
}
