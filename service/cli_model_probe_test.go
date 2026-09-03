package service

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestExecuteCLIModelProbeUsesFixedReadOnlyCommand(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("Mac CLI helper only runs on macOS")
	}
	directory := t.TempDir()
	resolvedDirectory, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	previousRoots := cliAllowedRoots
	cliAllowedRoots = func() []string { return []string{directory, resolvedDirectory} }
	t.Cleanup(func() { cliAllowedRoots = previousRoots })
	executable := filepath.Join(directory, "codex")
	script := `#!/bin/sh
printf '%s\n' "$@" > "$HOME/probe-args"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    output="$1"
  fi
  shift
done
printf 'OK\n' > "$output"
`
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	t.Setenv("HOME", directory)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(directory, "manifest.json")
	if err := os.WriteFile(manifestPath, cliTestManifest(t, privateKey, time.Now().Add(time.Hour), "codex", "codex", cliTestFileHash(t, executable)), 0o600); err != nil {
		t.Fatal(err)
	}
	previousManifest := config.Cfg.CLIHelperManifest
	previousPublicKey := config.Cfg.CLIHelperPublicKey
	config.Cfg.CLIHelperManifest = manifestPath
	config.Cfg.CLIHelperPublicKey = base64.StdEncoding.EncodeToString(publicKey)
	cliModelProbeState.Lock()
	previousTasks := cliModelProbeState.Tasks
	previousActiveID := cliModelProbeState.ActiveID
	cliModelProbeState.Tasks = map[string]*cliModelProbeTask{}
	cliModelProbeState.ActiveID = ""
	cliModelProbeState.Unlock()
	t.Cleanup(func() {
		config.Cfg.CLIHelperManifest = previousManifest
		config.Cfg.CLIHelperPublicKey = previousPublicKey
		cliModelProbeState.Lock()
		cliModelProbeState.Tasks = previousTasks
		cliModelProbeState.ActiveID = previousActiveID
		cliModelProbeState.Unlock()
	})
	input := cliCompanionActionRequest{Action: cliCompanionActionProbeStart, UserID: "user-1", ProviderID: "provider-1", Protocol: "codex"}
	started, _ := executeCLIModelProbeStart(context.Background(), input)
	if started.TaskStatus != "running" || !cliCompanionTaskPattern.MatchString(started.TaskID) {
		t.Fatalf("started=%#v", started)
	}
	input.Action = cliCompanionActionProbeStatus
	input.TaskID = started.TaskID
	deadline := time.Now().Add(5 * time.Second)
	var result CLIHelperResult
	for {
		result, _ = executeCLIModelProbeStatus(input)
		if result.TaskStatus != "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("model probe did not finish")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if result.TaskStatus != "succeeded" || result.Output != "OK" {
		t.Fatalf("result=%#v", result)
	}
	args, err := os.ReadFile(filepath.Join(directory, "probe-args"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(args)), "\n")
	if len(lines) != 10 || lines[0] != "exec" || lines[1] != "--sandbox" || lines[2] != "read-only" || lines[3] != "--skip-git-repo-check" || lines[4] != "--ephemeral" || lines[5] != "--model" || lines[6] != "gpt-5.5" || lines[7] != "--output-last-message" || filepath.Base(lines[8]) != "last-message.txt" || lines[9] != cliModelProbePrompt {
		t.Fatalf("args=%q", lines)
	}
	crossProvider := input
	crossProvider.ProviderID = "provider-2"
	denied, _ := executeCLIModelProbeStatus(crossProvider)
	if denied.TaskStatus != "" || denied.Output != "" {
		t.Fatalf("cross-provider result=%#v", denied)
	}
	cancelled := false
	cancelTaskID := strings.Repeat("c", 32)
	cliModelProbeState.Lock()
	cliModelProbeState.Tasks[cancelTaskID] = &cliModelProbeTask{ID: cancelTaskID, UserID: "user-1", ProviderID: "provider-1", Protocol: "codex", Status: "running", UpdatedAt: time.Now(), Cancel: func() { cancelled = true }}
	cliModelProbeState.ActiveID = cancelTaskID
	cliModelProbeState.Unlock()
	cancelInput := cliCompanionActionRequest{Action: cliCompanionActionProbeCancel, UserID: "user-1", ProviderID: "provider-1", Protocol: "codex", TaskID: cancelTaskID}
	cancelResult, _ := executeCLIModelProbeCancel(cancelInput)
	if cancelResult.TaskStatus != "cancelled" || !cancelled {
		t.Fatalf("cancel result=%#v cancelled=%v", cancelResult, cancelled)
	}
}

