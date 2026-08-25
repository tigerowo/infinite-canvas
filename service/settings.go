package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

var adminModelHTTPClient = &http.Client{Timeout: 30 * time.Second}

var modelDiscoveryReadLimits = upstreamReadLimits{
	MaxRequests: 32,
	MaxBytes:    32 * 1024 * 1024,
	Deadline:    time.Minute,
}

func PublicSettings() (model.PublicSetting, error) {
	settings, err := repository.GetSettings()
	settings = normalizeSettings(settings)
	settings.Public.ModelChannel.Channels = publicChannelInfos(settings.Private.Channels)
	if len(settings.Public.ModelChannel.AvailableModels) == 0 {
		settings.Public.ModelChannel.AvailableModels = enabledChannelModels(settings.Private.Channels)
	}
	return settings.Public, err
}

func UserCanUseRemoteModelChannel(user model.AuthUser) bool {
	if user.Role == model.UserRoleAdmin {
		return true
	}
	settings, err := PublicSettings()
	return err == nil && settings.ModelChannel.AllowUserRemoteChannel != nil && *settings.ModelChannel.AllowUserRemoteChannel
}

func AdminSettings() (model.Settings, error) {
	settings, err := repository.GetSettings()
	return hidePrivateAPIKeys(normalizeSettings(settings)), err
}

func SaveSettings(settings model.Settings) (model.Settings, error) {
	saved, err := repository.GetSettings()
	if err != nil {
		return model.Settings{}, err
	}
	settings = normalizeSettings(settings)
	keepPrivateAPIKeys(&settings, normalizeSettings(saved))
	keepPrivateAuthSecrets(&settings, normalizeSettings(saved))
	keepPrivateStorageSecrets(&settings, normalizeSettings(saved))
	if err := validateEnabledStorageProviderTypes(settings.Private.Storage.Providers); err != nil {
		return model.Settings{}, err
	}
	result, err := repository.SaveSettings(settings, now())
	if err == nil {
		RefreshPromptSyncScheduler()
		RefreshStorageCapacityScheduler()
		RefreshAILogCleanupScheduler()
	}
	return hidePrivateAPIKeys(result), err
}

func AdminChannelModels(index *int, channel model.ModelChannel) ([]string, error) {
	resolved, err := resolveAdminChannel(index, channel)
	if err != nil {
		return nil, err
	}
	return fetchAdminChannelModels(resolved)
}

func AdminTestChannelModel(index *int, channel model.ModelChannel, modelName string) (string, error) {
	resolved, err := resolveAdminChannel(index, channel)
	if err != nil {
		return "", err
	}
	if IsMiniMaxChannel(resolved) {
		return "MiniMax-H3 是异步视频模型，请在视频创作台测试生成。", nil
	}
	if isArkAgentPlanChannel(resolved) || isSeedanceModelName(modelName) {
		return testArkSeedanceChannelModel(resolved, modelName)
	}
	return testAdminChannelModel(resolved, modelName)
}

func normalizeSettings(settings model.Settings) model.Settings {
	settings.Private = normalizePrivateSetting(settings.Private)
	settings.Public = normalizePublicSettingWithChannels(settings.Public, settings.Private.Channels)
	return settings
}

func normalizePublicSetting(setting model.PublicSetting) model.PublicSetting {
	return normalizePublicSettingWithChannels(setting, nil)
}

func DefaultSystemPrompts() model.SystemPromptSetting {
	return model.SystemPromptSetting{
		Image:    "",
		Video:    "",
		Text:     "",
		Workflow: "",
		WorkflowAgent: `你是一个用于创建图片创作工作流的产品设计助理。请根据用户需求输出严格 JSON，不要输出 Markdown。
目标：把用户的自然语言需求整理为一个可复用的图片生成工作流。
要求：
1. 工作流必须面向同类型批量创作，变量字段要少而明确。
2. 变量名使用 snake_case，label 使用中文。
3. promptTemplate 必须使用 {{variable_name}} 引用变量。
4. 如果用户需要"多张、系列、组图、文章配图、海报组、写真组、方案集"，mode 使用 multi_image_series；否则使用 single_image。
5. config 只输出必要配置，apiMode 可为 responses、images 或 chat。
6. variables 支持 text、textarea、number、select、boolean。
7. select 类型的 options 必须是字符串数组。
8. 多图工作流必须输出 seriesConfig，用于先生成多条图片提示词草稿。
9. 输出 JSON 结构：
{
  "name": "工作流名称",
  "category": "分类",
  "description": "一句话描述",
  "mode": "single_image",
  "variables": [
    {"key":"product_name","label":"产品名称","type":"text","required":true,"defaultValue":"","options":[]}
  ],
  "config": {
    "promptTemplate": "生成提示词模板",
    "systemPrompt": "系统提示词，可空",
    "model": "",
    "apiMode": "responses",
    "size": "auto",
    "quality": "auto",
    "count": "1",
    "outputFormat": "png",
    "timeout": 600
  },
  "seriesConfig": {
    "targetCount": "4",
    "promptInstruction": "多图拆分规则，可空",
    "reviewRequired": true,
    "concurrency": "3"
  },
  "warnings": []
}`,
	}
}

