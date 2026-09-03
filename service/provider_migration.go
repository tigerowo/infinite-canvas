package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type ProviderMigrationItem struct {
	SourceID           string   `json:"sourceId"`
	Name               string   `json:"name"`
	Protocol           string   `json:"protocol"`
	BaseURL            string   `json:"baseUrl"`
	Models             []string `json:"models"`
	HasAPIKey          bool     `json:"hasApiKey"`
	Action             string   `json:"action"`
	ExistingProviderID string   `json:"existingProviderId,omitempty"`
	Issue              string   `json:"issue,omitempty"`
}

type ProviderMigrationPreview struct {
	Total            int                     `json:"total"`
	Importable       int                     `json:"importable"`
	Reusable         int                     `json:"reusable"`
	Invalid          int                     `json:"invalid"`
	PlaintextSecrets int                     `json:"plaintextSecrets"`
	Items            []ProviderMigrationItem `json:"items"`
}

type ProviderMigrationMapping struct {
	SourceID   string `json:"sourceId"`
	ProviderID string `json:"providerId"`
}

type ProviderMigrationResult struct {
	ImportedCount  int                        `json:"importedCount"`
	ReusedCount    int                        `json:"reusedCount"`
	CleanedSecrets int                        `json:"cleanedSecrets"`
	Mappings       []ProviderMigrationMapping `json:"mappings"`
	Providers      []ProviderView             `json:"providers"`
}

type legacyProviderCandidate struct {
	SourceID        string
	SourceIndex     int
	Synthetic       bool
	APIKey          string
	Input           ProviderInput
	Action          string
	TargetID        string
	TargetHasAPIKey bool
	Issue           string
}

type legacyModelConfig struct {
	LocalChannels []struct {
		ID        string   `json:"id"`
		Protocol  string   `json:"protocol"`
		Name      string   `json:"name"`
		BaseURL   string   `json:"baseUrl"`
		APIKey    string   `json:"apiKey"`
		Models    []string `json:"models"`
		Managed   bool     `json:"managed"`
		HasAPIKey bool     `json:"hasApiKey"`
	} `json:"localChannels"`
	BaseURL string   `json:"baseUrl"`
	APIKey  string   `json:"apiKey"`
	Models  []string `json:"models"`
	Timeout string   `json:"timeout"`
}

func CurrentUserProviderMigrationPreview(ctx context.Context) (ProviderMigrationPreview, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return ProviderMigrationPreview{}, safeMessageError{message: "请先登录"}
	}
	config, found, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return ProviderMigrationPreview{}, err
	}
	if !found || strings.TrimSpace(config.ModelConfig) == "" {
		return ProviderMigrationPreview{Items: []ProviderMigrationItem{}}, nil
	}
	existing, err := repository.ListProviders(user.ID, model.ProviderKindAPI)
	if err != nil {
		return ProviderMigrationPreview{}, err
	}
	candidates, err := buildLegacyProviderMigration(config.ModelConfig, existing)
	if err != nil {
		return ProviderMigrationPreview{}, err
	}
	preview := providerMigrationPreview(candidates)
	var legacy legacyModelConfig
	if json.Unmarshal([]byte(config.ModelConfig), &legacy) == nil && len(legacy.LocalChannels) > 0 && strings.TrimSpace(legacy.APIKey) != "" {
		preview.PlaintextSecrets++
	}
	return preview, nil
}

func MigrateCurrentUserProviders(ctx context.Context, cleanupLegacy bool) (ProviderMigrationResult, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return ProviderMigrationResult{}, safeMessageError{message: "请先登录"}
	}
	config, found, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return ProviderMigrationResult{}, err
	}
	if !found || strings.TrimSpace(config.ModelConfig) == "" {
		return ProviderMigrationResult{}, safeMessageError{message: "没有可迁移的旧渠道"}
	}
	existing, err := repository.ListProviders(user.ID, model.ProviderKindAPI)
	if err != nil {
		return ProviderMigrationResult{}, err
	}
	candidates, err := buildLegacyProviderMigration(config.ModelConfig, existing)
	if err != nil {
		return ProviderMigrationResult{}, err
	}

	startSort, err := repository.NextProviderSortOrder(user.ID, model.ProviderKindAPI)
	if err != nil {
		return ProviderMigrationResult{}, err
	}
	current := now()
	imports := make([]model.Provider, 0)
	mappings := make([]ProviderMigrationMapping, 0)
	reused := 0
	for index := range candidates {
		candidate := &candidates[index]
		if candidate.Action == "invalid" {
			continue
		}
		mappings = append(mappings, ProviderMigrationMapping{SourceID: candidate.SourceID, ProviderID: candidate.TargetID})
		if candidate.Action == "reuse" {
			reused++
			continue
		}
		ciphertext, err := encryptProviderCredentials(providerCredentials{APIKey: candidate.APIKey})
		if err != nil {
			return ProviderMigrationResult{}, err
		}
		input := candidate.Input
		imports = append(imports, model.Provider{
			ID: candidate.TargetID, OwnerUserID: user.ID, Kind: model.ProviderKindAPI,
			Protocol: input.Protocol, Name: input.Name, BaseURL: input.BaseURL,
			CredentialsCiphertext: ciphertext, Capabilities: input.Capabilities,
			Models: input.Models, DefaultModel: input.DefaultModel, Timeout: input.Timeout,
			Enabled: true, IsDefault: len(existing) == 0 && len(imports) == 0,
			SortOrder: startSort + len(imports), ConnectionStatus: model.ProviderStatusUntested,
			CreatedAt: current, UpdatedAt: current,
		})
	}
	if len(imports) == 0 && reused == 0 {
		return ProviderMigrationResult{}, safeMessageError{message: "旧渠道均无效，暂时无法迁移"}
	}

	cleanedSecrets := 0
	var rewritten *model.UserConfig
	if cleanupLegacy {
		cleaned, count, err := cleanupLegacyProviderConfig(config.ModelConfig, candidates)
		if err != nil {
			return ProviderMigrationResult{}, err
		}
		config.ModelConfig = cleaned
		rewritten = &config
		cleanedSecrets = count
	}
	if err := repository.ImportProvidersAndUserConfig(imports, rewritten); err != nil {
		return ProviderMigrationResult{}, err
	}
	providers, err := CurrentUserProviders(ctx, "")
	if err != nil {
		return ProviderMigrationResult{}, err
	}
	return ProviderMigrationResult{
		ImportedCount: len(imports), ReusedCount: reused, CleanedSecrets: cleanedSecrets,
		Mappings: mappings, Providers: providers,
	}, nil
}