func TestExecuteCLIModelProbeRejectsJimengDetectionOnlyProtocol(t *testing.T) {
	result, status := executeCLIModelProbeStart(context.Background(), cliCompanionActionRequest{
		Action: cliCompanionActionProbeStart, UserID: "user-1", ProviderID: "provider-1", Protocol: "jimeng",
	})
	if status != model.ProviderStatusUnavailable || result.Available || result.TaskID != "" || result.TaskStatus != "" || result.Output != "" || result.Message != "该 CLI 尚不支持受控最小调用" {
		t.Fatalf("result=%#v status=%s", result, status)
	}
}

func TestExecuteAntigravityCompletionUsesFixedHeadlessArguments(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("Mac CLI helper only runs on macOS")
	}
	directory := t.TempDir()
	resolvedDirectory, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	previousRoots := cliAllowedRoots
	cliAllowedRoots = func() []string { return []string{directory, resolvedDirectory} }
	t.Cleanup(func() { cliAllowedRoots = previousRoots })
	executable := filepath.Join(directory, "agy")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HOME/agy-args\"\nprintf 'canvas ok\\n'\n"
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	t.Setenv("HOME", directory)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(directory, "manifest.json")
	if err := os.WriteFile(manifestPath, cliTestManifest(t, privateKey, time.Now().Add(time.Hour), "gemini-cli", "agy", cliTestFileHash(t, executable)), 0o600); err != nil {
		t.Fatal(err)
	}
	previousManifest, previousPublicKey := config.Cfg.CLIHelperManifest, config.Cfg.CLIHelperPublicKey
	config.Cfg.CLIHelperManifest = manifestPath
	config.Cfg.CLIHelperPublicKey = base64.StdEncoding.EncodeToString(publicKey)
	cliModelProbeState.Lock()
	previousTasks, previousActiveID := cliModelProbeState.Tasks, cliModelProbeState.ActiveID
	cliModelProbeState.Tasks, cliModelProbeState.ActiveID = map[string]*cliModelProbeTask{}, ""
	cliModelProbeState.Unlock()
	t.Cleanup(func() {
		config.Cfg.CLIHelperManifest, config.Cfg.CLIHelperPublicKey = previousManifest, previousPublicKey
		cliModelProbeState.Lock()
		cliModelProbeState.Tasks, cliModelProbeState.ActiveID = previousTasks, previousActiveID
		cliModelProbeState.Unlock()
	})
	input := cliCompanionActionRequest{Action: cliCompanionActionCompletionStart, UserID: "user-1", ProviderID: "provider-1", Protocol: "gemini-cli", Model: "gemini-3.5-flash-low", Prompt: "只回复 OK"}
	started, _ := executeAntigravityCompletionStart(context.Background(), input)
	input.Action, input.TaskID, input.Model, input.Prompt = cliCompanionActionProbeStatus, started.TaskID, "", ""
	deadline := time.Now().Add(5 * time.Second)
	var result CLIHelperResult
	for {
		result, _ = executeCLIModelProbeStatus(input)
		if result.TaskStatus != "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Antigravity completion did not finish")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if result.TaskStatus != "succeeded" || result.Output != "canvas ok" {
		t.Fatalf("result=%#v", result)
	}
	args, err := os.ReadFile(filepath.Join(directory, "agy-args"))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--print", "只回复 OK", "--output-format", "text", "--model", "gemini-3.5-flash-low", "--effort", "low", "--print-timeout", "90s", "--disable-slash-commands", "--sandbox"}
	if string(args) != strings.Join(want, "\n")+"\n" {
		t.Fatalf("args=%q", args)
	}
}

func TestParseAntigravityCompletionAcceptsTextOutput(t *testing.T) {
	response, err := parseAntigravityCompletion("canvas ok\n")
	if err != nil || response != "canvas ok" {
		t.Fatalf("response=%q error=%v", response, err)
	}
}

