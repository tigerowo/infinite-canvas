package mediaarchive

import (
	"bytes"
	"io"
	"net/http"
	"testing"
)

func TestAudioBodyHasNoSizeGateAndVideoStillHasOne(t *testing.T) {
	data := bytes.Repeat([]byte{1}, 16<<20)
	for _, contentType := range []string{"audio/mpeg", "audio/wav"} {
		response := &http.Response{Header: http.Header{"Content-Type": []string{contentType}}, ContentLength: maxMediaBytes + 1, Body: io.NopCloser(bytes.NewReader(data))}
		got, mime, err := readMediaBody(response)
		if err != nil || mime != contentType || !bytes.Equal(got, data) {
			t.Fatalf("audio changed or rejected: %v", err)
		}
	}
	response := &http.Response{Header: http.Header{"Content-Type": []string{"video/mp4"}}, ContentLength: maxMediaBytes + 1, Body: io.NopCloser(bytes.NewReader(data))}
	if _, _, err := readMediaBody(response); err == nil {
		t.Fatal("video size protection removed")
	}
}