func buildLegacyProviderMigration(raw string, existing []model.Provider) ([]legacyProviderCandidate, error) {
	var config legacyModelConfig
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		return nil, safeMessageError{message: "旧模型配置无法解析"}
	}
	timeout := 600
	if value, err := strconv.Atoi(strings.TrimSpace(config.Timeout)); err == nil && value >= 1 && value <= 600 {
		timeout = value
	}
	candidates := make([]legacyProviderCandidate, 0, len(config.LocalChannels)+1)
	for index, channel := range config.LocalChannels {
		if channel.Managed {
			continue
		}
		candidates = append(candidates, newLegacyProviderCandidate(
			firstVideoTaskValue(strings.TrimSpace(channel.ID), fmt.Sprintf("local-%d", index+1)),
			index, false, channel.Protocol, channel.Name, channel.BaseURL, channel.APIKey,
			channel.Models, timeout,
		))
	}
	if len(config.LocalChannels) == 0 && (strings.TrimSpace(config.BaseURL) != "" || strings.TrimSpace(config.APIKey) != "") {
		candidates = append(candidates, newLegacyProviderCandidate(
			"local-default", -1, true, "openai", "本地直连", config.BaseURL,
			config.APIKey, config.Models, timeout,
		))
	}

	targets := map[string]struct {
		id        string
		hasAPIKey bool
	}{}
	for _, item := range existing {
		credentials, err := decryptProviderCredentials(item.CredentialsCiphertext)
		if err != nil {
			return nil, err
		}
		targets[providerMigrationFingerprint(item.Name, item.Protocol, item.BaseURL, credentials.APIKey)] = struct {
			id        string
			hasAPIKey bool
		}{id: item.ID, hasAPIKey: credentials.APIKey != ""}
	}
	for index := range candidates {
		candidate := &candidates[index]
		candidate.Input = normalizeProviderInput(candidate.Input)
		if err := validateProviderInput(candidate.Input); err != nil {
			candidate.Action = "invalid"
			candidate.Issue = safeProviderError(err)
			continue
		}
		fingerprint := providerMigrationFingerprint(candidate.Input.Name, candidate.Input.Protocol, candidate.Input.BaseURL, candidate.APIKey)
		if target, ok := targets[fingerprint]; ok {
			candidate.Action = "reuse"
			candidate.TargetID = target.id
			candidate.TargetHasAPIKey = target.hasAPIKey
			continue
		}
		candidate.Action = "import"
		candidate.TargetID = newID("provider")
		candidate.TargetHasAPIKey = candidate.APIKey != ""
		targets[fingerprint] = struct {
			id        string
			hasAPIKey bool
		}{id: candidate.TargetID, hasAPIKey: candidate.TargetHasAPIKey}
	}
	return candidates, nil
}

func newLegacyProviderCandidate(sourceID string, sourceIndex int, synthetic bool, protocol string, name string, baseURL string, apiKey string, models []string, timeout int) legacyProviderCandidate {
	protocol = strings.ToLower(strings.TrimSpace(protocol))
	if protocol == "" {
		protocol = "openai"
	}
	name = firstVideoTaskValue(strings.TrimSpace(name), "本地渠道")
	models = userLocalChannelModels(models)
	return legacyProviderCandidate{
		SourceID: sourceID, SourceIndex: sourceIndex, Synthetic: synthetic,
		APIKey: strings.TrimSpace(apiKey),
		Input: ProviderInput{
			Kind: model.ProviderKindAPI, Protocol: protocol, Name: name,
			BaseURL: baseURL, APIKey: apiKey, Models: models,
			Capabilities: legacyProviderCapabilities(models), Timeout: timeout,
		},
	}
}

