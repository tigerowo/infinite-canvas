package service

import (
	"crypto/rand"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/url"
	"strconv"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
)

type WorkflowRef struct {
	Scope      string `json:"scope"`
	ChannelID  string `json:"channelId"`
	Kind       string `json:"kind"`
	WorkflowID string `json:"workflowId"`
}

type WorkflowRunInput struct {
	Ref                   WorkflowRef       `json:"ref"`
	ExpectedCapability    string            `json:"expectedCapability"`
	Prompt                string            `json:"prompt"`
	SystemPrompt          string            `json:"systemPrompt"`
	FieldValues           map[string]any    `json:"fieldValues"`
	ReferenceImages       []string          `json:"referenceImages"`
	ReferenceVideos       []string          `json:"referenceVideos"`
	ReferenceAudios       []string          `json:"referenceAudios"`
	Mask                  string            `json:"mask"`
	Size                  string            `json:"size"`
	Quality               string            `json:"quality"`
	TransparentBackground bool              `json:"transparentBackground"`
	Count                 int               `json:"count"`
	VideoSeconds          string            `json:"videoSeconds"`
	VideoQuality          string            `json:"videoQuality"`
	VideoGenerateAudio    bool              `json:"videoGenerateAudio"`
	VideoWatermark        bool              `json:"videoWatermark"`
	AudioVoice            string            `json:"audioVoice"`
	AudioFormat           string            `json:"audioFormat"`
	AudioSpeed            float64           `json:"audioSpeed"`
	AudioInstructions     string            `json:"audioInstructions"`
	Source                string            `json:"source"`
	SourceID              string            `json:"sourceId"`
	NodeID                string            `json:"nodeId"`
	ClientTaskID          string            `json:"clientTaskId"`
	MediaSlotModes        map[string]string `json:"mediaSlotModes"`
}

type WorkflowOverride struct {
	NodeID    string `json:"nodeId"`
	FieldName string `json:"fieldName"`
	Value     any    `json:"value"`
}

func ResolveWorkflowFields(entry model.WorkflowEntry, input WorkflowRunInput) ([]WorkflowOverride, error) {
	result := make([]WorkflowOverride, 0, len(entry.Fields))
	seen := map[string]bool{}
	mappedMedia := map[string]bool{}
	for _, field := range entry.Fields {
		if field.Enabled != nil && !*field.Enabled || field.SafeToOverride != nil && !*field.SafeToOverride {
			continue
		}
		if entry.Provider == "runninghub" {
			classType := field.ClassType
			if node, ok := entry.WorkflowJSON[field.NodeID].(map[string]any); ok {
				if current, ok := node["class_type"].(string); ok {
					classType = current
				}
			}
			if !managementWorkflowFieldSafeToOverride(classType, field.FieldName) {
				continue
			}
		}
		identity := strings.TrimSpace(field.NodeID) + "::" + strings.TrimSpace(field.FieldName)
		if strings.TrimSpace(field.NodeID) == "" || strings.TrimSpace(field.FieldName) == "" || seen[identity] {
			return nil, fmt.Errorf("工作流字段身份无效或重复：%s", identity)
		}
		seen[identity] = true
		if len(entry.WorkflowJSON) > 0 {
			node, ok := entry.WorkflowJSON[field.NodeID].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("工作流缺少节点 %s", field.NodeID)
			}
			inputs, ok := node["inputs"].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("工作流节点 %s 没有 inputs", field.NodeID)
			}
			original, ok := inputs[field.FieldName]
			if !ok {
				return nil, fmt.Errorf("工作流缺少输入 %s.%s", field.NodeID, field.FieldName)
			}
			if isWorkflowLinkValue(original) {
				continue
			}
		}
		value, present, err := workflowFieldValue(field, input, entry.Capability)
		if err != nil {
			return nil, fmt.Errorf("字段 %s：%w", identity, err)
		}
		if !present {
			if field.Required {
				return nil, fmt.Errorf("必填字段 %s 缺少值", identity)
			}
			continue
		}
		if media, ok := value.(map[string]any); ok {
			mediaID, _ := media["mediaId"].(string)
			raw, err := workflowMediaSource(input, mediaID)
			if err != nil {
				return nil, err
			}
			if err := validateWorkflowMedia(raw, mediaID); err != nil {
				return nil, err
			}
			mappedMedia[mediaID] = true
		}
		value, err = validateWorkflowFieldValue(field, value)
		if err != nil {
			return nil, fmt.Errorf("字段 %s：%w", identity, err)
		}
		result = append(result, WorkflowOverride{NodeID: field.NodeID, FieldName: field.FieldName, Value: value})
	}
	for kind, items := range map[string][]string{"image": input.ReferenceImages, "video": input.ReferenceVideos, "audio": input.ReferenceAudios} {
		for index, item := range items {
			if strings.TrimSpace(item) != "" && !mappedMedia[fmt.Sprintf("%s:%d", kind, index)] {
				return nil, fmt.Errorf("第 %d 个%s素材没有对应的工作流字段映射", index+1, kind)
			}
		}
	}
	if input.Mask != "" && !mappedMedia["mask"] {
		return nil, errors.New("蒙版没有对应的工作流字段映射")
	}
	return result, nil
}

