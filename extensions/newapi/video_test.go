package newapi

import "testing"

func TestCompletedDirectVideo(t *testing.T) {
	for _, status := range []string{"completed", "processing", "failed"} {
		result := ParseVideoTask([]byte(`{"id":"gateway","status":"` + status + `","metadata":{"canvas_video_result":{"version":1,"url":"https://asset.example/result.mp4?sig=a%2Bb&expires=1"}}}`))
		want := ""
		if status == "completed" {
			want = "https://asset.example/result.mp4?sig=a%2Bb&expires=1"
		}
		if result.VideoURL != want || result.UpstreamTaskID != "gateway" {
			t.Fatalf("%s: %+v", status, result)
		}
	}
	for _, payload := range []string{
		`{"id":"gateway","status":"completed","metadata":{"url":"https://example.com/input.png"}}`,
		`{"id":"gateway","status":"completed","metadata":{"canvas_video_result":{"version":2,"url":"https://example.com/video.mp4"}}}`,
		`{"id":"gateway","status":"completed","metadata":{"canvas_video_result":{"version":1,"url":"javascript:alert(1)"}}}`,
	} {
		if ParseVideoTask([]byte(payload)).VideoURL != "" {
			t.Fatal("unexpected URL")
		}
	}
}
