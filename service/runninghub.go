package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

const (
	runningHubResponseLimit  = int64(4 * 1024 * 1024)
	runningHubDeadline       = 45 * time.Second
	runningHubCancelLimit    = int64(512 * 1024)
	runningHubCancelDeadline = 20 * time.Second
)

var runningHubNumericID = regexp.MustCompile(`^[0-9]{6,32}$`)

type RunningHubNodeInfo struct {
	NodeID      string `json:"nodeId"`
	FieldName   string `json:"fieldName"`
	FieldValue  any    `json:"fieldValue"`
	Description string `json:"description,omitempty"`
	FieldData   any    `json:"fieldData,omitempty"`
}

type RunningHubSubmitInput struct {
	Reference    string               `json:"reference"`
	NodeInfoList []RunningHubNodeInfo `json:"nodeInfoList"`
}

type RunningHubTaskResult struct {
	TaskID       string                   `json:"taskId"`
	Status       string                   `json:"status"`
	ErrorMessage string                   `json:"errorMessage,omitempty"`
	Results      []RunningHubOutputResult `json:"results,omitempty"`
}

type RunningHubOutputResult struct {
	URL        string `json:"url"`
	OutputType string `json:"outputType"`
	NodeID     string `json:"nodeId,omitempty"`
}

type runningHubEnvelope struct {
	Code int             `json:"code"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data"`
}

