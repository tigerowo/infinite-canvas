package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

const autoDLAPIPath = "/api/v1/comfyui"

type AutoDLInputRule struct {
	Type      string   `json:"type"`
	Required  bool     `json:"required"`
	Default   any      `json:"default,omitempty"`
	Min       *float64 `json:"min,omitempty"`
	Max       *float64 `json:"max,omitempty"`
	Options   []struct {
		Label string `json:"label"`
	} `json:"options,omitempty"`
}

type AutoDLWorkflow struct {
	UUID       string                    `json:"uuid"`
	Name       string                    `json:"name"`
	Kind       string                    `json:"kind"`
	InputRules map[string]AutoDLInputRule `json:"input_rules,omitempty"`
}

type autoDLMetadataEntry struct {
	data    json.RawMessage
	expires time.Time
}

var autoDLMetadataCache = struct {
	sync.Mutex
	items map[string]autoDLMetadataEntry
}{items: make(map[string]autoDLMetadataEntry)}

func IsAutoDLChannel(channel model.ModelChannel) bool {
	return strings.EqualFold(strings.TrimSpace(channel.Protocol), ModelChannelProtocolAutoDL)
}

func AutoDLModelKind(modelName string) string {
	switch strings.TrimSpace(modelName) {
	case "indextts2-v1":
		return "audio"
	case "minimax_h3_b99_002", "minimax_h3_b99_001", "minimax_h3_b99_003_12s",
		"wan2.2animate-v4-motion_retargeting", "minimax_h3_image_audio_to_video_v2_15s",
		"minimax_h3_lightx2v_v5_15s", "minimax_h3_image_audio_to_video_v2",
		"minimax_h3_image_audio_to_video", "minimax_h3_lightx2v_v5",
		"minimax_h3_lightx2v_no_pic", "minimax_h3_lightx2v",
		"minimax_h3_zm_u24", "minimax_h3_zm_u08":
		return "video"
	default:
		return "unsupported"
	}
}

func BuildAutoDLURL(baseURL string, path string) string {
	return strings.TrimRight(strings.TrimSpace(baseURL), "/") + path
}

func AutoDLTaskPath(id string, poll bool) string {
	prefix := autoDLAPIPath + "/comfyui_workflow/"
	if poll {
		prefix += "result/"
	}
	return prefix + url.PathEscape(strings.TrimSpace(id))
}

func AutoDLWorkflows(baseURL string) ([]AutoDLWorkflow, error) {
	items := []AutoDLWorkflow{}
	seen := map[string]bool{}
	for page := 1; ; page++ {
		body, _ := json.Marshal(map[string]int{"page_index": page, "page_size": 100})
		data, err := readAutoDLMetadata(baseURL, autoDLAPIPath+"/workflows", body)
		if err != nil {
			return nil, err
		}
		var result struct {
			List    []AutoDLWorkflow `json:"list"`
			MaxPage int              `json:"max_page"`
		}
		if err := json.Unmarshal(data, &result); err != nil {
			return nil, errors.New("AutoDL 工作流列表格式错误")
		}
		for _, item := range result.List {
			if item.UUID != "" && !seen[item.UUID] {
				item.Kind = AutoDLModelKind(item.UUID)
				items = append(items, item)
				seen[item.UUID] = true
			}
		}
		if page >= result.MaxPage || len(result.List) == 0 {
			return items, nil
		}
	}
}

func AutoDLWorkflowDetail(baseURL string, id string) (AutoDLWorkflow, error) {
	data, err := readAutoDLMetadata(baseURL, autoDLAPIPath+"/workflows/"+url.PathEscape(strings.TrimSpace(id)), nil)
	if err != nil {
		return AutoDLWorkflow{}, err
	}
	var workflow AutoDLWorkflow
	if json.Unmarshal(data, &workflow) != nil || workflow.UUID != strings.TrimSpace(id) || len(workflow.InputRules) == 0 {
		return AutoDLWorkflow{}, errors.New("AutoDL 工作流详情格式错误")
	}
	workflow.Kind = AutoDLModelKind(workflow.UUID)
	return workflow, nil
}

