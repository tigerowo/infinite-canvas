package service

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/url"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

const (
	jimengImageModel   = "jimeng-image-5.0"
	jimengVideoModel   = "jimeng-video-seedance2.0fast"
	jimengPromptLimit  = 8 * 1024
	jimengImageTimeout = 10 * time.Minute
	jimengVideoTimeout = 20 * time.Minute
	jimengPollInterval = 5 * time.Second
)

type jimengModelSpec struct {
	GenerationType string
	ModelVersion   string
	Resolutions    map[string]bool
	MinDuration    int
	MaxDuration    int
}

var (
	jimengCLIModels = []string{
		"jimeng-image-3.0", "jimeng-image-3.1", "jimeng-image-4.0", "jimeng-image-4.1", "jimeng-image-4.5", "jimeng-image-4.6", "jimeng-image-4.7", jimengImageModel, "jimeng-image-5.0Pro",
		"jimeng-video-seedance2.0", jimengVideoModel, "jimeng-video-seedance2.0_vip", "jimeng-video-seedance2.0fast_vip", "jimeng-video-seedance2.0mini", "jimeng-video-seedance2.5",
	}
	jimengModelSpecs = map[string]jimengModelSpec{
		"jimeng-image-3.0":                 {GenerationType: "image", ModelVersion: "3.0", Resolutions: map[string]bool{"1k": true, "2k": true}},
		"jimeng-image-3.1":                 {GenerationType: "image", ModelVersion: "3.1", Resolutions: map[string]bool{"1k": true, "2k": true}},
		"jimeng-image-4.0":                 {GenerationType: "image", ModelVersion: "4.0", Resolutions: map[string]bool{"2k": true, "4k": true}},
		"jimeng-image-4.1":                 {GenerationType: "image", ModelVersion: "4.1", Resolutions: map[string]bool{"2k": true, "4k": true}},
		"jimeng-image-4.5":                 {GenerationType: "image", ModelVersion: "4.5", Resolutions: map[string]bool{"2k": true, "4k": true}},
		"jimeng-image-4.6":                 {GenerationType: "image", ModelVersion: "4.6", Resolutions: map[string]bool{"2k": true, "4k": true}},
		"jimeng-image-4.7":                 {GenerationType: "image", ModelVersion: "4.7", Resolutions: map[string]bool{"2k": true, "4k": true}},
		jimengImageModel:                   {GenerationType: "image", ModelVersion: "5.0", Resolutions: map[string]bool{"2k": true, "4k": true}},
		"jimeng-image-5.0Pro":              {GenerationType: "image", ModelVersion: "5.0Pro", Resolutions: map[string]bool{"1.5k": true, "2k": true, "4k": true}},
		"jimeng-video-seedance2.0":         {GenerationType: "video", ModelVersion: "seedance2.0", Resolutions: map[string]bool{"720p": true}, MinDuration: 4, MaxDuration: 15},
		jimengVideoModel:                   {GenerationType: "video", ModelVersion: "seedance2.0fast", Resolutions: map[string]bool{"720p": true}, MinDuration: 4, MaxDuration: 15},
		"jimeng-video-seedance2.0_vip":     {GenerationType: "video", ModelVersion: "seedance2.0_vip", Resolutions: map[string]bool{"720p": true, "1080p": true, "4k": true}, MinDuration: 4, MaxDuration: 15},
		"jimeng-video-seedance2.0fast_vip": {GenerationType: "video", ModelVersion: "seedance2.0fast_vip", Resolutions: map[string]bool{"720p": true}, MinDuration: 4, MaxDuration: 15},
		"jimeng-video-seedance2.0mini":     {GenerationType: "video", ModelVersion: "seedance2.0mini", Resolutions: map[string]bool{"720p": true}, MinDuration: 4, MaxDuration: 15},
		"jimeng-video-seedance2.5":         {GenerationType: "video", ModelVersion: "seedance2.5", Resolutions: map[string]bool{"480p": true, "720p": true, "1080p": true}, MinDuration: 4, MaxDuration: 30},
	}
	jimengImageRatios = map[string]bool{"21:9": true, "16:9": true, "3:2": true, "4:3": true, "1:1": true, "3:4": true, "2:3": true, "9:16": true}
	jimengVideoRatios = map[string]bool{"21:9": true, "16:9": true, "4:3": true, "1:1": true, "3:4": true, "9:16": true}
)

