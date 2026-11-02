package model

type UserRole string

const (
	UserRoleGuest UserRole = "guest"
	UserRoleUser  UserRole = "user"
	UserRoleAdmin UserRole = "admin"
)

type UserStatus string

const (
	UserStatusActive UserStatus = "active"
	UserStatusBan    UserStatus = "ban"
)

// User 系统用户。
type User struct {
	ID          string     `json:"id" gorm:"primaryKey"`
	Username    string     `json:"username" gorm:"size:64;uniqueIndex"`
	Password    string     `json:"password,omitempty" gorm:"size:60"`
	Email       string     `json:"email" gorm:"size:254"`
	DisplayName string     `json:"displayName" gorm:"size:191"`
	AvatarURL   string     `json:"avatarUrl"`
	Role        UserRole   `json:"role" gorm:"size:32"`
	Credits     float64    `json:"credits" gorm:"type:decimal(20,2)"`
	GithubID    string     `json:"githubId" gorm:"size:191"`
	LinuxDoID   string     `json:"linuxDoId" gorm:"index"`
	WechatID    string     `json:"wechatId" gorm:"size:191"`
	Status      UserStatus `json:"status" gorm:"size:32"`
	LastLoginAt string     `json:"lastLoginAt" gorm:"size:64"`
	Extra       string     `json:"extra" gorm:"type:text"`
	CreatedAt   string     `json:"createdAt" gorm:"size:64"`
	UpdatedAt   string     `json:"updatedAt" gorm:"size:64"`
}

// UserList 用户分页结果。
type UserList struct {
	Items []User `json:"items"`
	Total int    `json:"total"`
}

// AuthUser 用户公开信息。
type AuthUser struct {
	ID          string   `json:"id"`
	Username    string   `json:"username"`
	DisplayName string   `json:"displayName"`
	AvatarURL   string   `json:"avatarUrl"`
	Role        UserRole `json:"role"`
	Credits     float64  `json:"credits"`
	CreatedAt   string   `json:"createdAt"`
	UpdatedAt   string   `json:"updatedAt"`
}

// AuthSession 登录会话信息。
type AuthSession struct {
	Token string   `json:"token"`
	User  AuthUser `json:"user"`
}

func PublicUser(user User) AuthUser {
	return AuthUser{
		ID:          user.ID,
		Username:    user.Username,
		DisplayName: user.DisplayName,
		AvatarURL:   user.AvatarURL,
		Role:        user.Role,
		Credits:     user.Credits,
		CreatedAt:   user.CreatedAt,
		UpdatedAt:   user.UpdatedAt,
	}
}

type CreditLogType string

const (
	CreditLogTypeAdminAdjust CreditLogType = "admin_adjust"
	CreditLogTypeAIConsume   CreditLogType = "ai_consume"
	CreditLogTypeAIRefund    CreditLogType = "ai_refund"
)

// CreditLog 用户算力点变更流水。
type CreditLog struct {
	ID        string        `json:"id" gorm:"primaryKey"`
	UserID    string        `json:"userId" gorm:"index"`
	Type      CreditLogType `json:"type" gorm:"size:32"`
	Amount    float64       `json:"amount" gorm:"type:decimal(20,2)"`
	Balance   float64       `json:"balance" gorm:"type:decimal(20,2)"`
	RelatedID string        `json:"relatedId" gorm:"size:191"`
	Remark    string        `json:"remark"`
	Extra     string        `json:"extra" gorm:"type:text"`
	CreatedAt string        `json:"createdAt" gorm:"size:64;index"`

	UserDisplayName string `json:"userDisplayName" gorm:"->;-:migration"`
}

type CreditLogList struct {
	Items []CreditLog `json:"items"`
	Total int         `json:"total"`
}
