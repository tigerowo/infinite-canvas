package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type WorkflowTaskResult struct {
	ID       string   `json:"id"`
	Status   string   `json:"status"`
	Progress int      `json:"progress"`
	URLs     []string `json:"urls,omitempty"`
	Error    string   `json:"error,omitempty"`
}

const workflowTaskTimeout = time.Hour

var ErrWorkflowTaskNotFound = errors.New("工作流任务不存在")

func CreateWorkflowTask(ctx context.Context, user model.AuthUser, input WorkflowRunInput) (result WorkflowTaskResult, err error) {
	user.DisplayName = firstNonEmpty(user.DisplayName, user.Username)
	resolved, err := ResolveWorkflowForUser(user, input.Ref)
	if err != nil {
		return WorkflowTaskResult{}, err
	}
	if input.ExpectedCapability != resolved.Entry.Capability {
		return WorkflowTaskResult{}, safeMessageError{message: "工作流用途与当前生成入口不匹配"}
	}
	overrides, err := ResolveWorkflowFields(resolved.Entry, input)
	if err != nil {
		return WorkflowTaskResult{}, safeMessageError{message: err.Error()}
	}
	refJSON, _ := json.Marshal(input.Ref)
	taskID := workflowTaskID(user.ID, resolved.Entry.Capability, input.ClientTaskID)
	if prior, found, err := workflowTaskSnapshot(user.ID, taskID); err != nil {
		return WorkflowTaskResult{}, err
	} else if found {
		if prior.ref != string(refJSON) {
			return WorkflowTaskResult{}, errors.New("任务 ID 已用于其他工作流")
		}
		return prior.result, nil
	}
	billingName := workflowBillingName(input.Ref)
	credits := 0.0
	if input.Ref.Scope == "system" {
		credits, err = ModelCost(billingName)
		if err != nil {
			return WorkflowTaskResult{}, err
		}
	}
	if err := createWorkflowTaskRecord(user, taskID, resolved, input, string(refJSON), billingName, credits); err != nil {
		if prior, found, lookupErr := workflowTaskSnapshot(user.ID, taskID); lookupErr == nil && found && prior.ref == string(refJSON) {
			return prior.result, nil
		}
		return WorkflowTaskResult{}, err
	}
	startedAt := time.Now()
	logInput := AICallLogInput{UserID: user.ID, UserDisplayName: user.DisplayName, Endpoint: "/api/v1/workflow-tasks", Method: "POST", Model: resolved.Entry.Title, ChannelID: resolved.Channel.ID, ChannelName: resolved.Channel.Name, Credits: credits}
	defer func() {
		upstreamStatus := logInput.Status
		logInput.DurationMs = time.Since(startedAt).Milliseconds()
		if err != nil {
			logInput.Status, logInput.Error = 0, err.Error()
		} else {
			logInput.Status = 200
		}
		response := map[string]any{"task": result}
		if upstreamStatus != 0 {
			response["upstreamHttpStatus"] = upstreamStatus
		}
		if logInput.ResponseBody != "" {
			response["responseBody"] = json.RawMessage(logInput.ResponseBody)
		}
		if err != nil {
			response["error"] = err.Error()
		}
		encoded, _ := json.Marshal(response)
		logInput.ResponseBody = string(encoded)
		SaveAICallLog(logInput)
	}()
	if resolved.Channel.Protocol == "comfyui" {
		payload := comfyWorkflowPayload(resolved.Entry, input, overrides)
		encoded, _ := json.Marshal(payload)
		logInput.RequestBody = string(workflowLogJSON(string(encoded), ""))
		request, queueErr := QueueComfyBridge(resolved.OwnerScope, resolved.OwnerID, resolved.Channel.BridgeID, taskID, resolved.Entry.Capability, payload)
		if queueErr != nil {
			return WorkflowTaskResult{}, errors.Join(queueErr, finishWorkflowTask(taskID, "failed", nil, queueErr.Error(), nil))
		}
		logInput.RequestBody = string(workflowLogJSON(request.PayloadJSON, ""))
		return WorkflowTaskResult{ID: taskID, Status: "queued", Progress: 0}, nil
	}
	upstreamID, err := SubmitRunningHubTask(ctx, resolved.Channel, resolved.Entry, input, overrides, &logInput)
	if err != nil {
		if finishErr := finishWorkflowTask(taskID, "failed", nil, err.Error(), nil); finishErr != nil {
			return WorkflowTaskResult{}, errors.Join(err, finishErr)
		}
		return WorkflowTaskResult{}, safeMessageError{message: err.Error()}
	}
	if err := markRunningHubTask(user.ID, taskID, upstreamID); err != nil {
		return WorkflowTaskResult{}, errors.Join(err, finishWorkflowTask(taskID, "failed", nil, err.Error(), nil))
	}
	WakeVideoTaskPoller()
	return WorkflowTaskResult{ID: taskID, Status: "running", Progress: 10}, nil
}

