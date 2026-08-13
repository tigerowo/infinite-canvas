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

// comfyTestTxt2ImgTemplate 测试用通用文生图模板（结构等价于原内置默认模板）。
const comfyTestTxt2ImgTemplate = `{
  "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "{{ckpt_name}}"}},
  "5": {"class_type": "EmptyLatentImage", "inputs": {"width": "{{width}}", "height": "{{height}}", "batch_size": "{{batch_size}}"}},
  "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{prompt}}", "clip": ["4", 1]}},
  "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{negative_prompt}}", "clip": ["4", 1]}},
  "3": {"class_type": "KSampler", "inputs": {"seed": "{{seed}}", "steps": "{{steps}}", "cfg": "{{cfg}}", "sampler_name": "{{sampler_name}}", "scheduler": "{{scheduler}}", "denoise": "{{denoise}}", "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}},
  "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
  "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "{{filename_prefix}}", "images": ["8", 0]}}
}`

// comfyTestImg2ImgTemplate 测试用通用图生图模板。
const comfyTestImg2ImgTemplate = `{
  "1": {"class_type": "LoadImage", "inputs": {"image": "{{image_name}}"}},
  "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "{{ckpt_name}}"}},
  "2": {"class_type": "VAEEncode", "inputs": {"pixels": ["1", 0], "vae": ["4", 2]}},
  "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{prompt}}", "clip": ["4", 1]}},
  "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{negative_prompt}}", "clip": ["4", 1]}},
  "3": {"class_type": "KSampler", "inputs": {"seed": "{{seed}}", "steps": "{{steps}}", "cfg": "{{cfg}}", "sampler_name": "{{sampler_name}}", "scheduler": "{{scheduler}}", "denoise": "{{denoise}}", "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["2", 0]}},
  "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
  "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "{{filename_prefix}}", "images": ["8", 0]}}
}`

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
	channel.Txt2ImgWorkflow = comfyTestTxt2ImgTemplate
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
	channel.Txt2ImgWorkflow = comfyTestTxt2ImgTemplate
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
	channel.Img2ImgWorkflow = comfyTestImg2ImgTemplate

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