func validateWorkflowMedia(raw, mediaID string) error {
	if strings.HasPrefix(raw, "data:") {
		kind := strings.Split(mediaID, ":")[0]
		if mediaID == "mask" {
			kind = "image"
		}
		if !strings.HasPrefix(raw, "data:"+kind+"/") || !strings.Contains(raw[:min(len(raw), 160)], ";base64,") {
			return fmt.Errorf("%s 素材类型或编码不匹配", mediaID)
		}
		if len(raw) > 86<<20 {
			return fmt.Errorf("%s 素材超过 64MB", mediaID)
		}
		return nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
		return fmt.Errorf("%s 只接受 data URL 或公开 HTTPS 地址", mediaID)
	}
	return nil
}

func workflowFieldValue(field model.WorkflowFieldMapping, input WorkflowRunInput, capability string) (any, bool, error) {
	source := strings.TrimSpace(field.Source)
	if source == "" && field.BindPrompt {
		source = "prompt"
	}
	if source == "" && field.SourceFromUpstream {
		switch strings.ToLower(strings.TrimSpace(field.FieldType)) {
		case "image", "img", "photo", "picture":
			source = "referenceImage"
		case "video", "movie":
			source = "referenceVideo"
		case "audio", "sound", "music", "voice":
			source = "referenceAudio"
		default:
			if name := strings.ToLower(strings.TrimSpace(field.FieldName)); name == "prompt" || name == "text" || name == "positive_prompt" || name == "positiveprompt" {
				source = "prompt"
			}
		}
	}
	mediaSource := source == "referenceImage" || source == "referenceVideo" || source == "referenceAudio" || source == "mask"
	if input.FieldValues != nil && !mediaSource && !field.RandomEnabled {
		if value, ok := input.FieldValues["field:"+field.NodeID+":"+field.FieldName]; ok {
			return value, !workflowValueEmpty(value), nil
		}
		if source != "" {
			if value, ok := input.FieldValues["source:"+source]; ok {
				return value, !workflowValueEmpty(value), nil
			}
		}
	}
	var value any
	switch source {
	case "":
		value = firstWorkflowValue(field.FieldValue, field.Value, field.DefaultValue, field.Default)
		if field.RandomEnabled {
			maxLimit := float64(0)
			if isManagementSeedField(field.FieldName) {
				maxLimit = 1<<32 - 1
			}
			generated, err := randomWorkflowNumber(field, maxLimit)
			if err != nil {
				return nil, false, err
			}
			value = generated
		}
	case "prompt":
		value = input.Prompt
	case "systemPrompt":
		value = input.SystemPrompt
	case "referenceImage", "referenceVideo", "referenceAudio", "mask":
		index := field.SourceIndex
		if source == "referenceImage" && field.ImageOrder > 0 {
			index = field.ImageOrder - 1
		}
		if source == "mask" {
			if input.Mask != "" {
				value = map[string]any{"mediaId": "mask"}
			}
		} else {
			var refs []string
			prefix := "image"
			switch source {
			case "referenceImage":
				refs = input.ReferenceImages
			case "referenceVideo":
				refs, prefix = input.ReferenceVideos, "video"
			case "referenceAudio":
				refs, prefix = input.ReferenceAudios, "audio"
			}
			if index >= 0 && index < len(refs) && strings.TrimSpace(refs[index]) != "" {
				value = map[string]any{"mediaId": fmt.Sprintf("%s:%d", prefix, index)}
			}
		}
	case "size":
		value = input.Size
	case "resolution":
		if capability == "video" {
			value = workflowVideoFieldValue(field, input.VideoQuality, normalizeWorkflowResolutionToken)
		} else {
			value = input.Size
		}
	case "aspectRatio":
		value = workflowAspectRatioValue(field, input.Size)
	case "width", "height":
		index := 0
		if source == "height" {
			index = 1
		}
		value = workflowDimensionPart(capability, input.Size, input.VideoQuality, index)
	case "count":
		value = input.Count
	case "quality":
		value = input.Quality
	case "transparentBackground":
		value = input.TransparentBackground
	case "videoSeconds":
		value = workflowVideoFieldValue(field, input.VideoSeconds, normalizeWorkflowDurationToken)
	case "vquality":
		value = workflowVideoFieldValue(field, input.VideoQuality, normalizeWorkflowResolutionToken)
	case "videoGenerateAudio":
		value = input.VideoGenerateAudio
	case "videoWatermark":
		value = input.VideoWatermark
	case "audioVoice":
		value = input.AudioVoice
	case "audioFormat":
		value = input.AudioFormat
	case "audioSpeed":
		value = input.AudioSpeed
	case "audioInstructions":
		value = input.AudioInstructions
	default:
		return nil, false, fmt.Errorf("不支持的来源 %q", source)
	}
	return value, !workflowValueEmpty(value), nil
}