func normalizePublicSettingWithChannels(setting model.PublicSetting, channels []model.ModelChannel) model.PublicSetting {
	if setting.ModelChannel.AvailableModels == nil {
		setting.ModelChannel.AvailableModels = []string{}
	}
	if setting.ModelChannel.ModelCosts == nil {
		setting.ModelChannel.ModelCosts = []model.ModelCost{}
	}
	if setting.ModelChannel.Channels == nil {
		setting.ModelChannel.Channels = []model.PublicModelChannelInfo{}
	}
	if strings.TrimSpace(setting.ModelChannel.SystemPrompts.Image) == "" {
		setting.ModelChannel.SystemPrompts.Image = firstNonEmpty(setting.ModelChannel.SystemPrompt, DefaultSystemPrompts().Image)
	}
	if strings.TrimSpace(setting.ModelChannel.SystemPrompts.Video) == "" {
		setting.ModelChannel.SystemPrompts.Video = DefaultSystemPrompts().Video
	}
	if strings.TrimSpace(setting.ModelChannel.SystemPrompts.Text) == "" {
		setting.ModelChannel.SystemPrompts.Text = firstNonEmpty(setting.ModelChannel.SystemPrompt, DefaultSystemPrompts().Text)
	}
	if strings.TrimSpace(setting.ModelChannel.SystemPrompts.Workflow) == "" {
		setting.ModelChannel.SystemPrompts.Workflow = DefaultSystemPrompts().Workflow
	}
	if strings.TrimSpace(setting.ModelChannel.SystemPrompts.WorkflowAgent) == "" {
		setting.ModelChannel.SystemPrompts.WorkflowAgent = DefaultSystemPrompts().WorkflowAgent
	}
	for i := range setting.ModelChannel.ModelCosts {
		setting.ModelChannel.ModelCosts[i].Model = strings.TrimSpace(setting.ModelChannel.ModelCosts[i].Model)
		if setting.ModelChannel.ModelCosts[i].Credits < 0 {
			setting.ModelChannel.ModelCosts[i].Credits = 0
		}
	}
	if setting.ModelChannel.AllowCustomChannel == nil {
		enabled := true
		setting.ModelChannel.AllowCustomChannel = &enabled
	}
	if setting.ModelChannel.AllowUserRemoteChannel == nil {
		enabled := false
		setting.ModelChannel.AllowUserRemoteChannel = &enabled
	}
	if setting.Auth.AllowRegister == nil {
		enabled := true
		setting.Auth.AllowRegister = &enabled
	}
	setting.ModelChannel.AvailableModels = filterEnabledModels(setting.ModelChannel.AvailableModels, enabledChannelModels(channels))
	setting.ModelChannel.DefaultTextModel = repairDefaultModel(setting.ModelChannel.DefaultTextModel, setting.ModelChannel.AvailableModels, isTextModelName)
	setting.ModelChannel.DefaultImageModel = repairDefaultModel(setting.ModelChannel.DefaultImageModel, setting.ModelChannel.AvailableModels, isImageModelName)
	setting.ModelChannel.DefaultVideoModel = repairDefaultModel(setting.ModelChannel.DefaultVideoModel, setting.ModelChannel.AvailableModels, isVideoModelName)
	setting.ModelChannel.DefaultModel = repairDefaultModel(setting.ModelChannel.DefaultModel, setting.ModelChannel.AvailableModels, isTextModelName)
	return setting
}

func ModelCost(modelName string) (int, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return 0, err
	}
	modelName = strings.TrimSpace(modelName)
	for _, item := range normalizePublicSetting(settings.Public).ModelChannel.ModelCosts {
		if item.Model == modelName {
			return item.Credits, nil
		}
	}
	return 0, nil
}

func normalizePrivateSetting(setting model.PrivateSetting) model.PrivateSetting {
	if setting.Channels == nil {
		setting.Channels = []model.ModelChannel{}
	}
	setting.PromptSync = normalizePromptSyncSetting(setting.PromptSync)
	setting.AILog = normalizeAILogSetting(setting.AILog)
	setting.Storage = normalizePrivateStorageSetting(setting.Storage)
	for i := range setting.Channels {
		if setting.Channels[i].Protocol == "" {
			setting.Channels[i].Protocol = "openai"
		}
		if setting.Channels[i].ID == "" {
			setting.Channels[i].ID = stableModelChannelID(setting.Channels[i])
		}
		if setting.Channels[i].Models == nil {
			setting.Channels[i].Models = []string{}
		}
		if setting.Channels[i].Weight <= 0 {
			setting.Channels[i].Weight = 1
		}
		if setting.Channels[i].Timeout <= 0 {
			setting.Channels[i].Timeout = 600
		}
	}
	return setting
}

func hidePrivateAPIKeys(settings model.Settings) model.Settings {
	for i := range settings.Private.Channels {
		settings.Private.Channels[i].APIKey = ""
	}
	for i := range settings.Private.Storage.Providers {
		settings.Private.Storage.Providers[i].SecretAccessKey = ""
		settings.Private.Storage.Providers[i].Password = ""
	}
	settings.Private.Auth.LinuxDo.ClientSecret = ""
	return settings
}

func keepPrivateAPIKeys(settings *model.Settings, saved model.Settings) {
	for i := range settings.Private.Channels {
		if strings.TrimSpace(settings.Private.Channels[i].APIKey) != "" {
			continue
		}
		if channel, ok := findSavedChannel(settings.Private.Channels[i], saved.Private.Channels, i); ok {
			settings.Private.Channels[i].APIKey = channel.APIKey
		}
	}
}

func keepPrivateAuthSecrets(settings *model.Settings, saved model.Settings) {
	if strings.TrimSpace(settings.Private.Auth.LinuxDo.ClientSecret) == "" {
		settings.Private.Auth.LinuxDo.ClientSecret = saved.Private.Auth.LinuxDo.ClientSecret
	}
}

