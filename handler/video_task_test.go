package handler

import (
	"net/url"
	"testing"
)

func TestNormalizeRelativeVideoURL(t *testing.T) {
	requestURL, err := url.Parse("https://api.example.com/v1/videos/task-123")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		payload string
		want    string
	}{
		{
			name:    "nested relative video URL",
			payload: `{"status":"done","video":{"url":"/v1/videos/task-123/content"}}`,
			want:    `{"status":"done","video":{"url":"/v1/videos/task-123/content"},"video_url":"https://api.example.com/v1/videos/task-123/content"}`,
		},
		{
			name:    "absolute video URL remains unchanged",
			payload: `{"status":"done","video_url":"https://cdn.example.com/video.mp4"}`,
			want:    `{"status":"done","video_url":"https://cdn.example.com/video.mp4"}`,
		},
		{
			name:    "response without video URL remains unchanged",
			payload: `{"status":"processing","progress":20}`,
			want:    `{"status":"processing","progress":20}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := string(normalizeRelativeVideoURL([]byte(test.payload), requestURL)); got != test.want {
				t.Fatalf("normalizeRelativeVideoURL() = %s, want %s", got, test.want)
			}
		})
	}
}
