package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestVideoCreationFailureRecovery(t *testing.T) {
	const marker = "EXT_VIDEO_FAILURE_CHILD"
	if os.Getenv(marker) != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestVideoCreationFailureRecovery$", "-test.timeout=40s")
		cmd.Env = append(os.Environ(), marker+"=1")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("isolated test: %v\n%s", err, output)
		}
		return
	}
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: ":memory:", AILogDir: t.TempDir()}
	blockProtocolNetwork(t)
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	conn.SetMaxOpenConns(1)
	defer conn.Close()
	user := model.User{ID: "owner", Username: "owner", Role: model.UserRoleAdmin, Status: model.UserStatusActive}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	channel := model.ModelChannel{ID: "fixture", Name: "fixture", Protocol: "newapi", BaseURL: "https://upstream.invalid", APIKey: "fixture", Models: []string{"fixture-video"}, Enabled: true, Weight: 1}
	if _, err := repository.SaveSettings(model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{channel}}}, "fixture"); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		name          string
		status        int
		body, message string
	}{
		{"gateway", 504, `{"error":{"message":"504 Gateway Time-out"}}`, "504 Gateway Time-out"},
		{"timeout", 408, `{"error":{"message":"generate status=408 code=timeout_error message=system under load"}}`, "system under load"},
		{"wrapped", 200, `{"code":"timeout_error","message":"system under load"}`, "system under load"},
		{"missing-id", 200, `{"status":"processing"}`, "NewAPI returned no gateway task ID"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			protocolMockHTTP(t, func(r *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: fixture.status, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(fixture.body))}, nil
			})
			id := "client_video_task_" + fixture.name
			req := httptest.NewRequest("POST", "/videos", strings.NewReader(`{"model":"fixture-video","prompt":"fixture"}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Model-Channel-ID", channel.ID)
			req.Header.Set("X-Client-Video-Task-ID", id)
			req.Header.Set("X-Video-Task-Source", "video-workbench")
			req = req.WithContext(service.WithUser(req.Context(), model.PublicUser(user)))
			writer := httptest.NewRecorder()
			AIVideos(writer, req)
			var created response
			if json.Unmarshal(writer.Body.Bytes(), &created) != nil || created.Code == 0 {
				t.Fatalf("expected creation failure: %s", writer.Body)
			}
			task, found, err := service.GetUserVideoTask(user.ID, id)
			if err != nil || !found || task.Status != "failed" || !strings.Contains(task.Error, fixture.message) {
				t.Fatalf("failure missing: %+v %v", task, err)
			}
			// A fresh request models a second browser with no local task state.
			query := httptest.NewRequest("GET", "/videos/"+id, nil)
			query = query.WithContext(service.WithUser(query.Context(), model.PublicUser(user)))
			reader := httptest.NewRecorder()
			AIVideo(reader, query, id)
			if !strings.Contains(reader.Body.String(), `"status":"failed"`) || !strings.Contains(reader.Body.String(), fixture.message) {
				t.Fatalf("wrong restored state: %s", reader.Body)
			}
			if _, found, _ := service.GetUserVideoTask("other", id); found {
				t.Fatal("cross-account leak")
			}
		})
	}
	req := httptest.NewRequest("GET", "/videos/client_video_task_missing", nil)
	req = req.WithContext(service.WithUser(req.Context(), model.PublicUser(user)))
	writer := httptest.NewRecorder()
	AIVideo(writer, req, "client_video_task_missing")
	if strings.Contains(writer.Body.String(), `"queued"`) || !strings.Contains(writer.Body.String(), "未找到") {
		t.Fatalf("fabricated queue: %s", writer.Body)
	}
}