func findSavedChannel(channel model.ModelChannel, saved []model.ModelChannel, index int) (model.ModelChannel, bool) {
	for _, item := range saved {
		if item.Name == channel.Name && item.BaseURL == channel.BaseURL {
			return item, true
		}
	}
	if index < len(saved) {
		return saved[index], true
	}
	return model.ModelChannel{}, false
}

func SelectModelChannel(modelName string) (model.ModelChannel, error) {
	return SelectModelChannelForModel(modelName, "")
}

func SelectModelChannelForModel(modelName string, channelID string) (model.ModelChannel, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.ModelChannel{}, err
	}
	channels := modelChannelsForModel(normalizePrivateSetting(settings.Private).Channels, modelName)
	if len(channels) == 0 {
		return model.ModelChannel{}, errors.New("没有可用模型渠道")
	}
	if strings.TrimSpace(channelID) != "" {
		for _, channel := range channels {
			if channel.ID == channelID {
				return channel, nil
			}
		}
		return model.ModelChannel{}, errors.New("指定模型渠道不可用")
	}
	total := 0
	for _, channel := range channels {
		total += channel.Weight
	}
	hit := rand.Intn(total)
	for _, channel := range channels {
		hit -= channel.Weight
		if hit < 0 {
			return channel, nil
		}
	}
	return channels[0], nil
}

func HTTPClientForChannel(channel model.ModelChannel) *http.Client {
	timeout := channel.Timeout
	if timeout <= 0 {
		timeout = 600
	}
	if channel.Restricted {
		return SafeProxyHTTPClientWithTimeout(time.Duration(timeout) * time.Second)
	}
	return &http.Client{Timeout: time.Duration(timeout) * time.Second}
}

func BuildModelChannelURL(channel model.ModelChannel, path string) string {
	if IsGeminiChannel(channel) {
		return BuildGeminiChannelURL(channel, path)
	}
	baseURL := normalizeModelChannelBaseURL(channel.BaseURL)
	if IsGenericHTTPChannel(channel) {
		return baseURL + "/" + strings.TrimLeft(path, "/")
	}
	if IsMiniMaxChannel(channel) {
		return baseURL + path
	}
	lowerBaseURL := strings.ToLower(baseURL)
	if !strings.HasSuffix(lowerBaseURL, "/v1") && !strings.HasSuffix(lowerBaseURL, "/api/v3") && !strings.HasSuffix(lowerBaseURL, "/api/plan/v3") && !strings.HasSuffix(lowerBaseURL, "/api/paas/v4") {
		baseURL += "/v1"
	}
	return baseURL + path
}

func normalizeModelChannelBaseURL(baseURL string) string {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	parsed, err := url.Parse(baseURL)
	if err == nil && parsed.Scheme != "" && parsed.Host != "" {
		path := strings.TrimRight(parsed.Path, "/")
		lowerPath := strings.ToLower(path)
		for _, versionPath := range []string{"/api/plan/v3", "/api/paas/v4"} {
			if index := strings.Index(lowerPath, versionPath); index >= 0 {
				end := index + len(versionPath)
				if len(lowerPath) == end || lowerPath[end] == '/' {
					parsed.Path = path[:end]
					parsed.RawPath = ""
					parsed.RawQuery = ""
					parsed.Fragment = ""
					return strings.TrimRight(parsed.String(), "/")
				}
			}
		}
	}
	return baseURL
}

func isArkAgentPlanChannel(channel model.ModelChannel) bool {
	baseURL := strings.ToLower(normalizeModelChannelBaseURL(channel.BaseURL))
	return strings.HasSuffix(baseURL, "/api/plan/v3")
}

func isSeedanceModelName(modelName string) bool {
	modelName = strings.ToLower(strings.TrimSpace(modelName))
	return strings.Contains(modelName, "seedance") || strings.Contains(modelName, "doubao-seedance")
}

func enabledChannelModels(channels []model.ModelChannel) []string {
	models := []string{}
	for _, channel := range channels {
		if !channel.Enabled {
			continue
		}
		models = append(models, channel.Models...)
	}
	return uniqueModelNames(models)
}

func filterEnabledModels(models []string, options []string) []string {
	allowed := map[string]bool{}
	for _, modelName := range options {
		allowed[modelName] = true
	}
	result := []string{}
	for _, modelName := range uniqueModelNames(models) {
		if allowed[modelName] {
			result = append(result, modelName)
		}
	}
	return result
}

func uniqueModelNames(models []string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, item := range models {
		name := strings.TrimSpace(item)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		result = append(result, name)
	}
	return result
}

func repairDefaultModel(current string, models []string, preferred func(string) bool) string {
	current = strings.TrimSpace(current)
	for _, item := range models {
		if item == current {
			return current
		}
	}
	for _, item := range models {
		if preferred(item) {
			return item
		}
	}
	if len(models) > 0 {
		return models[0]
	}
	return ""
}

func isVideoModelName(modelName string) bool {
	name := strings.ToLower(strings.TrimSpace(modelName))
	return name == "minimax-h3" || strings.Contains(name, "seedance") || strings.Contains(name, "video")
}

func isImageModelName(modelName string) bool {
	name := strings.ToLower(strings.TrimSpace(modelName))
	return strings.Contains(name, "seedream") || strings.Contains(name, "gpt-image") || strings.Contains(name, "image")
}

func isTextModelName(modelName string) bool {
	return !isImageModelName(modelName) && !isVideoModelName(modelName)
}

func normalizeModelChannel(channel model.ModelChannel) model.ModelChannel {
	if channel.Protocol == "" {
		channel.Protocol = "openai"
	}
	if channel.ID == "" {
		channel.ID = stableModelChannelID(channel)
	}
	if channel.Models == nil {
		channel.Models = []string{}
	}
	if channel.Weight <= 0 {
		channel.Weight = 1
	}
	if channel.Timeout <= 0 {
		channel.Timeout = 600
	}
	return channel
}

