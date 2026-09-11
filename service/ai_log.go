package service

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	medialifecycle "github.com/tigerowo/infinite-canvas/extensions/media-lifecycle"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"gorm.io/gorm"
)

const (
	aiLogRequestTextLimit = 64 * 1024
	aiLogErrorTextLimit   = 16 * 1024
	aiLogScannerMax       = 16 * 1024 * 1024
	defaultAILogCron      = "0 3 * * *"
	defaultAILogRetention = 14
)

var (
	htmlTagPattern        = regexp.MustCompile(`(?s)<[^>]+>`)
	whitespacePattern     = regexp.MustCompile(`\s+`)
	longDataURLPattern    = regexp.MustCompile(`data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]{512,}`)
	longBase64TextPattern = regexp.MustCompile(`"[A-Za-z0-9+/=]{512,}"`)

	aiLogFileMu sync.Mutex
)

type AICallLogInput struct {
	UserID          string `json:"userId"`
	UserDisplayName string `json:"userDisplayName"`
	Endpoint        string `json:"endpoint"`
	Method          string `json:"method"`
	Model           string `json:"model"`
	ChannelID       string `json:"channelId"`
	ChannelName     string `json:"channelName"`
	Status          int    `json:"status"`
	DurationMs      int64  `json:"durationMs"`
	Credits         int    `json:"credits"`
	RequestBody     string `json:"requestBody"`
	ResponseBody    string `json:"responseBody"`
	Error           string `json:"error"`
}

func SaveAICallLog(input AICallLogInput) {
	responseBody := normalizeAICallResponseLog(input.ResponseBody, input.Error)
	errorText := normalizeAICallErrorLog(input.Error, input.ResponseBody)
	item := model.AICallLog{
		ID:              uuid.NewString(),
		UserID:          strings.TrimSpace(input.UserID),
		UserDisplayName: strings.TrimSpace(input.UserDisplayName),
		Endpoint:        strings.TrimSpace(input.Endpoint),
		Method:          strings.TrimSpace(input.Method),
		Model:           strings.TrimSpace(input.Model),
		ChannelID:       strings.TrimSpace(input.ChannelID),
		ChannelName:     strings.TrimSpace(input.ChannelName),
		Status:          input.Status,
		DurationMs:      input.DurationMs,
		Credits:         input.Credits,
		RequestBody:     truncateLogText(input.RequestBody, aiLogRequestTextLimit),
		ResponseBody:    responseBody,
		Error:           truncateLogText(errorText, aiLogErrorTextLimit),
		CreatedAt:       now(),
	}
	db, err := repository.DB()
	if err != nil {
		log.Printf("index ai call log failed err=%v", err)
		return
	}
	lease, err := beginAILogWrite(db)
	if err != nil {
		log.Printf("begin ai call log write failed err=%v", err)
		return
	}
	defer endAILogWrite(db, lease)
	aiLogFileMu.Lock()
	err = appendAICallLog(item)
	aiLogFileMu.Unlock()
	if err != nil {
		log.Printf("write ai call log failed err=%v", err)
		return
	}
	if err := syncAICallLogRecord(db, item, lease.Epoch); err != nil {
		// The durable JSONL record remains the recovery source for the next sync.
		log.Printf("index ai call log failed err=%v", err)
	}
}

func ListAICallLogs(q model.Query) (model.AICallLogList, error) {
	q.Normalize()
	db, err := repository.DB()
	if err != nil {
		return model.AICallLogList{}, err
	}
	if err := SyncAICallLogsToDatabase(db); err != nil {
		return model.AICallLogList{}, err
	}
	items := []model.AICallLog{}
	if err := db.Find(&items).Error; err != nil {
		return model.AICallLogList{}, err
	}
	if keyword := strings.ToLower(strings.TrimSpace(q.Keyword)); keyword != "" {
		filtered := make([]model.AICallLog, 0, len(items))
		for _, item := range items {
			if aiLogMatchesKeyword(item, keyword) {
				filtered = append(filtered, item)
			}
		}
		items = filtered
	}
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].CreatedAt > items[j].CreatedAt
	})
	total := len(items)
	start := q.Offset()
	if start >= total {
		return model.AICallLogList{Items: []model.AICallLog{}, Total: total}, nil
	}
	end := start + q.PageSize
	if end > total {
		end = total
	}
	return model.AICallLogList{Items: items[start:end], Total: total}, nil
}

