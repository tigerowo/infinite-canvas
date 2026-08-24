package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

const kieFileStreamUploadURL = "https://kieai.redpandaai.co/api/file-stream-upload"

func mergeKIEFormFiles(payload map[string]any, files map[string][]*multipart.FileHeader, channel model.ModelChannel) error {
	for key, headers := range files {
		if len(headers) == 0 {
			continue
		}

		values := make([]any, 0, len(headers))
		for _, header := range headers {
			value, err := uploadKIEReferenceFile(channel, header)
			if err != nil {
				return err
			}
			values = append(values, value)
		}
		if len(values) == 0 {
			continue
		}
		if len(values) == 1 {
			payload[key] = values[0]
			continue
		}
		payload[key] = values
	}
	return nil
}

func uploadKIEReferenceFile(channel model.ModelChannel, header *multipart.FileHeader) (string, error) {
	data, contentType, err := readKIEFormFileBytes(header)
	if err != nil {
		return "", err
	}
	if len(data) == 0 || strings.TrimSpace(channel.APIKey) == "" {
		return "", errors.New("KIE file upload failed: empty file or missing API key")
	}

	uploadPath := "images/user-uploads"
	if strings.HasPrefix(strings.ToLower(contentType), "audio/") {
		uploadPath = "audios/user-uploads"
	} else if strings.HasPrefix(strings.ToLower(contentType), "video/") {
		uploadPath = "videos/user-uploads"
	}

	var requestBody bytes.Buffer
	writer := multipart.NewWriter(&requestBody)
	filename := normalizeKIEReferenceFilename(header.Filename, contentType)
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
	_ = writer.WriteField("uploadPath", uploadPath)
	if filename != "" {
		_ = writer.WriteField("fileName", filename)
	}
	_ = writer.Close()

	request, err := http.NewRequest(http.MethodPost, kieFileStreamUploadURL, &requestBody)
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	request.Header.Set("Content-Type", writer.FormDataContentType())

	response, err := service.HTTPClientForChannel(channel).Do(request)
	if err != nil {
		log.Printf("KIE file upload failed: filename=%s err=%v", header.Filename, err)
		return "", fmt.Errorf("KIE file upload failed: %v", err)
	}
	defer response.Body.Close()

	body, readErr := readLimitedUpstreamResponse(response.Body, "KIE 文件上传", pollResponseLimit)
	if readErr != nil {
		return "", fmt.Errorf("KIE file upload failed: %w", readErr)
	}
	if response.StatusCode >= http.StatusBadRequest {
		log.Printf("KIE file upload error: filename=%s status=%d body=%s", header.Filename, response.StatusCode, strings.TrimSpace(string(body)))
		return "", fmt.Errorf("KIE file upload failed: %s", readUpstreamAIErrorMessage(body, response.StatusCode))
	}

	url := readKIEUploadedFileURL(body)
	if url == "" {
		log.Printf("KIE file upload returned no URL: filename=%s body=%s", header.Filename, strings.TrimSpace(string(body)))
		return "", errors.New("KIE file upload failed: no file URL returned")
	}
	return url, nil
}

func readKIEUploadedFileURL(body []byte) string {
	var payload struct {
		Data struct {
			FileURL     string `json:"fileUrl"`
			DownloadURL string `json:"downloadUrl"`
			URL         string `json:"url"`
		} `json:"data"`
	}
	if len(body) == 0 || json.Unmarshal(body, &payload) != nil {
		return ""
	}
	return firstNonEmpty(payload.Data.DownloadURL, payload.Data.FileURL, payload.Data.URL)
}

func normalizeKIEReferenceFilename(filename string, contentType string) string {
	filename = strings.TrimSpace(filename)
	if filename == "" {
		filename = "reference"
	}
	lowered := strings.ToLower(filename)
	if strings.Contains(lowered, ".") {
		return filename
	}

	switch strings.ToLower(strings.TrimSpace(contentType)) {
	case "image/png":
		return filename + ".png"
	case "image/jpeg":
		return filename + ".jpg"
	case "image/webp":
		return filename + ".webp"
	case "video/mp4":
		return filename + ".mp4"
	case "video/quicktime":
		return filename + ".mov"
	case "video/webm":
		return filename + ".webm"
	case "audio/mpeg":
		return filename + ".mp3"
	case "audio/wav", "audio/x-wav":
		return filename + ".wav"
	default:
		return filename
	}
}

