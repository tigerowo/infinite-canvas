package handler

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestIsGrok2APIFamilyChannel(t *testing.T) {
	cases := []struct {
		name    string
		channel model.ModelChannel
		want    bool
	}{
		{name: "protocol grok2api", channel: model.ModelChannel{Protocol: "grok2api", BaseURL: "https://example.com"}, want: true},
		{name: "protocol xai", channel: model.ModelChannel{Protocol: "xai", BaseURL: "https://api.x.ai"}, want: true},
		{name: "base url grok2api", channel: model.ModelChannel{Protocol: "openai", BaseURL: "https://grok2api.example.com"}, want: true},
		{name: "base url xai", channel: model.ModelChannel{Protocol: "openai", BaseURL: "https://api.x.ai/v1"}, want: true},
		{name: "openai with grok video model", channel: model.ModelChannel{Protocol: "openai", BaseURL: "https://proxy.example.com"}, want: true},
		{name: "openai text model", channel: model.ModelChannel{Protocol: "openai", BaseURL: "https://example.com"}, want: false},
	}
	for _, item := range cases {
		modelName := "grok-imagine-video-1.5"
		if item.name == "openai text model" {
			modelName = "gpt-4o"
		}
		if got := isGrok2APIFamilyChannel(item.channel, modelName); got != item.want {
			t.Fatalf("%s: isGrok2APIFamilyChannel = %v, want %v", item.name, got, item.want)
		}
	}
}

func TestResolveAIProxyPathGrok2APIVideos(t *testing.T) {
	channel := model.ModelChannel{Protocol: "grok2api", BaseURL: "https://grok2api.example.com"}
	if got := resolveAIProxyPath(channel, "grok-imagine-video-1.5", "/videos"); got != "/videos/generations" {
		t.Fatalf("resolveAIProxyPath(/videos) = %q, want /videos/generations", got)
	}
	openaiChannel := model.ModelChannel{Protocol: "openai", BaseURL: "https://proxy.example.com/v1"}
	if got := resolveAIProxyPath(openaiChannel, "grok-imagine-video-1.5", "/videos"); got != "/videos/generations" {
		t.Fatalf("openai channel resolveAIProxyPath(/videos) = %q, want /videos/generations", got)
	}
	for _, path := range []string{
		"/images/generations",
		"/images/edits",
		"/videos/video_123",
		"/videos/video_123/content",
		"/audio/speech",
		"/tts",
	} {
		if got := resolveAIProxyPath(channel, "grok-imagine-video-1.5", path); got != path {
			t.Fatalf("resolveAIProxyPath(%q) = %q, want %q", path, got, path)
		}
	}
}

func TestNormalizeGrok2APIImageGenerationBody(t *testing.T) {
	body := []byte(`{"model":"grok-imagine-image-2.0","prompt":"a cat","n":2,"aspect_ratio":"16:9","resolution":"2k","response_format":"b64_json"}`)
	encoded, contentType, err := normalizeGrok2APIImageBody(body, "application/json", "grok-imagine-image-2.0", "/images/generations")
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "application/json" {
		t.Fatalf("content type = %q", contentType)
	}
	payload := testGrok2APIRecord(t, encoded)
	for key, want := range map[string]any{"model": "grok-imagine-image-2.0", "prompt": "a cat", "n": float64(2), "aspect_ratio": "16:9", "resolution": "2k", "response_format": "b64_json"} {
		if got := payload[key]; got != want {
			t.Fatalf("payload[%q] = %#v, want %#v", key, got, want)
		}
	}
	for _, key := range []string{"size", "image", "images", "reference_images"} {
		if _, ok := payload[key]; ok {
			t.Fatalf("unexpected payload key %q", key)
		}
	}
}

func TestNormalizeGrok2APIImageEditBody(t *testing.T) {
	body := []byte(`{"model":"grok-imagine-image-edit","prompt":"make it purple","size":"1024x1024","images":[{"url":"https://example.com/a.png"}]}`)
	encoded, _, err := normalizeGrok2APIImageBody(body, "application/json", "grok-imagine-image-edit", "/images/edits")
	if err != nil {
		t.Fatal(err)
	}
	payload := testGrok2APIRecord(t, encoded)
	image := testGrok2APIRecord(t, payload["image"])
	if image["url"] != "https://example.com/a.png" {
		t.Fatalf("image = %#v", image)
	}
	if payload["size"] != "1024x1024" {
		t.Fatalf("size = %#v", payload["size"])
	}
	if _, ok := payload["images"]; ok {
		t.Fatal("legacy images key should be removed")
	}
	if _, ok := payload["reference_images"]; ok {
		t.Fatal("single edit image should not become reference_images")
	}
}

func TestNormalizeGrok2APITextVideoBody(t *testing.T) {
	body := []byte(`{"model":"grok-imagine-video-1.5","prompt":"ocean","duration":8,"aspect_ratio":"16:9","resolution":"720p","n":1}`)
	encoded, _, err := normalizeGrok2APIVideoBody(body, "application/json", "grok-imagine-video-1.5")
	if err != nil {
		t.Fatal(err)
	}
	payload := testGrok2APIRecord(t, encoded)
	for key, want := range map[string]any{"model": "grok-imagine-video-1.5", "prompt": "ocean", "duration": float64(8), "aspect_ratio": "16:9", "resolution": "720p", "n": float64(1)} {
		if got := payload[key]; got != want {
			t.Fatalf("payload[%q] = %#v, want %#v", key, got, want)
		}
	}
	for _, key := range []string{"image", "reference_images"} {
		if _, ok := payload[key]; ok {
			t.Fatalf("text video should not include %q", key)
		}
	}
}

