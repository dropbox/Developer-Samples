//go:build unix

package tokenmint

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestLockFile_WaitsUntilTheContextIsDone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.json.lock")
	unlock, err := lockFile(t.Context(), path)
	require.NoError(t, err)

	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	_, err = lockFile(ctx, path)
	require.ErrorIs(t, err, context.DeadlineExceeded)

	require.NoError(t, unlock())
	unlockAgain, err := lockFile(t.Context(), path)
	require.NoError(t, err)
	require.NoError(t, unlockAgain())
}
