package service

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

const (
	cliModelProbeOutputLimit = 4 * 1024
	cliModelProbeTimeout     = 2 * time.Minute
	cliModelProbeRetention   = 10 * time.Minute
	cliModelProbePrompt      = "Reply with exactly OK. Do not inspect files, run commands, or use tools."
	cliCompletionPromptLimit = 24 * 1024
)

type cliModelProbeTask struct {
	ID         string
	UserID     string
	ProviderID string
	Protocol   string
	Status     string
	Output     string
	Message    string
	UpdatedAt  time.Time
	Cancel     context.CancelFunc
}

var cliModelProbeState = struct {
	sync.Mutex
	Tasks    map[string]*cliModelProbeTask
	ActiveID string
}{Tasks: map[string]*cliModelProbeTask{}}

func StartCurrentUserCLIModelProbe(ctx context.Context, providerID string) (CLIHelperResult, error) {
	item, err := currentUserProbeCLIProvider(ctx, providerID)
	if err != nil {
		return CLIHelperResult{}, err
	}
	result, _, err := requestCLICompanionInput(ctx, cliCompanionActionRequest{Action: cliCompanionActionProbeStart, UserID: item.OwnerUserID, ProviderID: item.ID, Protocol: item.Protocol, Model: item.DefaultModel})
	if err != nil {
		return CLIHelperResult{Protocol: item.Protocol, Message: "CLI 伴随进程未连接或授权失败"}, nil
	}
	return result, nil
}

func QueryCurrentUserCLIModelProbe(ctx context.Context, providerID string, taskID string) (CLIHelperResult, error) {
	item, err := currentUserCLIProbeTaskProvider(ctx, providerID)
	if err != nil {
		return CLIHelperResult{}, err
	}
	result, _, err := requestCLICompanionTaskAction(ctx, item.OwnerUserID, item.ID, item.Protocol, cliCompanionActionProbeStatus, taskID)
	if err != nil {
		return CLIHelperResult{Protocol: item.Protocol, TaskID: taskID, Message: "CLI 伴随进程未连接或授权失败"}, nil
	}
	return result, nil
}

func CancelCurrentUserCLIModelProbe(ctx context.Context, providerID string, taskID string) (CLIHelperResult, error) {
	item, err := currentUserCLIProbeTaskProvider(ctx, providerID)
	if err != nil {
		return CLIHelperResult{}, err
	}
	result, _, err := requestCLICompanionTaskAction(ctx, item.OwnerUserID, item.ID, item.Protocol, cliCompanionActionProbeCancel, taskID)
	if err != nil {
		return CLIHelperResult{Protocol: item.Protocol, TaskID: taskID, Message: "CLI 伴随进程未连接或授权失败"}, nil
	}
	return result, nil
}

func currentUserProbeCLIProvider(ctx context.Context, providerID string) (model.Provider, error) {
	item, err := currentUserCLIProbeTaskProvider(ctx, providerID)
	if err != nil {
		return model.Provider{}, err
	}
	if item.Protocol == "gemini-cli" && (!cliModelNamePattern.MatchString(item.DefaultModel) || !userLocalChannelHasModel(item.Models, item.DefaultModel)) {
		return model.Provider{}, safeMessageError{message: "请先检测 Antigravity CLI 并选择默认模型"}
	}
	return item, nil
}

func currentUserCLIProbeTaskProvider(ctx context.Context, providerID string) (model.Provider, error) {
	_, item, err := currentUserProvider(ctx, providerID)
	if err != nil {
		return model.Provider{}, err
	}
	if item.Kind != model.ProviderKindCLI || !item.Enabled {
		return model.Provider{}, safeMessageError{message: "CLI 渠道不可用"}
	}
	if item.Protocol != "codex" && item.Protocol != "gemini-cli" {
		return model.Provider{}, safeMessageError{message: "该 CLI 尚不支持受控最小调用"}
	}
	if !config.Cfg.CLIHelperEnabled {
		return model.Provider{}, safeMessageError{message: "Mac CLI helper 未启用"}
	}
	if runtime.GOOS != "darwin" {
		return model.Provider{}, safeMessageError{message: "CLI helper 仅支持 macOS"}
	}
	return item, nil
}

