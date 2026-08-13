package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func comfyTestChannel(baseURL string) model.ModelChannel {
	return model.ModelChannel{
		ID:       "test-comfyui",
		Protocol: "comfyui",
		Name:     "本地 ComfyUI",
		BaseURL:  baseURL,
		APIKey:   "unused",
		Models:   []string{"Qwen-Image-Edit-Rapid-AIO/Qwen-Rapid-AIO-NSFW-v19.safetensors"},
		Timeout:  30,
		Enabled:  true,
	}
}

func decodeComfyGraph(t *testing.T, encoded []byte) map[string]any {
	t.Helper()
	var submitted struct {
		Prompt map[string]any `json:"prompt"`
	}
	if err := json.Unmarshal(encoded, &submitted); err != nil {
		t.Fatalf("invalid prompt json: %v", err)
	}
	return submitted.Prompt
}

func comfyNodeInputs(t *testing.T, graph map[string]any, nodeID string) map[string]any {
	t.Helper()
	node, ok := graph[nodeID].(map[string]any)
	if !ok {
		t.Fatalf("node %s missing", nodeID)
	}
	inputs, ok := node["inputs"].(map[string]any)
	if !ok {
		t.Fatalf("node %s inputs missing", nodeID)
	}
	return inputs
}

func TestNormalizeComfyUIImageBody(t *testing.T) {
	channel := comfyTestChannel("http://comfy.local:8188")
	body := []byte(`{"model":"Qwen-Image-Edit-Rapid-AIO/Qwen-Rapid-AIO-NSFW-v19.safetensors","prompt":"a cat","n":2,"size":"1024x768"}`)
	encoded, contentType, err := normalizeComfyUIImageBody(body, "application/json", "", channel)
	if err != nil {
		t.Fatalf("normalize failed: %v", err)
	}
	if contentType != "application/json" {
		t.Fatalf("contentType = %q, want application/json", contentType)
	}

	graph := decodeComfyGraph(t, encoded)
	if len(graph) == 0 {
		t.Fatal("empty graph")
	}

	checkpoint := comfyNodeInputs(t, graph, "4")
	if checkpoint["ckpt_name"] != "Qwen-Image-Edit-Rapid-AIO/Qwen-Rapid-AIO-NSFW-v19.safetensors" {
		t.Fatalf("ckpt_name = %v", checkpoint["ckpt_name"])
	}

	latent := comfyNodeInputs(t, graph, "5")
	if latent["width"] != float64(1024) || latent["height"] != float64(768) || latent["batch_size"] != float64(2) {
		t.Fatalf("latent inputs = %v", latent)
	}

	// 数字占位符必须是 JSON 数值而非字符串
	ksampler := comfyNodeInputs(t, graph, "3")
	if _, ok := ksampler["steps"].(float64); !ok {
		t.Fatalf("steps 不是数值类型: %T", ksampler["steps"])
	}
	if _, ok := ksampler["seed"].(float64); !ok {
		t.Fatalf("seed 不是数值类型: %T", ksampler["seed"])
	}
	if ksampler["denoise"] != float64(1) {
		t.Fatalf("txt2img denoise = %v, want 1", ksampler["denoise"])
	}

	positive := comfyNodeInputs(t, graph, "6")
	if positive["text"] != "a cat" {
		t.Fatalf("positive text = %v", positive["text"])
	}
	negative := comfyNodeInputs(t, graph, "7")
	if negative["text"] != "" {
		t.Fatalf("negative text = %v", negative["text"])
	}
}

func TestNormalizeComfyUIImageBodyDefaultSize(t *testing.T) {
	channel := comfyTestChannel("http://comfy.local:8188")
	body := []byte(`{"model":"m","prompt":"hi"}`)
	encoded, _, err := normalizeComfyUIImageBody(body, "application/json", "m", channel)
	if err != nil {
		t.Fatalf("normalize failed: %v", err)
	}
	latent := comfyNodeInputs(t, decodeComfyGraph(t, encoded), "5")
	if latent["width"] != float64(1024) || latent["height"] != float64(1024) {
		t.Fatalf("default size = %v", latent)
	}
}

func TestNormalizeComfyUIImageEditBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/upload/image" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"name":"ref.png","subfolder":"","type":"input"}`))
	}))
	defer server.Close()

	channel := comfyTestChannel(server.URL)

	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	_ = writer.WriteField("model", "Qwen-Image-Edit-Rapid-AIO/Qwen-Rapid-AIO-NSFW-v19.safetensors")
	_ = writer.WriteField("prompt", "make it red")
	part, err := writer.CreateFormFile("image", "source.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("fake-png-bytes"))
	_ = writer.Close()

	encoded, contentType, err := normalizeComfyUIImageEditBody(buffer.Bytes(), writer.FormDataContentType(), "", channel)
	if err != nil {
		t.Fatalf("normalize edit failed: %v", err)
	}
	if contentType != "application/json" {
		t.Fatalf("contentType = %q", contentType)
	}

	graph := decodeComfyGraph(t, encoded)
	loadImage := comfyNodeInputs(t, graph, "1")
	if loadImage["image"] != "ref.png" {
		t.Fatalf("load image = %v, want ref.png", loadImage["image"])
	}

	ksampler := comfyNodeInputs(t, graph, "3")
	if ksampler["denoise"] != float64(0.85) {
		t.Fatalf("img2img denoise = %v, want 0.85", ksampler["denoise"])
	}
	positive := comfyNodeInputs(t, graph, "6")
	if positive["text"] != "make it red" {
		t.Fatalf("positive text = %v", positive["text"])
	}
}

func TestCopyComfyUIResponse(t *testing.T) {
	comfy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/prompt":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"prompt_id":"abc-123","number":1}`))
		case r.URL.Path == "/history/abc-123":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"abc-123":{"status":{"status_str":"success","completed":true},"outputs":{"9":{"images":[{"filename":"out.png","subfolder":"","type":"output"}]}}}}`))
		case r.URL.Path == "/view":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("PNGDATA"))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	defer comfy.Close()

	channel := comfyTestChannel(comfy.URL)
	promptResponse := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"application/json"}},
		Body:       io.NopCloser(strings.NewReader(`{"prompt_id":"abc-123","number":1}`)),
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "http://example.com/api/v1/images/generations", nil)
	handled := copyComfyUIResponse(recorder, promptResponse, request, channel, aiLogContext{Model: "x"}, nil)
	if !handled {
		t.Fatal("expected handled=true")
	}
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var converted struct {
		Data []struct {
			URL string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &converted); err != nil {
		t.Fatalf("invalid response json: %v", err)
	}
	if len(converted.Data) != 1 {
		t.Fatalf("data len = %d, body = %s", len(converted.Data), recorder.Body.String())
	}
	if !strings.HasPrefix(converted.Data[0].URL, "data:image/png;base64,") {
		t.Fatalf("url = %s", converted.Data[0].URL)
	}
}

func TestCopyComfyUIResponseSubmitError(t *testing.T) {
	comfy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"type":"invalid_prompt","message":"bad workflow"}}`))
	}))
	defer comfy.Close()

	channel := comfyTestChannel(comfy.URL)
	promptResponse := &http.Response{
		StatusCode: http.StatusBadRequest,
		Header:     http.Header{"Content-Type": {"application/json"}},
		Body:       io.NopCloser(strings.NewReader(`{"error":{"message":"bad workflow"}}`)),
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "http://example.com/api/v1/images/generations", nil)
	handled := copyComfyUIResponse(recorder, promptResponse, request, channel, aiLogContext{Model: "x"}, nil)
	if !handled {
		t.Fatal("expected handled=true")
	}
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	var failure struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &failure); err != nil {
		t.Fatalf("invalid error json: %v", err)
	}
	if failure.Code != 500 {
		t.Fatalf("code = %d, want 500", failure.Code)
	}
	if !strings.Contains(failure.Msg, "bad workflow") {
		t.Fatalf("msg = %q", failure.Msg)
	}
}

func TestIsComfyUIChannelByProtocolAndBaseURL(t *testing.T) {
	byProtocol := comfyTestChannel("http://anywhere:8188")
	if !isComfyUIChannel(byProtocol) {
		t.Fatal("protocol comfyui should be detected")
	}
	byBaseURL := model.ModelChannel{Protocol: "openai", BaseURL: "http://my-comfyui-host:8188"}
	if !isComfyUIChannel(byBaseURL) {
		t.Fatal("baseURL containing comfyui should be detected")
	}
	openai := model.ModelChannel{Protocol: "openai", BaseURL: "http://openai.example.com"}
	if isComfyUIChannel(openai) {
		t.Fatal("openai channel should not be comfyui")
	}
}

