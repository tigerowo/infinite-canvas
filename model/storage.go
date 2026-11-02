package model

// StorageObject 存储对象（S3/R2、WebDAV 共用文件索引）。
type StorageObject struct {
	ID         string `json:"id" gorm:"primaryKey"`
	ProviderID string `json:"providerId" gorm:"index"`
	Bucket     string `json:"bucket" gorm:"size:191"`
	ObjectKey  string `json:"objectKey" gorm:"size:1024"`
	PublicURL  string `json:"publicUrl"`
	MimeType   string `json:"mimeType" gorm:"size:191"`
	Bytes      int64  `json:"bytes"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	SHA256     string `json:"sha256" gorm:"size:64"`
	Direct     bool   `json:"direct"`
	CreatedBy  string `json:"createdBy" gorm:"index"`
	CreatedAt  string `json:"createdAt" gorm:"size:64"`
	DeletedAt  string `json:"deletedAt" gorm:"size:64"`
}
