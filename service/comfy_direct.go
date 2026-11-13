package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

// ComfyUI 直连：服务端直接向 ComfyUI 提交工作流、轮询历史并回传产物地址。
// 渠道绑定了 Bridge 时仍由 Bridge 执行；没有 Bridge 的渠道使用这里配置的服务端。

const (
	comfyDirectTagSeparator = "|"
	comfyReferenceBytes     = 64 << 20
)

var (
	comfyDirectHTTPClient  = &http.Client{Timeout: 10 * time.Minute}
	errComfyDirectTerminal = errors.New("ComfyUI 任务已终止")
)

type comfyTarget struct {
	ID     string
	URL    string
	APIKey string
}

type ComfyWorkflowInspectInput struct {
	WorkflowJSON map[string]any `json:"workflowJson"`
	Capability   string         `json:"capability"`
}

type ComfyWorkflowInspectResult struct {
	WorkflowJSON map[string]any `json:"workflowJson"`
	Fields       []any          `json:"fields"`
}

// comfyTargetForEntry 解析工作流要使用的服务端：绑定的服务端不存在时回落到默认地址。
func comfyTargetForEntry(entry model.WorkflowEntry) (comfyTarget, bool) {
	settings, err := repository.GetSettings()
	if err != nil {
		return comfyTarget{}, false
	}
	return comfyTargetFromSetting(settings.Private.Comfy, entry.ComfyServerID)
}

func comfyTargetByID(serverID string) (comfyTarget, bool) {
	settings, err := repository.GetSettings()
	if err != nil {
		return comfyTarget{}, false
	}
	return comfyTargetFromSetting(settings.Private.Comfy, serverID)
}

func comfyTargetFromSetting(setting model.ComfySetting, serverID string) (comfyTarget, bool) {
	if strings.TrimSpace(serverID) != "" {
		for _, server := range setting.Servers {
			if server.ID == serverID && strings.TrimSpace(server.URL) != "" {
				return comfyTarget{ID: server.ID, URL: strings.TrimRight(server.URL, "/"), APIKey: server.APIKey}, true
			}
		}
	}
	if strings.TrimSpace(setting.URL) == "" {
		return comfyTarget{}, false
	}
	return comfyTarget{URL: strings.TrimRight(setting.URL, "/"), APIKey: setting.APIKey}, true
}

func comfyDirectTag(serverID, capability, promptID string) string {
	return serverID + comfyDirectTagSeparator + capability + comfyDirectTagSeparator + promptID
}

func parseComfyDirectTag(value string) (serverID, capability, promptID string) {
	last := strings.LastIndex(value, comfyDirectTagSeparator)
	if last < 0 {
		return "", "", value
	}
	promptID = value[last+1:]
	rest := value[:last]
	index := strings.LastIndex(rest, comfyDirectTagSeparator)
	if index < 0 {
		return "", "", value
	}
	return rest[:index], rest[index+1:], promptID
}

// InspectComfyWorkflow 只解析 API JSON 并推断字段，不访问 ComfyUI。
func InspectComfyWorkflow(input ComfyWorkflowInspectInput) (ComfyWorkflowInspectResult, error) {
	workflow := comfyWorkflowAPI(input.WorkflowJSON)
	if len(workflow) == 0 {
		return ComfyWorkflowInspectResult{}, safeMessageError{message: "未找到可执行的 ComfyUI API 节点，请先导出 API 格式 JSON"}
	}
	capability := strings.ToLower(strings.TrimSpace(input.Capability))
	if capability != "image" && capability != "video" && capability != "audio" {
		capability = "image"
	}
	return ComfyWorkflowInspectResult{WorkflowJSON: workflow, Fields: comfyDiscoverFields(workflow, capability)}, nil
}

func comfyWorkflowAPI(value map[string]any) map[string]any {
	result := make(map[string]any, len(value))
	for nodeID, raw := range value {
		node, ok := comfyMapValue(raw)
		if !ok || stringValue(node["class_type"]) == "" || node["inputs"] == nil {
			continue
		}
		if comfyAnnotationNode(stringValue(node["class_type"])) {
			continue
		}
		result[nodeID] = node
	}
	return result
}