func escapeKIEFormFilename(filename string) string {
	filename = strings.ReplaceAll(filename, "\\", "\\\\")
	return strings.ReplaceAll(filename, `"`, `\"`)
}

func readKIEFormFileBytes(header *multipart.FileHeader) ([]byte, string, error) {
	file, err := header.Open()
	if err != nil {
		return nil, "", err
	}
	defer file.Close()

	data, err := readLimitedRequestBody(file, "KIE 参考文件", adapterReferenceMaxBytes)
	if err != nil {
		return nil, "", err
	}
	if len(data) == 0 {
		return nil, "", errors.New("KIE file upload failed: empty file")
	}

	contentType := strings.TrimSpace(header.Header.Get("Content-Type"))
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = http.DetectContentType(data)
	}
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = detectKIEReferenceContentType(header.Filename)
	}
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = "image/png"
	}

	return data, contentType, nil
}

func detectKIEReferenceContentType(filename string) string {
	filename = strings.ToLower(strings.TrimSpace(filename))
	switch {
	case strings.HasSuffix(filename, ".mp4"):
		return "video/mp4"
	case strings.HasSuffix(filename, ".mov"):
		return "video/quicktime"
	case strings.HasSuffix(filename, ".webm"):
		return "video/webm"
	case strings.HasSuffix(filename, ".mp3"):
		return "audio/mpeg"
	case strings.HasSuffix(filename, ".wav"):
		return "audio/wav"
	case strings.HasSuffix(filename, ".png"):
		return "image/png"
	case strings.HasSuffix(filename, ".jpg"), strings.HasSuffix(filename, ".jpeg"):
		return "image/jpeg"
	case strings.HasSuffix(filename, ".webp"):
		return "image/webp"
	default:
		return ""
	}
}

func kieReferenceAliasKeys() []string {
	keys := append([]string{}, kieImageReferenceAliasKeys()...)
	keys = append(keys, kieVideoReferenceAliasKeys()...)
	keys = append(keys, kieAudioReferenceAliasKeys()...)
	return keys
}

func kieImageReferenceAliasKeys() []string {
	return []string{
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
		"last_frame_url",
		"end_image_url",
		"tail_image_url",
	}
}

func kieVideoReferenceAliasKeys() []string {
	return []string{
		"video",
		"videos",
		"video_url",
		"video_urls",
		"input_video_url",
		"input_video_urls",
		"video_reference",
		"video_reference[]",
		"first_clip_url",
		"reference_video",
		"reference_videos",
		"reference_video_url",
		"reference_video_urls",
	}
}

func kieAudioReferenceAliasKeys() []string {
	return []string{
		"audio",
		"audios",
		"audio_url",
		"audio_urls",
		"input_audio_url",
		"input_audio_urls",
		"reference_audio",
		"reference_audios",
		"reference_audio_url",
		"reference_audio_urls",
		"audio_reference",
		"audio_reference[]",
		"driving_audio_url",
		"reference_voice",
		"audio_ids",
	}
}

func setKIEReferenceInput(input map[string]any, modelName string, sourceKey string, value any) string {
	config := kieModelInputConfig(modelName)
	values := normalizeKIEImageReferenceValues(value)
	if len(values) == 0 {
		return sourceKey
	}

	if isKIEAudioReferenceSource(sourceKey, values) && (config.audioRefField != "" || isKIEDirectAudioReferenceField(sourceKey)) {
		return setKIEAudioReferenceInput(input, config, sourceKey, values)
	}

	if isKIEVideoReferenceSource(sourceKey, values) && (config.videoRefField != "" || isKIEDirectVideoReferenceField(sourceKey)) {
		return setKIEVideoReferenceInput(input, config, sourceKey, values)
	}
	if isKIEImageReferenceSource(sourceKey, values) && (config.imageRefField != "" || isKIEDirectImageReferenceField(sourceKey)) {
		return setKIEImageReferenceInput(input, modelName, sourceKey, values)
	}
	if config.videoRefField != "" {
		return setKIEVideoReferenceInput(input, config, sourceKey, values)
	}
	if config.audioRefField != "" {
		return setKIEAudioReferenceInput(input, config, sourceKey, values)
	}
	return sourceKey
}

