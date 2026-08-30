package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

// StorageConfig 返回公开存储配置。
func StorageConfig(w http.ResponseWriter, r *http.Request) {
	config, err := service.PublicStorageConfig()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, config)
}

// SaveUserStorageProvider 保存用户配置的存储提供商。
func SaveUserStorageProvider(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Provider service.UserStorageProviders `json:"provider"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "配置内容格式错误")
		return
	}
	config, err := service.SaveCurrentUserStorageProvider(r.Context(), request.Provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, config)
}

// MeasureUserStorageProvider 统计用户存储提供商的已用容量。
func MeasureUserStorageProvider(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Provider service.StorageObjectProviderInput `json:"provider"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "配置内容格式错误")
		return
	}
	result, err := service.MeasureUserStorageProvider(r.Context(), request.Provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

// UploadFile 上传文件到对象存储。
func UploadFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, storageUploadRequestMaxBytes)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		Fail(w, "上传文件超过 256 MiB 限制或格式不正确")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		Fail(w, "请选择要上传的文件")
		return
	}
	defer file.Close()
	data, err := readLimitedRequestBody(file, "上传文件", storageUploadMaxBytes)
	if err != nil {
		FailError(w, err)
		return
	}
	contentType := header.Header.Get("Content-Type")
	if strings.TrimSpace(contentType) == "" {
		contentType = http.DetectContentType(data)
	}
	var provider *service.StorageObjectProviderInput
	if raw := strings.TrimSpace(r.FormValue("provider")); raw != "" {
		var parsed service.StorageObjectProviderInput
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			Fail(w, "用户对象存储配置格式错误")
			return
		}
		provider = &parsed
	}
	object, err := service.UploadStorageObjectWithProvider(r.Context(), header.Filename, contentType, data, provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, object)
}

// RegisterDirectFile 登记浏览器已直传至用户 WebDAV 的文件。
func RegisterDirectFile(w http.ResponseWriter, r *http.Request) {
	var request service.DirectStorageObjectInput
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "文件信息格式错误")
		return
	}
	object, err := service.RegisterDirectStorageObject(r.Context(), request)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, object)
}

// DeleteFile 删除文件。
func DeleteFile(w http.ResponseWriter, r *http.Request, id string) {
	var request struct {
		Provider *service.StorageObjectProviderInput `json:"provider"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&request)
	}
	if err := service.DeleteStorageObject(r.Context(), id, request.Provider); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

// DeleteDirectFileRecord 删除浏览器已直接删除的 WebDAV 文件索引。
func DeleteDirectFileRecord(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeleteDirectStorageObjectRecord(r.Context(), id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

// FileContent 获取文件内容。
func FileContent(w http.ResponseWriter, r *http.Request, id string) {
	download, err := service.DownloadStorageObject(id, r.Header.Get("Range"))
	if err != nil {
		FailError(w, err)
		return
	}
	defer download.Stream.Close()
	w.Header().Set("Content-Type", download.Object.MimeType)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	if download.AcceptRanges {
		w.Header().Set("Accept-Ranges", "bytes")
	}
	if download.ContentRange != "" {
		w.Header().Set("Content-Range", download.ContentRange)
	}
	if download.ContentLength >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(download.ContentLength, 10))
	}
	if download.StatusCode != 0 {
		w.WriteHeader(download.StatusCode)
	}
	_, _ = io.Copy(w, download.Stream)
}

// FileInfo 获取文件元数据。
func FileInfo(w http.ResponseWriter, r *http.Request, id string) {
	object, err := service.StorageObjectInfo(id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, object)
}

// AdminMeasureStorageProvider 管理员统计存储容量。
func AdminMeasureStorageProvider(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Index    int                    `json:"index"`
		Provider *model.StorageProvider `json:"provider"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "配置内容格式错误")
		return
	}
	result, err := service.MeasureAdminStorageProvider(r.Context(), request.Index, request.Provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

// ProxyImage 代理图片请求（解决跨域和机器人检测问题）。
func ProxyImage(w http.ResponseWriter, r *http.Request) {
	const maxProxyImageBytes = 25 * 1024 * 1024
	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		Fail(w, "url 参数不能为空")
		return
	}
	if !strings.HasPrefix(targetURL, "http://") && !strings.HasPrefix(targetURL, "https://") {
		Fail(w, "无效的 url")
		return
	}
	client := service.SafeProxyHTTPClient()
	req, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		FailError(w, err)
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	req.Header.Set("Cache-Control", "no-cache")
	req.Header.Set("Pragma", "no-cache")

	resp, err := client.Do(req)
	if err != nil {
		FailWithStatus(w, http.StatusBadGateway, "代理图片请求失败")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		FailWithStatus(w, http.StatusBadGateway, "代理图片请求失败: "+resp.Status)
		return
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	if !strings.HasPrefix(contentType, "image/") || contentType == "image/svg+xml" {
		FailWithStatus(w, http.StatusBadGateway, "代理地址没有返回安全图片")
		return
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxProxyImageBytes+1))
	if err != nil {
		FailWithStatus(w, http.StatusBadGateway, "代理图片请求失败")
		return
	}
	if len(data) > maxProxyImageBytes {
		FailWithStatus(w, http.StatusBadGateway, "代理图片超过 25 MiB 限制")
		return
	}
	detected := strings.ToLower(http.DetectContentType(data))
	if strings.HasPrefix(detected, "text/html") || strings.Contains(detected, "xml") {
		FailWithStatus(w, http.StatusBadGateway, "代理地址没有返回安全图片")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(data)
}

// ProxyMedia 代理远端视频和音频请求，供下载及对象存储同步使用。
func ProxyMedia(w http.ResponseWriter, r *http.Request) {
	proxyMedia(w, r, service.SafeProxyHTTPClient(), storageUploadMaxBytes)
}

func proxyMedia(w http.ResponseWriter, r *http.Request, client *http.Client, maxBytes int64) {
	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		Fail(w, "url 参数不能为空")
		return
	}
	if !strings.HasPrefix(targetURL, "http://") && !strings.HasPrefix(targetURL, "https://") {
		Fail(w, "无效的 url")
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, targetURL, nil)
	if err != nil {
		FailError(w, err)
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "video/mp4,video/*,audio/*,application/octet-stream;q=0.8,*/*;q=0.5")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	req.Header.Set("Cache-Control", "no-cache")
	req.Header.Set("Pragma", "no-cache")

	resp, err := client.Do(req)
	if err != nil {
		FailWithStatus(w, http.StatusBadGateway, "代理媒体请求失败")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		FailWithStatus(w, http.StatusBadGateway, "代理媒体请求失败: "+resp.Status)
		return
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		FailWithStatus(w, http.StatusBadGateway, "代理媒体请求失败")
		return
	}
	if int64(len(data)) > maxBytes {
		FailWithStatus(w, http.StatusBadGateway, "代理媒体超过 256 MiB 限制")
		return
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	detected := strings.ToLower(http.DetectContentType(data))
	if strings.HasPrefix(detected, "text/html") || strings.Contains(detected, "xml") {
		FailWithStatus(w, http.StatusBadGateway, "代理地址没有返回安全媒体")
		return
	}
	if contentType == "application/octet-stream" && (strings.HasPrefix(detected, "video/") || strings.HasPrefix(detected, "audio/")) {
		contentType = detected
	}
	if !strings.HasPrefix(contentType, "video/") && !strings.HasPrefix(contentType, "audio/") {
		FailWithStatus(w, http.StatusBadGateway, "代理地址没有返回安全媒体")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(data)
}
