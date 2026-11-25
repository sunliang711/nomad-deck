//go:build !unix

package selfupdate

// AcquireProcessLock is a no-op on non-Unix platforms.
func AcquireProcessLock(string) (func(), error) { return func() {}, nil }

// CheckProcessStopped is a no-op on non-Unix platforms.
func CheckProcessStopped(string) error { return nil }