func GetWorkflowTask(ctx context.Context, user model.AuthUser, taskID string) (WorkflowTaskResult, error) {
	snapshot, found, err := workflowTaskSnapshot(user.ID, taskID)
	if err != nil {
		return WorkflowTaskResult{}, err
	}
	if !found {
		return WorkflowTaskResult{}, ErrWorkflowTaskNotFound
	}
	bridgeRequest, hasBridge, err := repository.GetComfyBridgeRequestByTaskID(taskID)
	if err != nil {
		return WorkflowTaskResult{}, err
	}
	if snapshot.result.Status == "failed" {
		return snapshot.result, nil
	}
	if !hasBridge && snapshot.result.Status != "succeeded" && snapshot.upstreamID == "" {
		if started, parseErr := time.Parse(time.RFC3339, snapshot.createdAt); parseErr == nil && time.Since(started) > workflowTaskTimeout {
			if err := finishWorkflowTask(taskID, "failed", nil, "工作流任务超过 1 小时仍未完成"); err != nil {
				return WorkflowTaskResult{}, err
			}
			latest, _, err := workflowTaskSnapshot(user.ID, taskID)
			return latest.result, err
		}
	}
	if snapshot.result.Status == "succeeded" {
		if hasBridge && len(snapshot.result.URLs) == 0 {
			if urls, err := workflowResultURLs(bridgeRequest.ResultJSON); err == nil {
				snapshot.result.URLs = urls
			}
		}
		return snapshot.result, nil
	}
	if hasBridge {
		if _, err := expireComfyBridgeRequests(bridgeRequest.BridgeID); err != nil {
			return WorkflowTaskResult{}, err
		}
		bridgeRequest, err = repository.GetComfyBridgeRequest(bridgeRequest.ID)
		if err != nil {
			return WorkflowTaskResult{}, err
		}
		switch bridgeRequest.Status {
		case "failed":
			if err := finishWorkflowTask(taskID, "failed", nil, bridgeRequest.Error); err != nil {
				return WorkflowTaskResult{}, err
			}
		case "succeeded":
			urls, err := workflowResultURLs(bridgeRequest.ResultJSON)
			if err != nil {
				if finishErr := finishWorkflowTask(taskID, "failed", nil, err.Error()); finishErr != nil {
					return WorkflowTaskResult{}, errors.Join(err, finishErr)
				}
			} else {
				if err := finishWorkflowTask(taskID, "completed", urls, ""); err != nil {
					return WorkflowTaskResult{}, err
				}
			}
		case "claimed":
			return WorkflowTaskResult{ID: taskID, Status: "running", Progress: 30}, nil
		}
	}
	latest, _, err := workflowTaskSnapshot(user.ID, taskID)
	if err == nil && hasBridge && latest.result.Status == "succeeded" && len(latest.result.URLs) == 0 {
		if urls, parseErr := workflowResultURLs(bridgeRequest.ResultJSON); parseErr == nil {
			latest.result.URLs = urls
		}
	}
	return latest.result, err
}

type workflowSnapshot struct {
	result     WorkflowTaskResult
	ref        string
	upstreamID string
	createdAt  string
	log        AICallLogInput
}

