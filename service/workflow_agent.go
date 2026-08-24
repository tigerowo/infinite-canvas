package service

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

var workflowAgentReadLimits = upstreamReadLimits{
	MaxRequests: 1,
	MaxBytes:    8 * 1024 * 1024,
	Deadline:    2 * time.Minute,
}

func DraftCreativeWorkflow(ctx context.Context, request WorkflowAgentDraftRequest) (WorkflowAgentDraftResponse, error) {
	startedAt := time.Now()
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return WorkflowAgentDraftResponse{}, safeMessageError{message: "请先登录"}
	}
	prompt := strings.TrimSpace(request.Prompt)
	if prompt == "" {
		return WorkflowAgentDraftResponse{}, safeMessageError{message: "请输入工作流需求"}
	}

	modelName, err := workflowDraftModel(request.Model)
	if err != nil {
		return WorkflowAgentDraftResponse{}, err
	}
	if request.ChannelMode != "local" && !UserCanUseRemoteModelChannel(user) {
		return WorkflowAgentDraftResponse{}, safeMessageError{message: "当前账号未开放云端渠道"}
	}
	channel, err := workflowDraftChannel(request, modelName)
	if err != nil {
		return WorkflowAgentDraftResponse{}, err
	}

	credits, _ := ModelCost(modelName)
	chargedCredits := request.ChannelMode != "local"
	if chargedCredits {
		if err := ConsumeUserCredits(user.ID, modelName, credits, "/workflows/agent-draft"); err != nil {
			return WorkflowAgentDraftResponse{}, err
		}
	}
	refundCredits := func() {
		if chargedCredits {
			_ = RefundUserCredits(user.ID, modelName, credits, "/workflows/agent-draft")
		}
	}

	messages := workflowAgentMessages(prompt, request.References)
	body, _ := json.Marshal(map[string]any{
		"model":       modelName,
		"messages":    messages,
		"temperature": 0.2,
	})
	upstreamPath := "/chat/completions"
	if IsGeminiChannel(channel) {
		body = GeminiMessagesRequestBody(modelName, messages)
		body, _ = StripGeminiModelField(body, "application/json")
		upstreamPath = GeminiModelActionPath(modelName, "generateContent")
	}
	requestLogBody := string(body)
	if IsGeminiChannel(channel) && len(request.References) > 0 {
		requestLogBody = "[redacted Gemini workflow request]"
	}

	budget := newUpstreamReadBudget(ctx, "工作流 Agent", workflowAgentReadLimits)
	defer budget.Close()
	httpRequest, err := http.NewRequestWithContext(
		budget.Context(),
		http.MethodPost,
		BuildModelChannelURL(channel, upstreamPath),
		bytes.NewReader(body),
	)
	if err != nil {
		refundCredits()
		return WorkflowAgentDraftResponse{}, err
	}
	SetModelChannelAuthHeader(httpRequest, channel)
	httpRequest.Header.Set("Content-Type", "application/json")

	client := budget.HTTPClient(HTTPClientForChannel(channel))
	response, err := client.Do(httpRequest)
	if err != nil {
		err = normalizeUpstreamBudgetError(err)
		refundCredits()
		SaveAICallLog(AICallLogInput{
			UserID:          user.ID,
			UserDisplayName: firstNonEmpty(user.DisplayName, user.Username),
			Endpoint:        "/workflows/agent-draft",
			Method:          http.MethodPost,
			Model:           modelName,
			ChannelID:       channel.ID,
			ChannelName:     channel.Name,
			Status:          0,
			DurationMs:      time.Since(startedAt).Milliseconds(),
			Credits:         credits,
			RequestBody:     requestLogBody,
			Error:           err.Error(),
		})
		return WorkflowAgentDraftResponse{}, err
	}
	defer response.Body.Close()

	responseBody, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		readErr = normalizeUpstreamBudgetError(readErr)
		refundCredits()
		SaveAICallLog(AICallLogInput{
			UserID: user.ID, UserDisplayName: firstNonEmpty(user.DisplayName, user.Username),
			Endpoint: "/workflows/agent-draft", Method: http.MethodPost, Model: modelName,
			ChannelID: channel.ID, ChannelName: channel.Name, Status: response.StatusCode,
			DurationMs: time.Since(startedAt).Milliseconds(), Credits: credits,
			RequestBody: requestLogBody, Error: readErr.Error(),
		})
		return WorkflowAgentDraftResponse{}, readErr
	}
	if response.StatusCode >= http.StatusBadRequest {
		refundCredits()
		SaveAICallLog(AICallLogInput{
			UserID:          user.ID,
			UserDisplayName: firstNonEmpty(user.DisplayName, user.Username),
			Endpoint:        "/workflows/agent-draft",
			Method:          http.MethodPost,
			Model:           modelName,
			ChannelID:       channel.ID,
			ChannelName:     channel.Name,
			Status:          response.StatusCode,
			DurationMs:      time.Since(startedAt).Milliseconds(),
			Credits:         credits,
			RequestBody:     requestLogBody,
			ResponseBody:    string(responseBody),
			Error:           string(responseBody),
		})
		return WorkflowAgentDraftResponse{}, readChannelError(string(responseBody), "工作流 Agent 请求失败")
	}

	content := extractChatMessage(string(responseBody))
	if IsGeminiChannel(channel) {
		content = GeminiResponseText(responseBody)
	}
	draft, warnings, err := normalizeWorkflowDraft(content, request.Scope)
	if err != nil {
		refundCredits()
		SaveAICallLog(AICallLogInput{
			UserID:          user.ID,
			UserDisplayName: firstNonEmpty(user.DisplayName, user.Username),
			Endpoint:        "/workflows/agent-draft",
			Method:          http.MethodPost,
			Model:           modelName,
			ChannelID:       channel.ID,
			ChannelName:     channel.Name,
			Status:          response.StatusCode,
			DurationMs:      time.Since(startedAt).Milliseconds(),
			Credits:         credits,
			RequestBody:     requestLogBody,
			ResponseBody:    string(responseBody),
			Error:           err.Error(),
		})
		return WorkflowAgentDraftResponse{}, err
	}

	SaveAICallLog(AICallLogInput{
		UserID:          user.ID,
		UserDisplayName: firstNonEmpty(user.DisplayName, user.Username),
		Endpoint:        "/workflows/agent-draft",
		Method:          http.MethodPost,
		Model:           modelName,
		ChannelID:       channel.ID,
		ChannelName:     channel.Name,
		Status:          response.StatusCode,
		DurationMs:      time.Since(startedAt).Milliseconds(),
		Credits:         credits,
		RequestBody:     requestLogBody,
		ResponseBody:    string(responseBody),
	})
	return WorkflowAgentDraftResponse{Draft: draft, Warnings: warnings, Model: modelName}, nil
}