func resolveAdminChannel(index *int, channel model.ModelChannel) (model.ModelChannel, error) {
	resolved := normalizeModelChannel(channel)
	if strings.TrimSpace(resolved.APIKey) == "" {
		settings, err := repository.GetSettings()
		if err != nil {
			return model.ModelChannel{}, err
		}
		saved := normalizePrivateSetting(settings.Private).Channels
		if index != nil && *index >= 0 && *index < len(saved) {
			if resolved.APIKey == "" {
				resolved.APIKey = saved[*index].APIKey
			}
			if resolved.BaseURL == "" {
				resolved.BaseURL = saved[*index].BaseURL
			}
			if resolved.Name == "" {
				resolved.Name = saved[*index].Name
			}
		}
		if resolved.APIKey == "" {
			if savedChannel, ok := findSavedChannel(resolved, saved, -1); ok {
				resolved.APIKey = savedChannel.APIKey
			}
		}
	}
	if strings.TrimSpace(resolved.BaseURL) == "" {
		return model.ModelChannel{}, safeMessageError{message: "缺少接口地址"}
	}
	if strings.TrimSpace(resolved.APIKey) == "" {
		return model.ModelChannel{}, safeMessageError{message: "缺少 API Key"}
	}
	return resolved, nil
}

func FetchModelChannelModels(channel model.ModelChannel) ([]string, error) {
	return fetchAdminChannelModels(channel)
}

func fetchAdminChannelModels(channel model.ModelChannel) ([]string, error) {
	budget := newUpstreamReadBudget(context.Background(), "模型列表读取", modelDiscoveryReadLimits)
	defer budget.Close()
	return fetchAdminChannelModelsWithBudget(channel, budget)
}

func fetchAdminChannelModelsWithBudget(channel model.ModelChannel, budget *upstreamReadBudget) ([]string, error) {
	if IsGeminiChannel(channel) {
		return fetchGeminiAdminChannelModels(channel, budget)
	}
	if IsMiniMaxChannel(channel) {
		return MiniMaxModels(), nil
	}
	if IsMiMoChannel(channel) {
		result := MiMoModels()
		sort.Strings(result)
		return result, nil
	}
	if isKIEAdminChannel(channel) {
		result := kieMarketModels()
		sort.Strings(result)
		return result, nil
	}
	request, err := http.NewRequest(http.MethodGet, BuildModelChannelURL(channel, "/models"), nil)
	if err != nil {
		return nil, err
	}
	request = request.WithContext(budget.Context())
	SetModelChannelAuthHeader(request, channel)
	client := adminModelHTTPClient
	if channel.Restricted {
		client = HTTPClientForChannel(channel)
	}
	client = budget.HTTPClient(client)
	response, err := client.Do(request)
	if err != nil {
		err = normalizeUpstreamBudgetError(err)
		if isUpstreamBudgetError(err) {
			return nil, err
		}
		return nil, safeMessageError{message: "读取模型失败：上游接口无响应或网络不可达"}
	}
	defer response.Body.Close()
	body, err := readLimitedProviderResponse(response.Body)
	if err != nil {
		return nil, normalizeUpstreamBudgetError(err)
	}
	if response.StatusCode >= http.StatusBadRequest {
		if response.StatusCode == http.StatusNotFound && isArkAgentPlanChannel(channel) {
			return nil, safeMessageError{message: "火山方舟 Agent Plan 未提供 OpenAI /models 模型列表接口，请手动填写模型名称，例如 doubao-seedance-2.0。"}
		}
		return nil, readAdminChannelError(body, response.StatusCode, "读取模型失败")
	}
	result, err := parseProviderModelList(body)
	if err != nil {
		return nil, safeMessageError{message: "读取模型失败：上游响应无法解析"}
	}
	sort.Strings(result)
	return result, nil
}

func parseProviderModelList(body []byte) ([]string, error) {
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	result := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		result = appendUniqueModel(result, item.ID)
	}
	if len(payload.Models) == 0 {
		return result, nil
	}
	var objects []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if json.Unmarshal(payload.Models, &objects) == nil {
		for _, item := range objects {
			result = appendUniqueModel(result, firstVideoTaskValue(item.ID, item.Name))
		}
		return result, nil
	}
	var names []string
	if err := json.Unmarshal(payload.Models, &names); err != nil {
		return nil, err
	}
	for _, name := range names {
		result = appendUniqueModel(result, name)
	}
	return result, nil
}

func appendUniqueModel(models []string, name string) []string {
	name = strings.TrimPrefix(strings.TrimSpace(name), "models/")
	if name == "" {
		return models
	}
	for _, item := range models {
		if item == name {
			return models
		}
	}
	return append(models, name)
}

func isKIEAdminChannel(channel model.ModelChannel) bool {
	protocol := strings.ToLower(strings.TrimSpace(channel.Protocol))
	baseURL := strings.ToLower(strings.TrimSpace(channel.BaseURL))
	return protocol == "kie" || strings.Contains(baseURL, "kie.ai")
}

