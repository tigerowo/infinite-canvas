package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsSigner "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/google/uuid"
	"github.com/robfig/cron/v3"
	"github.com/tigerowo/infinite-canvas/extensions/mediaidentity"
	"github.com/tigerowo/infinite-canvas/extensions/s3compat"
	"github.com/tigerowo/infinite-canvas/extensions/storageaccess"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"gorm.io/gorm"
)

// UploadedStorageObject 上传存储对象返回结果。
type UploadedStorageObject struct {
	ID         string `json:"id"`
	URL        string `json:"url"`
	StorageKey string `json:"storageKey"`
	Bytes      int64  `json:"bytes"`
	MimeType   string `json:"mimeType"`
}

type DirectStorageObjectInput struct {
	Provider  StorageObjectProviderInput `json:"provider"`
	ObjectKey string                     `json:"objectKey"`
	MimeType  string                     `json:"mimeType"`
	Bytes     int64                      `json:"bytes"`
}

// DownloadedStorageObject 下载存储对象结果。
type SignedStorageObjectURL struct {
	URL       string `json:"url"`
	ExpiresAt string `json:"expiresAt"`
	MimeType  string `json:"mimeType"`
	Bytes     int64  `json:"bytes"`
}

type DownloadedStorageObject struct {
	Object        model.StorageObject
	Stream        io.ReadCloser
	StatusCode    int
	ContentLength int64
	ContentRange  string
	AcceptRanges  bool
}

type storageObjectStream struct {
	Body          io.ReadCloser
	StatusCode    int
	ContentLength int64
	ContentRange  string
	AcceptRanges  bool
}

// StorageCapacityResult 存储容量统计结果。
type StorageCapacityResult struct {
	Bytes        int64  `json:"bytes"`
	LimitBytes   int64  `json:"limitBytes"`
	OverLimit    bool   `json:"overLimit"`
	CheckedAt    string `json:"checkedAt"`
	ProviderName string `json:"providerName"`
}

const defaultStorageCapacityLimitBytes int64 = 9 * 1024 * 1024 * 1024

var (
	storageCapacityCron *cron.Cron
	storageCapacityOnce sync.Once
	storageCapacityMu   sync.Mutex
)

// HasAdminStorageProvider 检查管理员是否配置了有效的对象存储。
func HasAdminStorageProvider(storage model.PrivateStorageSetting) bool {
	for _, provider := range storage.Providers {
		if provider.Type == model.StorageProviderTypeS3 && provider.Enabled && storageProviderConfigured(provider) {
			return true
		}
	}
	return false
}

func canUseGlobalStorage(ctx context.Context, storage model.PrivateStorageSetting) bool {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" || user.Role == model.UserRoleGuest {
		return false
	}
	return user.Role == model.UserRoleAdmin || storage.AllowUserGlobalProvider
}

// HasActiveCloudStorage 判断当前请求是否有可用的云存储。
func HasActiveCloudStorage(ctx context.Context) (bool, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return false, err
	}
	settings = normalizeSettings(settings)
	storage := normalizePrivateStorageSetting(settings.Private.Storage)
	if canUseGlobalStorage(ctx, storage) && HasAdminStorageProvider(storage) {
		return true, nil
	}
	if storage.AllowUserProvider {
		user, ok := UserFromContext(ctx)
		if ok && user.ID != "" {
			config, found, err := repository.GetUserConfig(user.ID)
			if err == nil && found {
				for _, provider := range userStorageProvidersForOwner(config.StorageProvider, user.ID) {
					if provider.Type == model.StorageProviderTypeS3 && provider.Enabled && storageProviderConfigured(provider) {
						return true, nil
					}
				}
			}
		}
	}
	return false, nil
}

// PublicStorageConfig 返回公开存储配置。
func PublicStorageConfig() (model.PublicStorageConfig, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.PublicStorageConfig{}, err
	}
	settings = normalizeSettings(settings)
	storage := normalizePrivateStorageSetting(settings.Private.Storage)

	mode := "local_indexeddb"
	if HasAdminStorageProvider(storage) {
		mode = "server_sqlite_s3"
	} else if storage.AllowUserProvider {
		mode = "hybrid"
	}

	return model.PublicStorageConfig{PublicStorageSetting: model.PublicStorageSetting{Mode: mode, AllowUserProvider: storage.AllowUserProvider, AllowUserGlobalProvider: storage.AllowUserGlobalProvider}, AutoSyncAllAssets: storage.AutoSyncAllAssets}, nil
}

// StorageObjectInfo 获取存储对象元数据。
func StorageObjectInfo(id string) (model.StorageObject, error) {
	return repository.GetStorageObject(id)
}

