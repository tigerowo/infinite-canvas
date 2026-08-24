package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

const apimartImageUploadPath = "/uploads/images"

type apimartInputConfig struct {
	aspectField         string
	durationField       string
	hasResolution       bool
	resolutionCase      string
	maxResolution       string
	minResolution       string
	hasCount            bool
	hasQuality          bool
	maxImageRefs        int
	hasOutput           bool
	modeFromRes         bool
	dropAspectWithImage bool
	imageRefField       string
	imageRefKind        string
	videoRefField       string
	videoRefKind        string
	audioRefField       string
	audioRefKind        string
}

func isAPIMartChannel(channel model.ModelChannel, _ string) bool {
	return strings.EqualFold(strings.TrimSpace(channel.Protocol), "apimart")
}

func normalizeAPIMartVideoBody(body []byte, contentType string, modelName string, channel model.ModelChannel) ([]byte, string, error) {
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
	normalizeAPIMartVideoParams(payload, finalModel, channel)
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

func readAPIMartPayload(body []byte, contentType string, channel model.ModelChannel) (map[string]any, error) {
	payload := map[string]any{}
	if !strings.HasPrefix(strings.ToLower(contentType), "multipart/form-data") {
		_ = json.Unmarshal(body, &payload)
		return payload, nil
	}

	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return nil, err
	}
	form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
	if err != nil {
		return nil, err
	}
	defer form.RemoveAll()

	for key, values := range form.Value {
		if len(values) == 0 {
			continue
		}
		if len(values) == 1 {
			payload[key] = parseAPIMartFormValue(values[0])
			continue
		}
		items := make([]any, 0, len(values))
		for _, value := range values {
			items = append(items, parseAPIMartFormValue(value))
		}
		payload[key] = items
	}
	if err := mergeAPIMartFormFiles(payload, form.File, channel); err != nil {
		return nil, err
	}
	return payload, nil
}

