package model

type AssetType string

const (
	AssetTypeText  AssetType = "text"
	AssetTypeImage AssetType = "image"
)

// Asset 素材记录。
type Asset struct {
	ID          string    `json:"id" gorm:"primaryKey"`
	Title       string    `json:"title" gorm:"size:191"`
	Type        AssetType `json:"type" gorm:"size:32"`
	CoverURL    string    `json:"coverUrl"`
	Tags        []string  `json:"tags" gorm:"serializer:json"`
	Category    string    `json:"category" gorm:"size:191"`
	Description string    `json:"description"`
	Content     string    `json:"content,omitempty"`
	URL         string    `json:"url,omitempty"`
	CreatedAt   string    `json:"createdAt" gorm:"size:64"`
	UpdatedAt   string    `json:"updatedAt" gorm:"size:64"`
}

// AssetList 素材分页结果。
type AssetList struct {
	Items      []Asset  `json:"items"`
	Tags       []string `json:"tags"`
	Categories []string `json:"categories"`
	Total      int      `json:"total"`
}
