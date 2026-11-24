package sshx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"
)

func randomMarker() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// InstallSpec describes a file pushed to a host and installed as root.
type InstallSpec struct {
	OpID      string    // used for the per-operation staging directory
	Name      string    // staging file name
	Source    io.Reader // file content (gzip-compressed when Gzipped)
	Gzipped   bool      // decompress with gzip on the host
	SHA256    string    // expected SHA-256 of the installed (decompressed) content
	Dest      string    // absolute destination path
	Mode      string    // e.g. 0755
	RateLimit int64     // bytes per second, 0 = unlimited
}

// Install uploads a file over SFTP into a private (0700) per-user staging
// directory, then as root verifies it is a regular file (not a symlink),
// decompresses it next to the destination, checks the SHA-256 and atomically
// renames it into place.
func Install(ctx context.Context, c *Client, s InstallSpec) error {
	if err := ValidIdent(s.OpID); err != nil {
		return err
	}
	if err := ValidIdent(s.Name); err != nil {
		return err
	}
	if err := ValidSHA256(s.SHA256); err != nil {
		return err
	}
	if err := ValidPath(s.Dest); err != nil {
		return err
	}
	if !validMode(s.Mode) {
		return fmt.Errorf("invalid file mode %q", s.Mode)
	}
	sf, err := c.SFTP()
	if err != nil {
		return fmt.Errorf("open sftp: %w", err)
	}
	home, err := sf.Getwd()
	if err != nil {
		return err
	}
	stageRoot := path.Join(home, ".nomad-deck-staging")
	stageDir := path.Join(stageRoot, s.OpID)
	for _, d := range []string{stageRoot, stageDir} {
		if err := sf.Mkdir(d); err != nil {
			if fi, statErr := sf.Lstat(d); statErr != nil || !fi.IsDir() {
				return fmt.Errorf("create staging dir %s: %w", d, err)
			}
		}
		if err := sf.Chmod(d, 0o700); err != nil {
			return err
		}
	}
	stageFile := path.Join(stageDir, s.Name)
	f, err := sf.OpenFile(stageFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return fmt.Errorf("create staging file: %w", err)
	}
	src := s.Source
	if s.RateLimit > 0 {
		src = &rateLimitedReader{r: src, rate: s.RateLimit, ctx: ctx, start: time.Now()}
	}
	if _, err := io.Copy(f, &ctxReader{ctx: ctx, r: src}); err != nil {
		f.Close()
		return fmt.Errorf("upload: %w", err)
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := sf.Chmod(stageFile, 0o600); err != nil {
		return err
	}
	if err := ValidPath(stageFile); err != nil {
		return fmt.Errorf("staging path not usable: %w", err)
	}
	decode := "cat"
	if s.Gzipped {
		decode = "gzip -dc"
	}
	destDir := s.Dest[:strings.LastIndex(s.Dest, "/")]
	if destDir == "" {
		destDir = "/"
	}
	script := fmt.Sprintf(`set -e
src=%[1]s
if [ ! -f "$src" ] || [ -L "$src" ]; then echo "staging file is not a regular file" >&2; exit 2; fi
install -d -m 0755 %[2]s
tmp=%[3]s.nd-tmp.$$
trap 'rm -f "$tmp"' EXIT
%[4]s "$src" > "$tmp"
got=$(sha256sum "$tmp" | cut -d' ' -f1)
if [ "$got" != %[5]s ]; then echo "sha256 mismatch: got $got" >&2; exit 3; fi
chmod %[6]s "$tmp"
sync "$tmp" 2>/dev/null || sync
mv -f "$tmp" %[3]s
trap - EXIT
rm -f "$src"
`, Quote(stageFile), Quote(destDir), Quote(s.Dest), decode, Quote(s.SHA256), s.Mode)
	if _, err := c.Run(ctx, script, RunOptions{Sudo: true}); err != nil {
		return fmt.Errorf("install %s: %w", s.Dest, err)
	}
	_ = sf.RemoveDirectory(stageDir)
	return nil
}

func validMode(m string) bool {
	if len(m) != 4 || m[0] != '0' {
		return false
	}
	for _, ch := range m[1:] {
		if ch < '0' || ch > '7' {
			return false
		}
	}
	return true
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c *ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

type rateLimitedReader struct {
	r     io.Reader
	rate  int64
	ctx   context.Context
	start time.Time
	read  int64
}

func (l *rateLimitedReader) Read(p []byte) (int, error) {
	if max := int(l.rate / 10); max > 0 && len(p) > max {
		p = p[:max]
	}
	n, err := l.r.Read(p)
	l.read += int64(n)
	want := time.Duration(float64(l.read) / float64(l.rate) * float64(time.Second))
	if wait := want - time.Since(l.start); wait > 0 {
		select {
		case <-time.After(wait):
		case <-l.ctx.Done():
			return n, l.ctx.Err()
		}
	}
	return n, err
}
