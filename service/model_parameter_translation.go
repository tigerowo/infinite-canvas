package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"mime/multipart"
	"net/http"
	"net/url"
	"reflect"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dop251/goja"
	"github.com/dop251/goja/ast"
	"github.com/dop251/goja/parser"
	"github.com/tigerowo/infinite-canvas/model"
)

var parameterTranslationVariables = []string{
	"model", "prompt", "size", "aspectRatio", "quality", "count", "images",
	"resolution", "seconds", "mode", "negativePrompt", "generateAudio", "watermark",
	"draftTaskId",
	"videos", "audios", "firstFrame", "lastFrame", "voice", "audioFormat", "speed", "instructions",
}
var parameterTranslationMethods = []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
var parameterTranslationCache = struct {
	sync.Mutex
	items map[string]map[string]*goja.Program
}{items: map[string]map[string]*goja.Program{}}

// 解析配置仅用于校验和匹配，不执行用户表达式。空模型块保持系统默认调用。
func ParameterTranslationModels(source string) ([]string, error) {
	programs, err := parameterTranslationPrograms(source)
	if err != nil {
		return nil, err
	}
	models := make([]string, 0, len(programs))
	for name := range programs {
		models = append(models, name)
	}
	sort.Strings(models)
	return models, nil
}

func parameterTranslationPrograms(source string) (map[string]*goja.Program, error) {
	if strings.TrimSpace(source) == "" {
		return nil, nil
	}
	parameterTranslationCache.Lock()
	defer parameterTranslationCache.Unlock()
	if cached, ok := parameterTranslationCache.items[source]; ok {
		return cached, nil
	}
	text := "(" + source + "\n)"
	parsed, err := parser.ParseFile(nil, "自定传参转译", text, 0)
	if err != nil {
		return nil, fmt.Errorf("自定传参转译语法错误：%w", err)
	}
	if len(parsed.Body) != 1 {
		return nil, errors.New("渠道配置必须是一份对象")
	}
	statement, ok := parsed.Body[0].(*ast.ExpressionStatement)
	if !ok {
		return nil, errors.New("渠道配置必须是一份对象")
	}
	root, ok := statement.Expression.(*ast.ObjectLiteral)
	if !ok {
		return nil, errors.New("渠道配置必须是一份对象")
	}
	fields, err := parameterTranslationProperties(root)
	if err != nil {
		return nil, err
	}
	validatePoll := func(expression ast.Expression) error {
		if expression == nil {
			return nil
		}
		if value, ok := expression.(*ast.BooleanLiteral); ok && !value.Value {
			return nil
		}
		object, ok := expression.(*ast.ObjectLiteral)
		if !ok {
			return errors.New("poll 必须是查询配置对象或 false")
		}
		_, err := parameterTranslationProperties(object)
		return err
	}
	if err := validatePoll(fields["poll"]); err != nil {
		return nil, err
	}
	for name := range fields {
		if name != "models" && name != "headers" && name != "poll" {
			return nil, fmt.Errorf("不支持的渠道配置字段：%s", name)
		}
	}
	models, ok := fields["models"].(*ast.ObjectLiteral)
	if !ok {
		return nil, errors.New("请在 models 中逐个填写模型配置")
	}
	rules, err := parameterTranslationProperties(models)
	if err != nil {
		return nil, err
	}
	fragment := func(expression ast.Expression, fallback string) string {
		if expression == nil {
			return fallback
		}
		return text[int(expression.Idx0())-1 : int(expression.Idx1())-1]
	}
	programs := map[string]*goja.Program{}
	for name, expression := range rules {
		rule, ok := expression.(*ast.ObjectLiteral)
		if !ok || strings.TrimSpace(name) == "" {
			return nil, errors.New("每个模型必须有明确名称和配置对象")
		}
		if len(rule.Value) == 0 {
			continue
		}
		items, err := parameterTranslationProperties(rule)
		if err != nil {
			return nil, err
		}
		if err := validatePoll(items["poll"]); err != nil {
			return nil, err
		}
		requests := 0
		for _, method := range parameterTranslationMethods {
			if request, present := items[method]; present {
				requests++
				if _, ok := request.(*ast.ObjectLiteral); !ok {
					return nil, fmt.Errorf("模型 %s 的请求必须是配置对象", name)
				}
			}
		}
		if requests != 1 {
			return nil, fmt.Errorf("模型 %s 必须填写且仅填写一种请求方法", name)
		}
		// 只求值当前模型，其他媒体模型的表达式不会因本次缺少其参数而执行。
		code := fmt.Sprintf("({headers:(%s),poll:(%s),rule:(%s)})", fragment(fields["headers"], "{}"), fragment(fields["poll"], "false"), fragment(expression, "{}"))
		program, err := goja.Compile("自定传参转译", code, true)
		if err != nil {
			return nil, err
		}
		programs[name] = program
	}
	if len(parameterTranslationCache.items) >= 32 {
		for key := range parameterTranslationCache.items {
			delete(parameterTranslationCache.items, key)
			break
		}
	}
	parameterTranslationCache.items[source] = programs
	return programs, nil
}