func workflowValueEmpty(value any) bool {
	if value == nil {
		return true
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text) == ""
	}
	return false
}

func firstWorkflowValue(values ...any) any {
	for _, value := range values {
		if !workflowValueEmpty(value) {
			return value
		}
	}
	return nil
}

func randomWorkflowNumber(field model.WorkflowFieldMapping, maxLimit float64) (any, error) {
	const defaultMax = float64(9007199254740991)
	minimum, hasMinimum := workflowFieldBound(field.Min, field.Options, "min", "minValue", "min_value")
	maximum, hasMaximum := workflowFieldBound(field.Max, field.Options, "max", "maxValue", "max_value")
	step, hasStep := workflowFieldBound(field.Step, field.Options, "step", "stepValue", "step_value")
	if !hasMinimum {
		minimum = 0
	}
	if !hasMaximum {
		maximum = defaultMax
	}
	if maxLimit > 0 && maximum > maxLimit {
		maximum = maxLimit
	}
	if maximum < minimum {
		return nil, errors.New("工作流随机值最大值不能小于最小值")
	}
	if math.IsNaN(minimum) || math.IsInf(minimum, 0) || math.Trunc(minimum) != minimum || minimum < float64(math.MinInt64) || minimum >= float64(math.MaxInt64) ||
		math.IsNaN(maximum) || math.IsInf(maximum, 0) || math.Trunc(maximum) != maximum || maximum < float64(math.MinInt64) || maximum >= float64(math.MaxInt64) {
		return nil, errors.New("工作流随机值范围不是有效整数")
	}
	stepInteger := int64(1)
	if hasStep {
		if math.IsNaN(step) || math.IsInf(step, 0) || math.Trunc(step) != step || step <= 0 || step >= float64(math.MaxInt64) {
			return nil, errors.New("工作流随机值步长不是有效整数")
		}
		stepInteger = int64(step)
	}
	minimumInteger := int64(minimum)
	maximumInteger := int64(maximum)
	rangeSize := new(big.Int).Sub(big.NewInt(maximumInteger), big.NewInt(minimumInteger))
	rangeSize.Div(rangeSize, big.NewInt(stepInteger))
	rangeSize.Add(rangeSize, big.NewInt(1))
	offset, err := rand.Int(rand.Reader, rangeSize)
	if err != nil {
		return nil, fmt.Errorf("生成工作流随机值失败：%w", err)
	}
	return offset.Mul(offset, big.NewInt(stepInteger)).Add(offset, big.NewInt(minimumInteger)).Int64(), nil
}

