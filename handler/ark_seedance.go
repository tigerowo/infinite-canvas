package handler

import (
	"encoding/json"
	"strings"

	"github.com/tigerowo/infinite-canvas/service"
)

func prepareArkSeedanceRequest(input aiProtocolRequest) (aiProtocolRequest, bool, error) {
	if !service.IsArkChannel(input.channel) || input.endpoint != "/videos" {
		return input, false, nil
	}
	input.failureLabel = "火山方舟"
	body, err := normalizeArkSeedanceVideoBody(input.body, input.modelName)
	if err != nil {
		return input, true, err
	}
	input.body = body
	input.contentType = "application/json"
	return input, true, nil
}

func normalizeArkSeedanceVideoBody(body []byte, modelName string) ([]byte, error) {
	payload := map[string]any{}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	if id := strings.TrimSpace(toStringSafe(payload["draft_task_id"])); id != "" {
		return json.Marshal(map[string]any{
			"model":      firstNonEmpty(strings.TrimSpace(modelName), strings.TrimSpace(toStringSafe(payload["model"]))),
			"content":    []any{map[string]any{"type": "draft_task", "draft_task": map[string]any{"id": id}}},
			"resolution": "1080p",
			"watermark":  boolLike(payload["video_watermark"]),
		})
	}
	content := []any{map[string]any{"type": "text", "text": strings.TrimSpace(toStringSafe(payload["prompt"]))}}
	for _, url := range readStringSlice(payload["input_reference[]"]) {
		content = append(content, arkSeedanceReference("image", url, "reference_image"))
	}
	if url := strings.TrimSpace(toStringSafe(payload["first_frame_url"])); url != "" {
		content = append(content, arkSeedanceReference("image", url, "first_frame"))
	}
	if url := strings.TrimSpace(toStringSafe(payload["last_frame_url"])); url != "" {
		content = append(content, arkSeedanceReference("image", url, "last_frame"))
	}
	for _, url := range readStringSlice(payload["video_reference[]"]) {
		content = append(content, arkSeedanceReference("video", url, "reference_video"))
	}
	for _, url := range readStringSlice(payload["audio_reference[]"]) {
		content = append(content, arkSeedanceReference("audio", url, "reference_audio"))
	}
	result := map[string]any{
		"model":   firstNonEmpty(strings.TrimSpace(modelName), strings.TrimSpace(toStringSafe(payload["model"]))),
		"content": content,
	}
	if _, ok := payload["seconds"]; ok {
		result["duration"] = readIntPath(payload, "seconds")
	}
	if ratio := strings.TrimSpace(toStringSafe(payload["size"])); ratio != "" {
		result["ratio"] = ratio
	}
	if resolution := strings.TrimSpace(toStringSafe(payload["resolution_name"])); resolution != "" {
		result["resolution"] = resolution
	}
	if value, ok := payload["video_generate_audio"]; ok {
		result["generate_audio"] = boolLike(value)
	}
	if value, ok := payload["video_watermark"]; ok {
		result["watermark"] = boolLike(value)
	}
	if value, ok := payload["draft"]; ok {
		result["draft"] = boolLike(value)
	}
	return json.Marshal(result)
}

func arkSeedanceReference(kind string, url string, role string) map[string]any {
	field := kind + "_url"
	return map[string]any{
		"type": field,
		field:  map[string]any{"url": strings.TrimSpace(url)},
		"role": role,
	}
}