// CanReadStorageObject enforces access to private S3 objects before either
// signing or proxying them. Public objects and legacy WebDAV objects retain
// their existing read behavior.
func CanReadStorageObject(ctx context.Context, object model.StorageObject) error {
	provider, ok := StorageProviderForObject(object)
	if object.DeletedAt != "" {
		return errors.New("对象已删除")
	}
	if (ok && provider.Type == model.StorageProviderTypeWebDAV) || (object.PublicURL != "" && (!ok || provider.PublicBaseURL != "")) {
		return nil
	}
	return requireStorageObjectOwner(ctx, object)
}

func requireStorageObjectOwner(ctx context.Context, object model.StorageObject) error {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" || user.Role == model.UserRoleGuest {
		return errors.New("请先登录")
	}
	if object.DeletedAt != "" || (object.CreatedBy != user.ID && user.Role != model.UserRoleAdmin) {
		return errors.New("无权读取该对象")
	}
	return nil
}

func SignedStorageObjectURLForUser(ctx context.Context, id string) (SignedStorageObjectURL, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" || user.Role == model.UserRoleGuest {
		return SignedStorageObjectURL{}, errors.New("请先登录")
	}
	object, err := repository.GetStorageObject(id)
	if err != nil {
		return SignedStorageObjectURL{}, err
	}
	if err := requireStorageObjectOwner(ctx, object); err != nil {
		return SignedStorageObjectURL{}, err
	}
	provider, ok := StorageProviderForObject(object)
	if !ok || provider.Type != model.StorageProviderTypeS3 || provider.PublicBaseURL != "" || !storageProviderConfigured(provider) {
		return SignedStorageObjectURL{}, errors.New("该对象没有可用的私有 S3 存储配置")
	}
	const lifetime = 5 * time.Minute
	if cdnURL, expires, used, err := storageaccess.CDNURL(provider, object.ObjectKey, time.Now()); err != nil {
		return SignedStorageObjectURL{}, errors.New("读取私有 CDN 配置失败")
	} else if used {
		return SignedStorageObjectURL{URL: cdnURL, ExpiresAt: expires.Format(time.RFC3339), MimeType: object.MimeType, Bytes: object.Bytes}, nil
	}
	urlValue, err := presignS3GetURL(provider, object.ObjectKey, lifetime)
	if err != nil {
		return SignedStorageObjectURL{}, err
	}
	return SignedStorageObjectURL{URL: urlValue, ExpiresAt: time.Now().UTC().Add(lifetime).Format(time.RFC3339), MimeType: object.MimeType, Bytes: object.Bytes}, nil
}

// SaveCurrentUserStorageProvider 保存用户配置的存储提供商。
func SaveCurrentUserStorageProvider(ctx context.Context, incoming UserStorageProviders) (UserConfigPayload, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return UserConfigPayload{}, errors.New("请先登录")
	}
	config, _, err := repository.GetUserConfig(user.ID)
	if err != nil {
		return UserConfigPayload{}, err
	}
	providers := readUserStorageProviders(config.StorageProvider)
	if incoming.S3 != nil {
		provider := *incoming.S3
		provider.Type = model.StorageProviderTypeS3
		providers.S3 = &provider
	}
	if incoming.WebDAV != nil {
		provider := *incoming.WebDAV
		provider.Type = model.StorageProviderTypeWebDAV
		providers.WebDAV = &provider
	}
	if err := validateUserStorageProviderTypes(providers); err != nil {
		return UserConfigPayload{}, err
	}
	raw, err := json.Marshal(providers)
	if err != nil {
		return UserConfigPayload{}, err
	}
	current := now()
	if config.UserID == "" {
		config.UserID = user.ID
		config.CreatedAt = current
	}
	config.StorageProvider = string(raw)
	config.UpdatedAt = current
	if _, err := repository.SaveUserConfig(config); err != nil {
		return UserConfigPayload{}, err
	}
	return CurrentUserConfig(ctx)
}

// UploadStorageObject 上传对象到存储。
func UploadStorageObject(ctx context.Context, filename string, contentType string, data []byte) (UploadedStorageObject, error) {
	return UploadStorageObjectWithProvider(ctx, filename, contentType, data, nil)
}

