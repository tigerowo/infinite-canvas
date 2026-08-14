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
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/robfig/cron/v3"
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

// DownloadedStorageObject 下载存储对象结果。
type DownloadedStorageObject struct {
	Object      model.StorageObject
	Data        []byte
	RedirectURL string
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
		if provider.Enabled && storageProviderConfigured(provider) {
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
					if provider.Enabled && storageProviderConfigured(provider) {
						return true, nil
					}
				}
			}
		}
	}
	return false, nil
}

// PublicStorageConfig 返回公开存储配置。
func PublicStorageConfig() (model.PublicStorageSetting, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.PublicStorageSetting{}, err
	}
	settings = normalizeSettings(settings)
	storage := normalizePrivateStorageSetting(settings.Private.Storage)

	mode := "local_indexeddb"
	if HasAdminStorageProvider(storage) {
		mode = "server_sqlite_s3"
	} else if storage.AllowUserProvider {
		mode = "hybrid"
	}

	return model.PublicStorageSetting{Mode: mode, AllowUserProvider: storage.AllowUserProvider, AllowUserGlobalProvider: storage.AllowUserGlobalProvider}, nil
}

// StorageObjectInfo 获取存储对象元数据。
func StorageObjectInfo(id string) (model.StorageObject, error) {
	return repository.GetStorageObject(id)
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
	}
	objectID := uuid.NewString()
	ext := path.Ext(filename)
	if ext == "" {
		ext = extensionForContentType(contentType)
	}
	userID := "anonymous"
	if user, ok := UserFromContext(ctx); ok && user.ID != "" {
		userID = user.ID
	}
	nowTime := time.Now()
	objectKey := strings.Trim(strings.Trim(provider.PathPrefix, "/")+"/"+userID+"/"+nowTime.Format("2006/01/02")+"/"+objectID+ext, "/")
	sum := sha256.Sum256(data)
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
	// Always expose same-origin content URL to browsers. PublicBaseURL may point at
	// private WebDAV/S3 endpoints that <img>/<video> cannot authenticate against.
	url := "/api/files/" + objectID + "/content"
	return UploadedStorageObject{ID: objectID, URL: url, StorageKey: "server:" + objectID, Bytes: int64(len(data)), MimeType: contentType}, nil
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
func DownloadStorageObject(id string) (DownloadedStorageObject, error) {
	object, err := repository.GetStorageObject(id)
	if err != nil {
		return DownloadedStorageObject{}, err
	}

	providers := []model.StorageProvider{}
	if object.CreatedBy != "" && object.CreatedBy != "anonymous" {
		if config, found, loadErr := repository.GetUserConfig(object.CreatedBy); loadErr == nil && found {
			providers = append(providers, userStorageProvidersForOwner(config.StorageProvider, object.CreatedBy)...)
		}
	}
	if settings, loadErr := repository.GetSettings(); loadErr == nil {
		providers = append(providers, normalizePrivateStorageSetting(settings.Private.Storage).Providers...)
	}
	if provider, ok := findStorageProviderForObject(object, providers); ok && storageProviderConfigured(provider) {
		if data, readErr := getStorageObject(provider, object.ObjectKey); readErr == nil {
			return DownloadedStorageObject{Object: object, Data: data}, nil
		}
	}

	if object.PublicURL != "" {
		request, err := http.NewRequest(http.MethodGet, object.PublicURL, nil)
		if err != nil {
			return DownloadedStorageObject{}, err
		}
		response, err := SafeProxyHTTPClient().Do(request)
		if err != nil {
			return DownloadedStorageObject{}, err
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
			return DownloadedStorageObject{}, fmt.Errorf("对象存储读取失败: %s %s", response.Status, string(body))
		}
		data, err := io.ReadAll(response.Body)
		if err != nil {
			return DownloadedStorageObject{}, err
		}
		return DownloadedStorageObject{Object: object, Data: data}, nil
	}

	return DownloadedStorageObject{}, errors.New("无法读取对象存储文件")
}

// selectStorageProvider 按权重选择一个启用的存储提供商。
func selectStorageProvider(storage model.PrivateStorageSetting) (model.StorageProvider, error) {
	var candidates []model.StorageProvider
	for _, provider := range storage.Providers {
		if provider.Enabled && storageProviderConfigured(provider) {
			for i := 0; i < provider.Weight; i++ {
				candidates = append(candidates, provider)
			}
		}
	}
	if len(candidates) == 0 {
		return model.StorageProvider{}, errors.New("没有可用对象存储配置")
	}
	return candidates[int(time.Now().UnixNano())%len(candidates)], nil
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

func getStorageObject(provider model.StorageProvider, objectKey string) ([]byte, error) {
	switch provider.Type {
	case model.StorageProviderTypeS3:
		return getS3Object(provider, objectKey)
	case model.StorageProviderTypeWebDAV:
		return getWebDAVObject(provider, objectKey)
	default:
		return nil, errors.New("存储类型不支持")
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

// getS3Object 从 S3 兼容存储下载对象。
func getS3Object(provider model.StorageProvider, objectKey string) ([]byte, error) {
	request, err := newS3Request(http.MethodGet, provider, objectKey, nil, 0)
	if err != nil {
		return nil, err
	}
	response, err := SafeProxyHTTPClient().Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("对象读取失败: %s", response.Status)
	}
	return io.ReadAll(response.Body)
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
	endpoint, err := url.Parse(strings.TrimRight(provider.Endpoint, "/"))
	if err != nil {
		return nil, err
	}
	escapedKey := strings.TrimLeft(objectKey, "/")
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/" + provider.Bucket + "/" + escapedKey
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
	signS3Request(request, provider, escapedKey)
	return request, nil
}

func signS3Request(request *http.Request, provider model.StorageProvider, objectKey string) {
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
	canonicalURI := "/" + provider.Bucket + "/" + strings.ReplaceAll(url.PathEscape(objectKey), "%2F", "/")
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
