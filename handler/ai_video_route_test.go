package handler

import "testing"

func TestAgnesVideoQueryIDAcceptsProviderTaskIDs(t *testing.T) {
	tests := []struct {
		name string
		path string
		want string
	}{
		{name: "raw task id", path: "/videos/task_abc123", want: "task_abc123"},
		{name: "video id", path: "/videos/video_abc123", want: "video_abc123"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := agnesVideoQueryID("agnes-video-v2.0", tt.path)
			if !ok || got != tt.want {
				t.Fatalf("agnesVideoQueryID() = %q, %v; want %q, true", got, ok, tt.want)
			}
		})
	}
}

func TestAgnesVideoQueryIDRejectsOtherIDsAndContent(t *testing.T) {
	for _, path := range []string{"/videos/client_video_task_abc", "/videos/task_abc/content", "/videos/abc"} {
		if got, ok := agnesVideoQueryID("agnes-video-v2.0", path); ok || got != "" {
			t.Fatalf("agnesVideoQueryID(%q) = %q, %v; want empty, false", path, got, ok)
		}
	}
}
