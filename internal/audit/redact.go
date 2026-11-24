// Package audit records audit events and redacts secrets from request
// summaries and streamed logs before they are persisted or broadcast.
package audit

import (
	"bytes"
	"io"
	"regexp"
	"strings"
	"sync"
)

// Redacted replaces any secret value.
const Redacted = "<redacted>"

// sensitiveKeyParts mark map keys whose values are always redacted.
var sensitiveKeyParts = []string{
	"token", "password", "passphrase", "secret", "private_key", "privatekey",
	"unseal_key", "gossip_key", "authorization", "credential", "api_key", "apikey",
}

// IsSensitiveKey reports whether a field name denotes a secret.
func IsSensitiveKey(k string) bool {
	k = strings.ToLower(k)
	for _, p := range sensitiveKeyParts {
		if strings.Contains(k, p) {
			return true
		}
	}
	return false
}

var secretPatterns = []*regexp.Regexp{
	// PEM private keys of any kind.
	regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----`),
	// Authorization headers.
	regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}`),
	// Vault service/batch/recovery tokens and legacy tokens.
	regexp.MustCompile(`\bhv[sbr]\.[A-Za-z0-9_-]{20,}`),
	regexp.MustCompile(`\b[sbr]\.[A-Za-z0-9]{24}\b`),
	// Nomad / Vault token headers followed by a value.
	regexp.MustCompile(`(?i)(x-(?:nomad|vault)-token\s*[:=]\s*)\S+`),
	// key=value or key: value pairs with sensitive names.
	regexp.MustCompile(`(?i)\b((?:[a-z0-9_-]*)(?:password|passphrase|secret|token|unseal_key|gossip_key|private_key|api_key)[a-z0-9_-]*\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)`),
	// CLI flags carrying secrets.
	regexp.MustCompile(`(?i)(--?(?:password|passphrase|secret|token|key-shares-file|unseal-key)[= ])\S+`),
}

// RedactString removes secret material from free text.
func RedactString(s string) string {
	for i, re := range secretPatterns {
		switch i {
		case 4, 5, 6:
			s = re.ReplaceAllString(s, "${1}"+Redacted)
		default:
			s = re.ReplaceAllString(s, Redacted)
		}
	}
	return s
}

// RedactValue returns a deep copy of v with sensitive keys and secret-looking
// strings redacted. It understands the shapes produced by encoding/json.
func RedactValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if IsSensitiveKey(k) {
				if val == nil || val == "" {
					out[k] = val
				} else {
					out[k] = Redacted
				}
				continue
			}
			out[k] = RedactValue(val)
		}
		return out
	case map[string]string:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if IsSensitiveKey(k) && val != "" {
				out[k] = Redacted
			} else {
				out[k] = RedactString(val)
			}
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = RedactValue(val)
		}
		return out
	case []string:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = RedactString(val)
		}
		return out
	case string:
		return RedactString(t)
	default:
		return v
	}
}

// Writer is a line-buffered io.Writer that redacts each complete line before
// forwarding it. Multi-line PEM blocks are held until their END marker.
type Writer struct {
	mu   sync.Mutex
	dst  io.Writer
	buf  bytes.Buffer
	open bool // inside a PEM private key block
}

// NewWriter wraps dst with streaming redaction.
func NewWriter(dst io.Writer) *Writer { return &Writer{dst: dst} }

var (
	pemBegin = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`)
	pemEnd   = regexp.MustCompile(`-----END [A-Z0-9 ]*PRIVATE KEY-----`)
)

// Write implements io.Writer.
func (w *Writer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf.Write(p)
	for {
		data := w.buf.Bytes()
		idx := bytes.IndexByte(data, '\n')
		if idx < 0 {
			break
		}
		if !w.open && pemBegin.Match(data[:idx]) && !pemEnd.Match(data[:idx]) {
			// Hold everything until the END marker arrives.
			w.open = true
		}
		if w.open {
			loc := pemEnd.FindIndex(data)
			if loc == nil {
				break
			}
			end := bytes.IndexByte(data[loc[1]:], '\n')
			if end < 0 {
				break
			}
			chunk := string(data[:loc[1]+end+1])
			w.buf.Next(len(chunk))
			w.open = false
			if _, err := io.WriteString(w.dst, RedactString(chunk)); err != nil {
				return len(p), err
			}
			continue
		}
		line := string(data[:idx+1])
		w.buf.Next(idx + 1)
		if _, err := io.WriteString(w.dst, RedactString(line)); err != nil {
			return len(p), err
		}
	}
	return len(p), nil
}

// Flush writes any buffered partial line (redacted).
func (w *Writer) Flush() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.buf.Len() == 0 {
		return nil
	}
	s := w.buf.String()
	w.buf.Reset()
	if w.open {
		// An unterminated private key block: drop it entirely.
		w.open = false
		if i := pemBegin.FindStringIndex(s); i != nil {
			s = s[:i[0]] + Redacted + "\n"
		}
	}
	_, err := io.WriteString(w.dst, RedactString(s))
	return err
}
