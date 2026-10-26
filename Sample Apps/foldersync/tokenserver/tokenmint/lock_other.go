//go:build !unix

package tokenmint

import (
	"context"
	"fmt"
)

// lockFile is a no-op where flock isn't available. The sample runs on macOS and
// Linux; Windows support would use LockFileEx.
func lockFile(ctx context.Context, _ string) (func() error, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("wait for lock: %w", err)
	}
	return func() error { return nil }, nil
}
