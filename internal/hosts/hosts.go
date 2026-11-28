// Package hosts manages SSH keys and managed hosts: registration, host key
// pinning, one-time key push, environment probing and relay installation of
// verified artifacts.
package hosts

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/release"
	"nomad-deck/internal/sshx"
)

// HostIdentity holds hardware, OS, and SSH signals used to distinguish
// duplicate registrations of the same machine from cloned VMs.
type HostIdentity struct {
	MachineID          string
	ProductUUID        string
	MACAddrs           []string
	HostKeyFingerprint string
}

// IdentityRelation describes how two probed hosts relate.
type IdentityRelation int

const (
	IdentityDifferent IdentityRelation = iota
	IdentitySameHost
	IdentityClone
)

// Service implements host and SSH key management.
type Service struct {
	DB    *db.DB
	Keys  *crypto.Keyring
	Audit *audit.Recorder
	Pool  *sshx.Pool
	// LocalMachineID is the control plane's own /etc/machine-id (may be empty).
	LocalMachineID string
	// LocalIdentity holds the control plane host's full identity signals.
	LocalIdentity HostIdentity
	// ControlPlaneInDocker reports whether NomadDeck itself runs inside a Docker
	// container whose lifecycle depends on the host Docker daemon.
	ControlPlaneInDocker bool
}

// Error is a validation or conflict error with an HTTP status.
type Error = auth.Error

func badRequest(format string, args ...any) error {
	return &auth.Error{Status: 400, Code: "invalid_argument", Message: fmt.Sprintf(format, args...)}
}

func conflict(code, format string, args ...any) error {
	return &auth.Error{Status: 409, Code: code, Message: fmt.Sprintf(format, args...)}
}

var (
	errNotFound = &auth.Error{Status: 404, Code: "not_found", Message: "资源不存在"}
	reName      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)
	reUser      = regexp.MustCompile(`^[a-z_][a-z0-9_.-]{0,31}$`)
)

