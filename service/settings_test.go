package service

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestFetchAdminChannelModelsParsesOpenAIModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"z-model"},{"id":"a-model"},{"id":""}]}`))
	}))
	defer server.Close()

	models, err := fetchAdminChannelModels(model.ModelChannel{
		BaseURL: server.URL,
		APIKey:  "test-key",
	})
	if err != nil {
		t.Fatalf("fetchAdminChannelModels returned error: %v", err)
	}
	if want := []string{"a-model", "z-model"}; !reflect.DeepEqual(models, want) {
		t.Fatalf("models = %#v, want %#v", models, want)
	}
}

func TestFetchAdminChannelModelsReportsArkPlanModelsUnsupported(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/plan/v3/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	_, err := fetchAdminChannelModels(model.ModelChannel{
		BaseURL: server.URL + "/api/plan/v3/contents/generations/tasks",
		APIKey:  "test-key",
	})
	if err == nil {
		t.Fatal("expected unsupported /models error")
	}
	if !strings.Contains(err.Error(), "Agent Plan 未提供 OpenAI /models") {
		t.Fatalf("error = %q", err.Error())
	}
}

func TestBuildModelChannelURLNormalizesArkPlanTaskPath(t *testing.T) {
	got := BuildModelChannelURL(model.ModelChannel{BaseURL: "https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks?debug=1"}, "/models")
	want := "https://ark.cn-beijing.volces.com/api/plan/v3/models"
	if got != want {
		t.Fatalf("BuildModelChannelURL = %q, want %q", got, want)
	}
}

func TestFetchComfyUICheckpoints(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "" {
			t.Fatalf("ComfyUI request should not carry Authorization, got %q", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/object_info/CheckpointLoaderSimple":
			_, _ = w.Write([]byte(`{"CheckpointLoaderSimple":{"input":{"required":{"ckpt_name":[["qwen.safetensors","sd15.safetensors"],{}]}}}}`))
		case r.URL.Path == "/object_info/UNETLoader":
			_, _ = w.Write([]byte(`{"UNETLoader":{"input":{"required":{"unet_name":[["boogu_image_turbo_fp8_scaled.safetensors"],{}]}}}}`))
		case r.URL.Path == "/object_info/CLIPLoader":
			_, _ = w.Write([]byte(`{"CLIPLoader":{"input":{"required":{"clip_name":[["qwen3vl_8b_fp8_scaled.safetensors"],{}]}}}}`))
		case r.URL.Path == "/object_info/VAELoader":
			_, _ = w.Write([]byte(`{"VAELoader":{"input":{"required":{"vae_name":[["ae.safetensors"],{}]}}}}`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	models, err := fetchComfyUICheckpoints(model.ModelChannel{
		Protocol: "comfyui",
		BaseURL:  server.URL,
	})
	if err != nil {
		t.Fatalf("fetch failed: %v", err)
	}
	want := []string{"ae.safetensors", "boogu_image_turbo_fp8_scaled.safetensors", "qwen.safetensors", "qwen3vl_8b_fp8_scaled.safetensors", "sd15.safetensors"}
	if len(models) != len(want) {
		t.Fatalf("models = %v, want %v", models, want)
	}
	for i := range want {
		if models[i] != want[i] {
			t.Fatalf("models = %v, want %v", models, want)
		}
	}
}

func TestModelChannelsForModelAllowsEmptyAPIKeyForComfyUI(t *testing.T) {
	channels := []model.ModelChannel{
		{ID: "openai-no-key", Protocol: "openai", BaseURL: "http://x", APIKey: "", Models: []string{"m1"}, Enabled: true},
		{ID: "comfy-no-key", Protocol: "comfyui", BaseURL: "http://comfy:8188", APIKey: "", Models: []string{"m1"}, Enabled: true},
		{ID: "comfy-with-key", Protocol: "comfyui", BaseURL: "http://comfy:8188", APIKey: "k", Models: []string{"m1"}, Enabled: true},
	}
	result := modelChannelsForModel(channels, "m1")
	if len(result) != 2 {
		t.Fatalf("len = %d, want 2（openai 无 key 应被跳过，两个 comfyui 渠道可选）", len(result))
	}
	for _, channel := range result {
		if channel.ID == "openai-no-key" {
			t.Fatal("openai 渠道无 APIKey 不应被选中")
		}
	}
}
