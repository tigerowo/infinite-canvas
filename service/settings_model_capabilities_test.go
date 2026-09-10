package service

import "testing"

func TestAutomaticDefaultsStayEmptyAndManualDefaultsMatchCapability(t *testing.T) {
	models := []string{"gpt-image-2", "sora-video", "gpt-5.5"}
	for _, value := range []string{"", "all", "missing-video", "gpt-image-2"} {
		if got := repairDefaultModel(value, models, isVideoModelName); got != "" {
			t.Errorf("default %q: got %q, want automatic", value, got)
		}
	}
	if got := repairDefaultModel(" sora-video ", models, isVideoModelName); got != "sora-video" {
		t.Errorf("valid default lost: %q", got)
	}
}

func TestVerifiedVideoAliases(t *testing.T) {
	for _, name := range []string{"lec-mj-wan-3-0-1080p", "lec-seed-2-0-900", "lec-seed-2-5-900", " LEC-SEED-2-0-900 "} {
		if !isVideoModelName(name) || isTextModelName(name) {
			t.Errorf("%q must be video, not text", name)
		}
	}
	if isVideoModelName("wan3.0-image") || isVideoModelName("lec-seed-unknown") || !isTextModelName("gpt-5.4") {
		t.Fatal("unrelated model classification changed")
	}
}

func TestAudioModelsCannotRemainTextDefaults(t *testing.T) {
	for _, name := range []string{"gpt-4o-mini-tts", "gemini-tts", "suno-music", "speech-01", "voice-clone", "audio-model"} {
		if got := repairDefaultModel(name, []string{name, "gpt-5.5"}, isTextModelName); got != "" {
			t.Errorf("audio model %q remained a text default", got)
		}
	}
}