func SyncAICallLogsToDatabase(db *gorm.DB) error {
	lease, err := beginAILogWrite(db)
	if err != nil {
		return err
	}
	defer endAILogWrite(db, lease)
	aiLogFileMu.Lock()
	items, err := readAICallLogs()
	aiLogFileMu.Unlock()
	if err != nil {
		return err
	}
	for i := range items {
		if err := syncAICallLogRecord(db, items[i], lease.Epoch); err != nil {
			return err
		}
	}
	return nil
}

func beginAILogWrite(db *gorm.DB) (medialifecycle.RequestLease, error) {
	var lease medialifecycle.RequestLease
	err := medialifecycle.WithLock(db, func(tx *gorm.DB, policy *medialifecycle.Policy) error {
		if err := medialifecycle.GuardEpoch(*policy, 0); err != nil {
			return err
		}
		lease = medialifecycle.RequestLease{ID: medialifecycle.ID(), Epoch: policy.Epoch, Until: time.Now().UTC().UnixMilli() + medialifecycle.Day}
		return tx.Create(&lease).Error
	})
	return lease, err
}

func endAILogWrite(db *gorm.DB, lease medialifecycle.RequestLease) {
	if lease.ID == "" {
		return
	}
	if err := db.Delete(&medialifecycle.RequestLease{}, "id = ?", lease.ID).Error; err != nil {
		log.Printf("release ai call log write lease failed err=%v", err)
	}
}

func syncAICallLogRecord(db *gorm.DB, item model.AICallLog, epoch int64) error {
	return medialifecycle.WithLock(db, func(tx *gorm.DB, policy *medialifecycle.Policy) error {
		if err := medialifecycle.GuardEpoch(*policy, epoch); err != nil {
			return err
		}
		stored := item
		err := tx.First(&stored, "id = ?", item.ID).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			stored = item
			if err := tx.Create(&stored).Error; err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		if err := medialifecycle.TrackRecord(tx, *policy, &stored); err != nil {
			return err
		}
		created, ok := aiLogCreatedAt(stored.CreatedAt)
		if !ok {
			created, ok = aiLogCreatedAt(item.CreatedAt)
		}
		if !ok {
			return nil
		}
		result := tx.Model(&medialifecycle.Entity{}).
			Where("entity_key = ? AND state = ? AND epoch = ?", medialifecycle.Key(aiLogOwner(stored), "ai-log", stored.ID), medialifecycle.Active, policy.Epoch).
			Update("activity", created.UTC().UnixMilli())
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return medialifecycle.ErrConflict
		}
		return nil
	})
}

func ReconcileAILogFiles(ctx context.Context, db *gorm.DB, batch medialifecycle.Batch) error {
	aiLogFileMu.Lock()
	defer aiLogFileMu.Unlock()
	files, err := aiLogFiles()
	if err != nil {
		return err
	}
	if batch.Kind == "clear" {
		for _, file := range files {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := os.Remove(file); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		return nil
	}
	var ids []string
	if err := db.Model(&model.AICallLog{}).Pluck("id", &ids).Error; err != nil {
		return err
	}
	active := make(map[string]bool, len(ids))
	for _, id := range ids {
		active[id] = true
	}
	for _, file := range files {
		if err := ctx.Err(); err != nil {
			return err
		}
		lines, changed, err := retainedAILogLines(file, active)
		if err != nil {
			return err
		}
		if !changed {
			continue
		}
		if len(lines) == 0 {
			if err := os.Remove(file); err != nil && !os.IsNotExist(err) {
				return err
			}
			continue
		}
		if err := replaceAILogFile(file, lines); err != nil {
			return err
		}
	}
	return nil
}

func retainedAILogLines(filePath string, active map[string]bool) ([]string, bool, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, false, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), aiLogScannerMax)
	lines := []string{}
	changed := false
	for scanner.Scan() {
		line := scanner.Text()
		var item model.AICallLog
		if json.Unmarshal([]byte(strings.TrimSpace(line)), &item) != nil || item.ID == "" || active[item.ID] {
			lines = append(lines, line)
			continue
		}
		changed = true
	}
	return lines, changed, scanner.Err()
}