func comfyCloneWorkflow(value map[string]any) (map[string]any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	cloned := map[string]any{}
	if err := json.Unmarshal(encoded, &cloned); err != nil {
		return nil, err
	}
	return cloned, nil
}

// SubmitComfyDirectTask 上传参考素材、套用字段映射并提交 /prompt，返回 ComfyUI 的 prompt_id。
func SubmitComfyDirectTask(ctx context.Context, target comfyTarget, entry model.WorkflowEntry, input WorkflowRunInput, overrides []WorkflowOverride, capture *AICallLogInput) (string, error) {
	workflow, err := comfyCloneWorkflow(comfyWorkflowAPI(entry.WorkflowJSON))
	if err != nil {
		return "", errors.New("工作流 JSON 无法解析")
	}
	if len(workflow) == 0 {
		return "", errors.New("工作流没有可执行的 ComfyUI API 节点")
	}
	files := map[string]string{}
	for _, override := range overrides {
		media, ok := comfyMapValue(override.Value)
		if !ok {
			continue
		}
		mediaID := stringValue(media["mediaId"])
		if mediaID == "" {
			continue
		}
		if _, exists := files[mediaID]; exists {
			continue
		}
		source, err := workflowMediaSource(input, mediaID)
		if err != nil {
			return "", err
		}
		if strings.HasPrefix(source, "comfy:") {
			files[mediaID] = strings.TrimPrefix(source, "comfy:")
			continue
		}
		name, err := uploadComfyReference(ctx, target, mediaID, source)
		if err != nil {
			return "", err
		}
		files[mediaID] = name
	}
	if err := comfyApplyFields(workflow, entry.Fields, overrides, files); err != nil {
		return "", err
	}
	var response map[string]any
	body := map[string]any{"prompt": workflow, "client_id": uuid.NewString()}
	if err := comfyDirectJSON(ctx, target, http.MethodPost, "/prompt", body, &response, capture); err != nil {
		return "", fmt.Errorf("ComfyUI 提交失败：%w", err)
	}
	if message := comfyPromptError(response); message != "" {
		return "", errors.New(message)
	}
	promptID := stringValue(response["prompt_id"])
	if promptID == "" {
		return "", errors.New("ComfyUI 提交未返回 prompt_id")
	}
	return promptID, nil
}

// PollComfyDirectTask 查询 /history；未完成返回 done=false，完成后返回可直接展示的产物地址。
func PollComfyDirectTask(ctx context.Context, target comfyTarget, promptID, capability string) (urls []string, done bool, err error) {
	var history map[string]any
	if err := comfyDirectJSON(ctx, target, http.MethodGet, "/history/"+url.PathEscape(promptID), nil, &history, nil); err != nil {
		return nil, false, err
	}
	entry, ok := comfyMapValue(history[promptID])
	if !ok {
		return nil, false, nil
	}
	if message := comfyHistoryError(entry); message != "" {
		return nil, false, fmt.Errorf("%w: %s", errComfyDirectTerminal, message)
	}
	items := comfyOutputItems(entry["outputs"])
	if len(items) == 0 {
		if comfyHistoryCompleted(entry) {
			return nil, false, fmt.Errorf("%w: ComfyUI 任务完成但没有返回产物", errComfyDirectTerminal)
		}
		return nil, false, nil
	}
	urls = comfyOutputURLs(target.URL, items, capability)
	if len(urls) == 0 {
		return nil, false, fmt.Errorf("%w: ComfyUI 没有返回可用产物", errComfyDirectTerminal)
	}
	return urls, true, nil
}

