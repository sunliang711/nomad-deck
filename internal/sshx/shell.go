// Package sshx implements SSH/SFTP remote execution: host key pinning
// (trust on first use), a bounded connection pool, sudo wrapping, fixed
// command templates with strict argument validation, staged file upload and
// detached remote steps whose results survive disconnects and reboots.
package sshx

import (
	"fmt"
	"regexp"
	"strings"
)

// Quote returns s as a single POSIX shell word.
func Quote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

// Validators for values that are interpolated into remote command templates.
// Everything else must be passed through Quote.
var (
	reVersion  = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.]+)?$`)
	reIdent    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	reUnit     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9@._-]{0,200}$`)
	reSafePath = regexp.MustCompile(`^/[A-Za-z0-9._/@+-]*$`)
	reSHA256   = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// ValidVersion checks a product version string such as 1.9.3 or 1.9.3+ent.
func ValidVersion(s string) error { return check(reVersion, s, "version") }

// ValidIdent checks an identifier (operation IDs, step names, product names).
func ValidIdent(s string) error { return check(reIdent, s, "identifier") }

// ValidUnit checks a systemd unit name.
func ValidUnit(s string) error { return check(reUnit, s, "unit name") }

// ValidSHA256 checks a lowercase hex SHA-256 digest.
func ValidSHA256(s string) error { return check(reSHA256, s, "sha256") }

// ValidPath checks an absolute path without traversal or shell metacharacters.
func ValidPath(s string) error {
	if len(s) > 4096 {
		return fmt.Errorf("invalid path: too long")
	}
	if err := check(reSafePath, s, "path"); err != nil {
		return err
	}
	for _, part := range strings.Split(s, "/") {
		if part == ".." || part == "." {
			return fmt.Errorf("invalid path %q: traversal not allowed", s)
		}
	}
	return nil
}

func check(re *regexp.Regexp, s, what string) error {
	if !re.MatchString(s) {
		return fmt.Errorf("invalid %s %q", what, s)
	}
	return nil
}
