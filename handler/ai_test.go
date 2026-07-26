package handler

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestSelectAIRequestChannelRejectsUserLocalProxy(t *testing.T) {
	_, _, err := selectAIRequestChannel(model.AuthUser{ID: "u1", Role: model.UserRoleUser}, "gpt-image", "", "local-1")
	if err == nil {
		t.Fatal("expected local channel server proxy to be rejected")
	}
	if err.Error() != "本地渠道禁止服务端代发，请使用浏览器直连" {
		t.Fatalf("unexpected error: %v", err)
	}
}