func workflowDimensionPart(mode string, size string, videoQuality string, index int) string {
	if index < 0 || index > 1 {
		return ""
	}
	if dimensions, ok := workflowPixelDimensions(size); ok {
		return strconv.Itoa(dimensions[index])
	}
	if strings.EqualFold(strings.TrimSpace(mode), "video") {
		dimensions, ok := workflowVideoDimensions(size, videoQuality)
		if !ok {
			return ""
		}
		return strconv.Itoa(dimensions[index])
	}
	dimensions, ok := workflowImageDimensions(size)
	if !ok {
		return ""
	}
	return strconv.Itoa(dimensions[index])
}

func workflowPixelDimensions(value string) ([2]int, bool) {
	var result [2]int
	normalized := strings.ToLower(strings.TrimSpace(value))
	if !strings.Contains(normalized, "x") {
		return result, false
	}
	parts := strings.FieldsFunc(normalized, func(r rune) bool { return r == 'x' || r == ' ' || r == ',' })
	if len(parts) != 2 {
		return result, false
	}
	for index, part := range parts {
		parsed, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || parsed <= 0 {
			return result, false
		}
		result[index] = parsed
	}
	return result, true
}

func workflowAspectRatio(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	// RunningHub 的 ResolutionSelector 选项带有展示文案（例如
	// "9:16 (Portrait Widescreen)"），协议比较只需要比例前缀。
	if cut := strings.IndexAny(normalized, " ("); cut >= 0 {
		normalized = strings.TrimSpace(normalized[:cut])
	}
	for _, suffix := range []string{"-1k", "-2k", "-4k"} {
		if strings.HasSuffix(normalized, suffix) {
			normalized = strings.TrimSuffix(normalized, suffix)
			break
		}
	}
	if width, height, ok := workflowRatioParts(normalized); ok {
		divisor := workflowGreatestCommonDivisor(width, height)
		return fmt.Sprintf("%d:%d", width/divisor, height/divisor)
	}
	dimensions, ok := workflowPixelDimensions(normalized)
	if !ok {
		return ""
	}
	ratio := float64(dimensions[0]) / float64(dimensions[1])
	known := [][2]int{{1, 1}, {3, 2}, {2, 3}, {4, 3}, {3, 4}, {4, 5}, {5, 4}, {16, 9}, {9, 16}, {2, 1}, {1, 2}, {21, 9}}
	bestDifference := math.MaxFloat64
	best := [2]int{}
	for _, candidate := range known {
		expected := float64(candidate[0]) / float64(candidate[1])
		difference := math.Abs(ratio-expected) / expected
		if difference < bestDifference {
			bestDifference = difference
			best = candidate
		}
	}
	if bestDifference <= 0.03 {
		return fmt.Sprintf("%d:%d", best[0], best[1])
	}
	divisor := workflowGreatestCommonDivisor(dimensions[0], dimensions[1])
	return fmt.Sprintf("%d:%d", dimensions[0]/divisor, dimensions[1]/divisor)
}

func workflowAspectRatioValue(field model.WorkflowFieldMapping, value string) string {
	raw := strings.TrimSpace(value)
	if options := workflowFieldAllowedOptions(field); len(options) > 0 {
		requested := workflowAspectRatio(raw)
		for _, option := range options {
			candidate := strings.TrimSpace(workflowOptionString(option))
			if candidate != "" && strings.EqualFold(workflowAspectRatio(candidate), requested) {
				return candidate
			}
		}
		if fallback := workflowFieldConfiguredDefault(field); fallback != "" {
			return fallback
		}
		return raw
	}
	// “auto/adaptive” 是工作流的真实模式，不应被画布当前像素尺寸反推成
	// 一个并不存在的比例；宽高字段仍按工作流自身的默认值或显式尺寸处理。
	if fallback := strings.TrimSpace(workflowFieldConfiguredDefault(field)); strings.EqualFold(fallback, "auto") || strings.EqualFold(fallback, "adaptive") {
		return fallback
	}
	return workflowAspectRatio(raw)
}

func workflowFieldAllowedOptions(field model.WorkflowFieldMapping) []interface{} {
	classType := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(field.ClassType), "_", ""), "-", ""))
	fieldName := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(field.FieldName), "_", ""), "-", ""))
	if classType == "resolutionselector" && fieldName == "aspectratio" {
		// RunningHub 的工作流 API 不返回 object_info；ResolutionSelector 的完整枚举
		// 是节点协议的一部分，通用比例预设（9:16 等）不能直接提交给该节点。
		return []interface{}{
			"1:1 (Square)",
			"2:3 (Portrait Photo)",
			"3:2 (Photo)",
			"3:4 (Portrait Standard)",
			"4:3 (Standard)",
			"9:16 (Portrait Widescreen)",
			"16:9 (Widescreen)",
			"21:9 (Ultrawide)",
		}
	}
	return field.Options
}

