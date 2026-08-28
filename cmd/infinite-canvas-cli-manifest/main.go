package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const executableLimit = int64(256 * 1024 * 1024)

var allowedCandidates = map[string]map[string]bool{
	"codex":      {"codex": true},
	"gemini-cli": {"agy": true},
	"jimeng":     {"dreamina": true},
}

var manifestAllowedRoots = defaultManifestAllowedRoots

type stringList []string

func (values *stringList) String() string { return strings.Join(*values, ",") }
func (values *stringList) Set(value string) error {
	*values = append(*values, value)
	return nil
}

type manifestEnvelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

type manifestPayload struct {
	Version     int             `json:"version"`
	ExpiresAt   string          `json:"expiresAt"`
	Executables []manifestEntry `json:"executables"`
}

type manifestEntry struct {
	Protocol  string `json:"protocol"`
	Candidate string `json:"candidate"`
	SHA256    string `json:"sha256"`
}

func main() {
	var entries stringList
	generateKey := flag.Bool("generate-key", false, "生成新的离线 Ed25519 签名密钥")
	privateKeyPath := flag.String("private-key", "", "PKCS#8 PEM 私钥绝对路径")
	publicKeyPath := flag.String("public-key", "", "Base64 公钥输出绝对路径")
	outputPath := flag.String("output", "", "签名清单输出绝对路径")
	expiresAtText := flag.String("expires-at", "", "清单到期时间（RFC3339，最长 90 天）")
	flag.Var(&entries, "entry", "允许项，格式 protocol=candidate=/absolute/executable/path；可重复")
	flag.Parse()
	if flag.NArg() != 0 {
		fatal("不接受位置参数")
	}
	var err error
	if *generateKey {
		err = generateSigningKey(*privateKeyPath, *publicKeyPath)
	} else {
		err = signManifest(*privateKeyPath, *outputPath, *expiresAtText, entries)
	}
	if err != nil {
		fatal(err.Error())
	}
}

func generateSigningKey(privateKeyPath string, publicKeyPath string) error {
	if err := validateAbsoluteOutput(privateKeyPath); err != nil {
		return fmt.Errorf("私钥路径无效: %w", err)
	}
	if err := validateAbsoluteOutput(publicKeyPath); err != nil {
		return fmt.Errorf("公钥路径无效: %w", err)
	}
	if err := requirePrivateDirectory(filepath.Dir(privateKeyPath)); err != nil {
		return err
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return errors.New("无法生成签名密钥")
	}
	encodedPrivateKey, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return errors.New("无法编码签名私钥")
	}
	privatePEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encodedPrivateKey})
	if err := writeExclusive(privateKeyPath, privatePEM, 0o600); err != nil {
		return fmt.Errorf("无法写入私钥: %w", err)
	}
	if err := writeExclusive(publicKeyPath, []byte(base64.StdEncoding.EncodeToString(publicKey)+"\n"), 0o600); err != nil {
		_ = os.Remove(privateKeyPath)
		return fmt.Errorf("无法写入公钥: %w", err)
	}
	fmt.Printf("签名密钥已生成：私钥保存在离线位置，公钥写入 %s\n", publicKeyPath)
	return nil
}

func signManifest(privateKeyPath string, outputPath string, expiresAtText string, rawEntries []string) error {
	if !filepath.IsAbs(privateKeyPath) || !filepath.IsAbs(outputPath) || len(rawEntries) == 0 {
		return errors.New("签名时必须提供绝对私钥路径、绝对输出路径和至少一个 entry")
	}
	expiresAt, err := time.Parse(time.RFC3339, strings.TrimSpace(expiresAtText))
	if err != nil || !expiresAt.After(time.Now()) || expiresAt.After(time.Now().Add(90*24*time.Hour)) {
		return errors.New("expires-at 必须是未来 90 天内的 RFC3339 时间")
	}
	privateKey, err := loadPrivateKey(privateKeyPath)
	if err != nil {
		return err
	}
	entries := make([]manifestEntry, 0, len(rawEntries))
	seen := map[string]bool{}
	for _, raw := range rawEntries {
		entry, err := buildEntry(raw)
		if err != nil {
			return err
		}
		key := entry.Protocol + "\x00" + entry.Candidate
		if seen[key] {
			return errors.New("清单包含重复的 protocol/candidate")
		}
		seen[key] = true
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i int, j int) bool {
		if entries[i].Protocol == entries[j].Protocol {
			return entries[i].Candidate < entries[j].Candidate
		}
		return entries[i].Protocol < entries[j].Protocol
	})
	payload, err := json.Marshal(manifestPayload{Version: 1, ExpiresAt: expiresAt.UTC().Format(time.RFC3339), Executables: entries})
	if err != nil {
		return errors.New("无法编码清单")
	}
	envelope, err := json.Marshal(manifestEnvelope{
		Payload:   base64.StdEncoding.EncodeToString(payload),
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload)),
	})
	if err != nil {
		return errors.New("无法编码签名清单")
	}
	envelope = append(envelope, '\n')
	if err := validateAbsoluteOutput(outputPath); err != nil {
		return err
	}
	if err := writeExclusive(outputPath, envelope, 0o644); err != nil {
		return fmt.Errorf("无法写入清单: %w", err)
	}
	fmt.Printf("签名清单已写入 %s，包含 %d 个允许项\n", outputPath, len(entries))
	return nil
}

