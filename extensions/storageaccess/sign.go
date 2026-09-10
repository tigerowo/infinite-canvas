package storageaccess

import (
	"crypto/md5" // Required by the EdgeOne Type B wire protocol, not for passwords.
	"encoding/hex"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const TokenLifetime = 5 * time.Minute

// CDNURL must be called only after the caller verifies the object's ownership.
// User-owned providers do not inherit the administrator's CDN configuration.
func CDNURL(p model.StorageProvider, key string, now time.Time) (string, time.Time, bool, error) {
	if p.ID == "" || p.OwnerUserID != "" {
		return "", time.Time{}, false, nil
	}
	db, err := repository.DB()
	if err != nil {
		return "", time.Time{}, false, err
	}
	cfg, err := loadConfig(db, p)
	if err != nil {
		return "", time.Time{}, false, err
	}
	if cfg.Delivery == "esa-a" {
		signed, expires, err := signTypeA(cfg, key, now)
		return signed, expires, true, err
	}
	if cfg.Delivery != "edgeone-b" {
		return "", time.Time{}, false, nil
	}
	signed, expires, err := signTypeB(cfg, key, now)
	return signed, expires, true, err
}

func signTypeA(cfg Config, key string, now time.Time) (string, time.Time, error) {
	// Reuse path validation, but sign ESA's query-based Type A contract independently.
	if _, _, err := signTypeB(cfg, key, now); err != nil {
		return "", time.Time{}, err
	}
	path := strings.ReplaceAll(strings.ReplaceAll(url.QueryEscape("/"+key), "+", "%20"), "%2F", "/")
	stamp := strconv.FormatInt(now.Unix(), 10)
	auth := stamp + "-0-0"
	hash := md5.Sum([]byte(path + "-" + auth + "-" + cfg.TokenKey))
	return cfg.CDNBaseURL + path + "?auth_key=" + auth + "-" + hex.EncodeToString(hash[:]), now.UTC().Truncate(time.Second).Add(TokenLifetime), nil
}

func signTypeB(cfg Config, key string, now time.Time) (string, time.Time, error) {
	if cfg.CDNBaseURL == "" || cfg.TokenKey == "" || key == "" || strings.HasPrefix(key, "/") || strings.Contains(key, "\\") {
		return "", time.Time{}, errors.New("CDN 签名配置或对象路径无效")
	}
	for _, part := range strings.Split(key, "/") {
		if part == "." || part == ".." || part == "" {
			return "", time.Time{}, errors.New("对象路径无效")
		}
	}
	// Escape once and sign the exact path sent to EdgeOne; never path.Clean it.
	path := strings.ReplaceAll(strings.ReplaceAll(url.QueryEscape("/"+key), "+", "%20"), "%2F", "/")
	stamp := now.In(time.FixedZone("UTC+8", 8*60*60)).Format("200601021504")
	hash := md5.Sum([]byte(cfg.TokenKey + stamp + path))
	expires := now.UTC().Truncate(time.Minute).Add(TokenLifetime)
	return cfg.CDNBaseURL + "/" + stamp + "/" + hex.EncodeToString(hash[:]) + path, expires, nil
}
