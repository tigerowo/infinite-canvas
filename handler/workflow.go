package handler

import (
	"encoding/json"
	"net/http"

	"github.com/tigerowo/infinite-canvas/service"
)

func UserWorkflows(w http.ResponseWriter, r *http.Request) {
	workflows, err := service.ListCreativeWorkflows(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, workflows)
}

func SaveUserWorkflow(w http.ResponseWriter, r *http.Request) {
	var request service.CreativeWorkflowPayload
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "工作流数据格式错误")
		return
	}
	workflow, err := service.SaveCreativeWorkflow(r.Context(), request)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, workflow)
}

func DeleteUserWorkflow(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeleteCreativeWorkflow(r.Context(), id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func DraftUserWorkflow(w http.ResponseWriter, r *http.Request) {
	var request service.WorkflowAgentDraftRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "工作流需求格式错误")
		return
	}
	result, err := service.DraftCreativeWorkflow(r.Context(), request)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminAICallLogs(w http.ResponseWriter, r *http.Request) {
	list, err := service.ListAICallLogs(parseQuery(r))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, list)
}

// ClientAICallLog 接收前端本地直连渠道的 AI 调用日志上报。
func ClientAICallLog(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok || user.ID == "" {
		Fail(w, "请先登录")
		return
	}
	var request service.AICallLogInput
	_ = json.NewDecoder(r.Body).Decode(&request)
	if !service.LocalDirectAILogEnabled() {
		OK(w, true)
		return
	}
	request.UserID = user.ID
	request.UserDisplayName = firstNonEmpty(user.DisplayName, user.Username)
	service.SaveAICallLog(request)
	OK(w, true)
}
