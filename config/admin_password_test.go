package config

import "testing"

func TestIsInsecureAdminPassword(t *testing.T) {
	for _, password := range []string{"", "infinite-canvas", "admin", "1234567", "password"} {
		if !IsInsecureAdminPassword(password) {
			t.Fatalf("expected insecure: %q", password)
		}
	}
	if IsInsecureAdminPassword("correct-horse-battery") {
		t.Fatal("expected secure password")
	}
}
