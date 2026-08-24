package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

const userModelChannelHeader = "X-User-Model-Channel-ID"

const (
	maxAIRequestBytes  = 128 * 1024 * 1024
	maxAIResponseBytes = 512 * 1024 * 1024
)

func selectAIRequestChannel(user model.AuthUser, modelName string, channelID string, userChannelID string) (model.ModelChannel, string, error) {
	userChannelID = strings.TrimSpace(userChannelID)
	if userChannelID != "" {
		channel, err := service.SelectUserLocalModelChannelForModel(user.ID, modelName, userChannelID)
		return channel, userChannelID, err
	}
	if !service.UserCanUseRemoteModelChannel(user) {
		return model.ModelChannel{}, "", fmt.Errorf("当前账号未开放云端渠道")
	}
	channel, err := service.SelectModelChannelForModel(modelName, channelID)
	return channel, "", err
}

func failAIChannelSelect(w http.ResponseWriter, err error, fallback string) {
	message := strings.TrimSpace(err.Error())
	switch message {
	case "当前账号未开放云端渠道", "请先登录", "缺少模型名称", "缺少模型渠道", "本地渠道不存在", "本地渠道配置不完整", "本地渠道不支持该模型", "指定模型渠道不可用", "指定渠道不可用", "渠道 API Key 未配置":
		Fail(w, message)
	default:
		Fail(w, fallback)
	}
}

func AIImagesGenerations(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/images/generations")
}

func AIImagesEdits(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/images/edits")
}

func AIChatCompletions(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/chat/completions")
}

func AIResponses(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/responses")
}

func AIVideos(w http.ResponseWriter, r *http.Request) {
	proxyAIVideoTaskRequest(w, r)
}

func AIVideo(w http.ResponseWriter, r *http.Request, id string) {
	if serveAIVideoTask(w, r, id) {
		return
	}
	if isClientVideoTaskID(id) {
		OK(w, map[string]any{"id": id, "task_id": id, "object": "video", "status": "queued", "progress": 0})
		return
	}
	proxyAIGetRequest(w, r, "/videos/"+id)
}

func AIVideoContent(w http.ResponseWriter, r *http.Request, id string) {
	if serveGeminiVideoTaskContent(w, r, id) {
		return
	}
	proxyAIGetRequest(w, r, "/videos/"+id+"/content")
}

func AIAudioSpeech(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/audio/speech")
}

func AITTSVoices(w http.ResponseWriter, r *http.Request) {
	modelName := strings.TrimSpace(r.URL.Query().Get("model"))
	if modelName == "" {
		Fail(w, "缺少模型名称")
		return
	}
	proxyAIGetRequest(w, r, "/tts/voices?model="+url.QueryEscape(modelName))
}

func proxyAIGetRequest(w http.ResponseWriter, r *http.Request, path string) {
	startedAt := time.Now()
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	modelName := r.URL.Query().Get("model")
	if strings.TrimSpace(modelName) == "" {
		modelName = "Agnes-Video-V2.0"
	}
	channel, _, err := selectAIRequestChannel(user, modelName, r.Header.Get("X-Model-Channel-ID"), r.Header.Get(userModelChannelHeader))
	if err != nil {
		log.Printf("AI proxy select channel failed: model=%s err=%v", modelName, err)
		failAIChannelSelect(w, err, "AI 接口请求失败")
		return
	}
	upstreamPath := resolveAIProxyPath(channel, modelName, path)
	request, err := http.NewRequest(http.MethodGet, resolveAIProxyURL(channel, modelName, upstreamPath), nil)
	if err != nil {
		Fail(w, "AI 接口请求失败")
		return
	}
	service.SetModelChannelAuthHeader(request, channel)
	copyAIResponse(w, request, channel, aiLogContext{StartedAt: startedAt, Endpoint: path, Method: http.MethodGet, Model: modelName, Channel: channel, UserID: user.ID, UserDisplayName: firstNonEmpty(user.DisplayName, user.Username), RequestBody: summarizeQueryParams(r.URL.Query())}, nil)
}

