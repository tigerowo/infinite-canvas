package service

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/studio-b12/gowebdav"
	medialifecycle "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"gorm.io/gorm"
)

func attachTaskRecovery(result map[string]any, owner, kind, id, updatedAt string) {
	db, err := repository.DB()
	if err != nil {
		log.Printf("task recovery version database: %v", err)
		return
	}
	version, err := medialifecycle.TaskRecoveryVersion(db, owner, kind, id, updatedAt)
	if err != nil {
		log.Printf("task recovery version: %v", err)
		return
	}
	result["archiveRecovery"] = version
}

// This adapter is kept next to the existing private S3/WebDAV transport helpers.
// Deduplication, authorization and retention policy remain in the extension.
func uploadLifecycleObject(ctx context.Context, provider model.StorageProvider, userProvider bool, owner, name, mime string, data []byte) (UploadedStorageObject, error) {
	db, err := repository.DB()
	if err != nil {
		return UploadedStorageObject{}, err
	}
	scopeOwner := ""
	if userProvider {
		scopeOwner = owner
	}
	scope := medialifecycle.StorageScope(provider, scopeOwner)
	lease, err := medialifecycle.ReserveUpload(db, scope, sha256Hex(data), mime, int64(len(data)), medialifecycle.Epoch(ctx))
	if err != nil {
		return UploadedStorageObject{}, err
	}
	var object model.StorageObject
	if lease.Reused {
		object, err = medialifecycle.ObjectForFile(lease.File)
		if err != nil {
			return UploadedStorageObject{}, err
		}
		if provider.Type == model.StorageProviderTypeS3 {
			present, err := lifecycleObjectExists(ctx, provider, object.ObjectKey)
			if err != nil {
				return UploadedStorageObject{}, err
			}
			if !present {
				if err := medialifecycle.MarkMissing(db, lease.File); err != nil {
					return UploadedStorageObject{}, err
				}
				lease, err = medialifecycle.ReserveUpload(db, scope, sha256Hex(data), mime, int64(len(data)), medialifecycle.Epoch(ctx))
				if err != nil {
					return UploadedStorageObject{}, err
				}
			}
		}
	}
	if !lease.Reused {
		var cancel context.CancelCauseFunc
		ctx, cancel = context.WithCancelCause(ctx)
		defer cancel(nil)
		go func() {
			ticker := time.NewTicker(time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					if err := medialifecycle.RenewUpload(db, lease); err != nil {
						cancel(err)
						return
					}
				}
			}
		}()
		key := strings.Trim(strings.Trim(provider.PathPrefix, "/")+"/ext-media-lifecycle/"+lease.File.ID+extensionForContentType(mime), "/")
		object = model.StorageObject{ID: lease.File.ID, ProviderID: provider.ID, Bucket: provider.Bucket, ObjectKey: key, PublicURL: objectURL(provider, key), MimeType: mime, Bytes: int64(len(data)), SHA256: sha256Hex(data), CreatedBy: owner, CreatedAt: now()}
		if err := medialifecycle.PrepareUpload(db, lease, object); err != nil {
			return UploadedStorageObject{}, err
		}
		if err := putStorageObject(provider, key, mime, data, ctx); err != nil {
			_ = medialifecycle.AbandonUpload(db, lease)
			return UploadedStorageObject{}, err
		}
		if err := context.Cause(ctx); err != nil {
			return UploadedStorageObject{}, err
		}
	}
	if err := medialifecycle.CompleteUpload(db, lease, owner, name, object); err != nil {
		// A successful PUT is durable; retry the failed metadata transaction once,
		// without resending bytes. Longer failures remain visible and recoverable.
		if retryErr := medialifecycle.RecoverUpload(db, lease, owner, name, object); retryErr != nil {
			return UploadedStorageObject{}, retryErr
		}
	}
	return uploadedStorageObject(object), nil
}

func lifecycleObjectExists(ctx context.Context, provider model.StorageProvider, key string) (bool, error) {
	if provider.Type == model.StorageProviderTypeWebDAV {
		client, err := newWebDAVClient(provider, ctx)
		if err != nil {
			return false, err
		}
		remotePath, err := cleanStoragePath(key)
		if err != nil {
			return false, err
		}
		_, err = client.Stat(remotePath)
		if err == nil {
			return true, nil
		}
		if gowebdav.IsErrNotFound(err) {
			return false, nil
		}
		return false, err
	}
	request, err := newS3Request(http.MethodHead, provider, key, nil, 0)
	if err != nil {
		return false, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	response, err := SafeProxyHTTPClient().Do(request.WithContext(ctx))
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return false, fmt.Errorf("存储可用性检查失败：%s", response.Status)
	}
	return true, nil
}

