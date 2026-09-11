package service

import (
	"github.com/tigerowo/infinite-canvas/model"
	"testing"
)

func TestArchivedVideoResponseIdentity(t *testing.T) {
	response := VideoTaskResponse(model.VideoTask{ID: "task", Status: "completed", VideoURL: "/api/files/object/content"})
	if response["storageKey"] != "server:object" {
		t.Fatalf("missing stable identity: %v", response)
	}
	response = VideoTaskResponse(model.VideoTask{ID: "task", Status: "processing", ErrorDetail: "视频已生成，保存到 OSS 失败，后台将重试：下载失败"})
	if response["archive_error"] == nil || response["status"] != "processing" {
		t.Fatalf("missing recoverable error: %v", response)
	}
}
