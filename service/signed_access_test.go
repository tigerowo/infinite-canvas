package service

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
)

func TestSignAndVerifyResourceAccess(t *testing.T) {
	config.Cfg.JWTSecret = "test-secret-for-sign"
	exp, sig := SignResourceAccess("file:abc", time.Hour)
	if !VerifyResourceAccess("file:abc", strconv.FormatInt(exp, 10), sig) {
		t.Fatal("expected valid signature")
	}
	if VerifyResourceAccess("file:abc", strconv.FormatInt(exp, 10), "deadbeef") {
		t.Fatal("expected invalid signature reject")
	}
	if VerifyResourceAccess("file:other", strconv.FormatInt(exp, 10), sig) {
		t.Fatal("expected resource mismatch reject")
	}
	if VerifyResourceAccess("file:abc", strconv.FormatInt(time.Now().Add(-time.Hour).Unix(), 10), sig) {
		t.Fatal("expected expired reject")
	}
}

func TestSignedFileContentPathContainsQuery(t *testing.T) {
	config.Cfg.JWTSecret = "test-secret-for-sign"
	path := SignedFileContentPath("obj-1")
	if !strings.HasPrefix(path, "/api/files/") {
		t.Fatalf("unexpected path %q", path)
	}
	if !strings.Contains(path, "exp=") || !strings.Contains(path, "sig=") {
		t.Fatalf("missing query in %q", path)
	}
}
