package storageaccess

import (
	"fmt"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

// ValidateProviderChanges prevents removing or repointing a global provider
// while indexed objects still need its connection details to be readable.
func ValidateProviderChanges(previous, next []model.StorageProvider) error {
	return validateProviderChanges(previous, next, countStorageObjectsByProviderIDs)
}

func validateProviderChanges(previous, next []model.StorageProvider, countUsage func([]string) (map[string]int64, error)) error {
	previousByID := map[string]model.StorageProvider{}
	nextByID := map[string]model.StorageProvider{}
	ids := []string{}
	for _, provider := range previous {
		if provider.ID == "" {
			continue
		}
		previousByID[provider.ID] = provider
		ids = append(ids, provider.ID)
	}
	for _, provider := range next {
		if provider.ID != "" {
			nextByID[provider.ID] = provider
		}
	}
	if len(ids) == 0 {
		return nil
	}
	usage, err := countUsage(ids)
	if err != nil {
		return err
	}
	for id, count := range usage {
		if count == 0 {
			continue
		}
		oldProvider := previousByID[id]
		newProvider, retained := nextByID[id]
		if !retained || providerConnectionKey(oldProvider) != providerConnectionKey(newProvider) {
			return fmt.Errorf("不能修改或删除仍被 %d 个素材使用的 OSS「%s」，请新增新的 OSS 后停用旧配置", count, oldProvider.Name)
		}
	}
	return nil
}

func countStorageObjectsByProviderIDs(ids []string) (map[string]int64, error) {
	usage := map[string]int64{}
	db, err := repository.DB()
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ProviderID string
		Count      int64 `gorm:"column:count"`
	}
	if err := db.Model(&model.StorageObject{}).
		Select("provider_id, COUNT(*) AS count").
		Where("provider_id IN ?", ids).
		Group("provider_id").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	for _, row := range rows {
		usage[row.ProviderID] = row.Count
	}
	return usage, nil
}

func providerConnectionKey(provider model.StorageProvider) string {
	return strings.Join([]string{
		provider.Type,
		provider.Endpoint,
		provider.Region,
		provider.Bucket,
		provider.AccessKeyID,
		provider.SecretAccessKey,
		provider.PathPrefix,
		provider.Username,
		provider.Password,
		provider.OwnerUserID,
	}, "\x00")
}
