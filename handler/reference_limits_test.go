package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestAPIMartReferenceArraysKeepAllInputs(t *testing.T) {
	urls := make([]string, 50)
	for index := range urls {
		urls[index] = fmt.Sprintf("https://media.example/%d.png", index)
	}
	payload := map[string]any{}
	setAPIMartImageReference(payload, apimartInputConfig{imageRefField: "image_urls", imageRefKind: "array"}, "input_reference[]", urls)
	if len(normalizeAPIMartReferenceStringList(payload["image_urls"])) != len(urls) {
		t.Fatal("image references truncated")
	}
	payload["element_list"] = []any{}
	for index := 0; index < 5; index++ {
		payload["element_list"] = append(payload["element_list"].([]any), map[string]any{"name": "fixture", "element_input_urls": urls})
	}
	normalizeAPIMartKlingV3ElementList(payload, model.ModelChannel{})
	elements := payload["element_list"].([]map[string]any)
	if len(elements) != 5 {
		t.Fatal("elements truncated")
	}
	for _, element := range elements {
		if len(normalizeAPIMartReferenceStringList(element["element_input_urls"])) != 50 {
			t.Fatal("element resources truncated")
		}
	}
	if err := validateAPIMartVideoRequiredInputs(map[string]any{"image_urls": urls}, "happyhorse-1-1"); err != nil {
		t.Fatal(err)
	}
}

func TestReferenceAudioUploadExceedsFormerBodyAndAudioLimits(t *testing.T) {
	previous := config.Cfg
	t.Cleanup(func() { config.Cfg = previous })
	config.Cfg = config.Config{PublicBaseURL: "https://fixture.invalid", StorageDriver: "sqlite", DatabaseDSN: filepath.Join(t.TempDir(), "fixture.db")}
	reader, writer := io.Pipe()
	form := multipart.NewWriter(writer)
	done := make(chan error, 1)
	const size = 81 << 20
	go func() {
		part, err := form.CreateFormFile("file", "large.wav")
		if err == nil {
			_, err = io.CopyN(part, &repeatingBytes{}, size)
		}
		if err == nil {
			err = form.Close()
		}
		writer.CloseWithError(err)
		done <- err
	}()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/media/references", reader)
	request.Header.Set("Content-Type", form.FormDataContentType())
	response := httptest.NewRecorder()
	UploadReferenceMedia(response, request)
	reader.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	var result struct {
		Code int                        `json:"code"`
		Data referenceMediaUploadResult `json:"data"`
		Msg  string                     `json:"msg"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Code != 0 || result.Data.Bytes != size {
		t.Fatalf("upload rejected: %s", response.Body.String())
	}
}

type repeatingBytes struct{}

func (*repeatingBytes) Read(buffer []byte) (int, error) {
	clear(buffer)
	return len(buffer), nil
}
