package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
)

func isKIEChannel(channel model.ModelChannel, modelName string) bool {
	protocol := strings.ToLower(strings.TrimSpace(channel.Protocol))
	baseURL := strings.ToLower(strings.TrimSpace(channel.BaseURL))
	modelName = strings.ToLower(strings.TrimSpace(modelName))

	return protocol == "kie" ||
		strings.Contains(baseURL, "kie.ai") ||
		strings.Contains(modelName, "kie/")
}

func normalizeKIEVideoBody(body []byte, contentType string, modelName string, channel model.ModelChannel) ([]byte, string, error) {
	payload := map[string]any{}

	if !strings.HasPrefix(strings.ToLower(contentType), "multipart/form-data") {
		_ = json.Unmarshal(body, &payload)
	} else {
		_, params, err := mime.ParseMediaType(contentType)
		if err != nil {
			return body, contentType, nil
		}

		form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
		if err != nil {
			return body, contentType, nil
		}
		defer form.RemoveAll()

		for key, values := range form.Value {
			if len(values) == 0 {
				continue
			}

			if len(values) == 1 {
				payload[key] = parseKIEFormValue(values[0])
				continue
			}

			items := make([]any, 0, len(values))
			for _, value := range values {
				items = append(items, parseKIEFormValue(value))
			}
			payload[key] = items
		}
		if err := mergeKIEFormFiles(payload, form.File, channel); err != nil {
			return body, contentType, err
		}
	}

	finalModel := strings.TrimSpace(modelName)
	if finalModel == "" {
		finalModel = strings.TrimSpace(toStringSafe(payload["model"]))
	}
	finalModel = resolveKIEModelName(finalModel, payload)

	input := map[string]any{}
	if existingInput, ok := payload["input"].(map[string]any); ok {
		for key, value := range existingInput {
			input[key] = value
		}
	}

	mergeKIEPayloadIntoInput(payload, input, finalModel)
	normalizeKIEInputFields(input, finalModel)
	if err := validateKIERequiredInputs(input, finalModel); err != nil {
		return body, contentType, err
	}

	result := map[string]any{
		"model": finalModel,
		"input": input,
	}

	if callBackURL := readKIECallbackURL(payload); callBackURL != "" {
		result["callBackUrl"] = callBackURL
	}

	encoded, err := json.Marshal(result)
	if err != nil {
		return body, contentType, nil
	}

	return encoded, "application/json", nil
}