func workflowTaskSnapshot(userID, taskID string) (workflowSnapshot, bool, error) {
	switch {
	case strings.HasPrefix(taskID, "wf-image-"):
		task, found, err := repository.GetUserCanvasImageTask(userID, taskID)
		if !found || err != nil {
			return workflowSnapshot{}, found, err
		}
		return workflowSnapshot{result: WorkflowTaskResult{ID: task.ID, Status: workflowPublicStatus(task.Status), Progress: task.Progress, URLs: append([]string{}, task.ImageURLs...), Error: task.Error}, ref: task.WorkflowRef, upstreamID: workflowUpstreamID(task.ResponseBody), createdAt: task.CreatedAt, log: AICallLogInput{UserDisplayName: task.UserDisplayName, Model: task.Model, ChannelID: firstNonEmpty(task.ChannelID, task.UserChannelID), ChannelName: task.ChannelName}}, true, nil
	case strings.HasPrefix(taskID, "wf-video-"):
		task, found, err := repository.GetUserVideoTask(userID, taskID)
		if !found || err != nil {
			return workflowSnapshot{}, found, err
		}
		urls := []string{}
		if task.VideoURL != "" {
			urls = append(urls, task.VideoURL)
		}
		return workflowSnapshot{result: WorkflowTaskResult{ID: task.ID, Status: workflowPublicStatus(task.Status), Progress: task.Progress, URLs: urls, Error: task.Error}, ref: task.WorkflowRef, upstreamID: task.UpstreamTaskID, createdAt: task.CreatedAt, log: AICallLogInput{UserDisplayName: task.UserDisplayName, Model: task.Model, ChannelID: firstNonEmpty(task.ChannelID, task.UserChannelID), ChannelName: task.ChannelName}}, true, nil
	case strings.HasPrefix(taskID, "wf-audio-"):
		task, found, err := repository.GetUserCanvasAudioTask(userID, taskID)
		if !found || err != nil {
			return workflowSnapshot{}, found, err
		}
		urls := []string{}
		if task.AudioURL != "" {
			urls = append(urls, task.AudioURL)
		}
		return workflowSnapshot{result: WorkflowTaskResult{ID: task.ID, Status: workflowPublicStatus(task.Status), Progress: task.Progress, URLs: urls, Error: task.Error}, ref: task.WorkflowRef, upstreamID: workflowUpstreamID(task.ResponseBody), createdAt: task.CreatedAt, log: AICallLogInput{UserDisplayName: task.UserDisplayName, Model: task.Model, ChannelID: firstNonEmpty(task.ChannelID, task.UserChannelID), ChannelName: task.ChannelName}}, true, nil
	}
	return workflowSnapshot{}, false, nil
}

func workflowPublicStatus(status string) string {
	if status == "completed" || status == "succeeded" {
		return "succeeded"
	}
	if status == "failed" {
		return "failed"
	}
	if status == "running" || status == "processing" {
		return "running"
	}
	return "queued"
}

func workflowTaskID(userID, capability, clientID string) string {
	if strings.TrimSpace(clientID) != "" {
		return "wf-" + capability + "-" + uuid.NewSHA1(uuid.NameSpaceOID, []byte(userID+":"+clientID)).String()
	}
	return "wf-" + capability + "-" + uuid.NewString()
}

func workflowBillingName(ref WorkflowRef) string {
	return fmt.Sprintf("workflow:%s:%s:%s:%s", ref.Scope, ref.ChannelID, ref.Kind, ref.WorkflowID)
}

