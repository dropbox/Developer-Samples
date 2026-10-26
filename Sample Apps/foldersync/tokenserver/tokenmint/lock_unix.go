//go:build unix

package tokenmint

import (
	"context"
	"fmt"
	"os"
	"syscall"
	"time"

	"errors"
)

// lockPollInterval is how often lockFile retries a lock someone else holds.
const lockPollInterval = 20 * time.Millisecond

// lockFile takes an exclusive lock on path, waiting until it's free or ctx is
// done, and returns a function that releases it.
func lockFile(ctx context.Context, path string) (func() error, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open lock file: %w", err)
	}
	fail := func(err error) (func() error, error) {
		if closeErr := f.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close lock file: %w", closeErr))
		}
		return nil, err
	}
	ticker := time.NewTicker(lockPollInterval)
	defer ticker.Stop()
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			return fail(fmt.Errorf("take lock: %w", err))
		}
		select {
		case <-ctx.Done():
			return fail(fmt.Errorf("wait for lock: %w", ctx.Err()))
		case <-ticker.C:
		}
	}
	return func() error {
		unlockErr := syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		closeErr := f.Close()
		if unlockErr != nil {
			return errors.Join(fmt.Errorf("release lock: %w", unlockErr), closeErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close lock file: %w", closeErr)
		}
		return nil
	}, nil
}
