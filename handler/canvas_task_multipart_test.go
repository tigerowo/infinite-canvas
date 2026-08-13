package handler

import (
	"bytes"
	"io"
	"mime"
	"mime/multipart"
	"net/textproto"
	"testing"
)

func TestStripCanvasTaskMultipartFieldsPreservesDetectedJPEGType(t *testing.T) {
	jpegData := []byte{0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0x00, 0x01, 0xff, 0xd9}
	var input bytes.Buffer
	writer := multipart.NewWriter(&input)
	if err := writer.WriteField("_canvas_endpoint", "/images/edits"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("stream", "true"); err != nil {
		t.Fatal(err)
	}
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", `form-data; name="image"; filename="reference.png"`)
	header.Set("Content-Type", "application/octet-stream")
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(jpegData); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	cleaned, contentType, meta, err := stripCanvasTaskMultipartFields(input.Bytes(), writer.FormDataContentType())
	if err != nil {
		t.Fatal(err)
	}
	if meta["_canvas_endpoint"] != "/images/edits" {
		t.Fatalf("unexpected metadata: %#v", meta)
	}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		t.Fatal(err)
	}
	form, err := multipart.NewReader(bytes.NewReader(cleaned), params["boundary"]).ReadForm(1 << 20)
	if err != nil {
		t.Fatal(err)
	}
	defer form.RemoveAll()
	if _, ok := form.Value["stream"]; ok {
		t.Fatal("stream field must be removed for an asynchronous canvas task")
	}
	files := form.File["image"]
	if len(files) != 1 {
		t.Fatalf("expected one image, got %d", len(files))
	}
	if files[0].Filename != "reference.jpg" {
		t.Fatalf("expected normalized JPEG filename, got %q", files[0].Filename)
	}
	if got := files[0].Header.Get("Content-Type"); got != "image/jpeg" {
		t.Fatalf("expected image/jpeg, got %q", got)
	}
	file, err := files[0].Open()
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	actual, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, jpegData) {
		t.Fatal("multipart image bytes changed")
	}
}

func TestNormalizeCanvasAsyncImageRequestDisablesStreaming(t *testing.T) {
	body, contentType := normalizeCanvasAsyncImageRequest([]byte(`{"model":"gpt-image-2","stream":true,"partial_images":3}`), "application/json")
	if contentType != "application/json" {
		t.Fatalf("unexpected content type %q", contentType)
	}
	if string(body) != `{"model":"gpt-image-2","stream":false}` {
		t.Fatalf("unexpected normalized body %s", body)
	}
}

func TestNormalizeCanvasAsyncImageRequestOmitsStreamingForAgnes(t *testing.T) {
	body, contentType := normalizeCanvasAsyncImageRequest([]byte(`{"model":"agnes-image-2.1-flash","stream":true,"partial_images":3}`), "application/json")
	if contentType != "application/json" {
		t.Fatalf("unexpected content type %q", contentType)
	}
	if string(body) != `{"extra_body":{"response_format":"url"},"model":"agnes-image-2.1-flash"}` {
		t.Fatalf("unexpected normalized body %s", body)
	}
}