func createWorkflowTaskRecord(user model.AuthUser, id string, resolved ResolvedWorkflow, input WorkflowRunInput, ref, billingName string, credits float64) error {
	channelID, userChannelID := "", ""
	if input.Ref.Scope == "system" {
		channelID = input.Ref.ChannelID
	} else {
		userChannelID = input.Ref.ChannelID
	}
	switch resolved.Entry.Capability {
	case "image":
		source := "workflow"
		if input.Source == "image-workbench" || input.Source == "canvas" {
			source = input.Source
		}
		_, err := CreateCanvasImageTask(CanvasImageTaskCreateInput{UserID: user.ID, UserDisplayName: user.DisplayName, Source: source, SourceID: input.SourceID, NodeID: input.NodeID, ClientTaskID: id, Model: resolved.Entry.Title, ChannelID: channelID, UserChannelID: userChannelID, ChannelName: resolved.Channel.Name, WorkflowRef: ref, Credits: credits, BillingName: billingName, BillingPath: "/api/v1/workflow-tasks", Prompt: input.Prompt})
		return err
	case "video":
		source := "workflow"
		if input.Source == "video-workbench" || input.Source == "canvas" {
			source = input.Source
		}
		_, err := CreateVideoTask(VideoTaskCreateInput{UserID: user.ID, UserDisplayName: user.DisplayName, Source: source, SourceID: input.SourceID, ClientTaskID: id, Model: resolved.Entry.Title, ChannelID: channelID, UserChannelID: userChannelID, ChannelName: resolved.Channel.Name, WorkflowRef: ref, Credits: credits, BillingName: billingName, BillingPath: "/api/v1/workflow-tasks", Status: "queued", Seconds: input.VideoSeconds, Size: input.Size})
		return err
	case "audio":
		_, err := CreateCanvasAudioTask(CanvasAudioTaskCreateInput{UserID: user.ID, UserDisplayName: user.DisplayName, SourceID: input.SourceID, NodeID: input.NodeID, ClientTaskID: id, Model: resolved.Entry.Title, ChannelID: channelID, UserChannelID: userChannelID, ChannelName: resolved.Channel.Name, WorkflowRef: ref, Credits: credits, BillingName: billingName, BillingPath: "/api/v1/workflow-tasks", Prompt: input.Prompt})
		return err
	}
	return errors.New("工作流用途无效")
}

func markRunningHubTask(userID, taskID, upstreamID string) error {
	encoded, _ := json.Marshal(map[string]string{"upstreamTaskId": upstreamID})
	switch {
	case strings.HasPrefix(taskID, "wf-image-"):
		task, found, err := repository.GetUserCanvasImageTask(userID, taskID)
		if err != nil || !found {
			return errors.New("图片任务不存在")
		}
		task.Status, task.Progress, task.ResponseBody = "running", 10, string(encoded)
		_, err = SaveCanvasImageTask(task)
		return err
	case strings.HasPrefix(taskID, "wf-video-"):
		task, found, err := repository.GetUserVideoTask(userID, taskID)
		if err != nil || !found {
			return errors.New("视频任务不存在")
		}
		task.Status, task.Progress, task.UpstreamTaskID, task.UpdatedAt = "running", 10, upstreamID, now()
		_, err = repository.SaveVideoTask(task)
		return err
	case strings.HasPrefix(taskID, "wf-audio-"):
		task, found, err := repository.GetUserCanvasAudioTask(userID, taskID)
		if err != nil || !found {
			return errors.New("音频任务不存在")
		}
		task.Status, task.Progress, task.ResponseBody = "running", 10, string(encoded)
		_, err = SaveCanvasAudioTask(task)
		return err
	}
	return errors.New("工作流任务 ID 无效")
}

func workflowUpstreamID(value string) string {
	var data struct {
		UpstreamTaskID string `json:"upstreamTaskId"`
	}
	_ = json.Unmarshal([]byte(value), &data)
	return data.UpstreamTaskID
}