func comfyPromptError(response map[string]any) string {
	if nodeErrors, ok := comfyMapValue(response["node_errors"]); ok && len(nodeErrors) > 0 {
		for nodeID, raw := range nodeErrors {
			node, ok := comfyMapValue(raw)
			if !ok {
				continue
			}
			items, _ := node["errors"].([]any)
			for _, item := range items {
				detail, ok := comfyMapValue(item)
				if !ok {
					continue
				}
				message := firstNonEmpty(stringValue(detail["details"]), stringValue(detail["message"]))
				if message != "" {
					return "ComfyUI 提交失败：节点 " + nodeID + " " + message
				}
			}
		}
		return "ComfyUI 提交失败：节点参数校验未通过"
	}
	raw, exists := response["error"]
	if !exists || raw == nil {
		return ""
	}
	if text, ok := raw.(string); ok && strings.TrimSpace(text) != "" {
		return "ComfyUI 提交失败：" + strings.TrimSpace(text)
	}
	if detail, ok := comfyMapValue(raw); ok {
		message := firstNonEmpty(stringValue(detail["message"]), stringValue(detail["details"]))
		if message != "" {
			return "ComfyUI 提交失败：" + message
		}
	}
	return "ComfyUI 提交失败"
}

func comfyHistoryError(entry map[string]any) string {
	status, ok := comfyMapValue(entry["status"])
	if !ok || !strings.EqualFold(stringValue(status["status_str"]), "error") {
		return ""
	}
	for _, raw := range comfySliceValue(status["messages"]) {
		message, ok := raw.([]any)
		if !ok || len(message) < 2 || stringValue(message[0]) != "execution_error" {
			continue
		}
		if detail, ok := comfyMapValue(message[1]); ok {
			text := firstNonEmpty(stringValue(detail["exception_message"]), stringValue(detail["exception_type"]))
			if text != "" {
				return "ComfyUI 执行失败：" + text
			}
		}
	}
	return "ComfyUI 执行失败"
}

func comfyHistoryCompleted(entry map[string]any) bool {
	status, ok := comfyMapValue(entry["status"])
	if !ok {
		return false
	}
	return comfyBoolValue(status["completed"])
}

type comfyOutputItem struct {
	Filename  string
	Subfolder string
	Type      string
	Kind      string
}

func comfyOutputItems(outputs any) []comfyOutputItem {
	items := make([]comfyOutputItem, 0)
	var walk func(value any, kind string)
	walk = func(value any, kind string) {
		if list, ok := value.([]any); ok {
			for _, child := range list {
				walk(child, kind)
			}
			return
		}
		node, ok := comfyMapValue(value)
		if !ok {
			return
		}
		if filename := stringValue(node["filename"]); filename != "" {
			items = append(items, comfyOutputItem{Filename: filename, Subfolder: stringValue(node["subfolder"]), Type: firstNonEmpty(stringValue(node["type"]), "output"), Kind: firstNonEmpty(kind, comfyOutputKind(filename))})
			return
		}
		keys := make([]string, 0, len(node))
		for key := range node {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			switch key {
			case "images", "gifs", "files":
				walk(node[key], "")
			case "video", "videos":
				walk(node[key], "video")
			case "audio", "audios":
				walk(node[key], "audio")
			}
		}
	}
	walk(outputs, "")
	return items
}

func comfyOutputURLs(root string, items []comfyOutputItem, capability string) []string {
	wanted := make([]string, 0, len(items))
	others := make([]string, 0, len(items))
	for _, item := range items {
		viewURL := comfyViewURL(root, item)
		if item.Kind == capability || capability == "" {
			wanted = append(wanted, viewURL)
			continue
		}
		others = append(others, viewURL)
	}
	if capability == "video" || capability == "audio" {
		wanted = append(wanted, others...)
	}
	return wanted
}

func comfyViewURL(root string, item comfyOutputItem) string {
	query := url.Values{}
	query.Set("filename", item.Filename)
	if item.Subfolder != "" {
		query.Set("subfolder", item.Subfolder)
	}
	query.Set("type", firstNonEmpty(item.Type, "output"))
	return root + "/view?" + query.Encode()
}