func parseAPIMartFormValue(value string) any {
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

func mergeAPIMartFormFiles(payload map[string]any, files map[string][]*multipart.FileHeader, channel model.ModelChannel) error {
	for key, headers := range files {
		if len(headers) == 0 {
			continue
		}
		values := make([]any, 0, len(headers))
		for _, header := range headers {
			data, contentType, err := readAPIMartFormFileBytes(header)
			if err != nil {
				return err
			}
			if len(data) == 0 {
				return fmt.Errorf("APIMart file upload failed: empty file %s", header.Filename)
			}
			if strings.HasPrefix(strings.ToLower(contentType), "video/") || strings.HasPrefix(strings.ToLower(contentType), "audio/") {
				return errors.New("APIMart local video/audio reference upload is not supported; use a public media URL")
			}
			uploaded, err := uploadAPIMartImageBytes(channel, data, normalizeAPIMartReferenceFilename(header.Filename, contentType), contentType)
			if err != nil {
				return err
			}
			values = append(values, uploaded)
		}
		if len(values) == 1 {
			payload[key] = values[0]
		} else {
			payload[key] = values
		}
	}
	return nil
}

func normalizeAPIMartVideoParams(payload map[string]any, modelName string, channel model.ModelChannel) {
	config := apimartVideoConfig(modelName)
	config.durationField = firstNonEmpty(config.durationField, "duration")
	if isAPIMartKlingV26MotionControlModel(modelName) {
		config.durationField = ""
	}

	normalizeAPIMartAspect(payload, config)
	normalizeAPIMartDuration(payload, config)
	normalizeAPIMartVideoMode(payload, config)
	normalizeAPIMartKlingV3Advanced(payload, modelName, channel)
	normalizeAPIMartResolution(payload, config)
	normalizeAPIMartVideoQuality(payload, config)
	normalizeAPIMartReferenceInputs(payload, modelName, config, channel)
	applyAPIMartVideoGenerateAudioInput(payload, modelName)
	applyAPIMartVideoDefaults(payload, modelName)
	clearAPIMartConflictingReferences(payload, modelName)
	if err := validateAPIMartVideoRequiredInputs(payload, modelName); err != nil {
		payload["_apimart_reference_error"] = err.Error()
		return
	}
	clearAPIMartAspectForImageMode(payload, config)
	delete(payload, "preset")
}

func apimartVideoConfig(modelName string) apimartInputConfig {
	model := normalizeAPIMartModelName(modelName)
	config := apimartInputConfig{
		aspectField:    "aspect_ratio",
		durationField:  "duration",
		hasResolution:  true,
		resolutionCase: "video",
		imageRefField:  "image_urls",
		imageRefKind:   "array",
	}

	switch {
	case strings.Contains(model, "doubao-seedance-2"):
		config.aspectField = "size"
		config.imageRefKind = "seedance2"
		config.videoRefField = "video_urls"
		config.videoRefKind = "array"
		config.audioRefField = "audio_urls"
		config.audioRefKind = "array"
	case strings.Contains(model, "doubao-seedance-1-0"):
		config.aspectField = "aspect_ratio"
		config.imageRefField = "image_with_roles"
		config.imageRefKind = "roles"
	case strings.Contains(model, "doubao-seedance-1-5"), strings.Contains(model, "seedance-1"):
		config.aspectField = "aspect_ratio"
		config.imageRefField = "image_with_roles"
		config.imageRefKind = "roles"
	case strings.Contains(model, "sora-2-pro"):
		config.aspectField = "aspect_ratio"
		config.dropAspectWithImage = true
		config.maxImageRefs = 1
	case strings.Contains(model, "sora-2"):
		config.aspectField = "aspect_ratio"
		config.maxResolution = "720p"
		config.dropAspectWithImage = true
		config.maxImageRefs = 1
	case strings.Contains(model, "veo") && strings.Contains(model, "official"):
		config.aspectField = "aspect_ratio"
		config.imageRefField = "first_frame_image"
		config.imageRefKind = "first_last"
	case strings.Contains(model, "veo"):
		config.aspectField = "aspect_ratio"
	case model == "minimax-h3":
		config.aspectField = "aspect_ratio"
		config.imageRefField = "image_urls"
		config.imageRefKind = "minimax_h3"
		config.videoRefField = "video_urls"
		config.videoRefKind = "array"
		config.audioRefField = "audio_urls"
		config.audioRefKind = "array"
	case strings.Contains(model, "minimax-hailuo-2-3"):
		config.aspectField = ""
		config.imageRefField = "first_frame_image"
		config.imageRefKind = "first_only"
	case strings.Contains(model, "minimax"), strings.Contains(model, "hailuo"):
		config.aspectField = ""
		config.imageRefField = "first_frame_image"
		config.imageRefKind = "first_last"
	case strings.Contains(model, "skyreels"):
		config.aspectField = "aspect_ratio"
		config.imageRefField = "first_frame_image"
		config.imageRefKind = "skyreels"
		config.videoRefField = "ref_videos"
		config.videoRefKind = "skyreels"
		config.audioRefKind = "skyreels_ref_images"
	case model == "kling-3-0-turbo":
		config.aspectField = "aspect_ratio"
		config.imageRefField = "first_frame_image"
		config.imageRefKind = "first_only"
		config.dropAspectWithImage = true
	case model == "happyhorse-1-1":
		config.aspectField = "size"
		config.resolutionCase = "upper_video"
		config.imageRefKind = "happyhorse11"
	case strings.Contains(model, "happyhorse"):
		config.aspectField = "size"
		config.resolutionCase = "upper_video"
		config.imageRefKind = "happyhorse"
		config.videoRefField = "video_url"
		config.videoRefKind = "single"
	case strings.Contains(model, "gemini-omni-flash-preview"):
		config.maxResolution = "720p"
		config.videoRefField = "video_urls"
		config.videoRefKind = "array"
	case strings.Contains(model, "wan2-7-r2v"), strings.Contains(model, "wan2.7-r2v"):
		config.aspectField = "size"
		config.resolutionCase = "upper_video"
		config.imageRefField = "image_with_roles"
		config.imageRefKind = "roles"
		config.videoRefField = "video_urls"
		config.videoRefKind = "array"
		config.audioRefKind = "wan_r2v_voice"
	case strings.Contains(model, "wan2-7-videoedit"), strings.Contains(model, "wan2.7-videoedit"):
		config.aspectField = "size"
		config.resolutionCase = "upper_video"
		config.videoRefField = "video_urls"
		config.videoRefKind = "array"
	case strings.Contains(model, "wan2-7"), strings.Contains(model, "wan2.7"):
		config.aspectField = "size"
		config.resolutionCase = "upper_video"
		config.imageRefField = "image_with_roles"
		config.imageRefKind = "roles"
		config.videoRefField = "video_urls"
		config.videoRefKind = "array"
		config.audioRefField = "audio_url"
		config.audioRefKind = "single"
	case strings.Contains(model, "wan2-6-i2v-flash"), strings.Contains(model, "wan2.6-i2v-flash"):
		config.aspectField = ""
		config.audioRefField = "audio_url"
		config.audioRefKind = "single"
	case strings.Contains(model, "wan2-5"), strings.Contains(model, "wan2.5"):
		config.aspectField = "size"
		config.dropAspectWithImage = true
		config.audioRefField = "audio_url"
		config.audioRefKind = "single"
	case strings.Contains(model, "wan2-6"), strings.Contains(model, "wan2.6"):
		config.aspectField = "aspect_ratio"
		config.dropAspectWithImage = true
		config.audioRefField = "audio_url"
		config.audioRefKind = "single"
	case strings.Contains(model, "kling-v2-6-motion"), strings.Contains(model, "motion-control"):
		config.aspectField = ""
		config.hasResolution = false
		config.imageRefField = "image_url"
		config.imageRefKind = "single"
		config.videoRefField = "video_url"
		config.videoRefKind = "single"
	case strings.Contains(model, "kling-v2-6"), strings.Contains(model, "kling-2-6"):
		config.aspectField = "aspect_ratio"
		config.hasResolution = false
		config.imageRefKind = "array_frames"
	case model == "kling-v3":
		config.aspectField = "aspect_ratio"
		config.hasResolution = false
		config.imageRefKind = "array_frames"
	case strings.Contains(model, "kling-v3-omni"), strings.Contains(model, "kling-video-o1"):
		config.aspectField = "aspect_ratio"
		config.hasResolution = false
		config.modeFromRes = true
		config.videoRefField = "video_list"
		config.videoRefKind = "kling_video_list"
	case strings.Contains(model, "kling"):
		config.aspectField = "aspect_ratio"
		config.hasResolution = false
		config.modeFromRes = true
	case strings.Contains(model, "vidu"):
		config.aspectField = "aspect_ratio"
		config.dropAspectWithImage = model != "viduq3" && model != "viduq3-mix"
		config.imageRefKind = "array_frames"
	case strings.Contains(model, "grok-imagine"):
		config.aspectField = "size"
		config.hasResolution = false
		config.hasQuality = true
	case strings.Contains(model, "pixverse"):
		config.aspectField = "size"
		config.imageRefKind = "pixverse"
	case strings.Contains(model, "omni-flash"):
		config.aspectField = "aspect_ratio"
		config.videoRefField = "video_urls"
		config.videoRefKind = "array"
	case strings.Contains(model, "flux-3-video"):
		config.aspectField = "aspect_ratio"
		config.hasResolution = true
		config.resolutionCase = "video"
		config.maxImageRefs = 10
		config.imageRefField = "image_urls"
		config.imageRefKind = "array"
		config.videoRefField = "video_url"
		config.videoRefKind = "single"
	}
	return config
}

func normalizeAPIMartAspect(payload map[string]any, config apimartInputConfig) {
	if config.aspectField == "" {
		delete(payload, "size")
		delete(payload, "ratio")
		delete(payload, "aspect_ratio")
		return
	}

	value := firstNonEmpty(
		toStringSafe(payload[config.aspectField]),
		toStringSafe(payload["size"]),
		toStringSafe(payload["aspect_ratio"]),
		toStringSafe(payload["ratio"]),
		toStringSafe(payload["image_size"]),
	)
	if strings.TrimSpace(value) != "" {
		payload[config.aspectField] = normalizeAPIMartRatio(value)
	}
	if config.aspectField != "size" {
		delete(payload, "size")
	}
	if config.aspectField != "aspect_ratio" {
		delete(payload, "aspect_ratio")
	}
	delete(payload, "ratio")
	delete(payload, "image_size")
}

func normalizeAPIMartDuration(payload map[string]any, config apimartInputConfig) {
	if config.durationField == "" {
		delete(payload, "duration")
		delete(payload, "seconds")
		return
	}
	value, ok := payload[config.durationField]
	if !ok || isEmptyValue(value) {
		value = payload["duration"]
	}
	if isEmptyValue(value) {
		value = payload["seconds"]
	}
	if !isEmptyValue(value) {
		payload[config.durationField] = normalizeAPIMartInt(value)
	}
	if config.durationField != "duration" {
		delete(payload, "duration")
	}
	delete(payload, "seconds")
}

func normalizeAPIMartResolution(payload map[string]any, config apimartInputConfig) {
	if !config.hasResolution {
		if !config.hasQuality {
			delete(payload, "resolution")
			delete(payload, "resolution_name")
		}
		delete(payload, "image_resolution")
		return
	}
	value := firstNonEmpty(toStringSafe(payload["resolution"]), toStringSafe(payload["resolution_name"]), toStringSafe(payload["image_resolution"]))
	if config.resolutionCase != "video" && config.resolutionCase != "upper_video" {
		value = firstNonEmpty(value, apimartSizeResolution(toStringSafe(payload["size"])), apimartQualityResolution(toStringSafe(payload["quality"])))
	}
	if strings.TrimSpace(value) != "" {
		if config.resolutionCase == "video" {
			payload["resolution"] = normalizeAPIMartVideoResolution(value, config)
		} else if config.resolutionCase == "upper_video" {
			payload["resolution"] = strings.ToUpper(normalizeAPIMartVideoResolution(value, config))
		} else {
			payload["resolution"] = normalizeAPIMartImageResolution(clampAPIMartImageResolution(value, config), config.resolutionCase)
		}
	}
	delete(payload, "image_resolution")
	delete(payload, "resolution_name")
}

func normalizeAPIMartVideoMode(payload map[string]any, config apimartInputConfig) {
	if !config.modeFromRes {
		return
	}
	mode := strings.ToLower(strings.TrimSpace(toStringSafe(payload["mode"])))
	if mode == "" || mode == "normal" {
		resolution := strings.ToLower(firstNonEmpty(toStringSafe(payload["resolution"]), toStringSafe(payload["resolution_name"])))
		switch normalizeAPIMartVideoResolution(resolution, apimartInputConfig{}) {
		case "1080p", "4k":
			mode = "pro"
		default:
			mode = "std"
		}
	}
	payload["mode"] = mode
}

func normalizeAPIMartKlingV3Advanced(payload map[string]any, modelName string, channel model.ModelChannel) {
	if normalizeAPIMartModelName(modelName) != "kling-v3" {
		return
	}
	normalizeAPIMartKlingV3ElementList(payload, channel)
	if !boolLike(payload["multi_shot"]) {
		delete(payload, "multi_shot")
		delete(payload, "shot_type")
		delete(payload, "multi_prompt")
		return
	}
	payload["multi_shot"] = true
	shotType := strings.ToLower(strings.TrimSpace(toStringSafe(payload["shot_type"])))
	if shotType != "customize" {
		payload["shot_type"] = "intelligence"
		delete(payload, "multi_prompt")
		return
	}
	payload["shot_type"] = "customize"
	payload["multi_prompt"] = normalizeAPIMartKlingV3MultiPrompt(payload["multi_prompt"])
}

func normalizeAPIMartKlingV3ElementList(payload map[string]any, channel model.ModelChannel) {
	items, ok := payload["element_list"].([]any)
	if !ok || len(items) == 0 {
		delete(payload, "element_list")
		return
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		record, _ := item.(map[string]any)
		values, err := normalizeAPIMartReferenceValues(record["element_input_urls"], channel)
		if err != nil {
			payload["_apimart_reference_error"] = err.Error()
			return
		}
		if len(values) == 0 {
			continue
		}
		if len(values) > 4 {
			values = values[:4]
		}
		result = append(result, map[string]any{
			"name":               strings.TrimSpace(toStringSafe(record["name"])),
			"description":        strings.TrimSpace(toStringSafe(record["description"])),
			"element_input_urls": values,
		})
		if len(result) >= 3 {
			break
		}
	}
	if len(result) == 0 {
		delete(payload, "element_list")
		return
	}
	payload["element_list"] = result
}

func normalizeAPIMartKlingV3MultiPrompt(value any) []map[string]any {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		items = []any{map[string]any{"prompt": "", "duration": 1}}
	}
	result := make([]map[string]any, 0, len(items))
	for index, item := range items {
		record, _ := item.(map[string]any)
		duration := normalizeAPIMartInt(record["duration"])
		if duration < 1 {
			duration = 1
		}
		if duration > 15 {
			duration = 15
		}
		result = append(result, map[string]any{
			"index":    index + 1,
			"prompt":   toStringSafe(record["prompt"]),
			"duration": duration,
		})
	}
	return result
}
func normalizeAPIMartVideoQuality(payload map[string]any, config apimartInputConfig) {
	if !config.hasQuality {
		return
	}
	value := firstNonEmpty(toStringSafe(payload["quality"]), toStringSafe(payload["resolution"]), toStringSafe(payload["resolution_name"]))
	if strings.TrimSpace(value) != "" {
		payload["quality"] = normalizeAPIMartVideoResolution(value, config)
	}
	delete(payload, "resolution")
	delete(payload, "resolution_name")
}

