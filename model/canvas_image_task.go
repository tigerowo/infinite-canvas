package model

type CanvasImageTask struct {
	ID              string   `json:"id" gorm:"primaryKey"`
	UserID          string   `json:"userId" gorm:"index:idx_canvas_image_tasks_user_source_node,priority:1;index:idx_canvas_image_tasks_user_source_status_created_at,priority:1"`
	UserDisplayName string   `json:"userDisplayName" gorm:"size:191"`
	Source          string   `json:"source" gorm:"index:idx_canvas_image_tasks_user_source_node,priority:2;index:idx_canvas_image_tasks_user_source_status_created_at,priority:2"`
	SourceID        string   `json:"sourceId" gorm:"index:idx_canvas_image_tasks_user_source_node,priority:3"`
	NodeID          string   `json:"nodeId" gorm:"index:idx_canvas_image_tasks_user_source_node,priority:4"`
	Model           string   `json:"model" gorm:"size:191"`
	ChannelID       string   `json:"channelId" gorm:"size:191"`
	UserChannelID   string   `json:"userChannelId" gorm:"size:191"`
	ChannelName     string   `json:"channelName" gorm:"size:191"`
	WorkflowRef     string   `json:"workflowRef,omitempty" gorm:"type:text"`
	Credits         float64  `json:"credits,omitempty" gorm:"type:decimal(20,2)"`
	Status          string   `json:"status" gorm:"size:32;index:idx_canvas_image_tasks_status_completed_at,priority:1;index:idx_canvas_image_tasks_user_source_status_created_at,priority:3"`
	Progress        int      `json:"progress"`
	Prompt          string   `json:"prompt" gorm:"type:text"`
	GenerationType  string   `json:"generationType" gorm:"size:32"`
	Endpoint        string   `json:"endpoint" gorm:"size:191"`
	ContentType     string   `json:"contentType" gorm:"size:191"`
	RequestBody     string   `json:"requestBody" gorm:"type:text"`
	ResponseBody    string   `json:"responseBody" gorm:"type:text"`
	Error           string   `json:"error" gorm:"type:text"`
	ErrorDetail     string   `json:"errorDetail" gorm:"type:text"`
	ImageURL        string   `json:"imageUrl" gorm:"type:text"`
	ImageURLs       []string `json:"imageUrls" gorm:"serializer:json"`
	StorageKey      string   `json:"storageKey" gorm:"size:1024"`
	Width           int      `json:"width"`
	Height          int      `json:"height"`
	MimeType        string   `json:"mimeType" gorm:"size:191"`
	Bytes           int64    `json:"bytes"`
	CreatedAt       string   `json:"createdAt" gorm:"size:64;index:idx_canvas_image_tasks_user_source_status_created_at,priority:4"`
	UpdatedAt       string   `json:"updatedAt" gorm:"size:64"`
	StartedAt       string   `json:"startedAt" gorm:"size:64"`
	CompletedAt     string   `json:"completedAt" gorm:"size:64;index:idx_canvas_image_tasks_status_completed_at,priority:2"`
}