func TestParseComfyUISize(t *testing.T) {
	tests := []struct {
		input      string
		wantWidth  int
		wantHeight int
	}{
		{input: "1024x768", wantWidth: 1024, wantHeight: 768},
		{input: " 512x512 ", wantWidth: 512, wantHeight: 512},
		{input: "", wantWidth: 1024, wantHeight: 1024},
		{input: "abc", wantWidth: 1024, wantHeight: 1024},
		{input: "1:1", wantWidth: 1024, wantHeight: 1024},
		// 宽高比：基准边长 1024，对齐 8 的倍数
		{input: "16:9", wantWidth: 1024, wantHeight: 576},
		{input: "9:16", wantWidth: 576, wantHeight: 1024},
		{input: "3:2", wantWidth: 1024, wantHeight: 680},
		{input: "21:9", wantWidth: 1024, wantHeight: 432},
		{input: "19:9", wantWidth: 1024, wantHeight: 480},
		// 像素尺寸对齐 8 的倍数
		{input: "1000x1000", wantWidth: 1000, wantHeight: 1000},
	}
	for _, tt := range tests {
		width, height := parseComfyUISize(tt.input)
		if width != tt.wantWidth || height != tt.wantHeight {
			t.Fatalf("parseComfyUISize(%q) = %dx%d, want %dx%d", tt.input, width, height, tt.wantWidth, tt.wantHeight)
		}
	}
}

func TestRenderComfyUIWorkflowCustomTemplate(t *testing.T) {
	channel := comfyTestChannel("http://comfy.local:8188")
	channel.Txt2ImgWorkflow = `{"1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"{{ckpt_name}}"}},"2":{"class_type":"EmptyLatentImage","inputs":{"width":"{{width}}","height":"{{height}}","batch_size":1}}}`
	body := []byte(`{"model":"m","prompt":"p","size":"512x384"}`)
	encoded, _, err := normalizeComfyUIImageBody(body, "application/json", "m", channel)
	if err != nil {
		t.Fatalf("normalize failed: %v", err)
	}
	graph := decodeComfyGraph(t, encoded)
	latent := comfyNodeInputs(t, graph, "2")
	if latent["width"] != float64(512) || latent["height"] != float64(384) {
		t.Fatalf("custom template latent = %v", latent)
	}
	if _, ok := graph["3"]; ok {
		t.Fatal("custom template should not contain default nodes")
	}
}

// TestComfyUIInlinePlaceholders 验证自定义节点字符串参数（如 "{{width}}x{{height}}"）可注入画布尺寸。
func TestComfyUIInlinePlaceholders(t *testing.T) {
	vars := map[string]any{
		"width":  float64(1024),
		"height": float64(576),
		"steps":  float64(20),
		"cfg":    4.5,
		"ckpt":   "model.safetensors",
	}
	tests := []struct {
		input string
		want  string
	}{
		{input: "{{width}}x{{height}}", want: "1024x576"},
		{input: "1024x{{height}}", want: "1024x576"},
		{input: "{{steps}} steps cfg {{cfg}}", want: "20 steps cfg 4.5"},
		{input: "{{ckpt}}/v1", want: "model.safetensors/v1"},
		{input: "{{undefined}}x", want: "{{undefined}}x"},
		{input: "plain text", want: "plain text"},
		{input: "{{width}}", want: "1024"}, // inline 函数总是返回字符串
	}
	for _, tt := range tests {
		got := replaceComfyUIInlinePlaceholders(tt.input, vars)
		if got != tt.want {
			t.Fatalf("replaceComfyUIInlinePlaceholders(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

// TestComfyUIInlinePlaceholderInWorkflow 验证组合尺寸占位符能渲染进自定义模板节点。
func TestComfyUIInlinePlaceholderInWorkflow(t *testing.T) {
	channel := comfyTestChannel("http://comfy.local:8188")
	// 自定义节点用字符串 size 参数（社区节点常见写法）
	channel.Txt2ImgWorkflow = `{"1":{"class_type":"CustomResolutionNode","inputs":{"size":"{{width}}x{{height}}","model":"{{ckpt_name}}"}},"2":{"class_type":"EmptyLatentImage","inputs":{"width":"{{width}}","height":"{{height}}","batch_size":1}}}`
	body := []byte(`{"model":"m","prompt":"p","size":"16:9"}`)
	encoded, _, err := normalizeComfyUIImageBody(body, "application/json", "m", channel)
	if err != nil {
		t.Fatalf("normalize failed: %v", err)
	}
	graph := decodeComfyGraph(t, encoded)
	custom := comfyNodeInputs(t, graph, "1")
	if custom["size"] != "1024x576" {
		t.Fatalf("inline size = %v, want 1024x576", custom["size"])
	}
	if custom["model"] != "m" {
		t.Fatalf("inline model = %v, want m", custom["model"])
	}
}