func DeleteLifecycleFile(ctx context.Context, file medialifecycle.File) error {
	object, err := medialifecycle.ObjectForFile(file)
	if err != nil {
		return err
	}
	provider, ok := StorageProviderForObject(object)
	if !ok {
		return errors.New("对象对应的存储配置不存在，保留该清理项等待恢复")
	}
	if err := validateLifecycleLocation(file, object, provider); err != nil {
		return err
	}
	if err := deleteStorageObjectData(provider, object.ObjectKey, ctx); err != nil {
		return err
	}
	present, err := lifecycleObjectExists(ctx, provider, object.ObjectKey)
	if err != nil {
		return err
	}
	if present {
		return errors.New("存储仍返回对象，删除尚未确认")
	}
	return nil
}

func validateLifecycleLocation(file medialifecycle.File, object model.StorageObject, provider model.StorageProvider) error {
	if provider.Type != model.StorageProviderTypeS3 && provider.Type != model.StorageProviderTypeWebDAV {
		return medialifecycle.Error("该存储尚不支持确认删除，请先核对存储能力")
	}
	legacyScope := file.Scope == medialifecycle.Key("legacy", object.ProviderID, object.Bucket)
	validScope := file.Scope == medialifecycle.StorageScope(provider, "") || file.Scope == medialifecycle.StorageScope(provider, object.CreatedBy)
	if object.ProviderID != provider.ID || object.Bucket != provider.Bucket || (!validScope && !legacyScope) {
		return medialifecycle.Error("存储范围已变化，拒绝删除")
	}
	if object.ID != file.ID || object.ObjectKey == "" {
		return medialifecycle.Error("对象定位无效，拒绝删除")
	}
	return nil
}

// Validate every candidate before confirming a destructive batch. This is a
// local metadata check; each DELETE rechecks its immutable location as well.
func PreflightLifecycleBatch(id string) error {
	db, err := repository.DB()
	if err != nil {
		return err
	}
	var files []medialifecycle.File
	if err := db.Table("ext_media_lifecycle_files f").Select("f.*").Joins("JOIN ext_media_lifecycle_batch_items i ON i.target = f.id AND i.kind = ?", "file").Where("i.batch_id = ? AND f.state <> ?", id, medialifecycle.Deleted).Find(&files).Error; err != nil {
		return err
	}
	for _, file := range files {
		if file.State == medialifecycle.Uploading && file.ObjectJSON == "" {
			continue
		}
		object, err := medialifecycle.ObjectForFile(file)
		if err != nil {
			return medialifecycle.Error("文件定位记录无效，清理尚未开始")
		}
		provider, ok := StorageProviderForObject(object)
		if !ok {
			return medialifecycle.Error("对象对应的存储配置不存在，清理尚未开始")
		}
		if err := validateLifecycleLocation(file, object, provider); err != nil {
			return err
		}
	}
	return nil
}

// MigrateLegacyStorageScopes binds legacy lifecycle files to the currently
// configured provider when their immutable object metadata still identifies a
// known provider, bucket and owner. It only updates lifecycle metadata; it
// never moves, deletes, or rewrites an object in OSS.
type LegacyScopeMigration struct {
	Scanned  int      `json:"scanned"`
	Migrated int      `json:"migrated"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors,omitempty"`
}

func MigrateLegacyStorageScopes() (LegacyScopeMigration, error) {
	db, err := repository.DB()
	if err != nil {
		return LegacyScopeMigration{}, err
	}
	var files []medialifecycle.File
	if err := db.Where("scope LIKE ? AND state <> ?", "legacy%", medialifecycle.Deleted).Find(&files).Error; err != nil {
		return LegacyScopeMigration{}, err
	}
	result := LegacyScopeMigration{}
	for _, file := range files {
		result.Scanned++
		object, err := medialifecycle.ObjectForFile(file)
		if err != nil {
			result.Skipped++
			result.Errors = append(result.Errors, file.ID+": 对象元数据无效")
			continue
		}
		provider, ok := StorageProviderForObject(object)
		if !ok {
			result.Skipped++
			result.Errors = append(result.Errors, file.ID+": 当前未找到匹配的存储配置")
			continue
		}
		scopeOwner := object.CreatedBy
		if scopeOwner == "anonymous" {
			scopeOwner = ""
		}
		scope := medialifecycle.StorageScope(provider, scopeOwner)
		if err := db.Model(&medialifecycle.File{}).Where("id = ? AND scope = ? AND version = ?", file.ID, file.Scope, file.Version).Updates(map[string]any{"scope": scope, "version": gorm.Expr("version + 1")}).Error; err != nil {
			result.Skipped++
			result.Errors = append(result.Errors, file.ID+": 更新清单失败")
			continue
		}
		result.Migrated++
	}
	return result, nil
}

func PreviewLifecycleCleanup(db *gorm.DB, kind string) (medialifecycle.Preview, error) {
	if err := SyncAICallLogsToDatabase(db); err != nil {
		return medialifecycle.Preview{}, err
	}
	return medialifecycle.PreviewCleanup(db, kind)
}