func kieMarketModels() []string {
	return []string{
		"bytedance/seedream",
		"bytedance/seedream-v4-text-to-image",
		"bytedance/seedream-v4-edit",
		"seedream/4.5-text-to-image",
		"seedream/4.5-edit",
		"seedream/5-lite-text-to-image",
		"seedream/5-lite-image-to-image",
		"seedream/5-pro-text-to-image",
		"seedream/5-pro-image-to-image",
		"seedream/5-pro-layer-decomposition",
		"z-image",
		"nano-banana-2",
		"nano-banana-2-lite",
		"google/imagen4-fast",
		"google/imagen4-ultra",
		"google/imagen4",
		"google/nano-banana-edit",
		"google/nano-banana",
		"nano-banana-pro",
		"flux-2/pro-image-to-image",
		"flux-2/pro-text-to-image",
		"flux-2/flex-image-to-image",
		"flux-2/flex-text-to-image",
		"grok-imagine-image-2-0/text-to-image",
		"grok-imagine/text-to-image",
		"grok-imagine/image-to-image",
		"gpt-image/1.5-text-to-image",
		"gpt-image/1.5-image-to-image",
		"gpt-image-2-text-to-image",
		"gpt-image-2-image-to-image",
		"topaz/image-upscale",
		"recraft/remove-background",
		"recraft/crisp-upscale",
		"ideogram/character-edit",
		"ideogram/character-remix",
		"ideogram/character",
		"ideogram/v3-text-to-image",
		"ideogram/v3-edit",
		"ideogram/v3-remix",
		"qwen/text-to-image",
		"qwen/image-to-image",
		"qwen/image-edit",
		"qwen2/image-edit",
		"qwen2/text-to-image",
		"wan/2-7-image",
		"wan/2-7-image-pro",
		"grok-imagine/text-to-video",
		"grok-imagine/image-to-video",
		"grok-imagine/upscale",
		"grok-imagine/extend",
		"grok-imagine-video-1-5-preview",
		"minimax-h3/text-to-video",
		"minimax-h3/image-to-video",
		"minimax-h3/reference-to-video",
		"kling-2.6/text-to-video",
		"kling-2.6/image-to-video",
		"kling/v2-5-turbo-image-to-video-pro",
		"kling/v2-5-turbo-text-to-video-pro",
		"kling/ai-avatar-standard",
		"kling/ai-avatar-pro",
		"kling/v2-1-master-image-to-video",
		"kling/v2-1-master-text-to-video",
		"kling/v2-1-pro",
		"kling/v2-1-standard",
		"kling-2.6/motion-control",
		"kling-3.0/motion-control",
		"kling-3.0/video",
		"kling-3.0-omni/text-to-video",
		"kling-3.0-omni/image-to-video",
		"kling-3.0-omni/reference-to-video",
		"kling-3.0-omni/transformation",
		"kling/v3-turbo-text-to-video",
		"kling/v3-turbo-image-to-video",
		"bytedance/seedance-2",
		"bytedance/seedance-2-fast",
		"bytedance/seedance-2-mini",
		"bytedance/seedance-1.5-pro",
		"bytedance/v1-pro-fast-image-to-video",
		"bytedance/v1-pro-image-to-video",
		"bytedance/v1-pro-text-to-video",
		"bytedance/v1-lite-image-to-video",
		"bytedance/v1-lite-text-to-video",
		"hailuo/2-3-image-to-video-pro",
		"hailuo/2-3-image-to-video-standard",
		"hailuo/02-text-to-video-pro",
		"hailuo/02-image-to-video-pro",
		"hailuo/02-text-to-video-standard",
		"hailuo/02-image-to-video-standard",
		"wan/2-2-a14b-image-to-video-turbo",
		"wan/2-2-a14b-speech-to-video-turbo",
		"wan/2-2-a14b-text-to-video-turbo",
		"wan/2-2-animate-move",
		"wan/2-2-animate-replace",
		"wan/2-6-image-to-video",
		"wan/2-6-text-to-video",
		"wan/2-6-video-to-video",
		"wan/2-6-flash-image-to-video",
		"wan/2-6-flash-video-to-video",
		"wan/2-5-image-to-video",
		"wan/2-5-text-to-video",
		"wan/2-7-text-to-video",
		"wan/2-7-image-to-video",
		"wan/2-7-videoedit",
		"wan/2-7-r2v",
		"topaz/video-upscale",
		"infinitalk/from-audio",
		"happyhorse/text-to-video",
		"happyhorse/image-to-video",
		"happyhorse/reference-to-video",
		"happyhorse/video-edit",
		"happyhorse-1-1/text-to-video",
		"happyhorse-1-1/image-to-video",
		"happyhorse-1-1/reference-to-video",
		"happyhorse-1-1/text-to-video",
		"happyhorse-1-1/image-to-video",
		"happyhorse-1-1/reference-to-video",
		"gemini-omni-video",
	}
}

