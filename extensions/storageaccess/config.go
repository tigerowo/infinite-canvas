package storageaccess

import (
	"encoding/json"
	"errors"
	"net/url"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

// Config is stored independently from upstream settings and is never public.
type Config struct {
	DefaultUpload  bool     `json:"defaultUpload,omitempty"`
	AllowedOrigins []string `json:"allowedOrigins"`
	Delivery       string   `json:"delivery"`
	CDNBaseURL     string   `json:"cdnBaseUrl"`
	TokenKey       string   `json:"tokenKey"`
	HasTokenKey    bool     `json:"hasTokenKey"`
}

type configRow struct {
	ProviderID string `gorm:"primaryKey"`
	Scope      string `gorm:"type:text;not null"`
	Value      string `gorm:"type:text;not null"`
}

func (configRow) TableName() string { return "ext_storage_access" }

func defaultConfig() Config { return Config{Delivery: "s3", AllowedOrigins: []string{}} }

// RequireOSS prevents saving a cloud installation with no usable global OSS.
// An unconfigured installation may still start so its administrator can configure it.
func RequireOSS(providers []model.StorageProvider) error {
	for _, p := range providers {
		if p.Type != model.StorageProviderTypeS3 || !p.Enabled || p.CapacityExceeded {
			continue
		}
		u, err := url.Parse(p.Endpoint)
		if err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Hostname() != "" && p.Bucket != "" && p.AccessKeyID != "" && p.SecretAccessKey != "" {
			return nil
		}
	}
	return errors.New("必须保留至少一个已启用且配置完整的 OSS/S3 存储，请填写 Endpoint、Bucket、Access Key ID 和 Secret Access Key")
}

func providerScope(p model.StorageProvider) string {
	return strings.TrimRight(p.Endpoint, "/") + "\n" + p.Bucket
}

func loadConfig(db *gorm.DB, p model.StorageProvider) (Config, error) {
	var row configRow
	err := db.First(&row, "provider_id = ?", p.ID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return defaultConfig(), nil
	}
	if err != nil {
		return Config{}, err
	}
	// Changing a provider's bucket/endpoint must not reuse credentials for its old CDN.
	if row.Scope != providerScope(p) {
		return defaultConfig(), nil
	}
	var cfg Config
	if err := json.Unmarshal([]byte(row.Value), &cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func redact(cfg Config) Config {
	cfg.HasTokenKey = cfg.TokenKey != ""
	cfg.TokenKey = ""
	return cfg
}

func validateConfig(cfg, previous Config) (Config, error) {
	if cfg.Delivery != "s3" && cfg.Delivery != "edgeone-b" && cfg.Delivery != "esa-a" {
		return Config{}, errors.New("请选择签名直读、EdgeOne 或 ESA")
	}
	if len(cfg.AllowedOrigins) > 20 {
		return Config{}, errors.New("最多配置 20 个站点来源")
	}
	origins := make([]string, 0, len(cfg.AllowedOrigins))
	seen := map[string]bool{}
	for _, origin := range cfg.AllowedOrigins {
		if strings.TrimSpace(origin) == "" {
			continue
		}
		u, err := url.Parse(strings.TrimSpace(origin))
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || strings.Contains(u.Host, "*") {
			return Config{}, errors.New("跨域来源必须是完整站点地址，例如 https://canvas.example.com；不包含路径或通配符")
		}
		origin = strings.ToLower(u.Scheme + "://" + u.Host)
		if !seen[origin] {
			origins = append(origins, origin)
			seen[origin] = true
		}
	}
	cfg.AllowedOrigins = origins
	cfg.CDNBaseURL = strings.TrimRight(strings.TrimSpace(cfg.CDNBaseURL), "/")
	if cfg.CDNBaseURL != "" {
		u, err := url.Parse(cfg.CDNBaseURL)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.Contains(u.Host, "*") {
			return Config{}, errors.New("CDN 域名必须为 HTTPS 地址，不包含路径、参数或凭据")
		}
	}
	if cfg.TokenKey == "" {
		cfg.TokenKey = previous.TokenKey
	}
	if cfg.TokenKey != "" && (len(cfg.TokenKey) < 6 || len(cfg.TokenKey) > 256 || strings.ContainsAny(cfg.TokenKey, " \t\n\r")) {
		return Config{}, errors.New("鉴权密钥须为 6–256 字节且不含空白字符")
	}
	if cfg.Delivery != "s3" && (cfg.CDNBaseURL == "" || cfg.TokenKey == "") {
		return Config{}, errors.New("启用 CDN 前请填写加速域名和对应的鉴权密钥")
	}
	cfg.HasTokenKey = false
	return cfg, nil
}