func parameterTranslationProperties(object *ast.ObjectLiteral) (map[string]ast.Expression, error) {
	fields := map[string]ast.Expression{}
	for _, property := range object.Value {
		item, ok := property.(*ast.PropertyKeyed)
		if !ok || item.Computed || item.Kind != ast.PropertyKindValue {
			return nil, errors.New("配置字段和模型名称必须使用静态名称")
		}
		name := ""
		switch key := item.Key.(type) {
		case *ast.Identifier:
			name = key.Name.String()
		case *ast.StringLiteral:
			name = key.Value.String()
		default:
			return nil, errors.New("配置字段和模型名称必须使用静态名称")
		}
		if _, present := fields[name]; present {
			return nil, fmt.Errorf("配置字段不能重复：%s", name)
		}
		fields[name] = item.Value
	}
	return fields, nil
}

type ParameterTranslation struct {
	runtime    *goja.Runtime
	root       *goja.Object
	rule       *goja.Object
	poll       *goja.Object
	success    []any
	failure    []any
	channel    model.ModelChannel
	Client     *http.Client
	Submission *http.Request
}

func parameterTranslationValue(object *goja.Object, name string) goja.Value {
	if !slices.Contains(object.GetOwnPropertyNames(), name) {
		return goja.Undefined()
	}
	if value := object.Get(name); value != nil {
		return value
	}
	return goja.Undefined()
}

func NewParameterTranslation(channel model.ModelChannel, modelName string, variables map[string]any) (*ParameterTranslation, error) {
	programs, err := parameterTranslationPrograms(channel.ParameterTranslation)
	if err != nil || programs[modelName] == nil {
		return nil, err
	}
	runtime := goja.New()
	for _, name := range parameterTranslationVariables {
		_ = runtime.Set(name, goja.Undefined())
	}
	for _, name := range []string{"images", "videos", "audios"} {
		_ = runtime.Set(name, []string{})
	}
	_ = runtime.Set("firstFrame", "")
	_ = runtime.Set("lastFrame", "")
	for _, name := range parameterTranslationVariables {
		if value, present := variables[name]; present {
			_ = runtime.Set(name, value)
		}
	}
	_ = runtime.Set("model", modelName)
	translation := &ParameterTranslation{runtime: runtime, channel: channel, Client: HTTPClientForChannel(channel)}
	value, err := translation.run(func() (goja.Value, error) { return runtime.RunProgram(programs[modelName]) })
	if err != nil {
		return nil, fmt.Errorf("自定配置求值失败：%w", err)
	}
	translation.root = value.ToObject(runtime)
	translation.rule = translation.root.Get("rule").ToObject(runtime)
	poll := parameterTranslationValue(translation.rule, "poll")
	if goja.IsUndefined(poll) {
		poll = translation.root.Get("poll")
	}
	if !goja.IsUndefined(poll) && !goja.IsNull(poll) && poll.ToBoolean() {
		if object, ok := poll.(*goja.Object); ok {
			translation.poll = object
		} else {
			return nil, errors.New("poll 必须是查询配置对象或 false")
		}
	}
	if translation.poll != nil {
		value, err := translation.jsonValue(parameterTranslationValue(translation.poll, "success"))
		if err != nil {
			return nil, err
		}
		success, ok := value.([]any)
		if !ok || len(success) == 0 || goja.IsUndefined(parameterTranslationValue(translation.poll, "status")) || goja.IsUndefined(parameterTranslationValue(translation.poll, "taskId")) {
			return nil, errors.New("任务查询需要 taskId、status 和非空 success 状态值")
		}
		translation.success = success
		failure, err := translation.jsonValue(parameterTranslationValue(translation.poll, "failure"))
		if err != nil {
			return nil, err
		}
		if failure != nil {
			var ok bool
			translation.failure, ok = failure.([]any)
			if !ok {
				return nil, errors.New("failure 必须是状态值数组")
			}
		}
		if _, _, err := translation.request(context.Background(), true, "任务ID"); err != nil {
			return nil, err
		}
	}
	if _, _, err := translation.request(context.Background(), false, ""); err != nil {
		return nil, err
	}
	return translation, nil
}

type ParameterTranslationInput struct {
	Kind      string         `json:"kind"`
	Variables map[string]any `json:"variables"`
}