func parseKIEFormValue(value string) any {
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

func mergeKIEPayloadIntoInput(payload map[string]any, input map[string]any, modelName string) {
	config := kieModelInputConfig(modelName)

	for key, value := range payload {
		if isKIERequestWrapperField(key) || isKIEFrontendOnlyField(key) || isKIEExplicitInputField(key) {
			continue
		}
		if _, exists := input[key]; !exists {
			input[key] = value
		}
	}

	if value, ok := payload["prompt"]; ok && !isEmptyValue(value) {
		input["prompt"] = value
	}

	if value, ok := payload["size"]; ok && !isEmptyValue(value) {
		setKIEAspectInput(input, modelName, value)
		applyKIESizeQualityInput(input, modelName, value, payload)
	}
	if value, ok := payload["image_size"]; ok && !isEmptyValue(value) {
		setKIEAspectInput(input, modelName, value)
		applyKIESizeQualityInput(input, modelName, value, payload)
	}
	if value, ok := payload["ratio"]; ok && !isEmptyValue(value) {
		setKIEAspectInput(input, modelName, value)
	}
	if value, ok := payload["aspect_ratio"]; ok && !isEmptyValue(value) {
		setKIEAspectInput(input, modelName, value)
	}

	for _, key := range kieReferenceAliasKeys() {
		if value, ok := payload[key]; ok && !isEmptyValue(value) {
			if field := setKIEReferenceInput(input, modelName, key, value); field != key {
				delete(input, key)
			}
		}
	}

	if isKIEKlingMotionControlModel(modelName) {
		delete(input, "duration")
		delete(input, "seconds")
	} else {
		if value, ok := payload["duration"]; ok && !isEmptyValue(value) {
			input["duration"] = normalizeKIEDurationInput(value, config)
		}
		if value, ok := payload["seconds"]; ok && !isEmptyValue(value) {
			input["duration"] = normalizeKIEDurationInput(value, config)
		}
	}

	if value, ok := payload["resolution"]; ok && !isEmptyValue(value) {
		setKIEResolutionInput(input, modelName, value)
	}
	if value, ok := payload["image_resolution"]; ok && !isEmptyValue(value) {
		setKIEResolutionInput(input, modelName, value)
	}
	if value, ok := payload["quality"]; ok && !isEmptyValue(value) {
		setKIEQualityResolutionInput(input, modelName, value)
	}
	if value, ok := payload["n"]; ok && !isEmptyValue(value) {
		setKIECountInput(input, modelName, value)
	}
	if value, ok := payload["num_images"]; ok && !isEmptyValue(value) {
		setKIECountInput(input, modelName, value)
	}
	if value, ok := payload["max_images"]; ok && !isEmptyValue(value) {
		setKIECountInput(input, modelName, value)
	}
	if value, ok := payload["actual_image_count"]; ok && !isEmptyValue(value) {
		setKIECountInput(input, modelName, value)
	}

	if meta, ok := payload["metadata"].(map[string]any); ok {
		if value, ok := meta["resolution_name"]; ok && !isEmptyValue(value) {
			if isKIEKlingMotionControlModel(modelName) {
				input["mode"] = normalizeKIEKlingMotionControlMode(value)
			} else {
				setKIEResolutionInput(input, modelName, value)
			}
		}
		if value, ok := meta["preset"]; ok && !isEmptyValue(value) && config.presetField != "" {
			input[config.presetField] = strings.TrimSpace(toStringSafe(value))
		}
	}
}

func isKIERequestWrapperField(key string) bool {
	switch key {
	case "model", "input", "metadata", "callBackUrl", "callbackUrl", "callback_url":
		return true
	default:
		return false
	}
}

func isKIEExplicitInputField(key string) bool {
	switch key {
	case "prompt", "size", "ratio", "aspect_ratio", "image_size", "seconds", "duration", "resolution", "image_resolution", "n", "num_images", "max_images",
		"image", "images", "image_url", "image_urls", "input_url", "input_urls", "input_reference", "input_reference[]", "image_input", "reference_image", "reference_images", "reference_image_url", "reference_image_urls", "mask_url", "first_frame_url", "last_frame_url", "end_image_url", "tail_image_url":
		return true
	case "video", "videos", "video_url", "video_urls", "input_video_url", "input_video_urls", "first_clip_url", "reference_video", "reference_videos", "reference_video_url", "reference_video_urls":
		return true
	case "audio", "audios", "audio_url", "audio_urls", "input_audio_url", "input_audio_urls", "reference_audio", "reference_audios", "reference_audio_url", "reference_audio_urls", "audio_reference", "audio_reference[]", "driving_audio_url", "reference_voice", "audio_ids":
		return true
	default:
		return false
	}
}

func isKIEFrontendOnlyField(key string) bool {
	switch key {
	case "actual_image_count", "moderation", "response_format", "stream", "partial_images", "output_compression":
		return true
	default:
		return false
	}
}

func normalizeKIEInputFields(input map[string]any, modelName string) {
	config := kieModelInputConfig(modelName)
	layerSize, layerQuality := input["size"], input["quality"]

	if value, ok := input["resolution_name"]; ok {
		if !isEmptyValue(value) {
			if isKIEKlingMotionControlModel(modelName) {
				input["mode"] = normalizeKIEKlingMotionControlMode(value)
			} else {
				setKIEResolutionInput(input, modelName, value)
			}
		}
		delete(input, "resolution_name")
	}

	if value, ok := input["preset"]; ok {
		if !isEmptyValue(value) && config.presetField != "" {
			input[config.presetField] = strings.TrimSpace(toStringSafe(value))
		}
		delete(input, "preset")
	}

	if value, ok := input["size"]; ok {
		setKIEAspectInput(input, modelName, value)
	}

	if value, ok := input["image_size"]; ok {
		setKIEAspectInput(input, modelName, value)
		if config.aspectField != "image_size" {
			delete(input, "image_size")
		}
	}

	if value, ok := input["ratio"]; ok {
		setKIEAspectInput(input, modelName, value)
		if config.aspectField != "ratio" {
			delete(input, "ratio")
		}
	}

	if value, ok := input["aspect_ratio"]; ok {
		setKIEAspectInput(input, modelName, value)
		if config.aspectField == "ratio" {
			delete(input, "aspect_ratio")
		}
	}

	for _, key := range kieReferenceAliasKeys() {
		if value, ok := input[key]; ok {
			if field := setKIEReferenceInput(input, modelName, key, value); field != key {
				delete(input, key)
			}
		}
	}
	if isKIESeedreamLayerDecompositionModel(modelName) {
		normalizeKIESeedreamLayerDecompositionInput(input, layerSize, layerQuality)
		return
	}

	if value, ok := input["resolution"]; ok {
		setKIEResolutionInput(input, modelName, value)
		if kieResolutionField(config) != "resolution" {
			delete(input, "resolution")
		}
	}

	if value, ok := input["image_resolution"]; ok {
		setKIEResolutionInput(input, modelName, value)
		if kieResolutionField(config) != "image_resolution" {
			delete(input, "image_resolution")
		}
	}

	if value, ok := input["quality"]; ok {
		if config.hasQuality {
			input["quality"] = normalizeKIEImageQuality(modelName, value)
		} else {
			setKIEQualityResolutionInput(input, modelName, value)
			delete(input, "quality")
		}
	}

	if value, ok := input["n"]; ok {
		setKIECountInput(input, modelName, value)
		if config.countField != "n" {
			delete(input, "n")
		}
	}

	if value, ok := input["num_images"]; ok {
		setKIECountInput(input, modelName, value)
		if config.countField != "num_images" {
			delete(input, "num_images")
		}
	}

	if value, ok := input["max_images"]; ok {
		setKIECountInput(input, modelName, value)
		if config.countField != "max_images" {
			delete(input, "max_images")
		}
	}

	if value, ok := input["actual_image_count"]; ok {
		setKIECountInput(input, modelName, value)
		delete(input, "actual_image_count")
	}

	if isKIEKlingMotionControlModel(modelName) {
		delete(input, "seconds")
		delete(input, "duration")
	} else {
		if value, ok := input["seconds"]; ok {
			if !isEmptyValue(value) {
				input["duration"] = normalizeKIEDurationInput(value, config)
			}
			delete(input, "seconds")
		}

		if value, ok := input["duration"]; ok {
			input["duration"] = normalizeKIEDurationInput(value, config)
		}
	}

	normalizeKIEKlingV3VideoInput(input, modelName)
	applyKIEVideoGenerateAudioInput(input, modelName)
	normalizeKIEKlingOmniVideoInput(input, modelName)
	if value, ok := input["output_format"]; ok {
		if config.hasOutputFormat {
			input["output_format"] = normalizeKIEOutputFormat(toStringSafe(value))
		} else {
			delete(input, "output_format")
		}
	}

	applyKIEModelDefaults(input, modelName)

	for key := range input {
		if isKIEFrontendOnlyField(key) {
			delete(input, key)
		}
	}
}

func isKIESeedreamLayerDecompositionModel(modelName string) bool {
	return strings.EqualFold(strings.TrimSpace(modelName), "seedream/5-pro-layer-decomposition")
}

func normalizeKIESeedreamLayerDecompositionInput(input map[string]any, size any, quality any) {
	clearKIEReferenceAliases(input, "image_url")
	resolution := strings.ToLower(strings.TrimSpace(toStringSafe(size)))
	switch resolution {
	case "1k", "1.5k", "2k":
		input["size"] = strings.ToUpper(resolution)
	case "auto":
		input["size"] = "auto"
	default:
		switch strings.ToLower(strings.TrimSpace(toStringSafe(quality))) {
		case "low":
			input["size"] = "1K"
		case "medium":
			input["size"] = "1.5K"
		case "high":
			input["size"] = "2K"
		default:
			input["size"] = "auto"
		}
	}
	input["output_format"] = "png"
	for _, key := range []string{"quality", "ratio", "aspect_ratio", "image_size", "resolution", "image_resolution", "n", "num_images", "max_images", "actual_image_count"} {
		delete(input, key)
	}
	for key := range input {
		if isKIEFrontendOnlyField(key) {
			delete(input, key)
		}
	}
}

func setKIEAspectInput(input map[string]any, modelName string, value any) {
	config := kieModelInputConfig(modelName)
	field := config.aspectField
	if field == "" {
		delete(input, "size")
		delete(input, "ratio")
		delete(input, "aspect_ratio")
		delete(input, "image_size")
		return
	}

	setKIESizeResolutionInput(input, modelName, value)
	normalized := normalizeKIEAspectValue(toStringSafe(value), config.aspectKind)
	delete(input, "size")

	if field == "ratio" {
		delete(input, "aspect_ratio")
		delete(input, "image_size")
		input["ratio"] = normalized
		return
	}

	if field == "image_size" {
		delete(input, "ratio")
		delete(input, "aspect_ratio")
		input["image_size"] = normalized
		return
	}

	delete(input, "ratio")
	delete(input, "image_size")
	input["aspect_ratio"] = normalized
}

func normalizeKIEAspectRatio(value string) string {
	value = strings.ReplaceAll(strings.TrimSpace(strings.ToLower(value)), " ", "")

	switch value {
	case "", "auto", "adaptive":
		return value
	case "landscape":
		return "16:9"
	case "portrait":
		return "9:16"
	case "square", "square_hd":
		return "1:1"
	case "landscape_16_9":
		return "16:9"
	case "portrait_16_9":
		return "9:16"
	case "landscape_4_3":
		return "4:3"
	case "portrait_4_3":
		return "3:4"
	case "1280x720", "1920x1080", "1024x576", "720x405":
		return "16:9"
	case "720x1280", "1080x1920", "576x1024", "405x720":
		return "9:16"
	case "1024x1024", "1080x1080", "960x960":
		return "1:1"
	default:
		if ratio, ok := normalizeKIEAspectPair(value); ok {
			return ratio
		}
		return value
	}
}

func isKIEKlingMotionControlModel(modelName string) bool {
	switch strings.ToLower(strings.TrimSpace(modelName)) {
	case "kling-2.6/motion-control", "kling-3.0/motion-control":
		return true
	default:
		return false
	}
}

func normalizeKIEKlingMotionControlMode(value any) string {
	switch strings.ToLower(normalizeKIEResolution(toStringSafe(value))) {
	case "1080p":
		return "1080p"
	default:
		return "720p"
	}
}

func normalizeKIEResolution(value string) string {
	value = strings.ReplaceAll(strings.TrimSpace(value), " ", "")

	switch strings.ToLower(value) {
	case "":
		return ""
	case "480":
		return "480p"
	case "720":
		return "720p"
	case "1080":
		return "1080p"
	default:
		return value
	}
}

func normalizeKIEHailuoVideoResolution(value string) string {
	value = strings.ReplaceAll(strings.TrimSpace(value), " ", "")

	switch strings.ToLower(value) {
	case "480", "480p", "512", "512p":
		return "512P"
	case "720", "720p", "768", "768p":
		return "768P"
	default:
		return value
	}
}

func normalizeKIEMiniMaxH3VideoResolution(value string) string {
	value = strings.ReplaceAll(strings.TrimSpace(value), " ", "")

	switch strings.ToLower(value) {
	case "480", "480p", "720", "720p", "768", "768p":
		return "768P"
	case "1080", "1080p", "2k", "2048", "2048p":
		return "2K"
	default:
		return value
	}
}

func normalizeKIESeedance25VideoResolution(value string) string {
	value = strings.ReplaceAll(strings.TrimSpace(value), " ", "")
	switch strings.ToLower(value) {
	case "1080", "1080p", "2k", "4k":
		return "720p"
	default:
		return normalizeKIEResolution(value)
	}
}

func normalizeKIEImageQuality(modelName string, value any) string {
	quality := strings.ToLower(strings.TrimSpace(toStringSafe(value)))
	model := strings.ToLower(strings.TrimSpace(modelName))
	switch {
	case strings.HasPrefix(model, "gpt-image/1.5"):
		if quality == "high" {
			return "high"
		}
		return "medium"
	case strings.HasPrefix(model, "seedream/4.5") || strings.HasPrefix(model, "seedream/5-lite"):
		if quality == "high" || quality == "4k" {
			return "high"
		}
		return "basic"
	case strings.HasPrefix(model, "seedream/5-pro"):
		if quality == "high" || quality == "2k" {
			return "high"
		}
		return "basic"
	default:
		return quality
	}
}

func applyKIESizeQualityInput(input map[string]any, modelName string, value any, payload map[string]any) {
	config := kieModelInputConfig(modelName)
	if !config.hasQuality || kieResolutionField(config) != "" {
		return
	}
	if payloadQuality, ok := payload["quality"]; ok && !isEmptyValue(payloadQuality) && strings.ToLower(strings.TrimSpace(toStringSafe(payloadQuality))) != "auto" {
		return
	}
	resolution := normalizeKIESizeResolution(toStringSafe(value))
	if resolution == "" {
		return
	}
	input["quality"] = normalizeKIEImageQuality(modelName, resolution)
}

func normalizeKIEKlingV3VideoInput(input map[string]any, modelName string) {
	if strings.ToLower(strings.TrimSpace(modelName)) != "kling-3.0/video" {
		return
	}

	delete(input, "negative_prompt")
	delete(input, "shot_type")

	if value, ok := input["mode"]; ok && !isEmptyValue(value) {
		input["mode"] = normalizeKIEKlingV3Mode(value)
	}
	if value, ok := input["multi_shot"]; ok {
		input["multi_shots"] = boolLike(value)
		delete(input, "multi_shot")
	}
	if value, ok := input["multi_shots"]; ok {
		input["multi_shots"] = boolLike(value)
	}
	if value, ok := input["multi_prompt"]; ok {
		if prompts := normalizeKIEKlingV3MultiPrompt(value); len(prompts) > 0 {
			input["multi_prompt"] = prompts
		} else {
			delete(input, "multi_prompt")
		}
	}
	if value, ok := input["element_list"]; ok {
		if elements := normalizeKIEKlingV3Elements(value); len(elements) > 0 {
			input["kling_elements"] = elements
		}
		delete(input, "element_list")
	}
	if value, ok := input["kling_elements"]; ok {
		if elements := normalizeKIEKlingV3Elements(value); len(elements) > 0 {
			input["kling_elements"] = elements
		} else {
			delete(input, "kling_elements")
		}
	}
}

func normalizeKIEKlingOmniVideoInput(input map[string]any, modelName string) {
	variant := kieKlingOmniVariant(modelName)
	if variant == "" {
		return
	}

	delete(input, "negative_prompt")
	if value, ok := input["resolution"]; ok && !isEmptyValue(value) {
		input["resolution"] = normalizeKIEKlingOmniResolution(value)
	}
	if value, ok := input["mode"]; ok && !isEmptyValue(value) {
		input["resolution"] = normalizeKIEKlingOmniResolution(value)
	}
	delete(input, "mode")

	if value, ok := input["element_list"]; ok {
		if elements := normalizeKIEKlingV3Elements(value); len(elements) > 0 {
			input["elements"] = elements
		} else {
			delete(input, "elements")
		}
		delete(input, "element_list")
	} else if value, ok := input["elements"]; ok {
		if elements := normalizeKIEKlingV3Elements(value); len(elements) > 0 {
			input["elements"] = elements
		} else {
			delete(input, "elements")
		}
	}
	delete(input, "kling_elements")

	multiShot, hasMultiShot := input["multi_shot"]
	if !hasMultiShot {
		multiShot, hasMultiShot = input["multi_shots"]
	}
	delete(input, "multi_shot")
	delete(input, "multi_shots")
	shotType := strings.ToLower(strings.TrimSpace(toStringSafe(input["shot_type"])))
	delete(input, "shot_type")

	switch variant {
	case "text-to-video", "image-to-video":
		customShots := boolLike(input["customize_multi_shots"])
		smartShots := boolLike(input["prefer_multi_shots"])
		if hasMultiShot {
			customShots = boolLike(multiShot) && shotType == "customize"
			smartShots = boolLike(multiShot) && !customShots
		}
		if customShots {
			smartShots = false
		}
		input["customize_multi_shots"] = customShots
		input["prefer_multi_shots"] = smartShots
		if !customShots {
			delete(input, "multi_prompt")
		}
	case "reference-to-video":
		customShots := boolLike(input["customize_multi_shots"])
		if hasMultiShot {
			customShots = boolLike(multiShot)
		}
		input["customize_multi_shots"] = customShots
		delete(input, "prefer_multi_shots")
		if !customShots {
			delete(input, "multi_prompt")
		}
	case "transformation":
		delete(input, "customize_multi_shots")
		delete(input, "prefer_multi_shots")
		delete(input, "multi_prompt")
		delete(input, "elements")
	}

	if value, ok := input["multi_prompt"]; ok {
		if prompts := normalizeKIEKlingMultiPrompt(value, 15); len(prompts) > 0 {
			if len(prompts) > 6 {
				prompts = prompts[:6]
			}
			input["multi_prompt"] = prompts
		} else {
			delete(input, "multi_prompt")
		}
	}

	imageCount := len(readStringSlice(input["image_urls"]))
	hasVideo := len(readStringSlice(input["video_urls"])) > 0
	switch variant {
	case "text-to-video":
		for _, key := range append(kieImageReferenceAliasKeys(), kieVideoReferenceAliasKeys()...) {
			delete(input, key)
		}
	case "image-to-video":
		if imageCount > 1 {
			input["aspect_ratio"] = "auto"
		}
		for _, key := range kieVideoReferenceAliasKeys() {
			delete(input, key)
		}
	case "reference-to-video":
		if hasVideo {
			input["aspect_ratio"] = "auto"
			input["audio"] = false
			if imageCount == 0 && isEmptyValue(input["elements"]) {
				delete(input, "duration")
				input["customize_multi_shots"] = false
				delete(input, "multi_prompt")
			}
		}
	case "transformation":
		if hasVideo && imageCount == 0 {
			input["aspect_ratio"] = "auto"
			delete(input, "duration")
		}
	}
}

func kieKlingOmniVariant(modelName string) string {
	const prefix = "kling-3.0-omni/"
	modelName = strings.ToLower(strings.TrimSpace(modelName))
	if !strings.HasPrefix(modelName, prefix) {
		return ""
	}
	variant := strings.TrimPrefix(modelName, prefix)
	switch variant {
	case "text-to-video", "image-to-video", "reference-to-video", "transformation":
		return variant
	default:
		return ""
	}
}

func normalizeKIEKlingOmniResolution(value any) string {
	switch strings.ToLower(strings.TrimSpace(toStringSafe(value))) {
	case "4k":
		return "4k"
	case "pro", "1080", "1080p":
		return "1080p"
	default:
		return "720p"
	}
}

func normalizeKIEKlingV3Mode(value any) string {
	switch strings.ToLower(strings.TrimSpace(toStringSafe(value))) {
	case "4k":
		return "4K"
	case "pro":
		return "pro"
	default:
		return "std"
	}
}

func normalizeKIEKlingV3MultiPrompt(value any) []map[string]any {
	return normalizeKIEKlingMultiPrompt(value, 12)
}

func normalizeKIEKlingMultiPrompt(value any, maxDuration int) []map[string]any {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		result = append(result, map[string]any{
			"prompt":   strings.TrimSpace(toStringSafe(record["prompt"])),
			"duration": normalizeKIEKlingMultiPromptDuration(record["duration"], maxDuration),
		})
	}
	return result
}