// TestReadComfyUIPromptErrorPreferNodeErrors 验证 node_errors 的具体校验错误优先于通用 message。
func TestReadComfyUIPromptErrorPreferNodeErrors(t *testing.T) {
	msg := readComfyUIPromptError(
		map[string]any{"type": "prompt_outputs_failed_validation", "message": "Prompt outputs failed validation"},
		map[string]any{
			"4": map[string]any{
				"errors": []any{
					map[string]any{"type": "value_not_in_list", "message": "Value not in list", "details": "ckpt_name: 'boogu.safetensors' not in ['qwen.safetensors']"},
				},
			},
		},
	)
	if !strings.Contains(msg, "boogu.safetensors") || strings.Contains(msg, "Prompt outputs failed validation") {
		t.Fatalf("msg = %q, want 具体 node_errors 详情", msg)
	}
	// 无 node_errors 时回退 error 字段
	fallback := readComfyUIPromptError(map[string]any{"message": "bad workflow"}, nil)
	if fallback != "bad workflow" {
		t.Fatalf("fallback msg = %q", fallback)
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

// TestAutoWireComfyUITemplate 验证普通用户粘贴无占位符模板时，自动接入画布参数。
func TestAutoWireComfyUITemplate(t *testing.T) {
	// 模拟 Boogu 风格导出模板：UNETLoader + ResolutionSelector + 正负 CLIPTextEncode + KSampler
	template := `{
  "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "boogu_image_turbo_fp8_scaled.safetensors"}},
  "4": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_8b_fp8_scaled.safetensors", "type": "boogu"}},
  "5": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
  "9": {"class_type": "ResolutionSelector", "inputs": {"aspect_ratio": "9:16 (Portrait Widescreen)", "megapixels": 1, "multiple": 8}},
  "8": {"class_type": "EmptyLatentImage", "inputs": {"width": ["9", 0], "height": ["9", 1], "batch_size": 1}},
  "11": {"class_type": "CLIPTextEncode", "inputs": {"text": "写死的提示词", "clip": ["4", 0]}},
  "12": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["4", 0]}},
  "32": {"class_type": "KSampler", "inputs": {"seed": 123, "steps": 4, "cfg": 1, "sampler_name": "lcm", "scheduler": "sgm_uniform", "denoise": 1, "model": ["2", 0], "positive": ["11", 0], "negative": ["12", 0], "latent_image": ["8", 0]}}
}`

	channel := comfyTestChannel("http://comfy.local:8188")
	channel.Txt2ImgWorkflow = template
	body := []byte(`{"model":"boogu","prompt":"a red apple on wooden table","size":"9:16","n":1}`)
	encoded, _, err := normalizeComfyUIImageBody(body, "application/json", "boogu", channel)
	if err != nil {
		t.Fatalf("normalize failed: %v", err)
	}
	graph := decodeComfyGraph(t, encoded)

	// KSampler：seed 被随机替换（数字），steps/cfg/sampler 保留用户配置
	ksampler := comfyNodeInputs(t, graph, "32")
	if _, ok := ksampler["seed"].(float64); !ok {
		t.Fatalf("seed 未自动接入: %T", ksampler["seed"])
	}
	if ksampler["steps"] != float64(4) || ksampler["cfg"] != float64(1) || ksampler["sampler_name"] != "lcm" {
		t.Fatalf("采样参数应保留: %v", ksampler)
	}

	// 正向 CLIPTextEncode（11）：text 接入画布 prompt
	positive := comfyNodeInputs(t, graph, "11")
	if positive["text"] != "a red apple on wooden table" {
		t.Fatalf("正向 text = %v, want 画布 prompt", positive["text"])
	}
	// 负向 CLIPTextEncode（12）：保持原样
	negative := comfyNodeInputs(t, graph, "12")
	if negative["text"] != "" {
		t.Fatalf("负向 text = %v, want 原样空串", negative["text"])
	}

	// EmptyLatentImage：宽高从 ResolutionSelector 引用改为画布尺寸
	latent := comfyNodeInputs(t, graph, "8")
	if latent["width"] != float64(576) || latent["height"] != float64(1024) {
		t.Fatalf("latent = %v, want 576x1024（9:16）", latent)
	}
	if latent["batch_size"] != float64(1) {
		t.Fatalf("batch_size = %v, want 1", latent["batch_size"])
	}

	// 模型加载节点保持用户配置
	unet := comfyNodeInputs(t, graph, "2")
	if unet["unet_name"] != "boogu_image_turbo_fp8_scaled.safetensors" {
		t.Fatalf("unet_name 应保留: %v", unet["unet_name"])
	}
}

// TestAutoWireComfyUIKeepsPlaceholderTemplate 验证含占位符的模板不做自动接入（高级用户手动控制）。
func TestAutoWireComfyUIKeepsPlaceholderTemplate(t *testing.T) {
	template := `{"4":{"class_type":"KSampler","inputs":{"seed": 777, "steps": 20, "cfg": 4, "sampler_name": "euler", "scheduler": "normal", "denoise": 1, "model": ["2", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}},"6":{"class_type":"CLIPTextEncode","inputs":{"text":"fixed","clip":["4",1]}},"7":{"class_type":"CLIPTextEncode","inputs":{"text":"","clip":["4",1]}},"5":{"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512,"batch_size":1}},"2":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"{{ckpt_name}}"}}}`
	channel := comfyTestChannel("http://comfy.local:8188")
	channel.Txt2ImgWorkflow = template
	body := []byte(`{"model":"m","prompt":"p","size":"16:9"}`)
	encoded, _, err := normalizeComfyUIImageBody(body, "application/json", "m", channel)
	if err != nil {
		t.Fatalf("normalize failed: %v", err)
	}
	graph := decodeComfyGraph(t, encoded)
	ksampler := comfyNodeInputs(t, graph, "4")
	// 含占位符模板：seed 保持模板值 777（不自动接入）
	if ksampler["seed"] != float64(777) {
		t.Fatalf("seed = %v, want 保留 777", ksampler["seed"])
	}
	positive := comfyNodeInputs(t, graph, "6")
	if positive["text"] != "fixed" {
		t.Fatalf("text = %v, want 保留 fixed", positive["text"])
	}
}

// TestComfyUIEmptyTemplateReturnsError 验证渠道未配置模板时报友好错误（无内置默认模板）。
func TestComfyUIEmptyTemplateReturnsError(t *testing.T) {
	channel := comfyTestChannel("http://comfy.local:8188")
	body := []byte(`{"model":"m","prompt":"p"}`)
	_, _, err := normalizeComfyUIImageBody(body, "application/json", "m", channel)
	if err == nil {
		t.Fatal("expected error for missing txt2img template")
	}
	if !strings.Contains(err.Error(), "文生图工作流模板") {
		t.Fatalf("err = %v, want 模板缺失提示", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"name":"ref.png"}`))
	}))
	defer server.Close()
	channel2 := comfyTestChannel(server.URL)
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	_ = writer.WriteField("model", "m")
	_ = writer.WriteField("prompt", "p")
	part, _ := writer.CreateFormFile("image", "s.png")
	_, _ = part.Write([]byte("x"))
	_ = writer.Close()
	_, _, err = normalizeComfyUIImageEditBody(buffer.Bytes(), writer.FormDataContentType(), "m", channel2)
	if err == nil {
		t.Fatal("expected error for missing img2img template")
	}
	if !strings.Contains(err.Error(), "图生图工作流模板") {
		t.Fatalf("err = %v, want 图生图模板缺失提示", err)
	}
}

// TestAutoWireComfyUICustomEditNodes 验证 SamplerCustom + TextEncodeBooguEdit 等
// 自定义节点也能自动接入提示词/种子（Boogu Edit 图生图模板场景）。
func TestAutoWireComfyUICustomEditNodes(t *testing.T) {
	template := `{
  "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "boogu_image_edit_fp8_scaled.safetensors"}},
  "5": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
  "7": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_8b_fp8_scaled.safetensors", "type": "boogu"}},
  "32": {"class_type": "LoadImage", "inputs": {"image": "tech_cowboy.png"}},
  "8": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
  "36": {"class_type": "TextEncodeBooguEdit", "inputs": {"prompt": "remove the hat", "negative_prompt": "", "clip": ["7", 0], "vae": ["5", 0], "images.image_1": ["32", 0]}},
  "21": {"class_type": "SamplerCustom", "inputs": {"add_noise": true, "noise_seed": 22, "cfg": 3.5, "model": ["2", 0], "positive": ["36", 0], "negative": ["36", 1], "latent_image": ["8", 0]}}
}`

	channel := comfyTestChannel("http://comfy.local:8188")
	channel.Img2ImgWorkflow = template
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"name":"ref.png","subfolder":"","type":"input"}`))
	}))
	defer server.Close()
	channel.BaseURL = server.URL

	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	_ = writer.WriteField("model", "boogu-edit")
	_ = writer.WriteField("prompt", "make him wear sunglasses")
	part, _ := writer.CreateFormFile("image", "source.png")
	_, _ = part.Write([]byte("fake"))
	_ = writer.Close()

	encoded, _, err := normalizeComfyUIImageEditBody(buffer.Bytes(), writer.FormDataContentType(), "boogu-edit", channel)
	if err != nil {
		t.Fatalf("normalize edit failed: %v", err)
	}
	graph := decodeComfyGraph(t, encoded)

	// TextEncodeBooguEdit 的 prompt 字段接入画布提示词
	encode := comfyNodeInputs(t, graph, "36")
	if encode["prompt"] != "make him wear sunglasses" {
		t.Fatalf("TextEncodeBooguEdit prompt = %v, want 画布提示词", encode["prompt"])
	}
	// LoadImage 接入上传的参考图
	loadImage := comfyNodeInputs(t, graph, "32")
	if loadImage["image"] != "ref.png" {
		t.Fatalf("LoadImage image = %v, want ref.png", loadImage["image"])
	}
	// SamplerCustom 的 noise_seed 被随机替换
	sampler := comfyNodeInputs(t, graph, "21")
	if _, ok := sampler["noise_seed"].(float64); !ok {
		t.Fatalf("noise_seed 未接入: %T", sampler["noise_seed"])
	}
	// 采样参数保留
	if sampler["cfg"] != float64(3.5) {
		t.Fatalf("cfg = %v, want 保留 3.5", sampler["cfg"])
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