func ReadParameterTranslationInput(body []byte) (*ParameterTranslationInput, error) {
	if !bytes.Contains(body, []byte(`"_parameterTranslation"`)) {
		return nil, nil
	}
	var request struct {
		Input *ParameterTranslationInput `json:"_parameterTranslation"`
	}
	if err := json.Unmarshal(body, &request); err != nil || request.Input == nil {
		return nil, errors.New("自定义调用参数格式错误")
	}
	if !slices.Contains([]string{"image", "video", "audio"}, request.Input.Kind) {
		return nil, errors.New("自定义调用缺少媒体类型")
	}
	for key, value := range request.Input.Variables {
		if !slices.Contains(parameterTranslationVariables, key) {
			return nil, fmt.Errorf("不支持的调用变量：%s", key)
		}
		if slices.Contains([]string{"images", "videos", "audios"}, key) {
			values, ok := value.([]any)
			if !ok {
				return nil, fmt.Errorf("%s 必须是素材地址数组", key)
			}
			for _, item := range values {
				if _, ok := item.(string); !ok {
					return nil, fmt.Errorf("%s 必须是素材地址数组", key)
				}
			}
		} else {
			switch value.(type) {
			case string, float64, bool:
			default:
				return nil, fmt.Errorf("%s 必须是文字、数字或布尔值", key)
			}
		}
	}
	return request.Input, nil
}

type parameterTranslationSnapshot struct {
	Source    string                                `json:"source"`
	BaseURL   string                                `json:"baseUrl"`
	Protocol  string                                `json:"protocol"`
	Timeout   int                                   `json:"timeout"`
	Variables map[string]any                        `json:"variables"`
	TaskIDs   []string                              `json:"taskIds"`
	Completed map[string]ParameterTranslationResult `json:"completed"`
}

func (translation *ParameterTranslation) Snapshot(input ParameterTranslationInput, result ParameterTranslationResult) string {
	snapshot := parameterTranslationSnapshot{Source: translation.channel.ParameterTranslation, BaseURL: translation.channel.BaseURL, Protocol: translation.channel.Protocol, Timeout: translation.channel.Timeout, Variables: input.Variables, TaskIDs: result.TaskIDs, Completed: map[string]ParameterTranslationResult{}}
	if result.ContentURL != "" {
		snapshot.Completed[""] = ParameterTranslationResult{Status: result.Status, Progress: result.Progress, ContentURL: result.ContentURL}
	}
	encoded, _ := json.Marshal(snapshot)
	return string(encoded)
}

func videoTaskParameterTranslation(task model.VideoTask, channel model.ModelChannel) (*ParameterTranslation, parameterTranslationSnapshot, error) {
	var snapshot parameterTranslationSnapshot
	if json.Unmarshal([]byte(task.ParameterTranslationSnapshot), &snapshot) != nil {
		return nil, snapshot, errors.New("视频任务自定义查询快照无效")
	}
	channel.ParameterTranslation, channel.BaseURL, channel.Protocol, channel.Timeout = snapshot.Source, snapshot.BaseURL, snapshot.Protocol, snapshot.Timeout
	translation, err := NewParameterTranslation(channel, task.Model, snapshot.Variables)
	if err != nil {
		return nil, snapshot, err
	}
	if translation == nil {
		return nil, snapshot, errors.New("视频任务快照缺少模型配置")
	}
	return translation, snapshot, nil
}

func ParameterTranslationVideoContent(ctx context.Context, task model.VideoTask, channel model.ModelChannel) (*http.Response, error) {
	translation, snapshot, err := videoTaskParameterTranslation(task, channel)
	if err != nil {
		return nil, err
	}
	taskID := ""
	if len(snapshot.TaskIDs) > 0 {
		taskID = snapshot.TaskIDs[0]
	}
	if taskID != "" && snapshot.Completed[taskID].ContentURL == "" {
		result, err := translation.Send(ctx, "video", true, taskID)
		if err != nil {
			return nil, err
		}
		if len(result.Body) == 0 {
			return nil, errors.New("视频查询接口没有返回视频文件")
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{result.ContentType}}, Body: io.NopCloser(bytes.NewReader(result.Body))}, nil
	}
	request, _, err := translation.request(ctx, taskID != "", taskID)
	if err != nil {
		return nil, err
	}
	content, err := url.Parse(snapshot.Completed[taskID].ContentURL)
	if err != nil || content.User != nil || content.Scheme != request.URL.Scheme || content.Host != request.URL.Host {
		return nil, errors.New("视频内容地址无效")
	}
	params := request.URL.Query()
	maps.Copy(params, content.Query())
	content.RawQuery = params.Encode()
	request.URL, request.Method = content, http.MethodGet
	request.Body, request.GetBody, request.ContentLength = nil, nil, 0
	return translation.Client.Do(request)
}

