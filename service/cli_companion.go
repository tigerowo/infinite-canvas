package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

const (
	cliCompanionActionPath    = "/v1/actions"
	cliCompanionBodyLimit     = int64(32 * 1024)
	cliCompanionResponseLimit = int64(32 * 1024)
	cliCompanionAuthWindow    = 30 * time.Second
	cliCompanionNonceTTL      = 2 * time.Minute
	cliCompanionNonceLimit    = 4096
)

const (
	cliCompanionActionVersion    = "version"
	cliCompanionActionAuthStatus = "auth-status"
)

const (
	cliCompanionTimestampHeader = "X-CLI-Helper-Timestamp"
	cliCompanionNonceHeader     = "X-CLI-Helper-Nonce"
	cliCompanionSignatureHeader = "X-CLI-Helper-Signature"
	cliCompanionResponseHeader  = "X-CLI-Helper-Response-Signature"
)

var cliCompanionNoncePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32,64}$`)

type cliCompanionActionRequest struct {
	Action     string `json:"action"`
	UserID     string `json:"userId"`
	ProviderID string `json:"providerId"`
	Protocol   string `json:"protocol"`
}

type cliCompanionActionResponse struct {
	Result CLIHelperResult     `json:"result,omitempty"`
	Status model.ProviderStatus `json:"status,omitempty"`
	Error  string              `json:"error,omitempty"`
}

type cliCompanionHandler struct {
	secret  []byte
	now     func() time.Time
	execute func(context.Context, string, string) (CLIHelperResult, model.ProviderStatus)
	mu      sync.Mutex
	seen    map[string]time.Time
}

func NewCLICompanionHandler() (http.Handler, error) {
	secret, err := cliCompanionSharedSecret()
	if err != nil {
		return nil, err
	}
	handler := &cliCompanionHandler{secret: secret, now: time.Now, execute: executeCLICompanionAction, seen: map[string]time.Time{}}
	mux := http.NewServeMux()
	mux.Handle(cliCompanionActionPath, handler)
	return mux, nil
}

func (handler *cliCompanionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != cliCompanionActionPath {
		handler.writeResponse(w, http.StatusNotFound, r.Header.Get(cliCompanionNonceHeader), cliCompanionActionResponse{Error: "请求不存在"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, cliCompanionBodyLimit+1))
	if err != nil || len(body) == 0 || int64(len(body)) > cliCompanionBodyLimit {
		handler.writeResponse(w, http.StatusBadRequest, r.Header.Get(cliCompanionNonceHeader), cliCompanionActionResponse{Error: "请求格式错误或内容过大"})
		return
	}
	if err := handler.authorize(r.Header, body); err != nil {
		handler.writeResponse(w, http.StatusUnauthorized, r.Header.Get(cliCompanionNonceHeader), cliCompanionActionResponse{Error: "逐次授权无效或已使用"})
		return
	}
	var input cliCompanionActionRequest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	decodeErr := decoder.Decode(&input)
	trailingErr := decoder.Decode(&struct{}{})
	if decodeErr != nil || trailingErr != io.EOF || !validCLICompanionAction(input.Action) || !validCLICompanionID(input.UserID) || !validCLICompanionID(input.ProviderID) || cliSpecs[input.Protocol].Candidates == nil {
		handler.writeResponse(w, http.StatusBadRequest, r.Header.Get(cliCompanionNonceHeader), cliCompanionActionResponse{Error: "CLI 动作不受支持"})
		return
	}
	result, status := handler.execute(r.Context(), input.Action, input.Protocol)
	handler.writeResponse(w, http.StatusOK, r.Header.Get(cliCompanionNonceHeader), cliCompanionActionResponse{Result: result, Status: status})
}

func (handler *cliCompanionHandler) authorize(header http.Header, body []byte) error {
	timestampText := strings.TrimSpace(header.Get(cliCompanionTimestampHeader))
	nonce := strings.TrimSpace(header.Get(cliCompanionNonceHeader))
	signatureText := strings.TrimSpace(header.Get(cliCompanionSignatureHeader))
	timestamp, err := strconv.ParseInt(timestampText, 10, 64)
	if err != nil || !cliCompanionNoncePattern.MatchString(nonce) {
		return errors.New("invalid CLI companion authorization metadata")
	}
	current := handler.now()
	issuedAt := time.Unix(timestamp, 0)
	if issuedAt.Before(current.Add(-cliCompanionAuthWindow)) || issuedAt.After(current.Add(cliCompanionAuthWindow)) {
		return errors.New("expired CLI companion authorization")
	}
	signature, err := base64.RawURLEncoding.DecodeString(signatureText)
	if err != nil || !hmac.Equal(signature, cliCompanionRequestSignature(handler.secret, timestampText, nonce, body)) {
		return errors.New("invalid CLI companion authorization signature")
	}
	handler.mu.Lock()
	defer handler.mu.Unlock()
	for value, seenAt := range handler.seen {
		if current.Sub(seenAt) > cliCompanionNonceTTL {
			delete(handler.seen, value)
		}
	}
	if _, exists := handler.seen[nonce]; exists || len(handler.seen) >= cliCompanionNonceLimit {
		return errors.New("replayed CLI companion authorization")
	}
	handler.seen[nonce] = current
	return nil
}

func (handler *cliCompanionHandler) writeResponse(w http.ResponseWriter, status int, nonce string, value cliCompanionActionResponse) {
	body, _ := json.Marshal(value)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set(cliCompanionResponseHeader, base64.RawURLEncoding.EncodeToString(cliCompanionResponseSignature(handler.secret, nonce, body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func requestCLICompanion(parent context.Context, userID string, providerID string, protocol string) (CLIHelperResult, model.ProviderStatus, error) {
	return requestCLICompanionAction(parent, userID, providerID, protocol, cliCompanionActionVersion)
}

func requestCLICompanionAction(parent context.Context, userID string, providerID string, protocol string, action string) (CLIHelperResult, model.ProviderStatus, error) {
	if !validCLICompanionAction(action) {
		return CLIHelperResult{}, model.ProviderStatusUnavailable, errors.New("CLI companion action is invalid")
	}
	secret, err := cliCompanionSharedSecret()
	if err != nil {
		return CLIHelperResult{}, model.ProviderStatusUnavailable, err
	}
	socketPath, err := cliCompanionSocketPath()
	if err != nil {
		return CLIHelperResult{}, model.ProviderStatusUnavailable, err
	}
	body, _ := json.Marshal(cliCompanionActionRequest{Action: action, UserID: userID, ProviderID: providerID, Protocol: protocol})
	nonceBytes := make([]byte, 24)
	if _, err := rand.Read(nonceBytes); err != nil {
		return CLIHelperResult{}, model.ProviderStatusUnavailable, err
	}
	nonce := base64.RawURLEncoding.EncodeToString(nonceBytes)
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	request, err := http.NewRequestWithContext(parent, http.MethodPost, "http://unix"+cliCompanionActionPath, bytes.NewReader(body))
	if err != nil {
		return CLIHelperResult{}, model.ProviderStatusUnavailable, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(cliCompanionTimestampHeader, timestamp)
	request.Header.Set(cliCompanionNonceHeader, nonce)
	request.Header.Set(cliCompanionSignatureHeader, base64.RawURLEncoding.EncodeToString(cliCompanionRequestSignature(secret, timestamp, nonce, body)))
	dialer := &net.Dialer{Timeout: 2 * time.Second}
	transport := &http.Transport{
		Proxy:             nil,
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", socketPath)
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		Timeout:   7 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return CLIHelperResult{}, model.ProviderStatusUnavailable, err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, cliCompanionResponseLimit+1))
	if err != nil || len(responseBody) == 0 || int64(len(responseBody)) > cliCompanionResponseLimit {
		return CLIHelperResult{}, model.ProviderStatusUnavailable, errors.New("CLI companion response is invalid")
	}
	responseSignature, err := base64.RawURLEncoding.DecodeString(response.Header.Get(cliCompanionResponseHeader))
	if err != nil || !hmac.Equal(responseSignature, cliCompanionResponseSignature(secret, nonce, responseBody)) {
		return CLIHelperResult{}, model.ProviderStatusUnavailable, errors.New("CLI companion response signature is invalid")
	}
	var output cliCompanionActionResponse
	if json.Unmarshal(responseBody, &output) != nil || response.StatusCode != http.StatusOK || output.Error != "" || output.Result.Protocol != protocol || !validCLICompanionStatus(output.Status) || !validCLICompanionResult(action, output.Result) {
		return CLIHelperResult{}, model.ProviderStatusUnavailable, errors.New("CLI companion rejected the action")
	}
	return output.Result, output.Status, nil
}

func validCLICompanionResult(action string, result CLIHelperResult) bool {
	switch action {
	case cliCompanionActionVersion:
		return result.AuthStatus == ""
	case cliCompanionActionAuthStatus:
		if result.Version != "" {
			return false
		}
		switch result.AuthStatus {
		case "", "authenticated", "unauthenticated", "unsupported":
			return true
		default:
			return false
		}
	default:
		return false
	}
}

func validCLICompanionAction(action string) bool {
	switch action {
	case cliCompanionActionVersion, cliCompanionActionAuthStatus:
		return true
	default:
		return false
	}
}

func validCLICompanionID(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && len(value) <= 100 && !strings.ContainsAny(value, "\r\n\x00")
}

func validCLICompanionStatus(status model.ProviderStatus) bool {
	switch status {
	case model.ProviderStatusConnected, model.ProviderStatusFailed, model.ProviderStatusTimeout, model.ProviderStatusUnavailable:
		return true
	default:
		return false
	}
}

func cliCompanionSocketPath() (string, error) {
	path := strings.TrimSpace(config.Cfg.CLIHelperSocket)
	if path == "" || !filepath.IsAbs(path) {
		return "", errors.New("CLI companion socket is not configured")
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm()&0o077 != 0 {
		return "", errors.New("CLI companion socket is unavailable or unsafe")
	}
	return path, nil
}

func cliCompanionSharedSecret() ([]byte, error) {
	value := strings.TrimSpace(config.Cfg.CLIHelperSecret)
	for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.RawURLEncoding} {
		secret, err := encoding.DecodeString(value)
		if err == nil && len(secret) >= 32 && len(secret) <= 64 {
			return secret, nil
		}
	}
	return nil, errors.New("CLI companion shared secret is invalid")
}

func cliCompanionRequestSignature(secret []byte, timestamp string, nonce string, body []byte) []byte {
	digest := sha256.Sum256(body)
	mac := hmac.New(sha256.New, secret)
	_, _ = io.WriteString(mac, timestamp+"\n"+nonce+"\n"+hex.EncodeToString(digest[:]))
	return mac.Sum(nil)
}

func cliCompanionResponseSignature(secret []byte, nonce string, body []byte) []byte {
	digest := sha256.Sum256(body)
	mac := hmac.New(sha256.New, secret)
	_, _ = io.WriteString(mac, nonce+"\n"+hex.EncodeToString(digest[:]))
	return mac.Sum(nil)
}