// ReadLocalMachineID returns this host's machine ID, if readable.
func ReadLocalMachineID() string {
	b, err := os.ReadFile("/etc/machine-id")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// DetectDockerContainer reports whether the current process runs inside a
// Docker/containerd container whose lifecycle would be disrupted by restarting
// or reinstalling the host Docker daemon.
func DetectDockerContainer() bool {
	return detectDockerContainer(
		os.Getenv("NOMAD_DECK_CONTAINER"),
		func(p string) bool {
			_, err := os.Stat(p)
			return err == nil
		},
		func(p string) string {
			b, err := os.ReadFile(p)
			if err != nil {
				return ""
			}
			return string(b)
		},
	)
}

func detectDockerContainer(envFlag string, exists func(string) bool, readFile func(string) string) bool {
	if exists("/.dockerenv") {
		return true
	}
	// Podman/Buildah create /run/.containerenv rather than /.dockerenv;
	// restarting the host Docker daemon does not interrupt Podman containers.
	if exists("/run/.containerenv") {
		return false
	}
	if cgroup := readFile("/proc/1/cgroup"); cgroup != "" {
		if strings.Contains(cgroup, "docker") || strings.Contains(cgroup, "containerd") {
			return true
		}
	}
	return envFlag == "1"
}

// ReadLocalIdentity reads the control plane host's machine-id, DMI product UUID,
// and physical/primary NIC MAC addresses (all best-effort, empty if unreadable).
func ReadLocalIdentity() HostIdentity {
	id := HostIdentity{MachineID: ReadLocalMachineID()}
	if b, err := os.ReadFile("/sys/class/dmi/id/product_uuid"); err == nil {
		id.ProductUUID = strings.ToLower(strings.TrimSpace(string(b)))
	}
	if entries, err := os.ReadDir("/sys/class/net"); err == nil {
		var raw []string
		for _, e := range entries {
			name := e.Name()
			if !sshx.IsPhysicalInterfaceName(name) {
				continue
			}
			base := filepath.Join("/sys/class/net", name)
			if tb, err := os.ReadFile(filepath.Join(base, "type")); err == nil && strings.TrimSpace(string(tb)) != "1" {
				continue
			}
			if mb, err := os.ReadFile(filepath.Join(base, "address")); err == nil {
				raw = append(raw, string(mb))
			}
		}
		id.MACAddrs = sshx.NormalizeMACList(raw)
	}
	return id
}

func (s *Service) localIdentity() HostIdentity {
	if s == nil {
		return HostIdentity{}
	}
	id := s.LocalIdentity
	if id.MachineID == "" {
		id.MachineID = s.LocalMachineID
	}
	return id
}

// CompareHostIdentity determines whether two hosts are different machines,
// duplicate registrations of the same machine, or cloned VMs sharing a machine-id.
func CompareHostIdentity(a, b HostIdentity) IdentityRelation {
	if a.MachineID != "" && b.MachineID != "" && a.MachineID == b.MachineID {
		if a.ProductUUID != "" && b.ProductUUID != "" {
			if strings.EqualFold(a.ProductUUID, b.ProductUUID) {
				return IdentitySameHost
			}
			return IdentityClone
		}
		if len(a.MACAddrs) > 0 && len(b.MACAddrs) > 0 {
			if hasSharedMAC(a.MACAddrs, b.MACAddrs) {
				return IdentitySameHost
			}
			return IdentityClone
		}
		if a.HostKeyFingerprint != "" && b.HostKeyFingerprint != "" && a.HostKeyFingerprint != b.HostKeyFingerprint {
			return IdentityClone
		}
		return IdentitySameHost
	}
	if a.MachineID == "" || b.MachineID == "" {
		if a.ProductUUID != "" && b.ProductUUID != "" && strings.EqualFold(a.ProductUUID, b.ProductUUID) {
			return IdentitySameHost
		}
		if len(a.MACAddrs) > 0 && len(b.MACAddrs) > 0 && hasSharedMAC(a.MACAddrs, b.MACAddrs) {
			return IdentitySameHost
		}
	}
	return IdentityDifferent
}

func hasSharedMAC(a, b []string) bool {
	if len(a) == 0 || len(b) == 0 {
		return false
	}
	set := make(map[string]bool, len(a))
	for _, m := range a {
		set[strings.ToLower(strings.TrimSpace(m))] = true
	}
	for _, m := range b {
		if set[strings.ToLower(strings.TrimSpace(m))] {
			return true
		}
	}
	return false
}

func nodeIdentity(n *db.Node, p *sshx.ProbeResult) HostIdentity {
	if n == nil {
		return HostIdentity{}
	}
	id := HostIdentity{
		MachineID:          n.MachineID,
		HostKeyFingerprint: n.HostKeyFingerprint,
	}
	if p != nil {
		if p.MachineID != "" {
			id.MachineID = p.MachineID
		}
		id.ProductUUID = p.ProductUUID
		id.MACAddrs = p.MACAddrs
		return id
	}
	if n.ProbeJSON != "" && n.ProbeJSON != "{}" {
		var parsed sshx.ProbeResult
		if json.Unmarshal([]byte(n.ProbeJSON), &parsed) == nil {
			id.ProductUUID = parsed.ProductUUID
			id.MACAddrs = parsed.MACAddrs
		}
	}
	return id
}

// ---- SSH keys ----

// GenerateKey creates and stores a new Ed25519 key pair.
func (s *Service) GenerateKey(ctx context.Context, actor audit.Actor, name string) (*db.SSHKey, error) {
	if !reName.MatchString(name) {
		return nil, badRequest("密钥名称需为 1～63 位字母、数字、点、下划线或连字符")
	}
	pair, err := crypto.GenerateEd25519("nomad-deck")
	if err != nil {
		return nil, err
	}
	return s.storeKey(ctx, actor, name, "ed25519", pair.PublicKey, pair.PrivatePEM, pair.Fingerprint, "ssh_key.generate")
}

// ImportKey stores an existing unencrypted private key (OpenSSH or PEM).
func (s *Service) ImportKey(ctx context.Context, actor audit.Actor, name, privatePEM string) (*db.SSHKey, error) {
	if !reName.MatchString(name) {
		return nil, badRequest("密钥名称需为 1～63 位字母、数字、点、下划线或连字符")
	}
	signer, err := ssh.ParsePrivateKey([]byte(privatePEM))
	if err != nil {
		var pp *ssh.PassphraseMissingError
		if errors.As(err, &pp) {
			return nil, badRequest("请导入未设置口令的私钥")
		}
		return nil, badRequest("私钥格式无法识别")
	}
	pub := signer.PublicKey()
	algo := map[string]string{ssh.KeyAlgoED25519: "ed25519", ssh.KeyAlgoRSA: "rsa",
		ssh.KeyAlgoECDSA256: "ecdsa", ssh.KeyAlgoECDSA384: "ecdsa", ssh.KeyAlgoECDSA521: "ecdsa"}[pub.Type()]
	if algo == "" {
		return nil, badRequest("不支持的密钥类型 %s", pub.Type())
	}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub))) + " nomad-deck"
	return s.storeKey(ctx, actor, name, algo, line, []byte(privatePEM), ssh.FingerprintSHA256(pub), "ssh_key.import")
}