func normalizeKIEKlingMultiPromptDuration(value any, maxDuration int) int {
	duration, err := strconv.Atoi(normalizeKIEDurationString(toStringSafe(value)))
	if err != nil || duration < 1 {
		duration = 1
	}
	if duration > maxDuration {
		duration = maxDuration
	}
	return duration
}

func normalizeKIEKlingV3Elements(value any) []map[string]any {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		inputURLs := readStringSlice(record["element_input_urls"])
		audioURLs := readStringSlice(record["element_input_audio_urls"])
		if refs, ok := record["references"].([]any); ok {
			for _, ref := range refs {
				refRecord, ok := ref.(map[string]any)
				if !ok {
					continue
				}
				url := strings.TrimSpace(toStringSafe(refRecord["url"]))
				if url == "" {
					continue
				}
				if strings.ToLower(strings.TrimSpace(toStringSafe(refRecord["kind"]))) == "audio" {
					audioURLs = append(audioURLs, url)
				} else {
					inputURLs = append(inputURLs, url)
				}
			}
		}
		if len(inputURLs) == 0 && len(audioURLs) == 0 {
			continue
		}
		next := map[string]any{
			"name":        strings.TrimSpace(toStringSafe(record["name"])),
			"description": strings.TrimSpace(toStringSafe(record["description"])),
		}
		if len(inputURLs) > 0 {
			next["element_input_urls"] = inputURLs
		}
		if len(audioURLs) > 0 {
			next["element_input_audio_urls"] = audioURLs
		}
		result = append(result, next)
	}
	return result
}