type CLIGenerationInput struct {
	GenerationType string `json:"generationType"`
	Model          string `json:"model"`
	Prompt         string `json:"prompt"`
	Ratio          string `json:"ratio"`
	Resolution     string `json:"resolution"`
	Duration       int    `json:"duration"`
}

type jimengGenerationOutput struct {
	SubmitID string   `json:"submitId"`
	URLs     []string `json:"urls"`
}

type dreaminaTaskResponse struct {
	SubmitID string
	Status   string
	URLs     []string
}

type dreaminaCommandError struct {
	diagnostic string
}

func (err dreaminaCommandError) Error() string {
	return err.diagnostic
}

func StartCurrentUserCLIGeneration(ctx context.Context, providerID string, input CLIGenerationInput) (CLIHelperResult, error) {
	item, err := currentUserGenerationProvider(ctx, providerID)
	if err != nil {
		return CLIHelperResult{}, err
	}
	request := cliCompanionActionRequest{
		Action: cliCompanionActionGenerationStart, UserID: item.OwnerUserID, ProviderID: item.ID, Protocol: item.Protocol,
		GenerationType: strings.TrimSpace(input.GenerationType), Model: strings.TrimSpace(input.Model), Prompt: strings.TrimSpace(input.Prompt),
		Ratio: strings.TrimSpace(input.Ratio), Resolution: strings.TrimSpace(input.Resolution), Duration: input.Duration,
	}
	if !validCLIGenerationRequest(request) || !userLocalChannelHasModel(item.Models, request.Model) {
		return CLIHelperResult{}, safeMessageError{message: "CLI 生成参数不受支持"}
	}
	result, _, err := requestCLICompanionInput(ctx, request)
	if err != nil {
		return CLIHelperResult{Protocol: item.Protocol, Message: "CLI 伴随进程未连接或授权失败"}, nil
	}
	return result, nil
}

func QueryCurrentUserCLIGeneration(ctx context.Context, providerID string, taskID string) (CLIHelperResult, error) {
	item, err := currentUserGenerationProvider(ctx, providerID)
	if err != nil {
		return CLIHelperResult{}, err
	}
	result, _, err := requestCLICompanionTaskAction(ctx, item.OwnerUserID, item.ID, item.Protocol, cliCompanionActionGenerationStatus, taskID)
	if err != nil {
		return CLIHelperResult{Protocol: item.Protocol, TaskID: taskID, Message: "CLI 伴随进程未连接或授权失败"}, nil
	}
	if result.TaskStatus == "succeeded" && (item.Protocol == "gpt-image-2" || item.Protocol == "codex-image-emergency") {
		return finalizeSubscriptionImageResult(ctx, result)
	}
	return result, nil
}

func CancelCurrentUserCLIGeneration(ctx context.Context, providerID string, taskID string) (CLIHelperResult, error) {
	item, err := currentUserGenerationProvider(ctx, providerID)
	if err != nil {
		return CLIHelperResult{}, err
	}
	result, _, err := requestCLICompanionTaskAction(ctx, item.OwnerUserID, item.ID, item.Protocol, cliCompanionActionGenerationCancel, taskID)
	if err != nil {
		return CLIHelperResult{Protocol: item.Protocol, TaskID: taskID, Message: "CLI 伴随进程未连接或授权失败"}, nil
	}
	return result, nil
}

func currentUserGenerationProvider(ctx context.Context, providerID string) (model.Provider, error) {
	_, item, err := currentUserProvider(ctx, providerID)
	if err != nil {
		return model.Provider{}, err
	}
	if item.Kind != model.ProviderKindCLI || !map[string]bool{"jimeng": true, "gpt-image-2": true, "codex-image-emergency": true}[item.Protocol] || !item.Enabled || item.ConnectionStatus != model.ProviderStatusConnected {
		return model.Provider{}, safeMessageError{message: "CLI 生成渠道不可用，请先检查连接状态"}
	}
	if !config.Cfg.CLIHelperEnabled {
		return model.Provider{}, safeMessageError{message: "Mac CLI helper 未启用"}
	}
	if runtime.GOOS != "darwin" {
		return model.Provider{}, safeMessageError{message: "CLI helper 仅支持 macOS"}
	}
	return item, nil
}

func validCLIGenerationRequest(input cliCompanionActionRequest) bool {
	if input.Protocol == "jimeng" {
		return validJimengGenerationRequest(input)
	}
	return validSubscriptionImageGenerationRequest(input)
}

