package model

type AICallLog struct {
	ID              string `json:"id" gorm:"primaryKey"`
	UserID          string `json:"userId" gorm:"index"`
	UserDisplayName string `json:"userDisplayName" gorm:"->;-:migration"`
	Endpoint        string `json:"endpoint" gorm:"index"`
	Method          string `json:"method" gorm:"size:16"`
	Model           string `json:"model" gorm:"index"`
	ChannelID       string `json:"channelId" gorm:"index"`
	ChannelName     string `json:"channelName" gorm:"size:191"`
	Status          int    `json:"status" gorm:"index"`
	Failed          bool   `json:"failed" gorm:"-"`
	DurationMs      int64  `json:"durationMs"`
	Credits         float64 `json:"credits" gorm:"type:decimal(20,2)"`
	RequestBody     string `json:"requestBody" gorm:"type:text"`
	ResponseBody    string `json:"responseBody" gorm:"type:text"`
	Error           string `json:"error" gorm:"type:text"`
	CreatedAt       string `json:"createdAt" gorm:"index"`
}

type AICallLogList struct {
	Items []AICallLog `json:"items"`
	Total int         `json:"total"`
}