func setKIEImageReferenceInput(input map[string]any, modelName string, sourceKey string, values []string) string {
	config := kieModelInputConfig(modelName)
	field := config.imageRefField
	if isKIEFirstLastFrameSource(sourceKey) {
		field = resolveKIEFrameReferenceField(modelName, config, sourceKey)
		if field == "" {
			return sourceKey
		}
	} else if directField := inferKIEImageReferenceField(sourceKey); isKIEDirectImageReferenceField(sourceKey) && directField != "" {
		if !shouldPreferKIEConfiguredImageField(config, sourceKey, directField) {
			field = directField
		}
	}
	if field == "" {
		field = inferKIEImageReferenceField(sourceKey)
	}
	if field == "" {
		return sourceKey
	}

	if len(values) == 0 {
		return sourceKey
	}

	if config.imageRefKind == "single_array" {
		input[field] = []string{values[0]}
		return field
	}

	if config.imageRefKind == "array" || isKIEImageReferenceArrayField(field) {
		input[field] = mergeKIEStringValues(input[field], values)
		return field
	}

	input[field] = values[0]
	if field == "image_url" && len(values) > 1 {
		input[kieTailImageField(modelName)] = values[1]
	}
	if field == "first_frame_url" && len(values) > 1 {
		input["last_frame_url"] = values[1]
	}
	return field
}

func shouldPreferKIEConfiguredImageField(config kieInputConfig, sourceKey string, directField string) bool {
	if config.imageRefField == "" || config.imageRefField == directField {
		return false
	}
	switch sourceKey {
	case "image", "images", "image_url", "input_url", "input_reference", "input_reference[]", "reference_image", "reference_image_url":
		return true
	default:
		return false
	}
}