func readAutoDLMetadata(baseURL string, path string, body []byte) (json.RawMessage, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("AutoDL 渠道地址格式错误")
	}
	requestURL := BuildAutoDLURL(baseURL, path)
	key := requestURL + string(body)
	autoDLMetadataCache.Lock()
	cached, found := autoDLMetadataCache.items[key]
	autoDLMetadataCache.Unlock()
	if found && time.Now().Before(cached.expires) {
		return cached.data, nil
	}
	method := http.MethodGet
	if len(body) > 0 {
		method = http.MethodPost
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, requestURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := SafeProxyHTTPClient().Do(request)
	if err != nil {
		return nil, fmt.Errorf("AutoDL 工作流读取失败：%w", err)
	}
	defer response.Body.Close()
	var root struct {
		Code string          `json:"code"`
		Msg  string          `json:"msg"`
		Data json.RawMessage `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&root) != nil {
		return nil, errors.New("AutoDL 工作流响应格式错误")
	}
	if response.StatusCode >= http.StatusBadRequest || !strings.EqualFold(root.Code, "Success") {
		return nil, errors.New(firstNonEmpty(root.Msg, root.Code, "AutoDL 工作流读取失败"))
	}
	autoDLMetadataCache.Lock()
	for entry, value := range autoDLMetadataCache.items {
		if time.Now().After(value.expires) {
			delete(autoDLMetadataCache.items, entry)
		}
	}
	autoDLMetadataCache.items[key] = autoDLMetadataEntry{root.Data, time.Now().Add(10 * time.Minute)}
	autoDLMetadataCache.Unlock()
	return root.Data, nil
}

// 账号代理与直连请求规划共用字段映射；范围、默认值和枚举只读上游规则。
func TranslateAutoDLRequest(baseURL string, modelName string, input map[string]any) ([]byte, error) {
	workflow, err := AutoDLWorkflowDetail(baseURL, modelName)
	if err != nil {
		return nil, err
	}
	rules := workflow.InputRules
	output := map[string]any{}
	for source, target := range map[string]string{
		"prompt": "prompt", "input": "prompt_text", "reference_audio": "prompt_simple",
		"first_frame_url": "first_frame", "last_frame_url": "last_frame",
	} {
		if _, exists := rules[target]; exists {
			if value := autoDLString(input[source]); value != "" {
				output[target] = value
			}
		}
	}
	for source, prefix := range map[string]string{"input_reference": "ref_image", "audio_reference": "ref_audio", "video_reference": "ref_video"} {
		values := autoDLStrings(input[source+"[]"])
		limit := 0
		for field := range rules {
			if field == prefix || strings.HasPrefix(field, prefix+"_") {
				limit++
			}
		}
		if limit > 0 && len(values) > limit {
			return nil, fmt.Errorf("AutoDL 当前工作流最多支持 %d 个 %s 参考素材", limit, source)
		}
		for index, item := range values {
			field := prefix + "_" + strconv.Itoa(index)
			if _, exists := rules[prefix]; exists && index == 0 {
				field = prefix
			}
			if _, exists := rules[field]; exists {
				output[field] = item
			}
		}
	}
	for _, field := range []string{"duration", "audio_duration"} {
		if rule, exists := rules[field]; exists {
			value := autoDLString(input["seconds"])
			if value == "" {
				value = autoDLString(rule.Default)
			}
			seconds, err := strconv.ParseFloat(value, 64)
			if err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) {
				return nil, errors.New("AutoDL 时长格式错误")
			}
			if rule.Type == "integer" {
				seconds = math.Floor(seconds)
			}
			if rule.Min != nil {
				seconds = math.Max(seconds, *rule.Min)
			}
			if rule.Max != nil {
				seconds = math.Min(seconds, *rule.Max)
			}
			output[field] = seconds
		}
	}
	if rule, exists := rules["resolution"]; exists {
		output["resolution"] = autoDLResolution(input, rule)
	}
	if workflow.Kind == "audio" {
		output["emo_control_method"] = rules["emo_control_method"].Default
	}
	for field, rule := range rules {
		if rule.Required && field != "seed" && (!strings.HasPrefix(field, "emo_") || field == "emo_control_method") && autoDLString(output[field]) == "" {
			return nil, fmt.Errorf("AutoDL 缺少必填参数：%s", field)
		}
	}
	return json.Marshal(output)
}

func autoDLString(value any) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func autoDLStrings(value any) []string {
	items, _ := value.([]any)
	result := []string{}
	for _, item := range items {
		if value := autoDLString(item); value != "" {
			result = append(result, value)
		}
	}
	return result
}

func autoDLResolution(input map[string]any, rule AutoDLInputRule) string {
	quality := autoDLString(input["resolution_name"])
	if quality == "" && autoDLString(input["size"]) == "" {
		return autoDLString(rule.Default)
	}
	for _, option := range rule.Options {
		if option.Label == quality {
			return option.Label
		}
	}
	quality = strings.TrimSuffix(strings.ToLower(quality), "p")
	if quality == "2k" {
		quality = "1440"
	} else if quality == "4k" {
		quality = "2160"
	}
	target, _ := strconv.ParseFloat(quality, 64)
	if target <= 0 || math.IsNaN(target) || math.IsInf(target, 0) {
		numeric, _, _ := strings.Cut(autoDLString(rule.Default), "p")
		_, _ = fmt.Sscanf(numeric, "%f", &target)
	}
	size := strings.NewReplacer(":", "x", "*", "x").Replace(autoDLString(input["size"]))
	var width, height float64
	_, _ = fmt.Sscanf(size, "%fx%f", &width, &height)
	orientation := ""
	if width > 0 && height > 0 {
		switch {
		case width > height:
			orientation = "横"
		case width < height:
			orientation = "竖"
		default:
			orientation = "(1:1)"
		}
	}
	best, bestOrientation, distance := "", false, math.Inf(1)
	for _, option := range rule.Options {
		var pixels float64
		numeric, _, _ := strings.Cut(option.Label, "p")
		_, _ = fmt.Sscanf(numeric, "%f", &pixels)
		if strings.Contains(option.Label, "px(") {
			var width, height float64
			_, _ = fmt.Sscanf(numeric, "%f*%f", &width, &height)
			pixels = math.Min(width, height)
		}
		matchesOrientation := orientation == "" || strings.Contains(option.Label, orientation)
		delta := math.Abs(pixels - target)
		if best == "" || matchesOrientation && !bestOrientation || matchesOrientation == bestOrientation && delta < distance {
			best, bestOrientation, distance = option.Label, matchesOrientation, delta
		}
	}
	if best != "" {
		return best
	}
	return autoDLString(rule.Default)
}

type AutoDLTaskResult struct {
	ID       string
	Status   string
	URL      string
	MimeType string
}

func ReadAutoDLTask(payload []byte, kind string) (AutoDLTaskResult, error) {
	var root struct {
		Code string `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			TaskID  string `json:"task_id"`
			Status  string `json:"status"`
			Message string `json:"message"`
			Results []struct {
				Type       string `json:"type"`
				URL        string `json:"url"`
				FileType   string `json:"file_type"`
				OutputType string `json:"output_type"`
			} `json:"results"`
		} `json:"data"`
	}
	if json.Unmarshal(payload, &root) != nil {
		return AutoDLTaskResult{}, errors.New("AutoDL 任务响应格式错误")
	}
	result := AutoDLTaskResult{ID: strings.TrimSpace(root.Data.TaskID), Status: NormalizeVideoTaskStatus(root.Data.Status)}
	if !strings.EqualFold(root.Code, "Success") {
		return result, errors.New(firstNonEmpty(root.Data.Message, root.Msg, root.Code, "AutoDL 任务生成失败"))
	}
	if result.Status == "failed" {
		return result, errors.New(firstNonEmpty(root.Data.Message, root.Msg, "AutoDL 任务生成失败"))
	}
	for _, item := range root.Data.Results {
		parsed, err := url.Parse(strings.TrimSpace(item.URL))
		if item.Type == kind && (item.OutputType == "" || item.OutputType == "output") && err == nil && parsed.Host != "" && (parsed.Scheme == "https" || parsed.Scheme == "http") {
			result.URL = strings.TrimSpace(item.URL)
			if item.FileType != "" {
				result.MimeType = kind + "/" + strings.TrimPrefix(item.FileType, ".")
			}
			if result.MimeType == "audio/mp3" {
				result.MimeType = "audio/mpeg"
			}
			break
		}
	}
	if result.Status == "completed" && result.URL == "" {
		return result, errors.New("AutoDL 任务完成但没有返回结果地址")
	}
	return result, nil
}