func TestExecuteGeminiOfficialCompletionUsesFixedHeadlessArgumentsAndStdin(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("Mac CLI helper only runs on macOS")
	}
	directory := t.TempDir()
	resolvedDirectory, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	previousRoots := cliAllowedRoots
	cliAllowedRoots = func() []string { return []string{directory, resolvedDirectory} }
	t.Cleanup(func() { cliAllowedRoots = previousRoots })
	executable := filepath.Join(directory, "gemini")
	script := `#!/bin/sh
printf '%s\n' "$@" > "$HOME/gemini-official-args"
IFS= read -r prompt
printf '%s' "$prompt" > "$HOME/gemini-official-stdin"
printf '{"response":"Gemini OK","stats":{}}\n'
`
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	t.Setenv("HOME", directory)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(directory, "manifest.json")
	if err := os.WriteFile(manifestPath, cliTestManifest(t, privateKey, time.Now().Add(time.Hour), "gemini-official-cli", "gemini", cliTestFileHash(t, executable)), 0o600); err != nil {
		t.Fatal(err)
	}
	previousManifest, previousPublicKey := config.Cfg.CLIHelperManifest, config.Cfg.CLIHelperPublicKey
	config.Cfg.CLIHelperManifest = manifestPath
	config.Cfg.CLIHelperPublicKey = base64.StdEncoding.EncodeToString(publicKey)
	cliModelProbeState.Lock()
	previousTasks, previousActiveID := cliModelProbeState.Tasks, cliModelProbeState.ActiveID
	cliModelProbeState.Tasks, cliModelProbeState.ActiveID = map[string]*cliModelProbeTask{}, ""
	cliModelProbeState.Unlock()
	t.Cleanup(func() {
		config.Cfg.CLIHelperManifest, config.Cfg.CLIHelperPublicKey = previousManifest, previousPublicKey
		cliModelProbeState.Lock()
		cliModelProbeState.Tasks, cliModelProbeState.ActiveID = previousTasks, previousActiveID
		cliModelProbeState.Unlock()
	})
	input := cliCompanionActionRequest{Action: cliCompanionActionCompletionStart, UserID: "user-1", ProviderID: "provider-1", Protocol: "gemini-official-cli", Model: "flash-lite", Prompt: "只回复 Gemini OK"}
	started, _ := executeGeminiOfficialCompletionStart(context.Background(), input)
	input.Action, input.TaskID, input.Model, input.Prompt = cliCompanionActionProbeStatus, started.TaskID, "", ""
	deadline := time.Now().Add(5 * time.Second)
	var result CLIHelperResult
	for {
		result, _ = executeCLIModelProbeStatus(input)
		if result.TaskStatus != "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Gemini official completion did not finish")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if result.TaskStatus != "succeeded" || result.Output != "Gemini OK" {
		t.Fatalf("result=%#v", result)
	}
	args, err := os.ReadFile(filepath.Join(directory, "gemini-official-args"))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--prompt", "", "--output-format", "json", "--model", "flash-lite", "--approval-mode", "plan", "--sandbox", "--skip-trust"}
	if string(args) != strings.Join(want, "\n")+"\n" {
		t.Fatalf("args=%q", args)
	}
	stdin, err := os.ReadFile(filepath.Join(directory, "gemini-official-stdin"))
	if err != nil || string(stdin) != "只回复 Gemini OK" {
		t.Fatalf("stdin=%q error=%v", stdin, err)
	}
}

func TestParseGeminiOfficialCompletionReadsOnlyResponse(t *testing.T) {
	response, err := parseGeminiOfficialCompletion(`{"response":"Gemini CLI 文本","stats":{"models":{"flash-lite":{}}}}`)
	if err != nil || response != "Gemini CLI 文本" {
		t.Fatalf("response=%q error=%v", response, err)
	}
	if _, err := parseGeminiOfficialCompletion(`{"stats":{}}`); err == nil {
		t.Fatal("missing response must be rejected")
	}
}

func TestGeminiOfficialCompletionFailureMessageHidesUpstreamDiagnostic(t *testing.T) {
	diagnostic := `Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. Please migrate to the Antigravity suite at file:///Users/private/gemini.js:1`
	message := geminiOfficialCompletionFailureMessage(diagnostic)
	if message != "Gemini 官方 CLI 当前个人账户已不受此客户端支持，请改用 Antigravity" {
		t.Fatalf("message=%q", message)
	}
	if strings.Contains(message, "file://") || strings.Contains(message, "/Users/") || strings.Contains(message, "IneligibleTierError") {
		t.Fatalf("message exposes upstream diagnostic: %q", message)
	}

	message = geminiOfficialCompletionFailureMessage("unexpected upstream failure at file:///Users/private/stack.js:1")
	if message != "Gemini 官方 CLI 调用失败（上游错误详情已隐藏）" {
		t.Fatalf("message=%q", message)
	}
}

