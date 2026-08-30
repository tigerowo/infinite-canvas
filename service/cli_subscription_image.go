package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

const (
	cliSubscriptionImageTimeout          = 3 * time.Minute
	cliSubscriptionImagePreflightTimeout = 15 * time.Second
	cliSubscriptionImageLimit            = int64(32 * 1024 * 1024)
)

type cliSubscriptionImageOutput struct {
	LocalPath string `json:"localPath"`
}

type cliSubscriptionImageDoctorResponse struct {
	OK                bool `json:"ok"`
	ProviderSelection struct {
		Resolved string `json:"resolved"`
	} `json:"provider_selection"`
	Providers struct {
		Codex struct {
			Auth struct {
				Ready   bool `json:"ready"`
				Expired bool `json:"expired"`
			} `json:"auth"`
			Endpoint struct {
				Reachable bool            `json:"reachable"`
				Error     json.RawMessage `json:"error"`
			} `json:"endpoint"`
		} `json:"codex"`
	} `json:"providers"`
}

var cliSubscriptionImageFinalized = struct {
	sync.Mutex
	Results map[string]CLIHelperResult
}{Results: map[string]CLIHelperResult{}}

var (
	cliSubscriptionImageURLQueryPattern = regexp.MustCompile(`(https?://[^\s?]+)\?[^\s]+`)
	cliSubscriptionImageJWTPattern      = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)
)

func validSubscriptionImageGenerationRequest(input cliCompanionActionRequest) bool {
	if input.Action != cliCompanionActionGenerationStart || input.GenerationType != "image" || input.TaskID != "" || input.Duration != 0 || len(input.Prompt) == 0 || len(input.Prompt) > jimengPromptLimit || strings.ContainsRune(input.Prompt, '\x00') {
		return false
	}
	if !map[string]bool{"1:1": true, "16:9": true, "9:16": true, "3:2": true, "2:3": true}[input.Ratio] || !map[string]bool{"low": true, "medium": true, "high": true}[input.Resolution] {
		return false
	}
	return input.Protocol == "gpt-image-2" && input.Model == cliGPTImage2Model || input.Protocol == "codex-image-emergency" && input.Model == cliCodexEmergencyImageModel
}

func executeSubscriptionImageGenerationStart(parent context.Context, input cliCompanionActionRequest) (CLIHelperResult, model.ProviderStatus) {
	result := CLIHelperResult{Protocol: input.Protocol}
	if !validSubscriptionImageGenerationRequest(input) {
		result.Message = "订阅生图参数无效"
		return result, model.ProviderStatusUnavailable
	}
	hashes, err := loadCLIHelperHashes(input.Protocol, time.Now())
	if err != nil {
		result.Message = "CLI helper 可信清单未配置或无效"
		return result, model.ProviderStatusUnavailable
	}
	executable, err := findControlledCLIExecutable(cliSpecs[input.Protocol].Candidates, hashes)
	if err != nil {
		result.Message = "未检测到受支持的订阅生图 CLI"
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
		result.Message = "订阅生图任务创建失败"
		return result, model.ProviderStatusFailed
	}
	directory, err := newSubscriptionImageDirectory()
	if err != nil {
		result.Message = "订阅生图临时目录创建失败"
		return result, model.ProviderStatusFailed
	}
	ctx, cancel := context.WithTimeout(parent, cliSubscriptionImageTimeout)
	taskType := "subscription-image"
	if input.Protocol == "codex-image-emergency" {
		taskType = "codex-image-emergency"
	}
	task := &cliModelProbeTask{ID: taskID, UserID: input.UserID, ProviderID: input.ProviderID, Protocol: input.Protocol, GenerationType: "image", TaskType: taskType, Status: "running", Message: subscriptionImageRunningMessage(input.Protocol), UpdatedAt: time.Now(), Cancel: cancel}
	cliModelProbeState.Tasks[taskID] = task
	cliModelProbeState.ActiveID = taskID
	go runSubscriptionImageGeneration(ctx, cancel, executable, directory, input, taskID)
	result = cliModelProbeResult(task)
	result.Executable = executable
	return result, model.ProviderStatusConnected
}

func subscriptionImageRunningMessage(protocol string) string {
	if protocol == "codex-image-emergency" {
		return "Codex 应急生图正在执行；本次会占用 Codex 订阅调用"
	}
	return "GPT Image 2 订阅生图正在执行"
}