func pollRunningHubWorkflowTask(task repository.RunningHubWorkflowTask) error {
	if started, parseErr := time.Parse(time.RFC3339Nano, task.CreatedAt); parseErr == nil && time.Since(started) > workflowTaskTimeout {
		return finishWorkflowTask(task.ID, "failed", nil, "RunningHub 任务超过 1 小时仍未完成")
	}
	upstreamID := task.UpstreamTaskID
	if !strings.HasPrefix(task.ID, "wf-video-") {
		upstreamID = workflowUpstreamID(upstreamID)
	}
	if strings.TrimSpace(upstreamID) == "" {
		return finishWorkflowTask(task.ID, "failed", nil, "RunningHub 上游任务 ID 无效")
	}
	var ref WorkflowRef
	if err := json.Unmarshal([]byte(task.WorkflowRef), &ref); err != nil {
		return finishWorkflowTask(task.ID, "failed", nil, "工作流任务配置无效")
	}
	resolved, err := resolveWorkflowForUser(model.AuthUser{ID: task.UserID}, ref, false)
	if err != nil {
		return finishWorkflowTask(task.ID, "failed", nil, err.Error())
	}
	var capture AICallLogInput
	urls, done, pollErr := PollRunningHubTask(context.Background(), resolved.Channel, upstreamID, &capture)
	if errors.Is(pollErr, errRunningHubTaskTerminal) {
		failure := strings.TrimSpace(strings.TrimPrefix(pollErr.Error(), errRunningHubTaskTerminal.Error()+":"))
		if failure == "" {
			failure = errRunningHubTaskTerminal.Error()
		}
		return finishWorkflowTask(task.ID, "failed", nil, failure, &capture)
	}
	if done {
		return finishWorkflowTask(task.ID, "completed", urls, "", &capture)
	}
	return pollErr
}

func finishWorkflowTask(taskID, status string, urls []string, failure string, captures ...*AICallLogInput) error {
	preserveDataURLs := len(captures) > 0 && captures[0] != nil && strings.HasSuffix(captures[0].Endpoint, "/task/openapi/outputs")
	if !preserveDataURLs && len(urls) > 0 && strings.HasPrefix(urls[0], "data:") {
		urls = nil
	}
	var newRefundLog func(string) model.CreditLog
	if status == "failed" {
		newRefundLog = func(rawRef string) model.CreditLog {
			var ref WorkflowRef
			_ = json.Unmarshal([]byte(rawRef), &ref)
			modelName := workflowBillingName(ref)
			extra, _ := json.Marshal(map[string]string{"model": modelName, "path": "/api/v1/workflow-tasks"})
			return model.CreditLog{
				ID:        newID("credit"),
				Remark:    "模型调用失败返还 " + modelName,
				Extra:     string(extra),
				CreatedAt: now(),
			}
		}
	}
	changed, _, rawRef, userID, err := repository.CompleteWorkflowTask(taskID, status, urls, failure, newRefundLog)
	finishedAt := time.Now()
	if err != nil || !changed {
		return err
	}
	var ref WorkflowRef
	_ = json.Unmarshal([]byte(rawRef), &ref)
	if len(captures) > 0 && captures[0] == nil {
		return nil
	}
	logInput := AICallLogInput{UserID: userID, Endpoint: "/api/v1/workflow-tasks/" + taskID, Method: "TASK", ChannelID: ref.ChannelID, RequestBody: rawRef, Status: 200}
	if status == "failed" {
		logInput.Status, logInput.Error = 0, failure
	}
	if snapshot, found, lookupErr := workflowTaskSnapshot(userID, taskID); lookupErr == nil && found {
		logInput.UserDisplayName, logInput.Model, logInput.ChannelName = snapshot.log.UserDisplayName, snapshot.log.Model, snapshot.log.ChannelName
		if createdAt, parseErr := time.Parse(time.RFC3339Nano, snapshot.createdAt); parseErr == nil {
			logInput.DurationMs = max(0, finishedAt.Sub(createdAt).Milliseconds())
		}
	}
	response := map[string]any{"taskId": taskID, "status": workflowPublicStatus(status)}
	if failure != "" {
		response["error"] = failure
	}
	if len(captures) > 0 && captures[0] != nil {
		capture := captures[0]
		if capture.Endpoint != "" {
			logInput.Endpoint, logInput.Method = capture.Endpoint, capture.Method
		}
		if capture.RequestBody != "" {
			logInput.RequestBody = capture.RequestBody
		}
		if capture.ResponseBody != "" {
			response["responseBody"] = json.RawMessage(capture.ResponseBody)
		}
		if capture.Status != 0 {
			response["upstreamHttpStatus"] = capture.Status
		}
	} else if request, found, lookupErr := repository.GetComfyBridgeRequestByTaskID(taskID); lookupErr == nil && found {
		logInput.RequestBody = string(workflowLogJSON(request.PayloadJSON, ""))
		if request.ResultJSON != "" {
			response["responseBody"] = workflowLogJSON(request.ResultJSON, "")
		}
	}
	encoded, _ := json.Marshal(response)
	logInput.ResponseBody = string(encoded)
	SaveAICallLog(logInput)
	return nil
}

