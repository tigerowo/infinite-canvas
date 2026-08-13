package handler

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

const (
	comfyUIProtocol = "comfyui"

	comfyUIDefaultSteps    = 20
	comfyUIDefaultCFG      = 4.0
	comfyUIDefaultSampler  = "euler"
	comfyUIDefaultSchedule = "normal"
	comfyUIDefaultDenoise  = 0.85
	comfyUIDefaultWidth    = 1024
	comfyUIDefaultHeight   = 1024
	comfyUIDefaultPrefix   = "infinite-canvas"

	// comfyUITemplateTxt2Img 内置默认文生图 workflow 模板，适用于 CheckpointLoaderSimple
	// 加载的 checkpoint（含 Qwen-Image / SD 系 AIO 合并模型）。数字占位符在渲染时替换为数值。
	comfyUITemplateTxt2Img = `{
  "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "{{ckpt_name}}"}},
  "5": {"class_type": "EmptyLatentImage", "inputs": {"width": "{{width}}", "height": "{{height}}", "batch_size": "{{batch_size}}"}},
  "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{prompt}}", "clip": ["4", 1]}},
  "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{negative_prompt}}", "clip": ["4", 1]}},
  "3": {"class_type": "KSampler", "inputs": {"seed": "{{seed}}", "steps": "{{steps}}", "cfg": "{{cfg}}", "sampler_name": "{{sampler_name}}", "scheduler": "{{scheduler}}", "denoise": "{{denoise}}", "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}},
  "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
  "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "{{filename_prefix}}", "images": ["8", 0]}}
}`

	// comfyUITemplateImg2Img 内置默认图生图 workflow 模板：LoadImage 加载参考图后
	// 经 VAEEncode 进入 KSampler，通过 denoise 控制重绘强度。
	comfyUITemplateImg2Img = `{
  "1": {"class_type": "LoadImage", "inputs": {"image": "{{image_name}}"}},
  "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "{{ckpt_name}}"}},
  "2": {"class_type": "VAEEncode", "inputs": {"pixels": ["1", 0], "vae": ["4", 2]}},
  "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{prompt}}", "clip": ["4", 1]}},
  "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{negative_prompt}}", "clip": ["4", 1]}},
  "3": {"class_type": "KSampler", "inputs": {"seed": "{{seed}}", "steps": "{{steps}}", "cfg": "{{cfg}}", "sampler_name": "{{sampler_name}}", "scheduler": "{{scheduler}}", "denoise": "{{denoise}}", "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["2", 0]}},
  "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
  "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "{{filename_prefix}}", "images": ["8", 0]}}
}`
)

func isComfyUIChannel(channel model.ModelChannel) bool {
	protocol := strings.ToLower(strings.TrimSpace(channel.Protocol))
	baseURL := strings.ToLower(strings.TrimSpace(channel.BaseURL))
	return protocol == comfyUIProtocol || strings.Contains(baseURL, "comfyui")
}

func comfyUIBaseURL(channel model.ModelChannel) string {
	return strings.TrimRight(strings.TrimSpace(channel.BaseURL), "/")
}

// normalizeComfyUIImageBody 把 OpenAI 兼容的文生图请求（/images/generations JSON）
// 转换成 ComfyUI 的 /prompt 请求体。
func normalizeComfyUIImageBody(body []byte, contentType string, modelName string, channel model.ModelChannel) ([]byte, string, error) {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return body, contentType, nil
	}
	finalModel := strings.TrimSpace(modelName)
	if finalModel == "" {
		finalModel = strings.TrimSpace(toStringSafe(payload["model"]))
	}
	if finalModel == "" {
		return body, contentType, errors.New("缺少模型名称")
	}

	width, height := parseComfyUISize(toStringSafe(payload["size"]))
	batchSize := 1
	if n, err := strconv.Atoi(toStringSafe(payload["n"])); err == nil && n > 0 {
		batchSize = n
	}

	vars := comfyUIDefaultVars(finalModel)
	vars["width"] = width
	vars["height"] = height
	vars["batch_size"] = batchSize
	vars["prompt"] = toStringSafe(payload["prompt"])
	if negative := strings.TrimSpace(toStringSafe(payload["negative_prompt"])); negative != "" {
		vars["negative_prompt"] = negative
	}
	vars["denoise"] = 1.0

	graph, err := renderComfyUIWorkflow(comfyUIChannelTemplate(channel.Txt2ImgWorkflow, comfyUITemplateTxt2Img), vars)
	if err != nil {
		return body, contentType, errors.New("ComfyUI 文生图 workflow 模板配置错误")
	}
	return marshalComfyUIPrompt(graph)
}

