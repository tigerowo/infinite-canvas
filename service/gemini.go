package service

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
)

const ModelChannelProtocolGemini = "gemini"
const ModelChannelProtocolHTTP = "http"

func IsGeminiChannel(channel model.ModelChannel) bool {
	return strings.EqualFold(strings.TrimSpace(channel.Protocol), ModelChannelProtocolGemini)
}

func IsGenericHTTPChannel(channel model.ModelChannel) bool {
	return strings.EqualFold(strings.TrimSpace(channel.Protocol), ModelChannelProtocolHTTP)
}

func GeminiModelActionPath(modelName string, action string) string {
	modelName = strings.TrimPrefix(strings.TrimSpace(modelName), "models/")
	return "/v1beta/models/" + url.PathEscape(modelName) + ":" + action
}

func GeminiOperationPath(operation string) string {
	operation = strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(operation), "/"), "v1beta/")
	return "/v1beta/" + operation
}

func BuildGeminiChannelURL(channel model.ModelChannel, path string) string {
	baseURL := strings.TrimRight(strings.TrimSpace(channel.BaseURL), "/")
	if strings.HasSuffix(strings.ToLower(baseURL), "/v1beta") {
		baseURL = baseURL[:len(baseURL)-len("/v1beta")]
	}
	return baseURL + path
}

func SetModelChannelAuthHeader(request *http.Request, channel model.ModelChannel) {
	for name, value := range channel.Headers {
		request.Header.Set(name, value)
	}
	if IsGeminiChannel(channel) {
		if channel.APIKey != "" && request.Header.Get("x-goog-api-key") == "" {
			request.Header.Set("x-goog-api-key", channel.APIKey)
		}
		return
	}
	if channel.APIKey != "" && request.Header.Get("Authorization") == "" {
		request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	}
}

func StripGeminiModelField(body []byte, contentType string) ([]byte, error) {
	if !strings.HasPrefix(strings.ToLower(contentType), "application/json") {
		return body, nil
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	delete(payload, "model")
	delete(payload, "stream")
	return json.Marshal(payload)
}

func GeminiTextRequestBody(modelName string, prompt string) []byte {
	return GeminiMessagesRequestBody(modelName, []map[string]any{{"role": "user", "content": prompt}})
}

func GeminiMessagesRequestBody(modelName string, messages []map[string]any) []byte {
	systemParts := []map[string]string{}
	contents := []map[string]any{}
	for _, message := range messages {
		role := strings.ToLower(strings.TrimSpace(toGeminiString(message["role"])))
		parts := []map[string]any{}
		switch content := message["content"].(type) {
		case string:
			if strings.TrimSpace(content) != "" {
				parts = append(parts, map[string]any{"text": content})
			}
		case []map[string]any:
			parts = append(parts, geminiContentParts(content)...)
		case []any:
			items := make([]map[string]any, 0, len(content))
			for _, item := range content {
				if value, ok := item.(map[string]any); ok {
					items = append(items, value)
				}
			}
			parts = append(parts, geminiContentParts(items)...)
		}
		if role == "system" {
			for _, part := range parts {
				if text := toGeminiString(part["text"]); text != "" {
					systemParts = append(systemParts, map[string]string{"text": text})
				}
			}
			continue
		}
		if len(parts) > 0 {
			if role == "assistant" {
				role = "model"
			} else {
				role = "user"
			}
			contents = append(contents, map[string]any{"role": role, "parts": parts})
		}
	}
	payload := map[string]any{"model": modelName, "contents": contents}
	if len(systemParts) > 0 {
		payload["systemInstruction"] = map[string]any{"parts": systemParts}
	}
	body, _ := json.Marshal(payload)
	return body
}

func geminiContentParts(items []map[string]any) []map[string]any {
	parts := []map[string]any{}
	for _, item := range items {
		switch strings.ToLower(toGeminiString(item["type"])) {
		case "text":
			if text := toGeminiString(item["text"]); text != "" {
				parts = append(parts, map[string]any{"text": text})
			}
		case "image_url":
			image, _ := item["image_url"].(map[string]any)
			dataURL := toGeminiString(image["url"])
			if comma := strings.Index(dataURL, ","); strings.HasPrefix(dataURL, "data:") && comma > 5 {
				header := dataURL[5:comma]
				mimeType := strings.Split(header, ";")[0]
				parts = append(parts, map[string]any{"inlineData": map[string]string{"mimeType": mimeType, "data": dataURL[comma+1:]}})
			}
		}
	}
	return parts
}

func toGeminiString(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func GeminiResponseText(body []byte) string {
	var payload struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return ""
	}
	var result strings.Builder
	for _, candidate := range payload.Candidates {
		for _, part := range candidate.Content.Parts {
			result.WriteString(part.Text)
		}
	}
	return strings.TrimSpace(result.String())
}
