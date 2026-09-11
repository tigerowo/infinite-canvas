package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	medialifecycle "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const generationLogLimit = 1000

func CurrentUserVideoGenerationLogs(ctx context.Context) ([]json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}
	cleanupGenerationLogs()
	logs, err := repository.ListVideoGenerationLogs(user.ID, generationLogLimit)
	if err != nil {
		return nil, err
	}
	return videoGenerationPayloads(logs), nil
}

func SaveCurrentUserVideoGenerationLogs(ctx context.Context, raws []json.RawMessage) ([]json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}
	cleanupGenerationLogs()
	logs := make([]model.VideoGenerationLog, 0, len(raws))
	for _, raw := range raws {
		log := videoGenerationLogFromPayload(raw)
		if log.ID != "" {
			logs = append(logs, log)
		}
	}
	if err := repository.UpsertVideoGenerationLogs(user.ID, logs, medialifecycle.Epoch(ctx)); err != nil {
		return nil, err
	}
	return CurrentUserVideoGenerationLogs(ctx)
}

func DeleteCurrentUserVideoGenerationLog(ctx context.Context, id string) error {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return errors.New("请先登录")
	}
	cleanupGenerationLogs()
	return repository.SoftDeleteVideoGenerationLog(user.ID, strings.TrimSpace(id), now(), medialifecycle.Epoch(ctx))
}

func DeleteCurrentUserVideoGenerationLogs(ctx context.Context, ids []string) error {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return errors.New("请先登录")
	}
	cleanupGenerationLogs()
	return repository.SoftDeleteVideoGenerationLogs(user.ID, ids, now(), medialifecycle.Epoch(ctx))
}

func CurrentUserImageGenerationLogs(ctx context.Context) ([]json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}
	cleanupGenerationLogs()
	if err := migrateUserImageGenerationLogs(ctx, user.ID); err != nil {
		return nil, err
	}
	logs, err := repository.ListImageGenerationLogs(user.ID, generationLogLimit)
	if err != nil {
		return nil, err
	}
	return imageGenerationPayloads(logs), nil
}

func SaveCurrentUserImageGenerationLogs(ctx context.Context, raws []json.RawMessage) ([]json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}
	cleanupGenerationLogs()
	logs := make([]model.ImageGenerationLog, 0, len(raws))
	for _, raw := range raws {
		log := imageGenerationLogFromPayload(raw)
		if log.ID != "" {
			logs = append(logs, log)
		}
	}
	if err := repository.UpsertImageGenerationLogs(user.ID, logs, medialifecycle.Epoch(ctx)); err != nil {
		return nil, err
	}
	return CurrentUserImageGenerationLogs(ctx)
}

func DeleteCurrentUserImageGenerationLog(ctx context.Context, id string) error {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return errors.New("请先登录")
	}
	cleanupGenerationLogs()
	return repository.SoftDeleteImageGenerationLog(user.ID, strings.TrimSpace(id), now(), medialifecycle.Epoch(ctx))
}

func DeleteCurrentUserImageGenerationLogs(ctx context.Context, ids []string) error {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return errors.New("请先登录")
	}
	cleanupGenerationLogs()
	return repository.SoftDeleteImageGenerationLogs(user.ID, ids, now(), medialifecycle.Epoch(ctx))
}

func videoGenerationPayloads(logs []model.VideoGenerationLog) []json.RawMessage {
	result := make([]json.RawMessage, 0, len(logs))
	for _, log := range logs {
		if strings.TrimSpace(log.PayloadJSON) != "" {
			result = append(result, json.RawMessage(log.PayloadJSON))
		}
	}
	return result
}

func imageGenerationPayloads(logs []model.ImageGenerationLog) []json.RawMessage {
	result := make([]json.RawMessage, 0, len(logs))
	for _, log := range logs {
		if strings.TrimSpace(log.PayloadJSON) != "" {
			result = append(result, json.RawMessage(log.PayloadJSON))
		}
	}
	return result
}

