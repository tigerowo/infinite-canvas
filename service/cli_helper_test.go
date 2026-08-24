package service

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestFindControlledCLIExecutableUsesFixedNameAndRejectsWritableBinary(t *testing.T) {
	directory := t.TempDir()
	resolvedDirectory, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	previousRoots := cliAllowedRoots
	cliAllowedRoots = func() []string { return []string{directory, resolvedDirectory} }
	t.Cleanup(func() { cliAllowedRoots = previousRoots })
	path := filepath.Join(directory, "test-controlled-cli")
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho test\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	resolved, err := findControlledCLIExecutable([]string{"test-controlled-cli"})
	if err != nil || resolved != path {
		t.Fatalf("resolved=%q error=%v", resolved, err)
	}
	if err := os.Chmod(path, 0o722); err != nil {
		t.Fatal(err)
	}
	if _, err := findControlledCLIExecutable([]string{"test-controlled-cli"}); err == nil {
		t.Fatal("group/world writable executable must be rejected")
	}
}

func TestDetectCLIProviderRunsOnlyVersionProbe(t *testing.T) {
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
	path := filepath.Join(directory, "codex")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf 'codex-cli 1.2.3\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	previous := config.Cfg.CLIHelperEnabled
	config.Cfg.CLIHelperEnabled = true
	t.Cleanup(func() { config.Cfg.CLIHelperEnabled = previous })
	result, status := detectCLIProvider(context.Background(), model.Provider{Protocol: "codex"})
	if status != model.ProviderStatusConnected || !result.Available || result.Executable != path || result.Version != "codex-cli 1.2.3" {
		t.Fatalf("result=%#v status=%s", result, status)
	}
}

func TestCLIOutputIsCappedAndRedacted(t *testing.T) {
	var output cappedCLIOutput
	_, _ = output.Write([]byte("token=secret-value\n" + strings.Repeat("x", cliHelperOutputLimit*2)))
	if len(output.String()) != cliHelperOutputLimit {
		t.Fatalf("output length=%d", len(output.String()))
	}
	cleaned := sanitizeCLIOutput(output.String())
	if strings.Contains(cleaned, "secret-value") || !strings.Contains(cleaned, "[redacted]") {
		t.Fatalf("cleaned output was not redacted: %.80q", cleaned)
	}
}
