package handler

import (
	"encoding/json"
	"net/http"

	"github.com/tigerowo/infinite-canvas/service"
)

// InspectComfyWorkflow 直连渠道不经过 Bridge，直接解析前端提交的 ComfyUI API JSON。
func InspectComfyWorkflow(w http.ResponseWriter, r *http.Request) {
	var input service.ComfyWorkflowInspectInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&input); err != nil {
		Fail(w, "请求参数无效")
		return
	}
	result, err := service.InspectComfyWorkflow(input)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}