func (s *Service) storeKey(ctx context.Context, actor audit.Actor, name, algo, pub string, priv []byte, fp, action string) (*db.SSHKey, error) {
	id := db.NewID()
	enc, err := s.Keys.Encrypt(priv, db.SSHKeyAAD(id))
	if err != nil {
		return nil, err
	}
	now := s.DB.Now()
	k := &db.SSHKey{ID: id, Name: name, Algorithm: algo, PublicKey: pub, PrivateKeyEncrypted: enc, Fingerprint: fp, CreatedAt: now, UpdatedAt: now}
	err = s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		n, err := db.CountSSHKeys(ctx, tx)
		if err != nil {
			return err
		}
		k.IsDefault = n == 0
		if err := db.InsertSSHKey(ctx, tx, k); err != nil {
			if errors.Is(err, db.ErrUnique) {
				return conflict("name_taken", "密钥名称已存在")
			}
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: actor, Action: action, ResourceType: "ssh_key", ResourceID: id,
			ResourceName: name, Summary: map[string]any{"fingerprint": fp, "algorithm": algo}})
	})
	if err != nil {
		return nil, err
	}
	return k, nil
}

// SetDefaultKey marks a key as the default.
func (s *Service) SetDefaultKey(ctx context.Context, actor audit.Actor, id string) error {
	return s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		k, err := db.GetSSHKey(ctx, tx, id)
		if errors.Is(err, db.ErrNotFound) {
			return errNotFound
		}
		if err != nil {
			return err
		}
		if err := db.SetDefaultSSHKey(ctx, tx, id, s.DB.Now()); err != nil {
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: actor, Action: "ssh_key.set_default", ResourceType: "ssh_key",
			ResourceID: id, ResourceName: k.Name})
	})
}

// DeleteKey removes a key that no host references.
func (s *Service) DeleteKey(ctx context.Context, actor audit.Actor, id string) error {
	return s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		k, err := db.GetSSHKey(ctx, tx, id)
		if errors.Is(err, db.ErrNotFound) {
			return errNotFound
		}
		if err != nil {
			return err
		}
		n, err := db.CountNodesUsingKey(ctx, tx, id)
		if err != nil {
			return err
		}
		if n > 0 {
			return conflict("key_in_use", "该密钥仍被 %d 台主机使用，不能删除", n)
		}
		if err := db.DeleteSSHKey(ctx, tx, id); err != nil {
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: actor, Action: "ssh_key.delete", ResourceType: "ssh_key",
			ResourceID: id, ResourceName: k.Name})
	})
}

// ---- Hosts ----

// NodeInput is the editable part of a host.
type NodeInput struct {
	Name     string            `json:"name"`
	Host     string            `json:"host"`
	SSHPort  int               `json:"ssh_port"`
	SSHUser  string            `json:"ssh_user"`
	SSHKeyID string            `json:"ssh_key_id"`
	UseSudo  bool              `json:"use_sudo"`
	Labels   map[string]string `json:"labels"`
	Notes    string            `json:"notes"`
}

func (in *NodeInput) validate() error {
	if !reName.MatchString(in.Name) {
		return badRequest("主机名称需为 1～63 位字母、数字、点、下划线或连字符")
	}
	h := strings.TrimSpace(in.Host)
	if h == "" || strings.ContainsAny(h, " /@:") && net.ParseIP(h) == nil {
		return badRequest("主机地址不合法")
	}
	if in.SSHPort == 0 {
		in.SSHPort = 22
	}
	if in.SSHPort < 1 || in.SSHPort > 65535 {
		return badRequest("SSH 端口不合法")
	}
	if !reUser.MatchString(in.SSHUser) {
		return badRequest("SSH 用户名不合法")
	}
	if in.SSHUser != "root" && !in.UseSudo {
		return badRequest("非 root 用户必须启用 sudo")
	}
	if len(in.Notes) > 2000 {
		return badRequest("备注过长")
	}
	return nil
}

// CreateNode registers a host.
func (s *Service) CreateNode(ctx context.Context, actor audit.Actor, in NodeInput) (*db.Node, error) {
	if err := in.validate(); err != nil {
		return nil, err
	}
	labels, _ := json.Marshal(orEmpty(in.Labels))
	now := s.DB.Now()
	n := &db.Node{ID: db.NewID(), Name: in.Name, Host: strings.TrimSpace(in.Host), SSHPort: in.SSHPort, SSHUser: in.SSHUser,
		SSHKeyID: in.SSHKeyID, UseSudo: in.UseSudo, LabelsJSON: string(labels), Notes: in.Notes, CreatedAt: now, UpdatedAt: now}
	err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		if n.SSHKeyID == "" {
			k, err := db.GetDefaultSSHKey(ctx, tx)
			if err != nil {
				return badRequest("未指定 SSH 密钥且没有默认密钥")
			}
			n.SSHKeyID = k.ID
		} else if _, err := db.GetSSHKey(ctx, tx, n.SSHKeyID); err != nil {
			return badRequest("SSH 密钥不存在")
		}
		if err := db.InsertNode(ctx, tx, n); err != nil {
			if errors.Is(err, db.ErrUnique) {
				return conflict("name_taken", "主机名称已存在")
			}
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: actor, Action: "node.create", ResourceType: "node", ResourceID: n.ID,
			ResourceName: n.Name, Summary: map[string]any{"host": n.Host, "ssh_port": n.SSHPort, "ssh_user": n.SSHUser, "use_sudo": n.UseSudo}})
	})
	if err != nil {
		return nil, err
	}
	return db.GetNode(ctx, s.DB.Reader, n.ID)
}

