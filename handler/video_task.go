package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

const (
	videoTaskPollCountLimit      = 360
	videoTaskResponseByteLimit   = int64(32 * 1024 * 1024)
	videoTaskDeadline            = 30 * time.Minute
	videoTaskResponseLimit       = int64(1024 * 1024)
	videoTaskCancelDeadline      = 10 * time.Second
	videoTaskCancelResponseLimit = int64(64 * 1024)
)

var videoTaskPollCancels sync.Map

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
	if _, _, err := cancelUserVideoTask(r.Context(), user.ID, id); err != nil {
		log.Printf("cancel video task before delete failed: user=%s id=%s err=%s", user.ID, id, service.RedactSensitiveText(err.Error()))
	}
	if err := service.DeleteUserVideoTask(user.ID, id); err != nil {
		log.Printf("delete video task failed: user=%s id=%s err=%v", user.ID, id, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	OK(w, map[string]any{"deleted": true})
}

func CancelUserVideoTask(w http.ResponseWriter, r *http.Request, id string) {
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
	task, found, err := cancelUserVideoTask(r.Context(), user.ID, id)
	if err != nil {
		log.Printf("cancel video task failed: user=%s id=%s err=%s", user.ID, id, service.RedactSensitiveText(err.Error()))
		Fail(w, "AI 接口请求失败")
		return
	}
	if !found {
		Fail(w, "视频任务不存在")
		return
	}
	OK(w, service.VideoTaskResponse(task))
}

func cancelUserVideoTask(parent context.Context, userID string, id string) (model.VideoTask, bool, error) {
	current, found, err := service.GetUserVideoTask(userID, id)
	if err != nil || !found {
		return current, found, err
	}
	for _, key := range []string{id, current.ID} {
		if value, found := videoTaskPollCancels.Load(key); found {
			value.(context.CancelFunc)()
		}
	}
	if service.NormalizeVideoTaskStatus(current.Status) == "queued" {
		channel, channelErr := videoTaskChannel(current)
		if channelErr != nil {
			log.Printf("select video task channel before cancel failed: user=%s id=%s err=%s", userID, id, service.RedactSensitiveText(channelErr.Error()))
		} else if attempted, cancelErr := cancelUpstreamVideoTask(parent, current, channel); attempted && cancelErr != nil {
			log.Printf("cancel upstream video task failed: user=%s id=%s err=%s", userID, id, service.RedactSensitiveText(cancelErr.Error()))
		}
	}
	task, changed, err := service.CancelUserVideoTask(userID, id)
	if err != nil {
		return model.VideoTask{}, true, err
	}
	if !changed {
		current, found, readErr := service.GetUserVideoTask(userID, id)
		if readErr != nil || !found {
			return current, found, readErr
		}
		task = current
	}
	return task, true, nil
}

func videoTaskChannel(task model.VideoTask) (model.ModelChannel, error) {
	if strings.TrimSpace(task.UserChannelID) != "" {
		return service.SelectUserLocalModelChannelForModel(task.UserID, task.Model, task.UserChannelID)
	}
	return service.SelectModelChannelForModel(task.Model, task.ChannelID)
}

func cancelUpstreamVideoTask(parent context.Context, task model.VideoTask, channel model.ModelChannel) (bool, error) {
	requestContext, cancel := context.WithTimeout(parent, videoTaskCancelDeadline)
	defer cancel()
	request, supported, err := newUpstreamVideoCancelRequest(requestContext, task, channel)
	if err != nil || !supported {
		return supported, err
	}
	taskID := firstNonEmpty(task.UpstreamTaskID, task.UpstreamVideoID)
	startedAt := time.Now()
	logContext := aiLogContext{
		StartedAt:       startedAt,
		Endpoint:        request.URL.Path,
		Method:          http.MethodDelete,
		Model:           task.Model,
		Channel:         channel,
		UserID:          task.UserID,
		UserDisplayName: task.UserDisplayName,
		RequestBody:     fmt.Sprintf(`{"taskId":%q}`, taskID),
	}
	payload, status, err := doAIRequestWithLimit(request, channel, videoTaskCancelResponseLimit)
	responseBody := service.RedactSensitiveText(string(payload))
	if err != nil {
		saveAIProxyLog(logContext, status, responseBody, service.RedactSensitiveText(err.Error()))
		return true, err
	}
	if status == http.StatusNotFound {
		saveAIProxyLog(logContext, status, responseBody, "")
		return true, nil
	}
	if status >= http.StatusBadRequest {
		message := readUpstreamAIErrorMessage(payload, status)
		saveAIProxyLog(logContext, status, responseBody, message)
		return true, errors.New(message)
	}
	saveAIProxyLog(logContext, status, responseBody, "")
	return true, nil
}

func newUpstreamVideoCancelRequest(ctx context.Context, task model.VideoTask, channel model.ModelChannel) (*http.Request, bool, error) {
	if service.NormalizeVideoTaskStatus(task.Status) != "queued" {
		return nil, false, nil
	}
	taskID := firstNonEmpty(task.UpstreamTaskID, task.UpstreamVideoID)
	if taskID == "" {
		return nil, false, nil
	}
	endpoint := ""
	switch {
	case strings.EqualFold(strings.TrimSpace(channel.Protocol), "volcengine") && isArkSeedanceVideo(channel.BaseURL, task.Model):
		endpoint = "/contents/generations/tasks/" + url.PathEscape(taskID)
	case isMiniMaxH3Channel(channel, task.Model):
		endpoint = "/v2/video_generation/" + url.PathEscape(taskID)
	default:
		return nil, false, nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, service.BuildModelChannelURL(channel, endpoint), nil)
	if err != nil {
		return nil, true, err
	}
	service.SetModelChannelAuthHeader(request, channel)
	return request, true, nil
}

func proxyAIVideoTaskRequest(w http.ResponseWriter, r *http.Request) {
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
	releaseSlot, ok := reserveGenerationTaskSlot(w, r, user.ID)
	if !ok {
		return
	}
	defer releaseSlot()
	channel, userChannelID, err := selectAIRequestChannel(user, modelName, r.Header.Get("X-Model-Channel-ID"), r.Header.Get(userModelChannelHeader))
	if err != nil {
		log.Printf("AI video select channel failed: model=%s err=%v", modelName, err)
		failAIChannelSelect(w, err, "AI 接口请求失败")
		return
	}
	credits := 0
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
		Fail(w, "AI 接口请求失败")
		return
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, service.BuildModelChannelURL(channel, upstreamPath), bytes.NewReader(body))
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
	if credits > 0 {
		if err := service.ConsumeUserCredits(user.ID, modelName, credits, upstreamPath); err != nil {
			FailError(w, err)
			return
		}
	}
	payload, status, err := doAIRequest(request, channel)
	if err != nil {
		if credits > 0 {
			refundVideoCredits(user.ID, modelName, credits, upstreamPath)
		}
		saveAIProxyLog(logContext, 0, "", err.Error())
		Fail(w, "AI 接口请求失败")
		return
	}
	if status >= http.StatusBadRequest {
		message := readUpstreamAIErrorMessage(payload, status)
		if credits > 0 {
			refundVideoCredits(user.ID, modelName, credits, upstreamPath)
		}
		saveAIProxyLog(logContext, status, string(payload), strings.TrimSpace(string(payload)))
		Fail(w, message)
		return
	}
	transformed := transformVideoCreatePayload(payload, request, channel, modelName)
	if message := readVideoCreateErrorMessage(payload, transformed, channel, modelName); message != "" {
		if credits > 0 {
			refundVideoCredits(user.ID, modelName, credits, upstreamPath)
		}
		saveAIProxyLog(logContext, status, string(payload), message)
		Fail(w, message)
		return
	}
	parsed := parseVideoTaskPayload(transformed, modelName)
	if parsed.UpstreamTaskID == "" && parsed.UpstreamVideoID == "" {
		if credits > 0 {
			refundVideoCredits(user.ID, modelName, credits, upstreamPath)
		}
		saveAIProxyLog(logContext, status, string(transformed), "视频接口没有返回任务 ID")
		Fail(w, "视频接口没有返回任务 ID")
		return
	}
	task, err := service.CreateVideoTask(service.VideoTaskCreateInput{
		UserID:          user.ID,
		UserDisplayName: firstNonEmpty(user.DisplayName, user.Username),
		Model:           modelName,
		ChannelID:       channel.ID,
		UserChannelID:   userChannelID,
		ChannelName:     channel.Name,
		Source:          readVideoTaskSource(r),
		SourceID:        readVideoTaskSourceID(r),
		ClientTaskID:    readClientVideoTaskID(r),
		UpstreamTaskID:  parsed.UpstreamTaskID,
		UpstreamVideoID: parsed.UpstreamVideoID,
		Status:          parsed.Status,
		Progress:        parsed.Progress,
		Seconds:         parsed.Seconds,
		Size:            parsed.Size,
		VideoURL:        parsed.VideoURL,
		Error:           parsed.Error,
		ErrorDetail:     parsed.ErrorDetail,
		RequestBody:     logContext.RequestBody,
		ResponseBody:    string(transformed),
		Credits:         credits,
	})
	if err != nil {
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
	var channel model.ModelChannel
	if strings.TrimSpace(task.UserChannelID) != "" {
		channel, err = service.SelectUserLocalModelChannelForModel(task.UserID, task.Model, task.UserChannelID)
	} else {
		channel, err = service.SelectModelChannelForModel(task.Model, task.ChannelID)
	}
	if err != nil || !service.IsGeminiChannel(channel) {
		return false
	}
	if strings.TrimSpace(task.VideoURL) == "" {
		Fail(w, "Gemini Veo 任务完成但没有返回视频地址")
		return true
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, task.VideoURL, nil)
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
	if response.ContentLength > generatedMediaResponseLimit {
		Fail(w, "视频内容超过 512 MiB 限制")
		return true
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.WriteHeader(response.StatusCode)
	_, exceeded, _ := copyLimitedUpstreamResponse(w, response.Body, generatedMediaResponseLimit)
	if exceeded {
		log.Printf("Gemini video content exceeded 512 MiB limit: task=%s", task.ID)
	}
	return true
}

func pollVideoTaskFromUpstream(task model.VideoTask) (service.VideoTaskPollUpdate, error) {
	if message := videoTaskPollBudgetError(task, time.Now()); message != "" {
		return service.VideoTaskPollUpdate{Status: videoTaskPollBudgetStatus(message), Error: message, ErrorDetail: message}, nil
	}
	channel, err := videoTaskChannel(task)
	if err != nil {
		return service.VideoTaskPollUpdate{}, err
	}
	pollID := firstNonEmpty(task.UpstreamTaskID, task.ID)
	if isAgnesVideoModel(task.Model) && strings.HasPrefix(task.UpstreamVideoID, "video_") {
		pollID = task.UpstreamVideoID
	}
	if strings.TrimSpace(pollID) == "" {
		return service.VideoTaskPollUpdate{}, errors.New("视频任务缺少上游任务 ID")
	}
	endpoint := "/videos/" + pollID
	upstreamPath := resolveAIProxyPath(channel, task.Model, endpoint)
	createdAt, _ := time.Parse(time.RFC3339Nano, strings.TrimSpace(task.CreatedAt))
	pollContext, cancel := context.WithDeadline(context.Background(), createdAt.Add(videoTaskDeadline))
	defer cancel()
	videoTaskPollCancels.Store(task.ID, context.CancelFunc(cancel))
	defer videoTaskPollCancels.Delete(task.ID)
	request, err := http.NewRequestWithContext(pollContext, http.MethodGet, resolveAIProxyURL(channel, task.Model, upstreamPath), nil)
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
	remainingBytes := videoTaskResponseByteLimit - task.ResponseBytes
	perResponseLimit := min(videoTaskResponseLimit, remainingBytes)
	payload, status, err := doAIRequestWithLimit(request, channel, perResponseLimit)
	if err != nil {
		saveAIProxyLog(logContext, status, "", err.Error())
		if len(payload) > 0 {
			message := "视频任务上游响应读取失败"
			if task.ResponseBytes+int64(len(payload)) > videoTaskResponseByteLimit {
				message = "视频任务上游累计响应超过 32 MiB 限制"
			}
			return service.VideoTaskPollUpdate{Status: "failed", Error: message, ErrorDetail: service.RedactSensitiveText(err.Error()), ResponseBytes: int64(len(payload)), PollRequests: 1}, nil
		}
		return service.VideoTaskPollUpdate{Status: task.Status, ErrorDetail: service.RedactSensitiveText(err.Error()), PollRequests: 1}, nil
	}
	if status >= http.StatusBadRequest {
		message := readUpstreamAIErrorMessage(payload, status)
		saveAIProxyLog(logContext, status, string(payload), strings.TrimSpace(string(payload)))
		if status == http.StatusTooManyRequests {
			return service.VideoTaskPollUpdate{Status: task.Status, ErrorDetail: message, ResponseBody: string(payload), ResponseBytes: int64(len(payload)), PollRequests: 1}, nil
		}
		return service.VideoTaskPollUpdate{Status: "failed", Error: message, ErrorDetail: message, ResponseBody: service.RedactSensitiveText(string(payload)), ResponseBytes: int64(len(payload)), PollRequests: 1}, nil
	}
	transformed := transformVideoStatusPayload(payload, request, channel, task.Model)
	parsed := parseVideoTaskPayload(transformed, task.Model)
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
		parsed.ErrorDetail = service.RedactSensitiveText(string(payload))
	}
	saveAIProxyLog(logContext, status, string(transformed), firstNonEmpty(parsed.Error, ""))
	return service.VideoTaskPollUpdate{
		Status:        parsed.Status,
		Progress:      parsed.Progress,
		Seconds:       parsed.Seconds,
		Size:          parsed.Size,
		VideoURL:      parsed.VideoURL,
		Error:         parsed.Error,
		ErrorDetail:   parsed.ErrorDetail,
		ResponseBody:  string(transformed),
		ResponseBytes: int64(len(payload)),
		PollRequests:  1,
	}, nil
}

func videoTaskPollBudgetStatus(message string) string {
	if strings.Contains(message, "deadline") || strings.Contains(message, "创建时间无效") {
		return "timed_out"
	}
	return "failed"
}

func videoTaskPollBudgetError(task model.VideoTask, current time.Time) string {
	if task.PollCount >= videoTaskPollCountLimit {
		return "视频任务轮询超过 360 次限制"
	}
	if task.ResponseBytes >= videoTaskResponseByteLimit {
		return "视频任务上游累计响应超过 32 MiB 限制"
	}
	createdAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(task.CreatedAt))
	if err != nil {
		return "视频任务创建时间无效，已停止轮询"
	}
	if current.Sub(createdAt) >= videoTaskDeadline {
		return "视频任务轮询超过 30 分钟总体 deadline"
	}
	return ""
}

