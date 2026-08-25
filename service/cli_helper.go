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
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const (
	cliHelperOutputLimit   = 16 * 1024
	cliHelperManifestLimit = 64 * 1024
	cliHelperBinaryLimit   = int64(256 * 1024 * 1024)
)

var (
	cliHelperSlots  = make(chan struct{}, 2)
	cliSecretLine   = regexp.MustCompile(`(?i)(api[_-]?key|authorization|bearer|token|secret|password)\s*[:=]\s*\S+`)
	cliAllowedRoots = controlledCLIAllowedRoots
	cliSpecs        = map[string]struct {
		Candidates []string
		Version    []string
	}{
		"codex":      {Candidates: []string{"codex"}, Version: []string{"--version"}},
		"gemini-cli": {Candidates: []string{"gemini", "agy"}, Version: []string{"--version"}},
		"jimeng":     {Candidates: []string{"dreamina"}, Version: []string{"--version"}},
	}
)

type CLIHelperResult struct {
	Available  bool   `json:"available"`
	Protocol   string `json:"protocol"`
	Executable string `json:"executable,omitempty"`
	Version    string `json:"version,omitempty"`
	AuthStatus string `json:"authStatus,omitempty"`
	Message    string `json:"message"`
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
	if item.Protocol != "codex" {
		return CLIHelperResult{Protocol: item.Protocol, AuthStatus: "unsupported", Message: "该 CLI 暂无已确认的非交互登录状态命令"}, nil
	}
	if !config.Cfg.CLIHelperEnabled {
		return CLIHelperResult{Protocol: item.Protocol, Message: "Mac CLI helper 未启用"}, nil
	}
	if runtime.GOOS != "darwin" {
		return CLIHelperResult{Protocol: item.Protocol, Message: "CLI helper 仅支持 macOS"}, nil
	}
	result, _, err := requestCLICompanionAction(ctx, item.OwnerUserID, item.ID, item.Protocol, cliCompanionActionAuthStatus)
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
	if err := command.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			result.Message = "CLI 版本检测超时"
			return result, model.ProviderStatusTimeout
		}
		result.Message = "CLI 版本检测失败"
		return result, model.ProviderStatusFailed
	}
	version := sanitizeCLIOutput(output.String())
	if version == "" {
		version = "已安装（版本未知）"
	}
	result.Available = true
	result.Executable = executable
	result.Version = version
	result.Message = "CLI 检测成功"
	return result, model.ProviderStatusConnected
}

func executeCLICompanionAction(parent context.Context, action string, protocol string) (CLIHelperResult, model.ProviderStatus) {
	switch action {
	case cliCompanionActionVersion:
		return executeCLICompanionVersion(parent, protocol)
	case cliCompanionActionAuthStatus:
		return executeCLICompanionAuthStatus(parent, protocol)
	default:
		return CLIHelperResult{Protocol: protocol, Message: "CLI 动作不受支持"}, model.ProviderStatusUnavailable
	}
}

func executeCLICompanionAuthStatus(parent context.Context, protocol string) (CLIHelperResult, model.ProviderStatus) {
	result := CLIHelperResult{Protocol: protocol}
	if protocol != "codex" {
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
	result.Message = "Codex CLI 已登录"
	return result, model.ProviderStatusConnected
}

func loadCLIHelperHashes(protocol string, current time.Time) (map[string]string, error) {
	path := strings.TrimSpace(config.Cfg.CLIHelperManifest)
	publicKeyValue := strings.TrimSpace(config.Cfg.CLIHelperPublicKey)
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
	paths := controlledCLIAllowedRoots()
	result := []string{"LANG=C", "LC_ALL=C", "PATH=" + strings.Join(paths, string(os.PathListSeparator))}
	for _, name := range []string{"HOME", "TMPDIR"} {
		if value := os.Getenv(name); value != "" {
			result = append(result, name+"="+value)
		}
	}
	return result
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