func testAdminChannelModel(channel model.ModelChannel, modelName string) (string, error) {
	if strings.TrimSpace(modelName) == "" {
		return "", errors.New("缺少模型名称")
	}
	if strings.EqualFold(strings.TrimSpace(modelName), "glm-tts") {
		return testGLMTTSChannelModel(channel, modelName)
	}
	if IsMiMoTTSModelName(modelName) {
		return testMiMoTTSChannelModel(channel, modelName)
	}
	if IsGeminiChannel(channel) {
		return testGeminiChannelModel(channel, modelName)
	}
	body, _ := json.Marshal(map[string]any{
		"model": modelName,
		"messages": []map[string]string{{
			"role":    "user",
			"content": "hi",
		}},
	})
	request, err := http.NewRequest(http.MethodPost, BuildModelChannelURL(channel, "/chat/completions"), strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := adminModelHTTPClient.Do(request)
	if err != nil {
		return "", safeMessageError{message: "测试失败：上游接口无响应或网络不可达"}
	}
	defer response.Body.Close()
	responseBody, readErr := readLimitedModelTestResponse(response.Body)
	if readErr != nil {
		return "", readErr
	}
	if response.StatusCode >= http.StatusBadRequest {
		return "", readAdminChannelError(responseBody, response.StatusCode, "测试失败")
	}
	var payload struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	_ = json.Unmarshal(responseBody, &payload)
	if len(payload.Choices) > 0 && strings.TrimSpace(payload.Choices[0].Message.Content) != "" {
		return payload.Choices[0].Message.Content, nil
	}
	return "ok", nil
}

func fetchGeminiAdminChannelModels(channel model.ModelChannel, budget *upstreamReadBudget) ([]string, error) {
	result := []string{}
	pageToken := ""
	seenPageTokens := map[string]bool{}
	for {
		if err := budget.Check(); err != nil {
			return nil, err
		}
		path := "/v1beta/models"
		if pageToken != "" {
			path += "?pageToken=" + url.QueryEscape(pageToken)
		}
		request, err := http.NewRequest(http.MethodGet, BuildGeminiChannelURL(channel, path), nil)
		if err != nil {
			return nil, err
		}
		request = request.WithContext(budget.Context())
		SetModelChannelAuthHeader(request, channel)
		client := adminModelHTTPClient
		if channel.Restricted {
			client = HTTPClientForChannel(channel)
		}
		client = budget.HTTPClient(client)
		response, err := client.Do(request)
		if err != nil {
			err = normalizeUpstreamBudgetError(err)
			if isUpstreamBudgetError(err) {
				return nil, err
			}
			return nil, safeMessageError{message: "读取模型失败：上游接口无响应或网络不可达"}
		}
		body, readErr := readLimitedProviderResponse(response.Body)
		response.Body.Close()
		if readErr != nil {
			return nil, normalizeUpstreamBudgetError(readErr)
		}
		if response.StatusCode >= http.StatusBadRequest {
			return nil, readAdminChannelError(body, response.StatusCode, "读取模型失败")
		}
		var payload struct {
			Models []struct {
				Name                       string   `json:"name"`
				SupportedGenerationMethods []string `json:"supportedGenerationMethods"`
			} `json:"models"`
			NextPageToken string `json:"nextPageToken"`
		}
		if json.Unmarshal(body, &payload) != nil {
			return nil, safeMessageError{message: "读取模型失败：上游响应无法解析"}
		}
		for _, item := range payload.Models {
			name := strings.TrimPrefix(strings.TrimSpace(item.Name), "models/")
			methods := strings.Join(item.SupportedGenerationMethods, ",")
			if name != "" && !strings.Contains(strings.ToLower(name), "embed") && (strings.Contains(methods, "generateContent") || strings.Contains(methods, "predictLongRunning") || strings.HasPrefix(strings.ToLower(name), "veo-") || strings.HasPrefix(strings.ToLower(name), "imagen-")) {
				result = append(result, name)
			}
		}
		pageToken = strings.TrimSpace(payload.NextPageToken)
		if pageToken == "" {
			break
		}
		if seenPageTokens[pageToken] {
			return nil, safeMessageError{message: "读取模型失败：上游分页标记重复"}
		}
		seenPageTokens[pageToken] = true
	}
	seen := map[string]bool{}
	unique := result[:0]
	for _, name := range result {
		if !seen[name] {
			seen[name] = true
			unique = append(unique, name)
		}
	}
	result = unique
	sort.Strings(result)
	if len(result) == 0 {
		return nil, safeMessageError{message: "Gemini 模型列表为空"}
	}
	return result, nil
}

func readLimitedProviderResponse(reader io.Reader) ([]byte, error) {
	const limit = 8 * 1024 * 1024
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if len(body) > limit {
		return nil, safeMessageError{message: "读取模型失败：上游响应超过 8 MiB 限制"}
	}
	return body, nil
}

func readLimitedModelTestResponse(reader io.Reader) ([]byte, error) {
	const limit = 16 * 1024 * 1024
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if len(body) > limit {
		return nil, safeMessageError{message: "测试失败：上游响应超过 16 MiB 限制"}
	}
	return body, nil
}

func testGeminiChannelModel(channel model.ModelChannel, modelName string) (string, error) {
	lowerModel := strings.ToLower(strings.TrimSpace(modelName))
	if strings.HasPrefix(lowerModel, "veo-") || strings.Contains(lowerModel, "image") || strings.Contains(lowerModel, "tts") {
		return "模型列表与渠道配置有效；图片、视频和语音模型未执行付费生成测试。", nil
	}
	body := GeminiTextRequestBody(modelName, "hi")
	body, _ = StripGeminiModelField(body, "application/json")
	request, err := http.NewRequest(http.MethodPost, BuildGeminiChannelURL(channel, GeminiModelActionPath(modelName, "generateContent")), strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	SetModelChannelAuthHeader(request, channel)
	request.Header.Set("Content-Type", "application/json")
	response, err := adminModelHTTPClient.Do(request)
	if err != nil {
		return "", safeMessageError{message: "测试失败：上游接口无响应或网络不可达"}
	}
	defer response.Body.Close()
	responseBody, readErr := readLimitedModelTestResponse(response.Body)
	if readErr != nil {
		return "", readErr
	}
	if response.StatusCode >= http.StatusBadRequest {
		return "", readAdminChannelError(responseBody, response.StatusCode, "测试失败")
	}
	if text := GeminiResponseText(responseBody); text != "" {
		return text, nil
	}
	return "ok", nil
}

func testGLMTTSChannelModel(channel model.ModelChannel, modelName string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model":           modelName,
		"input":           "你好，这是语音模型测试。",
		"voice":           "tongtong",
		"response_format": "wav",
		"speed":           1,
	})
	request, err := http.NewRequest(http.MethodPost, BuildModelChannelURL(channel, "/audio/speech"), strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := adminModelHTTPClient.Do(request)
	if err != nil {
		return "", safeMessageError{message: "测试失败：上游接口无响应或网络不可达"}
	}
	defer response.Body.Close()
	responseBody, readErr := readLimitedModelTestResponse(response.Body)
	if readErr != nil {
		return "", readErr
	}
	if response.StatusCode >= http.StatusBadRequest {
		return "", readAdminChannelError(responseBody, response.StatusCode, "测试失败")
	}
	if len(responseBody) == 0 {
		return "", safeMessageError{message: "测试失败：GLM-TTS 未返回音频数据"}
	}
	return "ok", nil
}

func testMiMoTTSChannelModel(channel model.ModelChannel, modelName string) (string, error) {
	if strings.EqualFold(strings.TrimSpace(modelName), "mimo-v2.5-tts-voiceclone") {
		return "MiMo VoiceClone 需要画布连接 MP3/WAV 参考音频，后台不发送克隆样本，因此未执行上游生成测试。", nil
	}
	messages := []map[string]string{{"role": "assistant", "content": "你好，这是语音模型测试。"}}
	audio := map[string]any{"format": "wav"}
	if strings.EqualFold(strings.TrimSpace(modelName), "mimo-v2.5-tts-voicedesign") {
		messages = append([]map[string]string{{"role": "user", "content": "自然清晰的年轻女声"}}, messages...)
	} else {
		audio["voice"] = "冰糖"
	}
	body, _ := json.Marshal(map[string]any{"model": modelName, "messages": messages, "audio": audio})
	request, err := http.NewRequest(http.MethodPost, BuildModelChannelURL(channel, "/chat/completions"), strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := adminModelHTTPClient.Do(request)
	if err != nil {
		return "", safeMessageError{message: "测试失败：上游接口无响应或网络不可达"}
	}
	defer response.Body.Close()
	responseBody, readErr := readLimitedModelTestResponse(response.Body)
	if readErr != nil {
		return "", readErr
	}
	if response.StatusCode >= http.StatusBadRequest {
		return "", readAdminChannelError(responseBody, response.StatusCode, "测试失败")
	}
	var payload struct {
		Choices []struct {
			Message struct {
				Audio *struct {
					Data string `json:"data"`
				} `json:"audio"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(responseBody, &payload) != nil || len(payload.Choices) == 0 || payload.Choices[0].Message.Audio == nil || strings.TrimSpace(payload.Choices[0].Message.Audio.Data) == "" {
		return "", safeMessageError{message: "测试失败：MiMo TTS 未返回音频数据"}
	}
	return "ok", nil
}

func testArkSeedanceChannelModel(channel model.ModelChannel, modelName string) (string, error) {
	if strings.TrimSpace(modelName) == "" {
		return "", errors.New("缺少模型名称")
	}
	if strings.TrimSpace(channel.BaseURL) == "" {
		return "", safeMessageError{message: "缺少接口地址"}
	}
	if strings.TrimSpace(channel.APIKey) == "" {
		return "", safeMessageError{message: "缺少 API Key"}
	}
	if !isArkAgentPlanChannel(channel) {
		return "Seedance 视频模型不会发送 /chat/completions 文本测试。已检查 Base URL、API Key 和模型名非空；未调用视频生成接口，因此未验证套餐额度或模型权限。", nil
	}
	return "Agent Plan / Seedance 视频模型配置格式已通过。后台测试不会调用视频生成接口，因此未验证 API Key、套餐额度或模型权限；请在画布中使用视频生成验证。", nil
}

func readAdminChannelError(body []byte, statusCode int, fallback string) error {
	var payload struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Msg string `json:"msg"`
	}
	if len(body) > 0 && json.Unmarshal(body, &payload) == nil {
		if payload.Error != nil && strings.TrimSpace(payload.Error.Message) != "" {
			return safeMessageError{message: payload.Error.Message}
		}
		if strings.TrimSpace(payload.Msg) != "" {
			return safeMessageError{message: payload.Msg}
		}
	}
	if statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden {
		return safeMessageError{message: fmt.Sprintf("上游接口鉴权失败（%d），请检查 API Key、套餐权限或模型权限", statusCode)}
	}
	if statusCode == http.StatusTooManyRequests {
		return safeMessageError{message: "上游接口限流或额度不足（429），请稍后重试或检查额度"}
	}
	if statusCode > 0 {
		return safeMessageError{message: fmt.Sprintf("%s：%d", fallback, statusCode)}
	}
	return safeMessageError{message: fallback}
}

type safeMessageError struct {
	message string
}

func (err safeMessageError) Error() string {
	return err.message
}

func (err safeMessageError) SafeMessage() string {
	return err.message
}

func keepPrivateStorageSecrets(settings *model.Settings, saved model.Settings) {
	for i := range settings.Private.Storage.Providers {
		current := &settings.Private.Storage.Providers[i]
		if strings.TrimSpace(current.SecretAccessKey) != "" && strings.TrimSpace(current.Password) != "" {
			continue
		}
		if provider, ok := findSavedStorageProvider(*current, saved.Private.Storage.Providers, i); ok {
			if strings.TrimSpace(current.SecretAccessKey) == "" {
				current.SecretAccessKey = provider.SecretAccessKey
			}
			if strings.TrimSpace(current.Password) == "" {
				current.Password = provider.Password
			}
		}
	}
}

func findSavedStorageProvider(provider model.StorageProvider, saved []model.StorageProvider, index int) (model.StorageProvider, bool) {
	for _, item := range saved {
		if provider.ID != "" && item.ID == provider.ID {
			return item, true
		}
		if item.Type == provider.Type && item.Name == provider.Name && item.Endpoint == provider.Endpoint && item.Bucket == provider.Bucket && (provider.Type != model.StorageProviderTypeWebDAV || item.PathPrefix == provider.PathPrefix) {
			return item, true
		}
	}
	if index >= 0 && index < len(saved) && saved[index].Type == provider.Type {
		return saved[index], true
	}
	return model.StorageProvider{}, false
}

func validateEnabledStorageProviderTypes(providers []model.StorageProvider) error {
	enabledType := ""
	for _, provider := range providers {
		if provider.Type != model.StorageProviderTypeS3 && provider.Type != model.StorageProviderTypeWebDAV {
			return safeMessageError{message: "存储类型不支持"}
		}
		if !provider.Enabled {
			continue
		}
		if enabledType == "" {
			enabledType = provider.Type
			continue
		}
		if enabledType != provider.Type {
			return safeMessageError{message: "S3/R2 与 WebDAV 不能同时启用"}
		}
	}
	return nil
}

func normalizePrivateStorageSetting(setting model.PrivateStorageSetting) model.PrivateStorageSetting {
	if setting.Mode == "" {
		setting.Mode = "local_indexeddb"
		setting.AllowUserGlobalProvider = true
	}
	if setting.CapacityLimitBytes <= 0 {
		setting.CapacityLimitBytes = 9 * 1024 * 1024 * 1024
	}
	setting.CapacityCheck = normalizeStorageCapacityCheckSetting(setting.CapacityCheck)
	if setting.Providers == nil {
		setting.Providers = []model.StorageProvider{}
	}
	for i := range setting.Providers {
		setting.Providers[i] = normalizeStorageProvider(setting.Providers[i])
	}
	return setting
}

func normalizeStorageCapacityCheckSetting(setting model.StorageCapacityCheckSetting) model.StorageCapacityCheckSetting {
	if setting.Cron == "" {
		setting.Cron = "0 */6 * * *"
	}
	if setting.Enabled == nil {
		enabled := false
		setting.Enabled = &enabled
	}
	return setting
}

func normalizeStorageProvider(provider model.StorageProvider) model.StorageProvider {
	provider.Name = strings.TrimSpace(provider.Name)
	provider.Type = strings.ToLower(strings.TrimSpace(provider.Type))
	if provider.Type == "" {
		provider.Type = model.StorageProviderTypeS3
	}
	provider.Endpoint = strings.TrimRight(strings.TrimSpace(provider.Endpoint), "/")
	provider.Bucket = strings.TrimSpace(provider.Bucket)
	provider.AccessKeyID = strings.TrimSpace(provider.AccessKeyID)
	if provider.Type == model.StorageProviderTypeWebDAV {
		provider.PathPrefix = strings.Trim(strings.TrimSpace(provider.PathPrefix), "/")
		if provider.PathPrefix == "" {
			provider.PathPrefix = "canvas"
		}
	}
	provider.Username = strings.TrimSpace(provider.Username)
	if provider.Type == model.StorageProviderTypeS3 && provider.Region == "" {
		provider.Region = "auto"
	}
	if provider.ID == "" {
		provider.ID = stableStorageProviderID(provider)
	}
	if provider.Weight <= 0 {
		provider.Weight = 1
	}
	return provider
}

func stableStorageProviderID(provider model.StorageProvider) string {
	webDAVPath := ""
	if provider.Type == model.StorageProviderTypeWebDAV {
		webDAVPath = provider.PathPrefix
	}
	return "storage-" + providerSecureHash([]string{provider.OwnerUserID, provider.Type, provider.Name, provider.Endpoint, provider.Bucket, webDAVPath})
}

func stableModelChannelID(channel model.ModelChannel) string {
	return "channel-" + providerSecureHash([]string{channel.Name, channel.BaseURL})
}

func providerSecureHash(parts []string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return hex.EncodeToString(sum[:])[:16]
}

func modelChannelsForModel(channels []model.ModelChannel, modelName string) []model.ModelChannel {
	result := []model.ModelChannel{}
	for _, channel := range channels {
		if !channel.Enabled || channel.BaseURL == "" || channel.APIKey == "" {
			continue
		}
		for _, item := range channel.Models {
			if strings.TrimSpace(item) == modelName {
				result = append(result, channel)
				break
			}
		}
	}
	return result
}

func publicChannelInfos(channels []model.ModelChannel) []model.PublicModelChannelInfo {
	result := []model.PublicModelChannelInfo{}
	for _, channel := range channels {
		if !channel.Enabled || channel.BaseURL == "" || len(channel.Models) == 0 {
			continue
		}
		result = append(result, model.PublicModelChannelInfo{
			ID:       channel.ID,
			Protocol: channel.Protocol,
			Name:     channel.Name,
			BaseURL:  channel.BaseURL,
			Models:   append([]string{}, channel.Models...),
			Weight:   channel.Weight,
			Timeout:  channel.Timeout,
			Enabled:  channel.Enabled,
			Remark:   channel.Remark,
		})
	}
	return result
}

func collectChannelModels(channels []model.ModelChannel) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, channel := range channels {
		if !channel.Enabled || channel.BaseURL == "" {
			continue
		}
		for _, item := range channel.Models {
			modelName := strings.TrimSpace(item)
			if modelName == "" || seen[modelName] {
				continue
			}
			seen[modelName] = true
			result = append(result, modelName)
		}
	}
	sort.Strings(result)
	return result
}
