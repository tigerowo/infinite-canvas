package model

type AICallLog struct {
	ID              string `json:"id" gorm:"primaryKey"`
	UserID          string `json:"userId" gorm:"index"`
	UserDisplayName string `json:"userDisplayName"`
	Endpoint        string `json:"endpoint" gorm:"index"`
	Method          string `json:"method"`
	Model           string `json:"model" gorm:"index"`
	ChannelID       string `json:"channelId" gorm:"index"`
	ChannelName     string `json:"channelName"`
	Status          int    `json:"status" gorm:"index"`
	DurationMs      int64  `json:"durationMs"`
	Credits         int    `json:"credits"`
	RequestBody     string `json:"requestBody" gorm:"type:text"`
	ResponseBody    string `json:"responseBody" gorm:"type:text"`
	Error           string `json:"error" gorm:"type:text"`
	CreatedAt       string `json:"createdAt" gorm:"index"`
}

type AICallLogList struct {
	Items []AICallLog `json:"items"`
	Total int         `json:"total"`
}
