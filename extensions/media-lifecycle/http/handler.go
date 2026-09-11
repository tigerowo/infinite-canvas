package lifecyclehttp

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	ml "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"
	"github.com/tigerowo/infinite-canvas/extensions/mediaarchive"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
	"gorm.io/gorm"
)

func fail(c *gin.Context, err error) {
	status, message := http.StatusInternalServerError, "素材服务暂时不可用，请稍后重试"
	var safe ml.Error
	if errors.As(err, &safe) {
		status, message = http.StatusConflict, safe.SafeMessage()
	} else {
		log.Printf("media lifecycle request: %v", err)
	}
	if errors.Is(err, ml.ErrForbidden) {
		status = http.StatusForbidden
	}
	c.JSON(status, gin.H{"code": 1, "msg": message})
	c.Abort()
}
func respond(c *gin.Context, data any, err error) {
	if err != nil {
		fail(c, err)
		return
	}
	c.JSON(200, gin.H{"code": 0, "data": data, "msg": ""})
}
func owner(c *gin.Context) string {
	user, _ := service.UserFromContext(c.Request.Context())
	return user.ID
}

// Guard must follow authentication. After the first clear, old clients without
// an epoch are rejected; reading a new epoch never silently replays stale edits.
func Guard(c *gin.Context) {
	db, err := repository.DB()
	if err != nil {
		fail(c, err)
		return
	}
	p, err := ml.GetPolicy(db)
	if err != nil {
		fail(c, err)
		return
	}
	c.Header("X-Media-Epoch", strconv.FormatInt(p.Epoch, 10))
	if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
		if p.Clearing {
			fail(c, ml.ErrClearing)
			return
		}
		value := c.GetHeader("X-Media-Epoch")
		if (value == "" && p.Epoch > 1) || (value != "" && value != strconv.FormatInt(p.Epoch, 10)) {
			fail(c, ml.ErrConflict)
			return
		}
		lease := ml.RequestLease{ID: ml.ID(), Epoch: p.Epoch, Until: time.Now().UnixMilli() + ml.Day}
		if err := ml.WithLock(db, func(tx *gorm.DB, current *ml.Policy) error {
			if current.Clearing {
				return ml.ErrClearing
			}
			if current.Epoch != p.Epoch {
				return ml.ErrConflict
			}
			return tx.Create(&lease).Error
		}); err != nil {
			fail(c, err)
			return
		}
		defer func() {
			if err := db.Delete(&lease).Error; err != nil {
				log.Printf("media lifecycle request lease release: %v", err)
			}
		}()
	}
	c.Request = c.Request.WithContext(ml.WithEpoch(c.Request.Context(), p.Epoch))
	c.Next()
}