// UploadStorageObjectWithProvider 上传对象到存储（可选用户自定义 Provider）。
func UploadStorageObjectWithProvider(ctx context.Context, filename string, contentType string, data []byte, providerInput *StorageObjectProviderInput) (UploadedStorageObject, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return UploadedStorageObject{}, err
	}
	storage := normalizePrivateStorageSetting(settings.Private.Storage)
	usingUserProvider := providerInput != nil && storage.AllowUserProvider
	var provider model.StorageProvider
	if usingUserProvider {
		provider = normalizeUserStorageProvider(*providerInput, ctx)
		if !provider.Enabled || !storageProviderConfigured(provider) {
			return UploadedStorageObject{}, errors.New("用户对象存储配置不完整")
		}
	} else {
		if !canUseGlobalStorage(ctx, storage) {
			return UploadedStorageObject{}, errors.New("服务端对象存储未启用")
		}
		provider, err = selectStorageProvider(storage)
		if err != nil {
			return UploadedStorageObject{}, errors.New("服务端对象存储未启用")
		}
		if provider.Type != model.StorageProviderTypeS3 || !storageProviderConfigured(provider) {
			return UploadedStorageObject{}, errors.New("服务端必须配置完整的 OSS/S3 存储")
		}
	}
	userID := "anonymous"
	if user, ok := UserFromContext(ctx); ok && user.ID != "" {
		userID = user.ID
	}
	sum := sha256.Sum256(data)
	contentType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	objectID := mediaidentity.Digest(userID, provider.ID, provider.Endpoint, provider.Bucket, provider.PathPrefix, contentType, hex.EncodeToString(sum[:]))
	if userID == "anonymous" {
		objectID = uuid.NewString()
	}
	unlock := mediaidentity.Lock(objectID)
	defer unlock()
	if prior, err := repository.GetStorageObject(objectID); err == nil {
		if prior.DeletedAt != "" {
			return UploadedStorageObject{}, errors.New("该文件已删除")
		}
		return uploadedStorageObject(prior), nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return UploadedStorageObject{}, err
	}
	// Stable path also recovers an OSS success followed by a failed database save.
	objectKey := strings.Trim(strings.Trim(provider.PathPrefix, "/")+"/"+userID+"/ext-media/"+objectID+extensionForContentType(contentType), "/")
	if err := putStorageObject(provider, objectKey, contentType, data); err != nil {
		return UploadedStorageObject{}, err
	}
	publicURL := objectURL(provider, objectKey)
	object := model.StorageObject{
		ID: objectID, ProviderID: provider.ID, Bucket: provider.Bucket, ObjectKey: objectKey, PublicURL: publicURL,
		MimeType: contentType, Bytes: int64(len(data)), SHA256: hex.EncodeToString(sum[:]), CreatedBy: userID, CreatedAt: now(),
	}
	if _, err := repository.SaveStorageObject(object); err != nil {
		return UploadedStorageObject{}, err
	}
	return uploadedStorageObject(object), nil
}

func uploadedStorageObject(object model.StorageObject) UploadedStorageObject {
	u := "/api/files/" + object.ID + "/content"
	if object.PublicURL != "" {
		u = object.PublicURL
	}
	return UploadedStorageObject{ID: object.ID, URL: u, StorageKey: "server:" + object.ID, Bytes: object.Bytes, MimeType: object.MimeType}
}

// RegisterDirectStorageObject 登记浏览器已直传至用户 WebDAV 的对象。
func RegisterDirectStorageObject(ctx context.Context, input DirectStorageObjectInput) (UploadedStorageObject, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" || user.Role == model.UserRoleGuest {
		return UploadedStorageObject{}, errors.New("请先登录")
	}
	settings, err := repository.GetSettings()
	if err != nil {
		return UploadedStorageObject{}, err
	}
	storage := normalizePrivateStorageSetting(settings.Private.Storage)
	if !storage.AllowUserProvider || input.Provider.Type != model.StorageProviderTypeWebDAV {
		return UploadedStorageObject{}, errors.New("用户 WebDAV 未启用")
	}
	provider := normalizeUserStorageProvider(input.Provider, ctx)
	if !provider.Enabled || !storageProviderConfigured(provider) {
		return UploadedStorageObject{}, errors.New("用户 WebDAV 配置不完整")
	}
	objectKey, err := cleanStoragePath(input.ObjectKey)
	if err != nil {
		return UploadedStorageObject{}, err
	}
	prefix := strings.Trim(path.Join(provider.PathPrefix, user.ID), "/") + "/"
	if !strings.HasPrefix(objectKey, prefix) {
		return UploadedStorageObject{}, errors.New("WebDAV 对象路径无效")
	}
	contentType := strings.TrimSpace(input.MimeType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if input.Bytes < 0 {
		return UploadedStorageObject{}, errors.New("文件大小无效")
	}
	objectID := uuid.NewString()
	object := model.StorageObject{
		ID: objectID, ProviderID: provider.ID, ObjectKey: objectKey, MimeType: contentType,
		Bytes: input.Bytes, Direct: true, CreatedBy: user.ID, CreatedAt: now(),
	}
	if _, err := repository.SaveStorageObject(object); err != nil {
		return UploadedStorageObject{}, err
	}
	return UploadedStorageObject{
		ID: objectID, URL: "/api/files/" + objectID + "/content?direct=1", StorageKey: "server:" + objectID,
		Bytes: input.Bytes, MimeType: contentType,
	}, nil
}