func normalizeAPIMartImageCount(payload map[string]any, config apimartInputConfig) {
	if !config.hasCount {
		delete(payload, "n")
		delete(payload, "num_images")
		delete(payload, "max_images")
		delete(payload, "actual_image_count")
		return
	}
	value := payload["n"]
	if isEmptyValue(value) {
		value = payload["num_images"]
	}
	if isEmptyValue(value) {
		value = payload["max_images"]
	}
	if isEmptyValue(value) {
		value = payload["actual_image_count"]
	}
	if !isEmptyValue(value) {
		payload["n"] = normalizeAPIMartInt(value)
	}
	delete(payload, "num_images")
	delete(payload, "max_images")
	delete(payload, "actual_image_count")
}

func applyAPIMartVideoDefaults(payload map[string]any, modelName string) {
	model := normalizeAPIMartModelName(modelName)
	if model == "doubao-seedance-2.5" {
		switch strings.ToLower(strings.TrimSpace(toStringSafe(payload["resolution"]))) {
		case "1080p", "1080", "2k", "4k":
			payload["resolution"] = "720p"
		}
		if !isEmptyValue(payload["duration"]) {
			duration := normalizeAPIMartInt(payload["duration"])
			if duration == -1 {
			} else if duration < 4 {
				duration = 4
			} else if duration > 30 {
				duration = 30
			}
			payload["duration"] = duration
		}
	}
	if model == "flux-3-video" {
		switch strings.ToLower(strings.TrimSpace(toStringSafe(payload["resolution"]))) {
		case "360p", "360", "480p", "480":
			payload["resolution"] = "720p"
		}
		if !isEmptyValue(payload["duration"]) {
			duration := normalizeAPIMartInt(payload["duration"])
			if duration < 5 {
				duration = 5
			}
			if duration > 20 {
				duration = 20
			}
			payload["duration"] = duration
		}
	}
	if model == "minimax-h3" {
		switch toStringSafe(payload["resolution"]) {
		case "480p", "720p", "768p":
			payload["resolution"] = "768P"
		default:
			payload["resolution"] = "2K"
		}
		if !isEmptyValue(payload["duration"]) {
			duration := normalizeAPIMartInt(payload["duration"])
			if duration < 4 {
				duration = 4
			}
			if duration > 15 {
				duration = 15
			}
			payload["duration"] = duration
		}
	}
	if strings.Contains(model, "wan2-5") && isEmptyValue(payload["audio"]) {
		payload["audio"] = true
	}
	if isAPIMartKlingV26MotionControlModel(modelName) {
		delete(payload, "keep_original_sound")
		delete(payload, "watermark_info")
		if isEmptyValue(payload["character_orientation"]) {
			payload["character_orientation"] = "video"
		}
		if isEmptyValue(payload["mode"]) {
			payload["mode"] = "std"
		}
		return
	}
	if strings.Contains(model, "motion-control") {
		if isEmptyValue(payload["character_orientation"]) {
			payload["character_orientation"] = "image"
		}
		if isEmptyValue(payload["mode"]) {
			payload["mode"] = "std"
		}
		if isEmptyValue(payload["keep_original_sound"]) {
			payload["keep_original_sound"] = "yes"
		}
	}
}

func applyAPIMartVideoGenerateAudioInput(payload map[string]any, modelName string) {
	value, ok := payload["video_generate_audio"]
	if !ok {
		return
	}
	delete(payload, "video_generate_audio")
	enabled := boolLike(value)
	model := normalizeAPIMartModelName(modelName)
	switch {
	case strings.Contains(model, "doubao-seedance-2"), strings.Contains(model, "veo") && strings.Contains(model, "official"):
		payload["generate_audio"] = enabled
	case strings.Contains(model, "doubao-seedance-1-5"), strings.Contains(model, "seedance-1-5"):
		payload["audio"] = enabled
	case model == "wan2-6", model == "wan2-6-i2v-flash":
		payload["audio"] = enabled
	case strings.Contains(model, "kling-v3-omni"):
		if isEmptyValue(payload["video_list"]) {
			payload["audio"] = enabled
		}
	case strings.Contains(model, "kling-v3") && !strings.Contains(model, "omni"):
		payload["audio"] = enabled
	case strings.Contains(model, "pixverse-v6"), strings.Contains(model, "viduq3-pro"), strings.Contains(model, "vidu-q3-pro"), strings.Contains(model, "viduq3-turbo"):
		payload["audio"] = enabled
	case (strings.Contains(model, "kling-v2-6") || strings.Contains(model, "kling-2-6")) && !strings.Contains(model, "motion"):
		if enabled {
			if !hasAPIMartLastFrameInput(payload) {
				payload["audio"] = true
				if isEmptyValue(payload["mode"]) {
					payload["mode"] = "pro"
				}
			}
		} else {
			payload["audio"] = false
		}
	}
}

func clearAPIMartConflictingReferences(payload map[string]any, modelName string) {
	model := normalizeAPIMartModelName(modelName)
	if model == "happyhorse-1-1" && !isEmptyValue(payload["first_frame_image"]) {
		delete(payload, "image_urls")
	}
	if strings.Contains(model, "doubao-seedance-2") && !isEmptyValue(payload["image_with_roles"]) {
		delete(payload, "image_urls")
		if hasAPIMartFirstLastImageRole(payload) {
			delete(payload, "video_urls")
			delete(payload, "audio_urls")
		}
	}
	if (strings.Contains(model, "wan2-7") || strings.Contains(model, "wan2.7")) && !strings.Contains(model, "r2v") && !strings.Contains(model, "videoedit") && !isEmptyValue(payload["video_urls"]) {
		delete(payload, "audio_url")
	}
	if strings.Contains(model, "omni-flash-ext") && !isEmptyValue(payload["video_urls"]) {
		delete(payload, "duration")
	}
}

func validateAPIMartVideoRequiredInputs(payload map[string]any, modelName string) error {
	model := normalizeAPIMartModelName(modelName)
	switch {
	case model == "kling-3-0-turbo":
		return requireAPIMartAnyInput(payload, "prompt", "first_frame_image")
	case model == "happyhorse-1-1":
		if len(normalizeAPIMartReferenceStringList(payload["image_urls"])) > 9 {
			return errors.New("图片数量最多9张")
		}
		return requireAPIMartAnyInput(payload, "prompt", "first_frame_image", "image_urls")
	case strings.Contains(model, "motion-control"):
		if isEmptyValue(payload["image_url"]) || isEmptyValue(payload["video_url"]) {
			return errors.New("motion-control 模型缺少参考图和参考视频")
		}
		return nil
	case strings.Contains(model, "minimax-hailuo-2-3-fast"):
		return requireAPIMartAnyInput(payload, "first_frame_image")
	case strings.Contains(model, "wan2-7-videoedit"), strings.Contains(model, "wan2.7-videoedit"):
		return requireAPIMartAnyInput(payload, "video_urls")
	case strings.Contains(model, "wan2-7-r2v"), strings.Contains(model, "wan2.7-r2v"):
		return requireAPIMartAnyInput(payload, "image_with_roles", "video_urls")
	case strings.Contains(model, "wan2-6-i2v-flash"), strings.Contains(model, "wan2.6-i2v-flash"):
		return requireAPIMartAnyInput(payload, "image_urls")
	case model == "viduq3" || model == "viduq3-mix":
		return requireAPIMartAnyInput(payload, "image_urls")
	default:
		return nil
	}
}

