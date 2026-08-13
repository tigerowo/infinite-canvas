package service

import (
	"hash/crc32"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const videoTaskPollInterval = 5 * time.Second
const videoTaskFinishedRetention = 30 * 24 * time.Hour
const videoTaskCleanupInterval = 10 * time.Minute

var (
	videoTaskPollerOnce sync.Once
	videoTaskPollWake   = make(chan struct{}, 1)
	videoTaskPollerMu   sync.RWMutex
	videoTaskPoller     VideoTaskPollFunc
)

type VideoTaskCreateInput struct {
	UserID           string
	UserDisplayName  string
	Model            string
	ChannelID        string
	UserChannelID    string
	ChannelName      string
	Source           string
	SourceID         string
	ClientTaskID     string
	UpstreamTaskID   string
	UpstreamVideoID  string
	Status           string
	Progress         int
	Seconds          string
	Size             string
	VideoURL         string
	UpstreamVideoURL string
	StorageKey       string
	MimeType         string
	Bytes            int64
	Error            string
	ErrorDetail      string
	RequestBody      string
	ResponseBody     string
	Credits          int
}

type VideoTaskPollUpdate struct {
	Status           string
	Progress         int
	Seconds          string
	Size             string
	VideoURL         string
	Error            string
	ErrorDetail      string
	ResponseBody     string
	StorageKey       string
	MimeType         string
	Bytes            int64
	UpstreamVideoURL string
	RateLimited      bool
	RetryAfter       time.Duration
}

type VideoTaskPollFunc func(model.VideoTask) (VideoTaskPollUpdate, error)

func CreateVideoTask(input VideoTaskCreateInput) (model.VideoTask, error) {
	current := now()
	status := NormalizeVideoTaskStatus(input.Status)
	if status == "" {
		status = "queued"
	}
	task := model.VideoTask{
		ID:               firstVideoTaskValue(input.ClientTaskID, input.UpstreamTaskID, input.UpstreamVideoID, "video-task-"+uuid.NewString()),
		UserID:           strings.TrimSpace(input.UserID),
		UserDisplayName:  strings.TrimSpace(input.UserDisplayName),
		Model:            strings.TrimSpace(input.Model),
		ChannelID:        strings.TrimSpace(input.ChannelID),
		UserChannelID:    strings.TrimSpace(input.UserChannelID),
		ChannelName:      strings.TrimSpace(input.ChannelName),
		Source:           normalizeVideoTaskSource(input.Source),
		SourceID:         strings.TrimSpace(input.SourceID),
		UpstreamTaskID:   strings.TrimSpace(input.UpstreamTaskID),
		UpstreamVideoID:  strings.TrimSpace(input.UpstreamVideoID),
		Status:           status,
		Progress:         clampProgress(input.Progress),
		Seconds:          strings.TrimSpace(input.Seconds),
		Size:             strings.TrimSpace(input.Size),
		VideoURL:         strings.TrimSpace(input.VideoURL),
		UpstreamVideoURL: strings.TrimSpace(input.UpstreamVideoURL),
		StorageKey:       strings.TrimSpace(input.StorageKey),
		MimeType:         strings.TrimSpace(input.MimeType),
		Bytes:            input.Bytes,
		Error:            strings.TrimSpace(input.Error),
		ErrorDetail:      strings.TrimSpace(input.ErrorDetail),
		RequestBody:      input.RequestBody,
		ResponseBody:     input.ResponseBody,
		LastResponse:     input.ResponseBody,
		Credits:          input.Credits,
		CreatedAt:        current,
		UpdatedAt:        current,
		NextPollAt:       current,
	}
	if (IsCompletedVideoTaskStatus(task.Status) || task.VideoURL != "") && task.StorageKey != "" {
		task.Status = "completed"
		task.Progress = 100
		task.CompletedAt = current
	} else if IsFailedVideoTaskStatus(task.Status) || task.Error != "" {
		task.Status = "failed"
		task.CompletedAt = current
	} else if IsCompletedVideoTaskStatus(task.Status) || task.UpstreamVideoURL != "" {
		task.Status = "processing"
		task.Progress = max(task.Progress, 99)
	}
	saved, err := repository.SaveVideoTask(task)
	if err == nil && !IsCompletedVideoTaskStatus(saved.Status) && !IsFailedVideoTaskStatus(saved.Status) {
		WakeVideoTaskPoller()
	}
	return saved, err
}

func GetUserVideoTask(userID string, id string) (model.VideoTask, bool, error) {
	return repository.GetUserVideoTask(strings.TrimSpace(userID), strings.TrimSpace(id))
}

func ListUserVideoTasks(userID string, source string, limit int) ([]map[string]any, error) {
	tasks, err := repository.ListUserVideoTasks(strings.TrimSpace(userID), normalizeVideoTaskSource(source), limit)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0, len(tasks))
	for _, task := range tasks {
		result = append(result, VideoTaskResponse(task))
	}
	return result, nil
}

