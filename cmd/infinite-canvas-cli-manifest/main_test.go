package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestGenerateKeyAndSignManifest(t *testing.T) {
	directory := t.TempDir()
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	resolvedDirectory, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	previousRoots := manifestAllowedRoots
	manifestAllowedRoots = func() []string { return []string{directory, resolvedDirectory} }
	t.Cleanup(func() { manifestAllowedRoots = previousRoots })
	privateKeyPath := filepath.Join(directory, "signing-key.pem")
	publicKeyPath := filepath.Join(directory, "public-key.txt")
	manifestPath := filepath.Join(directory, "manifest.json")
	executablePath := filepath.Join(directory, "codex")
	if err := os.WriteFile(executablePath, []byte("test executable"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := generateSigningKey(privateKeyPath, publicKeyPath); err != nil {
		t.Fatal(err)
	}
	entries := []string{
		"codex=codex=" + executablePath,
		"codex-image-emergency=codex=" + executablePath,
		"gpt-image-2=gpt-image-2-skill=" + executablePath,
		"gemini-official-cli=gemini=" + executablePath,
	}
	if err := signManifest(privateKeyPath, manifestPath, time.Now().Add(time.Hour).UTC().Format(time.RFC3339), entries); err != nil {
		t.Fatal(err)
	}
	publicKeyText, err := os.ReadFile(publicKeyPath)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, err := base64.StdEncoding.DecodeString(string(publicKeyText[:len(publicKeyText)-1]))
	if err != nil {
		t.Fatal(err)
	}
	manifestData, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var envelope manifestEnvelope
	if json.Unmarshal(manifestData, &envelope) != nil {
		t.Fatal("manifest envelope is invalid")
	}
	payload, err := base64.StdEncoding.DecodeString(envelope.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var manifest manifestPayload
	if json.Unmarshal(payload, &manifest) != nil || len(manifest.Executables) != len(entries) {
		t.Fatal("manifest does not preserve controlled subscription image entries")
	}
	signature, err := base64.StdEncoding.DecodeString(envelope.Signature)
	if err != nil || !ed25519.Verify(ed25519.PublicKey(publicKey), payload, signature) {
		t.Fatal("manifest signature is invalid")
	}
	privateData, err := os.ReadFile(privateKeyPath)
	if err != nil {
		t.Fatal(err)
	}
	if block, _ := pem.Decode(privateData); block == nil || block.Type != "PRIVATE KEY" {
		t.Fatal("private key is not PKCS#8 PEM")
	}
}
