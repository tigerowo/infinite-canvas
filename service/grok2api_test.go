package service

import (
	"reflect"
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
	want := []string{
		"grok-imagine-image",
		"grok-imagine-image-2.0",
		"grok-imagine-image-edit",
		"grok-imagine-image-quality",
		"grok-imagine-video",
		"grok-imagine-video-1.5",
		"grok-voice-latest",
		"grok-voice-think-fast-2.0",
	}
	if !reflect.DeepEqual(models, want) {
		t.Fatalf("models = %#v, want %#v", models, want)
	}
}

func TestFetchAdminChannelModelsXAISkipsModelsRequest(t *testing.T) {
	models, err := fetchAdminChannelModels(model.ModelChannel{
		Protocol: "xai",
		BaseURL:  "https://api.x.ai",
		APIKey:   "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 8 {
		t.Fatalf("models length = %d", len(models))
	}
}