func applyKIEModelDefaults(input map[string]any, modelName string) {
	switch strings.ToLower(strings.TrimSpace(modelName)) {
	case "minimax-h3/text-to-video":
		if _, ok := input["aspect_ratio"]; !ok {
			input["aspect_ratio"] = "16:9"
		}
	case "kling-2.6/text-to-video", "kling-2.6/image-to-video":
		if _, ok := input["sound"]; !ok {
			input["sound"] = false
		}
	case "kling-2.6/motion-control":
		if _, ok := input["mode"]; !ok {
			input["mode"] = "720p"
		}
	case "kling-3.0/motion-control":
		if _, ok := input["mode"]; !ok {
			input["mode"] = "720p"
		}
	case "bytedance/seedance-2", "bytedance/seedance-2-fast":
		if _, ok := input["return_last_frame"]; !ok {
			input["return_last_frame"] = false
		}
	case "wan/2-6-flash-image-to-video":
		if _, ok := input["audio"]; !ok {
			input["audio"] = false
		}
		if _, ok := input["multi_shots"]; !ok {
			input["multi_shots"] = false
		}
	case "wan/2-6-flash-video-to-video":
		if _, ok := input["audio"]; !ok {
			input["audio"] = false
		}
		if _, ok := input["multi_shots"]; !ok {
			input["multi_shots"] = false
		}
	case "topaz/image-upscale":
		if _, ok := input["upscale_factor"]; !ok {
			input["upscale_factor"] = "2"
		}
	}
}

func applyKIEVideoGenerateAudioInput(input map[string]any, modelName string) {
	value, ok := input["video_generate_audio"]
	if !ok {
		return
	}
	delete(input, "video_generate_audio")
	enabled := boolLike(value)
	switch strings.ToLower(strings.TrimSpace(modelName)) {
	case "kling-2.6/text-to-video", "kling-2.6/image-to-video":
		input["sound"] = enabled
	case "kling-3.0/video":
		input["sound"] = enabled
	case "kling-3.0-omni/text-to-video", "kling-3.0-omni/image-to-video", "kling-3.0-omni/reference-to-video", "kling-3.0-omni/transformation":
		input["audio"] = enabled
	case "bytedance/seedance-2", "bytedance/seedance-2-fast", "bytedance/seedance-2-mini", "bytedance/seedance-1.5-pro", "bytedance/seedance-1-5-pro", "bytedance/seedance-2-5":
    	input["generate_audio"] = enabled
	case "wan/2-6-flash-image-to-video", "wan/2-6-flash-video-to-video":
		input["audio"] = enabled
	}
}

func validateKIERequiredInputs(input map[string]any, modelName string) error {
	model := strings.ToLower(strings.TrimSpace(modelName))
	switch model {
	case "kling-3.0-omni/text-to-video":
		return requireKIEAnyInput(input, "prompt")
	case "kling-3.0-omni/image-to-video":
		return requireKIEAnyInput(input, "image_urls")
	case "kling-3.0-omni/reference-to-video":
		return requireKIEAnyInput(input, "image_urls", "video_urls", "elements")
	case "kling-3.0-omni/transformation":
		return requireKIEAnyInput(input, "video_urls")
	case "kling/v3-turbo-text-to-video", "bytedance/seedance-2-mini", "happyhorse-1-1/text-to-video":
		return requireKIEAnyInput(input, "prompt")
	case "kling/v3-turbo-image-to-video", "happyhorse-1-1/image-to-video":
		return requireKIEAnyInput(input, "image_urls")
	case "happyhorse-1-1/reference-to-video":
		return requireKIEAnyInput(input, "reference_image")
	case "flux-2/flex-image-to-image", "flux-2/pro-image-to-image", "gpt-image-2-image-to-image", "gpt-image/1.5-image-to-image":
		return requireKIEAnyInput(input, "input_urls")
	case "google/nano-banana-edit", "grok-imagine/image-to-image", "seedream/4.5-edit", "seedream/5-lite-image-to-image", "seedream/5-pro-image-to-image", "bytedance/seedream-v4-edit":
		return requireKIEAnyInput(input, "image_urls")
	case "qwen/image-to-image", "qwen/image-edit", "qwen2/image-edit", "ideogram/v3-remix", "seedream/5-pro-layer-decomposition":
		return requireKIEAnyInput(input, "image_url")
	case "ideogram/character":
		return requireKIEAnyInput(input, "reference_image_urls")
	case "ideogram/v3-edit":
		if err := requireKIEAnyInput(input, "image_url"); err != nil {
			return err
		}
		return requireKIEAnyInput(input, "mask_url")
	case "ideogram/character-edit":
		if err := requireKIEAnyInput(input, "image_url"); err != nil {
			return err
		}
		if err := requireKIEAnyInput(input, "mask_url"); err != nil {
			return err
		}
		return requireKIEAnyInput(input, "reference_image_urls")
	case "ideogram/character-remix":
		if err := requireKIEAnyInput(input, "image_url"); err != nil {
			return err
		}
		return requireKIEAnyInput(input, "reference_image_urls")
	case "topaz/image-upscale":
		return requireKIEAnyInput(input, "image_url")
	case "recraft/crisp-upscale", "recraft/remove-background":
		return requireKIEAnyInput(input, "image")
	case "topaz/video-upscale":
		return requireKIEAnyInput(input, "video_url")
	case "infinitalk/from-audio":
		if err := requireKIEAnyInput(input, "image_url"); err != nil {
			return err
		}
		return requireKIEAnyInput(input, "audio_url")
	case "kling/ai-avatar-standard", "kling/ai-avatar-pro":
		if err := requireKIEAnyInput(input, "image_url"); err != nil {
			return err
		}
		return requireKIEAnyInput(input, "audio_url")
	case "wan/2-2-a14b-speech-to-video-turbo":
		if err := requireKIEAnyInput(input, "image_url"); err != nil {
			return err
		}
		return requireKIEAnyInput(input, "audio_url")
	case "wan/2-7-videoedit":
		return requireKIEAnyInput(input, "video_url")
	case "wan/2-7-r2v":
		return requireKIEAnyInput(input, "reference_image", "reference_video")
	case "kling-2.6/motion-control", "kling-3.0/motion-control":
		if err := requireKIEAnyInput(input, "input_urls"); err != nil {
			return err
		}
		return requireKIEAnyInput(input, "video_urls")
	case "happyhorse/reference-to-video":
		return requireKIEAnyInput(input, "reference_image")
	}
	if strings.Contains(model, "image-to-video") || strings.Contains(model, "image_to_video") {
		return requireKIEAnyInput(input, "image_url", "image_urls", "input_urls", "first_frame_url", "image_input")
	}
	if strings.Contains(model, "video-to-video") || strings.Contains(model, "video_to_video") || strings.Contains(model, "videoedit") || strings.Contains(model, "video-edit") || strings.Contains(model, "motion-control") {
		return requireKIEAnyInput(input, "video_url", "video_urls", "input_video_urls", "first_clip_url", "reference_video", "reference_video_urls")
	}
	return nil
}

func requireKIEAnyInput(input map[string]any, fields ...string) error {
	for _, field := range fields {
		if !isEmptyValue(input[field]) {
			return nil
		}
	}
	return errors.New("KIE required input missing: " + strings.Join(fields, " or "))
}

type kieInputConfig struct {
	aspectField     string
	aspectKind      string
	durationKind    string
	durationMin     int
	durationMax     int
	hasResolution   bool
	resolutionField string
	resolutionKind  string
	maxResolution   string
	countField      string
	countKind       string
	hasQuality      bool
	hasOutputFormat bool
	presetField     string
	imageRefField   string
	imageRefKind    string
	videoRefField   string
	videoRefKind    string
	audioRefField   string
	audioRefKind    string
}