func mergeKIEStringValues(existing any, values []string) []string {
	result := normalizeKIEImageReferenceValues(existing)
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

func isKIEFirstLastFrameSource(sourceKey string) bool {
	return isKIEFirstFrameSource(sourceKey) || isKIELastFrameSource(sourceKey)
}

func isKIEFirstFrameSource(sourceKey string) bool {
	return sourceKey == "first_frame_url"
}

func isKIELastFrameSource(sourceKey string) bool {
	return sourceKey == "last_frame_url"
}

func resolveKIEFrameReferenceField(modelName string, config kieInputConfig, sourceKey string) string {
	if isKIEModelNamedFrame(modelName) || config.imageRefField == "first_frame_url" {
		if isKIELastFrameSource(sourceKey) {
			return "last_frame_url"
		}
		return "first_frame_url"
	}
	if isKIEModelTailFrame(modelName) && config.imageRefField == "image_url" {
		if isKIELastFrameSource(sourceKey) {
			return kieTailImageField(modelName)
		}
		return "image_url"
	}
	return ""
}

func isKIEModelNamedFrame(modelName string) bool {
	modelName = strings.ToLower(strings.TrimSpace(modelName))
	return modelName == "bytedance/seedance-2" || modelName == "bytedance/seedance-2-fast" || modelName == "bytedance/seedance-2-mini" || modelName == "bytedance/seedance-2-5" || modelName == "wan/2-7-image-to-video"
}

func isKIEModelTailFrame(modelName string) bool {
	modelName = strings.ToLower(strings.TrimSpace(modelName))
	switch modelName {
	case "bytedance/v1-lite-image-to-video",
		"hailuo/02-image-to-video-standard",
		"hailuo/02-image-to-video-pro",
		"kling/v2-1-pro",
		"kling/v2-5-turbo-image-to-video-pro":
		return true
	default:
		return false
	}
}

func kieTailImageField(modelName string) string {
	modelName = strings.ToLower(strings.TrimSpace(modelName))
	if strings.HasPrefix(modelName, "kling/") {
		return "tail_image_url"
	}
	return "end_image_url"
}

func setKIEVideoReferenceInput(input map[string]any, config kieInputConfig, sourceKey string, values []string) string {
	field := config.videoRefField
	if directField := inferKIEVideoReferenceField(sourceKey); isKIEDirectVideoReferenceField(sourceKey) && directField != "" {
		field = directField
	}
	if field == "" {
		field = inferKIEVideoReferenceField(sourceKey)
	}
	if field == "" || len(values) == 0 {
		return sourceKey
	}

	if config.videoRefKind == "gemini_video_list" {
		input[field] = buildKIEGeminiVideoList(values)
		return field
	}
	if config.videoRefKind == "array" || isKIEVideoReferenceArrayField(field) {
		input[field] = values
		return field
	}
	input[field] = values[0]
	return field
}

func setKIEAudioReferenceInput(input map[string]any, config kieInputConfig, sourceKey string, values []string) string {
	field := config.audioRefField
	if directField := inferKIEAudioReferenceField(sourceKey); isKIEDirectAudioReferenceField(sourceKey) && directField != "" {
		field = directField
	}
	if field == "" {
		field = inferKIEAudioReferenceField(sourceKey)
	}
	if field == "" || len(values) == 0 {
		return sourceKey
	}
	if field == "audio_ids" {
		ids := make([]string, 0, len(values))
		for _, value := range values {
			trimmed := strings.TrimSpace(value)
			if strings.HasPrefix(trimmed, "audio_") {
				ids = append(ids, trimmed)
			}
		}
		if len(ids) == 0 {
			return sourceKey
		}
		input[field] = ids
		return field
	}
	if config.audioRefKind == "array" || isKIEAudioReferenceArrayField(field) {
		input[field] = values
		return field
	}
	input[field] = values[0]
	return field
}

func buildKIEGeminiVideoList(values []string) []map[string]any {
	items := make([]map[string]any, 0, len(values))
	for _, value := range values {
		items = append(items, map[string]any{
			"url":   value,
			"start": 0,
			"ends":  10,
		})
	}
	return items
}

func isKIEImageReferenceArrayField(field string) bool {
	return field == "image_urls" || field == "input_urls" || field == "image_input" || field == "reference_image_urls"
}

func isKIEVideoReferenceArrayField(field string) bool {
	return field == "video_urls" || field == "input_video_urls" || field == "reference_video" || field == "reference_videos" || field == "reference_video_urls"
}

func isKIEAudioReferenceArrayField(field string) bool {
	return field == "audio_urls" || field == "input_audio_urls" || field == "reference_audio" || field == "reference_audios" || field == "reference_audio_urls" || field == "audio_ids"
}

func inferKIEImageReferenceField(sourceKey string) string {
	switch sourceKey {
	case "image_urls", "images":
		return "image_urls"
	case "input_urls", "input_reference", "input_reference[]":
		return "input_urls"
	case "image_input":
		return "image_input"
	case "reference_image", "reference_images":
		return "reference_image"
	case "reference_image_url", "reference_image_urls":
		return "reference_image_urls"
	case "first_frame_url":
		return "first_frame_url"
	case "last_frame_url":
		return "last_frame_url"
	case "end_image_url":
		return "end_image_url"
	case "tail_image_url":
		return "tail_image_url"
	case "image", "image_url", "input_url":
		return "image_url"
	default:
		return ""
	}
}

func inferKIEVideoReferenceField(sourceKey string) string {
	switch sourceKey {
	case "video_urls", "videos", "input_video_urls", "video_reference", "video_reference[]":
		return "video_urls"
	case "reference_video", "reference_videos":
		return "reference_video"
	case "reference_video_urls":
		return "reference_video_urls"
	case "first_clip_url":
		return "first_clip_url"
	case "video", "video_url", "input_video_url", "reference_video_url":
		return "video_url"
	case "input_reference", "input_reference[]":
		return "video_urls"
	default:
		return ""
	}
}

func inferKIEAudioReferenceField(sourceKey string) string {
	switch sourceKey {
	case "audio_urls", "audios", "input_audio_urls":
		return "audio_urls"
	case "reference_audio", "reference_audios":
		return "reference_audio"
	case "reference_audio_urls", "audio_reference", "audio_reference[]":
		return "reference_audio_urls"
	case "driving_audio_url":
		return "driving_audio_url"
	case "reference_voice":
		return "reference_voice"
	case "audio_ids":
		return "audio_ids"
	case "audio", "audio_url", "input_audio_url", "reference_audio_url":
		return "audio_url"
	default:
		return ""
	}
}

func isKIEDirectImageReferenceField(sourceKey string) bool {
	switch sourceKey {
	case "image_url", "image_urls", "input_url", "input_urls", "image_input", "reference_image", "reference_images", "reference_image_url", "reference_image_urls", "first_frame_url", "last_frame_url", "end_image_url", "tail_image_url":
		return true
	default:
		return false
	}
}

func isKIEDirectVideoReferenceField(sourceKey string) bool {
	switch sourceKey {
	case "video_url", "video_urls", "input_video_url", "input_video_urls", "first_clip_url", "reference_video", "reference_videos", "reference_video_url", "reference_video_urls":
		return true
	default:
		return false
	}
}

func isKIEDirectAudioReferenceField(sourceKey string) bool {
	switch sourceKey {
	case "audio_url", "audio_urls", "input_audio_url", "input_audio_urls", "reference_audio", "reference_audios", "reference_audio_url", "reference_audio_urls", "audio_reference", "audio_reference[]", "driving_audio_url", "reference_voice", "audio_ids":
		return true
	default:
		return false
	}
}

func isKIEVideoReferenceSource(sourceKey string, values []string) bool {
	for _, key := range kieVideoReferenceAliasKeys() {
		if sourceKey == key {
			return true
		}
	}
	for _, value := range values {
		lowered := strings.ToLower(strings.TrimSpace(value))
		if strings.HasPrefix(lowered, "data:video/") || strings.HasSuffix(lowered, ".mp4") || strings.HasSuffix(lowered, ".mov") || strings.HasSuffix(lowered, ".webm") {
			return true
		}
	}
	return false
}

func isKIEImageReferenceSource(sourceKey string, values []string) bool {
	for _, key := range kieImageReferenceAliasKeys() {
		if sourceKey == key {
			return true
		}
	}
	for _, value := range values {
		lowered := strings.ToLower(strings.TrimSpace(value))
		if strings.HasPrefix(lowered, "data:image/") || strings.HasSuffix(lowered, ".png") || strings.HasSuffix(lowered, ".jpg") || strings.HasSuffix(lowered, ".jpeg") || strings.HasSuffix(lowered, ".webp") {
			return true
		}
	}
	return false
}

func isKIEAudioReferenceSource(sourceKey string, values []string) bool {
	for _, key := range kieAudioReferenceAliasKeys() {
		if sourceKey == key {
			return true
		}
	}
	for _, value := range values {
		lowered := strings.ToLower(strings.TrimSpace(value))
		if strings.HasPrefix(lowered, "data:audio/") || strings.HasSuffix(lowered, ".mp3") || strings.HasSuffix(lowered, ".wav") || strings.HasSuffix(lowered, ".m4a") {
			return true
		}
	}
	return false
}

func normalizeKIEImageReferenceValues(value any) []string {
	var result []string
	switch typed := value.(type) {
	case string:
		if trimmed := strings.TrimSpace(typed); trimmed != "" {
			result = append(result, trimmed)
		}
	case []string:
		for _, item := range typed {
			if trimmed := strings.TrimSpace(item); trimmed != "" {
				result = append(result, trimmed)
			}
		}
	case []any:
		for _, item := range typed {
			result = append(result, normalizeKIEImageReferenceValues(item)...)
		}
	default:
		if text := strings.TrimSpace(toStringSafe(value)); text != "" {
			result = append(result, text)
		}
	}
	return result
}

func clearKIEReferenceAliases(input map[string]any, keep string) {
	for _, key := range kieReferenceAliasKeys() {
		if key != keep {
			delete(input, key)
		}
	}
}

func normalizeKIEAspectValue(value string, aspectKind string) string {
	if aspectKind == "image_size_named" {
		return normalizeKIEImageSizeName(value)
	}
	return normalizeKIEAspectRatio(value)
}

func normalizeKIEImageSizeName(value string) string {
	ratio := normalizeKIEAspectRatio(value)
	switch ratio {
	case "", "auto":
		return ratio
	case "1:1", "square", "square_hd":
		return "square_hd"
	case "16:9":
		return "landscape_16_9"
	case "9:16":
		return "portrait_16_9"
	case "4:3":
		return "landscape_4_3"
	case "3:4":
		return "portrait_4_3"
	default:
		return ratio
	}
}

func normalizeKIEAspectPair(value string) (string, bool) {
	var parts []string
	switch {
	case strings.Contains(value, "x"):
		parts = strings.Split(value, "x")
	case strings.Contains(value, "*"):
		parts = strings.Split(value, "*")
	case strings.Contains(value, ":"):
		parts = strings.Split(value, ":")
	default:
		return "", false
	}

	if len(parts) != 2 {
		return "", false
	}

	width, err := strconv.Atoi(parts[0])
	if err != nil || width <= 0 {
		return "", false
	}
	height, err := strconv.Atoi(parts[1])
	if err != nil || height <= 0 {
		return "", false
	}

	if ratio, ok := nearestKIEAspectRatio(width, height); ok {
		return ratio, true
	}

	divisor := gcdInt(width, height)
	return strconv.Itoa(width/divisor) + ":" + strconv.Itoa(height/divisor), true
}

func nearestKIEAspectRatio(width, height int) (string, bool) {
	value := float64(width) / float64(height)
	options := []struct {
		name  string
		ratio float64
	}{
		{"1:1", 1.0},
		{"1:4", 1.0 / 4.0},
		{"16:9", 16.0 / 9.0},
		{"1:8", 1.0 / 8.0},
		{"21:9", 21.0 / 9.0},
		{"2:3", 2.0 / 3.0},
		{"3:2", 3.0 / 2.0},
		{"3:4", 3.0 / 4.0},
		{"4:1", 4.0},
		{"4:3", 4.0 / 3.0},
		{"4:5", 4.0 / 5.0},
		{"5:4", 5.0 / 4.0},
		{"8:1", 8.0},
		{"9:16", 9.0 / 16.0},
	}

	bestName := ""
	bestDiff := math.MaxFloat64
	for _, option := range options {
		diff := math.Abs(value-option.ratio) / option.ratio
		if diff < bestDiff {
			bestDiff = diff
			bestName = option.name
		}
	}

	if bestDiff <= 0.04 {
		return bestName, true
	}
	return "", false
}

func gcdInt(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	if a < 0 {
		return -a
	}
	return a
}

func setKIEResolutionInput(input map[string]any, modelName string, value any) {
	config := kieModelInputConfig(modelName)
	field := kieResolutionField(config)
	if field == "" {
		delete(input, "resolution")
		delete(input, "image_resolution")
		return
	}

	normalized := normalizeKIEResolutionValue(toStringSafe(value), config.resolutionKind)
	if config.maxResolution == "2K" && normalized == "4K" {
		normalized = "2K"
	}
	if field == "image_resolution" {
		delete(input, "resolution")
		input["image_resolution"] = normalized
		return
	}

	delete(input, "image_resolution")
	input["resolution"] = normalized
}

func setKIEQualityResolutionInput(input map[string]any, modelName string, value any) {
	config := kieModelInputConfig(modelName)
	if config.hasQuality || config.resolutionKind != "image" || kieResolutionField(config) == "" {
		return
	}
	if _, exists := input["resolution"]; exists {
		return
	}
	if _, exists := input["image_resolution"]; exists {
		return
	}
	resolution := normalizeKIEQualityResolution(toStringSafe(value))
	if resolution == "" {
		return
	}
	setKIEResolutionInput(input, modelName, resolution)
}

func setKIESizeResolutionInput(input map[string]any, modelName string, value any) {
	config := kieModelInputConfig(modelName)
	if config.resolutionKind != "image" || kieResolutionField(config) == "" {
		return
	}
	if _, exists := input["resolution"]; exists {
		return
	}
	if _, exists := input["image_resolution"]; exists {
		return
	}
	resolution := normalizeKIESizeResolution(toStringSafe(value))
	if resolution == "" {
		return
	}
	setKIEResolutionInput(input, modelName, resolution)
}

func kieResolutionField(config kieInputConfig) string {
	if config.resolutionField != "" {
		return config.resolutionField
	}
	if config.hasResolution {
		return "resolution"
	}
	return ""
}

func normalizeKIEResolutionValue(value string, resolutionKind string) string {
	if resolutionKind == "hailuo_video" {
		return normalizeKIEHailuoVideoResolution(value)
	}
	if resolutionKind == "minimax_h3_video" {
		return normalizeKIEMiniMaxH3VideoResolution(value)
	}
	if resolutionKind == "seedance_2_5_video" {
		return normalizeKIESeedance25VideoResolution(value)
	}
	if resolutionKind == "image" {
		return normalizeKIEImageResolution(value)
	}
	return normalizeKIEResolution(value)
}

func normalizeKIEQualityResolution(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low", "standard", "1k":
		return "1K"
	case "medium", "hd", "2k":
		return "2K"
	case "high", "4k":
		return "4K"
	default:
		return ""
	}
}

