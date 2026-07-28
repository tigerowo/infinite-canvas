package handler

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestImageURLFromAIResponseParsesServerSentBase64Image(t *testing.T) {
	imageData := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00}
	encodedImage := base64.StdEncoding.EncodeToString(imageData)
	eventData, err := json.Marshal(map[string]any{
		"type":        "image_generation.partial_succeeded",
		"image_index": 0,
		"b64_json":    encodedImage,
	})
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("event: image_generation.partial_succeeded\r\ndata: " + string(eventData) + "\r\n\r\ndata: [DONE]\r\n\r\n")

	imageURL, mimeType, byteCount, err := imageURLFromAIResponse(payload, "text/event-stream; charset=utf-8")
	if err != nil {
		t.Fatal(err)
	}
	if imageURL != "data:image/png;base64,"+encodedImage {
		t.Fatalf("image url = %q", imageURL)
	}
	if mimeType != "image/png" {
		t.Fatalf("mime type = %q", mimeType)
	}
	if byteCount != int64(len(imageData)) {
		t.Fatalf("byte count = %d, want %d", byteCount, len(imageData))
	}
}

func TestImageURLFromAIResponseDetectsServerSentBodyWithoutContentType(t *testing.T) {
	payload := []byte("event: image_generation.partial_succeeded\ndata: {\"type\":\"image_generation.partial_succeeded\",\"url\":\"https://example.com/generated.png\"}\n\n")

	imageURL, _, _, err := imageURLFromAIResponse(payload, "application/octet-stream")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(imageURL, "/generated.png") {
		t.Fatalf("image url = %q", imageURL)
	}
}
