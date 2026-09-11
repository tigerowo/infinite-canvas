// Package mediaarchive imports remote generated media without routing bytes through the browser.
package mediaarchive

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	ml "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"
	"github.com/tigerowo/infinite-canvas/extensions/mediaidentity"
	"github.com/tigerowo/infinite-canvas/extensions/s3compat"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type sourceRecord struct {
	ID       string `gorm:"primaryKey;size:64"`
	ObjectID string `gorm:"not null"`
}

func (sourceRecord) TableName() string { return "ext_media_archive_sources" }

var importLocks [64]sync.Mutex

const maxMediaBytes = 256 << 20

func sourceIdentity(owner, source string) string {
	u, err := url.Parse(source)
	if err == nil {
		u.Fragment = ""
		// Strip only recognized S3 authorization parameters, retaining variant/query identity.
		q := u.Query()
		if q.Get("X-Amz-Signature") != "" {
			for k := range q {
				if strings.HasPrefix(strings.ToLower(k), "x-amz-") {
					q.Del(k)
				}
			}
		}
		u.RawQuery = q.Encode()
		source = u.String()
	}
	return mediaidentity.Digest(owner, source)
}

// ArchiveVideo runs under the task owner's identity, independent of a browser session.
func ArchiveVideo(owner, source, filename string) (service.UploadedStorageObject, error) {
	return ArchiveMedia(context.Background(), owner, source, filename)
}

func ArchiveMedia(ctx context.Context, owner, source, filename string) (service.UploadedStorageObject, error) {
	user, found, err := repository.GetUserByID(owner)
	if err != nil || !found || user.Status == model.UserStatusBan {
		return service.UploadedStorageObject{}, errors.New("视频任务所属账号不可用")
	}
	db, err := repository.DB()
	if err != nil {
		return service.UploadedStorageObject{}, err
	}
	ctx = service.WithUser(ctx, model.AuthUser{ID: user.ID, Role: user.Role})
	if ml.Epoch(ctx) > 0 {
		p, err := ml.GetPolicy(db)
		if err != nil {
			return service.UploadedStorageObject{}, err
		}
		if err := ml.GuardEpoch(p, ml.Epoch(ctx)); err != nil {
			return service.UploadedStorageObject{}, err
		}
	}
	if strings.HasPrefix(source, "data:") {
		header, encoded, ok := strings.Cut(strings.TrimPrefix(source, "data:"), ",")
		if !ok || !strings.HasSuffix(header, ";base64") || len(encoded) > maxMediaBytes*4/3+4 {
			return service.UploadedStorageObject{}, errors.New("生成素材格式或大小无效")
		}
		mime := strings.TrimSuffix(header, ";base64")
		if !strings.HasPrefix(mime, "image/") && !strings.HasPrefix(mime, "audio/") && !strings.HasPrefix(mime, "video/") {
			return service.UploadedStorageObject{}, errors.New("生成素材类型无效")
		}
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return service.UploadedStorageObject{}, errors.New("生成素材编码无效")
		}
		return service.UploadStorageObject(ctx, filename, mime, data)
	}
	return importRemote(ctx, db, service.SafeProxyHTTPClient(), owner, source, filename)
}

