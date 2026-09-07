package modelcapabilities

import "strings"

// IsVideo recognizes provider aliases whose video capability was verified.
func IsVideo(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "lec-mj-wan-3-0-1080p", "lec-seed-2-0-900", "lec-seed-2-5-900":
		return true
	}
	return false
}