func normalizeKIESizeResolution(value string) string {
	value = strings.ReplaceAll(strings.TrimSpace(strings.ToLower(value)), " ", "")
	parts := strings.Split(value, "x")
	if len(parts) != 2 {
		return ""
	}
	width, err := strconv.Atoi(parts[0])
	if err != nil || width <= 0 {
		return ""
	}
	height, err := strconv.Atoi(parts[1])
	if err != nil || height <= 0 {
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

func normalizeKIEImageResolution(value string) string {
	value = strings.ReplaceAll(strings.TrimSpace(value), " ", "")
	lowered := strings.ToLower(value)

	switch lowered {
	case "":
		return ""
	case "1", "1k", "1024", "1024p":
		return "1K"
	case "2", "2k", "2048", "2048p":
		return "2K"
	case "4", "4k", "4096", "4096p":
		return "4K"
	default:
		if strings.HasSuffix(lowered, "k") {
			return strings.ToUpper(lowered)
		}
		return value
	}
}

func normalizeKIEOutputFormat(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "jpeg", "jpg":
		return "jpg"
	case "png":
		return "png"
	case "webp":
		return "png"
	default:
		return value
	}
}

func setKIECountInput(input map[string]any, modelName string, value any) {
	config := kieModelInputConfig(modelName)
	if config.countField == "" {
		delete(input, "n")
		delete(input, "num_images")
		delete(input, "max_images")
		return
	}

	normalized := normalizeKIECountValue(value, config.countKind)
	delete(input, "n")
	delete(input, "num_images")
	delete(input, "max_images")
	input[config.countField] = normalized
}

func normalizeKIECountValue(value any, countKind string) any {
	if countKind == "string" {
		return strings.TrimSuffix(strings.TrimSuffix(toStringSafe(value), ".0"), ".")
	}

	switch typed := value.(type) {
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		if err == nil {
			return parsed
		}
		return typed
	case float64:
		return int(typed)
	case float32:
		return int(typed)
	default:
		return value
	}
}

func isKIEImageEndpoint(endpoint string) bool {
	return endpoint == "/images/generations" || endpoint == "/images/edits"
}

func copyKIECreateImageResponse(w http.ResponseWriter, request *http.Request, payload []byte, statusCode int, channel model.ModelChannel, logContext aiLogContext, onFailure func()) bool {
	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			TaskID string `json:"taskId"`
		} `json:"data"`
	}

	if err := json.Unmarshal(payload, &result); err != nil {
		return false
	}
	if result.Code != 200 || strings.TrimSpace(result.Data.TaskID) == "" {
		return false
	}

	imageURLs, errorMessage, responseBody := pollKIEImageTask(request, channel, result.Data.TaskID)
	if errorMessage != "" {
		if onFailure != nil {
			onFailure()
		}
		writeKIEImageError(w, statusCode, errorMessage, logContext, responseBody)
		return true
	}

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
		if onFailure != nil {
			onFailure()
		}
		writeKIEImageError(w, statusCode, err.Error(), logContext)
		return true
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_, _ = w.Write(encoded)
	saveAIProxyLog(logContext, statusCode, string(encoded), "")
	return true
}