func importRemote(ctx context.Context, db *gorm.DB, client *http.Client, owner, source, filename string) (service.UploadedStorageObject, error) {
	p, err := ml.GetPolicy(db)
	if err != nil {
		return service.UploadedStorageObject{}, err
	}
	if ml.Epoch(ctx) == 0 {
		ctx = ml.WithEpoch(ctx, p.Epoch)
	}
	if err := ml.GuardEpoch(p, ml.Epoch(ctx)); err != nil {
		return service.UploadedStorageObject{}, err
	}
	u, err := url.Parse(source)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil {
		return service.UploadedStorageObject{}, errors.New("媒体来源必须是 HTTP(S) 地址")
	}
	id := sourceIdentity(owner, source)
	mu := &importLocks[int(id[0])%len(importLocks)]
	mu.Lock()
	defer mu.Unlock()
	var record sourceRecord
	err = db.First(&record, "id = ?", id).Error
	if err == nil {
		object, loadErr := service.StorageObjectInfo(record.ObjectID)
		if loadErr == nil {
			if err := service.CanReadStorageObject(ctx, object); err != nil {
				return service.UploadedStorageObject{}, err
			}
			return service.UploadedStorageObject{ID: object.ID, StorageKey: "server:" + object.ID, URL: "/api/files/" + object.ID + "/content", Bytes: object.Bytes, MimeType: object.MimeType}, nil
		}
		if !errors.Is(loadErr, gorm.ErrRecordNotFound) {
			return service.UploadedStorageObject{}, loadErr
		}
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return service.UploadedStorageObject{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return service.UploadedStorageObject{}, errors.New("媒体来源无效")
	}
	response, err := client.Do(request)
	if err != nil {
		return service.UploadedStorageObject{}, errors.New("服务端拉取媒体失败，请检查来源是否可访问")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return service.UploadedStorageObject{}, errors.New("媒体来源未返回完整文件")
	}
	data, mime, err := readMediaBody(response)
	if err != nil {
		return service.UploadedStorageObject{}, err
	}
	saved, err := service.UploadStorageObject(ctx, filename, mime, data)
	if err != nil {
		return saved, err
	}
	err = ml.SaveFileIndex(db, owner, saved.ID, ml.Epoch(ctx), func(tx *gorm.DB) error {
		return tx.Clauses(clause.OnConflict{UpdateAll: true}).Create(&sourceRecord{ID: id, ObjectID: saved.ID}).Error
	})
	return saved, err
}

func Register(group *gin.RouterGroup) error {
	db, err := repository.DB()
	if err != nil {
		return err
	}
	if err := db.AutoMigrate(&sourceRecord{}); err != nil {
		return err
	}
	group.POST("/resolve", func(c *gin.Context) {
		user, ok := service.UserFromContext(c.Request.Context())
		if !ok || user.ID == "" {
			c.JSON(401, gin.H{"code": -1, "msg": "请先登录"})
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<10)
		var input struct {
			URL string `json:"url"`
		}
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(400, gin.H{"code": -1, "msg": "媒体地址无效"})
			return
		}
		u, err := url.Parse(input.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
			c.JSON(400, gin.H{"code": -1, "msg": "媒体地址无效"})
			return
		}
		parts := strings.Split(strings.TrimLeft(u.Path, "/"), "/")
		keys := make([]string, 0, len(parts))
		for i := range parts {
			keys = append(keys, strings.Join(parts[i:], "/"))
		}
		var objects []model.StorageObject
		if err := db.Where("created_by = ? AND object_key IN ? AND deleted_at = ?", user.ID, keys, "").Find(&objects).Error; err != nil {
			c.JSON(500, gin.H{"code": -1, "msg": "读取素材身份失败"})
			return
		}
		for _, object := range objects {
			provider, found := service.StorageProviderForObject(object)
			if !found {
				continue
			}
			expected, err := s3compat.ObjectURL(provider.Endpoint, provider.Bucket, object.ObjectKey)
			if err == nil && expected.Scheme == u.Scheme && expected.Host == u.Host && expected.Path == u.Path {
				c.JSON(200, gin.H{"code": 0, "data": gin.H{"storageKey": "server:" + object.ID}})
				return
			}
		}
		c.JSON(200, gin.H{"code": 0, "data": gin.H{}})
	})
	group.POST("/import", func(c *gin.Context) {
		user, ok := service.UserFromContext(c.Request.Context())
		if !ok || user.ID == "" {
			c.JSON(401, gin.H{"code": -1, "msg": "请先登录"})
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<10)
		var input struct {
			URL      string `json:"url"`
			Filename string `json:"filename"`
		}
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(400, gin.H{"code": -1, "msg": "媒体来源格式无效"})
			return
		}
		result, err := importRemote(c.Request.Context(), db, service.SafeProxyHTTPClient(), user.ID, input.URL, input.Filename)
		if err != nil {
			c.JSON(400, gin.H{"code": -1, "msg": err.Error()})
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(200, gin.H{"code": 0, "data": result})
	})
	return nil
}