func requireAPIMartAnyInput(payload map[string]any, fields ...string) error {
	for _, field := range fields {
		if !isEmptyValue(payload[field]) {
			return nil
		}
	}
	return errors.New("APIMart required input missing: " + strings.Join(fields, " or "))
}

func normalizeAPIMartReferenceStringList(value any) []string {
	switch typed := value.(type) {
	case []string:
		return typed
	case []any:
		items := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := strings.TrimSpace(toStringSafe(item)); text != "" {
				items = append(items, text)
			}
		}
		return items
	case string:
		if strings.TrimSpace(typed) == "" {
			return nil
		}
		return []string{strings.TrimSpace(typed)}
	default:
		return nil
	}
}

func hasAPIMartFirstLastImageRole(payload map[string]any) bool {
	if items, ok := payload["image_with_roles"].([]map[string]string); ok {
		for _, item := range items {
			role := strings.TrimSpace(item["role"])
			if role == "first_frame" || role == "last_frame" {
				return true
			}
		}
	}
	rawItems, ok := payload["image_with_roles"].([]any)
	if !ok {
		return false
	}
	for _, raw := range rawItems {
		record, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role := strings.TrimSpace(toStringSafe(record["role"]))
		if role == "first_frame" || role == "last_frame" {
			return true
		}
	}
	return false
}

func hasAPIMartLastFrameInput(payload map[string]any) bool {
	if !isEmptyValue(payload["last_frame_image"]) || !isEmptyValue(payload["end_frame_image"]) {
		return true
	}
	if items, ok := payload["image_with_roles"].([]map[string]string); ok {
		for _, item := range items {
			if strings.TrimSpace(item["role"]) == "last_frame" {
				return true
			}
		}
	}
	rawItems, ok := payload["image_with_roles"].([]any)
	if !ok {
		return false
	}
	for _, raw := range rawItems {
		record, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if strings.TrimSpace(toStringSafe(record["role"])) == "last_frame" {
			return true
		}
	}
	return false
}

func normalizeAPIMartReferenceInputs(payload map[string]any, modelName string, config apimartInputConfig, channel model.ModelChannel) {
	for _, key := range apimartReferenceAliasKeys() {
		value, ok := payload[key]
		if !ok || isEmptyValue(value) {
			continue
		}
		values, err := normalizeAPIMartReferenceValues(value, channel)
		if err != nil {
			payload["_apimart_reference_error"] = err.Error()
			return
		}
		if len(values) == 0 {
			continue
		}
		if isAPIMartAudioReferenceSource(key, values) && (config.audioRefField != "" || isAPIMartDirectAudioReferenceField(key)) {
			setAPIMartAudioReference(payload, config, key, values)
		} else if isAPIMartVideoReferenceSource(key, values) && (config.videoRefField != "" || isAPIMartDirectVideoReferenceField(key)) {
			setAPIMartVideoReference(payload, config, key, values)
		} else if isAPIMartImageReferenceSource(key, values) && (config.imageRefField != "" || isAPIMartDirectImageReferenceField(key)) {
			setAPIMartImageReference(payload, config, key, values)
		}
	}
	clearAPIMartUnusedReferences(payload, config)
}

func clearAPIMartAspectForImageMode(payload map[string]any, config apimartInputConfig) {
	if !config.dropAspectWithImage || !hasAPIMartImageReference(payload) {
		return
	}
	delete(payload, "aspect_ratio")
	delete(payload, "size")
	delete(payload, "ratio")
	delete(payload, "image_size")
}

func hasAPIMartImageReference(payload map[string]any) bool {
	for _, key := range []string{
		"image_urls",
		"image_with_roles",
		"first_frame_image",
		"last_frame_image",
		"end_frame_image",
		"img_references",
		"ref_images",
	} {
		if !isEmptyValue(payload[key]) {
			return true
		}
	}
	return false
}

func setAPIMartImageReference(payload map[string]any, config apimartInputConfig, sourceKey string, values []string) {
	field := inferAPIMartImageReferenceField(sourceKey)
	if shouldPreferAPIMartConfiguredImageField(config, sourceKey, field) {
		field = config.imageRefField
	}
	if field == "" {
		field = config.imageRefField
	}
	if field == "" || len(values) == 0 {
		return
	}
	if config.maxImageRefs > 0 && len(values) > config.maxImageRefs {
		values = values[:config.maxImageRefs]
	}
	if (config.imageRefKind == "seedance2" || config.imageRefKind == "roles") && isAPIMartFirstLastSource(sourceKey) {
		appendAPIMartImageRole(payload, sourceKey, values[0])
		return
	}
	if config.imageRefKind == "array_frames" && isAPIMartFirstLastSource(sourceKey) {
		setAPIMartArrayFrameReference(payload, sourceKey, values[0])
		return
	}
	if config.imageRefKind == "happyhorse11" {
		setAPIMartHappyHorse11ImageReference(payload, sourceKey, values)
		return
	}
	if config.imageRefKind == "first_only" && isAPIMartFirstFrameSource(sourceKey) {
		payload["first_frame_image"] = values[0]
		return
	}
	if isAPIMartFirstLastSource(sourceKey) && !supportsAPIMartNamedFrameFields(config) {
		return
	}
	if supportsAPIMartNamedFrameFields(config) {
		if isAPIMartFirstFrameSource(sourceKey) {
			payload["first_frame_image"] = values[0]
			return
		}
		if isAPIMartLastFrameSource(sourceKey) {
			if config.imageRefKind == "skyreels" {
				payload["end_frame_image"] = values[0]
			} else if config.imageRefKind != "happyhorse" {
				payload["last_frame_image"] = values[0]
			}
			return
		}
	}
	if config.imageRefKind == "pixverse" {
		setAPIMartPixverseImageReference(payload, sourceKey, values)
		return
	}
	if config.imageRefKind == "skyreels" {
		setAPIMartSkyReelsImageReference(payload, values)
		return
	}
	if config.imageRefKind == "happyhorse11" {
		setAPIMartHappyHorse11ImageReference(payload, sourceKey, values)
		return
	}
	if config.imageRefKind == "happyhorse" {
		setAPIMartHappyHorseImageReference(payload, values)
		return
	}
	if config.imageRefKind == "roles" {
		payload["image_with_roles"] = buildAPIMartImageRoles(values)
		return
	}
	if config.imageRefKind == "array_frames" {
		payload[field] = mergeAPIMartStringValues(payload[field], values)
		return
	}
	if config.imageRefKind == "first_only" {
		payload["first_frame_image"] = values[0]
		return
	}
	if field == "first_frame_image" || config.imageRefKind == "first_last" {
		payload["first_frame_image"] = values[0]
		if len(values) > 1 {
			payload["last_frame_image"] = values[1]
		}
		return
	}
	if config.imageRefKind == "single" || field == "image_url" {
		payload[field] = values[0]
		return
	}
	payload[field] = mergeAPIMartStringValues(payload[field], values)
}

func setAPIMartArrayFrameReference(payload map[string]any, sourceKey string, value string) {
	value = strings.TrimSpace(value)
	if value == "" {
		return
	}
	items := collectAPIMartReferenceStrings(payload["image_urls"], 0)
	if isAPIMartFirstFrameSource(sourceKey) {
		if len(items) == 0 {
			items = append(items, value)
		} else {
			items[0] = value
		}
		payload["image_urls"] = items
		return
	}
	if len(items) == 0 {
		items = append(items, value)
	} else if len(items) == 1 {
		items = append(items, value)
	} else {
		items[1] = value
	}
	payload["image_urls"] = items
}

func setAPIMartPixverseImageReference(payload map[string]any, sourceKey string, values []string) {
	if isAPIMartFirstLastSource(sourceKey) {
		payload["first_frame_image"] = values[0]
		if len(values) > 1 {
			payload["last_frame_image"] = values[1]
		}
		return
	}
	if len(values) > 1 {
		payload["img_references"] = values
		return
	}
	payload["image_urls"] = values
}

func setAPIMartSkyReelsImageReference(payload map[string]any, values []string) {
	if len(values) == 0 {
		return
	}
	payload["ref_images"] = buildAPIMartSkyReelsImageReferences(values)
}