func pollKIEImageTask(request *http.Request, channel model.ModelChannel, taskID string) ([]string, string, string) {
	budget := newUpstreamResponseBudget(request.Context(), "KIE 图片任务轮询", pollRequestLimit, pollResponseTotalLimit, pollDeadline)
	defer budget.Close()
	pollURL := service.BuildModelChannelURL(channel, "/jobs/recordInfo?taskId="+url.QueryEscape(taskID))
	for attempt := 0; attempt < 300; attempt++ {
		if attempt > 0 {
			select {
			case <-budget.Context().Done():
				return nil, "KIE 图片任务轮询超过总体 deadline", ""
			case <-time.After(2 * time.Second):
			}
		}
		if err := budget.NextRequest(); err != nil {
			return nil, err.Error(), ""
		}

		pollRequest, err := http.NewRequestWithContext(budget.Context(), http.MethodGet, pollURL, nil)
		if err != nil {
			return nil, err.Error(), ""
		}
		pollRequest.Header.Set("Authorization", "Bearer "+channel.APIKey)

		response, err := service.HTTPClientForChannel(channel).Do(pollRequest)
		if err != nil {
			return nil, err.Error(), ""
		}
		body, readErr := budget.ReadAll(response.Body, pollResponseLimit)
		_ = response.Body.Close()
		if readErr != nil {
			return nil, readErr.Error(), ""
		}
		if response.StatusCode >= http.StatusBadRequest {
			return nil, readUpstreamAIErrorMessage(body, response.StatusCode), string(body)
		}

		imageURLs, done, errorMessage := readKIEImageTaskResult(body)
		if errorMessage != "" {
			return nil, errorMessage, string(body)
		}
		if done {
			if len(imageURLs) == 0 {
				return nil, "KIE image task completed but returned no image URL", string(body)
			}
			return imageURLs, "", ""
		}
	}

	return nil, "KIE image task timed out", ""
}

