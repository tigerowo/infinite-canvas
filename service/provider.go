package service

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"slices"
	"sort"
	"strings"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

var providerAPIProtocols = map[string]bool{
	"openai": true, "gemini": true, "http": true, "grok2api": true, "metaso": true,
	"apimart": true, "kie": true, "mimo": true, "runninghub": true, "volcengine": true,
}

var providerCLIProtocols = map[string]bool{"codex": true, "codex-image-emergency": true, "gpt-image-2": true, "gemini-cli": true, "gemini-official-cli": true, "jimeng": true, cliChatGPTProxyProtocol: true, cliAntigravityProxyProtocol: true}
var providerCapabilities = map[string]bool{"text": true, "image": true, "video": true, "audio": true}

type ProviderInput struct {
	ID               string             `json:"id"`
	Kind             model.ProviderKind `json:"kind"`
	Protocol         string             `json:"protocol"`
	Name             string             `json:"name"`
	BaseURL          string             `json:"baseUrl"`
	APIKey           string             `json:"apiKey"`
	ClearAPIKey      bool               `json:"clearApiKey"`
	Headers          *map[string]string `json:"headers"`
	ClearHeaders     bool               `json:"clearHeaders"`
	Capabilities     []string           `json:"capabilities"`
	Models           []string           `json:"models"`
	DefaultModel     string             `json:"defaultModel"`
	Timeout          int                `json:"timeout"`
	Enabled          *bool              `json:"enabled"`
	IsDefault        bool               `json:"isDefault"`
	Executable       string             `json:"executable"`
	WorkingDirectory string             `json:"workingDirectory"`
}

type ProviderView struct {
	ID               string               `json:"id"`
	Kind             model.ProviderKind   `json:"kind"`
	Protocol         string               `json:"protocol"`
	Name             string               `json:"name"`
	BaseURL          string               `json:"baseUrl"`
	HasAPIKey        bool                 `json:"hasApiKey"`
	APIKeyMasked     string               `json:"apiKeyMasked"`
	HasHeaders       bool                 `json:"hasHeaders"`
	HeaderNames      []string             `json:"headerNames"`
	Capabilities     []string             `json:"capabilities"`
	Models           []string             `json:"models"`
	VerifiedModels   []string             `json:"verifiedModels"`
	DefaultModel     string               `json:"defaultModel"`
	Timeout          int                  `json:"timeout"`
	Enabled          bool                 `json:"enabled"`
	IsDefault        bool                 `json:"isDefault"`
	SortOrder        int                  `json:"sortOrder"`
	ConnectionStatus model.ProviderStatus `json:"connectionStatus"`
	StatusMessage    string               `json:"statusMessage"`
	LastCheckedAt    string               `json:"lastCheckedAt"`
	Executable       string               `json:"executable"`
	WorkingDirectory string               `json:"workingDirectory"`
	Version          string               `json:"version"`
	CreatedAt        string               `json:"createdAt"`
	UpdatedAt        string               `json:"updatedAt"`
}

type ProviderTestResult struct {
	Status    model.ProviderStatus `json:"status"`
	Message   string               `json:"message"`
	Models    []string             `json:"models,omitempty"`
	CheckedAt string               `json:"checkedAt"`
}