func runSubscriptionImageGeneration(ctx context.Context, cancel context.CancelFunc, executable string, directory string, input cliCompanionActionRequest, taskID string) {
	defer cancel()
	outputPath := filepath.Join(directory, "output.png")
	if input.Protocol == "gpt-image-2" {
		diagnostic, err := verifySubscriptionImageEndpoint(ctx, executable)
		if err != nil {
			finishSubscriptionImageGeneration(taskID, directory, outputPath, ctx.Err(), err, diagnostic)
			return
		}
	}
	var command *exec.Cmd
	if input.Protocol == "gpt-image-2" {
		command = exec.CommandContext(ctx, executable,
			"--json", "--provider", "codex", "images", "generate",
			"--prompt", input.Prompt, "--out", outputPath, "--model", "gpt-5.4",
			"--format", "png", "--size", subscriptionImageSize(input.Ratio), "--quality", input.Resolution,
		)
	} else {
		lastMessagePath := filepath.Join(directory, "last-message.txt")
		prompt := "Generate exactly one image for the following request using image_generation. Save the final PNG as output.png in the current working directory. Do not run shell commands or inspect other files.\n\n" + input.Prompt
		command = exec.CommandContext(ctx, executable,
			"exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral",
			"--model", "gpt-5.5", "--enable", "image_generation", "--output-last-message", lastMessagePath, "-",
		)
		command.Stdin = strings.NewReader(prompt)
	}
	command.Dir = directory
	command.Env = controlledCLIEnvironment()
	var output, errorOutput cappedCLIOutput
	command.Stdout = &output
	command.Stderr = &errorOutput
	err := command.Run()
	contextErr := ctx.Err()
	if err == nil {
		outputPath, err = findSubscriptionImageOutput(directory, outputPath)
	}
	diagnostic := safeSubscriptionImageDiagnostic(output.String(), errorOutput.String(), input.Prompt, err)
	finishSubscriptionImageGeneration(taskID, directory, outputPath, contextErr, err, diagnostic)
}

func verifySubscriptionImageEndpoint(parent context.Context, executable string) (string, error) {
	ctx, cancel := context.WithTimeout(parent, cliSubscriptionImagePreflightTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "--json", "--provider", "codex", "doctor")
	command.Env = controlledCLIEnvironment()
	var output, errorOutput cappedCLIOutput
	command.Stdout = &output
	command.Stderr = &errorOutput
	runErr := command.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "network connection preflight timeout", errors.New("subscription image preflight timeout")
	}
	return subscriptionImageDoctorResult(output.String(), errorOutput.String(), runErr)
}

func subscriptionImageDoctorResult(stdout string, stderr string, runErr error) (string, error) {
	var response cliSubscriptionImageDoctorResponse
	if json.Unmarshal([]byte(strings.TrimSpace(stdout)), &response) != nil {
		diagnostic := safeSubscriptionImageDiagnostic(stdout, stderr, "", runErr)
		if diagnostic == "" {
			diagnostic = "subscription endpoint preflight returned invalid JSON"
		}
		return diagnostic, errors.New("subscription image preflight failed")
	}
	codex := response.Providers.Codex
	if response.OK && response.ProviderSelection.Resolved == "codex" && codex.Auth.Ready && !codex.Auth.Expired && codex.Endpoint.Reachable {
		return "", nil
	}
	diagnostic := ""
	switch {
	case !codex.Auth.Ready || codex.Auth.Expired:
		diagnostic = "login required"
	case response.ProviderSelection.Resolved != "codex":
		diagnostic = "unsupported subscription provider"
	case !codex.Endpoint.Reachable:
		diagnostic = "network connection failed"
		if detail := subscriptionImageDoctorError(codex.Endpoint.Error); detail != "" {
			diagnostic += ": " + detail
		}
	default:
		diagnostic = "subscription endpoint preflight failed"
	}
	return safeSubscriptionImageDiagnostic("", diagnostic, "", runErr), errors.New("subscription image preflight failed")
}

func subscriptionImageDoctorError(raw json.RawMessage) string {
	var message string
	if json.Unmarshal(raw, &message) == nil {
		return strings.TrimSpace(message)
	}
	var detail struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &detail) == nil {
		return strings.TrimSpace(detail.Code + " " + detail.Message)
	}
	return ""
}