func loadPrivateKey(path string) (ed25519.PrivateKey, error) {
	data, err := readProtectedFile(path, 8*1024)
	if err != nil {
		return nil, errors.New("无法读取受保护的签名私钥")
	}
	block, rest := pem.Decode(data)
	if block == nil || len(strings.TrimSpace(string(rest))) != 0 || block.Type != "PRIVATE KEY" {
		return nil, errors.New("签名私钥必须是单个 PKCS#8 PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	privateKey, ok := parsed.(ed25519.PrivateKey)
	if err != nil || !ok || len(privateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("签名私钥不是有效的 Ed25519 PKCS#8 密钥")
	}
	return privateKey, nil
}

func buildEntry(raw string) (manifestEntry, error) {
	parts := strings.SplitN(raw, "=", 3)
	if len(parts) != 3 {
		return manifestEntry{}, errors.New("entry 格式必须是 protocol=candidate=/absolute/path")
	}
	protocol := strings.TrimSpace(parts[0])
	candidate := strings.TrimSpace(parts[1])
	path := strings.TrimSpace(parts[2])
	if !allowedCandidates[protocol][candidate] || filepath.Base(candidate) != candidate || !filepath.IsAbs(path) {
		return manifestEntry{}, errors.New("entry 的协议、候选名或路径不受支持")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || !pathWithinAllowedRoots(resolved) {
		return manifestEntry{}, errors.New("entry 可执行文件不在受控目录")
	}
	hash, err := hashExecutable(resolved)
	if err != nil {
		return manifestEntry{}, err
	}
	return manifestEntry{Protocol: protocol, Candidate: candidate, SHA256: hash}, nil
}

func hashExecutable(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", errors.New("无法读取 entry 可执行文件")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 || info.Size() <= 0 || info.Size() > executableLimit {
		return "", errors.New("entry 可执行文件类型、权限或大小无效")
	}
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(file, executableLimit+1))
	if err != nil || written != info.Size() {
		return "", errors.New("无法完整读取 entry 可执行文件")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func pathWithinAllowedRoots(path string) bool {
	roots := manifestAllowedRoots()
	path = filepath.Clean(path)
	for _, root := range roots {
		root = filepath.Clean(root)
		if path == root || strings.HasPrefix(path, root+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}

func defaultManifestAllowedRoots() []string {
	roots := []string{"/usr/bin", "/usr/local", "/opt/homebrew", "/Applications"}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		for _, relative := range []string{".local", ".npm", ".bun", ".codex/bin"} {
			roots = append(roots, filepath.Join(home, relative))
		}
	}
	return roots
}

func readProtectedFile(path string, limit int64) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("路径必须是绝对路径")
	}
	pathInfo, err := os.Lstat(path)
	if err != nil || !pathInfo.Mode().IsRegular() || pathInfo.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("文件权限、类型或大小无效")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !os.SameFile(pathInfo, info) || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() <= 0 || info.Size() > limit {
		return nil, errors.New("文件权限、类型或大小无效")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("文件读取失败")
	}
	return data, nil
}

func validateAbsoluteOutput(path string) error {
	if !filepath.IsAbs(path) || filepath.Base(path) == "." || filepath.Base(path) == string(os.PathSeparator) {
		return errors.New("输出路径必须是绝对文件路径")
	}
	if _, err := os.Lstat(path); err == nil || !errors.Is(err, os.ErrNotExist) {
		return errors.New("输出文件已存在或不可检查")
	}
	return nil
}

func requirePrivateDirectory(path string) error {
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return errors.New("私钥目录必须已存在且权限不向组或其他用户开放")
	}
	return nil
}

func writeExclusive(path string, data []byte, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	return file.Close()
}

func fatal(message string) {
	fmt.Fprintln(os.Stderr, "错误："+message)
	os.Exit(1)
}
