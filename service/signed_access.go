package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
)

const (
	defaultSignedAccessTTL     = 2 * time.Hour
	referenceMediaSignedTTL    = 24 * time.Hour
	signedAccessQueryExp       = "exp"
	signedAccessQuerySig       = "sig"
)

// SignResourceAccess returns exp unix seconds and hex hmac signature for resourceKey.
func SignResourceAccess(resourceKey string, ttl time.Duration) (exp int64, sig string) {
	if ttl <= 0 {
		ttl = defaultSignedAccessTTL
	}
	exp = time.Now().Add(ttl).Unix()
	sig = signResource(resourceKey, exp)
	return exp, sig
}

// VerifyResourceAccess validates exp/sig query values for a resource key.
func VerifyResourceAccess(resourceKey string, expRaw string, sig string) bool {
	expRaw = strings.TrimSpace(expRaw)
	sig = strings.TrimSpace(sig)
	if expRaw == "" || sig == "" {
		return false
	}
	exp, err := strconv.ParseInt(expRaw, 10, 64)
	if err != nil || exp <= 0 {
		return false
	}
	if time.Now().Unix() > exp {
		return false
	}
	expected := signResource(resourceKey, exp)
	return hmac.Equal([]byte(strings.ToLower(sig)), []byte(strings.ToLower(expected)))
}

func signResource(resourceKey string, exp int64) string {
	secret := strings.TrimSpace(config.Cfg.JWTSecret)
	if secret == "" {
		secret = "infinite-canvas"
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(fmt.Sprintf("%s|%d", resourceKey, exp)))
	return hex.EncodeToString(mac.Sum(nil))
}

// AppendSignedAccessQuery appends exp/sig to a path-only or absolute path URL.
func AppendSignedAccessQuery(path string, resourceKey string, ttl time.Duration) string {
	exp, sig := SignResourceAccess(resourceKey, ttl)
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return path + sep + signedAccessQueryExp + "=" + strconv.FormatInt(exp, 10) + "&" + signedAccessQuerySig + "=" + url.QueryEscape(sig)
}

// SignedFileContentPath returns a relative signed content path for a storage object id.
func SignedFileContentPath(id string) string {
	id = strings.TrimSpace(id)
	path := "/api/files/" + url.PathEscape(id) + "/content"
	return AppendSignedAccessQuery(path, fileResourceKey(id), defaultSignedAccessTTL)
}

// SignedReferenceMediaPath returns a relative signed path for reference media.
func SignedReferenceMediaPath(id string) string {
	id = strings.TrimSpace(id)
	path := "/api/media/references/" + url.PathEscape(id)
	return AppendSignedAccessQuery(path, referenceResourceKey(id), referenceMediaSignedTTL)
}

func fileResourceKey(id string) string {
	return "file:" + strings.TrimSpace(id)
}

func referenceResourceKey(id string) string {
	return "reference:" + strings.TrimSpace(id)
}