// DeleteStorageObject 删除存储对象。
func DeleteStorageObject(ctx context.Context, id string, providerInput *StorageObjectProviderInput) error {
	object, err := repository.GetStorageObject(id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	if user, ok := UserFromContext(ctx); ok && object.CreatedBy != "" && object.CreatedBy != user.ID {
		return errors.New("无权删除该对象")
	}
	settings, err := repository.GetSettings()
	if err != nil {
		return err
	}
	storage := normalizePrivateStorageSetting(settings.Private.Storage)
	providers := storage.Providers
	if object.CreatedBy != "" && object.CreatedBy != "anonymous" {
		if config, found, loadErr := repository.GetUserConfig(object.CreatedBy); loadErr == nil && found {
			providers = append(userStorageProvidersForOwner(config.StorageProvider, object.CreatedBy), providers...)
		}
	}
	if providerInput != nil && storage.AllowUserProvider {
		providers = append([]model.StorageProvider{normalizeUserStorageProvider(*providerInput, ctx)}, providers...)
	}
	provider, ok := findStorageProviderForObject(object, providers)
	if !ok {
		return errors.New("对象存储配置不存在")
	}
	if err := deleteStorageObjectData(provider, object.ObjectKey); err != nil {
		return err
	}
	return repository.DeleteStorageObjectRecord(id)
}

// DeleteDirectStorageObjectRecord 删除已由浏览器直接删除的 WebDAV 对象索引。
func DeleteDirectStorageObjectRecord(ctx context.Context, id string) error {
	object, err := repository.GetStorageObject(id)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" || object.CreatedBy != user.ID || !object.Direct {
		return errors.New("无权删除该对象记录")
	}
	return repository.DeleteStorageObjectRecord(id)
}

// MeasureUserStorageProvider 统计用户存储提供商的已用容量。
func MeasureUserStorageProvider(ctx context.Context, providerInput StorageObjectProviderInput) (StorageCapacityResult, error) {
	provider := normalizeUserStorageProvider(providerInput, ctx)
	bytes, err := measureStorageProvider(provider)
	if err != nil {
		return StorageCapacityResult{}, err
	}
	checkedAt := now()
	return StorageCapacityResult{Bytes: bytes, LimitBytes: defaultStorageCapacityLimitBytes, OverLimit: bytes >= defaultStorageCapacityLimitBytes, CheckedAt: checkedAt, ProviderName: provider.Name}, nil
}

// MeasureAdminStorageProvider 管理员统计存储容量。
func MeasureAdminStorageProvider(index int, providerInput *model.StorageProvider) (StorageCapacityResult, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return StorageCapacityResult{}, err
	}
	settings = normalizeSettings(settings)
	storage := settings.Private.Storage
	if index < 0 || index >= len(storage.Providers) {
		return StorageCapacityResult{}, errors.New("对象存储配置不存在")
	}
	provider := storage.Providers[index]
	if providerInput != nil {
		provider = normalizeStorageProvider(*providerInput)
		provider.SecretAccessKey = storage.Providers[index].SecretAccessKey
		provider.Password = storage.Providers[index].Password
		if strings.TrimSpace(providerInput.SecretAccessKey) != "" {
			provider.SecretAccessKey = providerInput.SecretAccessKey
		}
		if strings.TrimSpace(providerInput.Password) != "" {
			provider.Password = providerInput.Password
		}
	}
	bytes, err := measureStorageProvider(provider)
	if err != nil {
		return StorageCapacityResult{}, err
	}
	checkedAt := now()
	limit := storage.CapacityLimitBytes
	if limit <= 0 {
		limit = defaultStorageCapacityLimitBytes
	}
	provider.CapacityBytes = bytes
	provider.CapacityCheckedAt = checkedAt
	provider.CapacityExceeded = bytes >= limit
	if provider.CapacityExceeded {
		provider.Enabled = false
	}
	storage.Providers[index] = provider
	settings.Private.Storage = storage
	if _, err := repository.SaveSettings(settings, now()); err != nil {
		return StorageCapacityResult{}, err
	}
	return StorageCapacityResult{Bytes: bytes, LimitBytes: limit, OverLimit: provider.CapacityExceeded, CheckedAt: checkedAt, ProviderName: provider.Name}, nil
}

// MeasureAllEnabledStorageProviders 统计所有启用的存储提供商的容量。
func MeasureAllEnabledStorageProviders() {
	settings, err := repository.GetSettings()
	if err != nil {
		log.Printf("storage capacity settings load failed err=%v", err)
		return
	}
	settings = normalizeSettings(settings)
	storage := settings.Private.Storage
	changed := false
	for i, provider := range storage.Providers {
		if !provider.Enabled {
			continue
		}
		bytes, err := measureStorageProvider(provider)
		if err != nil {
			log.Printf("storage capacity measure failed provider=%s err=%v", provider.Name, err)
			continue
		}
		provider.CapacityBytes = bytes
		provider.CapacityCheckedAt = now()
		provider.CapacityExceeded = bytes >= storage.CapacityLimitBytes
		if provider.CapacityExceeded {
			provider.Enabled = false
		}
		storage.Providers[i] = provider
		changed = true
	}
	if changed {
		settings.Private.Storage = storage
		if _, err := repository.SaveSettings(settings, now()); err != nil {
			log.Printf("storage capacity settings save failed err=%v", err)
		}
	}
}