func ParseRunningHubReference(reference string) (kind string, id string, ok bool) {
	parts := strings.SplitN(strings.ToLower(strings.TrimSpace(reference)), ":", 2)
	if len(parts) != 2 || parts[0] != "app" && parts[0] != "workflow" || !runningHubNumericID.MatchString(parts[1]) {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func SubmitCurrentUserRunningHubTask(ctx context.Context, providerID string, input RunningHubSubmitInput) (RunningHubTaskResult, error) {
	_, item, err := currentUserProvider(ctx, providerID)
	if err != nil {
		return RunningHubTaskResult{}, err
	}
	channel, err := runningHubProviderChannel(item)
	if err != nil {
		return RunningHubTaskResult{}, err
	}
	return submitRunningHubTask(ctx, channel, input)
}

func submitRunningHubTask(ctx context.Context, channel model.ModelChannel, input RunningHubSubmitInput) (RunningHubTaskResult, error) {
	kind, resourceID, ok := ParseRunningHubReference(input.Reference)
	if !ok {
		return RunningHubTaskResult{}, safeMessageError{message: "RunningHub 引用必须使用 app:<ID> 或 workflow:<ID>"}
	}
	if len(input.NodeInfoList) > 256 {
		return RunningHubTaskResult{}, safeMessageError{message: "RunningHub 节点参数不能超过 256 项"}
	}
	for _, node := range input.NodeInfoList {
		if strings.TrimSpace(node.NodeID) == "" || len(node.NodeID) > 80 || strings.TrimSpace(node.FieldName) == "" || len(node.FieldName) > 120 || strings.ContainsAny(node.NodeID+node.FieldName, "\r\n") {
			return RunningHubTaskResult{}, safeMessageError{message: "RunningHub 节点参数无效"}
		}
	}
	payload := map[string]any{"apiKey": channel.APIKey, "nodeInfoList": input.NodeInfoList}
	path := "/task/openapi/create"
	if kind == "app" {
		payload["webappId"] = resourceID
		path = "/task/openapi/ai-app/run"
	} else {
		payload["workflowId"] = resourceID
	}
	budget := newUpstreamReadBudget(ctx, "RunningHub 任务提交", upstreamReadLimits{MaxRequests: 1, MaxBytes: runningHubResponseLimit, Deadline: runningHubDeadline})
	defer budget.Close()
	body, err := doRunningHubJSON(channel, budget, path, payload)
	if err != nil {
		return RunningHubTaskResult{}, err
	}
	envelope, err := parseRunningHubEnvelope(body)
	if err != nil {
		return RunningHubTaskResult{}, err
	}
	var data map[string]any
	decoder := json.NewDecoder(bytes.NewReader(envelope.Data))
	decoder.UseNumber()
	_ = decoder.Decode(&data)
	taskID := runningHubString(data["taskId"])
	if !runningHubNumericID.MatchString(taskID) {
		return RunningHubTaskResult{}, safeMessageError{message: "RunningHub 未返回有效任务 ID"}
	}
	return RunningHubTaskResult{TaskID: taskID, Status: "QUEUED"}, nil
}

func QueryCurrentUserRunningHubTask(ctx context.Context, providerID string, taskID string) (RunningHubTaskResult, error) {
	_, item, err := currentUserProvider(ctx, providerID)
	if err != nil {
		return RunningHubTaskResult{}, err
	}
	channel, err := runningHubProviderChannel(item)
	if err != nil {
		return RunningHubTaskResult{}, err
	}
	return queryRunningHubTask(ctx, channel, taskID)
}

func CancelCurrentUserRunningHubTask(ctx context.Context, providerID string, taskID string) (RunningHubTaskResult, error) {
	_, item, err := currentUserProvider(ctx, providerID)
	if err != nil {
		return RunningHubTaskResult{}, err
	}
	channel, err := runningHubProviderChannel(item)
	if err != nil {
		return RunningHubTaskResult{}, err
	}
	return cancelRunningHubTask(ctx, channel, taskID)
}

func cancelRunningHubTask(ctx context.Context, channel model.ModelChannel, taskID string) (RunningHubTaskResult, error) {
	taskID = strings.TrimSpace(taskID)
	if !runningHubNumericID.MatchString(taskID) {
		return RunningHubTaskResult{}, safeMessageError{message: "RunningHub 任务 ID 无效"}
	}
	budget := newUpstreamReadBudget(ctx, "RunningHub 任务取消", upstreamReadLimits{MaxRequests: 1, MaxBytes: runningHubCancelLimit, Deadline: runningHubCancelDeadline})
	defer budget.Close()
	body, err := doRunningHubJSON(channel, budget, "/task/openapi/cancel", map[string]any{"apiKey": channel.APIKey, "taskId": taskID})
	if err != nil {
		return RunningHubTaskResult{}, err
	}
	if _, err := parseRunningHubEnvelope(body); err != nil {
		return RunningHubTaskResult{}, err
	}
	return RunningHubTaskResult{TaskID: taskID, Status: "CANCELLED"}, nil
}

func queryRunningHubTask(ctx context.Context, channel model.ModelChannel, taskID string) (RunningHubTaskResult, error) {
	taskID = strings.TrimSpace(taskID)
	if !runningHubNumericID.MatchString(taskID) {
		return RunningHubTaskResult{}, safeMessageError{message: "RunningHub 任务 ID 无效"}
	}
	budget := newUpstreamReadBudget(ctx, "RunningHub 任务查询", upstreamReadLimits{MaxRequests: 2, MaxBytes: runningHubResponseLimit, Deadline: runningHubDeadline})
	defer budget.Close()
	payload := map[string]any{"apiKey": channel.APIKey, "taskId": taskID}
	body, err := doRunningHubJSON(channel, budget, "/task/openapi/status", payload)
	if err != nil {
		return RunningHubTaskResult{}, err
	}
	envelope, err := parseRunningHubEnvelope(body)
	if err != nil {
		return RunningHubTaskResult{}, err
	}
	var status string
	_ = json.Unmarshal(envelope.Data, &status)
	status = strings.ToUpper(strings.TrimSpace(status))
	if status == "" {
		status = "RUNNING"
	}
	if status != "QUEUED" && status != "RUNNING" && status != "SUCCESS" && status != "FAILED" && status != "CANCELLED" {
		return RunningHubTaskResult{}, safeMessageError{message: "RunningHub 返回了未知任务状态"}
	}
	result := RunningHubTaskResult{TaskID: taskID, Status: status}
	if status == "FAILED" {
		result.ErrorMessage = "RunningHub 任务失败"
		return result, nil
	}
	if status != "SUCCESS" {
		return result, nil
	}
	body, err = doRunningHubJSON(channel, budget, "/task/openapi/outputs", payload)
	if err != nil {
		return RunningHubTaskResult{}, err
	}
	envelope, err = parseRunningHubEnvelope(body)
	if err != nil {
		return RunningHubTaskResult{}, err
	}
	var outputs []struct {
		FileURL  string `json:"fileUrl"`
		FileType string `json:"fileType"`
		NodeID   string `json:"nodeId"`
	}
	if err := json.Unmarshal(envelope.Data, &outputs); err != nil {
		return RunningHubTaskResult{}, safeMessageError{message: "RunningHub 返回了无效产物结构"}
	}
	for _, output := range outputs {
		if strings.TrimSpace(output.FileURL) == "" {
			continue
		}
		result.Results = append(result.Results, RunningHubOutputResult{URL: output.FileURL, OutputType: output.FileType, NodeID: output.NodeID})
	}
	return result, nil
}

func TestRunningHubChannel(ctx context.Context, channel model.ModelChannel) error {
	budget := newUpstreamReadBudget(ctx, "RunningHub 连接检测", upstreamReadLimits{MaxRequests: 1, MaxBytes: 512 * 1024, Deadline: 20 * time.Second})
	defer budget.Close()
	body, err := doRunningHubJSON(channel, budget, "/uc/openapi/accountStatus", map[string]any{"apikey": channel.APIKey})
	if err != nil {
		return err
	}
	_, err = parseRunningHubEnvelope(body)
	return err
}

func runningHubProviderChannel(item model.Provider) (model.ModelChannel, error) {
	if item.Kind != model.ProviderKindAPI || !item.Enabled || !strings.EqualFold(item.Protocol, "runninghub") {
		return model.ModelChannel{}, safeMessageError{message: "RunningHub 渠道不可用"}
	}
	return modelChannelFromProvider(item)
}

func doRunningHubJSON(channel model.ModelChannel, budget *upstreamReadBudget, path string, payload any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(budget.Context(), http.MethodPost, strings.TrimRight(channel.BaseURL, "/")+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	SetModelChannelAuthHeader(request, channel)
	response, err := budget.HTTPClient(HTTPClientForChannel(channel)).Do(request)
	if err != nil {
		return nil, normalizeUpstreamBudgetError(err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, normalizeUpstreamBudgetError(err)
	}
	if response.StatusCode >= http.StatusBadRequest {
		return nil, safeMessageError{message: fmt.Sprintf("RunningHub 请求失败（HTTP %d）", response.StatusCode)}
	}
	return responseBody, nil
}

func parseRunningHubEnvelope(body []byte) (runningHubEnvelope, error) {
	var envelope runningHubEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		return envelope, safeMessageError{message: "RunningHub 返回了无效响应"}
	}
	if envelope.Code != 0 {
		return envelope, safeMessageError{message: fmt.Sprintf("RunningHub 请求被拒绝（代码 %d）", envelope.Code)}
	}
	return envelope, nil
}

func runningHubString(value any) string {
	switch item := value.(type) {
	case string:
		return strings.TrimSpace(item)
	case json.Number:
		return string(item)
	case float64:
		return fmt.Sprintf("%.0f", item)
	default:
		return ""
	}
}