func validJimengGenerationRequest(input cliCompanionActionRequest) bool {
	if input.Protocol != "jimeng" || input.Action != cliCompanionActionGenerationStart || input.TaskID != "" || len(input.Prompt) == 0 || len(input.Prompt) > jimengPromptLimit || strings.ContainsRune(input.Prompt, '\x00') {
		return false
	}
	spec, ok := jimengModelSpecs[input.Model]
	if !ok || spec.GenerationType != input.GenerationType || !spec.Resolutions[input.Resolution] {
		return false
	}
	switch spec.GenerationType {
	case "image":
		return jimengImageRatios[input.Ratio] && input.Duration == 0
	case "video":
		return jimengVideoRatios[input.Ratio] && input.Duration >= spec.MinDuration && input.Duration <= spec.MaxDuration
	default:
		return false
	}
}

func executeJimengGenerationStart(parent context.Context, input cliCompanionActionRequest) (CLIHelperResult, model.ProviderStatus) {
	result := CLIHelperResult{Protocol: input.Protocol}
	if !validJimengGenerationRequest(input) {
		result.Message = "即梦生成参数无效"
		return result, model.ProviderStatusUnavailable
	}
	hashes, err := loadCLIHelperHashes(input.Protocol, time.Now())
	if err != nil {
		result.Message = "CLI helper 可信清单未配置或无效"
		return result, model.ProviderStatusUnavailable
	}
	executable, err := findControlledCLIExecutable(cliSpecs[input.Protocol].Candidates, hashes)
	if err != nil {
		result.Message = "未检测到受支持的即梦 CLI"
		return result, model.ProviderStatusUnavailable
	}
	cliModelProbeState.Lock()
	defer cliModelProbeState.Unlock()
	pruneCLIModelProbeTasks(time.Now())
	if cliModelProbeState.ActiveID != "" {
		result.Message = "CLI helper 正在执行另一个模型调用"
		return result, model.ProviderStatusTimeout
	}
	taskID, err := newCLIModelProbeTaskID()
	if err != nil {
		result.Message = "即梦任务创建失败"
		return result, model.ProviderStatusFailed
	}
	timeout := jimengImageTimeout
	if input.GenerationType == "video" {
		timeout = jimengVideoTimeout
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	task := &cliModelProbeTask{ID: taskID, UserID: input.UserID, ProviderID: input.ProviderID, Protocol: input.Protocol, GenerationType: input.GenerationType, Status: "running", Message: "即梦任务正在执行", UpdatedAt: time.Now(), Cancel: cancel}
	cliModelProbeState.Tasks[taskID] = task
	cliModelProbeState.ActiveID = taskID
	go runJimengGeneration(ctx, cancel, executable, input, taskID)
	result = cliModelProbeResult(task)
	result.Executable = executable
	return result, model.ProviderStatusConnected
}

func runJimengGeneration(ctx context.Context, cancel context.CancelFunc, executable string, input cliCompanionActionRequest, taskID string) {
	defer cancel()
	response, err := runDreaminaJSONCommand(ctx, executable, dreaminaGenerationArguments(input))
	response.URLs = jimengResultURLsForRequest(input.GenerationType, response.URLs)
	if err != nil {
		finishJimengGeneration(taskID, ctx.Err(), err, dreaminaTaskResponse{})
		return
	}
	if response.Status == "failed" || response.Status == "succeeded" {
		finishJimengGeneration(taskID, ctx.Err(), nil, response)
		return
	}
	if response.SubmitID == "" {
		finishJimengGeneration(taskID, ctx.Err(), errors.New("Dreamina submit ID is missing"), response)
		return
	}
	cliModelProbeState.Lock()
	if task := cliModelProbeState.Tasks[taskID]; task != nil {
		task.UpstreamID = response.SubmitID
	}
	cliModelProbeState.Unlock()
	ticker := time.NewTicker(jimengPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			finishJimengGeneration(taskID, ctx.Err(), nil, response)
			return
		case <-ticker.C:
			response, err = runDreaminaJSONCommand(ctx, executable, []string{"query_result", "--submit_id=" + response.SubmitID})
			response.URLs = jimengResultURLsForRequest(input.GenerationType, response.URLs)
			if err != nil || response.Status == "failed" || response.Status == "succeeded" {
				finishJimengGeneration(taskID, ctx.Err(), err, response)
				return
			}
		}
	}
}

func jimengResultURLsForRequest(generationType string, urls []string) []string {
	if generationType == "image" && len(urls) > 1 {
		return urls[:1]
	}
	return urls
}