// StartStorageCapacityScheduler 启动存储容量定时统计。
func StartStorageCapacityScheduler() {
	storageCapacityOnce.Do(func() {
		storageCapacityCron = cron.New()
		storageCapacityCron.Start()
	})
	RefreshStorageCapacityScheduler()
}

// RefreshStorageCapacityScheduler 刷新存储容量定时统计计划。
func RefreshStorageCapacityScheduler() {
	storageCapacityMu.Lock()
	defer storageCapacityMu.Unlock()
	if storageCapacityCron == nil {
		return
	}
	for _, entry := range storageCapacityCron.Entries() {
		storageCapacityCron.Remove(entry.ID)
	}
	settings, err := repository.GetSettings()
	if err != nil {
		log.Printf("load storage capacity setting failed err=%v", err)
		return
	}
	setting := normalizePrivateStorageSetting(settings.Private.Storage).CapacityCheck
	if setting.Enabled == nil || !*setting.Enabled {
		return
	}
	if _, err := storageCapacityCron.AddFunc(setting.Cron, MeasureAllEnabledStorageProviders); err != nil {
		log.Printf("add storage capacity cron failed cron=%s err=%v", setting.Cron, err)
	}
}

// DownloadStorageObject 下载存储对象内容。
func DownloadStorageObject(id string, rangeHeader string) (DownloadedStorageObject, error) {
	object, err := repository.GetStorageObject(id)
	if err != nil {
		return DownloadedStorageObject{}, err
	}

	if provider, ok := StorageProviderForObject(object); ok && storageProviderConfigured(provider) {
		var stream storageObjectStream
		var readErr error
		switch provider.Type {
		case model.StorageProviderTypeS3:
			stream, readErr = getS3ObjectStream(provider, object.ObjectKey, rangeHeader)
		case model.StorageProviderTypeWebDAV:
			stream, readErr = getWebDAVObjectStream(provider, object.ObjectKey, object.Bytes, rangeHeader)
		}
		if readErr == nil && stream.Body != nil {
			return downloadedStorageObject(object, stream), nil
		}
	}

	return downloadPublicStorageObject(object, rangeHeader)
}

// StorageProviderForObject resolves the existing object's owner and global storage configuration.
func StorageProviderForObject(object model.StorageObject) (model.StorageProvider, bool) {
	providers := []model.StorageProvider{}
	if object.CreatedBy != "" && object.CreatedBy != "anonymous" {
		if config, found, loadErr := repository.GetUserConfig(object.CreatedBy); loadErr == nil && found {
			providers = append(providers, userStorageProvidersForOwner(config.StorageProvider, object.CreatedBy)...)
		}
	}
	if settings, loadErr := repository.GetSettings(); loadErr == nil {
		providers = append(providers, normalizePrivateStorageSetting(settings.Private.Storage).Providers...)
	}
	return findStorageProviderForObject(object, providers)
}

func downloadPublicStorageObject(object model.StorageObject, rangeHeader string) (DownloadedStorageObject, error) {
	if object.PublicURL != "" {
		request, err := http.NewRequest(http.MethodGet, object.PublicURL, nil)
		if err != nil {
			return DownloadedStorageObject{}, err
		}
		if strings.TrimSpace(rangeHeader) != "" {
			request.Header.Set("Range", rangeHeader)
		}
		response, err := SafeProxyHTTPClient().Do(request)
		if err != nil {
			return DownloadedStorageObject{}, err
		}
		if !storageDownloadStatus(response.StatusCode) {
			body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
			_ = response.Body.Close()
			return DownloadedStorageObject{}, fmt.Errorf("对象存储读取失败: %s %s", response.Status, string(body))
		}
		return downloadedStorageObject(object, httpStorageObjectStream(response, response.Header.Get("Accept-Ranges") != "")), nil
	}

	return DownloadedStorageObject{}, errors.New("无法读取对象存储文件")
}

func downloadedStorageObject(object model.StorageObject, stream storageObjectStream) DownloadedStorageObject {
	return DownloadedStorageObject{
		Object: object, Stream: stream.Body, StatusCode: stream.StatusCode,
		ContentLength: stream.ContentLength, ContentRange: stream.ContentRange, AcceptRanges: stream.AcceptRanges,
	}
}