func proxyAIRequest(w http.ResponseWriter, r *http.Request, path string) {
	startedAt := time.Now()
	body, contentType, modelName, err := readAIRequest(r)
	if err != nil {
		log.Printf("AI proxy request read failed: %v", err)
		Fail(w, "AI 接口请求失败")
		return
	}
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	channel, userChannelID, err := selectAIRequestChannel(user, modelName, r.Header.Get("X-Model-Channel-ID"), r.Header.Get(userModelChannelHeader))
	if err != nil {
		log.Printf("AI proxy select channel failed: model=%s err=%v", modelName, err)
		failAIChannelSelect(w, err, "AI 接口请求失败")
		return
	}
	credits := 0
	if userChannelID == "" {
		credits, err = service.ModelCost(modelName)
		if err != nil {
			log.Printf("AI proxy read model cost failed: model=%s err=%v", modelName, err)
			Fail(w, "AI 接口请求失败")
			return
		}
		credits *= readAIRequestCount(body, contentType)
	}
	upstreamPath := resolveAIProxyPath(channel, modelName, path)
	if service.IsGeminiChannel(channel) {
		if path == "/chat/completions" && !geminiStreamRequested(body) {
			upstreamPath = service.GeminiModelActionPath(modelName, "generateContent")
		}
		body, err = service.StripGeminiModelField(body, contentType)
		if err != nil {
			log.Printf("AI proxy normalize Gemini request failed: model=%s err=%v", modelName, err)
			Fail(w, "AI 接口请求失败")
			return
		}
	}
	if service.IsMiMoTTSModelName(modelName) && path == "/audio/speech" {
		body, contentType, err = normalizeMiMoTTSBody(body, contentType, modelName)
		if err != nil {
			log.Printf("AI proxy normalize MiMo TTS request failed: model=%s err=%v", modelName, err)
			Fail(w, err.Error())
			return
		}
	} else if isKIEChannel(channel, modelName) && isKIECreateTaskPath(upstreamPath) {
		body, contentType, err = normalizeKIEVideoBody(body, contentType, modelName, channel)
		if err != nil {
			log.Printf("AI proxy normalize KIE request failed: model=%s err=%v", modelName, err)
			Fail(w, "AI 接口请求失败")
			return
		}
	} else if isAPIMartChannel(channel, modelName) && upstreamPath == "/videos/generations" {
		body, contentType, err = normalizeAPIMartVideoBody(body, contentType, modelName, channel)
		if err != nil {
			log.Printf("AI proxy normalize APIMart video request failed: model=%s err=%v", modelName, err)
			Fail(w, "AI 接口请求失败")
			return
		}
	} else if isAPIMartChannel(channel, modelName) && (upstreamPath == "/images/generations" || upstreamPath == "/images/edits") {
		body, contentType, err = normalizeAPIMartImageBody(body, contentType, modelName, channel)
		if err != nil {
			log.Printf("AI proxy normalize APIMart image request failed: model=%s err=%v", modelName, err)
			Fail(w, "AI 接口请求失败")
			return
		}
	}
	request, err := http.NewRequest(http.MethodPost, service.BuildModelChannelURL(channel, upstreamPath), bytes.NewReader(body))
	if err != nil {
		log.Printf("AI proxy build request failed: url=%s err=%v", service.BuildModelChannelURL(channel, upstreamPath), err)
		Fail(w, "AI 接口请求失败")
		return
	}
	service.SetModelChannelAuthHeader(request, channel)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	if credits > 0 {
		if err := service.ConsumeUserCredits(user.ID, modelName, credits, upstreamPath); err != nil {
			FailError(w, err)
			return
		}
	}
	copyAIResponse(w, request, channel, aiLogContext{
		StartedAt:       startedAt,
		Endpoint:        path,
		Method:          http.MethodPost,
		Model:           modelName,
		Channel:         channel,
		UserID:          user.ID,
		UserDisplayName: firstNonEmpty(user.DisplayName, user.Username),
		Credits:         credits,
		RequestBody:     summarizeAIRequest(body, contentType),
	}, func() {
		if credits > 0 {
			if err := service.RefundUserCredits(user.ID, modelName, credits, upstreamPath); err != nil {
				log.Printf("AI proxy refund credits failed: user=%s model=%s credits=%d err=%v", user.ID, modelName, credits, err)
			}
		}
	})
}