func WaitAutoDLAudio(ctx context.Context, channel model.ModelChannel, payload []byte) (AutoDLTaskResult, error) {
	result, err := ReadAutoDLTask(payload, "audio")
	if err != nil {
		return result, err
	}
	if result.ID == "" {
		return result, errors.New("AutoDL 没有返回任务 ID")
	}
	if result.Status == "completed" {
		return result, nil
	}
	client := HTTPClientForChannel(channel)
	ctx, cancel := context.WithTimeout(ctx, client.Timeout)
	defer cancel()
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return result, errors.New("AutoDL 音频任务等待超时或已取消")
		case <-ticker.C:
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, BuildAutoDLURL(channel.BaseURL, AutoDLTaskPath(result.ID, true)), nil)
			if err != nil {
				return result, err
			}
			SetModelChannelAuthHeader(request, channel)
			response, err := client.Do(request)
			if err != nil {
				return result, err
			}
			body, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
			response.Body.Close()
			if readErr != nil {
				return result, readErr
			}
			polled, err := ReadAutoDLTask(body, "audio")
			if err != nil {
				return polled, err
			}
			if response.StatusCode >= http.StatusBadRequest {
				return polled, fmt.Errorf("AutoDL 任务查询失败：HTTP %d", response.StatusCode)
			}
			if polled.Status == "completed" {
				return polled, nil
			}
		}
	}
}
