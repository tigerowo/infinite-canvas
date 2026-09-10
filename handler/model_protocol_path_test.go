package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

// Expectations characterize the pre-registry implementation, including overlaps
// where the explicit protocol is not the only routing condition.
func TestModelProtocolProxyPathContract(t *testing.T) {
	tests := []struct {
		name, protocol, baseURL, model, path, want string
	}{
		{"autodl create before URL inference", "autodl", "https://api.kie.ai", "minimax_h3_b99_002", "/videos", "/api/v1/comfyui/comfyui_workflow/minimax_h3_b99_002"},
		{"autodl audio", "autodl", "", "indextts2-v1", "/audio/speech", "/api/v1/comfyui/comfyui_workflow/indextts2-v1"},
		{"autodl poll escaped", "autodl", "", "minimax_h3_b99_002", "/videos/task a?b", "/api/v1/comfyui/comfyui_workflow/result/task%20a%3Fb"},
		{"gemini chat", "gemini", "", "models/gemini-test", "/chat/completions", "/v1beta/models/gemini-test:streamGenerateContent?alt=sse"},
		{"gemini speech before mimo", "gemini", "", "mimo-v2.5-tts", "/audio/speech", "/v1beta/models/mimo-v2.5-tts:generateContent"},
		{"gemini video before cog", " GEMINI ", "https://api.kie.ai", "cogvideox-3", "/videos", "/v1beta/models/cogvideox-3:predictLongRunning"},
		{"gemini operation", "gemini", "", "veo", "/videos/operations/task", "/v1beta/operations/task"},
		{"minimax create before kie URL", "metaso", "https://api.kie.ai", "MiniMax-H3", "/videos", "/v2/video_generation"},
		{"minimax other endpoint stops kie", "metaso", "https://api.kie.ai", "MiniMax-H3", "/images/generations", "/images/generations"},
		{"cog before kie", "kie", "", " COGVIDEOX-3 ", "/videos", "/videos/generations"},
		{"kie grok image special", "kie", "", " GROK-IMAGINE-IMAGE-2-0/TEXT-TO-IMAGE ", "/images/generations", "/client/tasks"},
		{"kie URL beats apimart", "apimart", "https://api.kie.ai", "sora-2", "/videos", "/jobs/createTask"},
		{"kie model marker beats apimart", "apimart", "", "vendor/kie/model", "/videos", "/jobs/createTask"},
		{"kie beats seedance", "kie", "", "bytedance/seedance-2", "/videos", "/jobs/createTask"},
		{"kie query escaped", "kie", "", "video-model", "/videos/task a+b?c", "/jobs/recordInfo?taskId=task+a%2Bb%3Fc"},
		{"kie content unchanged", "kie", "", "video-model", "/videos/task/content", "/videos/task/content"},
		{"apimart video before seedance", " APIMART ", "", "doubao-seedance-2", "/videos", "/videos/generations"},
		{"apimart image edit", "apimart", "", "gpt-image-2", "/images/edits", "/images/generations"},
		{"apimart grok edit kept", "apimart", "", "GROK_IMAGINE/edit", "/images/edits", "/images/edits"},
		{"apimart query escaped", "apimart", "", "video-model", "/videos/task a?b", "/tasks/task%20a%3Fb?language=zh"},
		{"grok2api 1.5 before ark URL", " GROK2API ", "https://api.example/api/plan/v3", " GROK-IMAGINE-VIDEO-1.5 ", "/videos", "/videos/generations"},
		{"ark by model", "openai", "", "doubao-seedance-2", "/videos", "/contents/generations/tasks"},
		{"ark by URL", "88api", "https://api.example/API/PLAN/V3", "deployment-id", "/videos", "/contents/generations/tasks"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			channel := model.ModelChannel{Protocol: test.protocol, BaseURL: test.baseURL}
			if got := resolveAIProxyPath(channel, test.model, test.path); got != test.want {
				t.Fatalf("got %q, want %q", got, test.want)
			}
		})
	}
	for _, protocol := range []string{"", "openai", "grok2api", "metaso", "mimo", "88api", "future-protocol"} {
		for _, path := range []string{"/chat/completions", "/responses", "/images/generations", "/images/edits", "/audio/speech", "/videos", "/videos/task", "/models"} {
			if got := resolveAIProxyPath(model.ModelChannel{Protocol: protocol}, "future-model", path); got != path {
				t.Errorf("passthrough %q %q: got %q", protocol, path, got)
			}
		}
	}
}