func safeSubscriptionImageDiagnostic(stdout string, stderr string, prompt string, commandErr error) string {
	diagnostic := strings.TrimSpace(stderr + "\n" + stdout)
	if prompt != "" {
		diagnostic = strings.ReplaceAll(diagnostic, prompt, "[prompt redacted]")
		if encoded, err := json.Marshal(prompt); err == nil {
			diagnostic = strings.ReplaceAll(diagnostic, strings.Trim(string(encoded), `"`), "[prompt redacted]")
		}
	}
	diagnostic = cliSubscriptionImageURLQueryPattern.ReplaceAllString(diagnostic, "$1?[redacted]")
	diagnostic = cliSubscriptionImageJWTPattern.ReplaceAllString(diagnostic, "[redacted]")
	diagnostic = RedactSensitiveText(redactLargePlainLogText(sanitizeCLIOutput(diagnostic)))
	if diagnostic == "" && commandErr != nil {
		diagnostic = commandErr.Error()
	}
	runes := []rune(diagnostic)
	if len(runes) > 512 {
		diagnostic = string(runes[:512])
	}
	return diagnostic
}

func subscriptionImageFailureMessage(diagnostic string) string {
	detail := strings.ToLower(diagnostic)
	switch {
	case strings.Contains(detail, "unauthorized"), strings.Contains(detail, "unauthenticated"), strings.Contains(detail, "invalid_grant"), strings.Contains(detail, "token expired"), strings.Contains(detail, "login required"), strings.Contains(detail, "not logged in"):
		return "GPT Image 2 订阅登录已失效，请重新登录 Codex"
	case strings.Contains(detail, "insufficient"), strings.Contains(detail, "quota"), strings.Contains(detail, "credit"), strings.Contains(detail, "balance"), strings.Contains(detail, "额度"), strings.Contains(detail, "余额"):
		return "GPT Image 2 订阅额度不足或当前账户受限"
	case strings.Contains(detail, "429"), strings.Contains(detail, "rate limit"), strings.Contains(detail, "too many requests"), strings.Contains(detail, "限流"):
		return "GPT Image 2 订阅请求频率受限，请稍后重试"
	case strings.Contains(detail, "model"), strings.Contains(detail, "image_generation"), strings.Contains(detail, "unsupported"), strings.Contains(detail, "not available"):
		return "GPT Image 2 模型或生图能力当前不可用"
	case strings.Contains(detail, "network"), strings.Contains(detail, "connection"), strings.Contains(detail, "connect"), strings.Contains(detail, "dns"), strings.Contains(detail, "tls"):
		return "GPT Image 2 订阅网络请求失败"
	case diagnostic != "" && !strings.HasPrefix(detail, "exit status"):
		return "订阅生图调用失败：" + diagnostic
	default:
		return "订阅生图调用失败；不会自动切换其他额度或付费 API"
	}
}

func subscriptionImageSize(ratio string) string {
	switch ratio {
	case "16:9", "3:2":
		return "1536x1024"
	case "9:16", "2:3":
		return "1024x1536"
	default:
		return "1024x1024"
	}
}

func newSubscriptionImageDirectory() (string, error) {
	root := filepath.Join(os.TempDir(), "infinite-canvas-cli-images")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return "", errors.New("CLI image output root is unsafe")
	}
	return os.MkdirTemp(root, "task-")
}

func findSubscriptionImageOutput(directory string, preferred string) (string, error) {
	if validSubscriptionImageFile(preferred) {
		return preferred, nil
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		path := filepath.Join(directory, entry.Name())
		if strings.EqualFold(filepath.Ext(entry.Name()), ".png") && validSubscriptionImageFile(path) {
			return path, nil
		}
	}
	return "", errors.New("subscription image output is missing")
}

func validSubscriptionImageFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 8 && info.Size() <= cliSubscriptionImageLimit
}