func TestAntigravityCompletionFailureDiagnosticIsRedacted(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(os.TempDir(), "antigravity-sensitive-workdir")
	diagnostic := safeAntigravityCompletionDiagnostic(`{"status":"failed","error":"upstream failed token=secret-value at `+home+` and `+directory+`"}`, "", directory, "private prompt", errors.New("exit status 1"))
	message := antigravityCompletionFailureMessage(diagnostic)
	if strings.Contains(message, "secret-value") || strings.Contains(message, home) || strings.Contains(message, directory) || !strings.Contains(message, "[redacted]") {
		t.Fatalf("message=%q", message)
	}
}

func TestAntigravityCompletionFailureMapsUnsupportedLocation(t *testing.T) {
	message := antigravityCompletionFailureMessage("calling model: FAILED_PRECONDITION (code 400): User location is not supported for the API use")
	if message != "Antigravity 当前代理出口地区不受 Google 支持，请切换代理节点后重试" {
		t.Fatalf("message=%q", message)
	}
}

func TestExecuteCodexCompletionUsesReadOnlyStdinPrompt(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("Mac CLI helper only runs on macOS")
	}
	directory := t.TempDir()
	resolvedDirectory, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	previousRoots := cliAllowedRoots
	cliAllowedRoots = func() []string { return []string{directory, resolvedDirectory} }
	t.Cleanup(func() { cliAllowedRoots = previousRoots })
	executable := filepath.Join(directory, "codex")
	script := `#!/bin/sh
printf '%s\n' "$@" > "$HOME/codex-completion-args"
IFS= read -r prompt
printf '%s' "$prompt" > "$HOME/codex-completion-stdin"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    output="$1"
  fi
  shift
done
printf 'canvas codex ok\n' > "$output"
`
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	t.Setenv("HOME", directory)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(directory, "manifest.json")
	if err := os.WriteFile(manifestPath, cliTestManifest(t, privateKey, time.Now().Add(time.Hour), "codex", "codex", cliTestFileHash(t, executable)), 0o600); err != nil {
		t.Fatal(err)
	}
	previousManifest, previousPublicKey := config.Cfg.CLIHelperManifest, config.Cfg.CLIHelperPublicKey
	config.Cfg.CLIHelperManifest = manifestPath
	config.Cfg.CLIHelperPublicKey = base64.StdEncoding.EncodeToString(publicKey)
	cliModelProbeState.Lock()
	previousTasks, previousActiveID := cliModelProbeState.Tasks, cliModelProbeState.ActiveID
	cliModelProbeState.Tasks, cliModelProbeState.ActiveID = map[string]*cliModelProbeTask{}, ""
	cliModelProbeState.Unlock()
	t.Cleanup(func() {
		config.Cfg.CLIHelperManifest, config.Cfg.CLIHelperPublicKey = previousManifest, previousPublicKey
		cliModelProbeState.Lock()
		cliModelProbeState.Tasks, cliModelProbeState.ActiveID = previousTasks, previousActiveID
		cliModelProbeState.Unlock()
	})
	input := cliCompanionActionRequest{Action: cliCompanionActionCompletionStart, UserID: "user-1", ProviderID: "provider-1", Protocol: "codex", Model: cliCodexDefaultModel, Prompt: "只回复 Codex OK"}
	started, _ := executeCodexCompletionStart(context.Background(), input)
	input.Action, input.TaskID, input.Model, input.Prompt = cliCompanionActionProbeStatus, started.TaskID, "", ""
	deadline := time.Now().Add(5 * time.Second)
	var result CLIHelperResult
	for {
		result, _ = executeCLIModelProbeStatus(input)
		if result.TaskStatus != "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Codex completion did not finish")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if result.TaskStatus != "succeeded" || result.Output != "canvas codex ok" {
		t.Fatalf("result=%#v", result)
	}
	args, err := os.ReadFile(filepath.Join(directory, "codex-completion-args"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(args)), "\n")
	if len(lines) != 10 || lines[0] != "exec" || lines[1] != "--sandbox" || lines[2] != "read-only" || lines[3] != "--skip-git-repo-check" || lines[4] != "--ephemeral" || lines[5] != "--model" || lines[6] != "gpt-5.5" || lines[7] != "--output-last-message" || filepath.Base(lines[8]) != "last-message.txt" || lines[9] != "-" {
		t.Fatalf("args=%q", lines)
	}
	stdin, err := os.ReadFile(filepath.Join(directory, "codex-completion-stdin"))
	if err != nil || string(stdin) != "只回复 Codex OK" {
		t.Fatalf("stdin=%q err=%v", stdin, err)
	}
}
