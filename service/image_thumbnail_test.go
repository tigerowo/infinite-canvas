package service

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestCreateGeneratedImageThumbnail(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 1200, 800))
	for y := 0; y < 800; y++ {
		for x := 0; x < 1200; x++ {
			source.SetRGBA(x, y, color.RGBA{R: uint8(x % 255), G: uint8(y % 255), B: 100, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}
	thumbnail, width, height, err := CreateGeneratedImageThumbnail(encoded.Bytes(), 640)
	if err != nil {
		t.Fatal(err)
	}
	if width != 1200 || height != 800 {
		t.Fatalf("unexpected original dimensions %dx%d", width, height)
	}
	decoded, _, err := image.DecodeConfig(bytes.NewReader(thumbnail))
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Width != 640 || decoded.Height != 427 {
		t.Fatalf("unexpected thumbnail dimensions %dx%d", decoded.Width, decoded.Height)
	}
}