func httpStorageObjectStream(response *http.Response, acceptRanges bool) storageObjectStream {
	return storageObjectStream{
		Body: response.Body, StatusCode: response.StatusCode, ContentLength: response.ContentLength,
		ContentRange: response.Header.Get("Content-Range"), AcceptRanges: acceptRanges,
	}
}

func storageDownloadStatus(status int) bool {
	return status >= 200 && status < 300 || status == http.StatusRequestedRangeNotSatisfiable
}

type storageByteRange struct {
	offset int64
	length int64
}

func parseStorageByteRange(value string, size int64) (storageByteRange, bool) {
	value = strings.TrimSpace(value)
	if size <= 0 || !strings.HasPrefix(strings.ToLower(value), "bytes=") {
		return storageByteRange{}, false
	}
	value = strings.TrimSpace(value[len("bytes="):])
	if value == "" || strings.Contains(value, ",") {
		return storageByteRange{}, false
	}
	parts := strings.SplitN(value, "-", 2)
	if len(parts) != 2 {
		return storageByteRange{}, false
	}
	if parts[0] == "" {
		suffix, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || suffix <= 0 {
			return storageByteRange{}, false
		}
		if suffix > size {
			suffix = size
		}
		return storageByteRange{offset: size - suffix, length: suffix}, true
	}
	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 || start >= size {
		return storageByteRange{}, false
	}
	end := size - 1
	if parts[1] != "" {
		end, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil || end < start {
			return storageByteRange{}, false
		}
		if end >= size {
			end = size - 1
		}
	}
	return storageByteRange{offset: start, length: end - start + 1}, true
}

// Explicit defaults never fail over to another provider. Legacy installs use list order.
func selectStorageProvider(storage model.PrivateStorageSetting) (model.StorageProvider, error) {
	defaultID, err := storageaccess.DefaultUploadID()
	if err != nil {
		return model.StorageProvider{}, err
	}
	for _, provider := range storage.Providers {
		if defaultID != "" && provider.ID != defaultID {
			continue
		}
		if provider.Type == model.StorageProviderTypeS3 && provider.Enabled && !provider.CapacityExceeded && storageProviderConfigured(provider) {
			return provider, nil
		}
	}
	if defaultID != "" {
		return model.StorageProvider{}, errors.New("默认上传位置不可用，请检查是否启用、容量及连接配置")
	}
	return model.StorageProvider{}, errors.New("没有可用对象存储配置")
}

func storageProviderConfigured(provider model.StorageProvider) bool {
	if provider.Endpoint == "" {
		return false
	}
	switch provider.Type {
	case model.StorageProviderTypeS3:
		return provider.Bucket != "" && provider.AccessKeyID != "" && provider.SecretAccessKey != ""
	case model.StorageProviderTypeWebDAV:
		return provider.Username != "" && provider.Password != ""
	default:
		return false
	}
}

func putStorageObject(provider model.StorageProvider, objectKey string, contentType string, data []byte) error {
	switch provider.Type {
	case model.StorageProviderTypeS3:
		return putS3Object(provider, objectKey, contentType, data)
	case model.StorageProviderTypeWebDAV:
		return putWebDAVObject(provider, objectKey, data)
	default:
		return errors.New("存储类型不支持")
	}
}

func deleteStorageObjectData(provider model.StorageProvider, objectKey string) error {
	switch provider.Type {
	case model.StorageProviderTypeS3:
		return deleteS3Object(provider, objectKey)
	case model.StorageProviderTypeWebDAV:
		return deleteWebDAVObject(provider, objectKey)
	default:
		return errors.New("存储类型不支持")
	}
}

func measureStorageProvider(provider model.StorageProvider) (int64, error) {
	switch provider.Type {
	case model.StorageProviderTypeS3:
		return measureS3Provider(provider)
	case model.StorageProviderTypeWebDAV:
		return measureWebDAVProvider(provider)
	default:
		return 0, errors.New("存储类型不支持")
	}
}

// putS3Object 上传对象到 S3 兼容存储。
func putS3Object(provider model.StorageProvider, objectKey string, contentType string, data []byte) error {
	request, err := newS3Request(http.MethodPut, provider, objectKey, bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", contentType)
	response, err := SafeProxyHTTPClient().Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("对象存储上传失败: %s %s", response.Status, string(body))
	}
	return nil
}

// getS3ObjectStream 从 S3 兼容存储流式读取对象。
func getS3ObjectStream(provider model.StorageProvider, objectKey string, rangeHeader string) (storageObjectStream, error) {
	request, err := newS3Request(http.MethodGet, provider, objectKey, nil, 0)
	if err != nil {
		return storageObjectStream{}, err
	}
	if strings.TrimSpace(rangeHeader) != "" {
		request.Header.Set("Range", rangeHeader)
	}
	response, err := SafeProxyHTTPClient().Do(request)
	if err != nil {
		return storageObjectStream{}, err
	}
	if !storageDownloadStatus(response.StatusCode) {
		_ = response.Body.Close()
		return storageObjectStream{}, fmt.Errorf("对象读取失败: %s", response.Status)
	}
	return httpStorageObjectStream(response, true), nil
}