func videoGenerationLogFromPayload(raw json.RawMessage) model.VideoGenerationLog {
	record := parseGenerationLogRecord(raw)
	task := generationLogRecord(record["task"])
	video := generationLogRecord(record["video"])
	current := now()
	createdAt := generationLogCreatedAt(record)
	if createdAt == "" {
		createdAt = current
	}
	return model.VideoGenerationLog{
		ID:          generationLogString(record["id"]),
		TaskID:      firstGenerationLogValue(generationLogString(task["id"]), generationLogString(task["task_id"]), generationLogString(record["taskId"])),
		VideoID:     firstGenerationLogValue(generationLogString(task["video_id"]), generationLogString(video["id"]), generationLogString(record["videoId"])),
		Status:      generationLogString(record["status"]),
		PayloadJSON: string(raw),
		CreatedAt:   createdAt,
		UpdatedAt:   current,
		DeletedAt:   "",
	}
}

func imageGenerationLogFromPayload(raw json.RawMessage) model.ImageGenerationLog {
	record := parseGenerationLogRecord(raw)
	task := generationLogRecord(record["task"])
	image := firstGenerationLogRecord(record["image"], record["result"], record["output"])
	current := now()
	createdAt := generationLogCreatedAt(record)
	if createdAt == "" {
		createdAt = current
	}
	return model.ImageGenerationLog{
		ID:          generationLogString(record["id"]),
		TaskID:      firstGenerationLogValue(generationLogString(task["id"]), generationLogString(task["task_id"]), generationLogString(record["taskId"])),
		ImageID:     firstGenerationLogValue(generationLogString(image["id"]), generationLogString(image["storageKey"]), generationLogString(image["url"]), generationLogString(record["imageId"])),
		Status:      generationLogString(record["status"]),
		PayloadJSON: string(raw),
		CreatedAt:   createdAt,
		UpdatedAt:   current,
		DeletedAt:   "",
	}
}

func parseGenerationLogRecord(raw json.RawMessage) map[string]any {
	var record map[string]any
	if err := json.Unmarshal(raw, &record); err != nil {
		return map[string]any{}
	}
	return record
}

func generationLogRecord(value any) map[string]any {
	if record, ok := value.(map[string]any); ok {
		return record
	}
	return map[string]any{}
}

func firstGenerationLogRecord(values ...any) map[string]any {
	for _, value := range values {
		record := generationLogRecord(value)
		if len(record) > 0 {
			return record
		}
	}
	return map[string]any{}
}

func generationLogString(value any) string {
	switch item := value.(type) {
	case string:
		return strings.TrimSpace(item)
	case float64:
		if item == float64(int64(item)) {
			return strconv.FormatInt(int64(item), 10)
		}
		return fmt.Sprintf("%v", item)
	case bool:
		return strconv.FormatBool(item)
	default:
		return ""
	}
}

func generationLogCreatedAt(record map[string]any) string {
	for _, key := range []string{"createdAt", "created_at", "time"} {
		value := generationLogString(record[key])
		if value != "" {
			return value
		}
	}
	return ""
}

func firstGenerationLogValue(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func cleanupGenerationLogs() {
	before := time.Now().Add(-7 * 24 * time.Hour).Format(time.RFC3339)
	_ = repository.CleanupDeletedVideoGenerationLogs(before)
	_ = repository.CleanupDeletedImageGenerationLogs(before)
}

func migrateUserImageGenerationLogs(ctx context.Context, userID string) error {
	config, found, err := repository.GetUserConfig(userID)
	if err != nil || !found || strings.TrimSpace(config.ImageHistory) == "" {
		return err
	}
	var legacy struct {
		Logs []json.RawMessage `json:"logs"`
	}
	if err := json.Unmarshal([]byte(config.ImageHistory), &legacy); err != nil {
		return medialifecycle.Error("旧生成历史格式异常，原始记录已保留，请核对后再迁移")
	}
	logs := make([]model.ImageGenerationLog, 0, len(legacy.Logs))
	for _, raw := range legacy.Logs {
		log := imageGenerationLogFromPayload(raw)
		if log.ID != "" {
			logs = append(logs, log)
		}
	}
	db, err := repository.DB()
	if err != nil {
		return err
	}
	rows := make([]any, 0, len(logs))
	for i := range logs {
		logs[i].UserID = userID
		rows = append(rows, &logs[i])
	}
	return medialifecycle.MigrateLegacyImageHistory(db, userID, config.ImageHistory, rows, medialifecycle.Epoch(ctx))
}
