package main

import (
	"os"
	"path/filepath"
	"testing"

	"nomad-deck/internal/selfupdate"
)

func TestRunVersionAndHelp(t *testing.T) {
	for _, arg := range []string{"--version", "-version", "version", "--help", "-h", "help"} {
		if err := run([]string{arg}); err != nil {
			t.Fatalf("run(%q) failed: %v", arg, err)
		}
	}
}

func TestResolveBinDir(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	verDir := filepath.Join(binDir, "versions")
	if err := os.MkdirAll(verDir, 0o755); err != nil {
		t.Fatal(err)
	}
	v1 := filepath.Join(verDir, "nomad-deck-1.0.0")
	if err := os.WriteFile(v1, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(binDir, "nomad-deck")
	if err := os.Symlink(filepath.Join("versions", "nomad-deck-1.0.0"), link); err != nil {
		t.Fatal(err)
	}

	origArgs := os.Args
	os.Args = []string{link}
	t.Cleanup(func() { os.Args = origArgs })

	if got := selfupdate.ResolveBinDir(); got != binDir {
		t.Fatalf("ResolveBinDir() = %q, want %q", got, binDir)
	}
}
