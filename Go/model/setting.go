package model

import "encoding/json"

type SettingKey string

const (
	SettingKeyPublic  SettingKey = "public"
	SettingKeyPrivate SettingKey = "private"
)

// ModelChannel 模型渠道配置。
type ModelChannel struct {
	ID       string   `json:"id"`
	Protocol string   `json:"protocol"`
	Name     string   `json:"name"`
	BaseURL  string   `json:"baseUrl"`
	APIKey   string   `json:"apiKey"`
	Models   []string `json:"models"`
	Weight   int      `json:"weight"`
	Timeout  int      `json:"timeout"`
	Enabled  bool     `json:"enabled"`
	Remark   string   `json:"remark"`
	ApiMode  string   `json:"apiMode"` // 生图接口模式：images（默认）/ responses
}

// ModelCost 模型算力点配置。
type ModelCost struct {
	Model   string `json:"model"`
	Credits int    `json:"credits"`
}

// ModelInfo 模型展示信息（下拉框副标题，hover 时显示）。
type ModelInfo struct {
	Model       string `json:"model"`
	Description string `json:"description,omitempty"`
}

// ModelCapability 模型能力配置。
// 空字段语义：ImageAspects 空=支持全部标准比例；ImageTiers 空=仅标准档；
// VideoResolutions 空=480p/720p/1080p 三档。
// VideoSecondsMin/Max 空=默认 4-20 秒。
// VideoPanelType 空=通用面板；kling-v26/kling-v3/seedance/grok/motion-control/agnes。
// VideoProvider 空=不区分；apimart/kie（仅 kling-v3/motion-control 需要区分请求体格式）。
type ModelCapability struct {
	Model            string   `json:"model"`
	ImageAspects     []string `json:"imageAspects,omitempty"`
	ImageTiers       []string `json:"imageTiers,omitempty"`
	VideoResolutions []string `json:"videoResolutions,omitempty"`
	VideoSecondsMin  *int     `json:"videoSecondsMin,omitempty"`
	VideoSecondsMax  *int     `json:"videoSecondsMax,omitempty"`

	// 视频面板类型与厂商，替代前端按模型名+渠道硬编码判断面板和请求体格式。
	VideoPanelType string `json:"videoPanelType,omitempty"`
	VideoProvider  string `json:"videoProvider,omitempty"`

	// 视频模式选项（Kling std/pro/4k、Grok fun/normal/spicy）。空=不支持模式选择。
	VideoModes []VideoModeOption `json:"videoModes,omitempty"`

	// 视频比例选项（如 16:9/9:16/1:1/adaptive）。空=通用面板走默认 sizeOptions。
	VideoRatios []string `json:"videoRatios,omitempty"`

	// 秒数预设档位（如 [5,10]）。空=连续 Slider；有值=按档位显示 OptionPill。
	VideoSecondsPresets []int `json:"videoSecondsPresets,omitempty"`

	// 是否支持 -1 智能时长（Seedance）。
	VideoSecondsSmart bool `json:"videoSecondsSmart,omitempty"`

	// 能力开关，控制 UI 功能显隐和请求体字段。
	SupportsNegativePrompt  bool `json:"supportsNegativePrompt,omitempty"`
	SupportsFirstLastFrame  bool `json:"supportsFirstLastFrame,omitempty"` // 兼容字段：首尾帧都支持时勾选；仅首帧用 SupportsFirstFrame
	SupportsFirstFrame      bool `json:"supportsFirstFrame,omitempty"`     // 仅支持首帧（部分模型如 minimax-hailuo-2-3、kling-3-0-turbo）
	SupportsMotionControl   bool `json:"supportsMotionControl,omitempty"`
	SupportsAudioGeneration bool `json:"supportsAudioGeneration,omitempty"`
	SupportsWatermark       bool `json:"supportsWatermark,omitempty"`
	SupportsMultiShot       bool `json:"supportsMultiShot,omitempty"`
	SupportsElementList     bool `json:"supportsElementList,omitempty"`

	// 音频生成限制：AudioRequiresMode 如 "pro" 表示仅该模式可用；AudioMaxReferences 如 1。
	AudioRequiresMode  string `json:"audioRequiresMode,omitempty"`
	AudioMaxReferences int    `json:"audioMaxReferences,omitempty"`

	// 参考素材数量上限（Seedance 等）。0=走前端默认硬编码（图片 9/视频 3/音频 3）。
	MaxImageReferences int `json:"maxImageReferences,omitempty"`
	MaxVideoReferences int `json:"maxVideoReferences,omitempty"`
	MaxAudioReferences int `json:"maxAudioReferences,omitempty"`
}

// VideoModeOption 视频模式选项。
type VideoModeOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
	Desc  string `json:"desc,omitempty"`
}