func setAPIMartHappyHorse11ImageReference(payload map[string]any, sourceKey string, values []string) {
	if len(values) == 0 {
		return
	}
	if isAPIMartFirstFrameSource(sourceKey) || sourceKey == "first_frame_image" {
		payload["first_frame_image"] = values[0]
		return
	}
	payload["image_urls"] = mergeAPIMartStringValues(payload["image_urls"], values)
}

func setAPIMartHappyHorseImageReference(payload map[string]any, values []string) {
	if len(values) == 0 {
		return
	}
	if len(values) == 1 {
		payload["first_frame_image"] = values[0]
		return
	}
	payload["image_urls"] = values
}

func isAPIMartFirstLastSource(sourceKey string) bool {
	return isAPIMartFirstFrameSource(sourceKey) || isAPIMartLastFrameSource(sourceKey)
}

func isAPIMartFirstFrameSource(sourceKey string) bool {
	return sourceKey == "first_frame_url" || sourceKey == "first_frame_image"
}

func isAPIMartLastFrameSource(sourceKey string) bool {
	return sourceKey == "last_frame_url" || sourceKey == "last_frame_image"
}

func supportsAPIMartNamedFrameFields(config apimartInputConfig) bool {
	switch config.imageRefKind {
	case "first_last", "skyreels", "pixverse", "happyhorse", "minimax_h3":
		return true
	default:
		return false
	}
}

func buildAPIMartImageRoles(values []string) []map[string]string {
	roles := make([]map[string]string, 0, len(values))
	for index, value := range values {
		role := "reference_image"
		if index == 0 {
			role = "first_frame"
		} else if index == 1 {
			role = "last_frame"
		}
		roles = append(roles, map[string]string{"url": value, "role": role})
	}
	return roles
}

func appendAPIMartImageRole(payload map[string]any, sourceKey string, value string) {
	if strings.TrimSpace(value) == "" {
		return
	}
	role := "reference_image"
	if strings.Contains(sourceKey, "first_frame") {
		role = "first_frame"
	} else if strings.Contains(sourceKey, "last_frame") {
		role = "last_frame"
	}
	roles := []map[string]string{}
	if existing, ok := payload["image_with_roles"].([]map[string]string); ok {
		roles = append(roles, existing...)
	} else if existing, ok := payload["image_with_roles"].([]any); ok {
		for _, item := range existing {
			if record, ok := item.(map[string]any); ok {
				url := strings.TrimSpace(toStringSafe(record["url"]))
				existingRole := strings.TrimSpace(toStringSafe(record["role"]))
				if url != "" && existingRole != "" {
					roles = append(roles, map[string]string{"url": url, "role": existingRole})
				}
			}
		}
	}
	for index, item := range roles {
		if item["role"] == role {
			roles[index] = map[string]string{"url": value, "role": role}
			payload["image_with_roles"] = roles
			return
		}
	}
	payload["image_with_roles"] = append(roles, map[string]string{"url": value, "role": role})
}

func setAPIMartVideoReference(payload map[string]any, config apimartInputConfig, sourceKey string, values []string) {
	field := ""
	if !isAPIMartGenericVideoReferenceField(sourceKey) {
		field = inferAPIMartVideoReferenceField(sourceKey)
	}
	if field == "" {
		field = config.videoRefField
	}
	if field == "" || len(values) == 0 {
		return
	}
	if config.videoRefKind == "skyreels" {
		payload["ref_videos"] = buildAPIMartSkyReelsVideoReferences(values)
		return
	}
	if config.videoRefKind == "kling_video_list" {
		payload["video_list"] = buildAPIMartKlingVideoList(values)
		return
	}
	if config.videoRefKind == "single" || field == "video_url" {
		payload[field] = values[0]
		return
	}
	payload[field] = values
}

func setAPIMartAudioReference(payload map[string]any, config apimartInputConfig, sourceKey string, values []string) {
	if config.audioRefKind == "skyreels_ref_images" {
		attachAPIMartSkyReelsAudioReference(payload, values)
		return
	}
	if config.audioRefKind == "wan_r2v_voice" {
		attachAPIMartImageRoleVoice(payload, values)
		return
	}
	field := ""
	if !isAPIMartGenericAudioReferenceField(sourceKey) {
		field = inferAPIMartAudioReferenceField(sourceKey)
	}
	if field == "" {
		field = config.audioRefField
	}
	if field == "" || len(values) == 0 {
		return
	}
	if config.audioRefKind == "array" || field == "audio_urls" || field == "reference_audio_urls" {
		payload[field] = values
		return
	}
	payload[field] = values[0]
}

func buildAPIMartSkyReelsImageReferences(values []string) []map[string]any {
	items := make([]map[string]any, 0, 1)
	items = append(items, map[string]any{
		"tag":        "@image1",
		"type":       "image",
		"image_urls": values,
	})
	return items
}

func mergeAPIMartStringValues(existing any, values []string) []string {
	result := collectAPIMartReferenceStrings(existing, 0)
	seen := map[string]bool{}
	merged := make([]string, 0, len(result)+len(values))
	for _, value := range append(result, values...) {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		merged = append(merged, value)
	}
	return merged
}

func buildAPIMartSkyReelsVideoReferences(values []string) []map[string]string {
	items := make([]map[string]string, 0, len(values))
	for index, value := range values {
		items = append(items, map[string]string{
			"tag":       fmt.Sprintf("@video%d", index+1),
			"type":      "reference",
			"video_url": value,
		})
	}
	return items
}

func attachAPIMartSkyReelsAudioReference(payload map[string]any, values []string) {
	if len(values) == 0 || strings.TrimSpace(values[0]) == "" {
		return
	}
	items := readAPIMartSkyReelsImageReferences(payload)
	if len(items) == 0 {
		return
	}
	items[0]["audio_url"] = values[0]
	payload["ref_images"] = items
}

func readAPIMartSkyReelsImageReferences(payload map[string]any) []map[string]any {
	if items, ok := payload["ref_images"].([]map[string]any); ok {
		return items
	}
	rawItems, ok := payload["ref_images"].([]any)
	if !ok {
		return nil
	}
	items := make([]map[string]any, 0, len(rawItems))
	for _, raw := range rawItems {
		if item, ok := raw.(map[string]any); ok {
			items = append(items, item)
		}
	}
	return items
}

func attachAPIMartImageRoleVoice(payload map[string]any, values []string) {
	if len(values) == 0 || strings.TrimSpace(values[0]) == "" {
		return
	}
	roles := readAPIMartImageRoles(payload)
	if len(roles) == 0 {
		return
	}
	roles[0]["reference_voice"] = values[0]
	payload["image_with_roles"] = roles
}

func readAPIMartImageRoles(payload map[string]any) []map[string]any {
	if roles, ok := payload["image_with_roles"].([]map[string]any); ok {
		return roles
	}
	if roles, ok := payload["image_with_roles"].([]map[string]string); ok {
		result := make([]map[string]any, 0, len(roles))
		for _, role := range roles {
			result = append(result, map[string]any{"url": role["url"], "role": role["role"]})
		}
		return result
	}
	rawItems, ok := payload["image_with_roles"].([]any)
	if !ok {
		return nil
	}
	result := make([]map[string]any, 0, len(rawItems))
	for _, raw := range rawItems {
		if role, ok := raw.(map[string]any); ok {
			result = append(result, role)
		}
	}
	return result
}

func buildAPIMartKlingVideoList(values []string) []map[string]string {
	items := make([]map[string]string, 0, len(values))
	for _, value := range values {
		items = append(items, map[string]string{
			"video_url":           value,
			"refer_type":          "base",
			"keep_original_sound": "no",
		})
	}
	return items
}

func shouldPreferAPIMartConfiguredImageField(config apimartInputConfig, sourceKey string, directField string) bool {
	if config.imageRefField == "" || config.imageRefField == directField {
		return false
	}
	if config.imageRefField != "image_urls" || config.imageRefKind != "array" {
		return false
	}
	switch sourceKey {
	case "image", "image_url", "input_url", "input_reference", "input_reference[]", "reference_image", "reference_image_url":
		return true
	default:
		return false
	}
}

