package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nomad-deck/internal/vaultbackup"
)

func TestOfflineBackupDecrypt(t *testing.T) {
	vaultbackup.DefaultMemory = 8 * 1024
	data, err := vaultbackup.Encrypt(&vaultbackup.Payload{ClusterName: "prod", ClusterID: "c1", CreatedAt: time.Now(), ActiveGeneration: 1,
		Generations: []vaultbackup.Generation{{Generation: 1, KeyShares: 3, KeyThreshold: 2, UnsealKeys: []string{"k1", "k2", "k3"}}}}, "offline passphrase")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "b.ndvkb")
	os.WriteFile(path, data, 0o600)
	var out, errOut bytes.Buffer
	if err := offlineBackup([]string{"decrypt", "--passphrase-stdin", path}, strings.NewReader("offline passphrase\n"), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"k3"`) || !strings.Contains(errOut.String(), "prod") {
		t.Fatalf("output: %s / %s", out.String(), errOut.String())
	}
	if err := offlineBackup([]string{"decrypt", "--passphrase-stdin", path}, strings.NewReader("wrong\n"), &out, &errOut); err == nil {
		t.Fatal("wrong passphrase must fail")
	}
}