func kieModelInputConfig(modelName string) kieInputConfig {
	modelName = strings.ToLower(strings.TrimSpace(modelName))
	configs := map[string]kieInputConfig{
		"bytedance/seedance-1.5-pro":           {aspectField: "aspect_ratio", durationKind: "number", hasResolution: true, imageRefField: "input_urls", imageRefKind: "array"},
		"bytedance/seedance-2":                 {aspectField: "aspect_ratio", durationKind: "number", hasResolution: true, imageRefField: "reference_image_urls", imageRefKind: "array", videoRefField: "reference_video_urls", videoRefKind: "array", audioRefField: "reference_audio_urls", audioRefKind: "array"},
		"bytedance/seedance-2-fast":            {aspectField: "aspect_ratio", durationKind: "number", hasResolution: true, imageRefField: "reference_image_urls", imageRefKind: "array", videoRefField: "reference_video_urls", videoRefKind: "array", audioRefField: "reference_audio_urls", audioRefKind: "array"},
		"bytedance/seedance-2-mini":            {aspectField: "aspect_ratio", durationKind: "number", hasResolution: true, imageRefField: "reference_image_urls", imageRefKind: "array", videoRefField: "reference_video_urls", videoRefKind: "array", audioRefField: "reference_audio_urls", audioRefKind: "array"},
		"bytedance/seedance-2-5":               {aspectField: "aspect_ratio", durationKind: "number", durationMin: 4, durationMax: 30, hasResolution: true, resolutionKind: "seedance_2_5_video", imageRefField: "reference_image_urls", imageRefKind: "array", videoRefField: "reference_video_urls", videoRefKind: "array", audioRefField: "reference_audio_urls", audioRefKind: "array"},
		"bytedance/v1-lite-image-to-video":     {durationKind: "string", hasResolution: true, imageRefField: "image_url", imageRefKind: "single"},
		"bytedance/v1-lite-text-to-video":      {aspectField: "aspect_ratio", durationKind: "string", hasResolution: true},
		"bytedance/v1-pro-fast-image-to-video": {durationKind: "string", hasResolution: true, imageRefField: "image_url", imageRefKind: "single"},
		"bytedance/v1-pro-image-to-video":      {durationKind: "string", hasResolution: true, imageRefField: "image_url", imageRefKind: "single"},
		"bytedance/v1-pro-text-to-video":       {aspectField: "aspect_ratio", durationKind: "string", hasResolution: true},

		"gemini-omni-video":                 {aspectField: "aspect_ratio", durationKind: "string", hasResolution: true, imageRefField: "image_urls", imageRefKind: "array", videoRefField: "video_list", videoRefKind: "gemini_video_list", audioRefField: "audio_ids", audioRefKind: "array"},
		"grok-imagine/image-to-video":       {aspectField: "aspect_ratio", durationKind: "string", durationMin: 6, durationMax: 30, hasResolution: true, presetField: "mode", imageRefField: "image_urls", imageRefKind: "array"},
		"grok-imagine/text-to-video":        {aspectField: "aspect_ratio", durationKind: "string", durationMin: 6, durationMax: 30, hasResolution: true, presetField: "mode"},
		"grok-imagine-video-1-5-preview":    {aspectField: "aspect_ratio", durationKind: "number", hasResolution: true, imageRefField: "image_urls", imageRefKind: "array"},
		"happyhorse/image-to-video":         {durationKind: "number", hasResolution: true, imageRefField: "image_urls", imageRefKind: "array"},
		"happyhorse/reference-to-video":     {aspectField: "aspect_ratio", durationKind: "number", hasResolution: true, imageRefField: "reference_image", imageRefKind: "array"},
		"happyhorse/text-to-video":          {aspectField: "aspect_ratio", durationKind: "number", hasResolution: true},
		"happyhorse/video-edit":             {hasResolution: true, imageRefField: "reference_image", imageRefKind: "array", videoRefField: "video_url", videoRefKind: "single"},
		"happyhorse-1-1/text-to-video":      {aspectField: "aspect_ratio", durationKind: "number", hasResolution: true},
		"happyhorse-1-1/image-to-video":     {durationKind: "number", hasResolution: true, imageRefField: "image_urls", imageRefKind: "single_array"},
		"happyhorse-1-1/reference-to-video": {aspectField: "aspect_ratio", durationKind: "number", hasResolution: true, imageRefField: "reference_image", imageRefKind: "array"},

		"minimax-h3/text-to-video":           {aspectField: "aspect_ratio", durationKind: "number", durationMin: 4, durationMax: 15, hasResolution: true, resolutionKind: "minimax_h3_video"},
		"minimax-h3/image-to-video":          {durationKind: "number", durationMin: 4, durationMax: 15, hasResolution: true, resolutionKind: "minimax_h3_video", imageRefField: "first_frame_url", imageRefKind: "single"},
		"minimax-h3/reference-to-video":      {aspectField: "aspect_ratio", durationKind: "number", durationMin: 4, durationMax: 15, hasResolution: true, resolutionKind: "minimax_h3_video", imageRefField: "reference_image_urls", imageRefKind: "array", videoRefField: "reference_video_urls", videoRefKind: "array", audioRefField: "reference_audio_urls", audioRefKind: "array"},
		"hailuo/02-image-to-video-standard":  {durationKind: "string", hasResolution: true, resolutionKind: "hailuo_video", imageRefField: "image_url", imageRefKind: "single"},
		"hailuo/02-image-to-video-pro":       {durationKind: "string", hasResolution: true, resolutionKind: "hailuo_video", imageRefField: "image_url", imageRefKind: "single"},
		"hailuo/02-text-to-video-standard":   {durationKind: "string"},
		"hailuo/02-text-to-video-pro":        {durationKind: "string"},
		"hailuo/2-3-image-to-video-pro":      {durationKind: "string", hasResolution: true, resolutionKind: "hailuo_video", imageRefField: "image_url", imageRefKind: "single"},
		"hailuo/2-3-image-to-video-standard": {durationKind: "string", hasResolution: true, resolutionKind: "hailuo_video", imageRefField: "image_url", imageRefKind: "single"},

		"kling-2.6/image-to-video":            {durationKind: "string", imageRefField: "image_urls", imageRefKind: "array"},
		"kling-2.6/text-to-video":             {aspectField: "aspect_ratio", durationKind: "string"},
		"kling-2.6/motion-control":            {durationKind: "string", imageRefField: "input_urls", imageRefKind: "array", videoRefField: "video_urls", videoRefKind: "array"},
		"kling-3.0/motion-control":            {durationKind: "string", imageRefField: "input_urls", imageRefKind: "array", videoRefField: "video_urls", videoRefKind: "array"},
		"kling-3.0/video":                     {aspectField: "aspect_ratio", durationKind: "string", presetField: "mode", imageRefField: "image_urls", imageRefKind: "array"},
		"kling-3.0-omni/text-to-video":        {aspectField: "aspect_ratio", durationKind: "number", durationMin: 3, durationMax: 15, hasResolution: true},
		"kling-3.0-omni/image-to-video":       {aspectField: "aspect_ratio", durationKind: "number", durationMin: 3, durationMax: 15, hasResolution: true, imageRefField: "image_urls", imageRefKind: "array"},
		"kling-3.0-omni/reference-to-video":   {aspectField: "aspect_ratio", durationKind: "number", durationMin: 3, durationMax: 15, hasResolution: true, imageRefField: "image_urls", imageRefKind: "array", videoRefField: "video_urls", videoRefKind: "array"},
		"kling-3.0-omni/transformation":       {aspectField: "aspect_ratio", durationKind: "number", durationMin: 3, durationMax: 15, hasResolution: true, imageRefField: "image_urls", imageRefKind: "array", videoRefField: "video_urls", videoRefKind: "array"},
		"kling/v3-turbo-text-to-video":        {aspectField: "aspect_ratio", durationKind: "string", hasResolution: true},
		"kling/v3-turbo-image-to-video":       {durationKind: "string", hasResolution: true, imageRefField: "image_urls", imageRefKind: "array"},
		"kling/ai-avatar-standard":            {imageRefField: "image_url", imageRefKind: "single", audioRefField: "audio_url", audioRefKind: "single"},
		"kling/ai-avatar-pro":                 {imageRefField: "image_url", imageRefKind: "single", audioRefField: "audio_url", audioRefKind: "single"},
		"kling/v2-1-master-image-to-video":    {durationKind: "string", imageRefField: "image_url", imageRefKind: "single"},
		"kling/v2-1-master-text-to-video":     {aspectField: "aspect_ratio", durationKind: "string"},
		"kling/v2-1-pro":                      {durationKind: "string", imageRefField: "image_url", imageRefKind: "single"},
		"kling/v2-1-standard":                 {durationKind: "string", imageRefField: "image_url", imageRefKind: "single"},
		"kling/v2-5-turbo-image-to-video-pro": {durationKind: "string", imageRefField: "image_url", imageRefKind: "single"},
		"kling/v2-5-turbo-text-to-video-pro":  {aspectField: "aspect_ratio", durationKind: "string"},

		"wan/2-2-a14b-image-to-video-turbo":  {hasResolution: true, imageRefField: "image_url", imageRefKind: "single"},
		"wan/2-2-a14b-speech-to-video-turbo": {hasResolution: true, imageRefField: "image_url", imageRefKind: "single", audioRefField: "audio_url", audioRefKind: "single"},
		"wan/2-2-a14b-text-to-video-turbo":   {aspectField: "aspect_ratio", hasResolution: true},
		"wan/2-2-animate-move":               {hasResolution: true, imageRefField: "image_url", imageRefKind: "single", videoRefField: "video_url", videoRefKind: "single"},
		"wan/2-2-animate-replace":            {hasResolution: true, imageRefField: "image_url", imageRefKind: "single", videoRefField: "video_url", videoRefKind: "single"},
		"wan/2-5-image-to-video":             {durationKind: "string", hasResolution: true, imageRefField: "image_url", imageRefKind: "single"},
		"wan/2-5-text-to-video":              {aspectField: "aspect_ratio", durationKind: "string", hasResolution: true},
		"wan/2-6-flash-image-to-video":       {durationKind: "string", hasResolution: true, imageRefField: "image_urls", imageRefKind: "array"},
		"wan/2-6-flash-video-to-video":       {durationKind: "string", hasResolution: true, videoRefField: "video_urls", videoRefKind: "array"},
		"wan/2-6-image-to-video":             {durationKind: "string", hasResolution: true, imageRefField: "image_urls", imageRefKind: "array"},
		"wan/2-6-text-to-video":              {durationKind: "string", hasResolution: true},
		"wan/2-6-video-to-video":             {durationKind: "string", hasResolution: true, videoRefField: "video_urls", videoRefKind: "array"},
		"wan/2-7-image-to-video":             {durationKind: "number", hasResolution: true, imageRefField: "first_frame_url", imageRefKind: "single", videoRefField: "first_clip_url", videoRefKind: "single", audioRefField: "driving_audio_url", audioRefKind: "single"},
		"wan/2-7-r2v":                        {aspectField: "aspect_ratio", durationKind: "number", hasResolution: true, imageRefField: "reference_image", imageRefKind: "array", videoRefField: "reference_video", videoRefKind: "array", audioRefField: "reference_voice", audioRefKind: "single"},
		"wan/2-7-text-to-video":              {aspectField: "ratio", durationKind: "number", hasResolution: true, audioRefField: "audio_url", audioRefKind: "single"},
		"wan/2-7-videoedit":                  {aspectField: "aspect_ratio", durationKind: "number", hasResolution: true, imageRefField: "reference_image", imageRefKind: "single", videoRefField: "video_url", videoRefKind: "single"},

		"bytedance/seedream":                  {aspectField: "image_size", aspectKind: "image_size_named"},
		"bytedance/seedream-v4-edit":          {aspectField: "image_size", aspectKind: "image_size_named", resolutionField: "image_resolution", resolutionKind: "image", countField: "max_images", imageRefField: "image_urls", imageRefKind: "array"},
		"bytedance/seedream-v4-text-to-image": {aspectField: "image_size", aspectKind: "image_size_named", resolutionField: "image_resolution", resolutionKind: "image", countField: "max_images"},
		"flux-2/flex-image-to-image":          {aspectField: "aspect_ratio", hasResolution: true, resolutionKind: "image", maxResolution: "2K", imageRefField: "input_urls", imageRefKind: "array"},
		"flux-2/flex-text-to-image":           {aspectField: "aspect_ratio", hasResolution: true, resolutionKind: "image", maxResolution: "2K"},
		"flux-2/pro-image-to-image":           {aspectField: "aspect_ratio", hasResolution: true, resolutionKind: "image", maxResolution: "2K", imageRefField: "input_urls", imageRefKind: "array"},
		"flux-2/pro-text-to-image":            {aspectField: "aspect_ratio", hasResolution: true, resolutionKind: "image", maxResolution: "2K"},
		"gpt-image-2-image-to-image":          {aspectField: "aspect_ratio", hasResolution: true, resolutionKind: "image", imageRefField: "input_urls", imageRefKind: "array"},
		"gpt-image-2-text-to-image":           {aspectField: "aspect_ratio", hasResolution: true, resolutionKind: "image"},
		"nano-banana-2":                       {aspectField: "aspect_ratio", hasResolution: true, resolutionKind: "image", hasOutputFormat: true, imageRefField: "image_input", imageRefKind: "array"},
		"nano-banana-2-lite":                  {aspectField: "aspect_ratio", imageRefField: "image_urls", imageRefKind: "array"},
		"nano-banana-pro":                     {aspectField: "aspect_ratio", hasResolution: true, resolutionKind: "image", hasOutputFormat: true, imageRefField: "image_input", imageRefKind: "array"},
		"wan/2-7-image":                       {aspectField: "aspect_ratio", hasResolution: true, resolutionKind: "image", countField: "n", imageRefField: "input_urls", imageRefKind: "array"},
		"wan/2-7-image-pro":                   {aspectField: "aspect_ratio", hasResolution: true, resolutionKind: "image", countField: "n", imageRefField: "input_urls", imageRefKind: "array"},

		"google/imagen4":                 {aspectField: "aspect_ratio"},
		"google/imagen4-fast":            {aspectField: "aspect_ratio"},
		"google/imagen4-ultra":           {aspectField: "aspect_ratio"},
		"google/nano-banana":             {aspectField: "aspect_ratio", hasOutputFormat: true},
		"google/nano-banana-edit":        {aspectField: "aspect_ratio", hasOutputFormat: true, imageRefField: "image_urls", imageRefKind: "array"},
		"gpt-image/1.5-image-to-image":   {aspectField: "aspect_ratio", hasQuality: true, imageRefField: "input_urls", imageRefKind: "array"},
		"gpt-image/1.5-text-to-image":    {aspectField: "aspect_ratio", hasQuality: true},
		"grok-imagine-image-2-0/text-to-image": {aspectField: "aspect_ratio"},
		"grok-imagine/text-to-image":     {aspectField: "aspect_ratio"},
		"grok-imagine/image-to-image":    {imageRefField: "image_urls", imageRefKind: "array"},
		"grok-imagine/extend":            {imageRefField: "image_url", imageRefKind: "single"},
		"ideogram/character":             {aspectField: "image_size", aspectKind: "image_size_named", countField: "num_images", countKind: "string", imageRefField: "reference_image_urls", imageRefKind: "array"},
		"ideogram/character-edit":        {countField: "num_images", countKind: "string", imageRefField: "image_url", imageRefKind: "single"},
		"ideogram/character-remix":       {aspectField: "image_size", aspectKind: "image_size_named", countField: "num_images", countKind: "string", imageRefField: "reference_image_urls", imageRefKind: "array"},
		"ideogram/v3-edit":               {imageRefField: "image_url", imageRefKind: "single"},
		"ideogram/v3-remix":              {aspectField: "image_size", aspectKind: "image_size_named", countField: "num_images", countKind: "string", imageRefField: "image_url", imageRefKind: "single"},
		"ideogram/v3-text-to-image":      {aspectField: "image_size", aspectKind: "image_size_named"},
		"qwen/text-to-image":             {aspectField: "image_size", aspectKind: "image_size_named", hasOutputFormat: true},
		"qwen/image-edit":                {aspectField: "image_size", aspectKind: "image_size_named", countField: "num_images", countKind: "string", hasOutputFormat: true, imageRefField: "image_url", imageRefKind: "single"},
		"qwen/image-to-image":            {hasOutputFormat: true, imageRefField: "image_url", imageRefKind: "single"},
		"qwen2/image-edit":               {aspectField: "image_size", hasOutputFormat: true, imageRefField: "image_url", imageRefKind: "single"},
		"qwen2/text-to-image":            {aspectField: "image_size", hasOutputFormat: true},
		"recraft/crisp-upscale":          {imageRefField: "image", imageRefKind: "single"},
		"recraft/remove-background":      {imageRefField: "image", imageRefKind: "single"},
		"seedream/4.5-edit":              {aspectField: "aspect_ratio", hasQuality: true, imageRefField: "image_urls", imageRefKind: "array"},
		"seedream/4.5-text-to-image":     {aspectField: "aspect_ratio", hasQuality: true},
		"seedream/5-lite-image-to-image": {aspectField: "aspect_ratio", hasQuality: true, imageRefField: "image_urls", imageRefKind: "array"},
		"seedream/5-lite-text-to-image":  {aspectField: "aspect_ratio", hasQuality: true},
		"seedream/5-pro-text-to-image":        {aspectField: "aspect_ratio", hasQuality: true},
		"seedream/5-pro-image-to-image":       {aspectField: "aspect_ratio", hasQuality: true, imageRefField: "image_urls", imageRefKind: "array"},
		"seedream/5-pro-layer-decomposition": {imageRefField: "image_url", imageRefKind: "single"},
		"topaz/image-upscale":                 {imageRefField: "image_url", imageRefKind: "single"},
		"topaz/video-upscale":            {videoRefField: "video_url", videoRefKind: "single"},
		"infinitalk/from-audio":          {hasResolution: true, imageRefField: "image_url", imageRefKind: "single", audioRefField: "audio_url", audioRefKind: "single"},
		"z-image":                        {aspectField: "aspect_ratio"},
	}

	if config, ok := configs[modelName]; ok {
		return config
	}
	return kieInputConfig{}
}