func comfyOutputKind(filename string) string {
	lower := strings.ToLower(filename)
	if index := strings.IndexAny(lower, "?#"); index >= 0 {
		lower = lower[:index]
	}
	switch {
	case strings.HasSuffix(lower, ".png"), strings.HasSuffix(lower, ".jpg"), strings.HasSuffix(lower, ".jpeg"),
		strings.HasSuffix(lower, ".webp"), strings.HasSuffix(lower, ".gif"), strings.HasSuffix(lower, ".bmp"), strings.HasSuffix(lower, ".avif"):
		return "image"
	case strings.HasSuffix(lower, ".mp4"), strings.HasSuffix(lower, ".webm"), strings.HasSuffix(lower, ".mov"), strings.HasSuffix(lower, ".m4v"), strings.HasSuffix(lower, ".mkv"):
		return "video"
	case strings.HasSuffix(lower, ".mp3"), strings.HasSuffix(lower, ".wav"), strings.HasSuffix(lower, ".ogg"), strings.HasSuffix(lower, ".m4a"), strings.HasSuffix(lower, ".flac"), strings.HasSuffix(lower, ".aac"):
		return "audio"
	}
	return ""
}

func uploadComfyReference(ctx context.Context, target comfyTarget, mediaID, source string) (string, error) {
	data, mimeType, err := readWorkflowMedia(ctx, source, comfyReferenceBytes)
	if err != nil {
		return "", err
	}
	if len(data) == 0 {
		return "", fmt.Errorf("参考素材 %s 内容为空", mediaID)
	}
	name := comfyReferenceName(mediaID) + workflowExtension(mimeType)
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": "image", "filename": name}))
	header.Set("Content-Type", firstNonEmpty(mimeType, "application/octet-stream"))
	part, err := writer.CreatePart(header)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(data); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.URL+"/upload/image", body)
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	comfySetAuth(request, target)
	response, err := comfyDirectHTTPClient.Do(request)
	if err != nil {
		return "", errors.New("ComfyUI 素材上传失败")
	}
	defer response.Body.Close()
	encoded, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("ComfyUI 素材上传失败 HTTP %d", response.StatusCode)
	}
	payload := map[string]any{}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		return "", errors.New("ComfyUI 素材上传响应无效")
	}
	uploaded := stringValue(payload["name"])
	if uploaded == "" {
		return "", errors.New("ComfyUI 素材上传响应缺少文件名")
	}
	return uploaded, nil
}

func comfyReferenceName(mediaID string) string {
	var builder strings.Builder
	for _, character := range mediaID {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '_' || character == '-' {
			builder.WriteRune(character)
		}
		if builder.Len() >= 48 {
			break
		}
	}
	if builder.Len() == 0 {
		return "reference"
	}
	return builder.String()
}

// comfyApplyFields 与 Bridge 的字段应用规则一致：覆盖已映射字段，缺失的媒体槽位删除节点输入。
func comfyApplyFields(workflow map[string]any, fields []model.WorkflowFieldMapping, overrides []WorkflowOverride, files map[string]string) error {
	values := make(map[string]any, len(overrides))
	for _, override := range overrides {
		values[override.NodeID+"::"+override.FieldName] = override.Value
	}
	removed := map[string]bool{}
	for _, field := range fields {
		if field.Enabled != nil && !*field.Enabled {
			continue
		}
		nodeID, fieldName := strings.TrimSpace(field.NodeID), strings.TrimSpace(field.FieldName)
		if nodeID == "" || fieldName == "" {
			continue
		}
		node, ok := comfyMapValue(workflow[nodeID])
		if !ok {
			if field.Required {
				return fmt.Errorf("工作流缺少必填映射节点 %s", nodeID)
			}
			continue
		}
		inputs, ok := comfyMapValue(node["inputs"])
		if !ok {
			inputs = map[string]any{}
		}
		source := comfyFieldSource(field)
		value, present := values[nodeID+"::"+fieldName]
		if present {
			if media, isMedia := comfyMapValue(value); isMedia && stringValue(media["mediaId"]) != "" {
				name, exists := files[stringValue(media["mediaId"])]
				if !exists || strings.TrimSpace(name) == "" {
					return fmt.Errorf("工作流字段 %s.%s 的素材上传结果不存在", nodeID, fieldName)
				}
				value = name
			}
			inputs[fieldName] = value
		} else if comfyMediaSource(source) {
			delete(inputs, fieldName)
		}
		node["inputs"] = inputs
		if len(inputs) == 0 && comfyMediaSource(source) {
			removed[nodeID] = true
		}
	}
	if len(removed) == 0 {
		return nil
	}
	for nodeID := range removed {
		delete(workflow, nodeID)
	}
	for _, rawNode := range workflow {
		node, ok := comfyMapValue(rawNode)
		if !ok {
			continue
		}
		inputs, ok := comfyMapValue(node["inputs"])
		if !ok {
			continue
		}
		for fieldName, value := range inputs {
			link, ok := value.([]any)
			if ok && len(link) > 0 && removed[stringValue(link[0])] {
				delete(inputs, fieldName)
			}
		}
	}
	return nil
}

