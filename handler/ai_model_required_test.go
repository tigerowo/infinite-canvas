package handler

import (
	"bytes"
	"errors"
	"mime/multipart"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReadAIRequestRejectsEmptyModel(t *testing.T) {
	for _, body := range []string{`{}`, `{"model":""}`, `{"model":"  "}`} {
		r := httptest.NewRequest("POST", "/api/ai/videos", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if _, _, _, err := readAIRequest(r); !errors.Is(err, errMissingModel) {
			t.Fatalf("body %s: want missing model, got %v", body, err)
		}
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("model", "  ")
	_ = writer.Close()
	r := httptest.NewRequest("POST", "/api/ai/videos", &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	if _, _, _, err := readAIRequest(r); !errors.Is(err, errMissingModel) {
		t.Fatalf("multipart: want missing model, got %v", err)
	}
}