func workflowDraftModel(modelName string) (string, error) {
	modelName = strings.TrimSpace(modelName)
	if modelName != "" {
		return modelName, nil
	}
	settings, err := repository.GetSettings()
	if err != nil {
		return "", err
	}
	normalized := normalizeSettings(settings)
	if strings.TrimSpace(normalized.Public.ModelChannel.DefaultTextModel) != "" {
		return strings.TrimSpace(normalized.Public.ModelChannel.DefaultTextModel), nil
	}
	if strings.TrimSpace(normalized.Public.ModelChannel.DefaultModel) != "" {
		return strings.TrimSpace(normalized.Public.ModelChannel.DefaultModel), nil
	}
	for _, channel := range normalized.Private.Channels {
		for _, model := range channel.Models {
			if strings.TrimSpace(model) != "" {
				return strings.TrimSpace(model), nil
			}
		}
	}
	return "", safeMessageError{message: "请先配置文本模型"}
}

func workflowDraftChannel(request WorkflowAgentDraftRequest, modelName string) (model.ModelChannel, error) {
	if request.ChannelMode == "local" {
		channel := model.ModelChannel{
			ID:       strings.TrimSpace(request.ChannelID),
			Name:     "用户本地直连",
			BaseURL:  strings.TrimSpace(request.BaseURL),
			APIKey:   strings.TrimSpace(request.APIKey),
			Models:   []string{modelName},
			Weight:   1,
			Timeout:  600,
			Protocol: strings.TrimSpace(request.Protocol),
		}
		if channel.BaseURL == "" || channel.APIKey == "" {
			return model.ModelChannel{}, safeMessageError{message: "文本模型本地直连渠道配置不完整"}
		}
		return channel, nil
	}
	return SelectModelChannel(modelName)
}