func PollParameterTranslationVideo(ctx context.Context, task model.VideoTask, channel model.ModelChannel) (VideoTaskPollUpdate, error) {
	translation, snapshot, err := videoTaskParameterTranslation(task, channel)
	if err != nil {
		return VideoTaskPollUpdate{}, err
	}
	if len(snapshot.TaskIDs) == 0 {
		return VideoTaskPollUpdate{}, errors.New("视频任务自定义查询快照无效")
	}
	if snapshot.Completed == nil {
		snapshot.Completed = map[string]ParameterTranslationResult{}
	}
	update := VideoTaskPollUpdate{Status: "processing"}
	progress := 0
	for _, id := range snapshot.TaskIDs {
		result, done := snapshot.Completed[id]
		if !done {
			result, err = translation.Send(ctx, "video", true, id)
			if err != nil {
				if !result.Retryable && result.StatusCode != http.StatusTooManyRequests {
					return VideoTaskPollUpdate{Status: "failed", Error: err.Error(), ErrorDetail: err.Error(), ResponseBody: result.ResponseBody, StatusCode: result.StatusCode}, nil
				}
				update.ErrorDetail = err.Error()
			}
			if result.Status == "completed" {
				snapshot.Completed[id] = ParameterTranslationResult{Status: result.Status, Progress: result.Progress, URLs: result.URLs[:min(1, len(result.URLs))], ContentURL: result.ContentURL, StatusCode: result.StatusCode}
			}
		}
		progress += result.Progress
		update.ResponseBody, update.StatusCode = result.ResponseBody, result.StatusCode
	}
	update.Progress = progress / len(snapshot.TaskIDs)
	if len(snapshot.Completed) == len(snapshot.TaskIDs) {
		result := snapshot.Completed[snapshot.TaskIDs[0]]
		update.Status, update.Progress = "completed", 100
		if len(result.URLs) > 0 {
			update.VideoURL = result.URLs[0]
		}
	}
	encoded, _ := json.Marshal(snapshot)
	update.ParameterTranslationSnapshot = string(encoded)
	return update, nil
}

func (translation *ParameterTranslation) run(action func() (goja.Value, error)) (goja.Value, error) {
	done := make(chan struct{})
	timer := time.AfterFunc(time.Second, func() { translation.runtime.Interrupt("自定配置执行超时"); close(done) })
	defer func() {
		if !timer.Stop() {
			<-done
		}
		translation.runtime.ClearInterrupt()
	}()
	return action()
}

func (translation *ParameterTranslation) selectValue(selector goja.Value, payload any) (any, error) {
	if goja.IsUndefined(selector) || goja.IsNull(selector) {
		return payload, nil
	}
	if function, ok := goja.AssertFunction(selector); ok {
		value, err := translation.run(func() (goja.Value, error) { return function(goja.Undefined(), translation.runtime.ToValue(payload)) })
		if err != nil {
			return nil, fmt.Errorf("响应解析失败：%w", err)
		}
		if goja.IsUndefined(value) || goja.IsNull(value) {
			return nil, nil
		}
		if value.ExportType() == reflect.TypeFor[*goja.Promise]() {
			return nil, errors.New("响应提取函数必须同步返回结果")
		}
		return translation.jsonValue(value)
	}
	if selector.ExportType() != reflect.TypeFor[string]() {
		return nil, errors.New("响应提取必须是字段路径或同步函数")
	}
	path, ok := selector.Export().(string)
	if !ok {
		return nil, errors.New("响应提取必须是字段路径或同步函数")
	}
	value := payload
	if path == "" {
		return value, nil
	}
	for _, field := range strings.Split(path, ".") {
		switch object := value.(type) {
		case map[string]any:
			value = object[field]
		case []any:
			index, err := strconv.Atoi(field)
			if err != nil || index < 0 || index >= len(object) {
				return nil, nil
			}
			value = object[index]
		default:
			return nil, nil
		}
	}
	return value, nil
}

func (translation *ParameterTranslation) jsonValue(value goja.Value) (any, error) {
	if goja.IsUndefined(value) || goja.IsNull(value) {
		return nil, nil
	}
	stringify, _ := goja.AssertFunction(translation.runtime.Get("JSON").ToObject(translation.runtime).Get("stringify"))
	encoded, err := translation.run(func() (goja.Value, error) { return stringify(goja.Undefined(), value) })
	if err != nil {
		return nil, err
	}
	var result any
	if json.Unmarshal([]byte(encoded.String()), &result) != nil {
		return nil, errors.New("配置值必须可序列化")
	}
	return result, nil
}