func workflowRatioParts(value string) (int, int, bool) {
	parts := strings.Split(strings.TrimSpace(value), ":")
	if len(parts) != 2 {
		return 0, 0, false
	}
	width, widthErr := strconv.Atoi(strings.TrimSpace(parts[0]))
	height, heightErr := strconv.Atoi(strings.TrimSpace(parts[1]))
	return width, height, widthErr == nil && heightErr == nil && width > 0 && height > 0
}

func workflowGreatestCommonDivisor(left int, right int) int {
	for right != 0 {
		left, right = right, left%right
	}
	if left <= 0 {
		return 1
	}
	return left
}

func workflowImageDimensions(value string) ([2]int, bool) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	preset := map[string][2]int{
		"1:1": {1024, 1024}, "3:2": {1536, 1024}, "2:3": {1024, 1536},
		"4:3": {1360, 1024}, "3:4": {1024, 1360}, "4:5": {1024, 1280}, "5:4": {1280, 1024},
		"16:9": {1824, 1024}, "9:16": {1024, 1824}, "2:1": {2048, 1024}, "1:2": {1024, 2048},
		"21:9": {2352, 1008}, "1:1-2k": {2048, 2048}, "16:9-2k": {2048, 1152},
		"9:16-2k": {1152, 2048}, "16:9-4k": {3840, 2160}, "9:16-4k": {2160, 3840},
	}
	if dimensions, ok := preset[normalized]; ok {
		return dimensions, true
	}
	ratio := workflowAspectRatio(normalized)
	widthRatio, heightRatio, ok := workflowRatioParts(ratio)
	if !ok {
		return [2]int{}, false
	}
	tier := "1k"
	if strings.HasSuffix(normalized, "-2k") {
		tier = "2k"
	} else if strings.HasSuffix(normalized, "-4k") {
		tier = "4k"
	}
	if tier == "1k" {
		if widthRatio >= heightRatio {
			return [2]int{workflowRoundToStep(1024*float64(widthRatio)/float64(heightRatio), 16), 1024}, true
		}
		return [2]int{1024, workflowRoundToStep(1024*float64(heightRatio)/float64(widthRatio), 16)}, true
	}
	longEdge := 2048
	if tier == "4k" {
		longEdge = 3840
	}
	if widthRatio >= heightRatio {
		return [2]int{longEdge, workflowRoundToStep(float64(longEdge)*float64(heightRatio)/float64(widthRatio), 16)}, true
	}
	return [2]int{workflowRoundToStep(float64(longEdge)*float64(widthRatio)/float64(heightRatio), 16), longEdge}, true
}

func workflowVideoDimensions(size string, quality string) ([2]int, bool) {
	ratio := workflowAspectRatio(size)
	widthRatio, heightRatio, ok := workflowRatioParts(ratio)
	shortEdge := workflowVideoResolutionPixels(quality)
	if !ok || shortEdge <= 0 {
		return [2]int{}, false
	}
	if widthRatio >= heightRatio {
		return [2]int{workflowRoundToStep(float64(shortEdge)*float64(widthRatio)/float64(heightRatio), 2), shortEdge}, true
	}
	return [2]int{shortEdge, workflowRoundToStep(float64(shortEdge)*float64(heightRatio)/float64(widthRatio), 2)}, true
}

func workflowRoundToStep(value float64, step int) int {
	if step <= 1 {
		return int(math.Round(value))
	}
	return int(math.Round(value/float64(step))) * step
}

func workflowVideoResolutionPixels(value string) int {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "low":
		return 480
	case "auto", "default", "medium", "high":
		return 720
	case "2k":
		return 1440
	case "4k":
		return 2160
	}
	parsed, err := strconv.Atoi(strings.TrimSuffix(normalized, "p"))
	if err != nil || parsed <= 0 {
		return 0
	}
	return parsed
}

