package service

import (
	"bytes"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"math"

	_ "golang.org/x/image/webp"
)

// CreateGeneratedImageThumbnail creates a compact preview for canvas cards.
// The full-resolution local file remains available for the fullscreen viewer.
func CreateGeneratedImageThumbnail(data []byte, maxDimension int) ([]byte, int, int, error) {
	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, 0, 0, err
	}
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= 0 || height <= 0 {
		return nil, 0, 0, image.ErrFormat
	}
	if maxDimension <= 0 {
		maxDimension = 640
	}
	scale := math.Min(1, float64(maxDimension)/float64(max(width, height)))
	targetWidth := max(1, int(math.Round(float64(width)*scale)))
	targetHeight := max(1, int(math.Round(float64(height)*scale)))
	target := image.NewRGBA(image.Rect(0, 0, targetWidth, targetHeight))
	for y := 0; y < targetHeight; y++ {
		sourceY := bounds.Min.Y + min(height-1, int(float64(y)*float64(height)/float64(targetHeight)))
		for x := 0; x < targetWidth; x++ {
			sourceX := bounds.Min.X + min(width-1, int(float64(x)*float64(width)/float64(targetWidth)))
			rgba := color.RGBAModel.Convert(source.At(sourceX, sourceY)).(color.RGBA)
			if rgba.A < 255 {
				alpha := uint32(rgba.A)
				rgba.R = uint8((uint32(rgba.R)*alpha + 255*(255-alpha)) / 255)
				rgba.G = uint8((uint32(rgba.G)*alpha + 255*(255-alpha)) / 255)
				rgba.B = uint8((uint32(rgba.B)*alpha + 255*(255-alpha)) / 255)
				rgba.A = 255
			}
			target.SetRGBA(x, y, rgba)
		}
	}
	var output bytes.Buffer
	if err := jpeg.Encode(&output, target, &jpeg.Options{Quality: 82}); err != nil {
		return nil, 0, 0, err
	}
	return output.Bytes(), width, height, nil
}
