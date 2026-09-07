package newapi

import (
	"encoding/json"
	"fmt"
)

type VideoTask struct {
	UpstreamTaskID  string
	UpstreamVideoID string
	Status          string
	Progress        int
	Seconds         string
	Size            string
	VideoURL        string
	Error           string
	ErrorDetail     string
}

func ParseVideoTask(payload []byte) VideoTask {
	var root map[string]json.RawMessage
	if json.Unmarshal(payload, &root) != nil {
		return VideoTask{Status: "failed", Error: "NewAPI returned invalid JSON"}
	}
	if nested := root["data"]; len(nested) > 0 && nested[0] == '{' {
		if json.Unmarshal(nested, &root) != nil {
			return VideoTask{Status: "failed", Error: "NewAPI returned invalid task data"}
		}
	}
	read := func(key string) string {
		var value any
		if json.Unmarshal(root[key], &value) != nil || value == nil {
			return ""
		}
		switch value.(type) {
		case string, float64:
			return fmt.Sprint(value)
		}
		return ""
	}
	result := VideoTask{UpstreamTaskID: read("id"), Status: read("status"), Seconds: read("seconds"), Size: read("size")}
	_ = json.Unmarshal(root["progress"], &result.Progress)
	var errorBody struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal(root["error"], &errorBody)
	result.Error = errorBody.Message
	switch result.Status {
	case "queued", "pending":
		result.Status = "queued"
	case "in_progress", "processing":
		result.Status = "processing"
	case "completed":
		result.Progress = 100
	case "failed", "cancelled", "canceled":
		result.Status = "failed"
	default:
		result.Status = "failed"
		if result.Error == "" {
			result.Error = "NewAPI returned an unknown video status"
		}
	}
	if result.UpstreamTaskID == "" {
		result.Status = "failed"
		if result.Error == "" {
			result.Error = "NewAPI returned no gateway task ID"
		}
	}
	if result.Status == "failed" && result.Error == "" {
		result.Error = "NewAPI video task failed"
	}
	if result.Error != "" {
		result.ErrorDetail = string(payload)
	}
	// Download through the gateway content endpoint. Provider IDs and metadata
	// URLs cannot change polling identity, status or the resulting video URL.
	return result
}