type providerCredentials struct {
	APIKey  string            `json:"apiKey,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

func CurrentUserProviders(ctx context.Context, kind model.ProviderKind) ([]ProviderView, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, safeMessageError{message: "请先登录"}
	}
	if kind != "" && kind != model.ProviderKindAPI && kind != model.ProviderKindCLI {
		return nil, safeMessageError{message: "渠道类型无效"}
	}
	items, err := repository.ListProviders(user.ID, kind)
	if err != nil {
		return nil, err
	}
	result := make([]ProviderView, 0, len(items))
	for _, item := range items {
		view, err := providerView(item)
		if err != nil {
			return nil, err
		}
		result = append(result, view)
	}
	return result, nil
}

func SaveCurrentUserProvider(ctx context.Context, input ProviderInput) (ProviderView, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return ProviderView{}, safeMessageError{message: "请先登录"}
	}
	input = normalizeProviderInput(input)
	if err := validateProviderInput(input); err != nil {
		return ProviderView{}, err
	}

	item := model.Provider{}
	credentials := providerCredentials{}
	credentialsChanged := input.ID == ""
	var err error
	if input.ID != "" {
		saved, found, err := repository.GetProvider(user.ID, input.ID)
		if err != nil {
			return ProviderView{}, err
		}
		if !found {
			return ProviderView{}, safeMessageError{message: "渠道不存在"}
		}
		item = saved
		credentials, err = decryptProviderCredentials(saved.CredentialsCiphertext)
		if err != nil {
			return ProviderView{}, err
		}
	} else {
		item.ID = newID("provider")
		item.OwnerUserID = user.ID
		item.CreatedAt = now()
		item.ConnectionStatus = model.ProviderStatusUntested
		sortOrder, err := repository.NextProviderSortOrder(user.ID, input.Kind)
		if err != nil {
			return ProviderView{}, err
		}
		item.SortOrder = sortOrder
		if sortOrder == 0 {
			input.IsDefault = true
		}
	}
	if input.Kind == model.ProviderKindCLI {
		if err := applyTrustedCLIProviderModels(item, &input); err != nil {
			return ProviderView{}, err
		}
	}

	if input.ClearAPIKey {
		credentials.APIKey = ""
		credentialsChanged = true
	} else if input.APIKey != "" {
		credentials.APIKey = input.APIKey
		credentialsChanged = true
	}
	if input.ClearHeaders {
		credentials.Headers = nil
		credentialsChanged = true
	} else if input.Headers != nil {
		credentials.Headers = normalizeProviderHeaders(*input.Headers)
		credentialsChanged = true
	}
	ciphertext := item.CredentialsCiphertext
	if credentialsChanged {
		ciphertext, err = encryptProviderCredentials(credentials)
		if err != nil {
			return ProviderView{}, err
		}
	}

	changedConnection := item.Protocol != input.Protocol || item.BaseURL != input.BaseURL || credentialsChanged
	protocolChanged := item.Protocol != input.Protocol
	item.Kind = input.Kind
	item.Protocol = input.Protocol
	item.Name = input.Name
	item.BaseURL = input.BaseURL
	item.CredentialsCiphertext = ciphertext
	item.Capabilities = input.Capabilities
	item.Models = input.Models
	item.DefaultModel = input.DefaultModel
	item.Timeout = input.Timeout
	item.Enabled = input.Enabled == nil || *input.Enabled
	item.IsDefault = input.IsDefault && item.Enabled
	if item.Kind == model.ProviderKindCLI && protocolChanged {
		item.Executable = ""
		item.Version = ""
		item.VerifiedModels = nil
	}
	item.WorkingDirectory = input.WorkingDirectory
	item.UpdatedAt = now()
	updateSavedProviderConnectionStatus(&item, changedConnection)
	item, err = repository.SaveProvider(item)
	if err != nil {
		return ProviderView{}, err
	}
	if item.IsDefault {
		if err := repository.SetDefaultProvider(user.ID, item.ID, item.Kind); err != nil {
			return ProviderView{}, err
		}
		item.IsDefault = true
	}
	return providerView(item)
}

func updateSavedProviderConnectionStatus(item *model.Provider, changedConnection bool) {
	if !item.Enabled {
		item.ConnectionStatus = model.ProviderStatusDisabled
		item.StatusMessage = "渠道已禁用"
		return
	}
	if item.Kind == model.ProviderKindCLI {
		if changedConnection || item.ConnectionStatus == model.ProviderStatusDisabled {
			item.ConnectionStatus = model.ProviderStatusUnavailable
			item.StatusMessage = "本地 CLI helper 尚未连接"
			item.LastCheckedAt = ""
		}
		return
	}
	if changedConnection || item.ConnectionStatus == model.ProviderStatusDisabled {
		item.ConnectionStatus = model.ProviderStatusUntested
		item.StatusMessage = ""
		item.LastCheckedAt = ""
	}
}

func DeleteCurrentUserProvider(ctx context.Context, id string) error {
	user, item, err := currentUserProvider(ctx, id)
	if err != nil {
		return err
	}
	references, err := repository.ProviderReferenceCount(user.ID, item.ID)
	if err != nil {
		return err
	}
	if references > 0 {
		return safeMessageError{message: "渠道仍被历史任务或调用日志引用，暂不能删除；可先禁用渠道"}
	}
	return repository.DeleteProvider(user.ID, item.ID)
}

func SetCurrentUserDefaultProvider(ctx context.Context, id string) (ProviderView, error) {
	user, item, err := currentUserProvider(ctx, id)
	if err != nil {
		return ProviderView{}, err
	}
	if !item.Enabled {
		return ProviderView{}, safeMessageError{message: "禁用渠道不能设为默认"}
	}
	if err := repository.SetDefaultProvider(user.ID, item.ID, item.Kind); err != nil {
		return ProviderView{}, err
	}
	item.IsDefault = true
	return providerView(item)
}

func TestCurrentUserProvider(ctx context.Context, id string, refreshModels bool) (ProviderTestResult, error) {
	_, item, err := currentUserProvider(ctx, id)
	if err != nil {
		return ProviderTestResult{}, err
	}
	if item.Kind == model.ProviderKindCLI {
		return saveProviderTestResult(item, model.ProviderStatusUnavailable, "请使用受控 Mac CLI 检测", nil)
	}
	if !item.Enabled {
		return saveProviderTestResult(item, model.ProviderStatusDisabled, "渠道已禁用", nil)
	}
	channel, err := modelChannelFromProvider(item)
	if err != nil {
		return saveProviderTestResult(item, model.ProviderStatusFailed, "渠道密钥不可用", nil)
	}
	if strings.EqualFold(item.Protocol, "runninghub") {
		err = TestRunningHubChannel(ctx, channel)
		if err != nil {
			status := model.ProviderStatusFailed
			var networkError net.Error
			if errors.As(err, &networkError) && networkError.Timeout() {
				status = model.ProviderStatusTimeout
			}
			result, saveErr := saveProviderTestResult(item, status, safeProviderError(err), nil)
			if saveErr != nil {
				return ProviderTestResult{}, saveErr
			}
			return result, err
		}
		return saveProviderTestResult(item, model.ProviderStatusConnected, "RunningHub OpenAPI 连接成功", nil)
	}
	models, err := FetchModelChannelModels(channel)
	if err != nil {
		status := model.ProviderStatusFailed
		var networkError net.Error
		if errors.As(err, &networkError) && networkError.Timeout() {
			status = model.ProviderStatusTimeout
		}
		result, saveErr := saveProviderTestResult(item, status, safeProviderError(err), nil)
		if saveErr != nil {
			return ProviderTestResult{}, saveErr
		}
		return result, err
	}
	if refreshModels && len(models) > 0 {
		item.Models = models
		if item.DefaultModel == "" {
			item.DefaultModel = models[0]
		}
	}
	return saveProviderTestResult(item, model.ProviderStatusConnected, "连接成功", models)
}

func SelectUserProviderForModel(userID string, modelName string, providerID string) (model.ModelChannel, bool, error) {
	item, ok, err := repository.GetProvider(strings.TrimSpace(userID), strings.TrimSpace(providerID))
	if err != nil || !ok {
		return model.ModelChannel{}, ok, err
	}
	if item.Kind != model.ProviderKindAPI || !item.Enabled {
		return model.ModelChannel{}, true, safeMessageError{message: "指定渠道不可用"}
	}
	if len(item.Models) > 0 && !userLocalChannelHasModel(item.Models, modelName) {
		return model.ModelChannel{}, true, safeMessageError{message: "本地渠道不支持该模型"}
	}
	channel, err := modelChannelFromProvider(item)
	return channel, true, err
}

func currentUserProvider(ctx context.Context, id string) (model.AuthUser, model.Provider, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return model.AuthUser{}, model.Provider{}, safeMessageError{message: "请先登录"}
	}
	item, found, err := repository.GetProvider(user.ID, strings.TrimSpace(id))
	if err != nil {
		return user, model.Provider{}, err
	}
	if !found {
		return user, model.Provider{}, safeMessageError{message: "渠道不存在"}
	}
	return user, item, nil
}

func modelChannelFromProvider(item model.Provider) (model.ModelChannel, error) {
	credentials, err := decryptProviderCredentials(item.CredentialsCiphertext)
	if err != nil {
		return model.ModelChannel{}, err
	}
	if strings.TrimSpace(credentials.APIKey) == "" && (item.Protocol != ModelChannelProtocolHTTP || len(credentials.Headers) == 0) {
		return model.ModelChannel{}, safeMessageError{message: "渠道 API Key 未配置"}
	}
	return model.ModelChannel{
		ID: item.ID, Protocol: item.Protocol, Name: item.Name, BaseURL: item.BaseURL,
		APIKey: credentials.APIKey, Models: item.Models, Weight: 1, Timeout: item.Timeout,
		Enabled: item.Enabled, Restricted: true, Headers: credentials.Headers,
	}, nil
}

func providerView(item model.Provider) (ProviderView, error) {
	credentials, err := decryptProviderCredentials(item.CredentialsCiphertext)
	if err != nil {
		return ProviderView{}, err
	}
	headerNames := make([]string, 0, len(credentials.Headers))
	for name := range credentials.Headers {
		headerNames = append(headerNames, name)
	}
	sort.Strings(headerNames)
	verifiedModels := item.VerifiedModels
	if verifiedModels == nil {
		verifiedModels = []string{}
	}
	return ProviderView{
		ID: item.ID, Kind: item.Kind, Protocol: item.Protocol, Name: item.Name,
		BaseURL: item.BaseURL, HasAPIKey: credentials.APIKey != "",
		APIKeyMasked: maskedProviderSecret(credentials.APIKey), HasHeaders: len(credentials.Headers) > 0,
		HeaderNames: headerNames, Capabilities: item.Capabilities, Models: item.Models, VerifiedModels: verifiedModels,
		DefaultModel: item.DefaultModel, Timeout: item.Timeout, Enabled: item.Enabled,
		IsDefault: item.IsDefault, SortOrder: item.SortOrder, ConnectionStatus: item.ConnectionStatus,
		StatusMessage: item.StatusMessage, LastCheckedAt: item.LastCheckedAt,
		Executable: item.Executable, WorkingDirectory: item.WorkingDirectory,
		Version: item.Version, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt,
	}, nil
}

func saveProviderTestResult(item model.Provider, status model.ProviderStatus, message string, models []string) (ProviderTestResult, error) {
	item.ConnectionStatus = status
	item.StatusMessage = message
	item.LastCheckedAt = now()
	item.UpdatedAt = item.LastCheckedAt
	if len(models) > 0 {
		item.Models = models
	}
	if _, err := repository.SaveProvider(item); err != nil {
		return ProviderTestResult{}, err
	}
	return ProviderTestResult{Status: status, Message: message, Models: models, CheckedAt: item.LastCheckedAt}, nil
}

func saveCLIModelVerification(item model.Provider, modelName string, taskStatus string, taskMessage string) error {
	modelName = strings.TrimSpace(modelName)
	if modelName == "" || taskStatus != "succeeded" && taskStatus != "failed" {
		return nil
	}
	fresh, found, err := repository.GetProvider(item.OwnerUserID, item.ID)
	if err != nil || !found {
		return err
	}
	if fresh.Kind != model.ProviderKindCLI || fresh.Protocol != item.Protocol || !userLocalChannelHasModel(fresh.Models, modelName) {
		return nil
	}
	verified := append([]string(nil), fresh.VerifiedModels...)
	if taskStatus == "succeeded" && !userLocalChannelHasModel(verified, modelName) {
		verified = append(verified, modelName)
	}
	if taskStatus == "failed" && cliFailureInvalidatesModel(taskMessage) {
		verified = removeProviderModel(verified, modelName)
	}
	verified = providerModelsInCatalogOrder(verified, fresh.Models)
	if slices.Equal(verified, fresh.VerifiedModels) {
		return nil
	}
	fresh.VerifiedModels = verified
	fresh.UpdatedAt = now()
	_, err = repository.SaveProvider(fresh)
	return err
}

func cliFailureInvalidatesModel(message string) bool {
	detail := strings.ToLower(strings.TrimSpace(message))
	return strings.Contains(detail, "所选模型当前不可用") ||
		strings.Contains(detail, "模型或生图能力当前不可用") ||
		strings.Contains(detail, "model not found") ||
		strings.Contains(detail, "unknown model") ||
		strings.Contains(detail, "unsupported model")
}

func providerModelsInCatalogOrder(values []string, catalog []string) []string {
	result := make([]string, 0, len(values))
	for _, modelName := range catalog {
		if userLocalChannelHasModel(values, modelName) {
			result = append(result, modelName)
		}
	}
	return result
}

func removeProviderModel(values []string, target string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != target {
			result = append(result, value)
		}
	}
	return result
}

func normalizeProviderInput(input ProviderInput) ProviderInput {
	input.ID = strings.TrimSpace(input.ID)
	input.Kind = model.ProviderKind(strings.ToLower(strings.TrimSpace(string(input.Kind))))
	input.Protocol = strings.ToLower(strings.TrimSpace(input.Protocol))
	input.Name = strings.TrimSpace(input.Name)
	input.BaseURL = strings.TrimRight(strings.TrimSpace(input.BaseURL), "/")
	input.APIKey = strings.TrimSpace(input.APIKey)
	input.DefaultModel = strings.TrimSpace(input.DefaultModel)
	input.Executable = strings.TrimSpace(input.Executable)
	input.WorkingDirectory = strings.TrimSpace(input.WorkingDirectory)
	if input.Timeout <= 0 {
		input.Timeout = 120
	}
	input.Capabilities = uniqueAllowedValues(input.Capabilities, providerCapabilities)
	input.Models = userLocalChannelModels(input.Models)
	return input
}

func validateProviderInput(input ProviderInput) error {
	if input.Kind != model.ProviderKindAPI && input.Kind != model.ProviderKindCLI {
		return safeMessageError{message: "渠道类型无效"}
	}
	if input.Name == "" || len([]rune(input.Name)) > 80 {
		return safeMessageError{message: "渠道名称不能为空且不能超过 80 个字符"}
	}
	if input.Timeout < 1 || input.Timeout > 600 {
		return safeMessageError{message: "请求超时必须在 1 到 600 秒之间"}
	}
	if input.Kind == model.ProviderKindCLI {
		if !providerCLIProtocols[input.Protocol] {
			return safeMessageError{message: "CLI 类型不受支持"}
		}
		if input.WorkingDirectory != "" && (!strings.HasPrefix(input.WorkingDirectory, "/") || strings.ContainsRune(input.WorkingDirectory, '\x00')) {
			return safeMessageError{message: "CLI 工作目录必须是绝对路径"}
		}
		return nil
	}
	if !providerAPIProtocols[input.Protocol] {
		return safeMessageError{message: "API 协议不受支持"}
	}
	parsed, err := url.Parse(input.BaseURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || parsed.Scheme != "http" && parsed.Scheme != "https" {
		return safeMessageError{message: "Base URL 必须是有效的 HTTP 或 HTTPS 地址"}
	}
	if input.Protocol == "runninghub" {
		host := strings.ToLower(parsed.Hostname())
		if parsed.Scheme != "https" || host != "www.runninghub.ai" && host != "www.runninghub.cn" || strings.Trim(parsed.Path, "/") != "" {
			return safeMessageError{message: "RunningHub Base URL 必须是 https://www.runninghub.ai 或 https://www.runninghub.cn"}
		}
		for _, reference := range input.Models {
			if _, _, ok := ParseRunningHubReference(reference); !ok {
				return safeMessageError{message: "RunningHub 引用必须使用 app:<ID> 或 workflow:<ID>"}
			}
		}
		if input.DefaultModel != "" {
			if _, _, ok := ParseRunningHubReference(input.DefaultModel); !ok {
				return safeMessageError{message: "RunningHub 默认引用格式无效"}
			}
		}
	}
	return nil
}

func applyTrustedCLIProviderModels(saved model.Provider, input *ProviderInput) error {
	input.Capabilities = trustedCLIProviderCapabilities(input.Protocol)
	if input.ID == "" || saved.Kind != model.ProviderKindCLI || saved.Protocol != input.Protocol {
		input.Models = nil
		input.DefaultModel = ""
		return nil
	}
	input.Models = append([]string(nil), saved.Models...)
	if input.DefaultModel != "" && !userLocalChannelHasModel(input.Models, input.DefaultModel) {
		return safeMessageError{message: "CLI 默认模型必须来自受控检测结果"}
	}
	return nil
}

func trustedCLIProviderCapabilities(protocol string) []string {
	if protocol == "codex" {
		return []string{"text"}
	}
	if protocol == "gemini-cli" {
		return []string{"text", "image"}
	}
	if isCLIProxyProtocol(protocol) {
		return []string{"text", "image"}
	}
	if protocol == "gemini-official-cli" {
		return []string{"text"}
	}
	if protocol == "gpt-image-2" {
		return []string{"image"}
	}
	if protocol == "codex-image-emergency" {
		return []string{"image"}
	}
	if protocol == "jimeng" {
		return []string{"image", "video"}
	}
	return nil
}

func normalizeProviderHeaders(headers map[string]string) map[string]string {
	result := map[string]string{}
	for name, value := range headers {
		name = strings.TrimSpace(name)
		value = strings.TrimSpace(value)
		if name == "" || value == "" || strings.ContainsAny(name+value, "\r\n") {
			continue
		}
		result[name] = value
	}
	return result
}

func uniqueAllowedValues(values []string, allowed map[string]bool) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if !allowed[value] || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func encryptProviderCredentials(credentials providerCredentials) (string, error) {
	if credentials.APIKey == "" && len(credentials.Headers) == 0 {
		return "", nil
	}
	payload, err := json.Marshal(credentials)
	if err != nil {
		return "", err
	}
	gcm, err := providerGCM()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, payload, nil)
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

func decryptProviderCredentials(ciphertext string) (providerCredentials, error) {
	if strings.TrimSpace(ciphertext) == "" {
		return providerCredentials{}, nil
	}
	sealed, err := base64.RawURLEncoding.DecodeString(ciphertext)
	if err != nil {
		return providerCredentials{}, errors.New("渠道密钥无法解密")
	}
	gcm, err := providerGCM()
	if err != nil || len(sealed) < gcm.NonceSize() {
		return providerCredentials{}, errors.New("渠道密钥无法解密")
	}
	payload, err := gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], nil)
	if err != nil {
		return providerCredentials{}, errors.New("渠道密钥无法解密")
	}
	var credentials providerCredentials
	if err := json.Unmarshal(payload, &credentials); err != nil {
		return providerCredentials{}, errors.New("渠道密钥无法解密")
	}
	return credentials, nil
}

func providerGCM() (cipher.AEAD, error) {
	secret := strings.TrimSpace(config.Cfg.JWTSecret)
	if secret == "" {
		return nil, errors.New("JWT Secret 未配置")
	}
	key := sha256.Sum256([]byte("infinite-canvas/provider-credentials/v1:" + secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func maskedProviderSecret(secret string) string {
	if secret == "" {
		return ""
	}
	return "••••••••"
}

func safeProviderError(err error) string {
	if safe, ok := err.(interface{ SafeMessage() string }); ok {
		return safe.SafeMessage()
	}
	return "连接失败，请检查地址、密钥和网络"
}
