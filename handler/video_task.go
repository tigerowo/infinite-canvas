package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	medialifecycle "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/extensions/taskidentity"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func StartVideoTaskPoller() {
	service.StartVideoTaskPoller(pollVideoTaskFromUpstream)
}

func UserVideoTasks(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	tasks, err := service.ListUserVideoTasks(user.ID, "video-workbench", 100)
	if err != nil {
		log.Printf("list video tasks failed: user=%s err=%v", user.ID, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	OK(w, tasks)
}

func DeleteUserVideoTask(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	id = strings.TrimSpace(id)
	if id == "" {
		Fail(w, "视频任务不存在")
		return
	}
	if err := service.DeleteUserVideoTask(user.ID, id); err != nil {
		log.Printf("delete video task failed: user=%s id=%s err=%v", user.ID, id, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	OK(w, map[string]any{"deleted": true})
}

func proxyAIVideoTaskRequest(w http.ResponseWriter, r *http.Request) {
	operation := readClientVideoTaskID(r)
	if operation == "" {
		operation = "client_video_task_" + medialifecycle.ID()
	}
	startedAt := time.Now()
	body, contentType, modelName, err := readAIRequest(r)
	if err != nil {
		log.Printf("AI video request read failed: %v", err)
		Fail(w, "AI 接口请求失败")
		return
	}
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	if len(operation) > 128 {
		Fail(w, "任务操作标识过长")
		return
	}
	if existing, found, err := service.GetUserVideoTask(user.ID, operation); err != nil {
		FailError(w, err)
		return
	} else if found {
		OK(w, service.VideoTaskResponse(existing))
		return
	}
	channel, userChannelID, err := selectAIRequestChannel(user, modelName, r.Header.Get("X-Model-Channel-ID"), r.Header.Get(userModelChannelHeader))
	if err != nil {
		log.Printf("AI video select channel failed: model=%s err=%v", modelName, err)
		failAIChannelSelect(w, err, "AI 接口请求失败")
		return
	}
	credits := 0
	credentialSource := service.UserRemoteModelAPIKeyMode()
	if userChannelID != "" {
		credentialSource = "local"
	}
	if userChannelID == "" {
		credits, err = service.ModelCost(modelName)
		if err != nil {
			log.Printf("AI video read model cost failed: model=%s err=%v", modelName, err)
			Fail(w, "AI 接口请求失败")
			return
		}
		credits *= readAIRequestCount(body, contentType)
	}
	upstreamPath := resolveAIProxyPath(channel, modelName, "/videos")
	body, contentType, err = normalizeVideoCreateBody(body, contentType, modelName, channel, upstreamPath)
	if err != nil {
		log.Printf("AI video normalize request failed: model=%s err=%v", modelName, err)
		if service.IsAutoDLChannel(channel) {
			Fail(w, err.Error())
			return
		}
		Fail(w, "AI 接口请求失败")
		return
	}
	request, err := http.NewRequest(http.MethodPost, service.BuildModelChannelURL(channel, upstreamPath), bytes.NewReader(body))
	if err != nil {
		log.Printf("AI video build request failed: url=%s err=%v", service.BuildModelChannelURL(channel, upstreamPath), err)
		Fail(w, "AI 接口请求失败")
		return
	}
	service.SetModelChannelAuthHeader(request, channel)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	logContext := aiLogContext{
		StartedAt:       startedAt,
		Endpoint:        "/videos",
		Method:          http.MethodPost,
		Model:           modelName,
		Channel:         channel,
		UserID:          user.ID,
		UserDisplayName: firstNonEmpty(user.DisplayName, user.Username),
		Credits:         credits,
		RequestBody:     summarizeAIRequest(body, contentType),
	}
	createInput := service.VideoTaskCreateInput{
		Epoch:            medialifecycle.Epoch(r.Context()),
		CredentialSource: credentialSource, UserID: user.ID,
		UserDisplayName: firstNonEmpty(user.DisplayName, user.Username),
		Model:           modelName, ChannelID: channel.ID, UserChannelID: userChannelID, ChannelName: channel.Name,
		Source: readVideoTaskSource(r), SourceID: readVideoTaskSourceID(r), ClientTaskID: operation,
		RequestBody: logContext.RequestBody,
		Status:      "submitting", Credits: credits,
	}
	placeholder, err := service.CreateVideoTask(createInput)
	if err != nil {
		if existing, found, loadErr := service.GetUserVideoTask(user.ID, operation); loadErr == nil && found {
			OK(w, service.VideoTaskResponse(existing))
			return
		}
		FailError(w, err)
		return
	}
	db, err := repository.DB()
	if err != nil {
		FailError(w, err)
		return
	}
	attempt, err := medialifecycle.BeginTaskSubmission(db, user.ID, "video-task", operation)
	if err != nil {
		FailError(w, err)
		return
	}
	requestCtx, cancel := context.WithDeadline(medialifecycle.WithEpoch(r.Context(), attempt.Epoch), time.UnixMilli(attempt.Started+medialifecycle.Day))
	defer cancel()
	go medialifecycle.KeepTaskSubmission(requestCtx, db, attempt)
	request = request.WithContext(requestCtx)
	failCreate := func(message string) {
		failed := placeholder
		failed.Status, failed.Error, failed.ErrorDetail = "failed", message, message
		failed.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
		if err := medialifecycle.StageTaskResult(db, &failed); err != nil {
			log.Printf("save failed video creation: model=%s err=%v", modelName, err)
		}
		Fail(w, message)
	}
	if err := service.ConsumeUserCredits(user.ID, modelName, credits, upstreamPath, operation, attempt.Epoch); err != nil {
		failCreate("任务未提交：" + err.Error())
		return
	}
	payload, status, err := doAIRequest(request, channel)
	if err != nil {
		if credits > 0 {
			_ = service.SetTaskSettlement(user.ID, operation, "unknown")
		}
		saveAIProxyLog(logContext, 0, "", err.Error())
		failCreate("视频创建请求失败：" + err.Error())
		return
	}
	if status >= http.StatusBadRequest {
		message := readUpstreamAIErrorMessage(payload, status)
		if credits > 0 && status < 500 {
			refundVideoCredits(user.ID, modelName, credits, upstreamPath, operation)
		} else if status >= 500 {
			if err := service.SetTaskSettlement(user.ID, operation, "unknown"); err != nil {
				log.Printf("video uncertain settlement: %v", err)
			}
		}
		saveAIProxyLog(logContext, status, string(payload), strings.TrimSpace(string(payload)))
		failCreate(message)
		return
	}
	transformed := transformVideoCreatePayload(payload, request, channel, modelName)
	if message := readVideoCreateErrorMessage(payload, transformed, channel, modelName); message != "" {
		if credits > 0 {
			refundVideoCredits(user.ID, modelName, credits, upstreamPath, operation)
		}
		saveAIProxyLog(logContext, status, string(payload), message)
		failCreate(message)
		return
	}
	parsed := parseChannelVideoTaskPayload(transformed, modelName, channel)
	if parsed.UpstreamTaskID == "" && parsed.UpstreamVideoID == "" {
		if credits > 0 {
			_ = service.SetTaskSettlement(user.ID, operation, "unknown")
		}
		saveAIProxyLog(logContext, status, string(transformed), "视频接口没有返回任务 ID")
		failCreate("视频接口没有返回任务 ID")
		return
	}
	createInput.UpstreamTaskID, createInput.UpstreamVideoID = parsed.UpstreamTaskID, parsed.UpstreamVideoID
	createInput.Status, createInput.Progress = parsed.Status, parsed.Progress
	createInput.Seconds, createInput.Size, createInput.VideoURL = parsed.Seconds, parsed.Size, parsed.VideoURL
	createInput.Error, createInput.ErrorDetail = parsed.Error, parsed.ErrorDetail
	createInput.ResponseBody, createInput.Credits = string(transformed), credits
	task := placeholder
	task.UpstreamTaskID, task.UpstreamVideoID = createInput.UpstreamTaskID, createInput.UpstreamVideoID
	task.Status, task.Progress = createInput.Status, createInput.Progress
	task.Seconds, task.Size, task.VideoURL = createInput.Seconds, createInput.Size, createInput.VideoURL
	task.Error, task.ErrorDetail = createInput.Error, createInput.ErrorDetail
	task.ResponseBody, task.LastResponse = createInput.ResponseBody, createInput.ResponseBody
	if service.IsCompletedVideoTaskStatus(task.Status) || service.IsFailedVideoTaskStatus(task.Status) {
		task.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if err := medialifecycle.StageTaskResult(db, &task); err != nil {
		log.Printf("save video task failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	saveAIProxyLog(logContext, status, string(transformed), "")
	OK(w, service.VideoTaskResponse(task))
}

func readClientVideoTaskID(r *http.Request) string {
	id := strings.TrimSpace(r.Header.Get("X-Client-Video-Task-ID"))
	if isClientVideoTaskID(id) {
		return id
	}
	return ""
}

func readVideoTaskSource(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-Video-Task-Source"))
}

func readVideoTaskSourceID(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-Video-Task-Source-ID"))
}

func isClientVideoTaskID(id string) bool {
	return strings.HasPrefix(strings.TrimSpace(id), "client_video_task_")
}

func serveAIVideoTask(w http.ResponseWriter, r *http.Request, id string) bool {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		return false
	}
	task, found, err := service.GetUserVideoTask(user.ID, id)
	if err != nil {
		log.Printf("read video task failed: id=%s user=%s err=%v", id, user.ID, err)
		Fail(w, "AI 接口请求失败")
		return true
	}
	if !found {
		return false
	}
	OK(w, service.VideoTaskResponse(task))
	return true
}

func serveGeminiVideoTaskContent(w http.ResponseWriter, r *http.Request, id string) bool {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		return false
	}
	task, found, err := service.GetUserVideoTask(user.ID, strings.TrimSpace(id))
	if err != nil || !found {
		return false
	}
	channel, err := selectVideoTaskChannel(task)
	if err != nil || !service.IsGeminiChannel(channel) {
		return false
	}
	if strings.TrimSpace(task.VideoURL) == "" {
		Fail(w, "Gemini Veo 任务完成但没有返回视频地址")
		return true
	}
	request, err := http.NewRequest(http.MethodGet, task.VideoURL, nil)
	if err != nil {
		Fail(w, "视频内容下载失败")
		return true
	}
	service.SetModelChannelAuthHeader(request, channel)
	response, err := service.HTTPClientForChannel(channel).Do(request)
	if err != nil {
		Fail(w, "视频内容下载失败")
		return true
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusBadRequest {
		Fail(w, readUpstreamAIErrorMessage(nil, response.StatusCode))
		return true
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
	return true
}

func pollVideoTaskFromUpstream(task model.VideoTask) (service.VideoTaskPollUpdate, error) {
	db, err := repository.DB()
	if err != nil {
		return service.VideoTaskPollUpdate{}, err
	}
	attempt, err := medialifecycle.LoadTaskAttempt(db, task.UserID, "video-task", task.ID)
	if err != nil {
		return service.VideoTaskPollUpdate{}, err
	}
	ctx, cancel := context.WithDeadline(medialifecycle.WithEpoch(context.Background(), attempt.Epoch), time.UnixMilli(min(attempt.Started+medialifecycle.Day, time.Now().Add(110*time.Second).UnixMilli())))
	defer cancel()
	channel, err := selectVideoTaskChannel(task)
	if err != nil {
		return service.VideoTaskPollUpdate{}, err
	}
	pollID := firstNonEmpty(task.UpstreamTaskID, task.ID)
	if !service.IsNewAPIChannel(channel) && isAIProtocolVideoID(task.Model, task.UpstreamVideoID) {
		pollID = task.UpstreamVideoID
	}
	if strings.TrimSpace(pollID) == "" {
		return service.VideoTaskPollUpdate{}, errors.New("视频任务缺少上游任务 ID")
	}
	endpoint := "/videos/" + pollID
	upstreamPath := resolveAIProxyPath(channel, task.Model, endpoint)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, resolveAIProxyURL(channel, task.Model, upstreamPath), nil)
	if err != nil {
		return service.VideoTaskPollUpdate{}, err
	}
	service.SetModelChannelAuthHeader(request, channel)
	startedAt := time.Now()
	logContext := aiLogContext{
		StartedAt:       startedAt,
		Endpoint:        endpoint,
		Method:          http.MethodGet,
		Model:           task.Model,
		Channel:         channel,
		UserID:          task.UserID,
		UserDisplayName: task.UserDisplayName,
		RequestBody:     fmt.Sprintf(`{"taskId":%q}`, pollID),
	}
	payload, status, err := doAIRequest(request, channel)
	if err != nil {
		saveAIProxyLog(logContext, 0, "", err.Error())
		return service.VideoTaskPollUpdate{}, err
	}
	if status >= http.StatusBadRequest {
		message := readUpstreamAIErrorMessage(payload, status)
		saveAIProxyLog(logContext, status, string(payload), strings.TrimSpace(string(payload)))
		if status == http.StatusTooManyRequests || status >= http.StatusInternalServerError || status == http.StatusRequestTimeout {
			return service.VideoTaskPollUpdate{Status: task.Status, ErrorDetail: message, ResponseBody: string(payload)}, nil
		}
		return service.VideoTaskPollUpdate{Status: "failed", Error: message, ErrorDetail: message, ResponseBody: string(payload)}, nil
	}
	transformed := transformVideoStatusPayload(payload, request, channel, task.Model)
	parsed := parseChannelVideoTaskPayload(transformed, task.Model, channel)
	if parsed.Status == "failed" && parsed.Error == "" {
		parsed.Error = firstNonEmpty(parsed.ErrorDetail, "视频任务生成失败")
	}
	if errMessage := readVideoStatusErrorMessage(payload, transformed, channel, task.Model); errMessage != "" {
		if parsed.Error == "" {
			parsed.Error = errMessage
		}
		parsed.Status = "failed"
	}
	if parsed.ErrorDetail == "" && len(payload) > 0 && parsed.Error != "" {
		parsed.ErrorDetail = string(payload)
	}
	saveAIProxyLog(logContext, status, string(transformed), firstNonEmpty(parsed.Error, ""))
	return service.VideoTaskPollUpdate{
		Status:       parsed.Status,
		Progress:     parsed.Progress,
		Seconds:      parsed.Seconds,
		Size:         parsed.Size,
		VideoURL:     parsed.VideoURL,
		Error:        parsed.Error,
		ErrorDetail:  parsed.ErrorDetail,
		ResponseBody: string(transformed),
	}, nil
}

func selectVideoTaskChannel(task model.VideoTask) (model.ModelChannel, error) {
	db, err := repository.DB()
	if err != nil {
		return model.ModelChannel{}, err
	}
	source, err := taskidentity.Load(db, task.ID, task.UserID)
	if err != nil {
		return model.ModelChannel{}, err
	}
	if strings.TrimSpace(task.UserChannelID) != "" {
		return service.SelectUserLocalModelChannelForModel(task.UserID, task.Model, task.UserChannelID)
	}
	if source != "" && source != service.UserRemoteModelAPIKeyMode() {
		return model.ModelChannel{}, errors.New("视频任务的凭证模式已变更，请恢复创建时的模式后重试")
	}
	user, found, err := repository.GetUserByID(task.UserID)
	if err != nil {
		return model.ModelChannel{}, err
	}
	if !found || user.Status == model.UserStatusBan {
		return model.ModelChannel{}, errors.New("视频任务所属账号不可用")
	}
	channel, _, err := selectAIRequestChannel(model.PublicUser(user), task.Model, task.ChannelID, "")
	return channel, err
}

func normalizeVideoCreateBody(body []byte, contentType string, modelName string, channel model.ModelChannel, upstreamPath string) ([]byte, string, error) {
	prepared, _, err := prepareAIProtocolRequest(aiProtocolRequest{
		mode: aiProtocolVideoRequest, body: body, contentType: contentType, modelName: modelName,
		channel: channel, endpoint: "/videos", path: upstreamPath,
	})
	return prepared.body, prepared.contentType, err
}

func doAIRequest(request *http.Request, channel model.ModelChannel) ([]byte, int, error) {
	response, err := service.HTTPClientForChannel(channel).Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
	return payload, response.StatusCode, nil
}

func transformVideoCreatePayload(payload []byte, request *http.Request, channel model.ModelChannel, modelName string) []byte {
	return transformAIProtocolVideoPayload(payload, request, channel, modelName, false)
}

func transformVideoStatusPayload(payload []byte, request *http.Request, channel model.ModelChannel, modelName string) []byte {
	return transformAIProtocolVideoPayload(payload, request, channel, modelName, true)
}

func transformGeminiVideoTaskResponse(payload []byte) ([]byte, bool) {
	var root map[string]any
	if len(payload) == 0 || json.Unmarshal(payload, &root) != nil {
		return nil, false
	}
	name := readStringPath(root, "name")
	done, _ := root["done"].(bool)
	videoURL := findFirstHTTPURL(root)
	errorMessage := firstNonEmpty(readStringPath(root, "error.message"))
	status := "processing"
	progress := 0
	if errorMessage != "" {
		status = "failed"
	} else if done && videoURL != "" {
		status = "completed"
		progress = 100
	} else if done {
		status = "failed"
		errorMessage = "Gemini Veo 任务完成但没有返回视频地址"
	}
	transformed, err := json.Marshal(map[string]any{
		"id":        name,
		"task_id":   name,
		"status":    status,
		"progress":  progress,
		"video_url": videoURL,
		"error":     map[string]any{"message": errorMessage},
	})
	return transformed, err == nil
}

func readVideoCreateErrorMessage(raw []byte, transformed []byte, channel model.ModelChannel, modelName string) string {
	if service.IsNewAPIChannel(channel) {
		return firstNonEmpty(readProviderPayloadError(raw), parseChannelVideoTaskPayload(transformed, modelName, channel).Error)
	}
	return firstNonEmpty(readAIProtocolVideoError(raw, channel, modelName, false), readProviderPayloadError(raw), readNormalizedVideoError(transformed))
}

func readVideoStatusErrorMessage(raw []byte, transformed []byte, channel model.ModelChannel, modelName string) string {
	if service.IsNewAPIChannel(channel) {
		return firstNonEmpty(readProviderPayloadError(raw), parseChannelVideoTaskPayload(transformed, modelName, channel).Error)
	}
	return firstNonEmpty(readAIProtocolVideoError(raw, channel, modelName, true), readProviderPayloadError(raw), readNormalizedVideoError(transformed))
}

type parsedVideoTaskPayload struct {
	UpstreamTaskID  string
	UpstreamVideoID string
	Status          string
	Progress        int
	Seconds         string
	Size            string
	VideoURL        string
	Error           string
	ErrorDetail     string
}

func parseVideoTaskPayload(payload []byte, modelName string) parsedVideoTaskPayload {
	var root any
	if len(payload) == 0 || json.Unmarshal(payload, &root) != nil {
		return parsedVideoTaskPayload{Status: "processing"}
	}
	data := normalizeVideoPayloadMap(root)
	result := parsedVideoTaskPayload{
		UpstreamTaskID:  firstNonEmpty(readStringPath(data, "task_id"), readStringPath(data, "taskId"), readStringPath(data, "id"), readStringPath(data, "request_id")),
		UpstreamVideoID: firstNonEmpty(readStringPath(data, "video_id"), readStringPath(data, "videoId")),
		Status:          service.NormalizeVideoTaskStatus(firstNonEmpty(readStringPath(data, "status"), readStringPath(data, "state"), readStringPath(data, "task_status"))),
		Progress:        readIntPath(data, "progress"),
		Seconds:         firstNonEmpty(readStringPath(data, "seconds"), readStringPath(data, "duration")),
		Size:            firstNonEmpty(readStringPath(data, "size"), readSizeFromDimensions(data)),
		VideoURL:        firstNonEmpty(readStringPath(data, "video_url"), readStringPath(data, "url"), readStringPath(data, "remixed_from_video_id"), readStringPath(data, "output_url"), readStringPath(data, "download_url"), findFirstHTTPURL(data)),
		Error:           firstNonEmpty(readStringPath(data, "error.message"), readStringPath(data, "error")),
		ErrorDetail:     "",
	}
	if result.UpstreamTaskID == result.UpstreamVideoID && strings.HasPrefix(result.UpstreamVideoID, "video_") {
		result.UpstreamTaskID = ""
	}
	if result.Status == "" {
		result.Status = "processing"
	}
	if result.VideoURL != "" {
		result.Status = "completed"
		result.Progress = 100
	}
	if result.Status == "failed" && result.Error == "" {
		result.Error = firstNonEmpty(readStringPath(data, "message"), readStringPath(data, "msg"), "视频任务生成失败")
	}
	if result.UpstreamVideoID == "" && isAIProtocolVideoID(modelName, result.VideoURL) {
		result.UpstreamVideoID = result.VideoURL
	}
	if result.Error != "" {
		result.ErrorDetail = string(payload)
	}
	return result
}

func normalizeVideoPayloadMap(value any) map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		if data, ok := typed["data"].(map[string]any); ok {
			for key, item := range typed {
				if _, exists := data[key]; !exists {
					data[key] = item
				}
			}
			return data
		}
		if data, ok := typed["data"].([]any); ok && len(data) > 0 {
			if item, ok := data[0].(map[string]any); ok {
				for key, value := range typed {
					if _, exists := item[key]; !exists {
						item[key] = value
					}
				}
				return item
			}
		}
		return typed
	default:
		return map[string]any{}
	}
}

func readNormalizedVideoError(payload []byte) string {
	parsed := parseVideoTaskPayload(payload, "")
	if parsed.Status == "failed" || parsed.Error != "" {
		return firstNonEmpty(parsed.Error, "视频任务生成失败")
	}
	return ""
}

func readProviderPayloadError(payload []byte) string {
	var value map[string]any
	if len(payload) == 0 || json.Unmarshal(payload, &value) != nil {
		return ""
	}
	code, hasCode := value["code"]
	if !hasCode {
		return ""
	}
	successCode := false
	switch typed := code.(type) {
	case float64:
		successCode = typed == 0 || typed == 200
	case string:
		text := strings.TrimSpace(strings.ToLower(typed))
		successCode = text == "" || text == "0" || text == "200" || text == "success" || text == "ok"
	default:
		successCode = false
	}
	if successCode {
		return ""
	}
	return firstNonEmpty(readStringPath(value, "error.message"), readStringPath(value, "error"), readStringPath(value, "message"), readStringPath(value, "msg"), fmt.Sprint(code))
}

func readStringPath(data map[string]any, path string) string {
	var current any = data
	for _, part := range strings.Split(path, ".") {
		m, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current = m[part]
	}
	return strings.TrimSpace(toStringSafe(current))
}

func readIntPath(data map[string]any, key string) int {
	value := data[key]
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case json.Number:
		number, _ := typed.Int64()
		return int(number)
	case string:
		var number int
		_, _ = fmt.Sscanf(strings.TrimSpace(typed), "%d", &number)
		return number
	default:
		return 0
	}
}

func readSizeFromDimensions(data map[string]any) string {
	width := readIntPath(data, "width")
	height := readIntPath(data, "height")
	if width > 0 && height > 0 {
		return fmt.Sprintf("%dx%d", width, height)
	}
	return ""
}

func findFirstHTTPURL(value any) string {
	switch typed := value.(type) {
	case string:
		text := strings.TrimSpace(typed)
		if strings.HasPrefix(text, "http://") || strings.HasPrefix(text, "https://") {
			return text
		}
		var parsed any
		if json.Unmarshal([]byte(text), &parsed) == nil {
			return findFirstHTTPURL(parsed)
		}
	case []any:
		for _, item := range typed {
			if url := findFirstHTTPURL(item); url != "" {
				return url
			}
		}
	case map[string]any:
		for _, key := range []string{"uri", "url", "video_url", "videoUrl", "download_url", "downloadUrl", "output_url", "outputUrl", "resultUrls", "result_urls", "videoUrls", "video_urls", "urls", "videos", "video_result", "video", "generatedSamples", "generateVideoResponse", "response", "data", "result", "metadata"} {
			if url := findFirstHTTPURL(typed[key]); url != "" {
				return url
			}
		}
	}
	return ""
}

func refundVideoCredits(userID string, modelName string, credits int, endpoint, operation string) {
	if err := service.RefundUserCredits(userID, modelName, credits, endpoint, operation); err != nil {
		log.Printf("AI video refund credits failed: user=%s model=%s credits=%d err=%v", userID, modelName, credits, err)
	}
}
