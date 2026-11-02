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
	Name            string `json:"name" gorm:"size:191"`
	Description     string `json:"description"`
	CoverURL        string `json:"coverUrl" gorm:"type:text"`
	CoverStorageKey string `json:"coverStorageKey" gorm:"size:1024"`
	Content         string `json:"content"`
	Enabled         bool   `json:"enabled" gorm:"index"`
	Sort            int    `json:"sort"`
	CreatedAt       string `json:"createdAt" gorm:"size:64"`
	UpdatedAt       string `json:"updatedAt" gorm:"size:64"`
	HasFiles        bool             `json:"hasFiles" gorm:"-"`
	Files           []AgentSkillFile `json:"files,omitempty" gorm:"-"`
}