type parameterTranslationRequest struct {
	URL          string          `json:"url"`
	Headers      map[string]any  `json:"headers"`
	Params       map[string]any  `json:"params"`
	Body         json.RawMessage `json:"body"`
	Format       string          `json:"format"`
	ResponseType string          `json:"responseType"`
}

func (translation *ParameterTranslation) request(ctx context.Context, query bool, taskID string, prepared ...*http.Request) (*http.Request, string, error) {
	if len(prepared) > 0 {
		return prepared[0], "blob", nil
	}
	rule := translation.rule
	if query {
		if translation.poll == nil {
			return nil, "", errors.New("缺少任务查询配置")
		}
		rule = translation.poll
	}
	method := ""
	var requestValue goja.Value
	for _, candidate := range parameterTranslationMethods {
		if value := parameterTranslationValue(rule, candidate); !goja.IsUndefined(value) {
			if method != "" {
				return nil, "", errors.New("必须填写且仅填写一种请求方法")
			}
			method, requestValue = candidate, value
		}
	}
	if method == "" {
		return nil, "", errors.New("缺少请求方法")
	}
	stringify, _ := goja.AssertFunction(translation.runtime.Get("JSON").ToObject(translation.runtime).Get("stringify"))
	encoded, err := translation.run(func() (goja.Value, error) { return stringify(goja.Undefined(), requestValue) })
	if err != nil {
		return nil, "", err
	}
	var plan parameterTranslationRequest
	if err := json.Unmarshal([]byte(encoded.String()), &plan); err != nil {
		return nil, "", errors.New("请求配置必须是可序列化的对象")
	}
	if strings.TrimSpace(plan.URL) == "" {
		return nil, "", errors.New("自定配置缺少接口地址 url")
	}
	if plan.ResponseType == "" {
		plan.ResponseType = "json"
	}
	if plan.ResponseType != "json" && plan.ResponseType != "text" && plan.ResponseType != "blob" && plan.ResponseType != "arraybuffer" {
		return nil, "", errors.New("不支持的返回数据格式")
	}
	if plan.Format == "" {
		plan.Format = "json"
	}
	target := strings.ReplaceAll(plan.URL, "{taskId}", strings.ReplaceAll(url.QueryEscape(taskID), "+", "%20"))
	target = strings.ReplaceAll(target, "{channelKey}", strings.ReplaceAll(url.QueryEscape(translation.channel.APIKey), "+", "%20"))
	parsed, err := url.Parse(target)
	if err != nil {
		return nil, "", err
	}
	if !parsed.IsAbs() {
		base, baseErr := url.Parse(translation.channel.BaseURL)
		if baseErr != nil {
			return nil, "", baseErr
		}
		path := strings.TrimRight(base.EscapedPath(), "/") + "/" + strings.TrimLeft(parsed.EscapedPath(), "/")
		base.Path, err = url.PathUnescape(path)
		if err != nil {
			return nil, "", err
		}
		base.RawPath = path
		params := base.Query()
		for key, values := range parsed.Query() {
			params[key] = values
		}
		base.RawQuery, base.Fragment = params.Encode(), parsed.Fragment
		parsed = base
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return nil, "", errors.New("接口地址必须是 HTTP 或 HTTPS 地址")
	}
	replace := func(value string) string {
		return strings.ReplaceAll(strings.ReplaceAll(value, "{taskId}", taskID), "{channelKey}", translation.channel.APIKey)
	}
	fieldText := func(value any) string {
		if text, ok := value.(string); ok {
			return replace(text)
		}
		encoded, _ := json.Marshal(value)
		return replace(string(encoded))
	}
	queryValues := parsed.Query()
	for key, value := range plan.Params {
		queryValues.Del(key)
		if values, ok := value.([]any); ok {
			if len(values) == 0 {
				queryValues.Set(key, "")
			}
			for _, value := range values {
				queryValues.Add(key, fieldText(value))
			}
		} else {
			queryValues.Set(key, fieldText(value))
		}
	}
	parsed.RawQuery = queryValues.Encode()
	var body io.Reader
	contentType := ""
	// 在 JSON 编码后替换 token 会破坏含引号的值，所以先递归替换字符串值。
	var bodyValue any
	if len(plan.Body) > 0 {
		if err := json.Unmarshal(plan.Body, &bodyValue); err != nil {
			return nil, "", err
		}
		bodyValue = replaceParameterTranslationValues(bodyValue, replace)
	}
	switch plan.Format {
	case "json":
		if len(plan.Body) > 0 {
			encoded, err := json.Marshal(bodyValue)
			if err != nil {
				return nil, "", err
			}
			body, contentType = bytes.NewReader(encoded), "application/json"
		}
	case "raw":
		if len(plan.Body) > 0 {
			body = strings.NewReader(fieldText(bodyValue))
		}
	case "formData", "urlencoded":
		fields, ok := bodyValue.(map[string]any)
		if !ok {
			return nil, "", errors.New("表单请求体必须是字段对象")
		}
		values := url.Values{}
		for key, value := range fields {
			if items, ok := value.([]any); ok {
				if len(items) == 0 {
					values.Set(key, "")
				}
				for _, item := range items {
					values.Add(key, fieldText(item))
				}
			} else {
				values.Set(key, fieldText(value))
			}
		}
		if plan.Format == "urlencoded" {
			body, contentType = strings.NewReader(values.Encode()), "application/x-www-form-urlencoded"
		} else {
			var buffer bytes.Buffer
			writer := multipart.NewWriter(&buffer)
			for key, values := range values {
				for _, value := range values {
					if err := writer.WriteField(key, value); err != nil {
						return nil, "", err
					}
				}
			}
			if err := writer.Close(); err != nil {
				return nil, "", err
			}
			body, contentType = &buffer, writer.FormDataContentType()
		}
	default:
		return nil, "", errors.New("不支持的请求体格式")
	}
	request, err := http.NewRequestWithContext(ctx, method, parsed.String(), body)
	if err != nil {
		return nil, "", err
	}
	headers := map[string]any{}
	common := translation.root.Get("headers")
	if !goja.IsUndefined(common) && !goja.IsNull(common) {
		value, err := translation.run(func() (goja.Value, error) { return stringify(goja.Undefined(), common) })
		if err != nil {
			return nil, "", err
		}
		if json.Unmarshal([]byte(value.String()), &headers) != nil {
			return nil, "", errors.New("headers 必须是字段对象")
		}
	}
	customAuth := strings.Contains(encoded.String(), "{channelKey}")
	for key, value := range headers {
		if strings.Contains(fmt.Sprint(value), "{channelKey}") {
			customAuth = true
		}
		request.Header.Set(key, fieldText(value))
	}
	for key := range plan.Headers {
		if slices.Contains([]string{"authorization", "x-api-key", "x-goog-api-key"}, strings.ToLower(key)) {
			for _, header := range []string{"Authorization", "X-API-Key", "X-Goog-API-Key"} {
				request.Header.Del(header)
			}
			break
		}
	}
	for key, value := range plan.Headers {
		request.Header.Set(key, fieldText(value))
	}
	if _, present := request.Header["Authorization"]; present {
		customAuth = true
	}
	if _, present := request.Header["X-Api-Key"]; present {
		customAuth = true
	}
	if _, present := request.Header["X-Goog-Api-Key"]; present {
		customAuth = true
	}
	if !customAuth {
		SetModelChannelAuthHeader(request, translation.channel)
	}
	if contentType != "" && (request.Header.Get("Content-Type") == "" || plan.Format == "formData") {
		request.Header.Set("Content-Type", contentType)
	}
	return request, plan.ResponseType, nil
}

