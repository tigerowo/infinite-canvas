package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"mime"
	"mime/multipart"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
)

func isGrok2APIFamilyChannel(channel model.ModelChannel, modelName string) bool {
	protocol := strings.ToLower(strings.TrimSpace(channel.Protocol))
	baseURL := strings.ToLower(strings.TrimSpace(channel.BaseURL))
	return protocol == "grok2api" || protocol == "xai" || strings.Contains(baseURL, "grok2api")
}

func normalizeGrok2APIRequestBody(body []byte, contentType string, modelName string, upstreamPath string) ([]byte, string, error) {
	switch upstreamPath {
	case "/images/generations", "/images/edits":
		return normalizeGrok2APIImageBody(body, contentType, modelName, upstreamPath)
	case "/videos/generations":
		return normalizeGrok2APIVideoBody(body, contentType, modelName)
	case "/tts":
		return normalizeGrok2APITTSBody(body, contentType, modelName)
	default:
		return body, contentType, nil
	}
}

func normalizeGrok2APIImageBody(body []byte, contentType string, modelName string, upstreamPath string) ([]byte, string, error) {
	payload, err := readGrok2APIPayload(body, contentType)
	if err != nil {
		return body, contentType, err
	}
	if finalModel := strings.TrimSpace(firstNonEmpty(modelName, toStringSafe(payload["model"]))); finalModel != "" {
		payload["model"] = finalModel
	}
	normalizeGrok2APIImageReferences(payload)
	keys := []string{"model", "prompt", "aspect_ratio", "resolution", "n", "response_format", "partial_images", "stream", "image", "reference_images"}
	if upstreamPath == "/images/edits" {
		keys = append(keys, "size")
	}
	return marshalGrok2APIPayload(payload, keys)
}

func normalizeGrok2APIVideoBody(body []byte, contentType string, modelName string) ([]byte, string, error) {
	payload, err := readGrok2APIPayload(body, contentType)
	if err != nil {
		return body, contentType, err
	}
	if finalModel := strings.TrimSpace(firstNonEmpty(modelName, toStringSafe(payload["model"]))); finalModel != "" {
		payload["model"] = finalModel
	}
	normalizeGrok2APIImageReferences(payload)
	return marshalGrok2APIPayload(payload, []string{
		"model", "prompt", "aspect_ratio", "duration", "resolution", "n", "response_format", "reference_audios", "video", "image", "reference_images",
	})
}

func marshalGrok2APIPayload(payload map[string]any, keys []string) ([]byte, string, error) {
	result := map[string]any{}
	for _, key := range keys {
		if value, ok := payload[key]; ok {
			result[key] = value
		}
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, "", err
	}
	return encoded, "application/json", nil
}

func normalizeGrok2APIImageReferences(payload map[string]any) {
	if value, ok := payload["image"]; ok {
		if urls := collectGrok2APIReferenceURLs(value); len(urls) > 0 {
			payload["image"] = map[string]any{"url": urls[0]}
		} else {
			delete(payload, "image")
		}
	}
	legacy := []string{
		"images", "image_url", "image_urls", "reference_image", "reference_image_url",
		"reference_image_urls", "first_frame_url", "first_frame_image",
		"input_reference", "input_reference[]", "image_input",
	}
	var urls []string
	for _, key := range legacy {
		if value, ok := payload[key]; ok {
			urls = append(urls, collectGrok2APIReferenceURLs(value)...)
			delete(payload, key)
		}
	}
	if len(urls) == 1 {
		payload["image"] = map[string]any{"url": urls[0]}
	} else if len(urls) > 1 {
		payload["reference_images"] = grok2APIReferenceImageList(urls)
	}
	if value, ok := payload["reference_images"]; ok {
		urls = collectGrok2APIReferenceURLs(value)
		if len(urls) > 0 {
			payload["reference_images"] = grok2APIReferenceImageList(urls)
		} else {
			delete(payload, "reference_images")
		}
	}
}

func grok2APIReferenceImageList(urls []string) []any {
	items := make([]any, 0, len(urls))
	for _, url := range urls {
		items = append(items, map[string]any{"url": url})
	}
	return items
}

func collectGrok2APIReferenceURLs(value any) []string {
	switch typed := value.(type) {
	case string:
		if text := strings.TrimSpace(typed); text != "" {
			return []string{text}
		}
	case map[string]any:
		if url := strings.TrimSpace(toStringSafe(typed["url"])); url != "" {
			return []string{url}
		}
	case []any:
		var result []string
		for _, item := range typed {
			result = append(result, collectGrok2APIReferenceURLs(item)...)
		}
		return result
	}
	return nil
}

func normalizeGrok2APITTSBody(body []byte, contentType string, modelName string) ([]byte, string, error) {
	if !strings.HasPrefix(strings.ToLower(contentType), "application/json") {
		return nil, "", errors.New("grok2api TTS 仅支持 JSON 请求")
	}
	var payload map[string]any
	if len(body) == 0 || json.Unmarshal(body, &payload) != nil {
		return nil, "", errors.New("grok2api TTS 请求体格式错误")
	}
	text := strings.TrimSpace(firstNonEmpty(toStringSafe(payload["text"]), toStringSafe(payload["input"])))
	if text == "" {
		return nil, "", errors.New("grok2api TTS 缺少播报文本")
	}
	if finalModel := strings.TrimSpace(firstNonEmpty(modelName, toStringSafe(payload["model"]))); finalModel != "" {
		payload["model"] = finalModel
	}
	payload["text"] = text
	delete(payload, "input")
	if strings.TrimSpace(toStringSafe(payload["voice_id"])) == "" {
		if voice := strings.TrimSpace(toStringSafe(payload["voice"])); voice != "" {
			payload["voice_id"] = voice
		}
	}
	delete(payload, "voice")
	if strings.TrimSpace(toStringSafe(payload["language"])) == "" {
		payload["language"] = "en"
	}
	return marshalGrok2APIPayload(payload, []string{
		"model", "text", "voice_id", "language", "output_format", "speed",
		"optimize_streaming_latency", "text_normalization", "with_timestamps",
	})
}

func readGrok2APIPayload(body []byte, contentType string) (map[string]any, error) {
	payload := map[string]any{}
	if !strings.HasPrefix(strings.ToLower(contentType), "multipart/form-data") {
		if len(body) > 0 && json.Unmarshal(body, &payload) != nil {
			return nil, errors.New("grok2api 请求体格式错误")
		}
		return payload, nil
	}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return nil, errors.New("grok2api multipart 请求格式错误")
	}
	form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
	if err != nil {
		return nil, errors.New("grok2api multipart 请求格式错误")
	}
	defer form.RemoveAll()
	if len(form.File) > 0 {
		return nil, errors.New("grok2api 暂不支持本地文件直传，请先上传参考文件到本项目媒体引用")
	}
	for key, values := range form.Value {
		if len(values) == 0 {
			continue
		}
		if len(values) == 1 {
			payload[key] = parseGrok2APIFormValue(values[0])
			continue
		}
		items := make([]any, 0, len(values))
		for _, value := range values {
			items = append(items, parseGrok2APIFormValue(value))
		}
		payload[key] = items
	}
	return payload, nil
}

func parseGrok2APIFormValue(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	var parsed any
	if err := json.Unmarshal([]byte(value), &parsed); err == nil {
		return parsed
	}
	return value
}
