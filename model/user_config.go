package model

// UserConfig 用户配置和同步数据。
type UserConfig struct {
	UserID          string `json:"userId" gorm:"primaryKey"`
	ModelConfig     string `json:"modelConfig" gorm:"size:134217728"`
	StorageProvider string `json:"storageProvider" gorm:"type:text"`
	ImageHistory    string `json:"imageHistory" gorm:"type:text"`
	AssetData       string `json:"assetData" gorm:"type:text"`
	CreatedAt       string `json:"createdAt" gorm:"size:64"`
	UpdatedAt       string `json:"updatedAt" gorm:"size:64"`
}
