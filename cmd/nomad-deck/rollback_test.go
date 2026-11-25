package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"nomad-deck/internal/db"
	"nomad-deck/internal/selfupdate"
	"nomad-deck/internal/server"
)

func TestRollbackCLI(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	binDir := filepath.Join(root, "bin")
	verDir := filepath.Join(binDir, "versions")
	_ = os.MkdirAll(verDir, 0o755)

	v1 := filepath.Join(verDir, "nomad-deck-1.0.0")
	v2 := filepath.Join(verDir, "nomad-deck-1.1.0")
	_ = os.WriteFile(v1, []byte("v1"), 0o755)
	_ = os.WriteFile(v2, []byte("v2"), 0o755)
	_ = os.Symlink(v2, filepath.Join(binDir, "nomad-deck"))
	_ = os.Symlink(v1, filepath.Join(binDir, "nomad-deck.prev"))

	d, err := db.Open(context.Background(), filepath.Join(dataDir, server.DatabaseFile))
	if err != nil {
		t.Fatal(err)
	}
	bak, err := selfupdate.BackupDatabase(context.Background(), d, dataDir, "v1.0.0", "v1.1.0")
	if err != nil {
		t.Fatal(err)
	}
	_ = db.PutSettingJSON(context.Background(), d.Writer, selfupdate.SettingLastResult, selfupdate.UpdateResult{
		State:       selfupdate.StatePending,
		FromVersion: "v1.0.0",
		ToVersion:   "v1.1.0",
		BackupFile:  bak,
		PrevBinary:  v1,
	}, d.NowString())
	d.Close()

	var out bytes.Buffer
	if err := rollbackCmd([]string{"--check", "--config", "", "--data-dir", dataDir}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("--check expected exit 0, got %v", err)
	}
	if err := rollbackCmd([]string{"--auto", "--config", "", "--data-dir", dataDir, "--bin-dir", binDir}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("--auto: %v", err)
	}
	var ee *server.ExitError
	err = rollbackCmd([]string{"--check", "--config", "", "--data-dir", dataDir}, strings.NewReader(""), &out)
	if !errors.As(err, &ee) || ee.Code != 1 {
		t.Fatalf("second --check must exit 1, got %v", err)
	}

	// --to-backup requires confirmation unless --yes.
	if err := rollbackCmd([]string{"--to-backup", bak, "--config", "", "--data-dir", dataDir, "--bin-dir", binDir}, strings.NewReader("no\n"), &out); err == nil {
		t.Fatal("expected cancel when confirmation is not yes")
	}
	if err := rollbackCmd([]string{"--to-backup", bak, "--yes", "--config", "", "--data-dir", dataDir, "--bin-dir", binDir}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("--to-backup --yes: %v", err)
	}
}
