package service

import "testing"

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