func comfyFieldSource(field model.WorkflowFieldMapping) string {
	source := strings.TrimSpace(field.Source)
	if source == "" && field.BindPrompt {
		source = "prompt"
	}
	if source == "" && field.SourceFromUpstream {
		switch strings.ToLower(strings.TrimSpace(field.FieldType)) {
		case "image":
			source = "referenceImage"
		case "video":
			source = "referenceVideo"
		case "audio":
			source = "referenceAudio"
		default:
			if comfyPromptFieldName(field.FieldName) {
				source = "prompt"
			}
		}
	}
	return comfyNormalizeName(source)
}

func comfyPromptFieldName(value string) bool {
	switch comfyNormalizeName(value) {
	case "text", "prompt", "positiveprompt", "caption", "description":
		return true
	}
	return false
}

func comfyMediaSource(source string) bool {
	switch source {
	case "referenceimage", "referenceimages", "image", "referencevideo", "referencevideos", "video",
		"referenceaudio", "referenceaudios", "audio", "mask":
		return true
	}
	return false
}

// comfyDiscoverFields 与 Bridge 的字段发现保持一致，供没有 Bridge 的直连渠道拉取工作流参数。
func comfyDiscoverFields(workflow map[string]any, capability string) []any {
	fields := make([]any, 0)
	nodeIDs := comfySortedNodeIDs(workflow)
	promptNode, promptField := comfyPromptTarget(workflow, nodeIDs)
	imageOrder, videoOrder, audioOrder := 0, 0, 0
	for _, nodeID := range nodeIDs {
		node, ok := comfyMapValue(workflow[nodeID])
		if !ok {
			continue
		}
		inputs, ok := comfyMapValue(node["inputs"])
		if !ok {
			continue
		}
		title := ""
		if meta, ok := comfyMapValue(node["_meta"]); ok {
			title = stringValue(meta["title"])
		}
		classType := stringValue(node["class_type"])
		if comfyAnnotationNode(classType) {
			continue
		}
		fieldNames := make([]string, 0, len(inputs))
		for fieldName := range inputs {
			fieldNames = append(fieldNames, fieldName)
		}
		sort.Strings(fieldNames)
		for _, fieldName := range fieldNames {
			fieldValue := inputs[fieldName]
			if comfyWorkflowLink(fieldValue) {
				continue
			}
			fieldType := comfyFieldType(fieldName, fieldValue, classType)
			label := fieldName
			if title != "" {
				label = title + " · " + fieldName
			}
			field := map[string]any{"id": nodeID + "::" + fieldName, "nodeId": nodeID, "fieldName": fieldName, "fieldValue": fieldValue, "fieldType": fieldType, "label": label, "enabled": true}
			if nodeID == promptNode && fieldName == promptField {
				field["source"], field["sourceAutomatic"], field["required"] = "prompt", true, true
			} else if source := comfyDynamicSource(fieldName, fieldType, capability); source != "" {
				field["source"], field["sourceAutomatic"] = source, true
			}
			switch comfyNormalizeName(stringValue(field["source"])) {
			case "referenceimage":
				imageOrder++
				field["imageOrder"], field["sourceIndex"], field["required"] = imageOrder, imageOrder-1, imageOrder == 1
			case "referencevideo":
				field["sourceIndex"], field["required"] = videoOrder, videoOrder == 0
				videoOrder++
			case "referenceaudio":
				field["sourceIndex"], field["required"] = audioOrder, audioOrder == 0
				audioOrder++
			case "mask":
				field["required"] = false
			}
			if comfySeedField(fieldName) {
				field["randomEnabled"] = true
			}
			fields = append(fields, field)
		}
	}
	return fields
}

