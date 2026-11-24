// Package version exposes build metadata injected at link time.
package version

import "fmt"

// Version and Commit are overridden with -ldflags at build time.
var (
	Version = "dev"
	Commit  = ""
)

// String returns a human readable version string.
func String() string {
	if Commit == "" {
		return Version
	}
	return fmt.Sprintf("%s (%s)", Version, Commit)
}
