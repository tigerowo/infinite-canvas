package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

const proxyImageMaxBytes = 15 << 20

// StorageConfig 返回公开存储配置。
func StorageConfig(w http.ResponseWriter, r *http.Request) {
	config, err := service.PublicStorageConfig()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, config)
}

// SaveUserStorageProvider 保存用户配置的 S3/R2 存储提供商。
func SaveUserStorageProvider(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Provider service.StorageObjectProviderInput `json:"provider"`
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
	file, header, err := r.FormFile("file")
	if err != nil {
		Fail(w, "请选择要上传的文件")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
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

// FileContent 获取文件内容。
func FileContent(w http.ResponseWriter, r *http.Request, id string) {
	if !authorizeFileAccess(r, id) {
		FailWithStatus(w, http.StatusUnauthorized, "未登录或无权访问该文件")
		return
	}
	download, err := service.DownloadStorageObject(id)
	if err != nil {
		FailError(w, err)
		return
	}
	if download.RedirectURL != "" {
		http.Redirect(w, r, download.RedirectURL, http.StatusTemporaryRedirect)
		return
	}
	w.Header().Set("Content-Type", download.Object.MimeType)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	_, _ = w.Write(download.Data)
}

// FileInfo 获取文件元数据。
func FileInfo(w http.ResponseWriter, r *http.Request, id string) {
	if !authorizeFileAccess(r, id) {
		FailWithStatus(w, http.StatusUnauthorized, "未登录或无权访问该文件")
		return
	}
	object, err := service.StorageObjectInfo(id)
	if err != nil {
		FailError(w, err)
		return
	}
	payload := map[string]any{
		"id":         object.ID,
		"providerId": object.ProviderID,
		"bucket":     object.Bucket,
		"objectKey":  object.ObjectKey,
		"publicUrl":  object.PublicURL,
		"mimeType":   object.MimeType,
		"bytes":      object.Bytes,
		"width":      object.Width,
		"height":     object.Height,
		"sha256":     object.SHA256,
		"createdBy":  object.CreatedBy,
		"createdAt":  object.CreatedAt,
		"contentUrl": service.SignedFileContentPath(object.ID),
	}
	OK(w, payload)
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
	result, err := service.MeasureAdminStorageProvider(request.Index, request.Provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

// ProxyImage 代理图片请求（解决跨域和机器人检测问题）。需登录，并做 SSRF 防护。
func ProxyImage(w http.ResponseWriter, r *http.Request) {
	if _, ok := service.UserFromContext(r.Context()); !ok {
		FailWithStatus(w, http.StatusUnauthorized, "未登录或权限不足")
		return
	}
	targetURL := r.URL.Query().Get("url")
	if err := service.ValidatePublicHTTPURL(targetURL); err != nil {
		FailWithStatus(w, http.StatusForbidden, err.Error())
		return
	}

	client := service.SafeImageProxyClient()
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, targetURL, nil)
	if err != nil {
		FailError(w, err)
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")

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
	contentType := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0])), "image/") {
		FailWithStatus(w, http.StatusUnsupportedMediaType, "仅允许代理图片内容")
		return
	}
	limited := io.LimitReader(resp.Body, proxyImageMaxBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		FailWithStatus(w, http.StatusBadGateway, "代理图片请求失败")
		return
	}
	if len(data) > proxyImageMaxBytes {
		FailWithStatus(w, http.StatusRequestEntityTooLarge, "代理图片过大")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func authorizeFileAccess(r *http.Request, id string) bool {
	id = strings.TrimSpace(id)
	if id == "" {
		return false
	}
	if service.VerifyResourceAccess("file:"+id, r.URL.Query().Get("exp"), r.URL.Query().Get("sig")) {
		return true
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if strings.TrimSpace(token) == "" {
		return false
	}
	user, ok := service.CurrentAuthUser(token)
	if !ok || user.Role == model.UserRoleGuest {
		return false
	}
	if user.Role == model.UserRoleAdmin {
		return true
	}
	object, err := service.StorageObjectInfo(id)
	if err != nil {
		return false
	}
	if object.CreatedBy == "" || object.CreatedBy == "anonymous" {
		return true
	}
	return object.CreatedBy == user.ID
}

