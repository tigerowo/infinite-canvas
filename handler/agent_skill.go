package handler

import (
	"encoding/json"
	"net/http"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func AgentSkills(w http.ResponseWriter, _ *http.Request) {
	items, err := service.ListEnabledSystemAgentSkills()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, items)
}

func AgentSkillFile(w http.ResponseWriter, r *http.Request, id string) {
	item, err := service.ReadEnabledSystemAgentSkillFile(id, r.URL.Query().Get("path"))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, item)
}

func UserAgentSkills(w http.ResponseWriter, r *http.Request) {
	items, err := service.ListCurrentUserAgentSkills(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, items)
}

func SaveUserAgentSkill(w http.ResponseWriter, r *http.Request) {
	var item model.AgentSkill
	if err := json.NewDecoder(r.Body).Decode(&item); err != nil {
		Fail(w, "Skill 数据格式错误")
		return
	}
	saved, err := service.SaveCurrentUserAgentSkill(r.Context(), item)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, saved)
}

func DeleteUserAgentSkill(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeleteCurrentUserAgentSkill(r.Context(), id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func AdminAgentSkills(w http.ResponseWriter, _ *http.Request) {
	items, err := service.ListSystemAgentSkills()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, items)
}

func AdminAgentSkillFiles(w http.ResponseWriter, _ *http.Request, id string) {
	items, err := service.ListSystemAgentSkillFiles(id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, items)
}

func AdminSaveAgentSkill(w http.ResponseWriter, r *http.Request) {
	var item model.AgentSkill
	if err := json.NewDecoder(r.Body).Decode(&item); err != nil {
		Fail(w, "Skill 数据格式错误")
		return
	}
	saved, err := service.SaveSystemAgentSkill(item)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, saved)
}

func AdminDeleteAgentSkill(w http.ResponseWriter, _ *http.Request, id string) {
	if err := service.DeleteSystemAgentSkill(id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}