func normalizeVideoCreateBody(body []byte, contentType string, modelName string, channel model.ModelChannel, upstreamPath string) ([]byte, string, error) {
	if service.IsGeminiChannel(channel) {
		normalized, err := service.StripGeminiModelField(body, contentType)
		return normalized, contentType, err
	}
	if isKIEChannel(channel, modelName) && upstreamPath == "/jobs/createTask" {
		return normalizeKIEVideoBody(body, contentType, modelName, channel)
	}
	if isAPIMartChannel(channel, modelName) && upstreamPath == "/videos/generations" {
		return normalizeAPIMartVideoBody(body, contentType, modelName, channel)
	}
	return body, contentType, nil
}

func doAIRequest(request *http.Request, channel model.ModelChannel) ([]byte, int, error) {
	return doAIRequestWithLimit(request, channel, videoTaskResponseLimit)
}

func doAIRequestWithLimit(request *http.Request, channel model.ModelChannel, limit int64) ([]byte, int, error) {
	if limit <= 0 {
		return nil, 0, errors.New("AI 上游响应读取预算已耗尽")
	}
	response, err := service.HTTPClientForChannel(channel).Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	payload, readErr := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if readErr != nil {
		return payload, response.StatusCode, readErr
	}
	if int64(len(payload)) > limit {
		return payload, response.StatusCode, fmt.Errorf("AI 上游单次响应超过 %s 限制", formatByteLimit(limit))
	}
	return payload, response.StatusCode, nil
}

