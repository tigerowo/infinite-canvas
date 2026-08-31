package service

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const (
	cliHelperOutputLimit           = 16 * 1024
	cliHelperManifestLimit         = 64 * 1024
	cliHelperBinaryLimit           = int64(256 * 1024 * 1024)
	cliHelperLoginTimeout          = 10 * time.Minute
	cliAntigravityModelListTimeout = 15 * time.Second
)

var (
	cliHelperSlots = make(chan struct{}, 2)
	cliLoginState  struct {
		sync.Mutex
		running bool
	}
	cliSecretLine             = regexp.MustCompile(`(?i)(api[_-]?key|authorization|bearer|token|secret|password)\s*[:=]\s*\S+`)
	cliGPTImageVersionPattern = regexp.MustCompile(`^gpt-image-2-skill [0-9]+\.[0-9]+\.[0-9]+$`)
	cliAllowedRoots           = controlledCLIAllowedRoots
	cliSpecs                  = map[string]struct {
		Candidates []string
		Version    []string
	}{
		"codex":                 {Candidates: []string{"codex"}, Version: []string{"--version"}},
		"codex-image-emergency": {Candidates: []string{"codex"}, Version: []string{"--version"}},
		"gpt-image-2":           {Candidates: []string{"gpt-image-2-skill"}, Version: []string{"--version"}},
		"gemini-cli":            {Candidates: []string{"agy"}, Version: []string{"--version"}},
		"jimeng":                {Candidates: []string{"dreamina"}, Version: []string{"--version"}},
	}
	cliModelNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`)
	cliCreditPattern    = regexp.MustCompile(`^\d{1,18}(?:\.\d{1,8})?$`)
)

type CLIAccountSummary struct {
	UserName    string `json:"userName"`
	VIPLevel    string `json:"vipLevel"`
	TotalCredit string `json:"totalCredit"`
}

type CLIHelperResult struct {
	Available    bool               `json:"available"`
	Protocol     string             `json:"protocol"`
	Executable   string             `json:"executable,omitempty"`
	Version      string             `json:"version,omitempty"`
	AuthStatus   string             `json:"authStatus,omitempty"`
	ActionStatus string             `json:"actionStatus,omitempty"`
	TaskID       string             `json:"taskId,omitempty"`
	TaskStatus   string             `json:"taskStatus,omitempty"`
	Output       string             `json:"output,omitempty"`
	Models       []string           `json:"models,omitempty"`
	Account      *CLIAccountSummary `json:"account,omitempty"`
	Message      string             `json:"message"`
}

type cliHelperManifestEnvelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

type cliHelperManifest struct {
	Version     int                      `json:"version"`
	ExpiresAt   string                   `json:"expiresAt"`
	Executables []cliHelperManifestEntry `json:"executables"`
}

type cliHelperManifestEntry struct {
	Protocol  string `json:"protocol"`
	Candidate string `json:"candidate"`
	SHA256    string `json:"sha256"`
}

func DetectCurrentUserCLIProvider(ctx context.Context, providerID string) (CLIHelperResult, error) {
	_, item, err := currentUserProvider(ctx, providerID)
	if err != nil {
		return CLIHelperResult{}, err
	}
	if item.Kind != model.ProviderKindCLI || !item.Enabled {
		return CLIHelperResult{}, safeMessageError{message: "CLI 渠道不可用"}
	}
	result, status := detectCLIProvider(ctx, item)
	item.ConnectionStatus = status
	item.StatusMessage = result.Message
	item.LastCheckedAt = now()
	item.UpdatedAt = item.LastCheckedAt
	if result.Available {
		item.Executable = result.Executable
		item.Version = result.Version
	}
	if len(result.Models) > 0 {
		item.Models = result.Models
		item.Capabilities = trustedCLIProviderCapabilities(item.Protocol)
		if !userLocalChannelHasModel(item.Models, item.DefaultModel) {
			item.DefaultModel = item.Models[0]
		}
	}
	if _, err := repository.SaveProvider(item); err != nil {
		return CLIHelperResult{}, err
	}
	return result, nil
}

func CheckCurrentUserCLIProviderAuth(ctx context.Context, providerID string) (CLIHelperResult, error) {
	_, item, err := currentUserProvider(ctx, providerID)
	if err != nil {
		return CLIHelperResult{}, err
	}
	if item.Kind != model.ProviderKindCLI || !item.Enabled {
		return CLIHelperResult{}, safeMessageError{message: "CLI 渠道不可用"}
	}
	if _, ok := cliSpecs[item.Protocol]; !ok {
		return CLIHelperResult{Protocol: item.Protocol, AuthStatus: "unsupported", Message: "CLI 类型不受支持"}, nil
	}
	if item.Protocol != "codex" && item.Protocol != "gemini-cli" && item.Protocol != "jimeng" {
		return CLIHelperResult{Protocol: item.Protocol, AuthStatus: "unsupported", Message: "该 CLI 暂无已确认的非交互登录状态命令"}, nil
	}
	if !config.Cfg.CLIHelperEnabled {
		return CLIHelperResult{Protocol: item.Protocol, Message: "Mac CLI helper 未启用"}, nil
	}
	if runtime.GOOS != "darwin" {
		return CLIHelperResult{Protocol: item.Protocol, Message: "CLI helper 仅支持 macOS"}, nil
	}
	result, status, err := requestCLICompanionAction(ctx, item.OwnerUserID, item.ID, item.Protocol, cliCompanionActionAuthStatus)
	if err != nil {
		return CLIHelperResult{Protocol: item.Protocol, Message: "CLI 伴随进程未连接或授权失败"}, nil
	}
	if result.AuthStatus != "" {
		item.ConnectionStatus = status
		item.StatusMessage = result.Message
		item.LastCheckedAt = now()
		item.UpdatedAt = item.LastCheckedAt
	}
	if len(result.Models) > 0 {
		item.Models = result.Models
		item.Capabilities = trustedCLIProviderCapabilities(item.Protocol)
		if !userLocalChannelHasModel(item.Models, item.DefaultModel) {
			item.DefaultModel = item.Models[0]
		}
	}
	if result.AuthStatus != "" {
		if _, saveErr := repository.SaveProvider(item); saveErr != nil {
			return CLIHelperResult{}, saveErr
		}
	}
	return result, nil
}

func GetCurrentUserCLIAccountSummary(ctx context.Context, providerID string) (CLIHelperResult, error) {
	_, item, err := currentUserProvider(ctx, providerID)
	if err != nil {
		return CLIHelperResult{}, err
	}
	if item.Kind != model.ProviderKindCLI || !item.Enabled || item.Protocol != "jimeng" {
		return CLIHelperResult{}, safeMessageError{message: "仅已启用的即梦 CLI 连接支持账户概览"}
	}
	if !config.Cfg.CLIHelperEnabled {
		return CLIHelperResult{Protocol: item.Protocol, Message: "Mac CLI helper 未启用"}, nil
	}
	if runtime.GOOS != "darwin" {
		return CLIHelperResult{Protocol: item.Protocol, Message: "CLI helper 仅支持 macOS"}, nil
	}
	result, _, err := requestCLICompanionAction(ctx, item.OwnerUserID, item.ID, item.Protocol, cliCompanionActionAccountSummary)
	if err != nil {
		return CLIHelperResult{Protocol: item.Protocol, Message: "CLI 伴随进程未连接或授权失败"}, nil
	}
	return result, nil
}

func StartCurrentUserCLIProviderLogin(ctx context.Context, providerID string) (CLIHelperResult, error) {
	_, item, err := currentUserProvider(ctx, providerID)
	if err != nil {
		return CLIHelperResult{}, err
	}
	if item.Kind != model.ProviderKindCLI || !item.Enabled {
		return CLIHelperResult{}, safeMessageError{message: "CLI 渠道不可用"}
	}
	if item.Protocol != "codex" {
		return CLIHelperResult{Protocol: item.Protocol, ActionStatus: "unsupported", Message: "该 CLI 暂不支持受控浏览器登录"}, nil
	}
	if !config.Cfg.CLIHelperEnabled {
		return CLIHelperResult{Protocol: item.Protocol, Message: "Mac CLI helper 未启用"}, nil
	}
	if runtime.GOOS != "darwin" {
		return CLIHelperResult{Protocol: item.Protocol, Message: "CLI helper 仅支持 macOS"}, nil
	}
	result, _, err := requestCLICompanionAction(ctx, item.OwnerUserID, item.ID, item.Protocol, cliCompanionActionLoginStart)
	if err != nil {
		return CLIHelperResult{Protocol: item.Protocol, Message: "CLI 伴随进程未连接或授权失败"}, nil
	}
	return result, nil
}

func detectCLIProvider(parent context.Context, item model.Provider) (CLIHelperResult, model.ProviderStatus) {
	result := CLIHelperResult{Protocol: item.Protocol}
	if !config.Cfg.CLIHelperEnabled {
		result.Message = "Mac CLI helper 未启用"
		return result, model.ProviderStatusUnavailable
	}
	if runtime.GOOS != "darwin" {
		result.Message = "CLI helper 仅支持 macOS"
		return result, model.ProviderStatusUnavailable
	}
	if _, ok := cliSpecs[item.Protocol]; !ok {
		result.Message = "CLI 类型不受支持"
		return result, model.ProviderStatusUnavailable
	}
	result, status, err := requestCLICompanion(parent, item.OwnerUserID, item.ID, item.Protocol)
	if err != nil {
		result = CLIHelperResult{Protocol: item.Protocol, Message: "CLI 伴随进程未连接或授权失败"}
		return result, model.ProviderStatusUnavailable
	}
	return result, status
}

func executeCLICompanionVersion(parent context.Context, protocol string) (CLIHelperResult, model.ProviderStatus) {
	result := CLIHelperResult{Protocol: protocol}
	spec, ok := cliSpecs[protocol]
	if !ok {
		result.Message = "CLI 类型不受支持"
		return result, model.ProviderStatusUnavailable
	}
	hashes, err := loadCLIHelperHashes(protocol, time.Now())
	if err != nil {
		result.Message = "CLI helper 可信清单未配置或无效"
		return result, model.ProviderStatusUnavailable
	}
	select {
	case cliHelperSlots <- struct{}{}:
		defer func() { <-cliHelperSlots }()
	default:
		result.Message = "CLI helper 正忙，请稍后重试"
		return result, model.ProviderStatusTimeout
	}
	executable, err := findControlledCLIExecutable(spec.Candidates, hashes)
	if err != nil {
		result.Message = "未检测到受支持的 CLI"
		return result, model.ProviderStatusUnavailable
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, spec.Version...)
	command.Env = controlledCLIEnvironment()
	var output cappedCLIOutput
	command.Stdout = &output
	command.Stderr = &output
	runErr := command.Run()
	version := ""
	if runErr != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			result.Message = "CLI 版本检测超时"
			return result, model.ProviderStatusTimeout
		}
		if protocol != "gpt-image-2" {
			result.Message = "CLI 版本检测失败"
			return result, model.ProviderStatusFailed
		}
		var ok bool
		version, ok = parseGPTImageVersionOutput(output.String())
		if !ok {
			result.Message = "CLI 版本检测失败"
			return result, model.ProviderStatusFailed
		}
	}
	if version == "" {
		version = sanitizeCLIOutput(output.String())
	}
	if version == "" {
		version = "已安装（版本未知）"
	}
	result.Available = true
	result.Executable = executable
	result.Version = version
	if protocol == "codex" {
		result.Models = []string{cliCodexDefaultModel}
	}
	if protocol == "codex-image-emergency" {
		result.Models = []string{cliCodexEmergencyImageModel}
		result.Message = "Codex 应急生图 CLI 检测成功；每次调用都需要单独确认"
		return result, model.ProviderStatusConnected
	}
	if protocol == "gpt-image-2" {
		result.Models = []string{cliGPTImage2Model}
		result.Message = "GPT Image 2 订阅 helper 检测成功；调用时仅使用 Codex 登录态"
		return result, model.ProviderStatusConnected
	}
	if protocol == "gemini-cli" {
		models, modelErr := executeAntigravityModelList(parent, executable)
		if modelErr != nil {
			result.Message = "Antigravity CLI 已安装，但登录状态或模型列表不可用"
			return result, model.ProviderStatusUnavailable
		}
		result.Models = models
		result.Message = "Antigravity CLI 检测成功，已读取文本模型"
		if userLocalChannelHasModel(models, cliAntigravityImageModel) {
			result.Message += "并启用 Nano Banana 2 生图工具"
		}
		return result, model.ProviderStatusConnected
	}
	result.Message = "CLI 检测成功"
	return result, model.ProviderStatusConnected
}

func parseGPTImageVersionOutput(value string) (string, bool) {
	var response struct {
		OK    bool `json:"ok"`
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(value), &response) != nil || response.OK || response.Error.Code != "invalid_command" {
		return "", false
	}
	version := strings.TrimSpace(response.Error.Message)
	return version, cliGPTImageVersionPattern.MatchString(version)
}

func executeCLICompanionAction(parent context.Context, input cliCompanionActionRequest) (CLIHelperResult, model.ProviderStatus) {
	switch input.Action {
	case cliCompanionActionVersion:
		return executeCLICompanionVersion(parent, input.Protocol)
	case cliCompanionActionAuthStatus:
		return executeCLICompanionAuthStatus(parent, input.Protocol)
	case cliCompanionActionAccountSummary:
		return executeCLICompanionAccountSummary(parent, input.Protocol)
	case cliCompanionActionLoginStart:
		return executeCLICompanionLoginStart(parent, input.Protocol)
	case cliCompanionActionProbeStart:
		return executeCLIModelProbeStart(parent, input)
	case cliCompanionActionProbeStatus:
		return executeCLIModelProbeStatus(input)
	case cliCompanionActionProbeCancel:
		return executeCLIModelProbeCancel(input)
	case cliCompanionActionCompletionStart:
		if input.Protocol == "codex" {
			return executeCodexCompletionStart(parent, input)
		}
		return executeAntigravityCompletionStart(parent, input)
	case cliCompanionActionGenerationStart:
		if input.Protocol == "jimeng" {
			return executeJimengGenerationStart(parent, input)
		}
		return executeSubscriptionImageGenerationStart(parent, input)
	case cliCompanionActionGenerationStatus:
		return executeCLIModelProbeStatus(input)
	case cliCompanionActionGenerationCancel:
		return executeCLIModelProbeCancel(input)
	default:
		return CLIHelperResult{Protocol: input.Protocol, Message: "CLI 动作不受支持"}, model.ProviderStatusUnavailable
	}
}

func executeCLICompanionLoginStart(parent context.Context, protocol string) (CLIHelperResult, model.ProviderStatus) {
	result := CLIHelperResult{Protocol: protocol}
	if protocol != "codex" {
		result.ActionStatus = "unsupported"
		result.Message = "该 CLI 暂不支持受控浏览器登录"
		return result, model.ProviderStatusUnavailable
	}
	hashes, err := loadCLIHelperHashes(protocol, time.Now())
	if err != nil {
		result.Message = "CLI helper 可信清单未配置或无效"
		return result, model.ProviderStatusUnavailable
	}
	executable, err := findControlledCLIExecutable(cliSpecs[protocol].Candidates, hashes)
	if err != nil {
		result.Message = "未检测到受支持的 CLI"
		return result, model.ProviderStatusUnavailable
	}
	result.Available = true
	result.Executable = executable
	cliLoginState.Lock()
	defer cliLoginState.Unlock()
	if cliLoginState.running {
		result.ActionStatus = "running"
		result.Message = "Codex 登录流程已在进行"
		return result, model.ProviderStatusConnected
	}
	ctx, cancel := context.WithTimeout(parent, cliHelperLoginTimeout)
	command := exec.CommandContext(ctx, executable, "login")
	command.Env = controlledCLIEnvironment()
	command.Stdin = nil
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		cancel()
		result.Message = "Codex 登录流程启动失败"
		return result, model.ProviderStatusFailed
	}
	cliLoginState.running = true
	go func() {
		_ = command.Wait()
		cancel()
		cliLoginState.Lock()
		cliLoginState.running = false
		cliLoginState.Unlock()
	}()
	result.ActionStatus = "started"
	result.Message = "Codex 登录已启动，请在浏览器完成授权"
	return result, model.ProviderStatusConnected
}

func executeCLICompanionAuthStatus(parent context.Context, protocol string) (CLIHelperResult, model.ProviderStatus) {
	result := CLIHelperResult{Protocol: protocol}
	if protocol != "codex" && protocol != "gemini-cli" && protocol != "jimeng" {
		result.AuthStatus = "unsupported"
		result.Message = "该 CLI 暂无已确认的非交互登录状态命令"
		return result, model.ProviderStatusUnavailable
	}
	hashes, err := loadCLIHelperHashes(protocol, time.Now())
	if err != nil {
		result.Message = "CLI helper 可信清单未配置或无效"
		return result, model.ProviderStatusUnavailable
	}
	select {
	case cliHelperSlots <- struct{}{}:
		defer func() { <-cliHelperSlots }()
	default:
		result.Message = "CLI helper 正忙，请稍后重试"
		return result, model.ProviderStatusTimeout
	}
	executable, err := findControlledCLIExecutable(cliSpecs[protocol].Candidates, hashes)
	if err != nil {
		result.Message = "未检测到受支持的 CLI"
		return result, model.ProviderStatusUnavailable
	}
	result.Available = true
	result.Executable = executable
	if protocol == "jimeng" {
		if err := executeDreaminaAuthStatus(parent, executable); err != nil {
			result.AuthStatus = "unauthenticated"
			result.Message = "即梦 CLI 未登录或账户状态不可用"
			return result, model.ProviderStatusUnavailable
		}
		result.AuthStatus = "authenticated"
		result.Models = append([]string(nil), jimengCLIModels...)
		result.Message = "即梦 CLI 已登录"
		return result, model.ProviderStatusConnected
	}
	if protocol == "gemini-cli" {
		models, err := executeAntigravityModelList(parent, executable)
		if err != nil {
			result.AuthStatus = "unauthenticated"
			result.Message = "Antigravity CLI 未登录或模型列表不可用"
			return result, model.ProviderStatusUnavailable
		}
		result.AuthStatus = "authenticated"
		result.Models = models
		result.Message = "Antigravity CLI 已登录"
		if userLocalChannelHasModel(models, cliAntigravityImageModel) {
			result.Message += "，Nano Banana 2 生图工具可用"
		}
		return result, model.ProviderStatusConnected
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "login", "status")
	command.Env = controlledCLIEnvironment()
	var output cappedCLIOutput
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			result.Message = "CLI 登录状态检测超时"
			return result, model.ProviderStatusTimeout
		}
		result.AuthStatus = "unauthenticated"
		result.Message = "Codex CLI 未登录或凭据不可用"
		return result, model.ProviderStatusUnavailable
	}
	result.AuthStatus = "authenticated"
	result.Models = []string{cliCodexDefaultModel}
	result.Message = "Codex CLI 已登录"
	return result, model.ProviderStatusConnected
}

func executeDreaminaAuthStatus(parent context.Context, executable string) error {
	_, err := queryDreaminaAccountSummary(parent, executable)
	return err
}

func executeCLICompanionAccountSummary(parent context.Context, protocol string) (CLIHelperResult, model.ProviderStatus) {
	result := CLIHelperResult{Protocol: protocol}
	if protocol != "jimeng" {
		result.Message = "该 CLI 不支持账户概览"
		return result, model.ProviderStatusUnavailable
	}
	hashes, err := loadCLIHelperHashes(protocol, time.Now())
	if err != nil {
		result.Message = "CLI helper 可信清单未配置或无效"
		return result, model.ProviderStatusUnavailable
	}
	select {
	case cliHelperSlots <- struct{}{}:
		defer func() { <-cliHelperSlots }()
	default:
		result.Message = "CLI helper 正忙，请稍后重试"
		return result, model.ProviderStatusTimeout
	}
	executable, err := findControlledCLIExecutable(cliSpecs[protocol].Candidates, hashes)
	if err != nil {
		result.Message = "未检测到受支持的 CLI"
		return result, model.ProviderStatusUnavailable
	}
	account, err := queryDreaminaAccountSummary(parent, executable)
	if err != nil {
		result.Message = "即梦账户信息读取失败，请重新登录后重试"
		return result, model.ProviderStatusUnavailable
	}
	result.Available = true
	result.Executable = executable
	result.Account = &account
	result.Message = "即梦账户信息已更新"
	return result, model.ProviderStatusConnected
}

func queryDreaminaAccountSummary(parent context.Context, executable string) (CLIAccountSummary, error) {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "user_credit")
	command.Env = controlledCLIEnvironment()
	command.Stdin = nil
	var output cappedCLIOutput
	command.Stdout = &output
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		return CLIAccountSummary{}, err
	}
	var value struct {
		TotalCredit json.Number `json:"total_credit"`
		UserID      json.Number `json:"user_id"`
		UserName    string      `json:"user_name"`
		VIPLevel    string      `json:"vip_level"`
	}
	decoder := json.NewDecoder(strings.NewReader(output.String()))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil || value.UserID == "" {
		return CLIAccountSummary{}, errors.New("Dreamina account response is invalid")
	}
	account := CLIAccountSummary{
		UserName:    strings.TrimSpace(value.UserName),
		VIPLevel:    strings.TrimSpace(value.VIPLevel),
		TotalCredit: value.TotalCredit.String(),
	}
	if !validCLIAccountSummary(account) {
		return CLIAccountSummary{}, errors.New("Dreamina account response is invalid")
	}
	return account, nil
}

func validCLIAccountSummary(value CLIAccountSummary) bool {
	return validCLIAccountText(value.UserName, 128, true) &&
		validCLIAccountText(value.VIPLevel, 64, true) &&
		cliCreditPattern.MatchString(value.TotalCredit)
}

func validCLIAccountText(value string, limit int, allowEmpty bool) bool {
	value = strings.TrimSpace(value)
	if (!allowEmpty && value == "") || len(value) > limit || strings.ContainsRune(value, '\x00') {
		return false
	}
	for _, char := range value {
		if char == '\r' || char == '\n' || char == '\t' {
			return false
		}
	}
	return true
}

func executeAntigravityModelList(parent context.Context, executable string) ([]string, error) {
	ctx, cancel := context.WithTimeout(parent, cliAntigravityModelListTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "models")
	command.Env = controlledCLIEnvironment()
	var output cappedCLIOutput
	command.Stdout = &output
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		return nil, err
	}
	models := make([]string, 0, 16)
	seen := map[string]bool{}
	for _, line := range strings.Split(output.String(), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || !cliModelNamePattern.MatchString(fields[0]) || seen[fields[0]] {
			continue
		}
		models = append(models, fields[0])
		seen[fields[0]] = true
		if len(models) == 64 {
			break
		}
	}
	if len(models) == 0 {
		return nil, errors.New("Antigravity model list is empty")
	}
	if seen[cliAntigravityImageReasoner] {
		models = append(models, cliAntigravityImageModel)
	}
	return models, nil
}

func loadCLIHelperHashes(protocol string, current time.Time) (map[string]string, error) {
	path := strings.TrimSpace(config.Cfg.CLIHelperManifest)
	publicKeyValue := strings.TrimSpace(config.Cfg.CLIHelperPublicKey)
	if publicKeyValue == "" {
		data, err := readProtectedCLIHelperFile(config.Cfg.CLIHelperPublicKeyFile, 4*1024)
		if err != nil {
			return nil, errors.New("CLI helper public key file is invalid")
		}
		publicKeyValue = strings.TrimSpace(string(data))
	}
	if path == "" || !filepath.IsAbs(path) || publicKeyValue == "" {
		return nil, errors.New("CLI helper manifest configuration is missing")
	}
	data, err := readCLIHelperManifest(path)
	if err != nil {
		return nil, errors.New("CLI helper manifest cannot be read")
	}
	publicKey, err := base64.StdEncoding.DecodeString(publicKeyValue)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return nil, errors.New("CLI helper public key is invalid")
	}
	return verifyCLIHelperManifest(data, publicKey, protocol, current)
}

func ValidateCLIHelperTrustConfiguration() error {
	_, err := loadCLIHelperHashes("codex", time.Now())
	return err
}

func readCLIHelperManifest(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > int64(cliHelperManifestLimit) {
		return nil, errors.New("CLI helper manifest file is invalid")
	}
	data, err := io.ReadAll(io.LimitReader(file, int64(cliHelperManifestLimit)+1))
	if err != nil || len(data) == 0 || len(data) > cliHelperManifestLimit {
		return nil, errors.New("CLI helper manifest file is invalid")
	}
	return data, nil
}

func verifyCLIHelperManifest(data []byte, publicKey ed25519.PublicKey, protocol string, current time.Time) (map[string]string, error) {
	var envelope cliHelperManifestEnvelope
	if json.Unmarshal(data, &envelope) != nil {
		return nil, errors.New("CLI helper manifest envelope is invalid")
	}
	payload, err := base64.StdEncoding.DecodeString(strings.TrimSpace(envelope.Payload))
	if err != nil || len(payload) == 0 || len(payload) > cliHelperManifestLimit {
		return nil, errors.New("CLI helper manifest payload is invalid")
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(envelope.Signature))
	if err != nil || !ed25519.Verify(publicKey, payload, signature) {
		return nil, errors.New("CLI helper manifest signature is invalid")
	}
	var manifest cliHelperManifest
	if json.Unmarshal(payload, &manifest) != nil || manifest.Version != 1 || len(manifest.Executables) == 0 || len(manifest.Executables) > 128 {
		return nil, errors.New("CLI helper manifest payload is invalid")
	}
	expiresAt, err := time.Parse(time.RFC3339, strings.TrimSpace(manifest.ExpiresAt))
	if err != nil || !current.Before(expiresAt) {
		return nil, errors.New("CLI helper manifest has expired")
	}
	hashes := map[string]string{}
	for _, entry := range manifest.Executables {
		candidate := strings.TrimSpace(entry.Candidate)
		hash := strings.ToLower(strings.TrimSpace(entry.SHA256))
		if entry.Protocol != protocol || filepath.Base(candidate) != candidate || strings.ContainsAny(candidate, `/\\`) {
			continue
		}
		decoded, decodeErr := hex.DecodeString(hash)
		if decodeErr != nil || len(decoded) != sha256.Size {
			return nil, errors.New("CLI helper manifest hash is invalid")
		}
		hashes[candidate] = hash
	}
	if len(hashes) == 0 {
		return nil, errors.New("CLI helper manifest does not allow this protocol")
	}
	return hashes, nil
}

func findControlledCLIExecutable(candidates []string, allowedHashes map[string]string) (string, error) {
	allowedRoots := cliAllowedRoots()
	for _, name := range candidates {
		if filepath.Base(name) != name || strings.ContainsAny(name, `/\\`) {
			continue
		}
		expectedHash := strings.ToLower(strings.TrimSpace(allowedHashes[name]))
		if expectedHash == "" {
			continue
		}
		path, err := exec.LookPath(name)
		if err != nil {
			continue
		}
		path, err = filepath.Abs(path)
		if err != nil {
			continue
		}
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			continue
		}
		if !pathWithinControlledRoots(path, allowedRoots) || !pathWithinControlledRoots(resolved, allowedRoots) {
			continue
		}
		if !matchesCLIExecutableHash(resolved, expectedHash) {
			continue
		}
		return resolved, nil
	}
	return "", errors.New("controlled CLI not found")
}

func matchesCLIExecutableHash(path string, expectedHash string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 || info.Size() < 0 || info.Size() > cliHelperBinaryLimit {
		return false
	}
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(file, cliHelperBinaryLimit+1))
	return err == nil && written == info.Size() && hex.EncodeToString(hash.Sum(nil)) == expectedHash
}

func controlledCLIAllowedRoots() []string {
	roots := []string{"/usr/bin", "/usr/local", "/opt/homebrew", "/Applications"}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		for _, relative := range []string{".local", ".npm", ".bun", ".codex/bin"} {
			roots = append(roots, filepath.Join(home, relative))
		}
	}
	return roots
}

func controlledCLIPathDirectories() []string {
	directories := []string{"/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/Applications/ChatGPT.app/Contents/Resources"}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		for _, relative := range []string{".local/bin", ".npm/bin", ".bun/bin", ".codex/bin"} {
			directories = append(directories, filepath.Join(home, relative))
		}
	}
	return directories
}

func pathWithinControlledRoots(path string, roots []string) bool {
	path = filepath.Clean(path)
	for _, root := range roots {
		root = filepath.Clean(root)
		if path == root || strings.HasPrefix(path, root+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}

func controlledCLIEnvironment() []string {
	paths := controlledCLIPathDirectories()
	result := []string{"LANG=C", "LC_ALL=C", "PATH=" + strings.Join(paths, string(os.PathListSeparator))}
	for _, name := range []string{"HOME", "TMPDIR"} {
		if value := os.Getenv(name); value != "" {
			result = append(result, name+"="+value)
		}
	}
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"} {
		if value, ok := controlledLoopbackProxy(os.Getenv(name)); ok {
			result = append(result, name+"="+value)
		}
	}
	return result
}

func controlledLoopbackProxy(value string) (string, bool) {
	value = strings.TrimSpace(value)
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.Port() == "" || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", false
	}
	host := strings.TrimSpace(parsed.Hostname())
	ip := net.ParseIP(host)
	if !strings.EqualFold(host, "localhost") && (ip == nil || !ip.IsLoopback()) {
		return "", false
	}
	return value, true
}

type cappedCLIOutput struct {
	buffer bytes.Buffer
}

func (output *cappedCLIOutput) Write(data []byte) (int, error) {
	original := len(data)
	remaining := cliHelperOutputLimit - output.buffer.Len()
	if remaining > 0 {
		if len(data) > remaining {
			data = data[:remaining]
		}
		_, _ = output.buffer.Write(data)
	}
	return original, nil
}

func (output *cappedCLIOutput) String() string {
	return output.buffer.String()
}

func sanitizeCLIOutput(value string) string {
	value = strings.ReplaceAll(value, "\x00", "")
	value = cliSecretLine.ReplaceAllString(value, "$1=[redacted]")
	lines := strings.Fields(strings.TrimSpace(value))
	return strings.TrimSpace(strings.Join(lines, " "))
}
