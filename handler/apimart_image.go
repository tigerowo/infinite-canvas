package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func normalizeAPIMartImageBody(body []byte, contentType string, modelName string, channel model.ModelChannel) ([]byte, string, error) {
	payload, err := readAPIMartPayload(body, contentType, channel)
	if err != nil {
		return body, contentType, err
	}
	finalModel := strings.TrimSpace(modelName)
	if finalModel == "" {
		finalModel = strings.TrimSpace(toStringSafe(payload["model"]))
	}
	if finalModel != "" {
		payload["model"] = finalModel
	}
	normalizeAPIMartImageParams(payload, finalModel, channel)
	if errMessage := strings.TrimSpace(toStringSafe(payload["_apimart_reference_error"])); errMessage != "" {
		return body, contentType, errors.New(errMessage)
	}
	delete(payload, "_apimart_reference_error")

	encoded, err := json.Marshal(payload)
	if err != nil {
		return body, contentType, err
	}
	return encoded, "application/json", nil
}

func normalizeAPIMartImageParams(payload map[string]any, modelName string, channel model.ModelChannel) {
	config := apimartImageConfig(modelName)
	if config.aspectField == "" {
		config.aspectField = "size"
	}

	normalizeAPIMartResolution(payload, config)
	normalizeAPIMartAspect(payload, config)
	normalizeAPIMartImageCount(payload, config)
	normalizeAPIMartImageQuality(payload, config)
	if apimartImageReferenceExcluded(modelName) {
		clearAPIMartImageReferenceFields(payload)
	} else {
		normalizeAPIMartReferenceInputs(payload, modelName, config, channel)
	}
	if err := validateAPIMartImageRequiredInputs(payload, modelName); err != nil {
		payload["_apimart_reference_error"] = err.Error()
	}
}

func apimartImageConfig(modelName string) apimartInputConfig {
	model := normalizeAPIMartModelName(modelName)
	config := apimartInputConfig{
		aspectField:    "size",
		hasResolution:  true,
		resolutionCase: "upper",
		hasCount:       true,
		imageRefField:  "image_urls",
		imageRefKind:   "array",
	}

	switch {
	case strings.Contains(model, "gpt-image-2") && strings.Contains(model, "official"):
		config.resolutionCase = "lower"
		config.hasQuality = true
		config.hasOutput = true
	case strings.Contains(model, "gpt-image-2"):
		config.resolutionCase = "lower"
		config.hasQuality = true
		config.hasOutput = false
	case strings.Contains(model, "gpt-4o-image"):
		config.hasResolution = false
	case strings.Contains(model, "gpt-image-1"):
		config.hasResolution = false
		config.hasQuality = true
		config.hasOutput = true
	case strings.Contains(model, "gemini-3-1-flash-lite"):
		config.resolutionCase = "upper"
		config.maxResolution = "1K"
	case strings.Contains(model, "gemini-3-1"), strings.Contains(model, "gemini-31"), strings.Contains(model, "nano-banana2"):
		config.resolutionCase = "upper"
		config.hasCount = false
	case strings.Contains(model, "gemini-3-pro"), strings.Contains(model, "nano-banana-pro"):
		config.resolutionCase = "upper"
		config.hasCount = false
	case strings.Contains(model, "gemini-2-5"), strings.Contains(model, "nano-banana"):
		config.resolutionCase = "upper"
		config.maxResolution = "1K"
		config.hasCount = false
	case strings.Contains(model, "imagen"):
		config.hasResolution = false
		config.hasQuality = false
		config.hasCount = false
		config.imageRefField = ""
	case strings.Contains(model, "seedream-5-0-pro"):
		config.resolutionCase = "upper"
		config.maxResolution = "2K"
		config.hasCount = false
		config.maxImageRefs = 10
	case strings.Contains(model, "seedream-5"):
		config.resolutionCase = "upper"
		config.minResolution = "2K"
		config.hasOutput = true
	case strings.Contains(model, "seedream-4-5"), strings.Contains(model, "seedance-4-5"):
		config.resolutionCase = "upper"
		config.minResolution = "2K"
	case strings.Contains(model, "seedream"), strings.Contains(model, "seedance-4"):
		config.resolutionCase = "upper"
	case strings.Contains(model, "qwen"):
		config.resolutionCase = "upper"
		config.maxResolution = "2K"
	case strings.Contains(model, "z-image"):
		config.resolutionCase = "upper"
		config.maxResolution = "2K"
		config.hasCount = false
		config.imageRefField = ""
	case strings.Contains(model, "grok-imagine"):
		config.hasResolution = false
	case strings.Contains(model, "wan2-7"), strings.Contains(model, "wan2.7"):
		config.resolutionCase = "upper"
	case strings.Contains(model, "flux-2"):
		config.resolutionCase = "upper"
		config.hasCount = false
	}
	return config
}

