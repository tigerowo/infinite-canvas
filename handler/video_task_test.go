package handler

import "testing"

func TestParseVideoTaskPayloadReadsNestedRelativeVideoURL(t *testing.T) {
	payload := []byte(`{
		"model":"grok-imagine-video",
		"status":"done",
		"video":{"url":"/v1/videos/video_example/content"}
	}`)

	parsed := parseVideoTaskPayload(payload, "grok-imagine-video")
	if got, want := parsed.VideoURL, "/v1/videos/video_example/content"; got != want {
		t.Fatalf("VideoURL = %q, want %q", got, want)
	}
	if got, want := parsed.Status, "completed"; got != want {
		t.Fatalf("Status = %q, want %q", got, want)
	}
}