type ParameterTranslationResult struct {
	TaskIDs      []string
	Status       string
	Progress     int
	URLs         []string
	ContentURL   string `json:",omitempty"`
	Body         []byte
	ContentType  string
	ResponseBody string
	StatusCode   int
	Retryable    bool `json:"-"`
}

func (translation *ParameterTranslation) Send(ctx context.Context, kind string, query bool, taskID string, downloadRequest ...*http.Request) (ParameterTranslationResult, error) {
	result := ParameterTranslationResult{Status: "processing"}
	request, responseType, err := translation.request(ctx, query, taskID, downloadRequest...)
	if err != nil {
		return result, err
	}
	download := len(downloadRequest) > 0
	if !query && !download {
		translation.Submission = request
	}
	response, err := translation.Client.Do(request)
	if err != nil {
		result.Retryable = true
		message := err.Error()
		if translation.channel.APIKey != "" {
			for _, key := range []string{translation.channel.APIKey, url.QueryEscape(translation.channel.APIKey), url.PathEscape(translation.channel.APIKey)} {
				message = strings.ReplaceAll(message, key, "[密钥]")
			}
		}
		return result, errors.New(message)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		result.Retryable = true
		return result, err
	}
	result.StatusCode, result.ContentType = response.StatusCode, response.Header.Get("Content-Type")
	var data any
	_ = json.Unmarshal(payload, &data)
	if data != nil {
		result.ResponseBody = string(payload)
		if kind == "video" {
			result.ResponseBody = string(workflowLogJSON(result.ResponseBody, ""))
		}
	}
	if responseType == "text" {
		data = string(payload)
	}
	errorSelector := parameterTranslationValue(translation.rule, "error")
	if !download && !goja.IsUndefined(errorSelector) && !goja.IsNull(errorSelector) && !(errorSelector.ExportType() == reflect.TypeFor[string]() && errorSelector.String() == "") {
		value, parseErr := translation.selectValue(errorSelector, data)
		if parseErr != nil {
			return result, parseErr
		}
		if value != nil && translation.runtime.ToValue(value).ToBoolean() {
			return result, errors.New(fmt.Sprint(value))
		}
	} else if object, ok := data.(map[string]any); ok {
		if failure, ok := object["error"].(map[string]any); ok && failure["message"] != nil {
			return result, errors.New(fmt.Sprint(failure["message"]))
		}
	}
	if response.StatusCode >= http.StatusBadRequest || (download && (strings.Contains(strings.ToLower(result.ContentType), "json") || strings.HasPrefix(strings.ToLower(result.ContentType), "text/"))) {
		return result, readAdminChannelError(payload, response.StatusCode, "自定义接口请求失败")
	}
	if responseType == "json" && data == nil {
		return result, errors.New("接口没有返回有效 JSON")
	}
	if query && !download {
		status, err := translation.selectValue(parameterTranslationValue(translation.poll, "status"), data)
		if err != nil {
			return result, err
		}
		matches := func(values []any) bool {
			for _, value := range values {
				if reflect.DeepEqual(value, status) || (fmt.Sprintf("%T", value) != "string" && fmt.Sprintf("%T", status) != "string" && fmt.Sprint(value) == fmt.Sprint(status)) {
					return true
				}
			}
			return false
		}
		if matches(translation.failure) {
			return result, fmt.Errorf("上游任务失败：%v", status)
		}
		if !goja.IsUndefined(parameterTranslationValue(translation.poll, "progress")) {
			value, err := translation.selectValue(parameterTranslationValue(translation.poll, "progress"), data)
			if err != nil {
				return result, err
			}
			if progress, err := strconv.ParseFloat(fmt.Sprint(value), 64); err == nil {
				result.Progress = max(0, min(100, int(progress)))
			}
		}
		if !matches(translation.success) {
			return result, nil
		}
	} else if translation.poll != nil && !download {
		value, err := translation.selectValue(parameterTranslationValue(translation.poll, "taskId"), data)
		if err != nil {
			return result, err
		}
		if items, ok := value.([]any); ok {
			for _, item := range items {
				if item != nil && fmt.Sprint(item) != "" {
					result.TaskIDs = append(result.TaskIDs, fmt.Sprint(item))
				}
			}
		} else if value != nil && fmt.Sprint(value) != "" {
			result.TaskIDs = []string{fmt.Sprint(value)}
		}
		if len(result.TaskIDs) == 0 {
			return result, errors.New("提交响应没有返回配置位置的任务 ID")
		}
		seen := map[string]bool{}
		ids := result.TaskIDs[:0]
		for _, id := range result.TaskIDs {
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
		result.TaskIDs = ids
		return result, nil
	}
	result.Status, result.Progress = "completed", 100
	if responseType == "blob" || responseType == "arraybuffer" {
		if len(payload) == 0 {
			return result, errors.New("接口返回了空媒体文件")
		}
		result.Body = payload
		if result.ContentType == "" {
			result.ContentType = http.DetectContentType(payload)
		}
		if (kind == "video" || download) && !strings.HasPrefix(result.ContentType, "video/") {
			result.ContentType = "video/mp4"
		}
		return result, nil
	}
	selector := parameterTranslationValue(translation.rule, "result")
	value, err := translation.selectValue(selector, data)
	if err != nil {
		return result, err
	}
	mimeType := result.ContentType
	if !strings.HasPrefix(mimeType, kind+"/") {
		mimeType = map[string]string{"image": "image/png", "video": "video/mp4", "audio": "audio/mpeg"}[kind]
		if kind == "audio" {
			if format := translation.runtime.Get("audioFormat"); format != nil {
				if mime := map[string]string{"wav": "audio/wav", "opus": "audio/opus", "aac": "audio/aac", "flac": "audio/flac", "pcm": "audio/pcm"}[format.String()]; mime != "" {
					mimeType = mime
				}
			}
		}
	}
	result.URLs = ParameterTranslationMediaURLs(value, kind, mimeType, 0)
	if kind == "video" {
		if len(result.URLs) > 0 && strings.HasPrefix(result.URLs[0], "data:video/") {
			result.Body, result.ContentType, err = readWorkflowMedia(ctx, result.URLs[0], 0)
			if err != nil {
				return result, errors.New("接口返回的视频编码无效")
			}
			result.URLs, result.ResponseBody = nil, ""
			return result, nil
		}
		var content *url.URL
		if len(result.URLs) == 1 {
			if target, err := url.Parse(result.URLs[0]); err == nil && target.User == nil && target.Scheme == request.URL.Scheme && target.Host == request.URL.Host {
				if parts := strings.Split(target.EscapedPath(), "/"); len(parts) >= 3 && parts[len(parts)-3] == "videos" && parts[len(parts)-2] != "" && parts[len(parts)-1] == "content" {
					content = target
				}
			}
		}
		defaultResult := goja.IsUndefined(selector) || goja.IsNull(selector) || (selector.ExportType() == reflect.TypeFor[string]() && selector.String() == "")
		if len(result.URLs) == 0 && query && defaultResult && request.Method == http.MethodGet && taskID != "" && strings.HasSuffix(request.URL.EscapedPath(), "/videos/"+strings.ReplaceAll(url.QueryEscape(taskID), "+", "%20")) {
			target := *request.URL
			target.Path, target.RawPath, target.RawQuery = target.Path+"/content", target.EscapedPath()+"/content", ""
			content = &target
		}
		if content != nil {
			result.ContentURL, result.URLs = content.String(), nil
			return result, nil
		}
	}
	if len(result.URLs) == 0 {
		return result, errors.New("生成已完成，但配置的结果位置没有可用媒体地址")
	}
	return result, nil
}

func ParameterTranslationMediaURLs(value any, kind string, contentType string, depth int) []string {
	if depth > 8 || value == nil {
		return nil
	}
	switch object := value.(type) {
	case string:
		text := strings.TrimSpace(object)
		if text == "" {
			return nil
		}
		if parsed, err := url.Parse(text); err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != "" {
			return []string{text}
		}
		if strings.HasPrefix(text, "data:"+kind+"/") {
			return []string{text}
		}
		if strings.HasPrefix(contentType, kind+"/") {
			if _, err := base64.StdEncoding.DecodeString(text); err == nil {
				return []string{"data:" + strings.Split(contentType, ";")[0] + ";base64," + text}
			}
		}
	case []any:
		var urls []string
		for _, item := range object {
			urls = append(urls, ParameterTranslationMediaURLs(item, kind, contentType, depth+1)...)
		}
		return urls
	case map[string]any:
		if mimeType, ok := object["mime_type"].(string); ok {
			contentType = mimeType
		}
		if mimeType, ok := object["mimeType"].(string); ok {
			contentType = mimeType
		}
		var urls []string
		for _, key := range []string{"url", "uri", "download_url", "image_url", "video_url", "audio_url", "images", "videos", "audios", "data", "outputs", "results", "result", "b64_json", "base64"} {
			urls = append(urls, ParameterTranslationMediaURLs(object[key], kind, contentType, depth+1)...)
		}
		return urls
	}
	return nil
}

func (translation *ParameterTranslation) Execute(ctx context.Context, kind string, onProgress func(int)) (ParameterTranslationResult, error) {
	timeout := translation.channel.Timeout
	if timeout <= 0 {
		timeout = 600
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()
	result, err := translation.Send(ctx, kind, false, "")
	if err != nil || result.Status == "completed" {
		return result, err
	}
	completed := map[string]ParameterTranslationResult{}
	progress := map[string]int{}
	for len(completed) < len(result.TaskIDs) {
		for _, id := range result.TaskIDs {
			if _, done := completed[id]; done {
				continue
			}
			polled, err := translation.Send(ctx, kind, true, id)
			if err != nil {
				return polled, err
			}
			if onProgress != nil {
				progress[id] = polled.Progress
				total := 0
				for _, value := range progress {
					total += value
				}
				onProgress(total / len(result.TaskIDs))
			}
			if polled.Status == "completed" {
				completed[id] = polled
			}
		}
		if len(completed) < len(result.TaskIDs) {
			timer := time.NewTimer(5 * time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return result, ctx.Err()
			case <-timer.C:
			}
		}
	}
	result.Status, result.Progress = "completed", 100
	for _, id := range result.TaskIDs {
		polled := completed[id]
		result.URLs = append(result.URLs, polled.URLs...)
		if len(polled.Body) > 0 {
			result.URLs = append(result.URLs, "data:"+strings.Split(polled.ContentType, ";")[0]+";base64,"+base64.StdEncoding.EncodeToString(polled.Body))
		}
		result.ResponseBody, result.StatusCode = polled.ResponseBody, polled.StatusCode
	}
	return result, nil
}

func replaceParameterTranslationValues(value any, replace func(string) string) any {
	switch object := value.(type) {
	case string:
		return replace(object)
	case []any:
		for index, value := range object {
			object[index] = replaceParameterTranslationValues(value, replace)
		}
	case map[string]any:
		for key, value := range object {
			object[key] = replaceParameterTranslationValues(value, replace)
		}
	}
	return value
}