// deleteS3Object 从 S3 兼容存储删除对象。
func deleteS3Object(provider model.StorageProvider, objectKey string) error {
	request, err := newS3Request(http.MethodDelete, provider, objectKey, nil, 0)
	if err != nil {
		return err
	}
	response, err := SafeProxyHTTPClient().Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("对象存储删除失败: %s %s", response.Status, string(body))
	}
	return nil
}

// measureS3Provider 统计 S3 存储桶的总容量。
func measureS3Provider(provider model.StorageProvider) (int64, error) {
	if provider.Endpoint == "" || provider.Bucket == "" || provider.AccessKeyID == "" || provider.SecretAccessKey == "" {
		return 0, errors.New("对象存储配置不完整")
	}
	var total int64
	var token string
	for {
		query := url.Values{}
		query.Set("list-type", "2")
		if token != "" {
			query.Set("continuation-token", token)
		}
		request, err := newS3RequestWithQuery(http.MethodGet, provider, "", query, nil, 0)
		if err != nil {
			return 0, err
		}
		response, err := SafeProxyHTTPClient().Do(request)
		if err != nil {
			return 0, err
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 32*1024*1024))
		_ = response.Body.Close()
		if readErr != nil {
			return 0, readErr
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return 0, fmt.Errorf("对象存储容量统计失败: %s %s", response.Status, string(body))
		}
		var result listBucketResult
		if err := xml.Unmarshal(body, &result); err != nil {
			return 0, err
		}
		for _, item := range result.Contents {
			total += item.Size
		}
		if !result.IsTruncated || strings.TrimSpace(result.NextContinuationToken) == "" {
			return total, nil
		}
		token = result.NextContinuationToken
	}
}

func newS3Request(method string, provider model.StorageProvider, objectKey string, body io.Reader, contentLength int64) (*http.Request, error) {
	return newS3RequestWithQuery(method, provider, objectKey, nil, body, contentLength)
}

func newS3RequestWithQuery(method string, provider model.StorageProvider, objectKey string, query url.Values, body io.Reader, contentLength int64) (*http.Request, error) {
	endpoint, err := s3compat.ObjectURL(provider.Endpoint, provider.Bucket, objectKey)
	if err != nil {
		return nil, err
	}
	if query != nil {
		endpoint.RawQuery = query.Encode()
	}
	request, err := http.NewRequest(method, endpoint.String(), body)
	if err != nil {
		return nil, err
	}
	if contentLength > 0 {
		request.ContentLength = contentLength
	}
	signS3Request(request, provider)
	return request, nil
}

func presignS3GetURL(provider model.StorageProvider, objectKey string, lifetime time.Duration) (string, error) {
	if provider.Type != model.StorageProviderTypeS3 {
		return "", errors.New("仅支持 S3 存储签名")
	}
	if lifetime <= 0 || lifetime > 5*time.Minute {
		return "", errors.New("签名 URL 有效期无效")
	}
	if provider.AccessKeyID == "" || provider.SecretAccessKey == "" || provider.Bucket == "" || provider.Endpoint == "" || objectKey == "" {
		return "", errors.New("S3 签名配置不完整")
	}
	endpoint, err := s3compat.ObjectURL(provider.Endpoint, provider.Bucket, objectKey)
	if err != nil {
		return "", err
	}
	region := provider.Region
	if region == "" {
		region = "auto"
	}
	request, err := http.NewRequest(http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return "", err
	}
	query := request.URL.Query()
	query.Set("X-Amz-Expires", strconv.FormatInt(int64(lifetime/time.Second), 10))
	request.URL.RawQuery = query.Encode()
	signer := awsSigner.NewSigner(func(options *awsSigner.SignerOptions) { options.DisableURIPathEscaping = true })
	credentialsValue := aws.Credentials{AccessKeyID: provider.AccessKeyID, SecretAccessKey: provider.SecretAccessKey}
	signedURL, _, err := signer.PresignHTTP(context.Background(), credentialsValue, request, "UNSIGNED-PAYLOAD", "s3", region, time.Now().UTC())
	if err != nil {
		return "", err
	}
	return signedURL, nil
}