func dreaminaGenerationArguments(input cliCompanionActionRequest) []string {
	spec := jimengModelSpecs[input.Model]
	if input.GenerationType == "image" {
		return []string{"text2image", "--prompt=" + input.Prompt, "--ratio", input.Ratio, "--resolution_type", input.Resolution, "--model_version", spec.ModelVersion, "--generate_num", "1", "--poll", "0"}
	}
	return []string{"text2video", "--prompt=" + input.Prompt, "--duration", strconv.Itoa(input.Duration), "--ratio", input.Ratio, "--video_resolution", input.Resolution, "--model_version", spec.ModelVersion, "--poll", "0"}
}

func runDreaminaJSONCommand(ctx context.Context, executable string, arguments []string) (dreaminaTaskResponse, error) {
	command := exec.CommandContext(ctx, executable, arguments...)
	command.Env = controlledCLIEnvironment()
	command.Stdin = nil
	var output, errorOutput cappedCLIOutput
	command.Stdout = &output
	command.Stderr = &errorOutput
	if err := command.Run(); err != nil {
		return dreaminaTaskResponse{}, dreaminaCommandError{diagnostic: safeDreaminaCommandDiagnostic(output.String(), errorOutput.String(), err)}
	}
	response, err := parseDreaminaTaskResponse(output.String())
	if err != nil {
		return dreaminaTaskResponse{}, dreaminaCommandError{diagnostic: safeDreaminaCommandDiagnostic(output.String(), errorOutput.String(), err)}
	}
	return response, nil
}

func safeDreaminaCommandDiagnostic(stdout string, stderr string, commandErr error) string {
	diagnostic := RedactSensitiveText(sanitizeCLIOutput(strings.TrimSpace(stderr + "\n" + stdout)))
	if diagnostic == "" && commandErr != nil {
		diagnostic = commandErr.Error()
	}
	runes := []rune(diagnostic)
	if len(runes) > 512 {
		diagnostic = string(runes[:512])
	}
	return diagnostic
}

func dreaminaFailureMessage(err error) string {
	if err == nil {
		return "即梦 CLI 调用失败"
	}
	detail := strings.ToLower(err.Error())
	switch {
	case strings.Contains(detail, "dreamina_cli"), strings.Contains(detail, "会员等级"), strings.Contains(detail, "membership"), strings.Contains(detail, "permission denied"), strings.Contains(detail, "forbidden"):
		return "即梦 CLI 生成权限不足，需要高级或以上会员"
	case strings.Contains(detail, "credit"), strings.Contains(detail, "balance"), strings.Contains(detail, "insufficient"), strings.Contains(detail, "额度"), strings.Contains(detail, "余额"):
		return "即梦账户额度不足"
	case strings.Contains(detail, "429"), strings.Contains(detail, "rate limit"), strings.Contains(detail, "too many requests"), strings.Contains(detail, "频率"), strings.Contains(detail, "限流"):
		return "即梦请求频率受限"
	case strings.Contains(detail, "unauthorized"), strings.Contains(detail, "unauthenticated"), strings.Contains(detail, "invalid_grant"), strings.Contains(detail, "token expired"), strings.Contains(detail, "login required"), strings.Contains(detail, "登录"):
		return "即梦 CLI 登录已失效"
	case strings.Contains(detail, "network"), strings.Contains(detail, "connection"), strings.Contains(detail, "connect"), strings.Contains(detail, "dns"), strings.Contains(detail, "tls"), strings.Contains(detail, "timeout"), strings.Contains(detail, "timed out"), strings.Contains(detail, "网络"):
		return "即梦 CLI 网络请求失败"
	case strings.Contains(detail, "invalid"), strings.Contains(detail, "unsupported"), strings.Contains(detail, "bad request"), strings.Contains(detail, "argument"), strings.Contains(detail, "parameter"), strings.Contains(detail, "参数"):
		return "即梦生成参数被上游拒绝"
	default:
		return "即梦 CLI 调用失败"
	}
}

func parseDreaminaTaskResponse(value string) (dreaminaTaskResponse, error) {
	start, end := strings.IndexByte(value, '{'), strings.LastIndexByte(value, '}')
	if start < 0 || end <= start {
		return dreaminaTaskResponse{}, errors.New("Dreamina response is not JSON")
	}
	var payload any
	decoder := json.NewDecoder(strings.NewReader(value[start : end+1]))
	decoder.UseNumber()
	if decoder.Decode(&payload) != nil {
		return dreaminaTaskResponse{}, errors.New("Dreamina response JSON is invalid")
	}
	response := dreaminaTaskResponse{
		SubmitID: firstDreaminaString(payload, "submit_id"),
		Status:   normalizeDreaminaStatus(firstDreaminaString(payload, "gen_status", "task_status", "status")),
		URLs:     dreaminaResultURLs(payload),
	}
	if response.Status == "" && response.SubmitID != "" {
		response.Status = "running"
	}
	if response.Status == "" {
		return dreaminaTaskResponse{}, errors.New("Dreamina response status is invalid")
	}
	return response, nil
}