func clearAPIMartUnusedReferences(payload map[string]any, config apimartInputConfig) {
	keep := map[string]bool{}
	for _, field := range []string{config.imageRefField, config.videoRefField, config.audioRefField, "first_frame_image", "last_frame_image"} {
		if field != "" {
			keep[field] = true
		}
	}
	if config.imageRefKind == "pixverse" {
		keep["image_urls"] = true
		keep["first_frame_image"] = true
		keep["last_frame_image"] = true
		keep["img_references"] = true
	}
	if config.imageRefKind == "skyreels" {
		keep["first_frame_image"] = true
		keep["end_frame_image"] = true
		keep["ref_images"] = true
	}
	if config.videoRefKind == "skyreels" {
		keep["ref_videos"] = true
	}
	if config.videoRefKind == "kling_video_list" {
		keep["video_list"] = true
	}
	if config.imageRefKind == "happyhorse" {
		keep["first_frame_image"] = true
		keep["image_urls"] = true
	}
	if config.imageRefKind == "seedance2" {
		keep["image_urls"] = true
		keep["image_with_roles"] = true
	}
	if config.imageRefKind == "roles" {
		keep["image_with_roles"] = true
	}
	for _, key := range apimartReferenceAliasKeys() {
		if !keep[key] {
			delete(payload, key)
		}
	}
}

func apimartReferenceAliasKeys() []string {
	return []string{
		"image", "images", "image_url", "image_urls", "input_url", "input_urls", "input_reference", "input_reference[]", "image_input",
		"reference_image", "reference_images", "reference_image_url", "reference_image_urls", "first_frame_url", "first_frame_image", "last_frame_url", "last_frame_image",
		"video", "videos", "video_url", "video_urls", "input_video_url", "input_video_urls", "video_reference", "video_reference[]", "reference_video_url", "reference_video_urls",
		"audio", "audios", "audio_url", "audio_urls", "input_audio_url", "input_audio_urls", "audio_reference", "audio_reference[]", "reference_audio_url", "reference_audio_urls",
	}
}

func inferAPIMartImageReferenceField(sourceKey string) string {
	switch sourceKey {
	case "first_frame_url", "first_frame_image":
		return "first_frame_image"
	case "last_frame_url", "last_frame_image":
		return "last_frame_image"
	case "image_url", "input_url", "reference_image_url":
		return "image_url"
	case "image_urls", "images", "input_urls", "image_input", "reference_images", "reference_image_urls":
		return "image_urls"
	case "input_reference", "input_reference[]", "reference_image":
		return ""
	default:
		return ""
	}
}

func inferAPIMartVideoReferenceField(sourceKey string) string {
	switch sourceKey {
	case "video", "video_url", "input_video_url", "reference_video_url":
		return "video_url"
	case "videos", "video_urls", "input_video_urls", "video_reference", "video_reference[]", "reference_video_urls":
		return "video_urls"
	default:
		return ""
	}
}

func inferAPIMartAudioReferenceField(sourceKey string) string {
	switch sourceKey {
	case "audio", "audio_url", "input_audio_url", "reference_audio_url":
		return "audio_url"
	case "audios", "audio_urls", "input_audio_urls", "audio_reference", "audio_reference[]", "reference_audio_urls":
		return "audio_urls"
	default:
		return ""
	}
}

func isAPIMartGenericVideoReferenceField(sourceKey string) bool {
	return sourceKey == "video_reference" || sourceKey == "video_reference[]"
}

func isAPIMartGenericAudioReferenceField(sourceKey string) bool {
	return sourceKey == "audio_reference" || sourceKey == "audio_reference[]"
}

func isAPIMartDirectImageReferenceField(sourceKey string) bool {
	switch sourceKey {
	case "image_url", "image_urls", "input_url", "input_urls", "image_input", "reference_image_url", "reference_image_urls", "first_frame_url", "first_frame_image", "last_frame_url", "last_frame_image":
		return true
	default:
		return false
	}
}

func isAPIMartDirectVideoReferenceField(sourceKey string) bool {
	switch sourceKey {
	case "video_url", "video_urls", "input_video_url", "input_video_urls", "reference_video_url", "reference_video_urls":
		return true
	default:
		return false
	}
}

func isAPIMartDirectAudioReferenceField(sourceKey string) bool {
	switch sourceKey {
	case "audio_url", "audio_urls", "input_audio_url", "input_audio_urls", "reference_audio_url", "reference_audio_urls":
		return true
	default:
		return false
	}
}

func isAPIMartVideoReferenceSource(sourceKey string, values []string) bool {
	switch sourceKey {
	case "video", "videos", "video_url", "video_urls", "input_video_url", "input_video_urls", "video_reference", "video_reference[]", "reference_video_url", "reference_video_urls":
		return true
	}
	for _, value := range values {
		lowered := strings.ToLower(strings.TrimSpace(value))
		if strings.HasPrefix(lowered, "data:video/") || strings.HasSuffix(lowered, ".mp4") || strings.HasSuffix(lowered, ".mov") || strings.HasSuffix(lowered, ".webm") {
			return true
		}
	}
	return false
}

func isAPIMartAudioReferenceSource(sourceKey string, values []string) bool {
	switch sourceKey {
	case "audio", "audios", "audio_url", "audio_urls", "input_audio_url", "input_audio_urls", "audio_reference", "audio_reference[]", "reference_audio_url", "reference_audio_urls":
		return true
	}
	for _, value := range values {
		lowered := strings.ToLower(strings.TrimSpace(value))
		if strings.HasPrefix(lowered, "data:audio/") || strings.HasSuffix(lowered, ".mp3") || strings.HasSuffix(lowered, ".wav") || strings.HasSuffix(lowered, ".m4a") {
			return true
		}
	}
	return false
}

func isAPIMartImageReferenceSource(sourceKey string, values []string) bool {
	switch sourceKey {
	case "image", "images", "image_url", "image_urls", "input_url", "input_urls", "input_reference", "input_reference[]", "image_input", "reference_image", "reference_images", "reference_image_url", "reference_image_urls", "first_frame_url", "first_frame_image", "last_frame_url", "last_frame_image":
		return true
	}
	for _, value := range values {
		lowered := strings.ToLower(strings.TrimSpace(value))
		if strings.HasPrefix(lowered, "data:image/") || strings.HasSuffix(lowered, ".png") || strings.HasSuffix(lowered, ".jpg") || strings.HasSuffix(lowered, ".jpeg") || strings.HasSuffix(lowered, ".webp") {
			return true
		}
	}
	return false
}

func normalizeAPIMartReferenceValues(value any, channel model.ModelChannel) ([]string, error) {
	raw := collectAPIMartReferenceStrings(value, 0)
	result := make([]string, 0, len(raw))
	for _, item := range raw {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if strings.HasPrefix(strings.ToLower(item), "data:image/") {
			uploaded, err := uploadAPIMartDataImage(channel, item)
			if err != nil {
				return nil, err
			}
			result = append(result, uploaded)
			continue
		}
		if strings.HasPrefix(strings.ToLower(item), "data:video/") {
			return nil, errors.New("APIMart data URI video references are not supported; use a public video URL")
		}
		if strings.HasPrefix(strings.ToLower(item), "data:audio/") {
			return nil, errors.New("APIMart data URI audio references are not supported; use a public audio URL")
		}
		result = append(result, item)
	}
	return result, nil
}

func collectAPIMartReferenceStrings(value any, depth int) []string {
	if depth > 6 || value == nil {
		return nil
	}
	switch typed := value.(type) {
	case string:
		if strings.TrimSpace(typed) == "" {
			return nil
		}
		return []string{typed}
	case []string:
		return typed
	case []any:
		var result []string
		for _, item := range typed {
			result = append(result, collectAPIMartReferenceStrings(item, depth+1)...)
		}
		return result
	case map[string]any:
		for _, key := range []string{"url", "image_url", "imageUrl", "video_url", "videoUrl", "download_url", "downloadUrl"} {
			if text := strings.TrimSpace(toStringSafe(typed[key])); text != "" {
				return []string{text}
			}
		}
		var result []string
		for _, item := range typed {
			result = append(result, collectAPIMartReferenceStrings(item, depth+1)...)
		}
		return result
	default:
		if text := strings.TrimSpace(toStringSafe(value)); text != "" {
			return []string{text}
		}
	}
	return nil
}