func providerMigrationPreview(candidates []legacyProviderCandidate) ProviderMigrationPreview {
	preview := ProviderMigrationPreview{Items: make([]ProviderMigrationItem, 0, len(candidates))}
	for _, candidate := range candidates {
		item := ProviderMigrationItem{
			SourceID: candidate.SourceID, Name: candidate.Input.Name,
			Protocol: candidate.Input.Protocol, BaseURL: migrationDisplayURL(candidate.Input.BaseURL),
			Models: candidate.Input.Models, HasAPIKey: candidate.APIKey != "",
			Action: candidate.Action, Issue: candidate.Issue,
		}
		preview.Total++
		if item.HasAPIKey {
			preview.PlaintextSecrets++
		}
		switch candidate.Action {
		case "import":
			preview.Importable++
		case "reuse":
			preview.Reusable++
			item.ExistingProviderID = candidate.TargetID
		default:
			preview.Invalid++
		}
		preview.Items = append(preview.Items, item)
	}
	return preview
}

func providerMigrationFingerprint(name string, protocol string, baseURL string, apiKey string) string {
	secretHash := sha256.Sum256([]byte(strings.TrimSpace(apiKey)))
	return strings.ToLower(strings.TrimSpace(name)) + "\x00" +
		strings.ToLower(strings.TrimSpace(protocol)) + "\x00" +
		strings.TrimRight(strings.ToLower(strings.TrimSpace(baseURL)), "/") + "\x00" +
		hex.EncodeToString(secretHash[:])
}

func legacyProviderCapabilities(models []string) []string {
	if len(models) == 0 {
		return []string{"text", "image", "video", "audio"}
	}
	seen := map[string]bool{}
	for _, name := range models {
		lower := strings.ToLower(strings.TrimSpace(name))
		switch {
		case strings.Contains(lower, "tts"), strings.Contains(lower, "speech"), strings.Contains(lower, "audio"):
			seen["audio"] = true
		case isVideoModelName(lower):
			seen["video"] = true
		case isImageModelName(lower):
			seen["image"] = true
		default:
			seen["text"] = true
		}
	}
	result := make([]string, 0, 4)
	for _, capability := range []string{"text", "image", "video", "audio"} {
		if seen[capability] {
			result = append(result, capability)
		}
	}
	return result
}

func migrationDisplayURL(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return strings.TrimSpace(raw)
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

func cleanupLegacyProviderConfig(raw string, candidates []legacyProviderCandidate) (string, int, error) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return "", 0, err
	}
	byIndex := map[int]legacyProviderCandidate{}
	selectionMap := map[string]string{}
	cleanedSecrets := 0
	for _, candidate := range candidates {
		if candidate.Action == "invalid" {
			continue
		}
		selectionMap[candidate.SourceID] = candidate.TargetID
		if !candidate.Synthetic {
			byIndex[candidate.SourceIndex] = candidate
		}
	}

	cleanedChannels := make([]any, 0)
	seenTargets := map[string]bool{}
	if channels, ok := payload["localChannels"].([]any); ok {
		for index, rawChannel := range channels {
			candidate, migrated := byIndex[index]
			channel, isObject := rawChannel.(map[string]any)
			if !migrated || !isObject {
				cleanedChannels = append(cleanedChannels, rawChannel)
				continue
			}
			if seenTargets[candidate.TargetID] {
				continue
			}
			if value, _ := channel["apiKey"].(string); strings.TrimSpace(value) != "" {
				cleanedSecrets++
			}
			channel["id"] = candidate.TargetID
			channel["apiKey"] = ""
			channel["managed"] = true
			channel["hasApiKey"] = candidate.TargetHasAPIKey
			cleanedChannels = append(cleanedChannels, channel)
			seenTargets[candidate.TargetID] = true
		}
	}
	for _, candidate := range candidates {
		if !candidate.Synthetic || candidate.Action == "invalid" || seenTargets[candidate.TargetID] {
			continue
		}
		cleanedChannels = append(cleanedChannels, map[string]any{
			"id": candidate.TargetID, "protocol": candidate.Input.Protocol,
			"name": candidate.Input.Name, "baseUrl": candidate.Input.BaseURL,
			"apiKey": "", "models": candidate.Input.Models,
			"managed": true, "hasApiKey": candidate.TargetHasAPIKey,
		})
		seenTargets[candidate.TargetID] = true
	}
	payload["localChannels"] = cleanedChannels
	if value, _ := payload["apiKey"].(string); strings.TrimSpace(value) != "" {
		cleanedSecrets++
	}
	payload["apiKey"] = ""
	for _, field := range []string{"activeChannelId", "imageChannelId", "videoChannelId", "textChannelId", "audioChannelId"} {
		if sourceID, _ := payload[field].(string); selectionMap[sourceID] != "" {
			payload[field] = selectionMap[sourceID]
		}
	}
	encoded, err := json.Marshal(payload)
	return string(encoded), cleanedSecrets, err
}
