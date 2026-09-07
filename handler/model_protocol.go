package handler

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

type aiProtocolRequestMode uint8

const (
	aiProtocolProxyRequest aiProtocolRequestMode = iota
	aiProtocolVideoRequest
	aiProtocolDirectRequest
)

type aiProtocolRequest struct {
	mode         aiProtocolRequestMode
	body         []byte
	contentType  string
	modelName    string
	channel      model.ModelChannel
	endpoint     string
	path         string
	failureLabel string
}

type aiProtocolAdapter struct {
	id            string
	path          func(model.ModelChannel, string, string) (string, bool)
	url           func(model.ModelChannel, string, string) (string, bool)
	prepare       func(aiProtocolRequest) (aiProtocolRequest, bool, error)
	copyResponse  func(http.ResponseWriter, *http.Response, *http.Request, model.ModelChannel, aiLogContext, func()) bool
	videoResponse func([]byte, *http.Request, model.ModelChannel, string, bool) ([]byte, bool)
	videoError    func([]byte, model.ModelChannel, string, bool) string
	videoContent  func(http.ResponseWriter, *http.Request, string) bool
	videoID       func(string, string) bool
	allImages     func(string) bool
	uploads       func(model.ModelChannel, map[string]bool) (map[string]directAIUpload, error)
}

