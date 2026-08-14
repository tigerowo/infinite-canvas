package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"mime"
	"mime/multipart"
	"strings"
	"unicode/utf8"

	"github.com/tigerowo/infinite-canvas/model"
)

const grok2APIImagePromptMaxRunes = 8000

func isGrok2APIFamilyChannel(channel model.ModelChannel, modelName string) bool {
	protocol := strings.ToLower(strings.TrimSpace(channel.Protocol))
	baseURL := strings.ToLower(strings.TrimSpace(channel.BaseURL))
	if protocol == "grok2api" || protocol == "xai" {
		return true
	}
	if strings.Contains(baseURL, "grok2api") || strings.Contains(baseURL, "api.x.ai") || strings.Contains(baseURL, "x.ai/") {
		return true
	}
	// When channel protocol is still openai but the selected model is native Grok media,
	// route it through the grok2api/xAI adapter. KIE/APIMart are checked earlier.
	model := strings.ToLower(strings.TrimSpace(modelName))
	return strings.HasPrefix(model, "grok-imagine-") || strings.HasPrefix(model, "grok-voice-")
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
	normalizeGrok2APIMediaReferences(payload, upstreamPath == "/images/edits")
	if err := sanitizeGrok2APIImageParams(payload, upstreamPath); err != nil {
		return nil, "", err
	}
	keys := []string{"model", "prompt", "aspect_ratio", "resolution", "n", "response_format", "partial_images", "stream", "image", "images", "size"}
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
	normalizeGrok2APIMediaReferences(payload, false)
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

func sanitizeGrok2APIImageParams(payload map[string]any, upstreamPath string) error {
	delete(payload, "quality")

	prompt := toStringSafe(payload["prompt"])
	if runes := utf8.RuneCountInString(prompt); runes > grok2APIImagePromptMaxRunes {
		return fmt.Errorf("Grok/xAI 图片 prompt 最长 %d 字符，当前 %d（含系统提示词）。请缩短提示词或系统提示词", grok2APIImagePromptMaxRunes, runes)
	}

	if ratio := strings.TrimSpace(toStringSafe(payload["aspect_ratio"])); ratio != "" {
		if snapped := snapGrok2APIImageAspectRatio(ratio); snapped != "" {
			payload["aspect_ratio"] = snapped
		} else {
			delete(payload, "aspect_ratio")
		}
	}

	size := strings.ToLower(strings.TrimSpace(toStringSafe(payload["size"])))
	if upstreamPath == "/images/edits" {
		switch size {
		case "", "auto", "1024x1024", "1024x1536", "1536x1024":
			if size != "" {
				payload["size"] = size
			}
		default:
			// Invalid OpenAI-style sizes are dropped; aspect_ratio already carries the intent.
			delete(payload, "size")
		}
	} else {
		delete(payload, "size")
	}

	resolution := strings.ToLower(strings.TrimSpace(toStringSafe(payload["resolution"])))
	switch resolution {
	case "1k", "2k":
		payload["resolution"] = resolution
	case "4k", "high", "hd", "medium":
		payload["resolution"] = "2k"
	case "low", "standard":
		payload["resolution"] = "1k"
	default:
		if resolution != "" {
			delete(payload, "resolution")
		}
	}

	if format := strings.ToLower(strings.TrimSpace(toStringSafe(payload["response_format"]))); format != "" {
		if format != "url" && format != "b64_json" {
			delete(payload, "response_format")
		}
	}
	return nil
}

func snapGrok2APIImageAspectRatio(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	switch value {
	case "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "20:9", "9:20", "19.5:9", "9:19.5", "auto":
		return value
	case "21:9", "7:3":
		return "20:9"
	case "9:21", "3:7":
		return "9:20"
	}
	if parts := strings.Split(value, "x"); len(parts) == 2 {
		var width, height float64
		if _, err := fmt.Sscanf(parts[0], "%f", &width); err == nil {
			if _, err := fmt.Sscanf(parts[1], "%f", &height); err == nil && width > 0 && height > 0 {
				return snapGrok2APIImageAspectRatioByValue(width / height)
			}
		}
	}
	parts := strings.Split(value, ":")
	if len(parts) != 2 {
		return ""
	}
	var width, height float64
	if _, err := fmt.Sscanf(parts[0], "%f", &width); err != nil || width <= 0 {
		return ""
	}
	if _, err := fmt.Sscanf(parts[1], "%f", &height); err != nil || height <= 0 {
		return ""
	}
	return snapGrok2APIImageAspectRatioByValue(width / height)
}

func snapGrok2APIImageAspectRatioByValue(ratio float64) string {
	candidates := []struct {
		label string
		value float64
	}{
		{"1:1", 1},
		{"16:9", 16.0 / 9.0},
		{"9:16", 9.0 / 16.0},
		{"4:3", 4.0 / 3.0},
		{"3:4", 3.0 / 4.0},
		{"3:2", 3.0 / 2.0},
		{"2:3", 2.0 / 3.0},
		{"2:1", 2},
		{"1:2", 0.5},
		{"20:9", 20.0 / 9.0},
		{"9:20", 9.0 / 20.0},
		{"19.5:9", 19.5 / 9.0},
		{"9:19.5", 9.0 / 19.5},
	}
	best := "1:1"
	bestScore := math.MaxFloat64
	for _, item := range candidates {
		score := math.Abs(math.Log(ratio) - math.Log(item.value))
		if score < bestScore {
			best = item.label
			bestScore = score
		}
	}
	return best
}

// normalizeGrok2APIMediaReferences maps legacy image fields.
// Image edits use image/images; video uses image/reference_images.
func normalizeGrok2APIMediaReferences(payload map[string]any, imageEdit bool) {
	var urls []string
	if value, ok := payload["image"]; ok {
		urls = append(urls, collectGrok2APIReferenceURLs(value)...)
		delete(payload, "image")
	}
	legacy := []string{
		"images", "image_url", "image_urls", "reference_image", "reference_image_url",
		"reference_image_urls", "first_frame_url", "first_frame_image",
		"input_reference", "input_reference[]", "image_input", "reference_images",
	}
	for _, key := range legacy {
		if value, ok := payload[key]; ok {
			urls = append(urls, collectGrok2APIReferenceURLs(value)...)
			delete(payload, key)
		}
	}
	// de-dup while preserving order
	seen := map[string]struct{}{}
	unique := make([]string, 0, len(urls))
	for _, url := range urls {
		url = strings.TrimSpace(url)
		if url == "" {
			continue
		}
		if _, ok := seen[url]; ok {
			continue
		}
		seen[url] = struct{}{}
		unique = append(unique, url)
	}
	if len(unique) == 0 {
		return
	}
	if imageEdit {
		if len(unique) == 1 {
			payload["image"] = map[string]any{"url": unique[0]}
			return
		}
		payload["images"] = grok2APIReferenceImageList(unique)
		return
	}
	if len(unique) == 1 {
		payload["image"] = map[string]any{"url": unique[0]}
		return
	}
	payload["reference_images"] = grok2APIReferenceImageList(unique)
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
