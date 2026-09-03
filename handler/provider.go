package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

const providerRequestLimit = 256 * 1024

func UserProviders(w http.ResponseWriter, r *http.Request) {
	kind := model.ProviderKind(strings.ToLower(strings.TrimSpace(r.URL.Query().Get("kind"))))
	items, err := service.CurrentUserProviders(r.Context(), kind)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, items)
}

func UserProviderMigrationPreview(w http.ResponseWriter, r *http.Request) {
	preview, err := service.CurrentUserProviderMigrationPreview(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, preview)
}

func MigrateUserProviders(w http.ResponseWriter, r *http.Request) {
	var request struct {
		CleanupLegacy bool `json:"cleanupLegacy"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, providerRequestLimit)
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "迁移参数格式错误")
		return
	}
	result, err := service.MigrateCurrentUserProviders(r.Context(), request.CleanupLegacy)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func SaveUserProvider(w http.ResponseWriter, r *http.Request) {
	var input service.ProviderInput
	r.Body = http.MaxBytesReader(w, r.Body, providerRequestLimit)
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		Fail(w, "渠道配置格式错误或内容过大")
		return
	}
	item, err := service.SaveCurrentUserProvider(r.Context(), input)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, item)
}

func DeleteUserProvider(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeleteCurrentUserProvider(r.Context(), id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

func SetDefaultUserProvider(w http.ResponseWriter, r *http.Request, id string) {
	item, err := service.SetCurrentUserDefaultProvider(r.Context(), id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, item)
}

func TestUserProvider(w http.ResponseWriter, r *http.Request, id string) {
	var request struct {
		RefreshModels bool `json:"refreshModels"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, providerRequestLimit)
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "测试参数格式错误")
		return
	}
	result, err := service.TestCurrentUserProvider(r.Context(), id, request.RefreshModels)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}
