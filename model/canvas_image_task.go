package model

type CanvasImageTask struct {
	ID                  string   `json:"id" gorm:"primaryKey"`
	UserID              string   `json:"userId" gorm:"index:idx_canvas_image_tasks_user_source_node,priority:1"`
	UserDisplayName     string   `json:"userDisplayName"`
	Source              string   `json:"source" gorm:"index:idx_canvas_image_tasks_user_source_node,priority:2"`
	SourceID            string   `json:"sourceId" gorm:"index:idx_canvas_image_tasks_user_source_node,priority:3"`
	NodeID              string   `json:"nodeId" gorm:"index:idx_canvas_image_tasks_user_source_node,priority:4"`
	Model               string   `json:"model"`
	ChannelID           string   `json:"channelId"`
	UserChannelID       string   `json:"userChannelId"`
	ChannelName         string   `json:"channelName"`
	Status              string   `json:"status"`
	Progress            int      `json:"progress"`
	Prompt              string   `json:"prompt" gorm:"type:text"`
	GenerationType      string   `json:"generationType"`
	Endpoint            string   `json:"endpoint"`
	ContentType         string   `json:"contentType"`
	RequestBody         string   `json:"requestBody" gorm:"type:text"`
	ResponseBody        string   `json:"responseBody" gorm:"type:text"`
	Error               string   `json:"error" gorm:"type:text"`
	ErrorDetail         string   `json:"errorDetail" gorm:"type:text"`
	ImageURL            string   `json:"imageUrl" gorm:"type:text"`
	ImageURLs           []string `json:"imageUrls" gorm:"serializer:json"`
	StorageKey          string   `json:"storageKey"`
	ThumbnailURL        string   `json:"thumbnailUrl" gorm:"type:text"`
	ThumbnailStorageKey string   `json:"thumbnailStorageKey"`
	Width               int      `json:"width"`
	Height              int      `json:"height"`
	MimeType            string   `json:"mimeType"`
	Bytes               int64    `json:"bytes"`
	CreatedAt           string   `json:"createdAt"`
	UpdatedAt           string   `json:"updatedAt"`
	StartedAt           string   `json:"startedAt"`
	CompletedAt         string   `json:"completedAt"`
}