// HTTP 混合钩子留在原 handler 包边界，避免 service 反向依赖 handler。
// 表只初始化一次；每阶段只执行自身钩子，bool 表示停止匹配，不表示字段是否改变。
var builtinAIProtocols = []aiProtocolAdapter{
	{
		id:           service.ModelChannelProtocolGemini,
		videoContent: serveGeminiVideoTaskContent,
		path: func(channel model.ModelChannel, modelName string, path string) (string, bool) {
			if !service.IsGeminiChannel(channel) {
				return path, false
			}
			switch path {
			case "/chat/completions":
				return service.GeminiModelActionPath(modelName, "streamGenerateContent") + "?alt=sse", true
			case "/images/generations", "/images/edits", "/audio/speech":
				return service.GeminiModelActionPath(modelName, "generateContent"), true
			case "/videos":
				return service.GeminiModelActionPath(modelName, "predictLongRunning"), true
			}
			if strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content") {
				return service.GeminiOperationPath(strings.TrimPrefix(path, "/videos/")), true
			}
			return path, false
		},
		prepare: func(input aiProtocolRequest) (aiProtocolRequest, bool, error) {
			if input.mode == aiProtocolDirectRequest || !service.IsGeminiChannel(input.channel) {
				return input, false, nil
			}
			input.failureLabel = "Gemini"
			if input.mode == aiProtocolProxyRequest && input.endpoint == "/chat/completions" && !geminiStreamRequested(input.body) {
				input.path = service.GeminiModelActionPath(input.modelName, "generateContent")
			}
			var err error
			input.body, err = service.StripGeminiModelField(input.body, input.contentType)
			return input, input.mode == aiProtocolVideoRequest, err
		},
		videoResponse: func(payload []byte, _ *http.Request, channel model.ModelChannel, _ string, _ bool) ([]byte, bool) {
			if service.IsGeminiChannel(channel) {
				return transformGeminiVideoTaskResponse(payload)
			}
			return nil, false
		},
	},
	{
		id: service.ModelChannelProtocolMiMo,
		path: func(_ model.ModelChannel, modelName string, path string) (string, bool) {
			if service.IsMiMoTTSModelName(modelName) && path == "/audio/speech" {
				return "/chat/completions", true
			}
			return path, false
		},
		prepare: func(input aiProtocolRequest) (aiProtocolRequest, bool, error) {
			if input.mode != aiProtocolProxyRequest || !service.IsMiMoTTSModelName(input.modelName) || input.endpoint != "/audio/speech" {
				return input, false, nil
			}
			input.failureLabel = "MiMo TTS"
			var err error
			input.body, input.contentType, err = normalizeMiMoTTSBody(input.body, input.contentType, input.modelName)
			return input, true, err
		},
		copyResponse: func(w http.ResponseWriter, response *http.Response, _ *http.Request, _ model.ModelChannel, context aiLogContext, onFailure func()) bool {
			return copyMiMoTTSResponse(w, response, context, onFailure)
		},
	},
	{
		id: service.ModelChannelProtocolMiniMax,
		path: func(channel model.ModelChannel, modelName string, path string) (string, bool) {
			if !isMiniMaxH3Channel(channel, modelName) {
				return path, false
			}
			if path == "/videos" {
				return "/v2/video_generation", true
			}
			if strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content") {
				taskID := strings.TrimSpace(strings.TrimPrefix(path, "/videos/"))
				if taskID != "" && !strings.Contains(taskID, "/") {
					return "/v2/query/video_generation/" + url.PathEscape(taskID), true
				}
			}
			return path, true
		},
		videoResponse: func(payload []byte, request *http.Request, channel model.ModelChannel, modelName string, status bool) ([]byte, bool) {
			if status && isMiniMaxH3Channel(channel, modelName) && strings.Contains(request.URL.Path, "/v2/query/video_generation/") {
				return transformMiniMaxVideoTaskResponse(payload)
			}
			return nil, false
		},
	},
	{
		id: "model:cogvideox3",
		path: func(_ model.ModelChannel, modelName string, path string) (string, bool) {
			if !isCogVideoX3Model(modelName) {
				return path, false
			}
			if path == "/videos" {
				return "/videos/generations", true
			}
			if strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content") {
				taskID := strings.TrimSpace(strings.TrimPrefix(path, "/videos/"))
				if taskID != "" && !strings.Contains(taskID, "/") {
					return "/async-result/" + url.PathEscape(taskID), true
				}
			}
			return path, true
		},
	},
	{
		id:        service.ModelChannelProtocolKIE,
		allImages: isKIESeedreamLayerDecompositionModel,
		path: func(channel model.ModelChannel, modelName string, path string) (string, bool) {
			if !isKIEChannel(channel, modelName) {
				return path, false
			}
			if path == "/images/generations" && strings.EqualFold(strings.TrimSpace(modelName), "grok-imagine-image-2-0/text-to-image") {
				return "/client/tasks", true
			}
			if path == "/videos" || path == "/images/generations" || path == "/images/edits" {
				return "/jobs/createTask", true
			}
			if strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content") {
				taskID := strings.TrimSpace(strings.TrimPrefix(path, "/videos/"))
				if taskID != "" && !strings.Contains(taskID, "/") {
					return "/jobs/recordInfo?taskId=" + url.QueryEscape(taskID), true
				}
			}
			return path, true
		},
		prepare: func(input aiProtocolRequest) (aiProtocolRequest, bool, error) {
			if !isKIEChannel(input.channel, input.modelName) || input.mode == aiProtocolProxyRequest && !isKIECreateTaskPath(input.path) || input.mode == aiProtocolVideoRequest && input.path != "/jobs/createTask" {
				return input, false, nil
			}
			input.failureLabel = "KIE"
			var err error
			input.body, input.contentType, err = normalizeKIEVideoBody(input.body, input.contentType, input.modelName, input.channel)
			return input, true, err
		},
		copyResponse: copyKIEVideoResponse,
		videoResponse: func(payload []byte, request *http.Request, channel model.ModelChannel, modelName string, status bool) ([]byte, bool) {
			if !isKIEChannel(channel, modelName) {
				return nil, false
			}
			if status && strings.Contains(request.URL.Path, "/jobs/recordInfo") {
				return transformKIETaskResponse(payload, modelName)
			}
			if !status && strings.Contains(request.URL.Path, "/jobs/createTask") {
				return transformKIECreateVideoResponse(payload, modelName)
			}
			return nil, false
		},
		videoError: func(payload []byte, channel model.ModelChannel, modelName string, status bool) string {
			if !isKIEChannel(channel, modelName) {
				return ""
			}
			if status {
				return readKIERecordInfoErrorMessage(payload)
			}
			return readKIECreateTaskErrorMessage(payload)
		},
		uploads: func(_ model.ModelChannel, kinds map[string]bool) (map[string]directAIUpload, error) {
			uploads := map[string]directAIUpload{}
			for kind, uploadPath := range map[string]string{"image": "images/user-uploads", "video": "videos/user-uploads", "audio": "audios/user-uploads"} {
				if kinds[kind] {
					uploads[kind] = directAIUpload{
						URL: kieFileStreamUploadURL, FileField: "file", FileNameField: "fileName",
						ExtraFields: map[string]string{"uploadPath": uploadPath}, ResponsePaths: []string{"data.downloadUrl", "data.fileUrl", "data.url"},
					}
				}
			}
			return uploads, nil
		},
	},
	{
		id: service.ModelChannelProtocolAPIMart,
		path: func(channel model.ModelChannel, modelName string, path string) (string, bool) {
			if !isAPIMartChannel(channel, modelName) {
				return path, false
			}
			if path == "/videos" {
				return "/videos/generations", true
			}
			if path == "/images/edits" {
				model := normalizeAPIMartModelName(modelName)
				if strings.Contains(model, "grok-imagine") && strings.Contains(model, "edit") {
					return path, true
				}
				return "/images/generations", true
			}
			if strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content") {
				taskID := strings.TrimSpace(strings.TrimPrefix(path, "/videos/"))
				if taskID != "" && !strings.Contains(taskID, "/") {
					return "/tasks/" + url.PathEscape(taskID) + "?language=zh", true
				}
			}
			return path, true
		},
		prepare: func(input aiProtocolRequest) (aiProtocolRequest, bool, error) {
			if !isAPIMartChannel(input.channel, input.modelName) {
				return input, false, nil
			}
			video := input.path == "/videos/generations"
			image := input.mode != aiProtocolVideoRequest && (input.path == "/images/generations" || input.path == "/images/edits")
			if input.mode == aiProtocolDirectRequest {
				video, image = input.endpoint == "/videos", input.endpoint != "/videos"
			}
			var err error
			if video {
				input.failureLabel = "APIMart video"
				input.body, input.contentType, err = normalizeAPIMartVideoBody(input.body, input.contentType, input.modelName, input.channel)
			} else if image {
				input.failureLabel = "APIMart image"
				input.body, input.contentType, err = normalizeAPIMartImageBody(input.body, input.contentType, input.modelName, input.channel)
			}
			return input, video || image, err
		},
		copyResponse: func(w http.ResponseWriter, response *http.Response, request *http.Request, channel model.ModelChannel, context aiLogContext, onFailure func()) bool {
			return isAPIMartChannel(channel, context.Model) && (copyAPIMartImageResponse(w, response, request, channel, context, onFailure) || copyAPIMartVideoResponse(w, response, request, channel, context))
		},
		videoResponse: func(payload []byte, request *http.Request, channel model.ModelChannel, modelName string, status bool) ([]byte, bool) {
			if !isAPIMartChannel(channel, modelName) {
				return nil, false
			}
			if status && strings.Contains(request.URL.Path, "/tasks/") {
				return transformAPIMartTaskResponse(payload, modelName)
			}
			if !status && strings.Contains(request.URL.Path, "/videos/generations") {
				return transformAPIMartCreateVideoResponse(payload, modelName)
			}
			return nil, false
		},
		uploads: func(channel model.ModelChannel, kinds map[string]bool) (map[string]directAIUpload, error) {
			if kinds["video"] || kinds["audio"] {
				return nil, errors.New("APIMart 本地视频和音频参考暂不支持直传，请使用公网媒体地址")
			}
			uploads := map[string]directAIUpload{}
			if kinds["image"] {
				uploads["image"] = directAIUpload{URL: service.BuildModelChannelURL(channel, apimartImageUploadPath), FileField: "file", ResponsePaths: []string{"url"}}
			}
			return uploads, nil
		},
	},
	{
		id: service.ModelChannelProtocolGrok2API,
		path: func(channel model.ModelChannel, modelName string, path string) (string, bool) {
			if strings.EqualFold(strings.TrimSpace(channel.Protocol), service.ModelChannelProtocolGrok2API) && (strings.EqualFold(strings.TrimSpace(modelName), "grok-imagine-video") || strings.EqualFold(strings.TrimSpace(modelName), "grok-imagine-video-1.5")) && path == "/videos" {
				return "/videos/generations", true
			}
			return path, false
		},
	},
	{
		id: "model:ark-seedance",
		path: func(channel model.ModelChannel, modelName string, path string) (string, bool) {
			if isArkSeedanceVideo(channel.BaseURL, modelName) {
				if path == "/videos" {
					return "/contents/generations/tasks", true
				}
				if strings.HasPrefix(path, "/videos/") && !strings.HasSuffix(path, "/content") {
					return "/contents/generations/tasks/" + strings.TrimPrefix(path, "/videos/"), true
				}
			}
			return path, false
		},
	},
	{
		id: "model:agnes",
		videoID: func(modelName string, id string) bool {
			return isAgnesVideoModel(modelName) && strings.HasPrefix(id, "video_")
		},
		url: func(channel model.ModelChannel, modelName string, path string) (string, bool) {
			videoID, ok := agnesVideoQueryID(modelName, path)
			if !ok {
				return "", false
			}
			baseURL := strings.TrimRight(strings.TrimSpace(channel.BaseURL), "/")
			if strings.HasSuffix(strings.ToLower(baseURL), "/v1") {
				baseURL = strings.TrimRight(baseURL[:len(baseURL)-len("/v1")], "/")
			}
			values := url.Values{}
			values.Set("video_id", videoID)
			values.Set("model_name", modelName)
			return baseURL + "/agnesapi?" + values.Encode(), true
		},
	},
	{id: service.ModelChannelProtocol88API},
	{
		id:   service.ModelChannelProtocolOpenAI,
		path: func(_ model.ModelChannel, _ string, path string) (string, bool) { return path, true },
	},
}