// UpdateNode edits connection settings. Changing the address or port clears
// the pinned host key so the next connection re-pins it explicitly.
func (s *Service) UpdateNode(ctx context.Context, actor audit.Actor, id string, in NodeInput) (*db.Node, error) {
	if err := in.validate(); err != nil {
		return nil, err
	}
	err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		n, err := db.GetNode(ctx, tx, id)
		if errors.Is(err, db.ErrNotFound) {
			return errNotFound
		}
		if err != nil {
			return err
		}
		if in.SSHKeyID == "" {
			in.SSHKeyID = n.SSHKeyID
		} else if _, err := db.GetSSHKey(ctx, tx, in.SSHKeyID); err != nil {
			return badRequest("SSH 密钥不存在")
		}
		addrChanged := n.Host != strings.TrimSpace(in.Host) || n.SSHPort != in.SSHPort
		labels, _ := json.Marshal(orEmpty(in.Labels))
		n.Name, n.Host, n.SSHPort, n.SSHUser, n.SSHKeyID, n.UseSudo = in.Name, strings.TrimSpace(in.Host), in.SSHPort, in.SSHUser, in.SSHKeyID, in.UseSudo
		n.LabelsJSON, n.Notes = string(labels), in.Notes
		if err := db.UpdateNodeConnection(ctx, tx, n, s.DB.Now()); err != nil {
			if errors.Is(err, db.ErrUnique) {
				return conflict("name_taken", "主机名称已存在")
			}
			return err
		}
		if addrChanged && n.HostKeyFingerprint != "" {
			if err := db.UpdateNodeHostKey(ctx, tx, id, "", s.DB.Now()); err != nil {
				return err
			}
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: actor, Action: "node.update", ResourceType: "node", ResourceID: id,
			ResourceName: n.Name, Summary: map[string]any{"host": n.Host, "ssh_port": n.SSHPort, "ssh_user": n.SSHUser,
				"use_sudo": n.UseSudo, "host_key_reset": addrChanged}})
	})
	if err != nil {
		return nil, err
	}
	s.Pool.DropPrefix(id)
	return db.GetNode(ctx, s.DB.Reader, id)
}