func workflowVideoFieldValue(field model.WorkflowFieldMapping, value string, normalize func(string) string) interface{} {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return ""
	}
	if len(field.Options) > 0 {
		requested := normalize(raw)
		for _, option := range field.Options {
			candidate := strings.TrimSpace(workflowOptionString(option))
			if candidate != "" && normalize(candidate) == requested {
				return candidate
			}
		}
		if fallback := workflowFieldConfiguredDefault(field); fallback != "" {
			for _, option := range field.Options {
				candidate := strings.TrimSpace(workflowOptionString(option))
				if candidate != "" && normalize(candidate) == normalize(fallback) {
					return candidate
				}
			}
			return fallback
		}
		return raw
	}
	if numeric := workflowNumericResolutionValue(field, raw); numeric != nil {
		return numeric
	}
	if fallback := workflowFieldConfiguredDefault(field); fallback != "" && !workflowResolutionShapeCompatible(fallback, raw) {
		return fallback
	}
	return raw
}

func normalizeWorkflowDurationToken(value string) string {
	return strings.ToLower(strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(value, "s"), "秒")))
}

func workflowFieldConfiguredDefault(field model.WorkflowFieldMapping) string {
	value := field.FieldValue
	if value == nil {
		value = field.Value
	}
	if value == nil {
		return ""
	}
	return strings.TrimSpace(workflowOptionString(value))
}

func normalizeWorkflowResolutionToken(value string) string {
	return strings.ToLower(strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(value, "p"), "P")))
}

func workflowNumericValue(value string) *float64 {
	parsed, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(value, "p"), "P")), 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return nil
	}
	return &parsed
}

func workflowResolutionShapeCompatible(defaultValue string, requested string) bool {
	defaultNumeric := workflowNumericValue(defaultValue)
	requestedNumeric := workflowNumericValue(requested)
	if defaultNumeric != nil && requestedNumeric != nil {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(defaultValue), strings.TrimSpace(requested))
}

func workflowNumericResolutionValue(field model.WorkflowFieldMapping, raw string) interface{} {
	parsed := workflowNumericValue(raw)
	if parsed == nil {
		return nil
	}
	min, minOK := workflowNumericBound(field.Min)
	max, maxOK := workflowNumericBound(field.Max)
	step, stepOK := workflowNumericBound(field.Step)
	if !minOK && !maxOK && !stepOK && !strings.EqualFold(strings.TrimSpace(field.FieldType), "NUMBER") {
		return nil
	}
	value := *parsed
	if minOK && value < min {
		value = min
	}
	if maxOK && value > max {
		value = max
	}
	if stepOK && step > 0 {
		anchor := min
		if !minOK {
			anchor = 0
		}
		value = anchor + math.Round((value-anchor)/step)*step
	}
	if strings.EqualFold(strings.TrimSpace(field.FieldType), "NUMBER") && math.Trunc(value) == value {
		return int64(value)
	}
	return value
}

func workflowNumericBound(value interface{}) (float64, bool) {
	parsed, err := strconv.ParseFloat(strings.TrimSpace(fmt.Sprint(value)), 64)
	return parsed, err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0)
}

func workflowOptionString(value interface{}) string {
	if object, ok := value.(map[string]interface{}); ok {
		for _, key := range []string{"value", "id", "key", "label", "name"} {
			if candidate := strings.TrimSpace(fmt.Sprint(object[key])); candidate != "" && candidate != "<nil>" {
				return candidate
			}
		}
	}
	return fmt.Sprint(value)
}