func replaceAILogFile(filePath string, lines []string) error {
	temporary, err := os.CreateTemp(filepath.Dir(filePath), ".ai-log-cleanup-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	writer := bufio.NewWriter(temporary)
	for _, line := range lines {
		if _, err := writer.WriteString(line + "\n"); err != nil {
			temporary.Close()
			return err
		}
	}
	if err := writer.Flush(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	backupPath := filePath + ".cleanup-backup"
	if err := os.Remove(backupPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(filePath, backupPath); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, filePath); err != nil {
		if restoreErr := os.Rename(backupPath, filePath); restoreErr != nil {
			return errors.Join(err, fmt.Errorf("restore AI log backup: %w", restoreErr))
		}
		return err
	}
	if err := os.Remove(backupPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func aiLogOwner(item model.AICallLog) string {
	if owner := strings.TrimSpace(item.UserID); owner != "" {
		return owner
	}
	return "@anonymous"
}

func aiLogCreatedAt(value string) (time.Time, bool) {
	created, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	return created, err == nil
}

func normalizeAILogCleanupSetting(setting model.AILogCleanupSetting) model.AILogCleanupSetting {
	if setting.Cron == "" {
		setting.Cron = defaultAILogCron
	}
	if setting.RetentionDays <= 0 {
		setting.RetentionDays = defaultAILogRetention
	}
	if setting.Enabled == nil {
		enabled := false
		setting.Enabled = &enabled
	}
	return setting
}

func normalizeAILogSetting(setting model.AILogSetting) model.AILogSetting {
	setting.Cleanup = normalizeAILogCleanupSetting(setting.Cleanup)
	if setting.LocalDirectReportEnabled == nil {
		enabled := false
		setting.LocalDirectReportEnabled = &enabled
	}
	return setting
}

func LocalDirectAILogEnabled() bool {
	settings, err := repository.GetSettings()
	if err != nil {
		log.Printf("load local direct ai log setting failed err=%v", err)
		return false
	}
	setting := normalizeAILogSetting(settings.Private.AILog)
	return setting.LocalDirectReportEnabled != nil && *setting.LocalDirectReportEnabled
}

func appendAICallLog(item model.AICallLog) error {
	dir := strings.TrimSpace(config.Cfg.AILogDir)
	if dir == "" {
		dir = filepath.Join("data", "logs", "ai-calls")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	filePath := filepath.Join(dir, fmt.Sprintf("ai-calls-%s.log", time.Now().Format("2006-01-02")))
	file, err := os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return err
	}
	defer file.Close()
	encoded, err := json.Marshal(item)
	if err != nil {
		return err
	}
	if _, err := file.Write(append(encoded, '\n')); err != nil {
		return err
	}
	return file.Sync()
}

func readAICallLogs() ([]model.AICallLog, error) {
	files, err := aiLogFiles()
	if err != nil {
		return nil, err
	}
	items := []model.AICallLog{}
	for _, file := range files {
		fileItems, err := readAICallLogFile(file)
		if err != nil {
			log.Printf("read ai call log file failed file=%s err=%v", file, err)
			continue
		}
		items = append(items, fileItems...)
	}
	return items, nil
}

func readAICallLogFile(filePath string) ([]model.AICallLog, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), aiLogScannerMax)
	items := []model.AICallLog{}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var item model.AICallLog
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			continue
		}
		item.ResponseBody = normalizeAICallResponseLog(item.ResponseBody, item.Error)
		item.Error = normalizeAICallErrorLog(item.Error, item.ResponseBody)
		items = append(items, item)
	}
	return items, scanner.Err()
}

func aiLogFiles() ([]string, error) {
	dir := strings.TrimSpace(config.Cfg.AILogDir)
	if dir == "" {
		dir = filepath.Join("data", "logs", "ai-calls")
	}
	if err := recoverAILogFileReplacements(dir); err != nil {
		return nil, err
	}
	files, err := filepath.Glob(filepath.Join(dir, "ai-calls-*.log"))
	if err != nil {
		return nil, err
	}
	sort.Sort(sort.Reverse(sort.StringSlice(files)))
	return files, nil
}

