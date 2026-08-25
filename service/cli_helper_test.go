package service

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

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
	resolvedPath := filepath.Join(resolvedDirectory, "test-controlled-cli")
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho test\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	hash := cliTestFileHash(t, path)
	resolved, err := findControlledCLIExecutable([]string{"test-controlled-cli"}, map[string]string{"test-controlled-cli": hash})
	if err != nil || resolved != resolvedPath {
		t.Fatalf("resolved=%q error=%v", resolved, err)
	}
	if _, err := findControlledCLIExecutable([]string{"test-controlled-cli"}, map[string]string{"test-controlled-cli": strings.Repeat("0", 64)}); err == nil {
		t.Fatal("hash mismatch must be rejected")
	}
	if err := os.Chmod(path, 0o722); err != nil {
		t.Fatal(err)
	}
	if _, err := findControlledCLIExecutable([]string{"test-controlled-cli"}, map[string]string{"test-controlled-cli": hash}); err == nil {
		t.Fatal("group/world writable executable must be rejected")
	}
}

func TestCLIHelperManifestRequiresValidSignatureAndExpiry(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	current := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	data := cliTestManifest(t, privateKey, current.Add(time.Hour), "codex", "codex", strings.Repeat("a", 64))
	hashes, err := verifyCLIHelperManifest(data, publicKey, "codex", current)
	if err != nil || hashes["codex"] != strings.Repeat("a", 64) {
		t.Fatalf("hashes=%v error=%v", hashes, err)
	}
	data[len(data)-2] ^= 1
	if _, err := verifyCLIHelperManifest(data, publicKey, "codex", current); err == nil {
		t.Fatal("tampered manifest must be rejected")
	}
	expired := cliTestManifest(t, privateKey, current.Add(-time.Second), "codex", "codex", strings.Repeat("a", 64))
	if _, err := verifyCLIHelperManifest(expired, publicKey, "codex", current); err == nil {
		t.Fatal("expired manifest must be rejected")
	}
}

func TestExecuteCLICompanionVersionRunsOnlyVersionProbe(t *testing.T) {
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
	resolvedPath := filepath.Join(resolvedDirectory, "codex")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf 'codex-cli 1.2.3\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(directory, "manifest.json")
	if err := os.WriteFile(manifestPath, cliTestManifest(t, privateKey, time.Now().Add(time.Hour), "codex", "codex", cliTestFileHash(t, path)), 0o600); err != nil {
		t.Fatal(err)
	}
	previousManifest := config.Cfg.CLIHelperManifest
	previousPublicKey := config.Cfg.CLIHelperPublicKey
	config.Cfg.CLIHelperManifest = manifestPath
	config.Cfg.CLIHelperPublicKey = base64.StdEncoding.EncodeToString(publicKey)
	t.Cleanup(func() {
		config.Cfg.CLIHelperManifest = previousManifest
		config.Cfg.CLIHelperPublicKey = previousPublicKey
	})
	result, status := executeCLICompanionVersion(context.Background(), "codex")
	if status != model.ProviderStatusConnected || !result.Available || result.Executable != resolvedPath || result.Version != "codex-cli 1.2.3" {
		t.Fatalf("result=%#v status=%s", result, status)
	}
}

func cliTestFileHash(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func cliTestManifest(t *testing.T, privateKey ed25519.PrivateKey, expiresAt time.Time, protocol string, candidate string, hash string) []byte {
	t.Helper()
	payload, err := json.Marshal(cliHelperManifest{
		Version:   1,
		ExpiresAt: expiresAt.UTC().Format(time.RFC3339),
		Executables: []cliHelperManifestEntry{{
			Protocol: protocol,
			Candidate: candidate,
			SHA256: hash,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(cliHelperManifestEnvelope{
		Payload:   base64.StdEncoding.EncodeToString(payload),
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
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
