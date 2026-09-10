package mediaidentity

import "testing"

func TestIdentityIsolation(t *testing.T) {
	a := Digest("user-a", "provider-a", "image/png", "content")
	if a != Digest("user-a", "provider-a", "image/png", "content") {
		t.Fatal("retry identity changed")
	}
	for _, parts := range [][]string{{"user-b", "provider-a", "image/png", "content"}, {"user-a", "provider-b", "image/png", "content"}, {"user-a", "provider-a", "image/png", "different"}} {
		if a == Digest(parts...) {
			t.Fatal("identity crossed owner, provider or content boundary")
		}
	}
}
