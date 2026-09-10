package handler

import (
	"github.com/tigerowo/infinite-canvas/extensions/newapi"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func serveNewAPIVideoTaskContent(w http.ResponseWriter, r *http.Request, id string) bool {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		return false
	}
	task, found, err := service.GetUserVideoTask(user.ID, strings.TrimSpace(id))
	if err != nil || !found {
		return false
	}
	channel, err := selectVideoTaskChannel(task)
	if err != nil {
		Fail(w, "视频任务渠道不可用")
		return true
	}
	if !service.IsNewAPIChannel(channel) {
		return false
	}
	if task.UpstreamTaskID == "" {
		Fail(w, "视频任务缺少 NewAPI 任务 ID")
		return true
	}
	path := "/videos/" + url.PathEscape(task.UpstreamTaskID) + "/content"
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, service.BuildModelChannelURL(channel, path), nil)
	if err != nil {
		Fail(w, "视频内容请求无效")
		return true
	}
	service.SetModelChannelAuthHeader(request, channel)
	for _, key := range []string{"Range", "If-Range"} {
		if value := r.Header.Get(key); value != "" {
			request.Header.Set(key, value)
		}
	}
	copyAIResponse(w, request, channel, aiLogContext{StartedAt: time.Now(), Endpoint: path, Method: http.MethodGet, Model: task.Model, Channel: channel, UserID: user.ID}, nil)
	return true
}

func parseChannelVideoTaskPayload(payload []byte, modelName string, channel model.ModelChannel) parsedVideoTaskPayload {
	if !service.IsNewAPIChannel(channel) {
		return parseVideoTaskPayload(payload, modelName)
	}
	return parsedVideoTaskPayload(newapi.ParseVideoTask(payload))
}