// DeleteNode removes a host after verifying it no longer belongs to any cluster.
func (s *Service) DeleteNode(ctx context.Context, actor audit.Actor, id string) error {
	err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		n, err := db.GetNode(ctx, tx, id)
		if errors.Is(err, db.ErrNotFound) {
			return errNotFound
		}
		if err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT c.name, c.type FROM cluster_nodes cn JOIN clusters c ON c.id = cn.cluster_id WHERE cn.node_id = ? ORDER BY c.type, c.name`, id)
		if err != nil {
			return err
		}
		var refs []string
		for rows.Next() {
			var cname, ctype string
			if err := rows.Scan(&cname, &ctype); err != nil {
				_ = rows.Close()
				return err
			}
			refs = append(refs, fmt.Sprintf("%s(%s)", cname, ctype))
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		_ = rows.Close()
		if len(refs) > 0 {
			return conflict("node_in_cluster", "主机仍属于集群 %s，请先在对应集群中移出该节点（失联节点可使用强制移出，单节点集群请使用卸载清理）后再删除", strings.Join(refs, "、"))
		}
		if err := db.DeleteNode(ctx, tx, id); err != nil {
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: actor, Action: "node.delete", ResourceType: "node", ResourceID: id, ResourceName: n.Name})
	})
	if err == nil {
		s.Pool.DropPrefix(id)
	}
	return err
}

// SetAliases replaces the address aliases of a host.
func (s *Service) SetAliases(ctx context.Context, actor audit.Actor, id string, aliases []string) error {
	clean := []string{}
	for _, a := range aliases {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		if strings.ContainsAny(a, " /@") {
			return badRequest("地址别名 %q 不合法", a)
		}
		clean = append(clean, a)
	}
	b, _ := json.Marshal(clean)
	return s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		if err := db.UpdateNodeAliases(ctx, tx, id, string(b), s.DB.Now()); err != nil {
			if errors.Is(err, db.ErrNotFound) {
				return errNotFound
			}
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: actor, Action: "node.set_aliases", ResourceType: "node", ResourceID: id,
			Summary: map[string]any{"aliases": clean}})
	})
}

// ResetFingerprint clears the pinned host key (after a reinstall).
func (s *Service) ResetFingerprint(ctx context.Context, actor audit.Actor, id string) error {
	err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		n, err := db.GetNode(ctx, tx, id)
		if errors.Is(err, db.ErrNotFound) {
			return errNotFound
		}
		if err != nil {
			return err
		}
		if err := db.UpdateNodeHostKey(ctx, tx, id, "", s.DB.Now()); err != nil {
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: actor, Action: "node.reset_fingerprint", ResourceType: "node",
			ResourceID: id, ResourceName: n.Name, Summary: map[string]any{"previous_fingerprint": n.HostKeyFingerprint}})
	})
	if err == nil {
		s.Pool.DropPrefix(id)
	}
	return err
}

// target builds the SSH target of a host using its stored key.
func (s *Service) target(ctx context.Context, n *db.Node) (sshx.Target, error) {
	k, err := db.GetSSHKey(ctx, s.DB.Reader, n.SSHKeyID)
	if err != nil {
		return sshx.Target{}, fmt.Errorf("load ssh key: %w", err)
	}
	pem, err := s.Keys.Decrypt(k.PrivateKeyEncrypted, db.SSHKeyAAD(k.ID))
	if err != nil {
		return sshx.Target{}, fmt.Errorf("decrypt ssh key: %w", err)
	}
	signer, err := ssh.ParsePrivateKey(pem)
	if err != nil {
		return sshx.Target{}, fmt.Errorf("parse ssh key: %w", err)
	}
	timeout := time.Duration(db.IntSetting(ctx, s.DB.Reader, "ssh.timeout_sec", 15)) * time.Second
	return sshx.Target{Host: n.Host, Port: n.SSHPort, User: n.SSHUser, UseSudo: n.UseSudo, Signer: signer,
		HostKeyFingerprint: n.HostKeyFingerprint, Timeout: timeout}, nil
}

// Connect returns a pooled connection, pinning the host key on first use.
func (s *Service) Connect(ctx context.Context, n *db.Node) (*sshx.Client, error) {
	t, err := s.target(ctx, n)
	if err != nil {
		return nil, err
	}
	c, err := s.Pool.Get(ctx, n.ID+"|"+n.HostKeyFingerprint, t)
	if err != nil {
		var mm *sshx.ErrHostKeyMismatch
		if errors.As(err, &mm) {
			return nil, conflict("host_key_mismatch", "主机指纹与已信任的指纹不一致（期望 %s，实际 %s）。如主机已重装，请确认后重置指纹", mm.Expected, mm.Actual)
		}
		return nil, err
	}
	if n.HostKeyFingerprint == "" && c.HostKeyFingerprint != "" {
		if err := db.UpdateNodeHostKey(ctx, s.DB.Writer, n.ID, c.HostKeyFingerprint, s.DB.Now()); err != nil {
			return nil, err
		}
		s.Pool.Rekey(n.ID+"|", n.ID+"|"+c.HostKeyFingerprint, c)
		n.HostKeyFingerprint = c.HostKeyFingerprint
	}
	return c, nil
}

// PushKey installs the host's configured public key using a one-time
// password. The password is used only in memory and never stored or audited.
func (s *Service) PushKey(ctx context.Context, actor audit.Actor, id, password string) error {
	n, err := db.GetNode(ctx, s.DB.Reader, id)
	if errors.Is(err, db.ErrNotFound) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if password == "" {
		return badRequest("请输入目标主机的 SSH 密码")
	}
	k, err := db.GetSSHKey(ctx, s.DB.Reader, n.SSHKeyID)
	if err != nil {
		return err
	}
	timeout := time.Duration(db.IntSetting(ctx, s.DB.Reader, "ssh.timeout_sec", 15)) * time.Second
	fp, err := sshx.PushKey(ctx, sshx.Target{Host: n.Host, Port: n.SSHPort, User: n.SSHUser, Password: password,
		HostKeyFingerprint: n.HostKeyFingerprint, Timeout: timeout}, k.PublicKey)
	ev := audit.Event{Actor: actor, Action: "node.push_key", ResourceType: "node", ResourceID: id, ResourceName: n.Name,
		Summary: map[string]any{"key_fingerprint": k.Fingerprint}, Err: err}
	if err == nil && n.HostKeyFingerprint == "" && fp != "" {
		_ = db.UpdateNodeHostKey(ctx, s.DB.Writer, id, fp, s.DB.Now())
	}
	_ = s.Audit.Record(ctx, nil, ev)
	if err != nil {
		return formatPushKeyError(err)
	}
	return nil
}

func formatPushKeyError(err error) error {
	var mm *sshx.ErrHostKeyMismatch
	if errors.As(err, &mm) {
		return conflict("host_key_mismatch", "主机指纹与已信任的指纹不一致")
	}
	if strings.Contains(err.Error(), "unable to authenticate") {
		return &auth.Error{
			Status:  502,
			Code:    "push_key_failed",
			Message: "推送公钥失败：SSH 密码认证被拒绝（请确认密码正确且目标主机允许密码登录；若无密码，请改用手动配置公钥）：" + err.Error(),
		}
	}
	return &auth.Error{Status: 502, Code: "push_key_failed", Message: "推送公钥失败：" + err.Error()}
}

// TestResult is returned by Test.
type TestResult struct {
	Node       *db.Node          `json:"-"`
	Probe      *sshx.ProbeResult `json:"probe"`
	Warnings   []string          `json:"warnings"`
	ClonePeers []string          `json:"clone_peers,omitempty"`
}

// ResetMachineID regenerates /etc/machine-id on a cloned host and re-probes it.
func (s *Service) ResetMachineID(ctx context.Context, actor audit.Actor, id string) (*TestResult, error) {
	n, err := db.GetNode(ctx, s.DB.Reader, id)
	if errors.Is(err, db.ErrNotFound) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if s.IsControlPlaneHost(n) {
		return nil, conflict("control_plane_host", "当前主机与 NomadDeck 控制面同机，不支持在控制面内自动重置 /etc/machine-id")
	}
	if n.SSHUser != "root" && !n.UseSudo {
		return nil, badRequest("非 root 用户需启用免密 sudo 才能重置 /etc/machine-id")
	}
	rctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	c, err := s.Connect(rctx, n)
	if err != nil {
		var ae *auth.Error
		if errors.As(err, &ae) {
			return nil, err
		}
		return nil, &auth.Error{Status: 502, Code: "ssh_failed", Message: "SSH 连接失败：" + err.Error()}
	}
	prevID := n.MachineID
	newID, err := sshx.ResetMachineID(rctx, c)
	_ = s.Audit.Record(ctx, nil, audit.Event{
		Actor: actor, Action: "node.reset_machine_id", ResourceType: "node", ResourceID: id,
		ResourceName: n.Name,
		Summary:      map[string]any{"previous_machine_id": prevID, "new_machine_id": newID},
		Err:          err,
	})
	if err != nil {
		return nil, &auth.Error{Status: 502, Code: "reset_machine_id_failed", Message: "重新生成 /etc/machine-id 失败：" + err.Error()}
	}
	return s.probe(ctx, n)
}

// Test connects to a host, probes its environment and stores the results.
func (s *Service) Test(ctx context.Context, actor audit.Actor, id string) (*TestResult, error) {
	n, err := db.GetNode(ctx, s.DB.Reader, id)
	if errors.Is(err, db.ErrNotFound) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	res, err := s.probe(ctx, n)
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "node.test", ResourceType: "node", ResourceID: id,
		ResourceName: n.Name, Err: err})
	return res, err
}

func (s *Service) probe(ctx context.Context, n *db.Node) (*TestResult, error) {
	pctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	c, err := s.Connect(pctx, n)
	if err != nil {
		_ = db.UpdateNodeStatus(ctx, s.DB.Writer, n.ID, "offline", s.DB.Now())
		var ae *auth.Error
		if errors.As(err, &ae) {
			return nil, err
		}
		return nil, &auth.Error{Status: 502, Code: "ssh_failed", Message: "SSH 连接失败：" + err.Error()}
	}
	p, err := sshx.Probe(pctx, c)
	if err != nil {
		s.Pool.DropPrefix(n.ID)
		_ = db.UpdateNodeStatus(ctx, s.DB.Writer, n.ID, "offline", s.DB.Now())
		return nil, &auth.Error{Status: 502, Code: "probe_failed", Message: "环境探测失败：" + err.Error()}
	}
	clonePeers, dupPeer, err := s.classifyExistingPeers(ctx, n, p)
	if err != nil {
		return nil, err
	}
	if dupPeer != "" {
		return nil, conflict("duplicate_host", "该主机已以“%s”登记。请为已有主机添加地址别名，而不是重复登记", dupPeer)
	}
	applyProbe(n, p)
	if err := db.UpdateNodeProbe(ctx, s.DB.Writer, n, s.DB.Now()); err != nil {
		return nil, err
	}
	return &TestResult{
		Node:       n,
		Probe:      p,
		Warnings:   WarningsForHostWithRuntime(n, p, s.IsControlPlaneHost(n), s.IsControlPlaneInDocker(), clonePeers),
		ClonePeers: clonePeers,
	}, nil
}

func (s *Service) classifyExistingPeers(ctx context.Context, n *db.Node, p *sshx.ProbeResult) (clonePeers []string, dupPeer string, err error) {
	if s == nil || s.DB == nil || s.DB.Reader == nil {
		return nil, "", nil
	}
	nodes, err := db.ListNodes(ctx, s.DB.Reader)
	if err != nil {
		return nil, "", err
	}
	curID := nodeIdentity(n, p)
	for _, other := range nodes {
		if other.ID == n.ID {
			continue
		}
		if other.LastCheckedAt.IsZero() && other.MachineID == "" && other.HostKeyFingerprint == "" {
			continue
		}
		switch CompareHostIdentity(curID, nodeIdentity(other, nil)) {
		case IdentitySameHost:
			return nil, other.Name, nil
		case IdentityClone:
			clonePeers = append(clonePeers, other.Name)
		}
	}
	return clonePeers, "", nil
}

// WarningsForNode computes preflight warnings for a node, including clone machine-id notices.
func (s *Service) WarningsForNode(ctx context.Context, n *db.Node, p *sshx.ProbeResult) []string {
	warnings, _ := s.WarningsForNodeWithClones(ctx, n, p)
	return warnings
}

// WarningsForNodeWithClones computes preflight warnings and clone peer names for a node.
func (s *Service) WarningsForNodeWithClones(ctx context.Context, n *db.Node, p *sshx.ProbeResult) ([]string, []string) {
	clonePeers, _, err := s.classifyExistingPeers(ctx, n, p)
	if err != nil {
		clonePeers = nil
	}
	return WarningsForHostWithRuntime(n, p, s.IsControlPlaneHost(n), s.IsControlPlaneInDocker(), clonePeers), clonePeers
}

// IsControlPlaneInDocker reports whether the control plane is running inside a
// Docker container.
func (s *Service) IsControlPlaneInDocker() bool {
	return s != nil && s.ControlPlaneInDocker
}

// IsControlPlaneHost reports whether n refers to the same host as the
// NomadDeck control plane host.
func (s *Service) IsControlPlaneHost(n *db.Node) bool {
	if s == nil || n == nil {
		return false
	}
	local := s.localIdentity()
	if local.MachineID == "" && local.ProductUUID == "" && len(local.MACAddrs) == 0 {
		return false
	}
	return CompareHostIdentity(nodeIdentity(n, nil), local) == IdentitySameHost
}

func applyProbe(n *db.Node, p *sshx.ProbeResult) {
	n.SudoReady, n.SELinuxMode, n.SwapEnabled = p.SudoReady, p.SELinux, p.SwapEnabled
	n.OSFamily, n.OSCodename, n.PackageManager = p.OSFamily, p.OSCodename, p.PackageManager
	n.DockerMode, n.DockerStatus, n.DockerVersion = p.DockerMode, p.DockerStatus, p.DockerVersion
	n.MachineID, n.TimeSync, n.ClockSkewMS = p.MachineID, p.TimeSync, p.ClockSkewMS
	n.OSInfo, n.Arch, n.Status = p.OSInfo, p.Arch, "online"
	n.CPUCores, n.CPUPercent = p.CPUCores, p.CPUPercent
	n.MemTotalBytes, n.MemUsedBytes, n.MemPercent = p.MemTotalBytes, p.MemUsedBytes, p.MemPercent
	b, _ := json.Marshal(p)
	n.ProbeJSON = string(b)
}

// MaxClockSkew is the tolerated clock difference with the control plane.
const MaxClockSkew = 30 * time.Second

// Warnings lists preflight problems found by a probe.
func Warnings(n *db.Node, p *sshx.ProbeResult) []string {
	return WarningsForHost(n, p, false)
}

// WarningsForHost lists preflight problems and co-location cautions found by a probe.
func WarningsForHost(n *db.Node, p *sshx.ProbeResult, isControlPlaneHost bool) []string {
	return WarningsForHostWithClones(n, p, isControlPlaneHost, nil)
}

// WarningsForHostWithClones lists preflight problems, co-location cautions, and
// non-blocking notices when cloned VMs share /etc/machine-id.
func WarningsForHostWithClones(n *db.Node, p *sshx.ProbeResult, isControlPlaneHost bool, clonePeers []string) []string {
	return WarningsForHostWithRuntime(n, p, isControlPlaneHost, false, clonePeers)
}

// WarningsForHostWithRuntime lists preflight problems, co-location cautions
// tailored to whether the control plane runs inside Docker, and clone notices.
func WarningsForHostWithRuntime(n *db.Node, p *sshx.ProbeResult, isControlPlaneHost, controlPlaneInDocker bool, clonePeers []string) []string {
	var w []string
	if len(clonePeers) > 0 {
		w = append(w, fmt.Sprintf("检测到该主机与「%s」共用相同的 /etc/machine-id（疑似克隆虚拟机），已允许接入；建议按需在目标机执行 sudo rm -f /etc/machine-id /var/lib/dbus/machine-id && sudo systemd-machine-id-setup 重新生成，以免影响 DHCP 或系统日志", strings.Join(clonePeers, "、")))
	}
	if isControlPlaneHost {
		if controlPlaneInDocker {
			w = append(w, "该主机与 NomadDeck 控制面同机，且当前控制面运行在 Docker 容器中：请勿在本页重启或重装该主机 Docker，否则会中断控制面服务；组建多节点集群时，请将该节点的集群通信地址（advertise_addr）填写真实内网 IP 而非 127.0.0.1")
		} else {
			w = append(w, "该主机与 NomadDeck 控制面同机：组建多节点集群时，请将该节点的集群通信地址（advertise_addr）填写真实内网 IP 而非 127.0.0.1")
		}
	}
	if n != nil && (n.Host == "127.0.0.1" || strings.EqualFold(n.Host, "localhost") || n.Host == "::1") {
		w = append(w, "当前主机 SSH 地址为回环地址，组建跨机集群时请将该节点的集群通信地址（advertise_addr）设为真实内网 IP")
	}
	if !p.SudoReady {
		w = append(w, "当前用户没有免密 sudo 权限，请在 sudoers 中为该用户配置 NOPASSWD")
	}
	if len(p.Missing) > 0 {
		w = append(w, "缺少必要命令："+strings.Join(p.Missing, "、"))
	}
	if p.Arch != "amd64" && p.Arch != "arm64" {
		w = append(w, "不支持的 CPU 架构："+p.Arch)
	}
	if p.TimeSync != "synced" {
		w = append(w, "时间同步未启用或未同步，请启用 systemd-timesyncd 或 chrony")
	}
	if abs(p.ClockSkewMS) > MaxClockSkew.Milliseconds() {
		w = append(w, fmt.Sprintf("与控制面的时钟偏差 %d 毫秒，超过 30 秒", p.ClockSkewMS))
	}
	if p.SELinux == "enforcing" {
		w = append(w, "SELinux 处于 enforcing，部署前需确认相关上下文标签与端口策略")
	}
	if p.SwapEnabled && !p.SwapEncrypted {
		w = append(w, "已启用未加密的 Swap（仅部署 Vault 时涉及，只跑 Nomad 可忽略）：部署 Vault 前建议禁用或改为加密 Swap")
	}
	if !p.OptWritable {
		w = append(w, "/opt/nomad-deck 不可写（需要 root 或免密 sudo）")
	}
	return w
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

func orEmpty(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

var reUnsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// InstallArtifact relays a verified artifact to a host and installs it as
// root at dest (decompressing and verifying SHA-256 on the host).
func (s *Service) InstallArtifact(ctx context.Context, c *sshx.Client, opID string, a *release.Artifact, dest, mode string, rateLimit int64) error {
	f, err := os.Open(a.GzipPath)
	if err != nil {
		return err
	}
	defer f.Close()
	// Staging names must be plain identifiers; package file names carry
	// characters such as "+" and "~".
	name := reUnsafeName.ReplaceAllString(a.PayloadName, "_")
	if a.Gzipped {
		name += ".gz"
	}
	release, err := s.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer release()
	return sshx.Install(ctx, c, sshx.InstallSpec{OpID: opID, Name: name, Source: f, Gzipped: a.Gzipped,
		SHA256: a.PayloadSHA256, Dest: dest, Mode: mode, RateLimit: rateLimit})
}

// Ping checks SSH reachability, collects CPU/memory utilization, and records
// the node's status as online or offline.
func (s *Service) Ping(ctx context.Context, n *db.Node) error {
	pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	c, err := s.Connect(pctx, n)
	var metrics *sshx.NodeMetrics
	if err == nil {
		metrics, err = sshx.CollectMetrics(pctx, c)
		if err != nil {
			s.Pool.DropPrefix(n.ID)
		}
	}
	if err != nil {
		_ = db.UpdateNodeStatus(ctx, s.DB.Writer, n.ID, "offline", s.DB.Now())
		return err
	}
	_ = db.UpdateNodeMetrics(ctx, s.DB.Writer, n.ID, "online",
		metrics.CPUCores, metrics.CPUPercent, metrics.MemTotalBytes, metrics.MemUsedBytes, metrics.MemPercent, s.DB.Now())
	return nil
}

// RefreshNodeMetrics collects live CPU and memory metrics for a single host.
func (s *Service) RefreshNodeMetrics(ctx context.Context, id string) (*db.Node, error) {
	n, err := db.GetNode(ctx, s.DB.Reader, id)
	if errors.Is(err, db.ErrNotFound) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := s.Ping(ctx, n); err != nil {
		return nil, &auth.Error{Status: 502, Code: "ssh_failed", Message: "采集主机负载失败：" + err.Error()}
	}
	return db.GetNode(ctx, s.DB.Reader, id)
}

// RefreshAllMetrics refreshes CPU and memory metrics across all registered hosts.
func (s *Service) RefreshAllMetrics(ctx context.Context) (int, int, error) {
	nodes, err := db.ListNodes(ctx, s.DB.Reader)
	if err != nil {
		return 0, 0, err
	}
	var okCount, failCount int
	for _, n := range nodes {
		if err := s.Ping(ctx, n); err != nil {
			failCount++
		} else {
			okCount++
		}
	}
	return okCount, failCount, nil
}