func workflowAgentMessages(prompt string, references []string) []map[string]any {
	systemPrompt := ""
	if settings, err := repository.GetSettings(); err == nil {
		normalized := normalizeSettings(settings)
		systemPrompt = strings.TrimSpace(normalized.Public.ModelChannel.SystemPrompts.WorkflowAgent)
	}
	if systemPrompt == "" {
		systemPrompt = "你是一个创意工作流设计助手。根据用户描述生成一个JSON格式的工作流模板。"
	}

	messages := []map[string]any{{"role": "system", "content": systemPrompt}}
	var content []map[string]any
	content = append(content, map[string]any{"type": "text", "text": prompt})
	for _, dataURL := range references {
		dataURL = strings.TrimSpace(dataURL)
		if strings.HasPrefix(dataURL, "data:image/") {
			content = append(content, map[string]any{
				"type":      "image_url",
				"image_url": map[string]string{"url": dataURL},
			})
		}
	}
	if len(content) == 1 {
		messages = append(messages, map[string]any{"role": "user", "content": prompt})
	} else {
		messages = append(messages, map[string]any{"role": "user", "content": content})
	}
	return messages
}

func extractChatMessage(responseBody string) string {
	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal([]byte(responseBody), &result); err != nil {
		return responseBody
	}
	if len(result.Choices) > 0 {
		return result.Choices[0].Message.Content
	}
	return responseBody
}

func normalizeWorkflowDraft(content string, scope string) (any, []string, error) {
	content = strings.TrimSpace(content)
	jsonStart := strings.Index(content, "{")
	if jsonStart < 0 {
		jsonStart = strings.Index(content, "[")
	}
	if jsonStart >= 0 {
		content = content[jsonStart:]
	}
	jsonEnd := strings.LastIndex(content, "}")
	if bracketEnd := strings.LastIndex(content, "]"); bracketEnd > jsonEnd {
		jsonEnd = bracketEnd
	}
	if jsonEnd >= 0 {
		content = content[:jsonEnd+1]
	}

	var draft map[string]any
	if err := json.Unmarshal([]byte(content), &draft); err != nil {
		return nil, nil, safeMessageError{message: "工作流 Agent 返回内容格式异常，请重试"}
	}

	warnings := []string{}
	if scope != "public" {
		draft["scope"] = "private"
	}

	// Sanitize variable keys: enforce [a-zA-Z0-9_-]
	if variables, ok := draft["variables"].([]any); ok {
		for i, v := range variables {
			if vmap, ok := v.(map[string]any); ok {
				if key, ok := vmap["key"].(string); ok {
					vmap["key"] = sanitizeVariableKey(key)
				}
				variables[i] = vmap
			}
		}
		draft["variables"] = variables
	}

	return draft, warnings, nil
}

func sanitizeVariableKey(key string) string {
	var result strings.Builder
	for _, r := range key {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			result.WriteRune(r)
		} else {
			result.WriteRune('_')
		}
	}
	out := result.String()
	if out == "" {
		return "var"
	}
	return out
}

func readChannelError(body string, fallback string) safeMessageError {
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Msg string `json:"msg"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err == nil {
		if strings.TrimSpace(payload.Error.Message) != "" {
			return safeMessageError{message: payload.Error.Message}
		}
		if strings.TrimSpace(payload.Msg) != "" {
			return safeMessageError{message: payload.Msg}
		}
	}
	return safeMessageError{message: fallback}
}
