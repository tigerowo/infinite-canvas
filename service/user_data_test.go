package service

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestRemoteModelChannelsForModelUsesPublishedMetadataOnly(t *testing.T) {
	channels := remoteModelChannelsForModel([]model.ModelChannel{
		{ID: "disabled", BaseURL: "https://disabled.example", Models: []string{"image"}, Enabled: false},
		{ID: "text", BaseURL: "https://text.example", Models: []string{"gpt-5.5"}, Enabled: true},
		{ID: "image", BaseURL: "https://image.example", Models: []string{"gpt-image-2"}, Enabled: true},
	}, "gpt-image-2")
	if len(channels) != 1 || channels[0].ID != "image" {
		t.Fatalf("unexpected remote channels: %#v", channels)
	}
	if channels[0].APIKey != "" {
		t.Fatal("published remote metadata must not carry an admin API key")
	}
}

func TestWithUserRemoteChannelKeyRequiresKey(t *testing.T) {
	if _, err := withUserRemoteChannelKey(model.ModelChannel{ID: "image"}, " "); err == nil {
		t.Fatal("expected missing user key error")
	}
	channel, err := withUserRemoteChannelKey(model.ModelChannel{ID: "image"}, " user-key ")
	if err != nil || channel.APIKey != "user-key" {
		t.Fatalf("unexpected user channel: %#v, err=%v", channel, err)
	}
}