func prepareAIProtocolRequest(input aiProtocolRequest) (aiProtocolRequest, string, error) {
	if service.IsNewAPIChannel(input.channel) {
		return input, service.ModelChannelProtocolNewAPI, nil
	}
	for _, adapter := range builtinAIProtocols {
		if adapter.prepare == nil {
			continue
		}
		var stop bool
		var err error
		input, stop, err = adapter.prepare(input)
		if err != nil || stop {
			return input, adapter.id, err
		}
	}
	return input, "", nil
}

func copyAIProtocolResponse(w http.ResponseWriter, response *http.Response, request *http.Request, channel model.ModelChannel, context aiLogContext, onFailure func()) bool {
	if service.IsNewAPIChannel(channel) {
		return false
	}
	for _, adapter := range builtinAIProtocols {
		if adapter.copyResponse != nil && adapter.copyResponse(w, response, request, channel, context, onFailure) {
			return true
		}
	}
	return false
}

func transformAIProtocolVideoPayload(payload []byte, request *http.Request, channel model.ModelChannel, modelName string, status bool) []byte {
	if service.IsNewAPIChannel(channel) {
		return payload
	}
	for _, adapter := range builtinAIProtocols {
		if adapter.videoResponse != nil {
			if result, ok := adapter.videoResponse(payload, request, channel, modelName, status); ok {
				return result
			}
		}
	}
	return payload
}

func readAIProtocolVideoError(payload []byte, channel model.ModelChannel, modelName string, status bool) string {
	if service.IsNewAPIChannel(channel) {
		return ""
	}
	for _, adapter := range builtinAIProtocols {
		if adapter.videoError != nil {
			if message := adapter.videoError(payload, channel, modelName, status); message != "" {
				return message
			}
		}
	}
	return ""
}

func isAIProtocolVideoID(modelName string, id string) bool {
	for _, adapter := range builtinAIProtocols {
		if adapter.videoID != nil && adapter.videoID(modelName, id) {
			return true
		}
	}
	return false
}

func allAIProtocolImageResults(modelName string) bool {
	for _, adapter := range builtinAIProtocols {
		if adapter.allImages != nil && adapter.allImages(modelName) {
			return true
		}
	}
	return false
}
