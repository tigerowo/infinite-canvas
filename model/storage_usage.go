package model

// StorageUsage 按 Provider 和自然月记录由本应用发起的 S3/R2 操作。
type StorageUsage struct {
	ProviderID       string `json:"providerId" gorm:"primaryKey"`
	Period           string `json:"period" gorm:"primaryKey"`
	ClassAOperations int64  `json:"classAOperations"`
	ClassBOperations int64  `json:"classBOperations"`
	UpdatedAt        string `json:"updatedAt"`
}