func normalizeKIEDurationInput(value any, config kieInputConfig) any {
	normalized := normalizeKIEDurationValue(value, config.durationKind)
	if config.durationMin <= 0 && config.durationMax <= 0 {
		return normalized
	}
	duration, ok := readKIEDurationInt(normalized)
	if !ok {
		return normalized
	}
	if config.durationMin > 0 && duration < config.durationMin {
		duration = config.durationMin
	}
	if config.durationMax > 0 && duration > config.durationMax {
		duration = config.durationMax
	}
	if config.durationKind == "number" {
		return duration
	}
	return strconv.Itoa(duration)
}

func readKIEDurationInt(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case float64:
		return int(typed), true
	case string:
		parsed, err := strconv.Atoi(normalizeKIEDurationString(typed))
		return parsed, err == nil
	default:
		parsed, err := strconv.Atoi(normalizeKIEDurationString(toStringSafe(value)))
		return parsed, err == nil
	}
}

func normalizeKIEDurationValue(value any, durationKind string) any {
	switch typed := value.(type) {
	case string:
		normalized := normalizeKIEDurationString(typed)
		if durationKind == "number" {
			return parseKIEDurationNumber(normalized)
		}
		return normalized
	case float64:
		if durationKind == "string" {
			return strings.TrimSuffix(strings.TrimSuffix(toStringSafe(typed), ".0"), ".")
		}
		return value
	case float32:
		if durationKind == "string" {
			return strings.TrimSuffix(strings.TrimSuffix(toStringSafe(typed), ".0"), ".")
		}
		return value
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		if durationKind == "string" {
			return toStringSafe(value)
		}
		return value
	default:
		return value
	}
}

