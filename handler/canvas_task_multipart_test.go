package handler

import (
	"bytes"
	"io"
	"mime"
	"mime/multipart"
	"testing"
)

func TestStripCanvasTaskMultipartFieldsNormalizesImages(t *testing.T) {
	tests := []struct {
		name            string
		filename        string
		data            []byte
		normalizeImages bool
		wantFilename    string
		wantContentType string
	}{
		{name: "jpeg", filename: "reference.png", data: []byte{0xff, 0xd8, 0xff, 0xdb, 0x00}, normalizeImages: true, wantFilename: "reference.jpg", wantContentType: "image/jpeg"},
		{name: "png", filename: "reference.jpg", data: []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}, normalizeImages: true, wantFilename: "reference.png", wantContentType: "image/png"},
		{name: "webp", filename: "reference.jpeg", data: []byte("RIFF\x04\x00\x00\x00WEBPVP8 "), normalizeImages: true, wantFilename: "reference.webp", wantContentType: "image/webp"},
		{name: "unknown", filename: "reference.bin", data: []byte("unknown"), normalizeImages: true, wantFilename: "reference.bin", wantContentType: "application/octet-stream"},
		{name: "disabled", filename: "reference.bin", data: []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}, wantFilename: "reference.bin", wantContentType: "application/octet-stream"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			raw, contentType := canvasTaskMultipartBody(t, test.filename, test.data)
			body, cleanedContentType, meta, err := stripCanvasTaskMultipartFields(raw, contentType, test.normalizeImages)
			if err != nil {
				t.Fatal(err)
			}
			if meta["_canvas_prompt"] != "prompt" {
				t.Fatalf("meta prompt = %q", meta["_canvas_prompt"])
			}
			_, params, err := mime.ParseMediaType(cleanedContentType)
			if err != nil {
				t.Fatal(err)
			}
			form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(1 << 20)
			if err != nil {
				t.Fatal(err)
			}
			defer form.RemoveAll()
			if len(form.Value["model"]) != 1 || form.Value["model"][0] != "test-model" {
				t.Fatalf("model = %#v", form.Value["model"])
			}
			files := form.File["image"]
			if len(files) != 1 {
				t.Fatalf("files = %d", len(files))
			}
			if files[0].Filename != test.wantFilename {
				t.Fatalf("filename = %q, want %q", files[0].Filename, test.wantFilename)
			}
			if got := files[0].Header.Get("Content-Type"); got != test.wantContentType {
				t.Fatalf("content type = %q, want %q", got, test.wantContentType)
			}
			file, err := files[0].Open()
			if err != nil {
				t.Fatal(err)
			}
			got, err := io.ReadAll(file)
			_ = file.Close()
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, test.data) {
				t.Fatalf("data = %v, want %v", got, test.data)
			}
		})
	}
}

func canvasTaskMultipartBody(t *testing.T, filename string, data []byte) ([]byte, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("_canvas_prompt", "prompt"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("model", "test-model"); err != nil {
		t.Fatal(err)
	}
	part, err := writer.CreateFormFile("image", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return body.Bytes(), writer.FormDataContentType()
}
