package sshx

import (
	"context"
	"fmt"
	"strings"
)

// PushKey appends publicKey to the login user's authorized_keys if it is not
// already present, fixing directory/file permissions and SELinux labels.
// The target normally authenticates with a one-time password. It returns the
// host key fingerprint observed during the connection.
func PushKey(ctx context.Context, t Target, publicKey string) (string, error) {
	publicKey = strings.TrimSpace(publicKey)
	if publicKey == "" || strings.ContainsAny(publicKey, "\r\n") {
		return "", fmt.Errorf("invalid public key")
	}
	c, err := Dial(ctx, t)
	if err != nil {
		return "", err
	}
	defer c.Close()
	script := `set -e
umask 077
key=` + Quote(publicKey) + `
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
if ! grep -qxF "$key" "$HOME/.ssh/authorized_keys"; then printf '%s\n' "$key" >> "$HOME/.ssh/authorized_keys"; fi
if command -v restorecon >/dev/null 2>&1; then restorecon -R "$HOME/.ssh" >/dev/null 2>&1 || true; fi
`
	if _, err := c.Run(ctx, script, RunOptions{}); err != nil {
		return c.HostKeyFingerprint, err
	}
	return c.HostKeyFingerprint, nil
}