func finishSubscriptionImageGeneration(taskID string, directory string, outputPath string, contextErr error, commandErr error, diagnostic string) {
	cliModelProbeState.Lock()
	defer cliModelProbeState.Unlock()
	task := cliModelProbeState.Tasks[taskID]
	if task == nil {
		_ = os.RemoveAll(directory)
		return
	}
	if task.Status != "cancelled" {
		switch {
		case errors.Is(contextErr, context.DeadlineExceeded):
			task.Status, task.Message = "timed_out", subscriptionImageTimeoutMessage(diagnostic)
		case errors.Is(contextErr, context.Canceled):
			task.Status, task.Message = "cancelled", "订阅生图调用已取消"
		case commandErr != nil:
			task.Status, task.Message = "failed", subscriptionImageFailureMessage(diagnostic)
		default:
			body, err := json.Marshal(cliSubscriptionImageOutput{LocalPath: outputPath})
			if err != nil || len(body) > cliModelProbeOutputLimit {
				task.Status, task.Message = "failed", "订阅生图返回结构异常"
			} else {
				task.Status, task.Output, task.Message = "succeeded", string(body), "订阅生图完成，正在保存到素材存储"
			}
		}
	}
	if task.Status != "succeeded" {
		_ = os.RemoveAll(directory)
	}
	task.UpdatedAt = time.Now()
	if cliModelProbeState.ActiveID == taskID {
		cliModelProbeState.ActiveID = ""
	}
}

func subscriptionImageTimeoutMessage(diagnostic string) string {
	message := "订阅生图调用超时（3分钟）"
	if strings.TrimSpace(diagnostic) == "" {
		return message
	}
	detail := subscriptionImageFailureMessage(diagnostic)
	if detail == "订阅生图调用失败；不会自动切换其他额度或付费 API" {
		return message
	}
	return message + "；" + detail
}

func finalizeSubscriptionImageResult(ctx context.Context, result CLIHelperResult) (CLIHelperResult, error) {
	cliSubscriptionImageFinalized.Lock()
	defer cliSubscriptionImageFinalized.Unlock()
	if cached, ok := cliSubscriptionImageFinalized.Results[result.TaskID]; ok {
		return cached, nil
	}
	var output cliSubscriptionImageOutput
	if json.Unmarshal([]byte(result.Output), &output) != nil {
		return CLIHelperResult{}, safeMessageError{message: "订阅生图返回结构异常"}
	}
	data, directory, err := readSubscriptionImageOutput(output.LocalPath)
	if err != nil {
		return CLIHelperResult{}, safeMessageError{message: "订阅生图文件无效或已过期"}
	}
	object, err := UploadStorageObject(ctx, "gpt-image-2.png", "image/png", data)
	if err != nil {
		return CLIHelperResult{}, err
	}
	_ = os.RemoveAll(directory)
	body, _ := json.Marshal(jimengGenerationOutput{SubmitID: result.TaskID, URLs: []string{object.URL}})
	result.Output = string(body)
	result.Message = "订阅生图已保存到素材存储"
	cliSubscriptionImageFinalized.Results[result.TaskID] = result
	return result, nil
}

func forgetSubscriptionImageResult(taskID string) {
	cliSubscriptionImageFinalized.Lock()
	delete(cliSubscriptionImageFinalized.Results, taskID)
	cliSubscriptionImageFinalized.Unlock()
}

func readSubscriptionImageOutput(path string) ([]byte, string, error) {
	root := filepath.Clean(filepath.Join(os.TempDir(), "infinite-canvas-cli-images"))
	path = filepath.Clean(path)
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == "." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) || filepath.IsAbs(relative) {
		return nil, "", errors.New("CLI image output path is unsafe")
	}
	rootResolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, "", err
	}
	pathResolved, err := filepath.EvalSymlinks(path)
	if err != nil || !strings.HasPrefix(pathResolved, rootResolved+string(os.PathSeparator)) || !validSubscriptionImageFile(pathResolved) {
		return nil, "", errors.New("CLI image output path is unsafe")
	}
	file, err := os.Open(pathResolved)
	if err != nil {
		return nil, "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, cliSubscriptionImageLimit+1))
	if err != nil || int64(len(data)) > cliSubscriptionImageLimit || !bytes.HasPrefix(data, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		return nil, "", errors.New("CLI image output is invalid")
	}
	return data, filepath.Dir(pathResolved), nil
}

func cleanupCLIGenerationOutput(output string) {
	var value cliSubscriptionImageOutput
	if json.Unmarshal([]byte(output), &value) == nil && value.LocalPath != "" {
		if _, directory, err := readSubscriptionImageOutput(value.LocalPath); err == nil {
			_ = os.RemoveAll(directory)
		}
	}
}