func comfySortedNodeIDs(workflow map[string]any) []string {
	nodeIDs := make([]string, 0, len(workflow))
	for nodeID := range workflow {
		nodeIDs = append(nodeIDs, nodeID)
	}
	sort.Slice(nodeIDs, func(i, j int) bool {
		left, leftErr := strconv.ParseInt(nodeIDs[i], 10, 64)
		right, rightErr := strconv.ParseInt(nodeIDs[j], 10, 64)
		if leftErr == nil && rightErr == nil {
			return left < right
		}
		return nodeIDs[i] < nodeIDs[j]
	})
	return nodeIDs
}

func comfyPromptTarget(workflow map[string]any, nodeIDs []string) (string, string) {
	bestNode, bestField, bestScore := "", "", -1<<31
	for _, nodeID := range nodeIDs {
		node, ok := comfyMapValue(workflow[nodeID])
		if !ok {
			continue
		}
		inputs, ok := comfyMapValue(node["inputs"])
		if !ok {
			continue
		}
		classType := strings.ToLower(stringValue(node["class_type"]))
		title := ""
		if meta, ok := comfyMapValue(node["_meta"]); ok {
			title = strings.ToLower(stringValue(meta["title"]))
		}
		for fieldName, value := range inputs {
			if _, ok := value.(string); !ok || !comfyPromptCandidate(fieldName, classType, title) {
				continue
			}
			descriptor := strings.ToLower(fieldName + " " + title)
			score := 0
			if strings.Contains(descriptor, "negative") || strings.Contains(descriptor, "负面") || strings.Contains(descriptor, "反向") || strings.Contains(descriptor, "负向") {
				score -= 100
			}
			if strings.Contains(descriptor, "positive") || strings.Contains(descriptor, "正面") || strings.Contains(descriptor, "正向") {
				score += 20
			}
			if strings.Contains(classType, "cliptextencode") {
				score += 5
			}
			if comfyPromptFieldName(fieldName) {
				score += 2
			}
			if bestNode == "" || score > bestScore {
				bestNode, bestField, bestScore = nodeID, fieldName, score
			}
		}
	}
	return bestNode, bestField
}

func comfyPromptCandidate(fieldName, classType, title string) bool {
	key := comfyNormalizeName(fieldName)
	if key == "text" || key == "prompt" || key == "positiveprompt" || key == "positive" || key == "caption" || key == "description" {
		return true
	}
	if strings.ToLower(fieldName) != "value" {
		return false
	}
	descriptor := classType + " " + title
	for _, token := range []string{"cliptextencode", "text", "string", "prompt", "提示词", "文本"} {
		if strings.Contains(descriptor, token) {
			return true
		}
	}
	return false
}

func comfyFieldType(fieldName string, value any, classType string) string {
	key, classKey := comfyNormalizeName(fieldName), comfyNormalizeName(classType)
	if strings.Contains(key, "mask") {
		return "IMAGE"
	}
	if strings.Contains(classKey, "loadimage") && (key == "image" || key == "file" || key == "path") {
		return "IMAGE"
	}
	if strings.Contains(classKey, "loadvideo") && (key == "video" || key == "file" || key == "path") {
		return "VIDEO"
	}
	if strings.Contains(classKey, "loadaudio") && (key == "audio" || key == "file" || key == "path") {
		return "AUDIO"
	}
	if comfyNamedDynamicSource(fieldName, "") != "" {
		return comfyScalarFieldType(value)
	}
	switch value.(type) {
	case bool:
		return "BOOLEAN"
	case float64, float32, int, int64:
		return "NUMBER"
	}
	if comfyMediaFieldName(key, "image") || comfyMediaValueType(value) == "IMAGE" {
		return "IMAGE"
	}
	if comfyMediaFieldName(key, "video") || comfyMediaValueType(value) == "VIDEO" {
		return "VIDEO"
	}
	if comfyMediaFieldName(key, "audio") || comfyMediaValueType(value) == "AUDIO" {
		return "AUDIO"
	}
	return "TEXT"
}