// normalizeComfyUIImageEditBody 把 OpenAI 兼容的图生图请求（/images/edits multipart）
// 转换成 ComfyUI 的 /prompt 请求体：先上传参考图，再构造 img2img workflow。
func normalizeComfyUIImageEditBody(body []byte, contentType string, modelName string, channel model.ModelChannel) ([]byte, string, error) {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return body, contentType, nil
	}
	form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(64 << 20)
	if err != nil {
		return body, contentType, nil
	}
	defer form.RemoveAll()

	finalModel := strings.TrimSpace(modelName)
	if finalModel == "" {
		finalModel = firstComfyUIFormValue(form, "model")
	}
	if finalModel == "" {
		return body, contentType, errors.New("缺少模型名称")
	}

	imageName, err := uploadComfyUIReferenceImage(form, channel)
	if err != nil {
		return body, contentType, err
	}
	if imageName == "" {
		return body, contentType, errors.New("图生图缺少参考图")
	}

	width, height := parseComfyUISize(firstComfyUIFormValue(form, "size"))
	batchSize := 1
	if n, err := strconv.Atoi(firstComfyUIFormValue(form, "n")); err == nil && n > 0 {
		batchSize = n
	}

	vars := comfyUIDefaultVars(finalModel)
	vars["prompt"] = firstComfyUIFormValue(form, "prompt")
	vars["image_name"] = imageName
	vars["width"] = width
	vars["height"] = height
	vars["batch_size"] = batchSize
	if negative := strings.TrimSpace(firstComfyUIFormValue(form, "negative_prompt")); negative != "" {
		vars["negative_prompt"] = negative
	}
	if denoise := strings.TrimSpace(firstComfyUIFormValue(form, "strength")); denoise != "" {
		if value, err := strconv.ParseFloat(denoise, 64); err == nil && value > 0 && value <= 1 {
			vars["denoise"] = value
		}
	}

	graph, err := renderComfyUIWorkflow(comfyUIChannelTemplate(channel.Img2ImgWorkflow, comfyUITemplateImg2Img), vars)
	if err != nil {
		return body, contentType, errors.New("ComfyUI 图生图 workflow 模板配置错误")
	}
	return marshalComfyUIPrompt(graph)
}

func comfyUIDefaultVars(ckptName string) map[string]any {
	return map[string]any{
		"ckpt_name":       ckptName,
		"negative_prompt": "",
		"seed":            rand.Int63(),
		"steps":           comfyUIDefaultSteps,
		"cfg":             comfyUIDefaultCFG,
		"sampler_name":    comfyUIDefaultSampler,
		"scheduler":       comfyUIDefaultSchedule,
		"denoise":         comfyUIDefaultDenoise,
		"filename_prefix": comfyUIDefaultPrefix,
	}
}

func comfyUIChannelTemplate(configured string, fallback string) string {
	if strings.TrimSpace(configured) != "" {
		return configured
	}
	return fallback
}

func parseComfyUISize(size string) (int, int) {
	size = strings.ToLower(strings.TrimSpace(size))
	// 像素格式 "WxH"（如 "1024x768"、"1920x1080"）
	if parts := strings.SplitN(size, "x", 2); len(parts) == 2 {
		width, errW := strconv.Atoi(strings.TrimSpace(parts[0]))
		height, errH := strconv.Atoi(strings.TrimSpace(parts[1]))
		if errW == nil && errH == nil && width > 0 && height > 0 {
			return alignComfyDimension(width), alignComfyDimension(height)
		}
	}
	// 宽高比格式 "W:H"（如 "16:9"、"9:16"、"21:9"、"1:1"）
	if parts := strings.SplitN(size, ":", 2); len(parts) == 2 {
		ratioW, errW := strconv.Atoi(strings.TrimSpace(parts[0]))
		ratioH, errH := strconv.Atoi(strings.TrimSpace(parts[1]))
		if errW == nil && errH == nil && ratioW > 0 && ratioH > 0 {
			return comfySizeFromAspect(ratioW, ratioH)
		}
	}
	return comfyUIDefaultWidth, comfyUIDefaultHeight
}

