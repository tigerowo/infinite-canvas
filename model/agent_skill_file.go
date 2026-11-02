package model

const (
	AgentSkillFileKindFolder = "folder"
	AgentSkillFileKindFile   = "file"
)

// AgentSkillFile 保存系统 Skill 的附属目录和文本文件；根 SKILL.md 继续使用 AgentSkill.Content。
type AgentSkillFile struct {
	SkillID   string `json:"-" gorm:"primaryKey"`
	Path      string `json:"path" gorm:"primaryKey"`
	Kind      string `json:"kind" gorm:"size:16"`
	Content   string `json:"content"`
	Sort      int    `json:"sort"`
	CreatedAt string `json:"createdAt" gorm:"size:64"`
	UpdatedAt string `json:"updatedAt" gorm:"size:64"`
}
