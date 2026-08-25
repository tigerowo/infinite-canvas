package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestCancelUpstreamVideoTaskUsesArkDeleteEndpoint(t *testing.T) {
	channel := model.ModelChannel{Protocol: "volcengine", BaseURL: "https://ark.example.test/api/v3", APIKey: "test-token"}
	task := model.VideoTask{Model: "doubao-seedance-1-5-pro", UpstreamTaskID: "task/1", Status: "queued"}
	request, supported, err := newUpstreamVideoCancelRequest(context.Background(), task, channel)
	if err != nil || !supported {
		t.Fatalf("supported=%v err=%v", supported, err)
	}
	if request.Method != http.MethodDelete || request.URL.EscapedPath() != "/api/v3/contents/generations/tasks/task%2F1" {
		t.Fatalf("method=%q path=%q", request.Method, request.URL.EscapedPath())
	}
	if request.Header.Get("Authorization") != "Bearer test-token" {
		t.Fatalf("authorization=%q", request.Header.Get("Authorization"))
	}
}

func TestCancelUpstreamVideoTaskSkipsUnconfirmedProtocols(t *testing.T) {
	for _, protocol := range []string{"openai", "gemini", "http", "grok2api", "apimart", "kie", "mimo"} {
		request, supported, err := newUpstreamVideoCancelRequest(context.Background(), model.VideoTask{Model: "seedance-test", UpstreamTaskID: "task-1", Status: "queued"}, model.ModelChannel{Protocol: protocol, BaseURL: "https://example.test"})
		if request != nil || supported || err != nil {
			t.Fatalf("protocol=%s request=%v supported=%v err=%v", protocol, request, supported, err)
		}
	}
}

func TestCancelUpstreamVideoTaskSkipsRunningArkTask(t *testing.T) {
	request, supported, err := newUpstreamVideoCancelRequest(context.Background(), model.VideoTask{Model: "seedance-test", UpstreamTaskID: "task-1", Status: "running"}, model.ModelChannel{Protocol: "volcengine", BaseURL: "https://ark.example.test/api/v3"})
	if request != nil || supported || err != nil {
		t.Fatalf("request=%v supported=%v err=%v", request, supported, err)
	}
}