func signS3Request(request *http.Request, provider model.StorageProvider) {
	nowTime := time.Now().UTC()
	amzDate := nowTime.Format("20060102T150405Z")
	dateStamp := nowTime.Format("20060102")
	payloadHash := "UNSIGNED-PAYLOAD"
	region := provider.Region
	if region == "" {
		region = "auto"
	}
	request.Header.Set("Host", request.URL.Host)
	request.Header.Set("X-Amz-Date", amzDate)
	request.Header.Set("X-Amz-Content-Sha256", payloadHash)
	canonicalURI := request.URL.EscapedPath()
	canonicalHeaders := "host:" + request.URL.Host + "\n" + "x-amz-content-sha256:" + payloadHash + "\n" + "x-amz-date:" + amzDate + "\n"
	signedHeaders := "host;x-amz-content-sha256;x-amz-date"
	canonicalRequest := request.Method + "\n" + canonicalURI + "\n" + request.URL.RawQuery + "\n" + canonicalHeaders + "\n" + signedHeaders + "\n" + payloadHash
	scope := dateStamp + "/" + region + "/s3/aws4_request"
	stringToSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + sha256Hex([]byte(canonicalRequest))
	signature := hex.EncodeToString(hmacSHA256(signingKey(provider.SecretAccessKey, dateStamp, region), []byte(stringToSign)))
	request.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+provider.AccessKeyID+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+signature)
}

func signingKey(secret string, dateStamp string, region string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secret), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte("s3"))
	return hmacSHA256(kService, []byte("aws4_request"))
}

func hmacSHA256(key []byte, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func objectURL(provider model.StorageProvider, objectKey string) string {
	if provider.PublicBaseURL == "" {
		return ""
	}
	return strings.TrimRight(provider.PublicBaseURL, "/") + "/" + strings.TrimLeft(objectKey, "/")
}

func normalizeUserStorageProvider(input StorageObjectProviderInput, ctx context.Context) model.StorageProvider {
	owner := "anonymous"
	if user, ok := UserFromContext(ctx); ok && user.ID != "" {
		owner = user.ID
	}
	return normalizeUserStorageProviderForOwner(input, owner)
}

func normalizeUserStorageProviderForOwner(input StorageObjectProviderInput, owner string) model.StorageProvider {
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	return normalizeStorageProvider(model.StorageProvider{
		Name:            input.Name,
		Type:            input.Type,
		Endpoint:        input.Endpoint,
		Region:          input.Region,
		Bucket:          input.Bucket,
		AccessKeyID:     input.AccessKeyID,
		SecretAccessKey: input.SecretAccessKey,
		PublicBaseURL:   input.PublicBaseURL,
		PathPrefix:      input.PathPrefix,
		Username:        input.Username,
		Password:        input.Password,
		Weight:          1,
		Enabled:         enabled,
		OwnerUserID:     owner,
	})
}

func userStorageProvidersForOwner(raw string, owner string) []model.StorageProvider {
	inputs := readUserStorageProviders(raw)
	providers := make([]model.StorageProvider, 0, 2)
	if inputs.S3 != nil {
		input := *inputs.S3
		input.Type = model.StorageProviderTypeS3
		providers = append(providers, normalizeUserStorageProviderForOwner(input, owner))
	}
	if inputs.WebDAV != nil {
		input := *inputs.WebDAV
		input.Type = model.StorageProviderTypeWebDAV
		providers = append(providers, normalizeUserStorageProviderForOwner(input, owner))
	}
	return providers
}

func validateUserStorageProviderTypes(providers UserStorageProviders) error {
	s3Enabled := providers.S3 != nil && (providers.S3.Enabled == nil || *providers.S3.Enabled)
	webDAVEnabled := providers.WebDAV != nil && (providers.WebDAV.Enabled == nil || *providers.WebDAV.Enabled)
	if s3Enabled && webDAVEnabled {
		return safeMessageError{message: "S3/R2 与 WebDAV 不能同时启用"}
	}
	return nil
}

func findStorageProviderForObject(object model.StorageObject, providers []model.StorageProvider) (model.StorageProvider, bool) {
	for _, provider := range providers {
		if object.ProviderID != "" && provider.ID == object.ProviderID {
			return provider, true
		}
		if object.Bucket != "" && provider.Bucket == object.Bucket {
			if object.PublicURL == "" || provider.PublicBaseURL == "" || strings.HasPrefix(object.PublicURL, strings.TrimRight(provider.PublicBaseURL, "/")+"/") {
				return provider, true
			}
		}
	}
	return model.StorageProvider{}, false
}

type listBucketResult struct {
	XMLName               xml.Name `xml:"ListBucketResult"`
	IsTruncated           bool     `xml:"IsTruncated"`
	NextContinuationToken string   `xml:"NextContinuationToken"`
	Contents              []struct {
		Size int64 `xml:"Size"`
	} `xml:"Contents"`
}

func extensionForContentType(contentType string) string {
	switch strings.ToLower(strings.Split(contentType, ";")[0]) {
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/png":
		return ".png"
	default:
		return ".bin"
	}
}
