package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func AutoDLWorkflows(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var input struct {
		BaseURL string `json:"baseUrl"`
		WorkflowID string `json:"workflowId"`
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		Fail(w, "AutoDL 工作流参数格式错误")
		return
	}
	var result any
	var err error
	if strings.TrimSpace(input.WorkflowID) == "" {
		result, err = service.AutoDLWorkflows(input.BaseURL)
	} else {
		result, err = service.AutoDLWorkflowDetail(input.BaseURL, input.WorkflowID)
	}
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, result)
}

func prepareAutoDLRequest(input aiProtocolRequest) (aiProtocolRequest, bool, error) {
	if !service.IsAutoDLChannel(input.channel) {
		return input, false, nil
	}
	input.failureLabel = "AutoDL"
	kind := service.AutoDLModelKind(input.modelName)
	if input.endpoint != "/videos" && input.endpoint != "/audio/speech" || input.endpoint == "/videos" && kind != "video" || input.endpoint == "/audio/speech" && kind != "audio" {
		return input, true, errors.New("该 AutoDL 工作流不支持当前生成接口")
	}
	payload := map[string]any{}
	if json.Unmarshal(input.body, &payload) != nil {
		return input, true, errors.New("AutoDL 请求参数格式错误")
	}
	var err error
	input.body, err = service.TranslateAutoDLRequest(input.channel.BaseURL, input.modelName, payload)
	input.contentType = "application/json"
	return input, true, err
}

func transformAutoDLVideoResponse(payload []byte) []byte {
	result, err := service.ReadAutoDLTask(payload, "video")
	output := map[string]any{"id": result.ID, "task_id": result.ID, "status": result.Status, "progress": 0}
	if err != nil {
		output["status"], output["error"] = "failed", map[string]string{"message": err.Error()}
	} else if result.URL != "" && result.Status == "completed" {
		output["video_url"], output["progress"] = result.URL, 100
	}
	encoded, _ := json.Marshal(output)
	return encoded
}

func copyAutoDLResponse(w http.ResponseWriter, response *http.Response, request *http.Request, channel model.ModelChannel, logContext aiLogContext, onFailure func()) bool {
	if !service.IsAutoDLChannel(channel) {
		return false
	}
	if logContext.Endpoint != "/audio/speech" && !strings.HasPrefix(logContext.Endpoint, "/videos/") {
		return false
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err == nil && logContext.Endpoint != "/audio/speech" {
		w.Header().Set("Content-Type", "application/json")
		encoded := transformAutoDLVideoResponse(payload)
		_, _ = w.Write(encoded)
		saveAIProxyLog(logContext, response.StatusCode, string(encoded), "")
		return true
	}
	var result service.AutoDLTaskResult
	if err == nil {
		result, err = service.WaitAutoDLAudio(request.Context(), channel, payload)
	}
	if err != nil {
		if onFailure != nil {
			onFailure()
		}
		saveAIProxyLog(logContext, response.StatusCode, string(payload), err.Error())
		Fail(w, err.Error())
		return true
	}
	encoded, _ := json.Marshal(map[string]string{"provider": "autodl", "audio_url": result.URL, "mime_type": result.MimeType})
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(encoded)
	saveAIProxyLog(logContext, response.StatusCode, string(encoded), "")
	return true
}
