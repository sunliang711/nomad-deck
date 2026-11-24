package audit

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestRedactString(t *testing.T) {
	in := strings.Join([]string{
		"Authorization: Bearer abcdefghijklmnop",
		"token=hvs.CAESIJabcdefghijklmnopqrstuvwxyz",
		"X-Nomad-Token: 5b6f1e2a-1234-4567-89ab-0123456789ab",
		"password: hunter2hunter2",
		"vault operator unseal --unseal-key abcdef",
		"-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
		"plain text stays",
	}, "\n")
	out := RedactString(in)
	for _, leak := range []string{"abcdefghijklmnop", "hvs.CAES", "5b6f1e2a", "hunter2", "AAAA", "abcdef\n"} {
		if strings.Contains(out, leak) {
			t.Errorf("leaked %q in:\n%s", leak, out)
		}
	}
	if !strings.Contains(out, "plain text stays") {
		t.Error("non-secret text must be preserved")
	}
}

func TestRedactValue(t *testing.T) {
	v := map[string]any{
		"username":         "alice",
		"current_password": "x",
		"nested":           map[string]any{"gossip_key": "k", "list": []any{"Bearer abcdefghijkl"}},
		"empty_token":      "",
	}
	b, _ := json.Marshal(RedactValue(v))
	s := string(b)
	if strings.Contains(s, `"x"`) || strings.Contains(s, `"k"`) || strings.Contains(s, "abcdefghijkl") {
		t.Fatalf("leak: %s", s)
	}
	if !strings.Contains(s, "alice") || !strings.Contains(s, `"empty_token":""`) {
		t.Fatalf("unexpected: %s", s)
	}
}

func TestStreamingWriter(t *testing.T) {
	var out bytes.Buffer
	w := NewWriter(&out)
	chunks := []string{"line one pass", "word=abc\nkeep\n-----BEGIN RSA PRIV", "ATE KEY-----\nMIIE\nxyz\n-----END RSA PRIVATE KEY-----\nafter\ntail"}
	for _, c := range chunks {
		w.Write([]byte(c))
	}
	w.Flush()
	s := out.String()
	if strings.Contains(s, "abc") || strings.Contains(s, "MIIE") || strings.Contains(s, "xyz") {
		t.Fatalf("leak: %q", s)
	}
	for _, keep := range []string{"keep\n", "after\n", "tail"} {
		if !strings.Contains(s, keep) {
			t.Fatalf("missing %q in %q", keep, s)
		}
	}
}

func TestStreamingWriterUnterminatedPEM(t *testing.T) {
	var out bytes.Buffer
	w := NewWriter(&out)
	w.Write([]byte("ok\n-----BEGIN EC PRIVATE KEY-----\nSECRETDATA\n"))
	w.Flush()
	if strings.Contains(out.String(), "SECRETDATA") || !strings.HasPrefix(out.String(), "ok\n") {
		t.Fatalf("unexpected: %q", out.String())
	}
}
