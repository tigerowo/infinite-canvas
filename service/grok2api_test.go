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
	if !containsAllStrings(models, append(grok2APIChatModels(), grok2APIModels()...)) {
		t.Fatalf("models missing built-in grok chat/media catalog: %#v", models)
	}
	if len(models) < len(grok2APIModels())+len(grok2APIChatModels()) {
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
	if !containsAllStrings(models, append(grok2APIChatModels(), grok2APIModels()...)) {
		t.Fatalf("models missing built-in grok chat/media catalog: %#v", models)
	}
	if !containsAllStrings(models, []string{"grok-4", "grok-3-mini", "grok-imagine-video-1.5"}) {
		t.Fatalf("xai fallback missing expected chat/media models: %#v", models)
	}
}

func TestMergeGrok2APIChannelModelsKeepsUpstreamChatModels(t *testing.T) {
	merged := uniqueModelNames(append(append([]string{"custom-chat-model", "grok-imagine-video"}, grok2APIChatModels()...), grok2APIModels()...))
	if !containsAllStrings(merged, []string{"grok-4", "grok-3-mini", "grok-imagine-video-1.5", "grok-voice-latest"}) {
		t.Fatalf("merged models = %#v", merged)
	}
	if !containsAllStrings(merged, []string{"custom-chat-model"}) {
		t.Fatalf("merged models lost upstream custom model: %#v", merged)
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
