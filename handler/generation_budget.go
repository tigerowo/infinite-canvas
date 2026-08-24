package handler

import (
	"net/http"

	"github.com/tigerowo/infinite-canvas/service"
)

func reserveGenerationTaskSlot(w http.ResponseWriter, r *http.Request, userID string) (func(), bool) {
	release, err := service.ReserveGenerationTaskSlot(r.Context(), userID)
	if err == nil {
		return release, true
	}
	if safe, ok := err.(interface{ SafeMessage() string }); ok {
		FailWithStatus(w, http.StatusTooManyRequests, safe.SafeMessage())
	} else {
		FailError(w, err)
	}
	return nil, false
}