func normalizeAPIMartImageQuality(payload map[string]any, config apimartInputConfig) {
	if config.hasQuality {
		if value := strings.TrimSpace(toStringSafe(payload["quality"])); value != "" {
			payload["quality"] = strings.ToLower(value)
		}
	} else {
		delete(payload, "quality")
	}

	if config.hasOutput {
		value := firstNonEmpty(toStringSafe(payload["output_format"]), toStringSafe(payload["format"]))
		if strings.TrimSpace(value) != "" {
			payload["output_format"] = normalizeAPIMartOutputFormat(value)
		}
	} else {
		delete(payload, "output_format")
	}
	delete(payload, "format")
}

func apimartImageReferenceExcluded(modelName string) bool {
	switch normalizeAPIMartModelName(modelName) {
	case "grok-imagine-1-5-apimart", "imagen-4-0-apimart":
		return true
	default:
		return false
	}
}

func clearAPIMartImageReferenceFields(payload map[string]any) {
	for _, key := range []string{
		"image",
		"images",
		"image_url",
		"image_urls",
		"input_url",
		"input_urls",
		"input_reference",
		"input_reference[]",
		"image_input",
		"reference_image",
		"reference_images",
		"reference_image_url",
		"reference_image_urls",
		"first_frame_url",
		"first_frame_image",
		"last_frame_url",
		"last_frame_image",
	} {
		delete(payload, key)
	}
}

func validateAPIMartImageRequiredInputs(payload map[string]any, modelName string) error {
	model := normalizeAPIMartModelName(modelName)
	if strings.Contains(model, "grok-imagine") && strings.Contains(model, "edit") {
		return requireAPIMartAnyInput(payload, "image_urls")
	}
	return nil
}

func normalizeAPIMartOutputFormat(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	switch value {
	case "jpg":
		return "jpeg"
	case "jpeg", "png", "webp":
		return value
	default:
		return value
	}
}

func copyAPIMartImageResponse(w http.ResponseWriter, response *http.Response, request *http.Request, channel model.ModelChannel, logContext aiLogContext, onFailure func()) bool {
	if !strings.Contains(request.URL.Path, "/images/generations") && !strings.Contains(request.URL.Path, "/images/edits") {
		return false
	}

	payload, err := readLimitedUpstreamResponse(response.Body, "APIMart 图片生成", structuredAdapterResponseLimit)
	if err != nil {
		if onFailure != nil {
			onFailure()
		}
		saveAIProxyLog(logContext, response.StatusCode, "", err.Error())
		Fail(w, "APIMart 响应读取失败")
		return true
	}
	if imageURLs, ok := readAPIMartDirectImageURLs(payload); ok {
		writeAPIMartImagesResponse(w, response.StatusCode, imageURLs, logContext)
		return true
	}

	taskID, _, ok := readAPIMartCreateTask(payload)
	if !ok {
		w.WriteHeader(response.StatusCode)
		_, _ = w.Write(payload)
		saveAIProxyLog(logContext, response.StatusCode, string(payload), "")
		return true
	}

	imageURLs, errorMessage := pollAPIMartImageTask(request, channel, taskID)
	if errorMessage != "" {
		if onFailure != nil {
			onFailure()
		}
		writeAPIMartImageError(w, response.StatusCode, errorMessage, logContext)
		return true
	}
	writeAPIMartImagesResponse(w, response.StatusCode, imageURLs, logContext)
	return true
}

func pollAPIMartImageTask(request *http.Request, channel model.ModelChannel, taskID string) ([]string, string) {
	budget := newUpstreamResponseBudget(request.Context(), "APIMart 图片任务轮询", pollRequestLimit, pollResponseTotalLimit, pollDeadline)
	defer budget.Close()
	pollURL := buildAPIMartTaskURL(channel, taskID)
	for attempt := 0; attempt < 300; attempt++ {
		if attempt > 0 {
			select {
			case <-budget.Context().Done():
				return nil, "APIMart 图片任务轮询超过总体 deadline"
			case <-time.After(2 * time.Second):
			}
		}
		if err := budget.NextRequest(); err != nil {
			return nil, err.Error()
		}

		pollRequest, err := http.NewRequestWithContext(budget.Context(), http.MethodGet, pollURL, nil)
		if err != nil {
			return nil, err.Error()
		}
		pollRequest.Header.Set("Authorization", "Bearer "+channel.APIKey)
		response, err := service.HTTPClientForChannel(channel).Do(pollRequest)
		if err != nil {
			return nil, err.Error()
		}
		body, readErr := budget.ReadAll(response.Body, pollResponseLimit)
		_ = response.Body.Close()
		if readErr != nil {
			return nil, readErr.Error()
		}
		if response.StatusCode >= http.StatusBadRequest {
			return nil, readUpstreamAIErrorMessage(body, response.StatusCode)
		}
		imageURLs, done, errorMessage := readAPIMartImageTaskResult(body)
		if errorMessage != "" {
			return nil, errorMessage
		}
		if done {
			if len(imageURLs) == 0 {
				return nil, "APIMart image task completed but returned no image URL"
			}
			return imageURLs, ""
		}
	}
	return nil, "APIMart image task timed out"
}

