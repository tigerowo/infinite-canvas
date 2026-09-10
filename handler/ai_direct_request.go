package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

const directAIRequestBodyLimit = 1 << 20

type directAIRequestInput struct {
	Channel  directAIChannelInput `json:"channel"`
	Model    string               `json:"model"`
	Endpoint string               `json:"endpoint"`
	Body     any                  `json:"body"`
}

type directAIChannelInput struct {
	Protocol string `json:"protocol"`
	BaseURL  string `json:"baseUrl"`
}

type directAIRequestPlan struct {
	Provider    string                    `json:"provider"`
	URL         string                    `json:"url"`
	ContentType string                    `json:"contentType"`
	Body        any                       `json:"body"`
	Uploads     map[string]directAIUpload `json:"uploads,omitempty"`
}

type directAIUpload struct {
	URL           string            `json:"url"`
	FileField     string            `json:"fileField"`
	FileNameField string            `json:"fileNameField,omitempty"`
	ExtraFields   map[string]string `json:"extraFields,omitempty"`
	ResponsePaths []string          `json:"responsePaths"`
}

func PrepareDirectAIRequest(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, directAIRequestBodyLimit)
	var input directAIRequestInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		if errors.Is(err, io.EOF) {
			Fail(w, "请求参数不能为空")
			return
		}
		Fail(w, "请求参数格式错误")
		return
	}

	plan, err := prepareDirectAIRequest(input)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, plan)
}

func prepareDirectAIRequest(input directAIRequestInput) (directAIRequestPlan, error) {
	input.Model = strings.TrimSpace(input.Model)
	input.Endpoint = strings.TrimSpace(input.Endpoint)
	input.Channel.Protocol = strings.TrimSpace(input.Channel.Protocol)
	input.Channel.BaseURL = strings.TrimSpace(input.Channel.BaseURL)
	if input.Model == "" {
		return directAIRequestPlan{}, errors.New("缺少模型名称")
	}
	if !isDirectAIEndpoint(input.Endpoint) && !(strings.EqualFold(input.Channel.Protocol, service.ModelChannelProtocolAutoDL) && input.Endpoint == "/audio/speech") {
		return directAIRequestPlan{}, errors.New("当前接口不支持本地参数转译")
	}
	if err := validateDirectAIBaseURL(input.Channel.BaseURL); err != nil {
		return directAIRequestPlan{}, err
	}
	if err := validateDirectAIRequestValue(input.Body); err != nil {
		return directAIRequestPlan{}, err
	}

	channel := model.ModelChannel{
		Protocol: input.Channel.Protocol,
		BaseURL:  input.Channel.BaseURL,
	}
	body, err := json.Marshal(input.Body)
	if err != nil {
		return directAIRequestPlan{}, errors.New("请求参数序列化失败")
	}

	contentType := "application/json"
	upstreamPath := resolveAIProxyPath(channel, input.Model, input.Endpoint)
	prepared, provider, err := prepareAIProtocolRequest(aiProtocolRequest{
		mode: aiProtocolDirectRequest, body: body, contentType: contentType, modelName: input.Model,
		channel: channel, endpoint: input.Endpoint, path: upstreamPath,
	})
	if provider == "" {
		return directAIRequestPlan{}, errors.New("当前渠道不支持本地复用后端转译")
	}
	if err != nil {
		return directAIRequestPlan{}, err
	}
	body, contentType = prepared.body, prepared.contentType

	var translated any
	if err := json.Unmarshal(body, &translated); err != nil {
		return directAIRequestPlan{}, errors.New("转译结果格式错误")
	}
	kinds := map[string]bool{}
	collectDirectAIReferenceKinds(translated, kinds)
	uploads, err := directAIUploads(provider, channel, kinds)
	if err != nil {
		return directAIRequestPlan{}, err
	}

	return directAIRequestPlan{
		Provider:    provider,
		URL:         service.BuildModelChannelURL(channel, upstreamPath),
		ContentType: contentType,
		Body:        translated,
		Uploads:     uploads,
	}, nil
}

func isDirectAIEndpoint(endpoint string) bool {
	switch endpoint {
	case "/images/generations", "/images/edits", "/videos":
		return true
	default:
		return false
	}
}

func validateDirectAIBaseURL(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Scheme != "http" && parsed.Scheme != "https" {
		return errors.New("渠道地址格式错误")
	}
	return nil
}

func validateDirectAIRequestValue(value any) error {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			if strings.EqualFold(strings.TrimSpace(key), "apiKey") || strings.EqualFold(strings.TrimSpace(key), "api_key") {
				return errors.New("参数转译请求不能包含 API Key")
			}
			if err := validateDirectAIRequestValue(item); err != nil {
				return err
			}
		}
	case []any:
		for _, item := range typed {
			if err := validateDirectAIRequestValue(item); err != nil {
				return err
			}
		}
	case string:
		text := strings.TrimSpace(typed)
		lower := strings.ToLower(text)
		if strings.HasPrefix(lower, "data:") || strings.HasPrefix(lower, "blob:") {
			return errors.New("参考文件不能传给参数转译接口")
		}
		if len(text) > 2048 && looksLikeBase64(text) {
			return errors.New("参数转译请求不能包含 base64 文件内容")
		}
	}
	return nil
}

func collectDirectAIReferenceKinds(value any, kinds map[string]bool) {
	switch typed := value.(type) {
	case map[string]any:
		for _, item := range typed {
			collectDirectAIReferenceKinds(item, kinds)
		}
	case []any:
		for _, item := range typed {
			collectDirectAIReferenceKinds(item, kinds)
		}
	case string:
		if kind := directAIReferenceKind(typed); kind != "" {
			kinds[kind] = true
		}
	}
}

func directAIReferenceKind(value string) string {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme != "https" || parsed.Host != "direct-reference.invalid" {
		return ""
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) != 3 || parts[0] == "" || parts[2] == "" {
		return ""
	}
	switch parts[1] {
	case "image", "video", "audio":
		return parts[1]
	default:
		return ""
	}
}

func directAIUploads(provider string, channel model.ModelChannel, kinds map[string]bool) (map[string]directAIUpload, error) {
	for _, adapter := range builtinAIProtocols {
		if adapter.id == provider && adapter.uploads != nil {
			return adapter.uploads(channel, kinds)
		}
	}
	return nil, fmt.Errorf("不支持的转译渠道：%s", provider)
}