func TestModelProtocolProxyURLContract(t *testing.T) {
	tests := []struct {
		name, protocol, baseURL, model, path, want string
	}{
		{"default version", "openai", " https://api.example/ ", "model", "/models", "https://api.example/v1/models"},
		{"existing v1", "openai", "https://api.example/v1/", "model", "/videos", "https://api.example/v1/videos"},
		{"gemini base version", "gemini", "https://api.example/v1beta/", "model", "/v1beta/models/model:generateContent", "https://api.example/v1beta/models/model:generateContent"},
		{"metaso no v1", "metaso", "https://api.example/", "MiniMax-H3", "/v2/video_generation", "https://api.example/v2/video_generation"},
		{"autodl no v1", "autodl", "https://api.example/", "minimax_h3_b99_002", "/api/v1/comfyui/comfyui_workflow/minimax_h3_b99_002", "https://api.example/api/v1/comfyui/comfyui_workflow/minimax_h3_b99_002"},
		{"agnes query", "openai", "https://api.example/v1/", "agnes-video-2.5", "/videos/video_a b", "https://api.example/agnesapi?model_name=agnes-video-2.5&video_id=video_a+b"},
		{"agnes wins protocol URL builder", "gemini", "https://api.example/v1", "agnes-video-2.5", "/videos/video_task", "https://api.example/agnesapi?model_name=agnes-video-2.5&video_id=video_task"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			channel := model.ModelChannel{Protocol: test.protocol, BaseURL: test.baseURL}
			if got := resolveAIProxyURL(channel, test.model, test.path); got != test.want {
				t.Fatalf("got %q, want %q", got, test.want)
			}
		})
	}
}