func uploadAPIMartDataImage(channel model.ModelChannel, dataURI string) (string, error) {
	mediaType, encoded, ok := strings.Cut(strings.TrimSpace(dataURI), ",")
	if !ok || !strings.Contains(strings.ToLower(mediaType), ";base64") {
		return "", errors.New("APIMart image upload failed: invalid data URI")
	}
	contentType := strings.TrimPrefix(strings.Split(strings.TrimPrefix(mediaType, "data:"), ";")[0], "data:")
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", fmt.Errorf("APIMart image upload failed: %v", err)
	}
	return uploadAPIMartImageBytes(channel, data, normalizeAPIMartReferenceFilename("reference", contentType), contentType)
}

func uploadAPIMartImageBytes(channel model.ModelChannel, data []byte, filename string, contentType string) (string, error) {
	if len(data) == 0 || strings.TrimSpace(channel.APIKey) == "" {
		return "", errors.New("APIMart image upload failed: empty file or missing API key")
	}
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = http.DetectContentType(data)
	}
	if !strings.HasPrefix(strings.ToLower(contentType), "image/") {
		return "", fmt.Errorf("APIMart image upload failed: unsupported content type %s", contentType)
	}

	var requestBody bytes.Buffer
	writer := multipart.NewWriter(&requestBody)
	filename = normalizeAPIMartReferenceFilename(filename, contentType)
	partHeader := textproto.MIMEHeader{}
	partHeader.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, escapeKIEFormFilename(filename)))
	partHeader.Set("Content-Type", contentType)
	part, err := writer.CreatePart(partHeader)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(data); err != nil {
		return "", err
	}
	_ = writer.Close()

	request, err := http.NewRequest(http.MethodPost, service.BuildModelChannelURL(channel, apimartImageUploadPath), &requestBody)
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	request.Header.Set("Content-Type", writer.FormDataContentType())

	response, err := service.HTTPClientForChannel(channel).Do(request)
	if err != nil {
		log.Printf("APIMart image upload failed: filename=%s err=%v", filename, err)
		return "", fmt.Errorf("APIMart image upload failed: %v", err)
	}
	defer response.Body.Close()

	body, readErr := readLimitedUpstreamResponse(response.Body, "APIMart 图片上传", pollResponseLimit)
	if readErr != nil {
		return "", fmt.Errorf("APIMart image upload failed: %w", readErr)
	}
	if response.StatusCode >= http.StatusBadRequest {
		log.Printf("APIMart image upload error: filename=%s status=%d body=%s", filename, response.StatusCode, strings.TrimSpace(string(body)))
		return "", fmt.Errorf("APIMart image upload failed: %s", readUpstreamAIErrorMessage(body, response.StatusCode))
	}

	var result struct {
		URL string `json:"url"`
	}
	if json.Unmarshal(body, &result) != nil || strings.TrimSpace(result.URL) == "" {
		return "", errors.New("APIMart image upload failed: no URL returned")
	}
	return strings.TrimSpace(result.URL), nil
}

func readAPIMartFormFileBytes(header *multipart.FileHeader) ([]byte, string, error) {
	file, err := header.Open()
	if err != nil {
		return nil, "", err
	}
	defer file.Close()
	data, err := readLimitedRequestBody(file, "APIMart 参考文件", adapterReferenceMaxBytes)
	if err != nil {
		return nil, "", err
	}
	if len(data) == 0 {
		return nil, "", errors.New("APIMart file upload failed: empty file")
	}
	contentType := strings.TrimSpace(header.Header.Get("Content-Type"))
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = http.DetectContentType(data)
	}
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = detectAPIMartReferenceContentType(header.Filename)
	}
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = "image/png"
	}
	return data, contentType, nil
}

func normalizeAPIMartReferenceFilename(filename string, contentType string) string {
	filename = strings.TrimSpace(filename)
	if filename == "" {
		filename = "reference"
	}
	if strings.Contains(strings.ToLower(filename), ".") {
		return filename
	}
	switch strings.ToLower(strings.TrimSpace(contentType)) {
	case "image/png":
		return filename + ".png"
	case "image/jpeg":
		return filename + ".jpg"
	case "image/webp":
		return filename + ".webp"
	case "image/gif":
		return filename + ".gif"
	default:
		return filename
	}
}

func detectAPIMartReferenceContentType(filename string) string {
	filename = strings.ToLower(strings.TrimSpace(filename))
	switch {
	case strings.HasSuffix(filename, ".png"):
		return "image/png"
	case strings.HasSuffix(filename, ".jpg"), strings.HasSuffix(filename, ".jpeg"):
		return "image/jpeg"
	case strings.HasSuffix(filename, ".webp"):
		return "image/webp"
	case strings.HasSuffix(filename, ".gif"):
		return "image/gif"
	case strings.HasSuffix(filename, ".mp4"):
		return "video/mp4"
	case strings.HasSuffix(filename, ".mov"):
		return "video/quicktime"
	case strings.HasSuffix(filename, ".webm"):
		return "video/webm"
	default:
		return ""
	}
}

func isAPIMartKlingV26MotionControlModel(modelName string) bool {
	model := normalizeAPIMartModelName(modelName)
	return model == "kling-v2-6-motion-control" || model == "kling-v3-motion-control"
}

func normalizeAPIMartModelName(modelName string) string {
	model := strings.ToLower(strings.TrimSpace(modelName))
	model = strings.ReplaceAll(model, "_", "-")
	model = strings.ReplaceAll(model, ".", "-")
	model = strings.ReplaceAll(model, "/", "-")
	return model
}

func normalizeAPIMartRatio(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	if value == "" || value == "auto" {
		return "auto"
	}
	if width, height, ok := parseAPIMartSize(value); ok {
		if ratio := normalizeAPIMartSizeRatio(width, height); ratio != "" {
			return ratio
		}
	}
	return value
}

func parseAPIMartSize(value string) (int, int, bool) {
	value = strings.TrimSpace(strings.ToLower(value))
	separator := "x"
	if strings.Contains(value, "*") {
		separator = "*"
	}
	parts := strings.Split(value, separator)
	if len(parts) != 2 {
		return 0, 0, false
	}
	width, err := strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil || width <= 0 {
		return 0, 0, false
	}
	height, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil || height <= 0 {
		return 0, 0, false
	}
	return width, height, true
}

func normalizeAPIMartSizeRatio(width int, height int) string {
	for _, item := range []struct {
		width  int
		height int
		ratio  string
	}{
		{1, 1, "1:1"},
		{2, 1, "2:1"},
		{1, 2, "1:2"},
		{3, 1, "3:1"},
		{1, 3, "1:3"},
		{5, 4, "5:4"},
		{4, 5, "4:5"},
		{16, 9, "16:9"},
		{9, 16, "9:16"},
		{4, 3, "4:3"},
		{3, 4, "3:4"},
		{3, 2, "3:2"},
		{2, 3, "2:3"},
		{21, 9, "21:9"},
		{9, 21, "9:21"},
	} {
		diff := width*item.height - height*item.width
		if diff < 0 {
			diff = -diff
		}
		if diff*100 <= width*item.height*4 {
			return item.ratio
		}
	}
	return ""
}

func apimartSizeResolution(value string) string {
	width, height, ok := parseAPIMartSize(value)
	if !ok {
		return ""
	}
	longSide := width
	if height > longSide {
		longSide = height
	}
	switch {
	case longSide >= 3500:
		return "4K"
	case longSide >= 1700:
		return "2K"
	case longSide >= 900:
		return "1K"
	default:
		return ""
	}
}

func apimartQualityResolution(value string) string {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case "low", "standard":
		return "1K"
	case "medium", "hd":
		return "2K"
	case "high", "uhd":
		return "4K"
	default:
		return ""
	}
}

func clampAPIMartImageResolution(value string, config apimartInputConfig) string {
	level := apimartResolutionLevel(value)
	if level == 0 {
		return value
	}
	if maxLevel := apimartResolutionLevel(config.maxResolution); maxLevel > 0 && level > maxLevel {
		level = maxLevel
	}
	if minLevel := apimartResolutionLevel(config.minResolution); minLevel > 0 && level < minLevel {
		level = minLevel
	}
	switch level {
	case 1:
		return "1K"
	case 2:
		return "2K"
	case 3:
		return "3K"
	case 4:
		return "4K"
	default:
		return value
	}
}

func apimartResolutionLevel(value string) int {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case "0.5", "0.5k", "512", "512p":
		return 1
	case "1", "1k", "1024", "1024p", "low", "standard":
		return 1
	case "2", "2k", "2048", "2048p", "medium", "hd":
		return 2
	case "3", "3k", "3072":
		return 3
	case "4", "4k", "4096", "4096p", "high", "uhd":
		return 4
	default:
		return 0
	}
}