func Register(user, admin *gin.RouterGroup) error {
	db, err := repository.DB()
	if err != nil {
		return err
	}
	user.GET("/state", func(c *gin.Context) { p, err := ml.GetPolicy(db); respond(c, p, err) })
	user.GET("/capacity", func(c *gin.Context) {
		result, err := ml.GetCapacity(db, owner(c))
		if err == nil {
			result.PhysicalBytes = 0
			result.PhysicalFiles = 0
			result.PendingBytes = 0
		}
		respond(c, result, err)
	})
	user.GET("/materials", func(c *gin.Context) {
		var records []ml.Material
		err := db.Where("owner = ? AND state = ?", owner(c), ml.Active).Limit(1000).Find(&records).Error
		respond(c, records, err)
	})
	user.POST("/share", func(c *gin.Context) {
		var input struct {
			FileID string `json:"fileId"`
		}
		if err := c.ShouldBindJSON(&input); err != nil {
			fail(c, ml.Error("素材参数无效"))
			return
		}
		result, err := ml.Share(db, owner(c), input.FileID)
		respond(c, result, err)
	})
	user.GET("/resolve/:id", func(c *gin.Context) { result, err := ml.Resolve(db, c.Param("id")); respond(c, result, err) })
	user.GET("/draft/:id", func(c *gin.Context) {
		result, err := ml.ReadUse(db, owner(c), "draft", c.Param("id"))
		respond(c, result, err)
	})
	user.POST("/tasks/retry-archive", func(c *gin.Context) {
		var input ml.Use
		if err := c.ShouldBindJSON(&input); err != nil || input.OperationID == "" || len(input.OperationID) > 128 || (input.Kind != "image-task" && input.Kind != "audio-task" && input.Kind != "video-task") {
			fail(c, ml.Error("归档恢复参数无效"))
			return
		}
		if err := ml.RetryTaskArchive(db, owner(c), input.Kind, input.ID, input.OperationID, ml.Epoch(c.Request.Context())); err != nil {
			fail(c, err)
			return
		}
		result, err := ml.TaskArchiveRetryReceipt(db, owner(c), input.OperationID)
		respond(c, result, err)
	})
	user.POST("/promote", func(c *gin.Context) {
		var input struct {
			ml.Use
			DraftID      string `json:"draftId"`
			DraftVersion *int64 `json:"draftVersion"`
		}
		if err := c.ShouldBindJSON(&input); err != nil || len(input.Files) > 50 || input.OperationID == "" || len(input.OperationID) > 128 || input.ID == "" || (input.DraftID != "" && input.DraftVersion == nil) {
			fail(c, ml.Error("提交引用参数无效"))
			return
		}
		input.Owner = owner(c)
		input.Epoch = ml.Epoch(c.Request.Context())
		result, err := ml.Promote(db, input.Use, input.DraftID, input.DraftVersion)
		respond(c, result, err)
	})
	user.POST("/claim", func(c *gin.Context) {
		var input struct {
			ShareID string `json:"shareId"`
			ml.Use
		}
		if err := c.ShouldBindJSON(&input); err != nil || input.OperationID == "" || len(input.OperationID) > 128 || input.Kind != "draft" || len(input.Files) > 50 || input.Version == nil {
			fail(c, ml.Error("草稿引用参数无效"))
			return
		}
		input.Epoch = ml.Epoch(c.Request.Context())
		result, err := ml.Claim(db, owner(c), input.ShareID, input.Use)
		respond(c, result, err)
	})
	user.POST("/activity", func(c *gin.Context) {
		var input ml.Use
		if err := c.ShouldBindJSON(&input); err != nil || input.OperationID == "" || len(input.OperationID) > 128 || len(input.Files) > 50 || len(input.Content) > 256 || (input.Kind == "draft" && (input.Version == nil || input.Content == "")) {
			fail(c, ml.Error("活动参数无效"))
			return
		}
		input.Owner = owner(c)
		input.Epoch = ml.Epoch(c.Request.Context())
		// Existing business entities may be touched, never invented by this API.
		if input.Kind != "draft" {
			var count int64
			if err := db.Model(&ml.Entity{}).Where("owner = ? AND kind = ? AND id = ? AND state = ?", input.Owner, input.Kind, input.ID, ml.Active).Count(&count).Error; err != nil {
				fail(c, err)
				return
			}
			if count != 1 {
				fail(c, ml.ErrConflict)
				return
			}
			input.Files = nil
		}
		result, err := ml.SaveUse(db, input, nil)
		respond(c, result, err)
	})
	user.POST("/release", func(c *gin.Context) {
		var input ml.Use
		if err := c.ShouldBindJSON(&input); err != nil || (input.Kind != "draft" && input.Kind != "library") {
			fail(c, ml.Error("释放位置无效"))
			return
		}
		respond(c, nil, ml.Release(db, owner(c), input.Kind, input.ID, ml.Epoch(c.Request.Context()), nil))
	})
	user.GET("/entities", func(c *gin.Context) {
		kind := c.Query("kind")
		var rows []ml.Entity
		err := db.Where("owner = ? AND kind = ? AND state = ?", owner(c), kind, ml.Active).Limit(1000).Find(&rows).Error
		respond(c, rows, err)
	})
	admin.GET("/policy", func(c *gin.Context) { p, err := ml.GetPolicy(db); respond(c, p, err) })
	admin.POST("/policy", func(c *gin.Context) {
		var p struct {
			ml.Policy
			PreviewID string `json:"previewId"`
		}
		if err := c.ShouldBindJSON(&p); err != nil {
			fail(c, ml.Error("策略格式无效"))
			return
		}
		result, err := ml.UpdatePolicy(db, p.Policy, p.PreviewID)
		respond(c, result, err)
	})
	admin.POST("/policy/preview", func(c *gin.Context) {
		var p ml.Policy
		if err := c.ShouldBindJSON(&p); err != nil {
			fail(c, ml.Error("策略格式无效"))
			return
		}
		result, err := ml.PreviewPolicyChange(db, p)
		respond(c, result, err)
	})
	admin.GET("/capacity", func(c *gin.Context) { result, err := ml.GetCapacity(db, owner(c)); respond(c, result, err) })
	admin.POST("/migrate-storage-scopes", func(c *gin.Context) {
		result, err := service.MigrateLegacyStorageScopes()
		respond(c, result, err)
	})
	admin.POST("/preview", func(c *gin.Context) {
		var input struct {
			Kind string `json:"kind"`
		}
		if err := c.ShouldBindJSON(&input); err != nil {
			fail(c, err)
			return
		}
		result, err := service.PreviewLifecycleCleanup(db, input.Kind)
		respond(c, result, err)
	})
	admin.GET("/batches", func(c *gin.Context) {
		var rows []ml.Batch
		err := db.Order("created DESC").Limit(50).Find(&rows).Error
		respond(c, rows, err)
	})
	admin.GET("/batches/:id", func(c *gin.Context) {
		var rows []ml.BatchItem
		err := db.Where("batch_id = ?", c.Param("id")).Limit(1000).Find(&rows).Error
		respond(c, rows, err)
	})
	admin.POST("/batches/:id/start", func(c *gin.Context) {
		var input struct {
			Confirmation string `json:"confirmation"`
		}
		if err := c.ShouldBindJSON(&input); err != nil {
			fail(c, err)
			return
		}
		err := service.PreflightLifecycleBatch(c.Param("id"))
		if err == nil {
			err = ml.StartBatch(db, c.Param("id"), input.Confirmation)
		}
		respond(c, nil, err)
	})
	admin.POST("/batches/:id/retry", func(c *gin.Context) {
		var b ml.Batch
		if err := db.First(&b, "id = ?", c.Param("id")).Error; err != nil {
			fail(c, err)
			return
		}
		if b.State != "failed" {
			fail(c, ml.ErrConflict)
			return
		}
		if err := service.PreflightLifecycleBatch(b.ID); err != nil {
			fail(c, err)
			return
		}
		respond(c, nil, db.Model(&b).Update("state", "running").Error)
	})
	return nil
}