func comfyMediaValueType(value any) string {
	if items, ok := value.([]any); ok && len(items) > 0 {
		value = items[0]
	}
	text := strings.ToLower(stringValue(value))
	if index := strings.IndexAny(text, "?#"); index >= 0 {
		text = text[:index]
	}
	switch {
	case strings.HasSuffix(text, ".png"), strings.HasSuffix(text, ".jpg"), strings.HasSuffix(text, ".jpeg"),
		strings.HasSuffix(text, ".webp"), strings.HasSuffix(text, ".gif"), strings.HasSuffix(text, ".bmp"), strings.HasSuffix(text, ".avif"):
		return "IMAGE"
	case strings.HasSuffix(text, ".mp4"), strings.HasSuffix(text, ".webm"), strings.HasSuffix(text, ".mov"),
		strings.HasSuffix(text, ".m4v"), strings.HasSuffix(text, ".mkv"):
		return "VIDEO"
	case strings.HasSuffix(text, ".mp3"), strings.HasSuffix(text, ".wav"), strings.HasSuffix(text, ".ogg"),
		strings.HasSuffix(text, ".m4a"), strings.HasSuffix(text, ".flac"), strings.HasSuffix(text, ".aac"):
		return "AUDIO"
	}
	return ""
}

func comfyDynamicSource(fieldName, fieldType, capability string) string {
	if source := comfyNamedDynamicSource(fieldName, capability); source != "" {
		return source
	}
	switch strings.ToUpper(strings.TrimSpace(fieldType)) {
	case "IMAGE":
		return "referenceImage"
	case "VIDEO":
		return "referenceVideo"
	case "AUDIO":
		return "referenceAudio"
	}
	return ""
}

func comfyNamedDynamicSource(fieldName, capability string) string {
	key := comfyNormalizeName(fieldName)
	if strings.Contains(key, "mask") {
		return "mask"
	}
	if source := comfyDimensionSource(key); source != "" {
		return source
	}
	switch key {
	case "ratio", "aspectratio", "imageaspectratio", "imageratio", "videoaspectratio", "videoratio":
		return "aspectRatio"
	case "videoresolution", "videoquality", "vquality":
		return "vquality"
	case "size", "imagesize", "imageresolution":
		return "size"
	case "resolution":
		if capability == "video" {
			return "vquality"
		}
		if capability == "image" {
			return "size"
		}
	}
	aliases := map[string]string{
		"batch": "count", "batchsize": "count", "count": "count", "numimages": "count", "numberofimages": "count", "imagecount": "count", "imagescount": "count",
		"quality": "quality", "duration": "videoSeconds", "seconds": "videoSeconds", "durationseconds": "videoSeconds", "videoseconds": "videoSeconds", "videoduration": "videoSeconds", "videodurationseconds": "videoSeconds", "videolength": "videoSeconds", "clipduration": "videoSeconds",
		"generateaudio": "videoGenerateAudio", "videogenerateaudio": "videoGenerateAudio", "watermark": "videoWatermark", "videowatermark": "videoWatermark",
		"audioformat": "audioFormat", "voice": "audioVoice", "audiovoice": "audioVoice", "audiospeed": "audioSpeed", "audioinstructions": "audioInstructions",
		"transparent": "transparentBackground", "transparentbackground": "transparentBackground",
	}
	return aliases[key]
}

func comfyDimensionSource(key string) string {
	for _, prefix := range []string{"", "image", "video", "size", "output", "target", "latent", "frame", "canvas", "source", "resolution", "final"} {
		if key == prefix+"width" {
			return "width"
		}
		if key == prefix+"height" {
			return "height"
		}
	}
	if key == "pixelwidth" || key == "widthpixels" {
		return "width"
	}
	if key == "pixelheight" || key == "heightpixels" {
		return "height"
	}
	return ""
}

func comfyScalarFieldType(value any) string {
	switch value.(type) {
	case bool:
		return "BOOLEAN"
	case float64, float32, int, int64:
		return "NUMBER"
	}
	return "TEXT"
}

