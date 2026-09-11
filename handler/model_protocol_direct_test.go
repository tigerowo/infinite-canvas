package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// Literal fixtures were derived from HEAD before introducing the registry.
// Keep representative field, reference and model-specific normalization contracts.
func TestModelProtocolRequestGoldens(t *testing.T) {
	blockProtocolNetwork(t)
	tests := []struct {
		name, protocol, model, endpoint, body, want, uploads string
	}{
		{
			name: "kie wrapper precedence", protocol: "kie", model: "future-model",
			body: `{"prompt":"outer","duration":9,"seconds":"7s","input":{"prompt":"inner","custom":false,"n":2,"stream":true},"custom":true,"size":"1920x1080","resolution":"1080","quality":"high","output_format":"png","callbackUrl":"https://media.invalid/second","callBackUrl":" https://media.invalid/first "}`,
			want: `{"model":"future-model","input":{"prompt":"outer","custom":false,"duration":"7"},"callBackUrl":"https://media.invalid/first"}`,
		},
		{
			name: "kie seedance auto duration", protocol: "kie", model: "bytedance/seedance-2-5",
			body: `{"prompt":"scene","seconds":"-1s","size":"1920x1080","resolution":"4k","video_generate_audio":false}`,
			want: `{"model":"bytedance/seedance-2-5","input":{"prompt":"scene","duration":-1,"aspect_ratio":"16:9","resolution":"720p","generate_audio":false}}`,
		},
		{
			name: "kie kling duration is not numeric", protocol: "kie", model: "kling/text-to-video",
			body: `{"prompt":"scene","duration":10,"video_generate_audio":true,"resolution":"1080"}`,
			want: `{"model":"kling-2.6/text-to-video","input":{"prompt":"scene","duration":"10","sound":true}}`,
		},
		{
			name: "kie kling omni pure video", protocol: "kie", model: "kling-3.0-omni/transformation",
			body: `{"prompt":"scene","duration":10,"size":"16:9","mode":"pro","video_reference":["https://media.invalid/video.mp4"],"multi_shot":true,"shot_type":"customize","multi_prompt":[{"prompt":"shot","duration":5}],"negative_prompt":"bad","video_generate_audio":true}`,
			want: `{"model":"kling-3.0-omni/transformation","input":{"prompt":"scene","aspect_ratio":"auto","resolution":"1080p","video_urls":["https://media.invalid/video.mp4"],"audio":true}}`,
		},
		{
			name: "kie seedream layer decomposition", protocol: "kie", model: "seedream/5-pro-layer-decomposition", endpoint: "/images/edits",
			body: `{"prompt":"scene","image":"https://media.invalid/image.png","quality":"high","n":4,"output_format":"jpeg","stream":true}`,
			want: `{"model":"seedream/5-pro-layer-decomposition","input":{"prompt":"scene","image_url":"https://media.invalid/image.png","size":"2K","output_format":"png"}}`,
		},
		{
			name: "kie image alias count and size", protocol: "kie", model: "seedream/seedream-v4-text-to-image", endpoint: "/images/generations",
			body: `{"prompt":"scene","size":"1920x1080","resolution":"4k","n":"2","num_images":3}`,
			want: `{"model":"bytedance/seedream-v4-text-to-image","input":{"prompt":"scene","image_size":"landscape_16_9","image_resolution":"4K","max_images":3}}`,
		},
		{
			name: "apimart sora caps resolution and preserves images", protocol: "apimart", model: "sora-2",
			body: `{"prompt":"scene","size":"1920x1080","seconds":"5s","resolution_name":"1080","image":["https://media.invalid/first.png","https://media.invalid/last.png"],"preset":"x"}`,
			want: `{"model":"sora-2","prompt":"scene","duration":5,"resolution":"720p","image_urls":["https://media.invalid/first.png","https://media.invalid/last.png"]}`,
		},
		{
			name: "apimart kling indexed shots", protocol: "apimart", model: "kling-v3",
			body: `{"prompt":"scene","seconds":"2s","size":"16:9","resolution":"1080","mode":"pro","negative_prompt":"bad","multi_shot":true,"shot_type":"customize","multi_prompt":[{"prompt":"first","duration":0},{"prompt":"last","duration":99}],"video_generate_audio":true}`,
			want: `{"model":"kling-v3","prompt":"scene","duration":2,"aspect_ratio":"16:9","mode":"pro","negative_prompt":"bad","multi_shot":true,"shot_type":"customize","multi_prompt":[{"index":1,"prompt":"first","duration":1},{"index":2,"prompt":"last","duration":15}],"audio":true}`,
		},
		{
			name: "apimart motion control no duration", protocol: "apimart", model: "kling-v2-6-motion-control",
			body: `{"prompt":"scene","seconds":10,"size":"16:9","resolution":"1080","image":"https://media.invalid/image.png","video_reference":["https://media.invalid/video.mp4"],"keep_original_sound":true,"watermark_info":true}`,
			want: `{"model":"kling-v2-6-motion-control","prompt":"scene","image_url":"https://media.invalid/image.png","video_url":"https://media.invalid/video.mp4","character_orientation":"video","mode":"std"}`,
		},
		{
			name: "apimart omni video excludes generated audio", protocol: "apimart", model: "kling-v3-omni",
			body: `{"prompt":"scene","seconds":5,"size":"16:9","resolution":"1080","video_reference":["https://media.invalid/video.mp4"],"video_generate_audio":true}`,
			want: `{"model":"kling-v3-omni","prompt":"scene","duration":5,"aspect_ratio":"16:9","mode":"pro","video_list":[{"video_url":"https://media.invalid/video.mp4","refer_type":"base","keep_original_sound":"no"}]}`,
		},
		{
			name: "apimart official image output", protocol: "apimart", model: "gpt-image-2-official", endpoint: "/images/edits",
			body: `{"prompt":"scene","size":"2048x1024","quality":"HIGH","output_format":"JPG","n":"3","image":["https://media.invalid/image.png","https://media.invalid/image.png"]}`,
			want: `{"model":"gpt-image-2-official","prompt":"scene","size":"2:1","resolution":"2k","quality":"high","output_format":"jpeg","n":3,"image_urls":["https://media.invalid/image.png"]}`,
		},
		{
			name: "apimart seedream image caps resolution drops count", protocol: "apimart", model: "seedream-5-0-pro", endpoint: "/images/generations",
			body: `{"prompt":"scene","resolution":"4K","quality":"high","n":4,"output_format":"jpg"}`,
			want: `{"model":"seedream-5-0-pro","prompt":"scene","resolution":"2K"}`,
		},
		{
			name: "kie upload metadata", protocol: "kie", model: "bytedance/seedance-2", endpoint: "/videos",
			body:    `{"prompt":"scene","image":"https://direct-reference.invalid/run/image/0","video_reference":["https://direct-reference.invalid/run/video/0"],"audio_reference":["https://direct-reference.invalid/run/audio/0"]}`,
			uploads: `{"image":{"url":"https://kieai.redpandaai.co/api/file-stream-upload","fileField":"file","fileNameField":"fileName","extraFields":{"uploadPath":"images/user-uploads"},"responsePaths":["data.downloadUrl","data.fileUrl","data.url"]},"video":{"url":"https://kieai.redpandaai.co/api/file-stream-upload","fileField":"file","fileNameField":"fileName","extraFields":{"uploadPath":"videos/user-uploads"},"responsePaths":["data.downloadUrl","data.fileUrl","data.url"]},"audio":{"url":"https://kieai.redpandaai.co/api/file-stream-upload","fileField":"file","fileNameField":"fileName","extraFields":{"uploadPath":"audios/user-uploads"},"responsePaths":["data.downloadUrl","data.fileUrl","data.url"]}}`,
		},
		{
			name: "apimart upload metadata", protocol: "apimart", model: "gpt-image-2-apimart", endpoint: "/images/edits",
			body:    `{"prompt":"scene","image":"https://direct-reference.invalid/run/image/0"}`,
			uploads: `{"image":{"url":"https://upstream.invalid/v1/uploads/images","fileField":"file","responsePaths":["url"]}}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			endpoint := test.endpoint
			if endpoint == "" {
				endpoint = "/videos"
			}
			input := directAIRequestInput{
				Channel: directAIChannelInput{Protocol: test.protocol, BaseURL: "https://upstream.invalid"},
				Model:   test.model, Endpoint: endpoint, Body: protocolJSON(t, test.body),
			}
			plan, err := prepareDirectAIRequest(input)
			if err != nil {
				t.Fatal(err)
			}
			if plan.Provider != test.protocol || plan.ContentType != "application/json" {
				t.Fatalf("unexpected direct plan: %#v", plan)
			}
			if test.want != "" {
				assertProtocolJSONValue(t, plan.Body, test.want)
			}
			if test.uploads != "" {
				assertProtocolJSONValue(t, plan.Uploads, test.uploads)
			} else if len(plan.Uploads) != 0 {
				t.Fatalf("unexpected upload instructions: %#v", plan.Uploads)
			}
			assertProtocolJSONValue(t, input.Body, test.body)
		})
	}
}

func TestModelProtocolDirectSecurityContract(t *testing.T) {
	blockProtocolNetwork(t)
	tests := []struct {
		name, protocol, baseURL, model, endpoint string
		body                                     any
		want                                     string
	}{
		{"missing model first", "kie", "bad", "", "/bad", nil, "缺少模型名称"},
		{"unsupported endpoint", "kie", "bad", "model", "/audio/speech", nil, "当前接口不支持本地参数转译"},
		{"invalid base", "kie", "ftp://api.example", "model", "/videos", nil, "渠道地址格式错误"},
		{"nested key", "kie", "", "model", "", map[string]any{"input": []any{map[string]any{" API_KEY ": "secret"}}}, "参数转译请求不能包含 API Key"},
		{"nested data URL", "kie", "", "model", "", map[string]any{"input": []any{" DATA:image/png;base64,AAAA "}}, "参考文件不能传给参数转译接口"},
		{"nested blob URL", "kie", "", "model", "", map[string]any{"input": []any{"blob:https://local.invalid/id"}}, "参考文件不能传给参数转译接口"},
		{"unsupported protocol", "openai", "", "model", "", map[string]any{"prompt": "scene"}, "当前渠道不支持本地复用后端转译"},
		{"kie required input", "kie", "", "kling-3.0-omni/image-to-video", "", map[string]any{"prompt": "scene"}, "KIE required input missing: image_urls"},
		{"apimart required input", "apimart", "", "kling-v2-6-motion-control", "", map[string]any{"prompt": "scene"}, "motion-control 模型缺少参考图和参考视频"},
		{"apimart video marker", "apimart", "", "doubao-seedance-2", "", map[string]any{"video_reference": []any{"https://direct-reference.invalid/run/video/0"}}, "APIMart 本地视频和音频参考暂不支持直传，请使用公网媒体地址"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			baseURL, endpoint := test.baseURL, test.endpoint
			if baseURL == "" {
				baseURL = "https://upstream.invalid"
			}
			if endpoint == "" {
				endpoint = "/videos"
			}
			_, err := prepareDirectAIRequest(directAIRequestInput{
				Channel: directAIChannelInput{Protocol: test.protocol, BaseURL: baseURL},
				Model:   test.model, Endpoint: endpoint, Body: test.body,
			})
			if err == nil || err.Error() != test.want {
				t.Fatalf("got error %v, want %q", err, test.want)
			}
		})
	}
}

func TestModelProtocolDirectHTTPEnvelope(t *testing.T) {
	blockProtocolNetwork(t)
	tests := []struct {
		name, body, want string
	}{
		{"anonymous success", `{"channel":{"protocol":"kie","baseUrl":"https://upstream.invalid"},"model":"future-model","endpoint":"/videos","body":{"prompt":"scene"}}`, `{"code":0,"data":{"provider":"kie","url":"https://upstream.invalid/v1/jobs/createTask","contentType":"application/json","body":{"model":"future-model","input":{"prompt":"scene"}}},"msg":"ok"}`},
		{"empty", "", `{"code":1,"data":null,"msg":"请求参数不能为空"}`},
		{"invalid JSON", "{", `{"code":1,"data":null,"msg":"请求参数格式错误"}`},
		{"missing model", "{}", `{"code":1,"data":null,"msg":"缺少模型名称"}`},
		{"oversized", `{"body":{"prompt":"` + strings.Repeat("x", 1<<20) + `"}}`, `{"code":1,"data":null,"msg":"请求参数格式错误"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/ai/direct-request", strings.NewReader(test.body))
			recorder := httptest.NewRecorder()
			PrepareDirectAIRequest(recorder, request)
			if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Type") != "application/json" {
				t.Fatalf("HTTP contract changed: status %d, headers %v", recorder.Code, recorder.Header())
			}
			assertProtocolJSONValue(t, protocolJSON(t, recorder.Body.String()), test.want)
		})
	}
}

