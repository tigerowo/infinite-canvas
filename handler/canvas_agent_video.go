package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/tigerowo/infinite-canvas/service"
)

func StartCanvasVideoAnalysis(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, service.MaxCanvasAnalysisVideoBytes+(1<<20))
	form, err := r.MultipartReader()
	if err != nil {
		FailWithStatus(w, http.StatusBadRequest, "请提交一个视频文件或视频 URL")
		return
	}

	part, err := form.NextPart()
	if err != nil {
		FailWithStatus(w, http.StatusBadRequest, "缺少视频文件或视频 URL")
		return
	}

	var upload io.Reader
	var videoURL string
	switch part.FormName() {
	case "file":
		if part.FileName() == "" {
			FailWithStatus(w, http.StatusBadRequest, "请选择视频文件")
			return
		}
		upload = part
	case "url":
		data, err := io.ReadAll(io.LimitReader(part, 8193))
		if err != nil || len(data) == 0 || len(data) > 8192 {
			FailWithStatus(w, http.StatusBadRequest, "视频 URL 无效")
			return
		}
		videoURL = string(data)
	default:
		FailWithStatus(w, http.StatusBadRequest, "视频来源字段无效")
		return
	}

	verifyEnd := func() error {
		if _, err := form.NextPart(); !errors.Is(err, io.EOF) {
			return service.ErrCanvasVideoSourceForm
		}
		return nil
	}
	if upload == nil {
		if err := verifyEnd(); err != nil {
			failCanvasVideoAnalysis(w, err)
			return
		}
		verifyEnd = nil
	}
	result, err := service.StartCanvasVideoAnalysis(r.Context(), upload, videoURL, verifyEnd)
	if err != nil {
		failCanvasVideoAnalysis(w, err)
		return
	}
	OK(w, result)
}

func CanvasVideoAnalysisFrames(w http.ResponseWriter, r *http.Request, id string) {
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var window service.CanvasVideoFrameWindow
	if err := json.NewDecoder(r.Body).Decode(&window); err != nil {
		FailWithStatus(w, http.StatusBadRequest, "视频取帧参数无效")
		return
	}
	batch, err := service.ReadCanvasVideoAnalysisFrames(r.Context(), id, window)
	if err != nil {
		failCanvasVideoAnalysis(w, err)
		return
	}
	OK(w, batch)
}

func CloseCanvasVideoAnalysis(w http.ResponseWriter, r *http.Request, id string) {
	service.CloseCanvasVideoAnalysis(r.Context(), id)
	OK(w, nil)
}

func failCanvasVideoAnalysis(w http.ResponseWriter, err error) {
	var sizeErr *http.MaxBytesError
	switch {
	case errors.Is(err, service.ErrCanvasVideoSourceForm):
		FailWithStatus(w, http.StatusBadRequest, service.ErrCanvasVideoSourceForm.Error())
	case errors.Is(err, service.ErrCanvasVideoSourceUnavailable):
		FailWithStatus(w, http.StatusFailedDependency, service.ErrCanvasVideoSourceUnavailable.Error())
	case errors.Is(err, service.ErrCanvasVideoAnalysisNotFound):
		FailWithStatus(w, http.StatusNotFound, service.ErrCanvasVideoAnalysisNotFound.Error())
	case errors.Is(err, service.ErrCanvasVideoAnalysisBusy):
		FailWithStatus(w, http.StatusTooManyRequests, service.ErrCanvasVideoAnalysisBusy.Error())
	case errors.Is(err, service.ErrCanvasVideoTooLarge), errors.As(err, &sizeErr):
		FailWithStatus(w, http.StatusRequestEntityTooLarge, service.ErrCanvasVideoTooLarge.Error())
	case errors.Is(err, service.ErrCanvasVideoNoDecoder):
		FailWithStatus(w, http.StatusUnprocessableEntity, service.ErrCanvasVideoNoDecoder.Error())
	default:
		FailWithStatus(w, http.StatusUnprocessableEntity, "视频无法读取或取帧失败")
	}
}