func executeCLIModelProbeStart(parent context.Context, input cliCompanionActionRequest) (CLIHelperResult, model.ProviderStatus) {
	result := CLIHelperResult{Protocol: input.Protocol}
	if input.Protocol != "codex" && input.Protocol != "gemini-cli" {
		result.Message = "该 CLI 尚不支持受控最小调用"
		return result, model.ProviderStatusUnavailable
	}
	if input.Protocol == "gemini-cli" {
		input.Prompt = cliModelProbePrompt
		return executeAntigravityCompletionStart(parent, input)
	}
	hashes, err := loadCLIHelperHashes(input.Protocol, time.Now())
	if err != nil {
		result.Message = "CLI helper 可信清单未配置或无效"
		return result, model.ProviderStatusUnavailable
	}
	executable, err := findControlledCLIExecutable(cliSpecs[input.Protocol].Candidates, hashes)
	if err != nil {
		result.Message = "未检测到受支持的 CLI"
		return result, model.ProviderStatusUnavailable
	}
	result.Available = true
	result.Executable = executable
	cliModelProbeState.Lock()
	defer cliModelProbeState.Unlock()
	pruneCLIModelProbeTasks(time.Now())
	if cliModelProbeState.ActiveID != "" {
		result.Message = "CLI helper 正在执行另一个最小调用"
		return result, model.ProviderStatusTimeout
	}
	taskID, err := newCLIModelProbeTaskID()
	if err != nil {
		result.Message = "最小调用任务创建失败"
		return result, model.ProviderStatusFailed
	}
	directory, err := os.MkdirTemp("", "infinite-canvas-codex-probe-")
	if err != nil {
		result.Message = "最小调用临时目录创建失败"
		return result, model.ProviderStatusFailed
	}
	outputPath := filepath.Join(directory, "last-message.txt")
	ctx, cancel := context.WithTimeout(parent, cliModelProbeTimeout)
	command := exec.CommandContext(ctx, executable,
		"exec",
		"--sandbox", "read-only",
		"--skip-git-repo-check",
		"--ephemeral",
		"--output-last-message", outputPath,
		cliModelProbePrompt,
	)
	command.Dir = directory
	command.Env = controlledCLIEnvironment()
	command.Stdin = nil
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		cancel()
		_ = os.RemoveAll(directory)
		result.Message = "Codex 最小调用启动失败"
		return result, model.ProviderStatusFailed
	}
	task := &cliModelProbeTask{
		ID:         taskID,
		UserID:     input.UserID,
		ProviderID: input.ProviderID,
		Protocol:   input.Protocol,
		Status:     "running",
		Message:    "Codex 最小调用正在执行",
		UpdatedAt:  time.Now(),
		Cancel:     cancel,
	}
	cliModelProbeState.Tasks[taskID] = task
	cliModelProbeState.ActiveID = taskID
	go finishCLIModelProbe(command, ctx, cancel, directory, outputPath, taskID)
	return cliModelProbeResult(task), model.ProviderStatusConnected
}