func comfyMediaFieldName(key, mediaType string) bool {
	if key == mediaType {
		return true
	}
	for _, prefix := range []string{"input", "reference", "ref", "source", "init", "start", "end", "first", "last", "control", "controlnet", "style", "subject"} {
		if key == prefix+mediaType {
			return true
		}
	}
	for _, suffix := range []string{"file", "path", "filename", "upload"} {
		if key == mediaType+suffix {
			return true
		}
	}
	return mediaType == "image" && (key == "firstframe" || key == "lastframe" || key == "startframe" || key == "endframe")
}

func comfySeedField(fieldName string) bool {
	key := comfyNormalizeName(fieldName)
	return key == "seed" || strings.HasSuffix(key, "seed") || strings.Contains(key, "noiseseed")
}

func comfyWorkflowLink(value any) bool {
	items, ok := value.([]any)
	if !ok || len(items) != 2 || stringValue(items[0]) == "" {
		return false
	}
	number, ok := items[1].(float64)
	return ok && number == float64(int64(number))
}

func comfyAnnotationNode(classType string) bool {
	normalized := strings.ToLower(strings.TrimSpace(classType))
	switch normalized {
	case "note", "markdownnote", "label (rgthree)", "label", "addlabel", "fast groups bypasser (rgthree)", "fast groups bypasser":
		return true
	}
	return strings.HasPrefix(normalized, "note:") || strings.HasPrefix(normalized, "markdownnote:")
}

func comfyNormalizeName(value string) string {
	return strings.ToLower(strings.NewReplacer(" ", "", "_", "", "-", "").Replace(strings.TrimSpace(value)))
}

func comfyDirectJSON(ctx context.Context, target comfyTarget, method, path string, body any, out any, capture *AICallLogInput) error {
	var reader io.Reader
	var payload []byte
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload, reader = encoded, bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, target.URL+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	comfySetAuth(request, target)
	response, err := comfyDirectHTTPClient.Do(request)
	if err != nil {
		return errors.New("ComfyUI 服务不可达")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return errors.New("ComfyUI 响应读取失败")
	}
	if capture != nil {
		capture.Endpoint, capture.Method, capture.Status = target.URL+path, method, response.StatusCode
		if len(payload) > 0 {
			capture.RequestBody = string(workflowLogJSON(string(payload), target.APIKey))
		}
		capture.ResponseBody = string(workflowLogJSON(string(data), target.APIKey))
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("ComfyUI HTTP %d %s", response.StatusCode, comfyErrorMessage(data))
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return errors.New("ComfyUI 响应不是有效 JSON")
		}
	}
	return nil
}

// comfyErrorMessage 从 ComfyUI 的错误响应里取出可直接展示的原因。
func comfyErrorMessage(data []byte) string {
	payload := map[string]any{}
	if err := json.Unmarshal(data, &payload); err == nil {
		if nodeErrors, ok := comfyMapValue(payload["node_errors"]); ok && len(nodeErrors) > 0 {
			for nodeID, raw := range nodeErrors {
				node, ok := comfyMapValue(raw)
				if !ok {
					continue
				}
				items, _ := node["errors"].([]any)
				for _, item := range items {
					detail, ok := comfyMapValue(item)
					if !ok {
						continue
					}
					if message := firstNonEmpty(stringValue(detail["details"]), stringValue(detail["message"])); message != "" {
						return "节点 " + nodeID + " " + message
					}
				}
			}
		}
		if detail, ok := comfyMapValue(payload["error"]); ok {
			if message := firstNonEmpty(stringValue(detail["message"]), stringValue(detail["details"])); message != "" {
				return message
			}
		}
	}
	text := strings.TrimSpace(string(data))
	if len(text) > 300 {
		text = text[:300]
	}
	return text
}

func comfySetAuth(request *http.Request, target comfyTarget) {
	if strings.TrimSpace(target.APIKey) != "" {
		request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(target.APIKey))
	}
}

func comfyMapValue(value any) (map[string]any, bool) {
	item, ok := value.(map[string]any)
	return item, ok
}

func comfySliceValue(value any) []any {
	items, _ := value.([]any)
	return items
}

func comfyBoolValue(value any) bool {
	flag, _ := value.(bool)
	return flag
}