// PublicModelChannelSetting 公开模型渠道配置。
type PublicModelChannelSetting struct {
	AvailableModels        []string                 `json:"availableModels"`
	ModelCosts             []ModelCost              `json:"modelCosts"`
	ModelCapabilities      []ModelCapability        `json:"modelCapabilities"`
	ModelInfos             []ModelInfo              `json:"modelInfos"`
	Channels               []PublicModelChannelInfo `json:"channels"`
	DefaultImageModel      string                   `json:"defaultImageModel"`
	DefaultVideoModel      string                   `json:"defaultVideoModel"`
	DefaultTextModel       string                   `json:"defaultTextModel"`
	DefaultAudioModel      string                   `json:"defaultAudioModel"`
	SystemPrompt           string                   `json:"systemPrompt"`
	SystemPrompts          SystemPromptSetting      `json:"systemPrompts"`
	AllowCustomChannel     *bool                    `json:"allowCustomChannel"`
	AllowUserRemoteChannel *bool                    `json:"allowUserRemoteChannel"`
	AllowGuestConfig       *bool                    `json:"allowGuestConfig"`
}

type SystemPromptSetting struct {
	Image         string `json:"image"`
	Video         string `json:"video"`
	Text          string `json:"text"`
	Workflow      string `json:"workflow"`
	WorkflowAgent string `json:"workflowAgent"`
}

type PublicModelChannelInfo struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	BaseURL string   `json:"baseUrl"`
	Models  []string `json:"models"`
	Weight  int      `json:"weight"`
	Timeout int      `json:"timeout"`
	Enabled bool     `json:"enabled"`
	Remark  string   `json:"remark"`
	ApiMode string   `json:"apiMode"` // 生图接口模式：images（默认）/ responses
}

// PublicSetting 公开配置。
type PublicSetting struct {
	ModelChannel PublicModelChannelSetting `json:"modelChannel"`
	Auth         PublicAuthSetting         `json:"auth"`
	Storage      PublicStorageSetting      `json:"storage"`
}

type PublicStorageSetting struct {
	Mode                    string `json:"mode"`
	AllowUserProvider       bool   `json:"allowUserProvider"`
	AllowUserGlobalProvider bool   `json:"allowUserGlobalProvider"`
}

type PublicAuthSetting struct {
	AllowRegister *bool `json:"allowRegister"`
}

// PrivateSetting 私有配置。
type PrivateSetting struct {
	Channels   []ModelChannel        `json:"channels"`
	PromptSync PromptSyncSetting     `json:"promptSync"`
	AILog      AILogSetting          `json:"aiLog"`
	Auth       PrivateAuthSetting    `json:"auth"`
	Storage    PrivateStorageSetting `json:"storage"`
}

type AILogSetting struct {
	LocalDirectReportEnabled *bool               `json:"localDirectReportEnabled"`
	Cleanup                  AILogCleanupSetting `json:"cleanup"`
}

type AILogCleanupSetting struct {
	Enabled       *bool  `json:"enabled"`
	RetentionDays int    `json:"retentionDays"`
	Cron          string `json:"cron"`
}

type PrivateStorageSetting struct {
	Mode                    string                      `json:"mode"`
	AllowUserProvider       bool                        `json:"allowUserProvider"`
	AllowUserGlobalProvider bool                        `json:"allowUserGlobalProvider"`
	Providers               []StorageProvider           `json:"providers"`
	RoundRobinCursor        int                         `json:"roundRobinCursor"`
	CapacityCheck           StorageCapacityCheckSetting `json:"capacityCheck"`
	CapacityLimitBytes      int64                       `json:"capacityLimitBytes"`
}

type StorageProvider struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Type              string `json:"type"`
	Endpoint          string `json:"endpoint"`
	Region            string `json:"region"`
	Bucket            string `json:"bucket"`
	AccessKeyID       string `json:"accessKeyId"`
	SecretAccessKey   string `json:"secretAccessKey"`
	PublicBaseURL     string `json:"publicBaseUrl"`
	PathPrefix        string `json:"pathPrefix"`
	Weight            int    `json:"weight"`
	Enabled           bool   `json:"enabled"`
	OwnerUserID       string `json:"ownerUserId"`
	CapacityBytes     int64  `json:"capacityBytes"`
	CapacityCheckedAt string `json:"capacityCheckedAt"`
	CapacityExceeded  bool   `json:"capacityExceeded"`
}

type StorageCapacityCheckSetting struct {
	Enabled *bool  `json:"enabled"`
	Cron    string `json:"cron"`
}

// PromptSyncSetting 提示词定时同步配置。
type PromptSyncSetting struct {
	Enabled *bool  `json:"enabled"`
	Cron    string `json:"cron"`
}

type PrivateAuthSetting struct {
}

// Setting 系统配置。
type Setting struct {
	Key       SettingKey      `json:"key" gorm:"primaryKey"`
	Value     json.RawMessage `json:"value" gorm:"serializer:json"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
}

// Settings 系统公开和私有配置。
type Settings struct {
	Public  PublicSetting  `json:"public"`
	Private PrivateSetting `json:"private"`
}
