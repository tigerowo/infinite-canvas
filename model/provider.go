package model

type ProviderKind string

const (
	ProviderKindAPI ProviderKind = "api"
	ProviderKindCLI ProviderKind = "cli"
)

type ProviderStatus string

const (
	ProviderStatusUntested    ProviderStatus = "untested"
	ProviderStatusConnected   ProviderStatus = "connected"
	ProviderStatusFailed      ProviderStatus = "failed"
	ProviderStatusTimeout     ProviderStatus = "timeout"
	ProviderStatusDisabled    ProviderStatus = "disabled"
	ProviderStatusUnavailable ProviderStatus = "unavailable"
)

// Provider 保存用户连接中心中的 API 或 CLI 渠道。
// CredentialsCiphertext 只保存加密后的 API Key 与自定义请求头，永不通过 JSON 返回。
type Provider struct {
	ID                    string         `json:"id" gorm:"primaryKey"`
	OwnerUserID           string         `json:"ownerUserId" gorm:"index:idx_providers_owner_kind_sort,priority:1"`
	Kind                  ProviderKind   `json:"kind" gorm:"index:idx_providers_owner_kind_sort,priority:2"`
	Protocol              string         `json:"protocol"`
	Name                  string         `json:"name"`
	BaseURL               string         `json:"baseUrl"`
	CredentialsCiphertext string         `json:"-" gorm:"type:text"`
	Capabilities          []string       `json:"capabilities" gorm:"serializer:json;type:text"`
	Models                []string       `json:"models" gorm:"serializer:json;type:text"`
	VerifiedModels        []string       `json:"verifiedModels" gorm:"serializer:json;type:text"`
	DefaultModel          string         `json:"defaultModel"`
	Timeout               int            `json:"timeout"`
	Enabled               bool           `json:"enabled"`
	IsDefault             bool           `json:"isDefault"`
	SortOrder             int            `json:"sortOrder" gorm:"index:idx_providers_owner_kind_sort,priority:3"`
	ConnectionStatus      ProviderStatus `json:"connectionStatus"`
	StatusMessage         string         `json:"statusMessage" gorm:"type:text"`
	LastCheckedAt         string         `json:"lastCheckedAt"`
	Executable            string         `json:"executable"`
	WorkingDirectory      string         `json:"workingDirectory"`
	Version               string         `json:"version"`
	CreatedAt             string         `json:"createdAt"`
	UpdatedAt             string         `json:"updatedAt"`
}
