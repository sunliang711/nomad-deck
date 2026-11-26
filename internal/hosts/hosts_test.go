package hosts

import (
	"errors"
	"strings"
	"testing"

	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
	"nomad-deck/internal/sshx"
)

func TestControlPlaneHostColocationAllowedWithWarning(t *testing.T) {
	svc := &Service{LocalMachineID: "cp-machine-123"}
	same := &db.Node{Host: "127.0.0.1", MachineID: "cp-machine-123"}
	other := &db.Node{Host: "10.0.0.12", MachineID: "remote-machine-456"}

	if !svc.IsControlPlaneHost(same) {
		t.Fatal("expected IsControlPlaneHost(same) = true")
	}
	if svc.IsControlPlaneHost(other) {
		t.Fatal("expected IsControlPlaneHost(other) = false")
	}

	probe := &sshx.ProbeResult{
		SudoReady:   true,
		Arch:        "amd64",
		TimeSync:    "synced",
		OptWritable: true,
	}
	warnings := WarningsForHost(same, probe, svc.IsControlPlaneHost(same))
	joined := strings.Join(warnings, "\n")
	if !strings.Contains(joined, "与 NomadDeck 控制面同机") {
		t.Fatalf("expected co-location warning, got %v", warnings)
	}
	if !strings.Contains(joined, "回环地址") {
		t.Fatalf("expected loopback warning, got %v", warnings)
	}

	otherWarnings := WarningsForHost(other, probe, svc.IsControlPlaneHost(other))
	if len(otherWarnings) != 0 {
		t.Fatalf("expected no warnings for clean remote node, got %v", otherWarnings)
	}
}

func TestFormatPushKeyError(t *testing.T) {
	mmErr := formatPushKeyError(&sshx.ErrHostKeyMismatch{Expected: "SHA256:a", Actual: "SHA256:b"})
	var ae *auth.Error
	if !errors.As(mmErr, &ae) || ae.Code != "host_key_mismatch" {
		t.Fatalf("expected host_key_mismatch, got %v", mmErr)
	}

	authErr := formatPushKeyError(errors.New("ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password], no supported methods remain"))
	if !errors.As(authErr, &ae) || ae.Code != "push_key_failed" || !strings.Contains(ae.Message, "手动配置公钥") {
		t.Fatalf("expected friendly auth error, got %v", authErr)
	}

	netErr := formatPushKeyError(errors.New("dial tcp 10.0.0.1:22: i/o timeout"))
	if !errors.As(netErr, &ae) || ae.Code != "push_key_failed" || !strings.Contains(ae.Message, "i/o timeout") {
		t.Fatalf("expected generic push_key_failed, got %v", netErr)
	}
}
