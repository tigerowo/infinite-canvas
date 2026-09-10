package storageaccess

import (
	"encoding/json"
	"net/http"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type providerView struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Bucket  string `json:"bucket"`
	Enabled bool   `json:"enabled"`
	Config  Config `json:"config"`
}

type providerConfigInput struct {
	ProviderID string `json:"providerId"`
	Config
}

type configRequestError struct {
	status  int
	message string
}

func (e configRequestError) Error() string { return e.message }

// Register only accepts an admin-authenticated group. No endpoint exposes CDN keys.
func Register(admin *gin.RouterGroup) error {
	db, err := repository.DB()
	if err != nil {
		return err
	}
	if err := db.AutoMigrate(&configRow{}); err != nil {
		return err
	}
	registerHandlers(admin, db, repository.GetSettings)
	return nil
}

func registerHandlers(admin *gin.RouterGroup, db *gorm.DB, loadSettings func() (model.Settings, error)) {
	db = db.Session(&gorm.Session{Logger: logger.Discard})
	var saveMu sync.Mutex
	fail := func(c *gin.Context, code int, msg string) { c.JSON(code, gin.H{"code": -1, "msg": msg}) }
	respondSaveError := func(c *gin.Context, err error) {
		if requestError, ok := err.(configRequestError); ok {
			fail(c, requestError.status, requestError.message)
			return
		}
		fail(c, 500, "保存存储访问设置失败")
	}
	admin.GET("/storage-access", func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		settings, err := loadSettings()
		if err != nil {
			fail(c, 500, "读取存储配置失败")
			return
		}
		views := []providerView{}
		defaultID, err := defaultUploadID(db)
		if err != nil {
			fail(c, 500, "读取默认上传位置失败")
			return
		}
		if defaultID == "" {
			for _, p := range settings.Private.Storage.Providers {
				if p.Type == model.StorageProviderTypeS3 && p.Enabled && !p.CapacityExceeded && p.Endpoint != "" && p.Bucket != "" && p.AccessKeyID != "" && p.SecretAccessKey != "" {
					defaultID = p.ID
					break
				}
			}
		}
		for _, p := range settings.Private.Storage.Providers {
			if p.Type != model.StorageProviderTypeS3 || p.ID == "" {
				continue
			}
			cfg, err := loadConfig(db, p)
			if err != nil {
				fail(c, 500, "读取存储访问设置失败")
				return
			}
			cfg.DefaultUpload = p.ID == defaultID
			views = append(views, providerView{ID: p.ID, Name: p.Name, Bucket: p.Bucket, Enabled: p.Enabled, Config: redact(cfg)})
		}
		c.JSON(200, gin.H{"code": 0, "data": views})
	})
	admin.PUT("/storage-access", func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 512*1024)
		var input struct {
			Providers []providerConfigInput `json:"providers"`
		}
		if err := c.ShouldBindJSON(&input); err != nil || len(input.Providers) > 100 {
			fail(c, 400, "配置格式错误")
			return
		}
		saveMu.Lock()
		defer saveMu.Unlock()
		settings, err := loadSettings()
		if err != nil {
			fail(c, 500, "读取存储配置失败")
			return
		}
		views, err := saveProviderConfigs(db, settings.Private.Storage.Providers, input.Providers)
		if err != nil {
			respondSaveError(c, err)
			return
		}
		c.JSON(200, gin.H{"code": 0, "data": views})
	})
	admin.PUT("/storage-access/:id", func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64*1024)
		var cfg Config
		if err := c.ShouldBindJSON(&cfg); err != nil {
			fail(c, 400, "配置格式错误")
			return
		}
		saveMu.Lock()
		defer saveMu.Unlock()
		settings, err := loadSettings()
		if err != nil {
			fail(c, 500, "读取存储配置失败")
			return
		}
		views, err := saveProviderConfigs(db, settings.Private.Storage.Providers, []providerConfigInput{{ProviderID: c.Param("id"), Config: cfg}})
		if err != nil {
			respondSaveError(c, err)
			return
		}
		c.JSON(200, gin.H{"code": 0, "data": views[0].Config})
	})
}

func saveProviderConfigs(db *gorm.DB, providers []model.StorageProvider, inputs []providerConfigInput) ([]providerView, error) {
	byID := map[string]model.StorageProvider{}
	for _, provider := range providers {
		if provider.Type == model.StorageProviderTypeS3 && provider.ID != "" {
			byID[provider.ID] = provider
		}
	}
	rows := make([]configRow, 0, len(inputs))
	views := make([]providerView, 0, len(inputs))
	seen := map[string]bool{}
	selectedDefault := ""
	for _, input := range inputs {
		provider, found := byID[input.ProviderID]
		if !found {
			return nil, configRequestError{404, "请先保存对应的 OSS 配置"}
		}
		if seen[input.ProviderID] {
			return nil, configRequestError{400, "同一 OSS 的访问设置不能重复提交"}
		}
		seen[input.ProviderID] = true
		previous, err := loadConfig(db, provider)
		if err != nil {
			return nil, err
		}
		cfg, err := validateConfig(input.Config, previous)
		if err != nil {
			return nil, configRequestError{400, err.Error()}
		}
		if cfg.DefaultUpload {
			if selectedDefault != "" {
				return nil, configRequestError{400, "只能选择一个默认上传位置"}
			}
			if !provider.Enabled || provider.CapacityExceeded || provider.Endpoint == "" || provider.Bucket == "" || provider.AccessKeyID == "" || provider.SecretAccessKey == "" {
				return nil, configRequestError{400, "默认上传位置必须启用且配置完整、容量可用"}
			}
			selectedDefault = provider.ID
		}
		if cfg.Delivery != "s3" && provider.PublicBaseURL != "" {
			return nil, configRequestError{400, "私有 CDN 不能填在公开访问域名中，请清空对应 OSS 的公开访问域名"}
		}
		raw, err := json.Marshal(cfg)
		if err != nil {
			return nil, err
		}
		rows = append(rows, configRow{ProviderID: provider.ID, Scope: providerScope(provider), Value: string(raw)})
		views = append(views, providerView{ID: provider.ID, Name: provider.Name, Bucket: provider.Bucket, Enabled: provider.Enabled, Config: redact(cfg)})
	}
	if err := db.Transaction(func(tx *gorm.DB) error {
		if selectedDefault != "" {
			if err := tx.Save(&configRow{ProviderID: defaultUploadRow, Scope: "default", Value: selectedDefault}).Error; err != nil {
				return err
			}
		}
		for _, row := range rows {
			if err := tx.Save(&row).Error; err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return views, nil
}