func DeleteUserVideoTask(userID string, id string) error {
	return repository.DeleteUserVideoTask(strings.TrimSpace(userID), strings.TrimSpace(id))
}

func VideoTaskResponse(task model.VideoTask) map[string]any {
	result := map[string]any{
		"id":            task.ID,
		"object":        "video",
		"model":         task.Model,
		"channelId":     task.ChannelID,
		"userChannelId": task.UserChannelID,
		"channelName":   task.ChannelName,
		"source":        task.Source,
		"source_id":     task.SourceID,
		"status":        task.Status,
		"progress":      task.Progress,
		"task_id":       firstVideoTaskValue(task.UpstreamTaskID, task.ID),
		"video_id":      task.UpstreamVideoID,
		"seconds":       task.Seconds,
		"size":          task.Size,
		"created_at":    task.CreatedAt,
		"updated_at":    task.UpdatedAt,
		"started_at":    task.StartedAt,
		"completed_at":  task.CompletedAt,
		"createdAt":     task.CreatedAt,
		"updatedAt":     task.UpdatedAt,
		"request_body":  task.RequestBody,
	}
	if task.VideoURL != "" {
		result["url"] = task.VideoURL
		result["video_url"] = task.VideoURL
		result["data"] = []map[string]any{{"url": task.VideoURL}}
		result["storageKey"] = task.StorageKey
		result["mimeType"] = task.MimeType
		result["bytes"] = task.Bytes
	}
	if IsFailedVideoTaskStatus(task.Status) && (task.Error != "" || task.ErrorDetail != "") {
		result["error"] = map[string]any{"message": firstVideoTaskValue(task.Error, task.ErrorDetail)}
		result["error_detail"] = task.ErrorDetail
	}
	return result
}

func StartVideoTaskPoller(poll VideoTaskPollFunc) {
	if poll == nil {
		return
	}
	videoTaskPollerMu.Lock()
	videoTaskPoller = poll
	videoTaskPollerMu.Unlock()
	videoTaskPollerOnce.Do(func() {
		go runVideoTaskPoller()
	})
	WakeVideoTaskPoller()
}

func WakeVideoTaskPoller() {
	select {
	case videoTaskPollWake <- struct{}{}:
	default:
	}
}

func runVideoTaskPoller() {
	inFlight := sync.Map{}
	lastCleanupAt := time.Time{}
	ticker := time.NewTicker(videoTaskPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-videoTaskPollWake:
		case <-ticker.C:
		}
		current := time.Now()
		tasks, err := repository.ListDueVideoTasks(videoTaskTime(current), 200)
		if err != nil {
			log.Printf("list due video tasks failed err=%v", err)
			continue
		}
		if lastCleanupAt.IsZero() || current.Sub(lastCleanupAt) >= videoTaskCleanupInterval {
			if err := repository.DeleteFinishedVideoTasksBefore(videoTaskTime(current.Add(-videoTaskFinishedRetention))); err != nil {
				log.Printf("cleanup finished video tasks failed err=%v", err)
			}
			lastCleanupAt = current
		}
		for _, task := range tasks {
			if _, loaded := inFlight.LoadOrStore(task.ID, true); loaded {
				continue
			}
			go func(task model.VideoTask) {
				defer inFlight.Delete(task.ID)
				poll := currentVideoTaskPoller()
				if poll == nil {
					return
				}
				update, err := poll(task)
				if err != nil {
					update = VideoTaskPollUpdate{Status: task.Status, ErrorDetail: err.Error()}
				}
				if err := UpdateVideoTaskFromPoll(task, update); err != nil {
					log.Printf("update video task failed id=%s err=%v", task.ID, err)
				}
			}(task)
		}
	}
}

func currentVideoTaskPoller() VideoTaskPollFunc {
	videoTaskPollerMu.RLock()
	defer videoTaskPollerMu.RUnlock()
	return videoTaskPoller
}