func geminiStreamRequested(body []byte) bool {
	var payload struct {
		Stream *bool `json:"stream"`
	}
	return json.Unmarshal(body, &payload) == nil && payload.Stream != nil && *payload.Stream
}

type aiLogContext struct {
	StartedAt       time.Time
	Endpoint        string
	Method          string
	Model           string
	Channel         model.ModelChannel
	UserID          string
	UserDisplayName string
	Credits         int
	RequestBody     string
}

func copyAIResponse(w http.ResponseWriter, request *http.Request, channel model.ModelChannel, logContext aiLogContext, onFailure func()) {
	response, err := service.HTTPClientForChannel(channel).Do(request)
	if err != nil {
		log.Printf("AI proxy request failed: url=%s err=%v", request.URL.String(), err)
		if onFailure != nil {
			onFailure()
		}
		saveAIProxyLog(logContext, 0, "", err.Error())
		Fail(w, "AI 接口请求失败")
		return
	}
	defer response.Body.Close()

	if response.StatusCode >= http.StatusBadRequest {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 256*1024))
		log.Printf("AI upstream error: url=%s status=%d body=%s", request.URL.String(), response.StatusCode, strings.TrimSpace(string(payload)))
		if onFailure != nil {
			onFailure()
		}
		saveAIProxyLog(logContext, response.StatusCode, string(payload), strings.TrimSpace(string(payload)))
		Fail(w, readUpstreamAIErrorMessage(payload, response.StatusCode))
		return
	}
	if unsafeAIResponseContentType(response.Header.Get("Content-Type")) {
		if onFailure != nil {
			onFailure()
		}
		saveAIProxyLog(logContext, response.StatusCode, "", "上游返回了不安全的内容类型")
		Fail(w, "AI 接口返回了不安全的内容类型")
		return
	}
	if response.ContentLength > maxAIResponseBytes {
		if onFailure != nil {
			onFailure()
		}
		saveAIProxyLog(logContext, response.StatusCode, "", "上游响应超过 512 MiB 限制")
		Fail(w, "AI 接口响应过大")
		return
	}

	if copyMiMoTTSResponse(w, response, logContext, onFailure) {
		return
	}
	if copyKIEVideoResponse(w, response, request, channel, logContext, onFailure) {
		return
	}
	if isAPIMartChannel(channel, logContext.Model) {
		if copyAPIMartImageResponse(w, response, request, channel, logContext, onFailure) {
			return
		}
		if copyAPIMartVideoResponse(w, response, request, channel, logContext, onFailure) {
			return
		}
	}

	for key, values := range response.Header {
		if strings.EqualFold(key, "Content-Length") || strings.EqualFold(key, "Set-Cookie") || strings.EqualFold(key, "Location") {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	if strings.TrimSpace(w.Header().Get("Content-Type")) == "" {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(response.StatusCode)
	responseBody, exceeded := copyAIResponseBody(w, response.Body)
	if exceeded {
		saveAIProxyLog(logContext, response.StatusCode, responseBody, "上游响应超过 512 MiB 限制")
		return
	}
	saveAIProxyLog(logContext, response.StatusCode, responseBody, "")
}

func copyAIResponseBody(w http.ResponseWriter, body io.Reader) (string, bool) {
	flusher, canFlush := w.(http.Flusher)
	buffer := make([]byte, 32*1024)
	var logBuffer strings.Builder
	var total int64
	for {
		remaining := int64(maxAIResponseBytes) - total
		readBuffer := buffer
		if remaining < int64(len(buffer)) {
			readBuffer = buffer[:remaining+1]
		}
		n, err := body.Read(readBuffer)
		if n > 0 {
			writeBytes := n
			exceeded := int64(n) > remaining
			if exceeded {
				writeBytes = int(remaining)
			}
			if writeBytes > 0 {
				if _, writeErr := w.Write(buffer[:writeBytes]); writeErr != nil {
					return logBuffer.String(), false
				}
				total += int64(writeBytes)
			}
			if logBuffer.Len() < 64*1024 && writeBytes > 0 {
				_, _ = logBuffer.Write(buffer[:min(writeBytes, 64*1024-logBuffer.Len())])
			}
			if canFlush && writeBytes > 0 {
				flusher.Flush()
			}
			if exceeded {
				return logBuffer.String(), true
			}
		}
		if err != nil {
			return logBuffer.String(), false
		}
	}
}

func unsafeAIResponseContentType(contentType string) bool {
	contentType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	return contentType == "text/html" || contentType == "application/xhtml+xml" || contentType == "image/svg+xml" || contentType == "text/xml" || contentType == "application/xml"
}

func saveAIProxyLog(context aiLogContext, status int, responseBody string, errorMessage string) {
	if context.StartedAt.IsZero() {
		context.StartedAt = time.Now()
	}
	if service.IsGeminiChannel(context.Channel) {
		if context.Endpoint == "/images/generations" || context.Endpoint == "/images/edits" || context.Endpoint == "/audio/speech" {
			responseBody = "[redacted Gemini media response]"
		} else if strings.TrimSpace(responseBody) != "" {
			responseBody = summarizeAIRequest([]byte(responseBody), "application/json")
		}
	}
	service.SaveAICallLog(service.AICallLogInput{
		UserID:          context.UserID,
		UserDisplayName: context.UserDisplayName,
		Endpoint:        context.Endpoint,
		Method:          context.Method,
		Model:           context.Model,
		ChannelID:       context.Channel.ID,
		ChannelName:     context.Channel.Name,
		Status:          status,
		DurationMs:      time.Since(context.StartedAt).Milliseconds(),
		Credits:         context.Credits,
		RequestBody:     context.RequestBody,
		ResponseBody:    responseBody,
		Error:           errorMessage,
	})
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func summarizeAIRequest(body []byte, contentType string) string {
	if strings.HasPrefix(contentType, "multipart/form-data") {
		return summarizeMultipartAIRequest(body, contentType)
	}
	var payload any
	if err := json.Unmarshal(body, &payload); err == nil {
		redactLargeImages(&payload)
		if encoded, err := json.MarshalIndent(payload, "", "  "); err == nil {
			return string(encoded)
		}
	}
	return string(body)
}

func summarizeQueryParams(values map[string][]string) string {
	if len(values) == 0 {
		return ""
	}
	encoded, _ := json.MarshalIndent(values, "", "  ")
	return string(encoded)
}

func summarizeMultipartAIRequest(body []byte, contentType string) string {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return "multipart/form-data"
	}
	form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
	if err != nil {
		return "multipart/form-data"
	}
	defer form.RemoveAll()
	summary := map[string]any{"fields": form.Value}
	files := []map[string]any{}
	for field, headers := range form.File {
		for _, header := range headers {
			files = append(files, map[string]any{"field": field, "filename": header.Filename, "size": header.Size, "contentType": header.Header.Get("Content-Type")})
		}
	}
	summary["files"] = files
	encoded, _ := json.MarshalIndent(summary, "", "  ")
	return string(encoded)
}

func readUpstreamAIErrorMessage(body []byte, statusCode int) string {
	var payload struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Msg     string `json:"msg"`
		Message string `json:"message"`
	}
	if len(body) > 0 && json.Unmarshal(body, &payload) == nil {
		if payload.Error != nil && strings.TrimSpace(payload.Error.Message) != "" {
			return payload.Error.Message
		}
		if strings.TrimSpace(payload.Msg) != "" {
			return payload.Msg
		}
		if strings.TrimSpace(payload.Message) != "" {
			return payload.Message
		}
	}
	if statusCode > 0 {
		return fmt.Sprintf("AI 接口请求失败：%d", statusCode)
	}
	return "AI 接口请求失败"
}

func redactLargeImages(value *any) {
	switch typed := (*value).(type) {
	case map[string]any:
		for key, item := range typed {
			if text, ok := item.(string); ok && (strings.HasPrefix(text, "data:image/") || strings.HasPrefix(text, "data:video/") || strings.HasPrefix(text, "data:audio/") || len(text) > 2048 && looksLikeBase64(text)) {
				typed[key] = fmt.Sprintf("[redacted media/string len=%d]", len(text))
				continue
			}
			redactLargeImages(&item)
			typed[key] = item
		}
	case []any:
		for index, item := range typed {
			redactLargeImages(&item)
			typed[index] = item
		}
	}
}

func looksLikeBase64(value string) bool {
	for _, char := range value[:min(len(value), 200)] {
		if !(char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '+' || char == '/' || char == '=') {
			return false
		}
	}
	return true
}

func readAIRequest(r *http.Request) ([]byte, string, string, error) {
	contentType := r.Header.Get("Content-Type")
	body, err := io.ReadAll(io.LimitReader(r.Body, maxAIRequestBytes+1))
	if err != nil {
		return nil, "", "", err
	}
	if len(body) > maxAIRequestBytes {
		return nil, "", "", errors.New("AI 请求超过 128 MiB 限制")
	}
	modelName := ""
	if strings.HasPrefix(contentType, "multipart/form-data") {
		modelName = readMultipartModel(body, contentType)
	} else {
		var payload struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(body, &payload)
		modelName = payload.Model
	}
	if strings.TrimSpace(modelName) == "" {
		return nil, "", "", errMissingModel
	}
	return body, contentType, modelName, nil
}

func readMultipartModel(body []byte, contentType string) string {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return ""
	}
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	form, err := reader.ReadForm(32 << 20)
	if err != nil {
		return ""
	}
	defer form.RemoveAll()
	if values := form.Value["model"]; len(values) > 0 {
		return values[0]
	}
	return ""
}