func protocolJSON(t *testing.T, text string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		t.Fatalf("invalid fixture JSON: %v", err)
	}
	return value
}

func assertProtocolJSONValue(t *testing.T, got any, want string) {
	t.Helper()
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(protocolJSON(t, string(encoded)), protocolJSON(t, want)) {
		t.Fatalf("got %s; want %s", encoded, want)
	}
}

func blockProtocolNetwork(t *testing.T) {
	t.Helper()
	protocolMockHTTP(t, func(request *http.Request) (*http.Response, error) {
		t.Errorf("unexpected upstream request: %s %s", request.Method, request.URL)
		return nil, errors.New("contract test forbids upstream network I/O")
	})
}

func assertProtocolBytes(t *testing.T, got, want []byte) {
	t.Helper()
	if json.Valid(got) && json.Valid(want) {
		assertProtocolJSONValue(t, protocolJSON(t, string(got)), string(want))
	} else if !bytes.Equal(got, want) {
		t.Fatalf("raw payload changed: got %q, want %q", got, want)
	}
}

type protocolTransport func(*http.Request) (*http.Response, error)

func (transport protocolTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func protocolMockHTTP(t *testing.T, transport protocolTransport) {
	t.Helper()
	previous := http.DefaultTransport
	http.DefaultTransport = transport
	t.Cleanup(func() { http.DefaultTransport = previous })
}

type protocolResponseBody struct {
	io.Reader
	closed *int
}

func (body *protocolResponseBody) Close() error {
	*body.closed++
	return nil
}