func validateWorkflowFieldValue(field model.WorkflowFieldMapping, value any) (any, error) {
	if _, media := value.(map[string]any); media {
		return value, nil
	}
	kind := strings.ToUpper(strings.TrimSpace(field.FieldType))
	switch kind {
	case "TEXT", "STRING", "COMBO":
		if _, ok := value.(string); !ok {
			value = fmt.Sprint(value)
		}
	case "BOOLEAN", "BOOL":
		if _, ok := value.(bool); !ok {
			switch strings.ToLower(strings.TrimSpace(fmt.Sprint(value))) {
			case "true":
				value = true
			case "false":
				value = false
			default:
				return nil, errors.New("需要布尔值")
			}
		}
	case "INTEGER", "INT":
		text := strings.TrimSpace(fmt.Sprint(value))
		integer, parseErr := strconv.ParseInt(text, 10, 64)
		if parseErr != nil {
			number, floatErr := strconv.ParseFloat(text, 64)
			if floatErr != nil || math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || number < float64(math.MinInt64) || number >= float64(math.MaxInt64) {
				return nil, errors.New("需要整数")
			}
			integer = int64(number)
		}
		value = integer
	case "NUMBER", "FLOAT", "SLIDER":
		number, parseErr := strconv.ParseFloat(strings.TrimSpace(fmt.Sprint(value)), 64)
		if parseErr != nil || math.IsNaN(number) || math.IsInf(number, 0) {
			return nil, errors.New("需要有效数字")
		}
		value = number
	}
	if kind == "NUMBER" || kind == "FLOAT" || kind == "INTEGER" || kind == "INT" || kind == "SLIDER" {
		number, _ := strconv.ParseFloat(strings.TrimSpace(fmt.Sprint(value)), 64)
		minimum, hasMinimum := workflowFieldBound(field.Min, field.Options, "min", "minValue", "min_value")
		maximum, hasMaximum := workflowFieldBound(field.Max, field.Options, "max", "maxValue", "max_value")
		step, hasStep := workflowFieldBound(field.Step, field.Options, "step", "stepValue", "step_value")
		if hasMinimum && hasMaximum && minimum > maximum {
			return nil, errors.New("最小值不能大于最大值")
		}
		if hasMinimum && number < minimum || hasMaximum && number > maximum {
			return nil, errors.New("数值超出允许范围")
		}
		if hasStep && step <= 0 {
			return nil, errors.New("步长必须大于 0")
		}
		if hasStep {
			base := 0.0
			if hasMinimum {
				base = minimum
			}
			steps := (number - base) / step
			if math.Abs(steps-math.Round(steps)) > 0.000001 {
				return nil, errors.New("数值不符合步长")
			}
		}
	}
	choices := make([]string, 0, len(workflowFieldAllowedOptions(field)))
	for _, option := range workflowFieldAllowedOptions(field) {
		if candidate, ok := workflowOptionScalar(option); ok {
			choices = append(choices, candidate)
		}
	}
	if len(choices) > 0 {
		allowed := false
		for _, option := range choices {
			matches := option == fmt.Sprint(value)
			if kind == "NUMBER" || kind == "FLOAT" || kind == "INTEGER" || kind == "INT" || kind == "SLIDER" {
				optionNumber, optionErr := strconv.ParseFloat(strings.TrimSpace(option), 64)
				valueNumber, valueErr := strconv.ParseFloat(strings.TrimSpace(fmt.Sprint(value)), 64)
				matches = optionErr == nil && valueErr == nil && optionNumber == valueNumber
			}
			if matches {
				allowed = true
				break
			}
		}
		if !allowed {
			return nil, fmt.Errorf("值不在允许选项内：%v", choices)
		}
	}
	return value, nil
}

func workflowOptionScalar(option any) (string, bool) {
	if item, ok := option.(map[string]any); ok {
		for _, key := range []string{"min", "max", "step", "minValue", "maxValue", "stepValue", "range"} {
			if _, exists := item[key]; exists {
				return "", false
			}
		}
		for _, key := range []string{"value", "id", "key", "name", "label"} {
			if value, exists := item[key]; exists && value != nil {
				return fmt.Sprint(value), true
			}
		}
		return "", false
	}
	if option == nil {
		return "", false
	}
	return fmt.Sprint(option), true
}

func workflowFieldBound(direct any, options []any, keys ...string) (float64, bool) {
	read := func(value any) (float64, bool) {
		if value == nil || strings.TrimSpace(fmt.Sprint(value)) == "" {
			return 0, false
		}
		number, err := strconv.ParseFloat(strings.TrimSpace(fmt.Sprint(value)), 64)
		return number, err == nil && !math.IsNaN(number) && !math.IsInf(number, 0)
	}
	if value, ok := read(direct); ok {
		return value, true
	}
	for _, option := range options {
		item, ok := option.(map[string]any)
		if !ok {
			continue
		}
		rangeObject, _ := item["range"].(map[string]any)
		for _, source := range []map[string]any{item, rangeObject} {
			for _, key := range keys {
				if value, ok := read(source[key]); ok {
					return value, true
				}
			}
		}
	}
	return 0, false
}
