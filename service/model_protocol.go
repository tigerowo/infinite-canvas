package service

import (
	"net/http"
	"sort"
	"strings"

	"github.com/tigerowo/infinite-canvas/extensions/newapi"
	"github.com/tigerowo/infinite-canvas/model"
)

const (
	ModelChannelProtocolNewAPI   = newapi.Protocol
	ModelChannelProtocolOpenAI   = "openai"
	ModelChannelProtocolGrok2API = "grok2api"
	ModelChannelProtocolAPIMart  = "apimart"
	ModelChannelProtocolKIE      = "kie"
	ModelChannelProtocol88API    = "88api"
)

type modelProtocolAdapter struct {
	buildURL  func(model.ModelChannel, string) string
	setAuth   func(*http.Request, model.ModelChannel)
	models    func(model.ModelChannel) ([]string, error)
	testModel func(model.ModelChannel, string) (string, error)
}

type modelProtocolRule struct {
	id      string
	matches func(model.ModelChannel, string) bool
}

var modelProtocolRegistry map[string]modelProtocolAdapter
var modelProtocolIDs = []string{ModelChannelProtocolOpenAI, ModelChannelProtocolGemini, ModelChannelProtocolGrok2API, ModelChannelProtocolMiniMax, ModelChannelProtocolAPIMart, ModelChannelProtocolKIE, ModelChannelProtocolMiMo, ModelChannelProtocol88API}

func init() {
	modelProtocolIDs = append(modelProtocolIDs, ModelChannelProtocolNewAPI)
	compatible := modelProtocolAdapter{
		buildURL: buildOpenAIModelChannelURL,
		setAuth: func(request *http.Request, channel model.ModelChannel) {
			request.Header.Set("Authorization", "Bearer "+channel.APIKey)
		},
		models:    fetchOpenAIAdminChannelModels,
		testModel: testOpenAIChannelModel,
	}
	modelProtocolRegistry = make(map[string]modelProtocolAdapter, 10)
	for _, id := range modelProtocolIDs {
		modelProtocolRegistry[id] = compatible
	}
	gemini := compatible
	gemini.buildURL = BuildGeminiChannelURL
	gemini.setAuth = func(request *http.Request, channel model.ModelChannel) {
		request.Header.Set("x-goog-api-key", channel.APIKey)
	}
	gemini.models = fetchGeminiAdminChannelModels
	gemini.testModel = testGeminiChannelModel
	modelProtocolRegistry[ModelChannelProtocolGemini] = gemini

	minimax := compatible
	minimax.buildURL = func(channel model.ModelChannel, path string) string {
		return normalizeModelChannelBaseURL(channel.BaseURL) + path
	}
	minimax.models = func(model.ModelChannel) ([]string, error) { return MiniMaxModels(), nil }
	minimax.testModel = func(model.ModelChannel, string) (string, error) {
		return "MiniMax-H3 是异步视频模型，请在视频创作台测试生成。", nil
	}
	modelProtocolRegistry[ModelChannelProtocolMiniMax] = minimax

	mimo := compatible
	mimo.models = func(model.ModelChannel) ([]string, error) {
		result := MiMoModels()
		sort.Strings(result)
		return result, nil
	}
	mimo.testModel = testMiMoTTSChannelModel
	modelProtocolRegistry[ModelChannelProtocolMiMo] = mimo

	kie := compatible
	kie.models = func(model.ModelChannel) ([]string, error) {
		result := kieMarketModels()
		sort.Strings(result)
		return result, nil
	}
	modelProtocolRegistry[ModelChannelProtocolKIE] = kie

	api88 := compatible
	api88.testModel = func(model.ModelChannel, string) (string, error) {
		return "88API 渠道不会调用聊天接口测试，请在对应创作台验证模型。", nil
	}
	modelProtocolRegistry[ModelChannelProtocol88API] = api88
	ark := compatible
	ark.testModel = testArkSeedanceChannelModel
	modelProtocolRegistry["model:ark-seedance"] = ark
	glm := compatible
	glm.testModel = testGLMTTSChannelModel
	modelProtocolRegistry["model:glm-tts"] = glm
}

// 发现模型、配置测试与生成的命中规则不同，分别保留原有优先级。
var modelDiscoveryRules = []modelProtocolRule{
	{ModelChannelProtocolGemini, func(channel model.ModelChannel, _ string) bool { return IsGeminiChannel(channel) }},
	{ModelChannelProtocolMiniMax, func(channel model.ModelChannel, _ string) bool { return IsMiniMaxChannel(channel) }},
	{ModelChannelProtocolMiMo, func(channel model.ModelChannel, _ string) bool { return IsMiMoChannel(channel) }},
	{ModelChannelProtocolKIE, func(channel model.ModelChannel, _ string) bool { return isKIEAdminChannel(channel) }},
}

var modelConfigTestRules = []modelProtocolRule{
	{ModelChannelProtocolMiniMax, func(channel model.ModelChannel, _ string) bool { return IsMiniMaxChannel(channel) }},
	{ModelChannelProtocol88API, func(channel model.ModelChannel, _ string) bool {
		return strings.EqualFold(strings.TrimSpace(channel.Protocol), ModelChannelProtocol88API)
	}},
	{"model:ark-seedance", func(channel model.ModelChannel, modelName string) bool {
		return isArkAgentPlanChannel(channel) || isSeedanceModelName(modelName)
	}},
}

var modelGenerationTestRules = []modelProtocolRule{
	{"model:glm-tts", func(_ model.ModelChannel, modelName string) bool {
		return strings.EqualFold(strings.TrimSpace(modelName), "glm-tts")
	}},
	{ModelChannelProtocolMiMo, func(_ model.ModelChannel, modelName string) bool { return IsMiMoTTSModelName(modelName) }},
	{ModelChannelProtocolGemini, func(channel model.ModelChannel, _ string) bool { return IsGeminiChannel(channel) }},
}

func modelProtocolForChannel(channel model.ModelChannel) modelProtocolAdapter {
	protocol := strings.TrimSpace(channel.Protocol)
	if adapter, ok := modelProtocolRegistry[protocol]; ok {
		return adapter
	}
	for _, id := range modelProtocolIDs {
		if strings.EqualFold(protocol, id) {
			return modelProtocolRegistry[id]
		}
	}
	return modelProtocolRegistry[ModelChannelProtocolOpenAI]
}

func matchModelProtocol(rules []modelProtocolRule, channel model.ModelChannel, modelName string) (modelProtocolAdapter, bool) {
	if IsNewAPIChannel(channel) {
		return modelProtocolRegistry[ModelChannelProtocolNewAPI], true
	}
	for _, rule := range rules {
		if rule.matches(channel, modelName) {
			return modelProtocolRegistry[rule.id], true
		}
	}
	return modelProtocolRegistry[ModelChannelProtocolOpenAI], false
}

func IsNewAPIChannel(channel model.ModelChannel) bool {
	return newapi.IsProtocol(channel.Protocol)
}
