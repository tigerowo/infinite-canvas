package handler

import (
	"bytes"
	"net/http"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestNewAPIProtocolIgnoresProviderNames(t *testing.T) {
	channel := model.ModelChannel{Protocol: "newapi", BaseURL: "https://gateway.example/v1", APIKey: "test-key"}
	for _, name := range []string{"Agnes-Video-V2.0", "cogvideox-3", "doubao-seedance-2-5", "glm-tts", "mimo-v2.5-tts"} {
		for _, path := range []string{"/videos", "/videos/video_provider", "/videos/task_gateway/content", "/images/edits", "/audio/speech", "/chat/completions", "/responses"} {
			if got := resolveAIProxyPath(channel, name, path); got != path {
				t.Fatalf("%s path: %s", name, got)
			}
			if got := resolveAIProxyURL(channel, name, path); got != "https://gateway.example/v1"+path {
				t.Fatalf("%s url: %s", name, got)
			}
		}
		input := aiProtocolRequest{channel: channel, modelName: name, body: []byte(`{"model":"public-alias","prompt":"test","seconds":"15","metadata":{"canvas_video":{"version":1,"media":[]}}}`), contentType: "application/json", endpoint: "/videos", path: "/videos"}
		got, protocol, err := prepareAIProtocolRequest(input)
		if err != nil || protocol != "newapi" || !bytes.Equal(got.body, input.body) || got.contentType != input.contentType {
			t.Fatalf("%s transformed NewAPI input: %+v %v", name, got, err)
		}
		if !bytes.Equal(transformAIProtocolVideoPayload(input.body, nil, channel, name, false), input.body) {
			t.Fatal("transformed gateway response")
		}
	}
	request, _ := http.NewRequest("GET", "https://gateway.example", nil)
	service.SetModelChannelAuthHeader(request, channel)
	if request.Header.Get("Authorization") != "Bearer test-key" || request.Header.Get("x-goog-api-key") != "" {
		t.Fatal("invalid gateway auth")
	}
}

func TestNewAPITaskIdentityAndStatus(t *testing.T) {
	channel := model.ModelChannel{Protocol: "newapi"}
	parsed := parseChannelVideoTaskPayload([]byte(`{"id":"gateway-task","video_id":"video_provider","status":"in_progress","metadata":{"url":"https://example.org/input.png"},"remixed_from_video_id":"https://example.org/old.mp4"}`), "Agnes-Video-V2.0", channel)
	if parsed.UpstreamTaskID != "gateway-task" || parsed.UpstreamVideoID != "" || parsed.VideoURL != "" || parsed.Status != "processing" {
		t.Fatalf("unexpected task: %+v", parsed)
	}
	for _, payload := range []string{`{"id":"t","status":"future"}`, `{"status":"completed"}`, `not-json`} {
		if readVideoCreateErrorMessage([]byte(payload), []byte(payload), channel, "model") == "" {
			t.Fatal("invalid NewAPI submission bypassed the existing refund path")
		}
		if got := parseChannelVideoTaskPayload([]byte(payload), "model", channel); got.Status != "failed" || got.Error == "" {
			t.Fatalf("invalid payload accepted: %+v", got)
		}
	}
	got := parseChannelVideoTaskPayload([]byte(`{"data":{"id":"gateway-task","status":"completed"}}`), "model", channel)
	if got.Status != "completed" || got.Progress != 100 || got.VideoURL != "" {
		t.Fatalf("unexpected completed task: %+v", got)
	}
}
