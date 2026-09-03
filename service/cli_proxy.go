package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

const (
	cliChatGPTProxyProtocol       = "chatgpt-subscription-proxy"
	cliAntigravityProxyProtocol   = "antigravity-subscription-proxy"
	cliChatGPTProxyTextModel      = "gpt-5.5"
	cliChatGPTProxyImageModel     = "gpt-image-2"
	cliAntigravityProxyTextModel  = "gemini-3.1-flash-lite"
	cliAntigravityProxyImageModel = "gemini-3.1-flash-image"
	cliProxyAddress               = "127.0.0.1:8317"
	cliProxyBaseURL               = "http://127.0.0.1:8317"
	cliProxyModelsResponseLimit   = int64(256 * 1024)
	cliProxyTextResponseLimit     = int64(1024 * 1024)
	cliProxyImageResponseLimit    = int64(45 * 1024 * 1024)
)

type cliProxyRequestError struct {
	status     int
	diagnostic string
}

func (err cliProxyRequestError) Error() string {
	return err.diagnostic
}

func isCLIProxyProtocol(protocol string) bool {
	return protocol == cliChatGPTProxyProtocol || protocol == cliAntigravityProxyProtocol
}

func cliProxyAllowedModels(protocol string) []string {
	if protocol == cliChatGPTProxyProtocol {
		return []string{cliChatGPTProxyTextModel, cliChatGPTProxyImageModel}
	}
	if protocol == cliAntigravityProxyProtocol {
		return []string{cliAntigravityProxyTextModel, cliAntigravityProxyImageModel}
	}
	return nil
}

func cliProxyTextModel(protocol string, modelName string) bool {
	return protocol == cliChatGPTProxyProtocol && modelName == cliChatGPTProxyTextModel ||
		protocol == cliAntigravityProxyProtocol && modelName == cliAntigravityProxyTextModel
}

func cliProxyImageModel(protocol string, modelName string) bool {
	return protocol == cliChatGPTProxyProtocol && modelName == cliChatGPTProxyImageModel ||
		protocol == cliAntigravityProxyProtocol && modelName == cliAntigravityProxyImageModel
}

func cliProxyAPIKey() (string, error) {
	if !config.Cfg.CLIProxyEnabled {
		return "", errors.New("subscription proxy is disabled")
	}
	path := strings.TrimSpace(config.Cfg.CLIProxyAPIKeyFile)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return "", errors.New("subscription proxy key file is invalid")
	}
	data, err := readProtectedCLIHelperFile(path, 4*1024)
	key := strings.TrimSpace(string(data))
	if err != nil || len(key) < 16 || len(key) > 512 || strings.ContainsAny(key, "\r\n\x00") {
		return "", errors.New("subscription proxy key file is invalid")
	}
	return key, nil
}

func cliProxyHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: 2 * time.Second}
	transport := &http.Transport{
		Proxy:                 nil,
		DisableKeepAlives:     true,
		MaxResponseHeaderBytes: 32 * 1024,
		DialContext: func(ctx context.Context, network string, address string) (net.Conn, error) {
			if network != "tcp" || address != cliProxyAddress {
				return nil, errors.New("subscription proxy destination is not allowed")
			}
			return dialer.DialContext(ctx, "tcp", cliProxyAddress)
		},
	}
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func requestCLIProxyJSON(ctx context.Context, path string, payload any, limit int64, output any) error {
	if path != "/v1/models" && path != "/v1/chat/completions" && path != "/v1/images/generations" {
		return errors.New("subscription proxy path is not allowed")
	}
	key, err := cliProxyAPIKey()
	if err != nil {
		return err
	}
	var body io.Reader
	if payload != nil {
		encoded, encodeErr := json.Marshal(payload)
		if encodeErr != nil {
			return encodeErr
		}
		if len(encoded) > int(cliCompanionBodyLimit) {
			return errors.New("subscription proxy request is too large")
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, func() string {
		if payload == nil {
			return http.MethodGet
		}
		return http.MethodPost
	}(), cliProxyBaseURL+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("Content-Type", "application/json")
	client := cliProxyHTTPClient()
	response, err := client.Do(request)
	if transport, ok := client.Transport.(*http.Transport); ok {
		defer transport.CloseIdleConnections()
	}
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.ContentLength > limit {
		return errors.New("subscription proxy response is too large")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return errors.New("subscription proxy response is too large")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		diagnostic := sanitizeCLIOutput(string(data))
		diagnostic = strings.ReplaceAll(diagnostic, key, "[redacted]")
		if diagnostic == "" {
			diagnostic = http.StatusText(response.StatusCode)
		}
		return cliProxyRequestError{status: response.StatusCode, diagnostic: diagnostic}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(output); err != nil {
		return errors.New("subscription proxy response structure is invalid")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("subscription proxy response structure is invalid")
	}
	return nil
}

func executeCLIProxyVersion(parent context.Context, protocol string) (CLIHelperResult, model.ProviderStatus) {
	result := CLIHelperResult{Protocol: protocol}
	if !isCLIProxyProtocol(protocol) {
		result.Message = "订阅代理类型不受支持"
		return result, model.ProviderStatusUnavailable
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	var response struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := requestCLIProxyJSON(ctx, "/v1/models", nil, cliProxyModelsResponseLimit, &response); err != nil {
		result.Message = cliProxyFailureMessage(protocol, err, "")
		return result, cliProxyProviderStatus(err)
	}
	advertised := map[string]bool{}
	for _, item := range response.Data {
		advertised[strings.TrimSpace(item.ID)] = true
	}
	for _, modelName := range cliProxyAllowedModels(protocol) {
		if advertised[modelName] {
			result.Models = append(result.Models, modelName)
		}
	}
	if len(result.Models) == 0 {
		result.Message = "订阅代理未返回允许使用的模型"
		return result, model.ProviderStatusUnavailable
	}
	result.Available = true
	result.Version = "CLIProxyAPI · 127.0.0.1:8317"
	if protocol == cliChatGPTProxyProtocol {
		result.Message = "ChatGPT 订阅代理检测成功；只开放 gpt-5.5 与 gpt-image-2，不回退付费 API"
	} else {
		result.Message = "Antigravity 订阅代理检测成功；只开放受控 Gemini 模型，不回退付费 API"
	}
	return result, model.ProviderStatusConnected
}

func executeCLIProxyCompletionStart(parent context.Context, input cliCompanionActionRequest) (CLIHelperResult, model.ProviderStatus) {
	result := CLIHelperResult{Protocol: input.Protocol}
	if !cliProxyTextModel(input.Protocol, input.Model) || len(input.Prompt) == 0 || len(input.Prompt) > cliCompletionPromptLimit || strings.ContainsRune(input.Prompt, '\x00') {
		result.Message = "订阅代理文本调用参数无效"
		return result, model.ProviderStatusUnavailable
	}
	cliModelProbeState.Lock()
	defer cliModelProbeState.Unlock()
	pruneCLIModelProbeTasks(time.Now())
	if cliModelProbeState.ActiveID != "" {
		result.Message = "CLI helper 正在执行另一个模型调用"
		return result, model.ProviderStatusTimeout
	}
	taskID, err := newCLIModelProbeTaskID()
	if err != nil {
		result.Message = "订阅代理任务创建失败"
		return result, model.ProviderStatusFailed
	}
	ctx, cancel := context.WithTimeout(parent, cliModelProbeTimeout)
	task := &cliModelProbeTask{ID: taskID, UserID: input.UserID, ProviderID: input.ProviderID, Protocol: input.Protocol, Model: input.Model, Status: "running", Message: "订阅代理文本调用正在执行", TaskType: "completion", UpdatedAt: time.Now(), Cancel: cancel}
	cliModelProbeState.Tasks[taskID] = task
	cliModelProbeState.ActiveID = taskID
	go runCLIProxyCompletion(ctx, cancel, input, taskID)
	return cliModelProbeResult(task), model.ProviderStatusConnected
}

func runCLIProxyCompletion(ctx context.Context, cancel context.CancelFunc, input cliCompanionActionRequest, taskID string) {
	defer cancel()
	payload := map[string]any{
		"model": input.Model,
		"messages": []map[string]string{{"role": "user", "content": input.Prompt}},
		"max_tokens": 512,
		"stream": false,
	}
	var response struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	err := requestCLIProxyJSON(ctx, "/v1/chat/completions", payload, cliProxyTextResponseLimit, &response)
	content := ""
	if len(response.Choices) > 0 {
		content = sanitizeCLIOutput(response.Choices[0].Message.Content)
	}
	cliModelProbeState.Lock()
	defer cliModelProbeState.Unlock()
	task := cliModelProbeState.Tasks[taskID]
	if task == nil {
		return
	}
	if task.Status != "cancelled" {
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			task.Status, task.Message = "timed_out", "订阅代理文本调用超时"
		case errors.Is(ctx.Err(), context.Canceled):
			task.Status, task.Message = "cancelled", "订阅代理文本调用已取消"
		case err != nil:
			task.Status, task.Message = "failed", cliProxyFailureMessage(input.Protocol, err, input.Prompt)
		case content == "" || len(content) > cliModelProbeOutputLimit:
			task.Status, task.Message = "failed", "订阅代理未返回有效文本"
		default:
			task.Status, task.Output, task.Message = "succeeded", content, "订阅代理文本调用成功"
		}
	}
	task.UpdatedAt = time.Now()
	if cliModelProbeState.ActiveID == taskID {
		cliModelProbeState.ActiveID = ""
	}
}

func executeCLIProxyImageGenerationStart(parent context.Context, input cliCompanionActionRequest) (CLIHelperResult, model.ProviderStatus) {
	result := CLIHelperResult{Protocol: input.Protocol}
	cliModelProbeState.Lock()
	defer cliModelProbeState.Unlock()
	pruneCLIModelProbeTasks(time.Now())
	if cliModelProbeState.ActiveID != "" {
		result.Message = "CLI helper 正在执行另一个模型调用"
		return result, model.ProviderStatusTimeout
	}
	taskID, err := newCLIModelProbeTaskID()
	if err != nil {
		result.Message = "订阅代理生图任务创建失败"
		return result, model.ProviderStatusFailed
	}
	directory, err := newSubscriptionImageDirectory()
	if err != nil {
		result.Message = "订阅代理生图临时目录创建失败"
		return result, model.ProviderStatusFailed
	}
	ctx, cancel := context.WithTimeout(parent, cliSubscriptionImageTimeout)
	task := &cliModelProbeTask{ID: taskID, UserID: input.UserID, ProviderID: input.ProviderID, Protocol: input.Protocol, Model: input.Model, GenerationType: "image", TaskType: "subscription-proxy-image", Status: "running", Message: subscriptionImageRunningMessage(input.Protocol), UpdatedAt: time.Now(), Cancel: cancel}
	cliModelProbeState.Tasks[taskID] = task
	cliModelProbeState.ActiveID = taskID
	go runCLIProxyImageGeneration(ctx, cancel, directory, input, taskID)
	return cliModelProbeResult(task), model.ProviderStatusConnected
}

func runCLIProxyImageGeneration(ctx context.Context, cancel context.CancelFunc, directory string, input cliCompanionActionRequest, taskID string) {
	defer cancel()
	encoded := ""
	if input.Protocol == cliChatGPTProxyProtocol {
		payload := map[string]any{"model": input.Model, "prompt": input.Prompt, "n": 1, "size": subscriptionImageSize(input.Ratio), "quality": input.Resolution, "response_format": "b64_json"}
		var response struct {
			Data []struct {
				B64JSON string `json:"b64_json"`
			} `json:"data"`
		}
		err := requestCLIProxyJSON(ctx, "/v1/images/generations", payload, cliProxyImageResponseLimit, &response)
		if len(response.Data) > 0 {
			encoded = response.Data[0].B64JSON
		}
		path, contentType, decodeErr := writeCLIProxyImage(directory, encoded)
		if err == nil {
			err = decodeErr
		}
		finishSubscriptionImageGeneration(taskID, directory, path, contentType, ctx.Err(), err, cliProxyFailureDiagnostic(err, input.Prompt))
		return
	}
	payload := map[string]any{
		"model": input.Model,
		"messages": []map[string]string{{"role": "user", "content": input.Prompt}},
		"modalities": []string{"text", "image"},
		"image_config": map[string]string{"aspect_ratio": input.Ratio},
		"stream": false,
	}
	var response struct {
		Choices []struct {
			Message struct {
				Images []struct {
					ImageURL struct {
						URL string `json:"url"`
					} `json:"image_url"`
				} `json:"images"`
			} `json:"message"`
		} `json:"choices"`
	}
	err := requestCLIProxyJSON(ctx, "/v1/chat/completions", payload, cliProxyImageResponseLimit, &response)
	if len(response.Choices) > 0 && len(response.Choices[0].Message.Images) > 0 {
		encoded = response.Choices[0].Message.Images[0].ImageURL.URL
	}
	path, contentType, decodeErr := writeCLIProxyImage(directory, encoded)
	if err == nil {
		err = decodeErr
	}
	finishSubscriptionImageGeneration(taskID, directory, path, contentType, ctx.Err(), err, cliProxyFailureDiagnostic(err, input.Prompt))
}

func writeCLIProxyImage(directory string, value string) (string, string, error) {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "data:") {
		separator := strings.IndexByte(value, ',')
		if separator < 0 || !strings.HasSuffix(value[:separator], ";base64") {
			return "", "", errors.New("subscription proxy image data is invalid")
		}
		value = value[separator+1:]
	}
	if value == "" || int64(len(value)) > int64(base64.StdEncoding.EncodedLen(int(cliSubscriptionImageLimit)))+4 {
		return "", "", errors.New("subscription proxy image data is missing or too large")
	}
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil || int64(len(data)) > cliSubscriptionImageLimit {
		return "", "", errors.New("subscription proxy image data is invalid")
	}
	contentType := http.DetectContentType(data)
	if contentType != "image/png" && contentType != "image/jpeg" && contentType != "image/webp" {
		return "", "", errors.New("subscription proxy image type is unsupported")
	}
	path := filepath.Join(directory, "output"+imageExtensionForContentType(contentType))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", "", err
	}
	return path, contentType, nil
}

func cliProxyFailureDiagnostic(err error, prompt string) string {
	if err == nil {
		return ""
	}
	diagnostic := err.Error()
	if requestErr, ok := err.(cliProxyRequestError); ok {
		diagnostic = "HTTP " + http.StatusText(requestErr.status) + ": " + requestErr.diagnostic
	}
	return safeSubscriptionImageDiagnostic(diagnostic, "", prompt, err)
}

func cliProxyFailureMessage(protocol string, err error, prompt string) string {
	prefix := "ChatGPT 订阅代理"
	if protocol == cliAntigravityProxyProtocol {
		prefix = "Antigravity 订阅代理"
	}
	diagnostic := strings.ToLower(cliProxyFailureDiagnostic(err, prompt))
	var requestErr cliProxyRequestError
	if errors.As(err, &requestErr) {
		switch requestErr.status {
		case http.StatusUnauthorized:
			return prefix + "本地访问密钥无效或上游登录已失效"
		case http.StatusForbidden:
			return prefix + "当前账户无权使用所选模型"
		case http.StatusTooManyRequests:
			return prefix + "额度不足或请求频率受限"
		}
		if requestErr.status >= 500 {
			return prefix + "上游服务暂时不可用"
		}
	}
	switch {
	case strings.Contains(diagnostic, "disabled"), strings.Contains(diagnostic, "key file"):
		return prefix + "未启用或本地密钥文件无效"
	case strings.Contains(diagnostic, "deadline"), strings.Contains(diagnostic, "timeout"):
		return prefix + "请求超时"
	case strings.Contains(diagnostic, "connection"), strings.Contains(diagnostic, "connect"), strings.Contains(diagnostic, "refused"):
		return prefix + "未连接，请先启动本机 CLIProxyAPI"
	case strings.Contains(diagnostic, "model"), strings.Contains(diagnostic, "unsupported"), strings.Contains(diagnostic, "not available"):
		return prefix + "所选模型当前不可用"
	default:
		return prefix + "调用失败；不会切换其他渠道或付费 API"
	}
}

func cliProxyProviderStatus(err error) model.ProviderStatus {
	if errors.Is(err, context.DeadlineExceeded) {
		return model.ProviderStatusTimeout
	}
	return model.ProviderStatusUnavailable
}
