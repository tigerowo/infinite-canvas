package model

type VideoTask struct {
	ID                           string  `json:"id" gorm:"primaryKey"`
	UserID                       string  `json:"userId" gorm:"index;index:idx_video_tasks_user_source_status_created_at,priority:1"`
	UserDisplayName              string  `json:"userDisplayName" gorm:"size:191"`
	Model                        string  `json:"model" gorm:"index"`
	ChannelID                    string  `json:"channelId" gorm:"index"`
	UserChannelID                string  `json:"userChannelId" gorm:"index"`
	ChannelName                  string  `json:"channelName" gorm:"size:191"`
	WorkflowRef                  string  `json:"workflowRef,omitempty" gorm:"type:text"`
	Source                       string  `json:"source" gorm:"index;index:idx_video_tasks_user_source_status_created_at,priority:2"`
	SourceID                     string  `json:"source_id" gorm:"index"`
	UpstreamTaskID               string  `json:"upstreamTaskId" gorm:"index"`
	UpstreamVideoID              string  `json:"upstreamVideoId" gorm:"index"`
	Status                       string  `json:"status" gorm:"index:idx_video_tasks_status_created_at,priority:1;index:idx_video_tasks_status_completed_at,priority:1;index:idx_video_tasks_user_source_status_created_at,priority:3"`
	Progress                     int     `json:"progress"`
	Seconds                      string  `json:"seconds" gorm:"size:32"`
	Size                         string  `json:"size" gorm:"size:64"`
	VideoURL                     string  `json:"videoUrl"`
	Error                        string  `json:"error" gorm:"type:text"`
	ErrorDetail                  string  `json:"errorDetail"`
	RequestBody                  string  `json:"requestBody"`
	ParameterTranslationSnapshot string  `json:"-"`
	ResponseBody                 string  `json:"responseBody"`
	LastResponse                 string  `json:"lastResponse"`
	Credits                      float64 `json:"credits" gorm:"type:decimal(20,2)"`
	CreatedAt                    string  `json:"createdAt" gorm:"index;index:idx_video_tasks_status_created_at,priority:2;index:idx_video_tasks_user_source_status_created_at,priority:4"`
	UpdatedAt                    string  `json:"updatedAt" gorm:"index"`
	StartedAt                    string  `json:"startedAt" gorm:"size:64"`
	CompletedAt                  string  `json:"completedAt" gorm:"size:64;index:idx_video_tasks_status_completed_at,priority:2"`
	LastPolledAt                 string  `json:"lastPolledAt" gorm:"index"`
}