// comfySizeFromAspect 按宽高比计算像素尺寸：基准边长 1024，
// 结果对齐到 8 的倍数（ComfyUI latent 尺寸要求 step 8）。
func comfySizeFromAspect(ratioW int, ratioH int) (int, int) {
	const base = 1024
	if ratioW >= ratioH {
		return alignComfyDimension(base), alignComfyDimension(base * ratioH / ratioW)
	}
	return alignComfyDimension(base * ratioW / ratioH), alignComfyDimension(base)
}

// alignComfyDimension 对齐到 8 的倍数，最小 8。
func alignComfyDimension(value int) int {
	if value <= 0 {
		return comfyUIDefaultWidth
	}
	return value - value%8
}

func firstComfyUIFormValue(form *multipart.Form, key string) string {
	if values := form.Value[key]; len(values) > 0 {
		return strings.TrimSpace(values[0])
	}
	return ""
}

// replaceComfyUIInlinePlaceholders 替换字符串内所有 {{name}} 占位符；
// 未定义的占位符保持原样，由 ComfyUI 端校验报错。
func replaceComfyUIInlinePlaceholders(value string, vars map[string]any) string {
	var builder strings.Builder
	for {
		start := strings.Index(value, "{{")
		if start < 0 {
			builder.WriteString(value)
			break
		}
		end := strings.Index(value[start:], "}}")
		if end < 0 {
			builder.WriteString(value)
			break
		}
		end += start + 2
		name := strings.TrimSpace(value[start+2 : end-2])
		if replacement, ok := vars[name]; ok {
			builder.WriteString(value[:start])
			builder.WriteString(comfyPlaceholderString(replacement))
		} else {
			builder.WriteString(value[:end])
		}
		value = value[end:]
	}
	return builder.String()
}

func comfyPlaceholderString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	default:
		return fmt.Sprint(typed)
	}
}

// renderComfyUIWorkflow 解析 workflow 模板 JSON 并递归替换 {{name}} 占位符。
// 数字占位符替换为对应 Go 数值类型，序列化时保持 JSON 数字。
func renderComfyUIWorkflow(template string, vars map[string]any) (map[string]any, error) {
	var graph any
	if err := json.Unmarshal([]byte(template), &graph); err != nil {
		return nil, err
	}
	resolved, err := resolveComfyUIPlaceholders(graph, vars)
	if err != nil {
		return nil, err
	}
	typed, ok := resolved.(map[string]any)
	if !ok {
		return nil, errors.New("workflow 模板必须是 JSON 对象")
	}
	return typed, nil
}

func resolveComfyUIPlaceholders(value any, vars map[string]any) (any, error) {
	switch typed := value.(type) {
	case string:
		if strings.HasPrefix(typed, "{{") && strings.HasSuffix(typed, "}}") {
			name := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(typed, "{{"), "}}"))
			if replacement, ok := vars[name]; ok {
				return replacement, nil
			}
		}
		// 支持内嵌占位符：字符串任意位置的 {{name}} 替换为变量的字符串表示，
		// 便于自定义节点使用 "{{width}}x{{height}}" 这类组合尺寸参数。
		if strings.Contains(typed, "{{") {
			return replaceComfyUIInlinePlaceholders(typed, vars), nil
		}
		return typed, nil
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			resolved, err := resolveComfyUIPlaceholders(item, vars)
			if err != nil {
				return nil, err
			}
			result[key] = resolved
		}
		return result, nil
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			resolved, err := resolveComfyUIPlaceholders(item, vars)
			if err != nil {
				return nil, err
			}
			result[index] = resolved
		}
		return result, nil
	default:
		return value, nil
	}
}

func marshalComfyUIPrompt(graph map[string]any) ([]byte, string, error) {
	encoded, err := json.Marshal(map[string]any{
		"prompt":    graph,
		"client_id": "infinite-canvas",
	})
	if err != nil {
		return nil, "", err
	}
	return encoded, "application/json", nil
}

