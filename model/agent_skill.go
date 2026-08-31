package model

const (
	AgentSkillSourceSystem = "system"
	AgentSkillSourceUser   = "user"
)

// AgentSkill 可由用户主动选择的 Agent 工作流说明。
type AgentSkill struct {
	ID              string `json:"id" gorm:"primaryKey"`
	OwnerUserID     string `json:"ownerUserId" gorm:"index"`
	Source          string `json:"source" gorm:"index"`
	Name            string `json:"name"`
	Description     string `json:"description"`
	CoverURL        string `json:"coverUrl" gorm:"type:text"`
	CoverStorageKey string `json:"coverStorageKey"`
	Content         string `json:"content"`
	Enabled         bool   `json:"enabled" gorm:"index"`
	Sort            int    `json:"sort"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
	HasFiles        bool             `json:"hasFiles" gorm:"-"`
	Files           []AgentSkillFile `json:"files,omitempty" gorm:"-"`
}
