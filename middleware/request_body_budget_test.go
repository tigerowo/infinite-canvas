package middleware

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestAPIRequestBodyLimitsByPath(t *testing.T) {
	tests := map[string]int64{
		"/api/auth/login":              defaultAPIRequestBodyLimit,
		"/api/v1/canvas/projects/sync": largeJSONRequestBodyLimit,
		"/api/v1/images/generations":   aiRequestBodyLimit,
		"/api/v1/canvas/audio-tasks":   aiRequestBodyLimit,
		"/api/anonymous/files":         anonymousUploadBodyLimit,
		"/api/v1/media/references":     referenceUploadBodyLimit,
		"/api/v1/files":                storageUploadBodyLimit,
	}
	for path, want := range tests {
		if got := apiRequestBodyLimit(path); got != want {
			t.Fatalf("apiRequestBodyLimit(%q)=%d want=%d", path, got, want)
		}
	}
}

func TestAPIRequestBodyBudgetRejectsKnownOversize(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(APIRequestBodyBudget)
	router.POST("/api/test", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	request := httptest.NewRequest(http.MethodPost, "/api/test", bytes.NewReader(make([]byte, defaultAPIRequestBodyLimit+1)))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestAPIRequestBodyBudgetStopsUnknownLengthBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(APIRequestBodyBudget)
	router.POST("/api/test", func(c *gin.Context) {
		if _, err := io.ReadAll(c.Request.Body); err != nil {
			c.Status(http.StatusRequestEntityTooLarge)
			return
		}
		c.Status(http.StatusNoContent)
	})
	request := httptest.NewRequest(http.MethodPost, "/api/test", bytes.NewReader(make([]byte, defaultAPIRequestBodyLimit+1)))
	request.ContentLength = -1
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d", response.Code)
	}
}
