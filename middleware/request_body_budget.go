package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/handler"
)

const (
	defaultAPIRequestBodyLimit = int64(2 * 1024 * 1024)
	largeJSONRequestBodyLimit  = int64(64 * 1024 * 1024)
	aiRequestBodyLimit         = int64(128 * 1024 * 1024)
	anonymousUploadBodyLimit   = int64(129 * 1024 * 1024)
	referenceUploadBodyLimit   = int64(81 * 1024 * 1024)
	storageUploadBodyLimit     = int64(257 * 1024 * 1024)
)

func APIRequestBodyBudget(c *gin.Context) {
	if c.Request.Method != http.MethodPost && c.Request.Method != http.MethodPut && c.Request.Method != http.MethodPatch {
		c.Next()
		return
	}
	limit := apiRequestBodyLimit(c.Request.URL.Path)
	if c.Request.ContentLength > limit {
		handler.FailWithStatus(c.Writer, http.StatusRequestEntityTooLarge, "请求内容过大")
		c.Abort()
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
	c.Next()
}

func apiRequestBodyLimit(path string) int64 {
	switch {
	case path == "/api/anonymous/files":
		return anonymousUploadBodyLimit
	case path == "/api/v1/files":
		return storageUploadBodyLimit
	case path == "/api/v1/media/references":
		return referenceUploadBodyLimit
	case strings.HasPrefix(path, "/api/v1/images/"),
		path == "/api/v1/responses",
		path == "/api/v1/chat/completions",
		path == "/api/v1/audio/speech",
		path == "/api/v1/videos",
		path == "/api/v1/canvas/image-tasks",
		path == "/api/v1/canvas/audio-tasks":
		return aiRequestBodyLimit
	case strings.HasPrefix(path, "/api/v1/canvas/projects"),
		strings.HasPrefix(path, "/api/v1/user-data/"),
		strings.HasPrefix(path, "/api/v1/generation-logs/"):
		return largeJSONRequestBodyLimit
	default:
		return defaultAPIRequestBodyLimit
	}
}
