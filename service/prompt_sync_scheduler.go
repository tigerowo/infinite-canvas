package service

import (
	"context"
	"log"
	"sync"

	"github.com/robfig/cron/v3"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const defaultPromptSyncCron = "0 0 * * *"

var (
	promptSyncCron *cron.Cron
	promptSyncOnce sync.Once
	promptSyncMu   sync.Mutex
)

func StartPromptSyncScheduler() {
	promptSyncOnce.Do(func() {
		promptSyncCron = cron.New()
		promptSyncCron.Start()
	})
	RefreshPromptSyncScheduler()
}

func RefreshPromptSyncScheduler() {
	promptSyncMu.Lock()
	defer promptSyncMu.Unlock()
	if promptSyncCron == nil {
		return
	}
	for _, entry := range promptSyncCron.Entries() {
		promptSyncCron.Remove(entry.ID)
	}
	settings, err := repository.GetSettings()
	if err != nil {
		log.Printf("load prompt sync setting failed err=%v", err)
		return
	}
	setting := normalizePromptSyncSetting(settings.Private.PromptSync)
	if setting.Enabled == nil || !*setting.Enabled {
		return
	}
	if _, err := promptSyncCron.AddFunc(setting.Cron, func() {
		if err := SyncRemotePromptCategories(context.Background()); err != nil {
			log.Printf("scheduled prompt sync stopped err=%v", err)
		}
	}); err != nil {
		log.Printf("add prompt sync cron failed cron=%s err=%v", setting.Cron, err)
	}
}

func SyncRemotePromptCategories(ctx context.Context) error {
	budget := newUpstreamReadBudget(ctx, "提示词全量同步", promptSyncReadLimits)
	defer budget.Close()
	var lastErr error
	for _, category := range repository.PromptCategories() {
		if !category.Remote {
			continue
		}
		log.Printf("scheduled prompt sync start category=%s", category.Category)
		if _, err := syncPromptCategoryWithBudget(category.Category, budget); err != nil {
			log.Printf("scheduled prompt sync failed category=%s err=%v", category.Category, err)
			lastErr = err
			if isUpstreamBudgetError(err) {
				return err
			}
			continue
		}
		log.Printf("scheduled prompt sync done category=%s", category.Category)
	}
	return lastErr
}

func normalizePromptSyncSetting(setting model.PromptSyncSetting) model.PromptSyncSetting {
	if setting.Cron == "" {
		setting.Cron = defaultPromptSyncCron
	}
	if setting.Enabled == nil {
		enabled := true
		setting.Enabled = &enabled
	}
	return setting
}