func TestNormalizeGrok2APIFirstFrameVideoBody(t *testing.T) {
	body := []byte(`{"model":"grok-imagine-video","prompt":"move","image":"https://example.com/first.png","duration":6}`)
	encoded, _, err := normalizeGrok2APIVideoBody(body, "application/json", "grok-imagine-video")
	if err != nil {
		t.Fatal(err)
	}
	payload := testGrok2APIRecord(t, encoded)
	image := testGrok2APIRecord(t, payload["image"])
	if image["url"] != "https://example.com/first.png" {
		t.Fatalf("image = %#v", image)
	}
	if _, ok := payload["reference_images"]; ok {
		t.Fatal("single first frame should not become reference_images")
	}
}

func TestNormalizeGrok2APIMultiReferenceVideoBody(t *testing.T) {
	body := []byte(`{"model":"grok-imagine-video","prompt":"move","images":[{"url":"https://example.com/a.png"},{"url":"https://example.com/b.png"}]}`)
	encoded, _, err := normalizeGrok2APIVideoBody(body, "application/json", "grok-imagine-video")
	if err != nil {
		t.Fatal(err)
	}
	payload := testGrok2APIRecord(t, encoded)
	items, ok := payload["reference_images"].([]any)
	if !ok || len(items) != 2 {
		t.Fatalf("reference_images = %#v", payload["reference_images"])
	}
	if testGrok2APIRecord(t, items[0])["url"] != "https://example.com/a.png" || testGrok2APIRecord(t, items[1])["url"] != "https://example.com/b.png" {
		t.Fatalf("reference_images = %#v", items)
	}
	if _, ok := payload["image"]; ok {
		t.Fatal("multi reference video should not keep image key")
	}
}

func TestNormalizeGrok2APITTSNativeBody(t *testing.T) {
	body := []byte(`{"model":"grok-voice-latest","input":"hello","voice":"alloy","speed":1.2,"response_format":"mp3"}`)
	encoded, _, err := normalizeGrok2APITTSBody(body, "application/json", "grok-voice-latest")
	if err != nil {
		t.Fatal(err)
	}
	payload := testGrok2APIRecord(t, encoded)
	for key, want := range map[string]any{"model": "grok-voice-latest", "text": "hello", "voice_id": "alloy", "language": "en", "speed": 1.2} {
		if got := payload[key]; got != want {
			t.Fatalf("payload[%q] = %#v, want %#v", key, got, want)
		}
	}
	for _, key := range []string{"input", "voice", "response_format"} {
		if _, ok := payload[key]; ok {
			t.Fatalf("unexpected payload key %q", key)
		}
	}
}

func TestGrok2APIAudioSpeechKeepsOpenAIFields(t *testing.T) {
	body := []byte(`{"model":"grok-voice-latest","input":"hello","voice":"alloy","response_format":"mp3","speed":1.2}`)
	encoded, contentType, err := normalizeGrok2APIRequestBody(body, "application/json", "grok-voice-latest", "/audio/speech")
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != string(body) || contentType != "application/json" {
		t.Fatalf("audio/speech should pass through unchanged, got %s (%s)", encoded, contentType)
	}
}

func testGrok2APIRecord(t *testing.T, value any) map[string]any {
	t.Helper()
	switch typed := value.(type) {
	case []byte:
		var record map[string]any
		if err := json.Unmarshal(typed, &record); err != nil {
			t.Fatalf("decode %s: %v", typed, err)
		}
		return record
	case map[string]any:
		return typed
	default:
		t.Fatalf("expected object, got %#v", value)
		return nil
	}
}

func testGrok2APIMultipartForm(t *testing.T, fields map[string]string) (string, []byte) {
	t.Helper()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return writer.FormDataContentType(), buffer.Bytes()
}

func TestGrok2APIMultipartVideoBody(t *testing.T) {
	contentType, body := testGrok2APIMultipartForm(t, map[string]string{
		"model":           "grok-imagine-video",
		"prompt":          "move",
		"image_urls":      `["https://example.com/a.png","https://example.com/b.png"]`,
		"aspect_ratio":    "16:9",
		"duration":        "8",
		"response_format": "url",
	})
	encoded, _, err := normalizeGrok2APIVideoBody(body, contentType, "grok-imagine-video")
	if err != nil {
		t.Fatal(err)
	}
	payload := testGrok2APIRecord(t, encoded)
	items, ok := payload["reference_images"].([]any)
	if !ok || len(items) != 2 {
		t.Fatalf("reference_images = %#v", payload["reference_images"])
	}
	if duration, ok := payload["duration"]; !ok || !strings.Contains(strings.TrimSpace(toStringSafe(duration)), "8") {
		t.Fatalf("duration = %#v", duration)
	}
}
