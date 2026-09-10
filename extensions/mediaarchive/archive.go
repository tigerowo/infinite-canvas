// Package mediaarchive imports remote generated media without routing bytes through the browser.
package mediaarchive

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
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

func importRemote(ctx context.Context, db *gorm.DB, client *http.Client, owner, source, filename string) (service.UploadedStorageObject, error) {
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
	if response.ContentLength > maxMediaBytes {
		return service.UploadedStorageObject{}, errors.New("媒体文件超过 256 MiB 限制")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxMediaBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxMediaBytes {
		return service.UploadedStorageObject{}, errors.New("媒体文件为空、过大或下载中断")
	}
	mime := strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0])
	if mime == "" || mime == "application/octet-stream" {
		mime = http.DetectContentType(data)
	}
	if !strings.HasPrefix(mime, "image/") && !strings.HasPrefix(mime, "video/") && !strings.HasPrefix(mime, "audio/") {
		return service.UploadedStorageObject{}, errors.New("来源不是图片、视频或音频文件")
	}
	saved, err := service.UploadStorageObject(ctx, filename, mime, data)
	if err != nil {
		return saved, err
	}
	err = db.Clauses(clause.OnConflict{UpdateAll: true}).Create(&sourceRecord{ID: id, ObjectID: saved.ID}).Error
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
