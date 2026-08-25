package service

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func TestNormalizeVideoTaskStatusUsesCanonicalStates(t *testing.T) {
	cases := map[string]string{
		"pending": "queued", "processing": "running", "completed": "succeeded",
		"error": "failed", "canceled": "cancelled", "timeout": "timed_out",
	}
	for input, expected := range cases {
		if actual := NormalizeVideoTaskStatus(input); actual != expected {
			t.Fatalf("NormalizeVideoTaskStatus(%q)=%q，期望 %q", input, actual, expected)
		}
	}
}

func TestTerminalVideoTaskStates(t *testing.T) {
	for _, status := range []string{"succeeded", "failed", "cancelled", "timed_out"} {
		if !IsTerminalVideoTaskStatus(status) {
			t.Fatalf("%s 应为终态", status)
		}
	}
	for _, status := range []string{"queued", "running"} {
		if IsTerminalVideoTaskStatus(status) {
			t.Fatalf("%s 不应为终态", status)
		}
	}
}

func TestCancelledVideoTaskCannotBeOverwrittenByStalePoll(t *testing.T) {
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "video-task-cancel.db")
	createdAt := time.Now().UTC().Format(time.RFC3339Nano)
	task := model.VideoTask{ID: "cancel-race", UserID: "user-1", Status: "running", CreatedAt: createdAt, UpdatedAt: createdAt}
	if _, err := repository.SaveVideoTask(task); err != nil {
		t.Fatal(err)
	}
	cancelled, changed, err := CancelUserVideoTask("user-1", task.ID)
	if err != nil || !changed || cancelled.Status != "cancelled" {
		t.Fatalf("cancelled=%#v changed=%v err=%v", cancelled, changed, err)
	}
	if err := UpdateVideoTaskFromPoll(task, VideoTaskPollUpdate{Status: "succeeded", VideoURL: "https://example.test/video.mp4"}); err != nil {
		t.Fatal(err)
	}
	stored, found, err := GetUserVideoTask("user-1", task.ID)
	if err != nil || !found || stored.Status != "cancelled" || stored.VideoURL != "" {
		t.Fatalf("stored=%#v found=%v err=%v", stored, found, err)
	}
}