func recoverAILogFileReplacements(dir string) error {
	backups, err := filepath.Glob(filepath.Join(dir, "ai-calls-*.log.cleanup-backup"))
	if err != nil {
		return err
	}
	for _, backupPath := range backups {
		filePath := strings.TrimSuffix(backupPath, ".cleanup-backup")
		_, targetErr := os.Stat(filePath)
		switch {
		case targetErr == nil:
			if err := os.Remove(backupPath); err != nil && !os.IsNotExist(err) {
				return err
			}
		case os.IsNotExist(targetErr):
			if err := os.Rename(backupPath, filePath); err != nil {
				return err
			}
		default:
			return targetErr
		}
	}
	temporaryFiles, err := filepath.Glob(filepath.Join(dir, ".ai-log-cleanup-*"))
	if err != nil {
		return err
	}
	for _, temporaryPath := range temporaryFiles {
		if err := os.Remove(temporaryPath); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func aiLogFileDate(filePath string) (time.Time, bool) {
	name := filepath.Base(filePath)
	value := strings.TrimSuffix(strings.TrimPrefix(name, "ai-calls-"), ".log")
	parsed, err := time.ParseInLocation("2006-01-02", value, time.Local)
	return parsed, err == nil
}

func startOfDay(value time.Time) time.Time {
	year, month, day := value.Date()
	return time.Date(year, month, day, 0, 0, 0, 0, value.Location())
}

func aiLogMatchesKeyword(item model.AICallLog, keyword string) bool {
	fields := []string{item.UserID, item.UserDisplayName, item.Endpoint, item.Method, item.Model, item.ChannelID, item.ChannelName, item.RequestBody, item.ResponseBody, item.Error, strconv.Itoa(item.Status)}
	for _, field := range fields {
		if strings.Contains(strings.ToLower(field), keyword) {
			return true
		}
	}
	return false
}

func normalizeAICallResponseLog(responseBody string, errorMessage string) string {
	responseBody = strings.TrimSpace(responseBody)
	if responseBody == "" {
		return ""
	}
	formatted := formatAICallLogPayload(responseBody)
	reason := extractAICallFailureReason(errorMessage)
	if reason == "" {
		reason = extractAICallFailureReason(responseBody)
	}
	if reason == "" {
		return formatted
	}
	if strings.HasPrefix(formatted, "失败原因:") {
		return formatted
	}
	return "失败原因: " + reason + "\n\n原始返回:\n" + formatted
}

func normalizeAICallErrorLog(errorMessage string, responseBody string) string {
	if reason := extractAICallFailureReason(errorMessage); reason != "" {
		return reason
	}
	if reason := extractAICallFailureReason(responseBody); reason != "" {
		return reason
	}
	return cleanPlainLogText(errorMessage)
}

func formatAICallLogPayload(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	var payload any
	if err := json.Unmarshal([]byte(raw), &payload); err == nil {
		redactLargeLogStrings(&payload)
		if encoded, err := json.MarshalIndent(payload, "", "  "); err == nil {
			return string(encoded)
		}
	}
	if strings.Contains(raw, "\ndata:") || strings.HasPrefix(raw, "data:") || strings.Contains(raw, "\nevent:") || strings.HasPrefix(raw, "event:") {
		return formatEventStreamLog(raw)
	}
	return redactLargePlainLogText(raw)
}

func formatEventStreamLog(raw string) string {
	lines := strings.Split(raw, "\n")
	formatted := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "data:") {
			formatted = append(formatted, redactLargePlainLogText(line))
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
		if data == "" || data == "[DONE]" {
			formatted = append(formatted, line)
			continue
		}
		var payload any
		if err := json.Unmarshal([]byte(data), &payload); err != nil {
			formatted = append(formatted, redactLargePlainLogText(line))
			continue
		}
		redactLargeLogStrings(&payload)
		encoded, err := json.Marshal(payload)
		if err != nil {
			formatted = append(formatted, redactLargePlainLogText(line))
			continue
		}
		formatted = append(formatted, "data: "+string(encoded))
	}
	return strings.TrimSpace(strings.Join(formatted, "\n"))
}

func extractAICallFailureReason(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	var payload any
	if err := json.Unmarshal([]byte(raw), &payload); err == nil {
		reasons := []string{}
		collectAICallFailureReasons(payload, &reasons)
		return strings.Join(dedupeStrings(reasons), "；")
	}
	cleaned := cleanPlainLogText(raw)
	if cleaned == "" || looksLikeSuccessfulLogText(cleaned) {
		return ""
	}
	return cleaned
}

func collectAICallFailureReasons(value any, reasons *[]string) {
	switch typed := value.(type) {
	case map[string]any:
		if message := stringField(typed, "message"); message != "" {
			*reasons = append(*reasons, message)
		}
		if message := stringField(typed, "msg"); message != "" {
			*reasons = append(*reasons, message)
		}
		if detail := stringField(typed, "detail"); detail != "" {
			*reasons = append(*reasons, detail)
		}
		if reason := stringField(typed, "reason"); reason != "" {
			*reasons = append(*reasons, reason)
		}
		if errValue, ok := typed["error"]; ok && errValue != nil {
			if message, ok := errValue.(string); ok && strings.TrimSpace(message) != "" {
				*reasons = append(*reasons, strings.TrimSpace(message))
			} else {
				collectAICallFailureReasons(errValue, reasons)
			}
		}
		status := strings.ToLower(stringField(typed, "status"))
		typeName := stringField(typed, "type")
		if status == "failed" || status == "incomplete" || status == "cancelled" || status == "canceled" {
			if typeName == "image_generation_call" {
				*reasons = append(*reasons, "Responses 图像生成调用失败：image_generation_call 状态为 "+status+"，接口未返回具体错误原因")
			} else if typeName != "" {
				*reasons = append(*reasons, typeName+" 状态为 "+status)
			} else {
				*reasons = append(*reasons, "状态为 "+status)
			}
		}
		for key, item := range typed {
			if key == "instructions" || key == "prompt" || key == "requestBody" || key == "responseBody" {
				continue
			}
			collectAICallFailureReasons(item, reasons)
		}
	case []any:
		for _, item := range typed {
			collectAICallFailureReasons(item, reasons)
		}
	}
}

func stringField(values map[string]any, key string) string {
	value, ok := values[key]
	if !ok || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return ""
	}
}