func readAPIMartImageTaskResult(payload []byte) ([]string, bool, string) {
	var result struct {
		Code int `json:"code"`
		Data struct {
			Status string         `json:"status"`
			Result map[string]any `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		} `json:"data"`
		Msg string `json:"msg"`
	}
	if err := json.Unmarshal(payload, &result); err != nil {
		return nil, false, err.Error()
	}
	if result.Code != 200 {
		return nil, false, firstNonEmpty(result.Msg, "APIMart image task query failed")
	}

	imageURLs := extractAPIMartImageURLs(result.Data.Result)
	if len(imageURLs) > 0 {
		return imageURLs, true, ""
	}
	switch normalizeAPIMartTaskStatus(result.Data.Status) {
	case "completed":
		return imageURLs, true, ""
	case "failed":
		if result.Data.Error != nil && strings.TrimSpace(result.Data.Error.Message) != "" {
			return nil, false, result.Data.Error.Message
		}
		return nil, false, firstNonEmpty(result.Msg, "APIMart image task failed")
	default:
		return nil, false, ""
	}
}

func extractAPIMartImageURLs(result map[string]any) []string {
	if result == nil {
		return nil
	}
	values := collectAPIMartURLs(result, 0)
	seen := map[string]bool{}
	urls := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] || !(strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://")) {
			continue
		}
		seen[value] = true
		urls = append(urls, value)
	}
	return urls
}

func collectAPIMartURLs(value any, depth int) []string {
	if depth > 6 || value == nil {
		return nil
	}
	switch typed := value.(type) {
	case string:
		text := strings.TrimSpace(typed)
		if strings.HasPrefix(text, "http://") || strings.HasPrefix(text, "https://") {
			return []string{text}
		}
		var parsed any
		if json.Unmarshal([]byte(text), &parsed) == nil {
			return collectAPIMartURLs(parsed, depth+1)
		}
	case []any:
		var result []string
		for _, item := range typed {
			result = append(result, collectAPIMartURLs(item, depth+1)...)
		}
		return result
	case map[string]any:
		var result []string
		for _, key := range []string{"images", "image", "url", "urls", "image_url", "imageUrl", "download_url", "downloadUrl", "data", "result"} {
			result = append(result, collectAPIMartURLs(typed[key], depth+1)...)
		}
		return result
	}
	return nil
}

func readAPIMartDirectImageURLs(payload []byte) ([]string, bool) {
	var result struct {
		Data []struct {
			URL string `json:"url"`
		} `json:"data"`
	}
	if json.Unmarshal(payload, &result) != nil || len(result.Data) == 0 {
		return nil, false
	}
	urls := make([]string, 0, len(result.Data))
	for _, item := range result.Data {
		if strings.TrimSpace(item.URL) != "" {
			urls = append(urls, strings.TrimSpace(item.URL))
		}
	}
	return urls, len(urls) > 0
}

func writeAPIMartImagesResponse(w http.ResponseWriter, statusCode int, imageURLs []string, logContext aiLogContext) {
	items := make([]map[string]any, 0, len(imageURLs))
	for _, imageURL := range imageURLs {
		items = append(items, map[string]any{"url": imageURL})
	}
	converted := map[string]any{
		"created": time.Now().Unix(),
		"data":    items,
	}
	encoded, err := json.Marshal(converted)
	if err != nil {
		writeAPIMartImageError(w, statusCode, err.Error(), logContext)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_, _ = w.Write(encoded)
	saveAIProxyLog(logContext, statusCode, string(encoded), "")
}

func writeAPIMartImageError(w http.ResponseWriter, statusCode int, message string, logContext aiLogContext) {
	if statusCode < http.StatusBadRequest {
		statusCode = http.StatusBadGateway
	}
	body, _ := json.Marshal(map[string]any{
		"error": map[string]any{
			"message": message,
		},
	})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_, _ = w.Write(body)
	saveAIProxyLog(logContext, statusCode, string(body), message)
}