func parseKIEDurationNumber(value string) any {
	if value == "" {
		return value
	}
	if strings.Contains(value, ".") {
		if parsed, err := strconv.ParseFloat(value, 64); err == nil {
			return parsed
		}
		return value
	}
	if parsed, err := strconv.Atoi(value); err == nil {
		return parsed
	}
	return value
}

func normalizeKIEDurationString(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	value = strings.TrimSuffix(value, "s")
	value = strings.TrimSuffix(value, "\u79d2")
	return strings.TrimSpace(value)
}

func readKIECallbackURL(payload map[string]any) string {
	for _, key := range []string{"callBackUrl", "callbackUrl", "callback_url"} {
		if value, ok := payload[key]; ok {
			if text := strings.TrimSpace(toStringSafe(value)); text != "" {
				return text
			}
		}
	}
	return ""
}

func resolveKIEModelName(modelName string, payload map[string]any) string {
	trimmed := strings.TrimSpace(modelName)
	lowered := strings.ToLower(trimmed)

	if alias, ok := kieModelAliases()[lowered]; ok {
		return alias
	}

	if strings.Contains(trimmed, "/") {
		return trimmed
	}

	switch lowered {
	case "grok-imagine", "grok-imagine-video":
		if hasKIEImageInput(payload) {
			return "grok-imagine/image-to-video"
		}
		return "grok-imagine/text-to-video"
	case "grok-imagine-1.5-video", "grok-imagine-1.5-preview", "grok-imagine-video-1-5-preview":
		return "grok-imagine-video-1-5-preview"
	}

	return trimmed
}

func kieModelAliases() map[string]string {
	return map[string]string{
		"seedream/seedream":                     "bytedance/seedream",
		"seedream/seedream-v4-text-to-image":    "bytedance/seedream-v4-text-to-image",
		"seedream/seedream-v4-edit":             "bytedance/seedream-v4-edit",
		"seedream/4-5-text-to-image":            "seedream/4.5-text-to-image",
		"seedream/4-5-edit":                     "seedream/4.5-edit",
		"z-image/z-image":                       "z-image",
		"google/nanobanana2":                    "nano-banana-2",
		"google/nano-banana-2-lite":             "nano-banana-2-lite",
		"google/pro-image-to-image":             "nano-banana-pro",
		"flux2/pro-image-to-image":              "flux-2/pro-image-to-image",
		"flux2/pro-text-to-image":               "flux-2/pro-text-to-image",
		"flux2/flex-image-to-image":             "flux-2/flex-image-to-image",
		"flux2/flex-text-to-image":              "flux-2/flex-text-to-image",
		"gpt-image/1-5-text-to-image":           "gpt-image/1.5-text-to-image",
		"gpt-image/1-5-image-to-image":          "gpt-image/1.5-image-to-image",
		"gpt/gpt-image-2-text-to-image":         "gpt-image-2-text-to-image",
		"gpt/gpt-image-2-image-to-image":        "gpt-image-2-image-to-image",
		"bytedance/seedance-1-5-pro":            "bytedance/seedance-1.5-pro",
		"kling/text-to-video":                   "kling-2.6/text-to-video",
		"kling/image-to-video":                  "kling-2.6/image-to-video",
		"kling/motion-control":                  "kling-2.6/motion-control",
		"kling/motion-control-v3":               "kling-3.0/motion-control",
		"kling/kling-3-0":                       "kling-3.0/video",
		"kling/v25-turbo-image-to-video-pro":    "kling/v2-5-turbo-image-to-video-pro",
		"kling/v25-turbo-text-to-video-pro":     "kling/v2-5-turbo-text-to-video-pro",
		"grok-imagine/1-5-preview":              "grok-imagine-video-1-5-preview",
		"grok-imagine/grok-imagine-1.5-preview": "grok-imagine-video-1-5-preview",
	}
}

func hasKIEImageInput(payload map[string]any) bool {
	checkKeys := []string{
		"image_url",
		"image_urls",
		"first_frame_url",
		"last_frame_url",
		"first_frame_image",
		"last_frame_image",
		"image",
		"images",
	}

	for _, key := range checkKeys {
		if value, ok := payload[key]; ok && !isEmptyValue(value) {
			return true
		}
	}

	if input, ok := payload["input"].(map[string]any); ok {
		for _, key := range checkKeys {
			if value, ok := input[key]; ok && !isEmptyValue(value) {
				return true
			}
		}
	}

	return false
}

func isEmptyValue(value any) bool {
	if value == nil {
		return true
	}

	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v) == ""
	case []any:
		return len(v) == 0
	case []string:
		return len(v) == 0
	default:
		return false
	}
}

func boolLike(value any) bool {
	switch v := value.(type) {
	case bool:
		return v
	case string:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "1", "true", "yes", "on":
			return true
		default:
			return false
		}
	case float64:
		return v != 0
	case int:
		return v != 0
	default:
		return false
	}
}

