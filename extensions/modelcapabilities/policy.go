package modelcapabilities

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/repository"
	"gorm.io/gorm"
)

type Policy struct {
	ImageTransfer string            `json:"imageTransfer"`
	Overrides     map[string]string `json:"overrides"`
}

type policyRow struct {
	ID    uint   `gorm:"primaryKey"`
	Value string `gorm:"type:text;not null"`
}

func (policyRow) TableName() string { return "ext_model_policy" }

var currentPolicy atomic.Pointer[Policy]
var saveMu sync.Mutex

func CurrentPolicy() Policy {
	if p := currentPolicy.Load(); p != nil {
		return *p
	}
	return Policy{ImageTransfer: "url", Overrides: map[string]string{}}
}

func Override(name string) string {
	return CurrentPolicy().Overrides[strings.ToLower(strings.TrimSpace(name))]
}

func validatePolicy(p Policy) (Policy, error) {
	if p.ImageTransfer != "url" && p.ImageTransfer != "base64" {
		return Policy{}, errors.New("图片传输方式必须为 URL 或 Base64")
	}
	if len(p.Overrides) > 2000 {
		return Policy{}, errors.New("最多设置 2000 个模型")
	}
	normalized := make(map[string]string, len(p.Overrides))
	for name, kind := range p.Overrides {
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" || len(name) > 256 {
			return Policy{}, errors.New("模型 ID 不能为空且不能超过 256 字节")
		}
		switch kind {
		case "text", "image", "video", "audio":
		default:
			return Policy{}, errors.New("无效的模型类型")
		}
		if _, exists := normalized[name]; exists {
			return Policy{}, errors.New("模型 ID 重复")
		}
		normalized[name] = kind
	}
	p.Overrides = normalized
	return p, nil
}

func initializePolicy(db *gorm.DB) error {
	if err := db.AutoMigrate(&policyRow{}); err != nil {
		return err
	}
	var row policyRow
	err := db.First(&row, 1).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		p := CurrentPolicy()
		currentPolicy.Store(&p)
		return nil
	}
	if err != nil {
		return err
	}
	var p Policy
	if err = json.Unmarshal([]byte(row.Value), &p); err != nil {
		return err
	}
	p, err = validatePolicy(p)
	if err == nil {
		currentPolicy.Store(&p)
	}
	return err
}

func RegisterPolicy(public, admin *gin.RouterGroup) error {
	db, err := repository.DB()
	if err != nil {
		return err
	}
	if err = initializePolicy(db); err != nil {
		return err
	}
	public.GET("/model-policy", func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{"code": 0, "data": CurrentPolicy()})
	})
	admin.PUT("/model-policy", func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1024*1024)
		var p Policy
		if err := c.ShouldBindJSON(&p); err != nil {
			c.JSON(400, gin.H{"code": -1, "msg": "配置格式错误"})
			return
		}
		p, err := validatePolicy(p)
		if err != nil {
			c.JSON(400, gin.H{"code": -1, "msg": err.Error()})
			return
		}
		raw, err := json.Marshal(p)
		if err != nil {
			c.JSON(500, gin.H{"code": -1, "msg": "配置编码失败"})
			return
		}
		saveMu.Lock()
		defer saveMu.Unlock()
		if err = db.Save(&policyRow{ID: 1, Value: string(raw)}).Error; err != nil {
			c.JSON(500, gin.H{"code": -1, "msg": "配置保存失败"})
			return
		}
		currentPolicy.Store(&p)
		c.JSON(200, gin.H{"code": 0, "data": p})
	})
	return nil
}