// uploadComfyUIReferenceImage 把 multipart 中的第一张参考图上传到 ComfyUI，
// 返回可在 LoadImage 节点使用的图片名（含子目录）。
func uploadComfyUIReferenceImage(form *multipart.Form, channel model.ModelChannel) (string, error) {
	files := form.File["image"]
	if len(files) == 0 {
		return "", nil
	}
	file, err := files[0].Open()
	if err != nil {
		return "", err
	}
	defer file.Close()

	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	part, err := writer.CreateFormFile("image", files[0].Filename)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(part, file); err != nil {
		return "", err
	}
	_ = writer.Close()

	request, err := http.NewRequest(http.MethodPost, comfyUIBaseURL(channel)+"/upload/image", &buffer)
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := service.HTTPClientForChannel(channel).Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusBadRequest {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 256*1024))
		return "", errors.New(readUpstreamAIErrorMessage(payload, response.StatusCode))
	}
	var result struct {
		Name      string `json:"name"`
		Subfolder string `json:"subfolder"`
		Type      string `json:"type"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return "", errors.New("ComfyUI 图片上传响应解析失败")
	}
	name := strings.TrimSpace(result.Name)
	if name == "" {
		return "", errors.New("ComfyUI 图片上传未返回文件名")
	}
	if subfolder := strings.Trim(result.Subfolder, "/"); subfolder != "" {
		name = subfolder + "/" + name
	}
	return name, nil
}

// copyComfyUIResponse 处理 ComfyUI /prompt 的响应：解析 prompt_id 后轮询
// /history 直到完成，下载输出图片并组装成 OpenAI 兼容格式返回。
func copyComfyUIResponse(w http.ResponseWriter, response *http.Response, request *http.Request, channel model.ModelChannel, logContext aiLogContext, onFailure func()) bool {
	if !isComfyUIChannel(channel) {
		return false
	}
	payload, _ := io.ReadAll(io.LimitReader(response.Body, 512*1024))
	responseBody := string(payload)

	if response.StatusCode >= http.StatusBadRequest {
		writeComfyUIImageError(w, response.StatusCode, readUpstreamAIErrorMessage(payload, response.StatusCode), logContext, responseBody)
		return true
	}

	var submitted struct {
		PromptID string `json:"prompt_id"`
		Error    any    `json:"error"`
	}
	if err := json.Unmarshal(payload, &submitted); err != nil {
		writeComfyUIImageError(w, response.StatusCode, "ComfyUI 提交任务响应解析失败", logContext, responseBody)
		return true
	}
	if submitted.Error != nil {
		if onFailure != nil {
			onFailure()
		}
		writeComfyUIImageError(w, response.StatusCode, readComfyUIPromptError(submitted.Error), logContext, responseBody)
		return true
	}
	promptID := strings.TrimSpace(submitted.PromptID)
	if promptID == "" {
		writeComfyUIImageError(w, response.StatusCode, "ComfyUI 未返回 prompt_id", logContext, responseBody)
		return true
	}

	dataURLs, errorMessage, pollBody := pollComfyUITask(request, channel, promptID)
	if errorMessage != "" {
		if onFailure != nil {
			onFailure()
		}
		writeComfyUIImageError(w, response.StatusCode, errorMessage, logContext, pollBody)
		return true
	}

	items := make([]map[string]any, 0, len(dataURLs))
	for _, dataURL := range dataURLs {
		items = append(items, map[string]any{"url": dataURL})
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
		writeComfyUIImageError(w, response.StatusCode, err.Error(), logContext, pollBody)
		return true
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(encoded)
	saveAIProxyLog(logContext, response.StatusCode, string(encoded), "")
	return true
}

// pollComfyUITask 轮询 ComfyUI 任务结果并下载输出图片（最多 300 次 × 2 秒）。
func pollComfyUITask(request *http.Request, channel model.ModelChannel, promptID string) ([]string, string, string) {
	historyURL := comfyUIBaseURL(channel) + "/history/" + url.PathEscape(promptID)
	for attempt := 0; attempt < 300; attempt++ {
		if attempt > 0 {
			select {
			case <-request.Context().Done():
				return nil, request.Context().Err().Error(), ""
			case <-time.After(2 * time.Second):
			}
		}
		pollRequest, err := http.NewRequestWithContext(request.Context(), http.MethodGet, historyURL, nil)
		if err != nil {
			return nil, err.Error(), ""
		}
		pollResponse, err := service.HTTPClientForChannel(channel).Do(pollRequest)
		if err != nil {
			return nil, err.Error(), ""
		}
		body, _ := io.ReadAll(io.LimitReader(pollResponse.Body, 512*1024))
		_ = pollResponse.Body.Close()
		if pollResponse.StatusCode >= http.StatusBadRequest {
			return nil, readUpstreamAIErrorMessage(body, pollResponse.StatusCode), string(body)
		}

		imageFiles, done, errorMessage := readComfyUIHistoryImageFiles(body, promptID)
		if errorMessage != "" {
			return nil, errorMessage, string(body)
		}
		if done {
			if len(imageFiles) == 0 {
				return nil, "ComfyUI 任务完成但未返回图片", string(body)
			}
			dataURLs := make([]string, 0, len(imageFiles))
			for _, file := range imageFiles {
				dataURL, err := fetchComfyUIImageAsDataURL(request.Context(), channel, file)
				if err != nil {
					return nil, err.Error(), string(body)
				}
				dataURLs = append(dataURLs, dataURL)
			}
			return dataURLs, "", string(body)
		}
	}
	return nil, "ComfyUI 任务超时", ""
}

type comfyUIImageFile struct {
	Filename  string `json:"filename"`
	Subfolder string `json:"subfolder"`
	Type      string `json:"type"`
}

// readComfyUIHistoryImageFiles 从 /history 响应中读取指定 prompt 的输出图片。
func readComfyUIHistoryImageFiles(payload []byte, promptID string) ([]comfyUIImageFile, bool, string) {
	var history map[string]struct {
		Status struct {
			StatusStr string `json:"status_str"`
			Completed bool   `json:"completed"`
		} `json:"status"`
		Outputs map[string]struct {
			Images []comfyUIImageFile `json:"images"`
		} `json:"outputs"`
	}
	if err := json.Unmarshal(payload, &history); err != nil {
		return nil, false, ""
	}
	entry, ok := history[promptID]
	if !ok {
		return nil, false, ""
	}
	if entry.Status.StatusStr == "error" {
		return nil, true, "ComfyUI 任务执行失败"
	}
	if !entry.Status.Completed {
		return nil, false, ""
	}
	var files []comfyUIImageFile
	for _, output := range entry.Outputs {
		files = append(files, output.Images...)
	}
	return files, true, ""
}

// fetchComfyUIImageAsDataURL 通过 /view 下载图片并转成 data URL，保证图片自包含。
func fetchComfyUIImageAsDataURL(ctx context.Context, channel model.ModelChannel, file comfyUIImageFile) (string, error) {
	query := url.Values{}
	query.Set("filename", file.Filename)
	if file.Subfolder != "" {
		query.Set("subfolder", file.Subfolder)
	}
	if file.Type != "" {
		query.Set("type", file.Type)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, comfyUIBaseURL(channel)+"/view?"+query.Encode(), nil)
	if err != nil {
		return "", err
	}
	response, err := service.HTTPClientForChannel(channel).Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusBadRequest {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 256*1024))
		return "", errors.New(readUpstreamAIErrorMessage(payload, response.StatusCode))
	}
	imageBytes, err := io.ReadAll(io.LimitReader(response.Body, 32<<20))
	if err != nil {
		return "", err
	}
	contentType := strings.TrimSpace(response.Header.Get("Content-Type"))
	if contentType == "" || strings.HasPrefix(contentType, "text/plain") || strings.HasPrefix(contentType, "application/octet-stream") {
		contentType = mime.TypeByExtension(filepath.Ext(file.Filename))
	}
	if contentType == "" {
		contentType = http.DetectContentType(imageBytes)
	}
	return "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(imageBytes), nil
}

func readComfyUIPromptError(value any) string {
	if value == nil {
		return "ComfyUI 任务提交失败"
	}
	switch typed := value.(type) {
	case string:
		if strings.TrimSpace(typed) != "" {
			return strings.TrimSpace(typed)
		}
	case map[string]any:
		for _, key := range []string{"message", "detail", "details", "type"} {
			if message := strings.TrimSpace(toStringSafe(typed[key])); message != "" {
				return message
			}
		}
		encoded, _ := json.Marshal(value)
		return string(encoded)
	}
	return "ComfyUI 任务提交失败"
}

func writeComfyUIImageError(w http.ResponseWriter, statusCode int, message string, logContext aiLogContext, responseBody string) {
	body, _ := json.Marshal(map[string]any{
		"code": 500,
		"msg":  message,
		"data": nil,
	})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_, _ = w.Write(body)
	logBody := string(body)
	if strings.TrimSpace(responseBody) != "" {
		logBody = responseBody
	}
	saveAIProxyLog(logContext, statusCode, logBody, message)
}