func readAIRequestCount(body []byte, contentType string) int {
	count := 1
	if strings.HasPrefix(contentType, "multipart/form-data") {
		_, params, err := mime.ParseMediaType(contentType)
		if err != nil {
			return count
		}
		form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
		if err != nil {
			return count
		}
		defer form.RemoveAll()
		if values := form.Value["n"]; len(values) > 0 {
			_, _ = fmt.Sscan(values[0], &count)
		}
	} else {
		var payload struct {
			N int `json:"n"`
		}
		_ = json.Unmarshal(body, &payload)
		count = payload.N
	}
	if count < 1 {
		return 1
	}
	return count
}

func resolveAIProxyURL(channel model.ModelChannel, modelName string, path string) string {
	if videoID, ok := agnesVideoQueryID(modelName, path); ok {
		baseURL := strings.TrimRight(strings.TrimSpace(channel.BaseURL), "/")
		if strings.HasSuffix(strings.ToLower(baseURL), "/v1") {
			baseURL = strings.TrimRight(baseURL[:len(baseURL)-len("/v1")], "/")
		}
		values := url.Values{}
		values.Set("video_id", videoID)
		values.Set("model_name", modelName)
		return baseURL + "/agnesapi?" + values.Encode()
	}
	return service.BuildModelChannelURL(channel, path)
}