func normalizeAPIMartVideoResolution(value string, config apimartInputConfig) string {
	value = strings.TrimSpace(strings.ToLower(value))
	value = strings.TrimSuffix(value, " ")
	normalized := value
	switch value {
	case "480", "480p", "sd", "low":
		normalized = "480p"
	case "512", "512p":
		normalized = "512p"
	case "540", "540p":
		normalized = "540p"
	case "720", "720p", "hd", "medium", "standard":
		normalized = "720p"
	case "768", "768p":
		normalized = "768p"
	case "1080", "1080p", "fhd", "high", "pro":
		normalized = "1080p"
	case "2160", "2160p", "4k", "uhd":
		normalized = "4k"
	case "360", "360p":
		normalized = "360p"
	}
	if config.maxResolution == "720p" && (normalized == "1080p" || normalized == "4k") {
		return "720p"
	}
	return normalized
}

func normalizeAPIMartImageResolution(value string, mode string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	value = strings.TrimSuffix(value, "px")
	normalized := value
	switch value {
	case "0.5", "0.5k", "512", "512p":
		normalized = "0.5k"
	case "1", "1k", "1024", "1024p", "low", "standard":
		normalized = "1k"
	case "2", "2k", "2048", "2048p", "medium", "hd":
		normalized = "2k"
	case "3", "3k", "3072":
		normalized = "3k"
	case "4", "4k", "4096", "4096p", "high", "uhd":
		normalized = "4k"
	}
	if mode == "lower" {
		return normalized
	}
	return strings.ToUpper(normalized)
}

func normalizeAPIMartInt(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case float32:
		return int(typed)
	case json.Number:
		i, _ := typed.Int64()
		return int(i)
	default:
		text := strings.TrimSpace(fmt.Sprint(value))
		text = strings.TrimSuffix(strings.ToLower(text), "s")
		i, _ := strconv.Atoi(text)
		return i
	}
}

func copyAPIMartVideoResponse(w http.ResponseWriter, response *http.Response, request *http.Request, channel model.ModelChannel, logContext aiLogContext, onFailure func()) bool {
	if strings.Contains(request.URL.Path, "/videos/generations") {
		payload, err := readLimitedUpstreamResponse(response.Body, "APIMart 视频生成", structuredAdapterResponseLimit)
		if err != nil {
			if onFailure != nil {
				onFailure()
			}
			saveAIProxyLog(logContext, response.StatusCode, "", err.Error())
			Fail(w, "APIMart 响应读取失败")
			return true
		}
		responseBody := string(payload)
		if transformed, ok := transformAPIMartCreateVideoResponse(payload, logContext.Model); ok {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(response.StatusCode)
			_, _ = w.Write(transformed)
			saveAIProxyLog(logContext, response.StatusCode, string(transformed), "")
			return true
		}
		w.WriteHeader(response.StatusCode)
		_, _ = w.Write(payload)
		saveAIProxyLog(logContext, response.StatusCode, responseBody, "")
		return true
	}

	if strings.Contains(request.URL.Path, "/tasks/") {
		payload, err := readLimitedUpstreamResponse(response.Body, "APIMart 任务状态", structuredAdapterResponseLimit)
		if err != nil {
			if onFailure != nil {
				onFailure()
			}
			saveAIProxyLog(logContext, response.StatusCode, "", err.Error())
			Fail(w, "APIMart 响应读取失败")
			return true
		}
		responseBody := string(payload)
		if transformed, ok := transformAPIMartTaskResponse(payload, logContext.Model); ok {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(response.StatusCode)
			_, _ = w.Write(transformed)
			saveAIProxyLog(logContext, response.StatusCode, string(transformed), "")
			return true
		}
		w.WriteHeader(response.StatusCode)
		_, _ = w.Write(payload)
		saveAIProxyLog(logContext, response.StatusCode, responseBody, "")
		return true
	}
	return false
}

func transformAPIMartCreateVideoResponse(payload []byte, modelName string) ([]byte, bool) {
	taskID, status, ok := readAPIMartCreateTask(payload)
	if !ok {
		return nil, false
	}
	converted := map[string]any{
		"id":     taskID,
		"object": "video",
		"status": normalizeAPIMartTaskStatus(status),
		"model":  modelName,
	}
	encoded, err := json.Marshal(converted)
	if err != nil {
		return nil, false
	}
	return encoded, true
}

func transformAPIMartTaskResponse(payload []byte, modelName string) ([]byte, bool) {
	var result struct {
		Code int `json:"code"`
		Data struct {
			ID       string         `json:"id"`
			Status   string         `json:"status"`
			Progress int            `json:"progress"`
			Result   map[string]any `json:"result"`
			Error    *struct {
				Message string `json:"message"`
			} `json:"error"`
		} `json:"data"`
		Msg string `json:"msg"`
	}
	if err := json.Unmarshal(payload, &result); err != nil {
		return nil, false
	}
	if result.Code != 200 || strings.TrimSpace(result.Data.ID) == "" {
		return nil, false
	}
	converted := map[string]any{
		"id":       result.Data.ID,
		"object":   "video",
		"status":   normalizeAPIMartTaskStatus(result.Data.Status),
		"progress": result.Data.Progress,
		"model":    modelName,
	}
	videoURL := firstNonEmpty(extractAPIMartResultURL(result.Data.Result, "videos"), extractAPIMartResultURL(result.Data.Result, "video"))
	if videoURL != "" {
		converted["video"] = map[string]any{"url": videoURL}
		converted["url"] = videoURL
		converted["data"] = []map[string]any{{"url": videoURL}}
	}
	if result.Data.Error != nil && strings.TrimSpace(result.Data.Error.Message) != "" {
		converted["error"] = result.Data.Error.Message
	}
	encoded, err := json.Marshal(converted)
	if err != nil {
		return nil, false
	}
	return encoded, true
}

func readAPIMartCreateTask(payload []byte) (string, string, bool) {
	var result struct {
		Code int `json:"code"`
		Data []struct {
			Status string `json:"status"`
			TaskID string `json:"task_id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(payload, &result); err != nil {
		return "", "", false
	}
	if result.Code != 200 || len(result.Data) == 0 || strings.TrimSpace(result.Data[0].TaskID) == "" {
		return "", "", false
	}
	return strings.TrimSpace(result.Data[0].TaskID), result.Data[0].Status, true
}

func normalizeAPIMartTaskStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "submitted", "pending", "processing", "running", "queued":
		return "processing"
	case "completed", "success", "succeeded":
		return "completed"
	case "failed", "cancelled", "canceled":
		return "failed"
	default:
		if strings.TrimSpace(status) == "" {
			return "processing"
		}
		return status
	}
}

func extractAPIMartResultURL(result map[string]any, preferredKeys ...string) string {
	if result == nil {
		return ""
	}
	keys := append([]string{}, preferredKeys...)
	keys = append(keys, "url", "urls", "video_url", "videoUrl", "download_url", "downloadUrl", "output_url", "outputUrl", "images", "videos", "data", "result")
	for _, key := range keys {
		if url := collectAPIMartURL(result[key], 0); url != "" {
			return url
		}
	}
	return ""
}

func collectAPIMartURL(value any, depth int) string {
	if depth > 6 || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		text := strings.TrimSpace(typed)
		if strings.HasPrefix(text, "http://") || strings.HasPrefix(text, "https://") {
			return text
		}
		var parsed any
		if json.Unmarshal([]byte(text), &parsed) == nil {
			return collectAPIMartURL(parsed, depth+1)
		}
	case []any:
		for _, item := range typed {
			if url := collectAPIMartURL(item, depth+1); url != "" {
				return url
			}
		}
	case map[string]any:
		for _, key := range []string{"url", "urls", "image_url", "imageUrl", "video_url", "videoUrl", "download_url", "downloadUrl", "images", "videos", "data", "result"} {
			if url := collectAPIMartURL(typed[key], depth+1); url != "" {
				return url
			}
		}
	}
	return ""
}

func buildAPIMartTaskURL(channel model.ModelChannel, taskID string) string {
	return service.BuildModelChannelURL(channel, "/tasks/"+url.PathEscape(taskID)+"?language=zh")
}
