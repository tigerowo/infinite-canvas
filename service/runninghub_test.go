package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestParseRunningHubReference(t *testing.T) {
	for _, value := range []string{"app:2058517022748798977", "workflow:2058824859437850625"} {
		if _, _, ok := ParseRunningHubReference(value); !ok {
			t.Fatalf("reference %q should be valid", value)
		}
	}
	for _, value := range []string{"2058517022748798977", "model:any", "workflow:abc", "app:1"} {
		if _, _, ok := ParseRunningHubReference(value); ok {
			t.Fatalf("reference %q should be invalid", value)
		}
	}
}

func TestRunningHubAccountCheckUsesOfficialAuthShape(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/uc/openapi/accountStatus" || r.Header.Get("Authorization") != "Bearer test-key" || r.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("unexpected request: path=%s auth=%q content-type=%q", r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Content-Type"))
		}
		var payload map[string]string
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload["apikey"] != "test-key" {
			t.Fatalf("payload=%#v error=%v", payload, err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"code":0,"msg":"success","data":{"remainCoins":"1"}}`)
	}))
	defer server.Close()
	channel := model.ModelChannel{Protocol: "runninghub", BaseURL: server.URL, APIKey: "test-key", Timeout: 5, Enabled: true}
	if err := TestRunningHubChannel(context.Background(), channel); err != nil {
		t.Fatal(err)
	}
}

func TestRunningHubResponseUsesAggregateReadBudget(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Repeat("x", 1024))
	}))
	defer server.Close()
	channel := model.ModelChannel{BaseURL: server.URL, APIKey: "test-key", Timeout: 5, Enabled: true}
	budget := newUpstreamReadBudget(context.Background(), "RunningHub 测试", upstreamReadLimits{MaxRequests: 1, MaxBytes: 32, Deadline: runningHubDeadline})
	defer budget.Close()
	_, err := doRunningHubJSON(channel, budget, "/large", map[string]string{"ok": "yes"})
	if !isUpstreamBudgetError(err) || !strings.Contains(err.Error(), "累计响应大小") {
		t.Fatalf("error=%v", err)
	}
}

func TestRunningHubWorkflowSubmitAndQuery(t *testing.T) {
	taskID := "2058824859437850625"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/task/openapi/create":
			var payload struct {
				APIKey       string               `json:"apiKey"`
				WorkflowID   string               `json:"workflowId"`
				NodeInfoList []RunningHubNodeInfo `json:"nodeInfoList"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.APIKey != "test-key" || payload.WorkflowID != taskID || len(payload.NodeInfoList) != 1 {
				t.Fatalf("submit payload=%#v error=%v", payload, err)
			}
			_, _ = io.WriteString(w, `{"code":0,"msg":"success","data":{"taskId":"`+taskID+`"}}`)
		case "/task/openapi/status":
			_, _ = io.WriteString(w, `{"code":0,"msg":"success","data":"SUCCESS"}`)
		case "/task/openapi/outputs":
			_, _ = io.WriteString(w, `{"code":0,"msg":"success","data":[{"fileUrl":"https://cdn.example.test/result.png","fileType":"png","nodeId":"12"}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	channel := model.ModelChannel{Protocol: "runninghub", BaseURL: server.URL, APIKey: "test-key", Timeout: 5, Enabled: true}
	submitted, err := submitRunningHubTask(context.Background(), channel, RunningHubSubmitInput{
		Reference:    "workflow:" + taskID,
		NodeInfoList: []RunningHubNodeInfo{{NodeID: "12", FieldName: "prompt", FieldValue: "test prompt"}},
	})
	if err != nil || submitted.TaskID != taskID || submitted.Status != "QUEUED" {
		t.Fatalf("submitted=%#v error=%v", submitted, err)
	}
	queried, err := queryRunningHubTask(context.Background(), channel, taskID)
	if err != nil || queried.Status != "SUCCESS" || len(queried.Results) != 1 || queried.Results[0].URL != "https://cdn.example.test/result.png" {
		t.Fatalf("queried=%#v error=%v", queried, err)
	}
}
