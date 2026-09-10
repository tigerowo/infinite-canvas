// Package mediaidentity gives immutable uploads an owner- and provider-scoped identity.
package mediaidentity

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sync"
)

var locks [64]sync.Mutex

func Digest(parts ...string) string {
	data, _ := json.Marshal(parts)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// Lock coalesces local writers. Across processes the same immutable bytes use
// the same object path, so a crash/retry cannot leave a second physical object.
func Lock(id string) func() {
	sum := sha256.Sum256([]byte(id))
	mu := &locks[int(sum[0])%len(locks)]
	mu.Lock()
	return mu.Unlock
}