func readKIEImageTaskResult(payload []byte) ([]string, bool, string) {
	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			State      string `json:"state"`
			ResultJSON any    `json:"resultJson"`
			FailCode   string `json:"failCode"`
			FailMsg    string `json:"failMsg"`
		} `json:"data"`
	}

	if err := json.Unmarshal(payload, &result); err != nil {
		return nil, false, err.Error()
	}
	if result.Code != 0 && result.Code != 200 {
		return nil, false, strings.TrimSpace(result.Msg)
	}

	imageURLs := extractKIEImageURLs(result.Data.ResultJSON)
	if len(imageURLs) > 0 {
		return imageURLs, true, ""
	}

	switch strings.ToLower(strings.TrimSpace(result.Data.State)) {
	case "success", "succeeded", "completed":
		return imageURLs, true, ""
	case "fail", "failed", "cancelled":
		return nil, false, firstNonEmpty(result.Data.FailMsg, result.Data.FailCode, result.Msg, "KIE image task failed")
	default:
		return nil, false, ""
	}
}

func extractKIEImageURLs(result any) []string {
	values := collectKIEImageURLs(result, 0)
	seen := map[string]bool{}
	urls := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		urls = append(urls, value)
	}
	return urls
}

func collectKIEImageURLs(value any, depth int) []string {
	if depth > 6 || value == nil {
		return nil
	}

	switch typed := value.(type) {
	case string:
		trimmed := strings.TrimSpace(typed)
		if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
			var parsed any
			if json.Unmarshal([]byte(trimmed), &parsed) == nil {
				return collectKIEImageURLs(parsed, depth+1)
			}
		}
		if isKIEOutputURL(trimmed) {
			return []string{trimmed}
		}
	case []any:
		var urls []string
		for _, item := range typed {
			urls = append(urls, collectKIEImageURLs(item, depth+1)...)
		}
		return urls
	case map[string]any:
		keys := []string{"resultUrls", "result_urls", "imageUrls", "image_urls", "urls", "images", "data", "url", "imageUrl", "image_url", "downloadUrl", "download_url"}
		var urls []string
		for _, key := range keys {
			urls = append(urls, collectKIEImageURLs(typed[key], depth+1)...)
		}
		return urls
	}

	return nil
}

func isKIEOutputURL(value string) bool {
	return strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "data:image/")
}

func writeKIEImageError(w http.ResponseWriter, statusCode int, message string, logContext aiLogContext, responseBody ...string) {
	payload := map[string]any{
		"code": 500,
		"msg":  message,
		"data": nil,
	}
	encoded, _ := json.Marshal(payload)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_, _ = w.Write(encoded)
	logBody := string(encoded)
	if len(responseBody) > 0 && strings.TrimSpace(responseBody[0]) != "" {
		logBody = responseBody[0]
	}
	saveAIProxyLog(logContext, statusCode, logBody, message)
}