// Start runs after migrations and route registration. There is no startup
// deletion: new installs default to observation, and only confirmed batches run.
func Start(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				db, err := repository.DB()
				if err != nil {
					log.Printf("media task recovery database: %v", err)
					continue
				}
				err = ml.RecoverTaskResults(ctx, db, func(ctx context.Context, owner, source, name string) (ml.ArchivedTaskMedia, error) {
					value, err := mediaarchive.ArchiveMedia(ctx, owner, source, name)
					return ml.ArchivedTaskMedia{URL: "/api/files/" + value.ID + "/content", StorageKey: value.StorageKey, MimeType: value.MimeType, Bytes: value.Bytes}, err
				})
				if err != nil {
					log.Printf("media task recovery: %v", err)
				}
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		lastScan := int64(0)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				db, err := repository.DB()
				if err != nil {
					log.Printf("media lifecycle database: %v", err)
					continue
				}
				var batches []ml.Batch
				if err := db.Where("state = ?", "running").Order("created ASC").Find(&batches).Error; err != nil {
					log.Printf("media lifecycle batches: %v", err)
					continue
				}
				for _, batch := range batches {
					if err := service.PreflightLifecycleBatch(batch.ID); err != nil {
						log.Printf("media lifecycle preflight %s: %v", batch.ID, err)
						if saveErr := db.Model(&ml.Batch{}).Where("id = ? AND lease_until <= ?", batch.ID, time.Now().UnixMilli()).Updates(map[string]any{"state": "failed", "error": "存储范围预检失败，尚未继续删除；请核对配置和文件清单"}).Error; saveErr != nil {
							log.Printf("media lifecycle preflight status: %v", saveErr)
						}
						continue
					}
					if err := ml.RunBatchWithFinalizer(ctx, db, batch.ID, service.DeleteLifecycleFile, func(ctx context.Context, batch ml.Batch) error {
						return service.ReconcileAILogFiles(ctx, db, batch)
					}); err != nil {
						log.Printf("media lifecycle batch %s: %v", batch.ID, err)
					}
				}
				p, err := ml.GetPolicy(db)
				if err != nil || p.Clearing {
					continue
				}
				if time.Now().Unix()-lastScan >= 86400 {
					preview, err := service.PreviewLifecycleCleanup(db, "expiry")
					if err == nil && p.Execution == "enforce" && p.Mode == "retention" {
						err = service.PreflightLifecycleBatch(preview.Batch.ID)
						if err == nil {
							err = ml.StartBatch(db, preview.Batch.ID, "")
						}
					}
					if err != nil {
						log.Printf("media lifecycle scan: %v", err)
					} else {
						lastScan = time.Now().Unix()
					}
				}
			}
		}
	}()
}