func agnesVideoQueryID(modelName string, path string) (string, bool) {
	if !isAgnesVideoModel(modelName) || !strings.HasPrefix(path, "/videos/") || strings.HasSuffix(path, "/content") {
		return "", false
	}
	id := strings.TrimPrefix(path, "/videos/")
	if strings.HasPrefix(id, "video_") {
		return id, true
	}
	return "", false
}

func resolveAIProxyPath(channel model.ModelChannel, modelName string, path string) string {
	if service.IsGeminiChannel(channel) {
		switch path {
		case "/chat/completions":
			return service.GeminiModelActionPath(modelName, "streamGenerateContent") + "?alt=sse"
		case "/images/generations", "/images/edits", "/audio/speech":
			return service.GeminiModelActionPath(modelName, "generateContent")
		case "/videos":
			return service.GeminiModelActionPath(modelName, "predictLongRunning")
		}
		if strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content") {
			return service.GeminiOperationPath(strings.TrimPrefix(path, "/videos/"))
		}
	}
	if service.IsMiMoTTSModelName(modelName) && path == "/audio/speech" {
		return "/chat/completions"
	}
	if isMiniMaxH3Channel(channel, modelName) {
		if path == "/videos" {
			return "/v2/video_generation"
		}
		if strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content") {
			taskID := strings.TrimSpace(strings.TrimPrefix(path, "/videos/"))
			if taskID != "" && !strings.Contains(taskID, "/") {
				return "/v2/query/video_generation/" + url.PathEscape(taskID)
			}
		}
		return path
	}
	if isCogVideoX3Model(modelName) {
		if path == "/videos" {
			return "/videos/generations"
		}
		if strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content") {
			taskID := strings.TrimSpace(strings.TrimPrefix(path, "/videos/"))
			if taskID != "" && !strings.Contains(taskID, "/") {
				return "/async-result/" + url.PathEscape(taskID)
			}
		}
		return path
	}
	if isKIEChannel(channel, modelName) {
		if path == "/images/generations" && strings.EqualFold(strings.TrimSpace(modelName), "grok-imagine-image-2-0/text-to-image") {
			return "/client/tasks"
		}
		if path == "/videos" || path == "/images/generations" || path == "/images/edits" {
			return "/jobs/createTask"
		}
		if strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content") {
			taskID := strings.TrimSpace(strings.TrimPrefix(path, "/videos/"))
			if taskID != "" && !strings.Contains(taskID, "/") {
				return "/jobs/recordInfo?taskId=" + url.QueryEscape(taskID)
			}
		}
		return path
	}
	if isAPIMartChannel(channel, modelName) {
		if path == "/videos" {
			return "/videos/generations"
		}
		if path == "/images/edits" {
			model := normalizeAPIMartModelName(modelName)
			if strings.Contains(model, "grok-imagine") && strings.Contains(model, "edit") {
				return path
			}
			return "/images/generations"
		}
		if strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content") {
			taskID := strings.TrimSpace(strings.TrimPrefix(path, "/videos/"))
			if taskID != "" && !strings.Contains(taskID, "/") {
				return "/tasks/" + url.PathEscape(taskID) + "?language=zh"
			}
		}
		return path
	}
	if strings.EqualFold(strings.TrimSpace(channel.Protocol), "grok2api") && (strings.EqualFold(strings.TrimSpace(modelName), "grok-imagine-video") || strings.EqualFold(strings.TrimSpace(modelName), "grok-imagine-video-1.5")) && path == "/videos" {
		return "/videos/generations"
	}
	if isArkSeedanceVideo(channel.BaseURL, modelName) {
		if path == "/videos" {
			return "/contents/generations/tasks"
		}
		if strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content") {
			return "/contents/generations/tasks/" + strings.TrimPrefix(path, "/videos/")
		}
	}
	return path
}

func isCogVideoX3Model(modelName string) bool {
	return strings.EqualFold(strings.TrimSpace(modelName), "cogvideox-3")
}

func isArkSeedanceVideo(baseURL string, modelName string) bool {
	base := strings.ToLower(baseURL)
	model := strings.ToLower(modelName)
	return strings.Contains(model, "seedance") || strings.Contains(model, "doubao-seedance") || strings.Contains(base, "/api/plan/v3")
}

func isAgnesVideoModel(modelName string) bool {
	return strings.Contains(strings.ToLower(strings.TrimSpace(modelName)), "agnes-video")
}

var errMissingModel = &aiError{"缺少模型名称"}

type aiError struct {
	message string
}

func (err *aiError) Error() string {
	return err.message
}