func workflowLogJSON(raw, secret string) json.RawMessage {
	var payload any
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		if secret != "" {
			raw = strings.ReplaceAll(raw, secret, "[redacted]")
		}
		lower := strings.ToLower(strings.TrimSpace(raw))
		if strings.HasPrefix(lower, "data:") || strings.Contains(lower, "data:") && strings.Contains(lower, ";base64,") {
			raw = "[redacted media data]"
		} else {
			raw = redactLargePlainLogText(raw)
		}
		encoded, _ := json.Marshal(raw)
		return encoded
	}
	var redact func(any) any
	redact = func(value any) any {
		switch item := value.(type) {
		case string:
			if secret != "" {
				item = strings.ReplaceAll(item, secret, "[redacted]")
			}
			lower := strings.ToLower(strings.TrimSpace(item))
			if strings.HasPrefix(lower, "data:") || strings.Contains(lower, "data:") && strings.Contains(lower, ";base64,") {
				return "[redacted media data]"
			}
			if isLargeLogString(item) {
				return fmt.Sprintf("[redacted large string len=%d]", len(item))
			}
			return item
		case map[string]any:
			for key, child := range item {
				item[key] = redact(child)
			}
		case []any:
			for index, child := range item {
				item[index] = redact(child)
			}
		}
		return value
	}
	encoded, _ := json.Marshal(redact(payload))
	return encoded
}

func comfyWorkflowPayload(entry model.WorkflowEntry, input WorkflowRunInput, overrides []WorkflowOverride) map[string]any {
	media := func(prefix string, values []string) []map[string]any {
		items := make([]map[string]any, 0, len(values))
		for index, value := range values {
			if strings.TrimSpace(value) == "" {
				continue
			}
			item := map[string]any{"id": fmt.Sprintf("%s:%d", prefix, index)}
			if strings.HasPrefix(value, "data:") {
				item["dataUrl"] = value
			} else {
				item["url"] = value
			}
			items = append(items, item)
		}
		return items
	}
	payload := map[string]any{
		"mode": entry.Capability, "workflowId": entry.WorkflowID, "workflowJson": entry.WorkflowJSON, "workflowFields": entry.Fields, "workflowOverrides": overrides,
		"referenceImages": media("image", input.ReferenceImages), "referenceVideos": media("video", input.ReferenceVideos), "referenceAudios": media("audio", input.ReferenceAudios),
		"mediaSlotModes": input.MediaSlotModes,
	}
	if input.Mask != "" {
		mask := media("mask", []string{input.Mask})[0]
		mask["id"] = "mask"
		payload["mask"] = mask
	}
	return payload
}

func workflowResultURLs(raw string) ([]string, error) {
	var result struct {
		Images []struct {
			URL string `json:"url"`
		} `json:"images"`
		Video struct {
			URL string `json:"url"`
		} `json:"video"`
		Audio struct {
			URL string `json:"url"`
		} `json:"audio"`
	}
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, errors.New("Bridge 产物格式无效")
	}
	urls := make([]string, 0, len(result.Images)+2)
	for _, image := range result.Images {
		if image.URL != "" {
			urls = append(urls, image.URL)
		}
	}
	if result.Video.URL != "" {
		urls = append(urls, result.Video.URL)
	}
	if result.Audio.URL != "" {
		urls = append(urls, result.Audio.URL)
	}
	if len(urls) == 0 {
		return nil, errors.New("Bridge 没有返回可用产物")
	}
	return urls, nil
}