func copyKIEVideoResponse(w http.ResponseWriter, response *http.Response, request *http.Request, channel model.ModelChannel, logContext aiLogContext, onFailure func()) bool {
	if !isKIEChannel(channel, logContext.Model) {
		return false
	}

	if isKIECreateTaskPath(request.URL.Path) {
		payload, _ := io.ReadAll(response.Body)
		responseBody := string(payload)

		if isKIEImageEndpoint(logContext.Endpoint) {
			if handled := copyKIECreateImageResponse(w, request, payload, response.StatusCode, channel, logContext, onFailure); handled {
				return true
			}
		}

		if transformed, ok := transformKIECreateVideoResponse(payload, logContext.Model); ok {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(response.StatusCode)
			_, _ = w.Write(transformed)
			saveAIProxyLog(logContext, response.StatusCode, string(transformed), "")
			return true
		}

		if errorMessage := readKIECreateTaskErrorMessage(payload); errorMessage != "" {
			if onFailure != nil {
				onFailure()
			}
			w.WriteHeader(response.StatusCode)
			_, _ = w.Write(payload)
			saveAIProxyLog(logContext, response.StatusCode, responseBody, errorMessage)
			return true
		}

		w.WriteHeader(response.StatusCode)
		_, _ = w.Write(payload)
		saveAIProxyLog(logContext, response.StatusCode, responseBody, "")
		return true
	}

	if strings.Contains(request.URL.Path, "/jobs/recordInfo") {
		payload, _ := io.ReadAll(response.Body)
		responseBody := string(payload)

		if transformed, ok := transformKIETaskResponse(payload, logContext.Model); ok {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(response.StatusCode)
			_, _ = w.Write(transformed)
			if errorMessage := readKIERecordInfoErrorMessage(payload); errorMessage != "" {
				saveAIProxyLog(logContext, response.StatusCode, responseBody, errorMessage)
			} else {
				saveAIProxyLog(logContext, response.StatusCode, string(transformed), "")
			}
			return true
		}

		w.WriteHeader(response.StatusCode)
		_, _ = w.Write(payload)
		saveAIProxyLog(logContext, response.StatusCode, responseBody, "")
		return true
	}

	return false
}

func isKIECreateTaskPath(path string) bool {
	return strings.HasSuffix(path, "/jobs/createTask") || strings.HasSuffix(path, "/client/tasks")
}

func readKIECreateTaskErrorMessage(payload []byte) string {
	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}

	if len(payload) == 0 || json.Unmarshal(payload, &result) != nil {
		return ""
	}
	if result.Code == 0 || result.Code == 200 {
		return ""
	}
	return strings.TrimSpace(result.Msg)
}

func readKIERecordInfoErrorMessage(payload []byte) string {
	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			State    string `json:"state"`
			FailCode string `json:"failCode"`
			FailMsg  string `json:"failMsg"`
		} `json:"data"`
	}

	if len(payload) == 0 || json.Unmarshal(payload, &result) != nil {
		return ""
	}
	if result.Code != 0 && result.Code != 200 {
		return strings.TrimSpace(result.Msg)
	}
	state := strings.ToLower(strings.TrimSpace(result.Data.State))
	if state == "fail" || state == "failed" || state == "cancelled" {
		return firstNonEmpty(result.Data.FailMsg, result.Data.FailCode, result.Msg, "KIE task failed")
	}
	return firstNonEmpty(result.Data.FailMsg, result.Data.FailCode)
}

func transformKIECreateVideoResponse(payload []byte, modelName string) ([]byte, bool) {
	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			TaskID string `json:"taskId"`
		} `json:"data"`
	}

	if err := json.Unmarshal(payload, &result); err != nil {
		return nil, false
	}

	if result.Code != 200 || strings.TrimSpace(result.Data.TaskID) == "" {
		return nil, false
	}

	converted := map[string]any{
		"id":     result.Data.TaskID,
		"object": "video",
		"status": "processing",
		"model":  modelName,
	}

	encoded, err := json.Marshal(converted)
	if err != nil {
		return nil, false
	}

	return encoded, true
}

func transformKIETaskResponse(payload []byte, modelName string) ([]byte, bool) {
	var result struct {
		Code    int    `json:"code"`
		Msg     string `json:"msg"`
		Success bool   `json:"success"`
		Data    struct {
			TaskID       string `json:"taskId"`
			Model        string `json:"model"`
			State        string `json:"state"`
			ResultJSON   any    `json:"resultJson"`
			FailCode     string `json:"failCode"`
			FailMsg      string `json:"failMsg"`
			Progress     int    `json:"progress"`
			CompleteTime int64  `json:"completeTime"`
			CreateTime   int64  `json:"createTime"`
			UpdateTime   int64  `json:"updateTime"`
			CostTime     int64  `json:"costTime"`
		} `json:"data"`
	}

	if err := json.Unmarshal(payload, &result); err != nil {
		return nil, false
	}

	if strings.TrimSpace(result.Data.TaskID) == "" {
		return nil, false
	}

	status := "processing"
	switch strings.ToLower(strings.TrimSpace(result.Data.State)) {
	case "waiting", "queuing", "generating":
		status = "processing"
	case "success", "succeeded", "completed":
		status = "completed"
	case "fail", "failed", "cancelled":
		status = "failed"
	}

	converted := map[string]any{
		"id":       result.Data.TaskID,
		"object":   "video",
		"status":   status,
		"progress": result.Data.Progress,
		"model":    modelName,
	}

	videoURL := extractKIEVideoURL(result.Data.ResultJSON)
	if videoURL != "" {
		converted["video"] = map[string]any{
			"url": videoURL,
		}
		converted["url"] = videoURL
		converted["data"] = []map[string]any{
			{
				"url": videoURL,
			},
		}
	}

	if strings.TrimSpace(result.Data.FailMsg) != "" {
		converted["error"] = result.Data.FailMsg
	}
	if strings.TrimSpace(result.Data.FailCode) != "" {
		converted["error_code"] = result.Data.FailCode
	}

	encoded, err := json.Marshal(converted)
	if err != nil {
		return nil, false
	}

	return encoded, true
}

func extractKIEVideoURL(result any) string {
	parsed := decodeKIEResultJSON(result)
	if parsed == nil {
		return ""
	}

	if urls := readStringSlice(parsed["resultUrls"]); len(urls) > 0 {
		return strings.TrimSpace(urls[0])
	}
	if urls := readStringSlice(parsed["result_urls"]); len(urls) > 0 {
		return strings.TrimSpace(urls[0])
	}
	if urls := readStringSlice(parsed["urls"]); len(urls) > 0 {
		return strings.TrimSpace(urls[0])
	}
	if urls := readStringSlice(parsed["videoUrls"]); len(urls) > 0 {
		return strings.TrimSpace(urls[0])
	}
	if urls := readStringSlice(parsed["video_urls"]); len(urls) > 0 {
		return strings.TrimSpace(urls[0])
	}

	if url := strings.TrimSpace(toStringSafe(parsed["url"])); url != "" {
		return url
	}
	if url := strings.TrimSpace(toStringSafe(parsed["videoUrl"])); url != "" {
		return url
	}
	if url := strings.TrimSpace(toStringSafe(parsed["video_url"])); url != "" {
		return url
	}
	if url := strings.TrimSpace(toStringSafe(parsed["downloadUrl"])); url != "" {
		return url
	}
	if url := strings.TrimSpace(toStringSafe(parsed["download_url"])); url != "" {
		return url
	}

	if videos, ok := parsed["videos"].([]any); ok {
		for _, item := range videos {
			if m, ok := item.(map[string]any); ok {
				if url := strings.TrimSpace(toStringSafe(m["url"])); url != "" {
					return url
				}
				if urls := readStringSlice(m["urls"]); len(urls) > 0 {
					return strings.TrimSpace(urls[0])
				}
			}
		}
	}

	return ""
}

func decodeKIEResultJSON(value any) map[string]any {
	switch v := value.(type) {
	case string:
		if strings.TrimSpace(v) == "" {
			return nil
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(v), &parsed); err == nil {
			return parsed
		}
	case map[string]any:
		return v
	}
	return nil
}

func readStringSlice(value any) []string {
	switch v := value.(type) {
	case []string:
		return v
	case []any:
		result := make([]string, 0, len(v))
		for _, item := range v {
			s := strings.TrimSpace(toStringSafe(item))
			if s != "" {
				result = append(result, s)
			}
		}
		return result
	default:
		return nil
	}
}

func toStringSafe(value any) string {
	if value == nil {
		return ""
	}

	switch v := value.(type) {
	case string:
		return v
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		s := strings.TrimSpace(string(b))
		s = strings.TrimPrefix(s, "\"")
		s = strings.TrimSuffix(s, "\"")
		return s
	}
}
