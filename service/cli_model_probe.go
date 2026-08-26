package service

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
	item, err := currentUserCodexCLIProvider(ctx, providerID)
	if err != nil {
		return CLIHelperResult{}, err
	}
	result, _, err := requestCLICompanionTaskAction(ctx, item.OwnerUserID, item.ID, item.Protocol, cliCompanionActionProbeStart, "")
	if err != nil {
		return CLIHelperResult{Protocol: item.Protocol, Message: "CLI 伴随进程未连接或授权失败"}, nil
	}
	return result, nil
}

func QueryCurrentUserCLIModelProbe(ctx context.Context, providerID string, taskID string) (CLIHelperResult, error) {
	item, err := currentUserCodexCLIProvider(ctx, providerID)
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
	item, err := currentUserCodexCLIProvider(ctx, providerID)
	if err != nil {
		return CLIHelperResult{}, err
	}
	result, _, err := requestCLICompanionTaskAction(ctx, item.OwnerUserID, item.ID, item.Protocol, cliCompanionActionProbeCancel, taskID)
	if err != nil {
		return CLIHelperResult{Protocol: item.Protocol, TaskID: taskID, Message: "CLI 伴随进程未连接或授权失败"}, nil
	}
	return result, nil
}

func currentUserCodexCLIProvider(ctx context.Context, providerID string) (model.Provider, error) {
	_, item, err := currentUserProvider(ctx, providerID)
	if err != nil {
		return model.Provider{}, err
	}
	if item.Kind != model.ProviderKindCLI || !item.Enabled {
		return model.Provider{}, safeMessageError{message: "CLI 渠道不可用"}
	}
	if item.Protocol != "codex" {
		return model.Provider{}, safeMessageError{message: "仅 Codex CLI 支持受控最小调用"}
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
	if input.Protocol != "codex" {
		result.Message = "仅 Codex CLI 支持受控最小调用"
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
		task.Message = "Codex 最小调用已取消"
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
