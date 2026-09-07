package publicmedia

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/extensions/s3compat"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

const URLLifetime = 24 * time.Hour

func Presign(ctx context.Context, provider model.StorageProvider, key string, now time.Time) (string, error) {
	if provider.Type != model.StorageProviderTypeS3 {
		return "", errors.New("素材必须保存到 S3 对象存储")
	}
	u, err := s3compat.ObjectURL(provider.Endpoint, provider.Bucket, key)
	if err != nil || u == nil || u.Scheme != "https" || u.Hostname() == "" {
		return "", errors.New("S3 需要配置可从公网访问的 HTTPS Endpoint")
	}
	q := u.Query()
	q.Set("X-Amz-Expires", "86400")
	u.RawQuery = q.Encode()
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	region := provider.Region
	if region == "" {
		region = "us-east-1"
	}
	url, _, err := v4.NewSigner(func(o *v4.SignerOptions) { o.DisableURIPathEscaping = true }).PresignHTTP(ctx,
		aws.Credentials{AccessKeyID: provider.AccessKeyID, SecretAccessKey: provider.SecretAccessKey},
		r, "UNSIGNED-PAYLOAD", "s3", region, now)
	return url, err
}

func Register(group *gin.RouterGroup) {
	group.GET("/files/:id/url", func(c *gin.Context) {
		user, ok := service.UserFromContext(c.Request.Context())
		object, err := service.StorageObjectInfo(c.Param("id"))
		if !ok || err != nil || (object.CreatedBy != user.ID && user.Role != model.UserRoleAdmin) {
			c.JSON(http.StatusForbidden, gin.H{"code": -1, "msg": "无权访问该素材"})
			return
		}
		provider, found := service.StorageProviderForObject(object)
		if !found {
			c.JSON(http.StatusBadRequest, gin.H{"code": -1, "msg": "找不到素材的 S3 配置"})
			return
		}
		now := time.Now().UTC()
		url, err := Presign(c.Request.Context(), provider, object.ObjectKey, now)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"code": -1, "msg": "无法生成 S3 公网链接，请检查存储配置"})
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{"code": 0, "data": gin.H{"url": url, "expiresAt": now.Add(URLLifetime).Format(time.RFC3339), "mimeType": object.MimeType}})
	})
}