func executeAntigravityCompletionStart(parent context.Context, input cliCompanionActionRequest) (CLIHelperResult, model.ProviderStatus) {
	result := CLIHelperResult{Protocol: input.Protocol}
	if input.Protocol != "gemini-cli" || !cliModelNamePattern.MatchString(input.Model) || len(input.Prompt) == 0 || len(input.Prompt) > cliCompletionPromptLimit {
		result.Message = "Antigravity CLI 调用参数无效"
		return result, model.ProviderStatusUnavailable
	}
	hashes, err := loadCLIHelperHashes(input.Protocol, time.Now())
	if err != nil {
		result.Message = "CLI helper 可信清单未配置或无效"
		return result, model.ProviderStatusUnavailable
	}
	executable, err := findControlledCLIExecutable(cliSpecs[input.Protocol].Candidates, hashes)
	if err != nil {
		result.Message = "未检测到受支持的 CLI"
		return result, model.ProviderStatusUnavailable
	}
	result.Available = true
	result.Executable = executable
	cliModelProbeState.Lock()
	defer cliModelProbeState.Unlock()
	pruneCLIModelProbeTasks(time.Now())
	if cliModelProbeState.ActiveID != "" {
		result.Message = "CLI helper 正在执行另一个模型调用"
		return result, model.ProviderStatusTimeout
	}
	taskID, err := newCLIModelProbeTaskID()
	if err != nil {
		result.Message = "模型调用任务创建失败"
		return result, model.ProviderStatusFailed
	}
	directory, err := os.MkdirTemp("", "infinite-canvas-antigravity-")
	if err != nil {
		result.Message = "模型调用临时目录创建失败"
		return result, model.ProviderStatusFailed
	}
	ctx, cancel := context.WithTimeout(parent, cliModelProbeTimeout)
	command := exec.CommandContext(ctx, executable,
		"--print", input.Prompt,
		"--output-format", "json",
		"--model", input.Model,
		"--effort", "low",
		"--print-timeout", "90s",
		"--disable-slash-commands",
		"--mode", "plan",
		"--sandbox",
	)
	command.Dir = directory
	command.Env = controlledCLIEnvironment()
	command.Stdin = nil
	var output cappedCLIOutput
	command.Stdout = &output
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		cancel()
		_ = os.RemoveAll(directory)
		result.Message = "Antigravity CLI 调用启动失败"
		return result, model.ProviderStatusFailed
	}
	task := &cliModelProbeTask{ID: taskID, UserID: input.UserID, ProviderID: input.ProviderID, Protocol: input.Protocol, Status: "running", Message: "Antigravity CLI 调用正在执行", UpdatedAt: time.Now(), Cancel: cancel}
	cliModelProbeState.Tasks[taskID] = task
	cliModelProbeState.ActiveID = taskID
	go finishAntigravityCompletion(command, ctx, cancel, directory, &output, taskID)
	return cliModelProbeResult(task), model.ProviderStatusConnected
}

func finishAntigravityCompletion(command *exec.Cmd, ctx context.Context, cancel context.CancelFunc, directory string, output *cappedCLIOutput, taskID string) {
	err := command.Wait()
	contextErr := ctx.Err()
	cancel()
	response, responseErr := parseAntigravityCompletion(output.String())
	_ = os.RemoveAll(directory)
	cliModelProbeState.Lock()
	defer cliModelProbeState.Unlock()
	task := cliModelProbeState.Tasks[taskID]
	if task == nil {
		return
	}
	if task.Status != "cancelled" {
		switch {
		case errors.Is(contextErr, context.DeadlineExceeded):
			task.Status, task.Message = "timed_out", "Antigravity CLI 调用超时"
		case errors.Is(contextErr, context.Canceled):
			task.Status, task.Message = "cancelled", "Antigravity CLI 调用已取消"
		case err != nil:
			task.Status, task.Message = "failed", "Antigravity CLI 调用失败"
		case responseErr != nil:
			task.Status, task.Message = "failed", "Antigravity CLI 返回结构异常"
		default:
			task.Status, task.Output, task.Message = "succeeded", response, "Antigravity CLI 调用成功"
		}
	}
	task.UpdatedAt = time.Now()
	if cliModelProbeState.ActiveID == taskID {
		cliModelProbeState.ActiveID = ""
	}
}

func parseAntigravityCompletion(value string) (string, error) {
	var envelope struct {
		Status   string `json:"status"`
		Response string `json:"response"`
	}
	if json.Unmarshal([]byte(value), &envelope) != nil || !strings.EqualFold(strings.TrimSpace(envelope.Status), "success") {
		return "", errors.New("Antigravity completion envelope is invalid")
	}
	response := sanitizeCLIOutput(envelope.Response)
	if response == "" || len(response) > cliModelProbeOutputLimit {
		return "", errors.New("Antigravity completion response is invalid")
	}
	return response, nil
}

func executeCLIModelProbeStatus(input cliCompanionActionRequest) (CLIHelperResult, model.ProviderStatus) {
	cliModelProbeState.Lock()
	defer cliModelProbeState.Unlock()
	pruneCLIModelProbeTasks(time.Now())
	task := cliModelProbeState.Tasks[input.TaskID]
	if !matchingCLIModelProbeTask(task, input) {
		return CLIHelperResult{Protocol: input.Protocol, TaskID: input.TaskID, Message: "最小调用任务不存在或无权访问"}, model.ProviderStatusUnavailable
	}
	return cliModelProbeResult(task), cliModelProbeProviderStatus(task.Status)
}