func transformVideoCreatePayload(payload []byte, request *http.Request, channel model.ModelChannel, modelName string) []byte {
	if service.IsGeminiChannel(channel) {
		if transformed, ok := transformGeminiVideoTaskResponse(payload); ok {
			return transformed
		}
	}
	if isKIEChannel(channel, modelName) && strings.Contains(request.URL.Path, "/jobs/createTask") {
		if transformed, ok := transformKIECreateVideoResponse(payload, modelName); ok {
			return transformed
		}
	}
	if isAPIMartChannel(channel, modelName) && strings.Contains(request.URL.Path, "/videos/generations") {
		if transformed, ok := transformAPIMartCreateVideoResponse(payload, modelName); ok {
			return transformed
		}
	}
	return payload
}

func transformVideoStatusPayload(payload []byte, request *http.Request, channel model.ModelChannel, modelName string) []byte {
	if service.IsGeminiChannel(channel) {
		if transformed, ok := transformGeminiVideoTaskResponse(payload); ok {
			return transformed
		}
	}
	if isMiniMaxH3Channel(channel, modelName) && strings.Contains(request.URL.Path, "/v2/query/video_generation/") {
		if transformed, ok := transformMiniMaxVideoTaskResponse(payload); ok {
			return transformed
		}
	}
	if isKIEChannel(channel, modelName) && strings.Contains(request.URL.Path, "/jobs/recordInfo") {
		if transformed, ok := transformKIETaskResponse(payload, modelName); ok {
			return transformed
		}
	}
	if isAPIMartChannel(channel, modelName) && strings.Contains(request.URL.Path, "/tasks/") {
		if transformed, ok := transformAPIMartTaskResponse(payload, modelName); ok {
			return transformed
		}
	}
	return payload
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
	if isKIEChannel(channel, modelName) {
		return firstNonEmpty(readKIECreateTaskErrorMessage(raw), readProviderPayloadError(raw), readNormalizedVideoError(transformed))
	}
	return firstNonEmpty(readProviderPayloadError(raw), readNormalizedVideoError(transformed))
}

func readVideoStatusErrorMessage(raw []byte, transformed []byte, channel model.ModelChannel, modelName string) string {
	if isKIEChannel(channel, modelName) {
		return firstNonEmpty(readKIERecordInfoErrorMessage(raw), readProviderPayloadError(raw), readNormalizedVideoError(transformed))
	}
	return firstNonEmpty(readProviderPayloadError(raw), readNormalizedVideoError(transformed))
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
	if result.UpstreamVideoID == "" && isAgnesVideoModel(modelName) && strings.HasPrefix(result.VideoURL, "video_") {
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

func refundVideoCredits(userID string, modelName string, credits int, endpoint string) {
	if err := service.RefundUserCredits(userID, modelName, credits, endpoint); err != nil {
		log.Printf("AI video refund credits failed: user=%s model=%s credits=%d err=%v", userID, modelName, credits, err)
	}
}