func dedupeStrings(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		value = cleanPlainLogText(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func cleanPlainLogText(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	value = longDataURLPattern.ReplaceAllString(value, "[redacted image data]")
	value = longBase64TextPattern.ReplaceAllString(value, `"[redacted large base64/string]"`)
	value = html.UnescapeString(htmlTagPattern.ReplaceAllString(value, " "))
	value = whitespacePattern.ReplaceAllString(value, " ")
	value = strings.TrimSpace(value)
	if len(value) > aiLogErrorTextLimit {
		return value[:aiLogErrorTextLimit] + "\n... [truncated]"
	}
	return value
}

func redactLargePlainLogText(value string) string {
	value = longDataURLPattern.ReplaceAllString(value, "[redacted image data]")
	value = longBase64TextPattern.ReplaceAllString(value, `"[redacted large base64/string]"`)
	return strings.TrimSpace(value)
}

func redactLargeLogStrings(value *any) {
	switch typed := (*value).(type) {
	case map[string]any:
		for key, item := range typed {
			if text, ok := item.(string); ok && isLargeLogString(text) {
				typed[key] = fmt.Sprintf("[redacted large string len=%d]", len(text))
				continue
			}
			redactLargeLogStrings(&item)
			typed[key] = item
		}
	case []any:
		for index, item := range typed {
			redactLargeLogStrings(&item)
			typed[index] = item
		}
	}
}

func isLargeLogString(value string) bool {
	if strings.HasPrefix(value, "data:image/") {
		return true
	}
	return len(value) > 4096 && looksLikeLogBase64(value)
}

func looksLikeLogBase64(value string) bool {
	for _, char := range value[:min(len(value), 256)] {
		if !(char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '+' || char == '/' || char == '=') {
			return false
		}
	}
	return true
}

func looksLikeSuccessfulLogText(value string) bool {
	lower := strings.ToLower(value)
	return !strings.Contains(lower, "error") &&
		!strings.Contains(lower, "failed") &&
		!strings.Contains(lower, "fail") &&
		!strings.Contains(lower, "timeout") &&
		!strings.Contains(lower, "stream_read_error") &&
		!strings.Contains(lower, "502") &&
		!strings.Contains(lower, "500") &&
		!strings.Contains(lower, "429") &&
		!strings.Contains(lower, "401") &&
		!strings.Contains(lower, "403")
}

func truncateLogText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "\n... [truncated]"
}
