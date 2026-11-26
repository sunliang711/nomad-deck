// Package version exposes build metadata injected at link time.
package version

import "fmt"

// Version, Commit, BuildDate, Repo and ReleasePublicKey are overridden with -ldflags at build time.
var (
	Version          = "dev"
	Commit           = ""
	BuildDate        = ""
	Repo             = "sunliang711/nomad-deck"
	ReleasePublicKey = ""
)

// ExitCodeRestart is returned when the control plane exits after switching
// binaries so systemd immediately restarts it with the new version.
const ExitCodeRestart = 75

// String returns a human readable version string.
func String() string {
	if Commit == "" {
		return Version
	}
	return fmt.Sprintf("%s (%s)", Version, Commit)
}
