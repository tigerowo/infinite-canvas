package handler

import (
	"encoding/json"
	"testing"
)

func TestImageURLsFromChatMarkdownDataURL(t *testing.T) {
	dataURL := "data:image/png;base64,iVBORw0KGgo="
	payload, err := json.Marshal(map[string]any{
		"choices": []any{map[string]any{
			"message": map[string]any{"content": "![generated image](" + dataURL + ")"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}

	urls, mimeType, bytes, err := imageURLsFromAIResponse(payload, "application/json", false, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(urls) != 1 || urls[0] != dataURL {
		t.Fatalf("未解析 Markdown Data URL：%v", urls)
	}
	if mimeType != "image/png" || bytes != 8 {
		t.Fatalf("图片元数据异常：mime=%s bytes=%d", mimeType, bytes)
	}
}