func executeCLIModelProbeCancel(input cliCompanionActionRequest) (CLIHelperResult, model.ProviderStatus) {
	cliModelProbeState.Lock()
	defer cliModelProbeState.Unlock()
	task := cliModelProbeState.Tasks[input.TaskID]
	if !matchingCLIModelProbeTask(task, input) {
		return CLIHelperResult{Protocol: input.Protocol, TaskID: input.TaskID, Message: "最小调用任务不存在或无权访问"}, model.ProviderStatusUnavailable
	}
	if task.Status == "running" {
		task.Status = "cancelled"
		task.Output = ""
		if task.Protocol == "gemini-cli" {
			task.Message = "Antigravity CLI 调用已取消"
		} else {
			task.Message = "Codex 最小调用已取消"
		}
		task.UpdatedAt = time.Now()
		task.Cancel()
	}
	return cliModelProbeResult(task), cliModelProbeProviderStatus(task.Status)
}

func finishCLIModelProbe(command *exec.Cmd, ctx context.Context, cancel context.CancelFunc, directory string, outputPath string, taskID string) {
	err := command.Wait()
	contextErr := ctx.Err()
	cancel()
	output, outputErr := readCLIModelProbeOutput(outputPath)
	_ = os.RemoveAll(directory)
	cliModelProbeState.Lock()
	defer cliModelProbeState.Unlock()
	task := cliModelProbeState.Tasks[taskID]
	if task == nil {
		return
	}
	if task.Status != "cancelled" {
		switch {
		case errors.Is(contextErr, context.DeadlineExceeded):
			task.Status = "timed_out"
			task.Message = "Codex 最小调用超时"
		case errors.Is(contextErr, context.Canceled):
			task.Status = "cancelled"
			task.Message = "Codex 最小调用已取消"
		case err != nil:
			task.Status = "failed"
			task.Message = "Codex 最小调用失败"
		case outputErr != nil || output == "":
			task.Status = "failed"
			task.Message = "Codex 最小调用没有返回有效结果"
		default:
			task.Status = "succeeded"
			task.Output = output
			task.Message = "Codex 最小调用成功"
		}
	}
	task.UpdatedAt = time.Now()
	if cliModelProbeState.ActiveID == taskID {
		cliModelProbeState.ActiveID = ""
	}
}

func readCLIModelProbeOutput(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > int64(cliModelProbeOutputLimit) {
		return "", errors.New("CLI model probe output is invalid")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, int64(cliModelProbeOutputLimit)+1))
	if err != nil || len(data) > cliModelProbeOutputLimit {
		return "", errors.New("CLI model probe output is invalid")
	}
	return sanitizeCLIOutput(string(data)), nil
}

func newCLIModelProbeTaskID() (string, error) {
	data := make([]byte, 24)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

func matchingCLIModelProbeTask(task *cliModelProbeTask, input cliCompanionActionRequest) bool {
	return task != nil && task.UserID == input.UserID && task.ProviderID == input.ProviderID && task.Protocol == input.Protocol
}

func cliModelProbeResult(task *cliModelProbeTask) CLIHelperResult {
	return CLIHelperResult{Available: true, Protocol: task.Protocol, TaskID: task.ID, TaskStatus: task.Status, Output: task.Output, Message: task.Message}
}

func cliModelProbeProviderStatus(status string) model.ProviderStatus {
	switch status {
	case "failed":
		return model.ProviderStatusFailed
	case "timed_out":
		return model.ProviderStatusTimeout
	default:
		return model.ProviderStatusConnected
	}
}

func pruneCLIModelProbeTasks(current time.Time) {
	for id, task := range cliModelProbeState.Tasks {
		if task.Status != "running" && current.Sub(task.UpdatedAt) > cliModelProbeRetention {
			delete(cliModelProbeState.Tasks, id)
		}
	}
}
