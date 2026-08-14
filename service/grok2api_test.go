package service

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestFetchAdminChannelModelsGrok2API(t *testing.T) {
	models, err := fetchAdminChannelModels(model.ModelChannel{
		Protocol: "grok2api",
		BaseURL:  "https://grok2api.example.com",
		APIKey:   "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	// Unreachable base URL falls back to built-in media catalog.
	if !containsAllStrings(models, grok2APIModels()) {
		t.Fatalf("models missing built-in grok media catalog: %#v", models)
	}
	if len(models) < len(grok2APIModels()) {
		t.Fatalf("models length = %d", len(models))
	}
}

func TestFetchAdminChannelModelsXAIFallsBackToBuiltin(t *testing.T) {
	models, err := fetchAdminChannelModels(model.ModelChannel{
		Protocol: "xai",
		BaseURL:  "https://api.x.ai",
		APIKey:   "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !containsAllStrings(models, grok2APIModels()) {
		t.Fatalf("models missing built-in grok media catalog: %#v", models)
	}
}

func TestMergeGrok2APIChannelModelsKeepsUpstreamChatModels(t *testing.T) {
	merged := uniqueModelNames(append([]string{"grok-4", "grok-3-mini", "grok-imagine-video"}, grok2APIModels()...))
	if !containsAllStrings(merged, []string{"grok-4", "grok-3-mini", "grok-imagine-video-1.5", "grok-voice-latest"}) {
		t.Fatalf("merged models = %#v", merged)
	}
}

func containsAllStrings(items []string, required []string) bool {
	set := map[string]bool{}
	for _, item := range items {
		set[item] = true
	}
	for _, item := range required {
		if !set[item] {
			return false
		}
	}
	return true
}