func TestModelProtocolProxyPreparationOrder(t *testing.T) {
	blockProtocolNetwork(t)
	tests := []struct {
		name, protocol, baseURL, model, endpoint, path, body string
		wantPath, wantBody, wantLabel, wantError             string
		mode                                                 aiProtocolRequestMode
	}{
		{
			name: "Gemini continues MiMo and retains Gemini path", protocol: "gemini", baseURL: "https://api.kie.ai", model: "mimo-v2.5-tts", endpoint: "/audio/speech",
			body:     `{"model":"discarded-by-Gemini","stream":true,"input":" hello ","instructions":" calm ","response_format":"MP3"}`,
			wantPath: "/v1beta/models/mimo-v2.5-tts:generateContent", wantLabel: "MiMo TTS",
			wantBody: `{"model":"mimo-v2.5-tts","messages":[{"role":"user","content":"calm"},{"role":"assistant","content":"hello"}],"audio":{"format":"mp3","voice":"冰糖"}}`,
		},
		{
			name: "Gemini malformed body stops before MiMo", protocol: "gemini", model: "mimo-v2.5-tts", endpoint: "/audio/speech", body: `{`,
			wantPath: "/v1beta/models/mimo-v2.5-tts:generateContent", wantLabel: "Gemini", wantError: "unexpected end of JSON input",
		},
		{
			name: "Gemini video stops before KIE", protocol: "gemini", baseURL: "https://api.kie.ai", model: "future-model", path: "/jobs/createTask", mode: aiProtocolVideoRequest,
			body:     `{"model":"inner","stream":true,"prompt":"scene","seconds":7}`,
			wantPath: "/jobs/createTask", wantLabel: "Gemini", wantBody: `{"prompt":"scene","seconds":7}`,
		},
		{
			name: "video KIE mismatch continues APIMart", protocol: "apimart", baseURL: "https://api.kie.ai", model: "future-model", path: "/videos/generations", mode: aiProtocolVideoRequest,
			body:     `{"prompt":"scene","seconds":"7s"}`,
			wantPath: "/videos/generations", wantLabel: "APIMart video", wantBody: `{"model":"future-model","prompt":"scene","duration":7}`,
		},
		{
			name: "compatible passthrough", protocol: "unknown", model: "future-model", endpoint: "/chat/completions", body: `not JSON`,
			wantPath: "/chat/completions", wantBody: `not JSON`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			channel := model.ModelChannel{Protocol: test.protocol, BaseURL: test.baseURL}
			path := test.path
			if path == "" {
				path = resolveAIProxyPath(channel, test.model, test.endpoint)
			}
			// Exercise the pure stage extracted from proxyAIRequest, without its
			// database selection, billing, upstream request or logging side effects.
			got, _, err := prepareAIProtocolRequest(aiProtocolRequest{
				mode: test.mode, channel: channel, modelName: test.model,
				endpoint: test.endpoint, path: path, contentType: "application/json", body: []byte(test.body),
			})
			if got.path != test.wantPath || got.failureLabel != test.wantLabel {
				t.Fatalf("got path %q, stage %q; want %q, %q", got.path, got.failureLabel, test.wantPath, test.wantLabel)
			}
			if test.wantError != "" {
				if err == nil || err.Error() != test.wantError {
					t.Fatalf("got error %v; want %q", err, test.wantError)
				}
				return
			}
			if err != nil || got.contentType != "application/json" {
				t.Fatalf("got content type %q, error %v", got.contentType, err)
			}
			assertProtocolBytes(t, got.body, []byte(test.wantBody))
		})
	}
}

// Ordinary conversion fixtures live in RequestGoldens; these lock down overlapping routes.
func TestModelProtocolVideoResponsePrecedence(t *testing.T) {
	const kie = `{"code":200,"data":{"taskId":"task"}}`
	const apimart = `{"code":200,"data":[{"task_id":"task","status":"submitted"}]}`
	const video = `{"id":"task","object":"video","status":"processing","model":"future-model"}`
	const gemini = `{"name":"operations/task","code":200,"data":{"taskId":"task"}}`
	const geminiVideo = `{"id":"operations/task","task_id":"operations/task","status":"processing","progress":0,"video_url":"","error":{"message":""}}`
	const failed = `{"code":200,"data":{"id":"task","status":"failed","error":{"message":"failed"}}}`
	tests := []struct {
		name, protocol, path, body, create, status string
	}{
		{"Gemini before KIE create", "gemini", "/jobs/createTask", gemini, geminiVideo, geminiVideo},
		{"Gemini before KIE status", "gemini", "/jobs/recordInfo", gemini, geminiVideo, geminiVideo},
		{"KIE URL before APIMart", "apimart", "/jobs/createTask", kie, video, kie},
		{"KIE path mismatch continues APIMart", "apimart", "/videos/generations", apimart, video, apimart},
		{"KIE status path mismatch continues APIMart", "apimart", "/tasks/task", failed, failed, `{"id":"task","object":"video","status":"failed","progress":0,"model":"future-model","error":"failed"}`},
		{"unmatched path passes through", "apimart", "/videos", kie, kie, kie},
		{"malformed body passes through", "apimart", "/videos/generations", "{", "{", "{"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			channel := model.ModelChannel{Protocol: test.protocol, BaseURL: "https://api.kie.ai"}
			request := httptest.NewRequest(http.MethodPost, "https://upstream.invalid"+test.path, nil)
			assertProtocolBytes(t, transformVideoCreatePayload([]byte(test.body), request, channel, "future-model"), []byte(test.create))
			assertProtocolBytes(t, transformVideoStatusPayload([]byte(test.body), request, channel, "future-model"), []byte(test.status))
		})
	}
}