func firstDreaminaString(value any, keys ...string) string {
	for _, key := range keys {
		if result := findDreaminaString(value, key); result != "" {
			return result
		}
	}
	return ""
}

func findDreaminaString(value any, target string) string {
	var visit func(any) string
	visit = func(current any) string {
		switch item := current.(type) {
		case map[string]any:
			for key, child := range item {
				if strings.EqualFold(key, target) {
					switch typed := child.(type) {
					case string:
						return strings.TrimSpace(typed)
					case json.Number:
						return typed.String()
					case float64:
						return strconv.FormatInt(int64(typed), 10)
					}
				}
			}
			for _, child := range item {
				if result := visit(child); result != "" {
					return result
				}
			}
		case []any:
			for _, child := range item {
				if result := visit(child); result != "" {
					return result
				}
			}
		}
		return ""
	}
	return visit(value)
}

func normalizeDreaminaStatus(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "querying", "queued", "pending", "processing", "running":
		return "running"
	case "success", "succeeded", "finished", "completed", "done":
		return "succeeded"
	case "fail", "failed", "error":
		return "failed"
	default:
		return ""
	}
}

func dreaminaResultURLs(value any) []string {
	seen := map[string]bool{}
	result := make([]string, 0, 4)
	var appendURL func(any)
	appendURL = func(current any) {
		if len(result) >= 10 {
			return
		}
		switch item := current.(type) {
		case string:
			parsed, err := url.Parse(strings.TrimSpace(item))
			if err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil && len(item) <= 2048 && !seen[item] {
				seen[item] = true
				result = append(result, item)
			}
		case []any:
			for _, child := range item {
				appendURL(child)
			}
		case map[string]any:
			for key, child := range item {
				normalized := strings.ToLower(key)
				if normalized == "url" || normalized == "image_url" || normalized == "image_urls" || normalized == "video_url" || normalized == "video_urls" || normalized == "download_url" {
					appendURL(child)
				}
			}
			for _, child := range item {
				if _, nested := child.(map[string]any); nested {
					appendURL(child)
				} else if _, nested := child.([]any); nested {
					appendURL(child)
				}
			}
		}
	}
	appendURL(value)
	return result
}

func finishJimengGeneration(taskID string, contextErr error, commandErr error, response dreaminaTaskResponse) {
	cliModelProbeState.Lock()
	defer cliModelProbeState.Unlock()
	task := cliModelProbeState.Tasks[taskID]
	if task == nil {
		return
	}
	if task.Status != "cancelled" {
		switch {
		case errors.Is(contextErr, context.DeadlineExceeded):
			task.Status, task.Message = "timed_out", "即梦本地轮询超时；上游任务可能仍会继续"
		case errors.Is(contextErr, context.Canceled):
			task.Status, task.Message = "cancelled", "即梦本地轮询已取消；上游任务可能仍会继续"
		case commandErr != nil:
			log.Printf("Dreamina CLI failed: %s", commandErr.Error())
			task.Status, task.Message = "failed", dreaminaFailureMessage(commandErr)
		case response.Status == "failed":
			task.Status, task.Message = "failed", "即梦上游任务失败"
		case response.Status == "succeeded" && len(response.URLs) == 0:
			task.Status, task.Message = "failed", "即梦任务完成但未返回安全的 HTTPS 结果地址"
		case response.Status == "succeeded":
			body, err := json.Marshal(jimengGenerationOutput{SubmitID: response.SubmitID, URLs: response.URLs})
			if err != nil || len(body) > cliModelProbeOutputLimit {
				task.Status, task.Message = "failed", "即梦返回结构异常"
			} else {
				task.Status, task.Output, task.Message = "succeeded", string(body), "即梦任务完成"
			}
		default:
			task.Status, task.Message = "failed", "即梦返回结构异常"
		}
	}
	task.UpdatedAt = time.Now()
	if cliModelProbeState.ActiveID == taskID {
		cliModelProbeState.ActiveID = ""
	}
}
