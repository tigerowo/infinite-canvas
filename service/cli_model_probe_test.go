package service

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
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
	if len(lines) != 8 || lines[0] != "exec" || lines[1] != "--sandbox" || lines[2] != "read-only" || lines[3] != "--skip-git-repo-check" || lines[4] != "--ephemeral" || lines[5] != "--output-last-message" || filepath.Base(lines[6]) != "last-message.txt" || lines[7] != cliModelProbePrompt {
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
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HOME/agy-args\"\nprintf '{\"status\":\"SUCCESS\",\"response\":\"canvas ok\"}'\n"
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
	want := []string{"--print", "只回复 OK", "--output-format", "json", "--model", "gemini-3.5-flash-low", "--effort", "low", "--print-timeout", "90s", "--disable-slash-commands", "--mode", "plan", "--sandbox"}
	if string(args) != strings.Join(want, "\n")+"\n" {
		t.Fatalf("args=%q", args)
	}
}
