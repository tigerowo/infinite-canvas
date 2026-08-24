package service

import (
	"bytes"
	"context"
	"errors"
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

const cliHelperOutputLimit = 16 * 1024

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
	Message    string `json:"message"`
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
	spec, ok := cliSpecs[item.Protocol]
	if !ok {
		result.Message = "CLI 类型不受支持"
		return result, model.ProviderStatusUnavailable
	}
	select {
	case cliHelperSlots <- struct{}{}:
		defer func() { <-cliHelperSlots }()
	default:
		result.Message = "CLI helper 正忙，请稍后重试"
		return result, model.ProviderStatusTimeout
	}
	executable, err := findControlledCLIExecutable(spec.Candidates)
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

func findControlledCLIExecutable(candidates []string) (string, error) {
	allowedRoots := cliAllowedRoots()
	for _, name := range candidates {
		if filepath.Base(name) != name || strings.ContainsAny(name, `/\\`) {
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
		info, err := os.Stat(resolved)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 {
			continue
		}
		return path, nil
	}
	return "", errors.New("controlled CLI not found")
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