func UpdateVideoTaskFromPoll(task model.VideoTask, update VideoTaskPollUpdate) error {
	currentTime := time.Now()
	current := videoTaskTime(currentTime)
	task.Status = NormalizeVideoTaskStatus(firstVideoTaskValue(update.Status, task.Status))
	if task.Status == "" {
		task.Status = "processing"
	}
	if update.Progress > 0 || task.Progress == 0 {
		task.Progress = clampProgress(update.Progress)
	}
	if strings.TrimSpace(update.Seconds) != "" {
		task.Seconds = strings.TrimSpace(update.Seconds)
	}
	if strings.TrimSpace(update.Size) != "" {
		task.Size = strings.TrimSpace(update.Size)
	}
	if strings.TrimSpace(update.VideoURL) != "" {
		task.VideoURL = strings.TrimSpace(update.VideoURL)
	}
	if strings.TrimSpace(update.UpstreamVideoURL) != "" {
		task.UpstreamVideoURL = strings.TrimSpace(update.UpstreamVideoURL)
	}
	if strings.TrimSpace(update.StorageKey) != "" {
		task.StorageKey = strings.TrimSpace(update.StorageKey)
	}
	if strings.TrimSpace(update.MimeType) != "" {
		task.MimeType = strings.TrimSpace(update.MimeType)
	}
	if update.Bytes > 0 {
		task.Bytes = update.Bytes
	}
	if strings.TrimSpace(update.Error) != "" {
		task.Error = strings.TrimSpace(update.Error)
	}
	if strings.TrimSpace(update.ErrorDetail) != "" {
		task.ErrorDetail = strings.TrimSpace(update.ErrorDetail)
	}
	if update.ResponseBody != "" {
		task.LastResponse = update.ResponseBody
	}
	task.UpdatedAt = current
	task.LastPolledAt = current
	task.PollAttempts++
	if update.RateLimited {
		task.RateLimitCount++
	}
	if task.VideoURL != "" && task.StorageKey != "" || IsCompletedVideoTaskStatus(task.Status) && task.StorageKey != "" {
		task.Status = "completed"
		task.Progress = 100
		task.CompletedAt = current
		task.Error = ""
		task.ErrorDetail = ""
	} else if task.Error != "" || IsFailedVideoTaskStatus(task.Status) {
		task.Status = "failed"
		task.CompletedAt = current
	} else {
		task.Status = NormalizeVideoTaskStatus(task.Status)
		if task.Status == "completed" {
			task.Status = "processing"
		}
		task.NextPollAt = videoTaskTime(currentTime.Add(nextVideoTaskPollDelay(task, update)))
	}
	_, err := repository.SaveVideoTask(task)
	return err
}

func nextVideoTaskPollDelay(task model.VideoTask, update VideoTaskPollUpdate) time.Duration {
	if update.RateLimited {
		delay := update.RetryAfter
		if delay < 45*time.Second {
			delay = 45 * time.Second
		}
		return delay + videoTaskPollJitter(task.ID)
	}
	age := time.Since(parseVideoTaskTime(task.CreatedAt))
	base := 10 * time.Second
	if age >= 2*time.Minute {
		base = 15 * time.Second
	}
	if age >= 10*time.Minute {
		base = 30 * time.Second
	}
	return base + videoTaskPollJitter(task.ID)
}

func videoTaskPollJitter(id string) time.Duration {
	return time.Duration(crc32.ChecksumIEEE([]byte(id))%3000) * time.Millisecond
}

func parseVideoTaskTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Now()
	}
	return parsed
}

func NormalizeVideoTaskStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "complete", "done", "succeeded", "success":
		return "completed"
	case "failed", "fail", "error", "cancelled", "canceled":
		return "failed"
	case "running", "processing", "in_progress", "in-progress":
		return "processing"
	case "queued", "queue", "pending", "":
		return "queued"
	default:
		return strings.ToLower(strings.TrimSpace(status))
	}
}

func IsCompletedVideoTaskStatus(status string) bool {
	return NormalizeVideoTaskStatus(status) == "completed"
}

func IsFailedVideoTaskStatus(status string) bool {
	return NormalizeVideoTaskStatus(status) == "failed"
}

func videoTaskTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func firstVideoTaskValue(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func normalizeVideoTaskSource(source string) string {
	switch strings.ToLower(strings.TrimSpace(source)) {
	case "canvas":
		return "canvas"
	case "video-workbench", "":
		return "video-workbench"
	default:
		return "video-workbench"
	}
}

func clampProgress(value int) int {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}
