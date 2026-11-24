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

// Service implements host and SSH key management.
type Service struct {
	DB    *db.DB
	Keys  *crypto.Keyring
	Audit *audit.Recorder
	Pool  *sshx.Pool
	// LocalMachineID is the control plane's own /etc/machine-id (may be empty).
	LocalMachineID string
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

// DeleteNode removes a host. (Cluster membership checks are added with clusters.)
func (s *Service) DeleteNode(ctx context.Context, actor audit.Actor, id string) error {
	err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		n, err := db.GetNode(ctx, tx, id)
		if errors.Is(err, db.ErrNotFound) {
			return errNotFound
		}
		if err != nil {
			return err
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
		var mm *sshx.ErrHostKeyMismatch
		if errors.As(err, &mm) {
			return conflict("host_key_mismatch", "主机指纹与已信任的指纹不一致")
		}
		return &auth.Error{Status: 502, Code: "push_key_failed", Message: "推送公钥失败：" + err.Error()}
	}
	return nil
}

// TestResult is returned by Test.
type TestResult struct {
	Node     *db.Node          `json:"-"`
	Probe    *sshx.ProbeResult `json:"probe"`
	Warnings []string          `json:"warnings"`
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
	if p.MachineID != "" && s.LocalMachineID != "" && p.MachineID == s.LocalMachineID {
		return nil, conflict("control_plane_host", "该主机是 NomadDeck 控制面宿主机本身，不能纳管为集群节点")
	}
	if p.MachineID != "" {
		if other, err := db.GetNodeByMachineID(ctx, s.DB.Reader, p.MachineID); err == nil && other.ID != n.ID {
			return nil, conflict("duplicate_host", "该主机已以“%s”登记（machine-id 相同）。请为已有主机添加地址别名，而不是重复登记；若为克隆虚拟机，请重新生成 /etc/machine-id", other.Name)
		}
	}
	applyProbe(n, p)
	if err := db.UpdateNodeProbe(ctx, s.DB.Writer, n, s.DB.Now()); err != nil {
		if errors.Is(err, db.ErrUnique) {
			return nil, conflict("duplicate_host", "machine-id 与已登记主机重复")
		}
		return nil, err
	}
	return &TestResult{Node: n, Probe: p, Warnings: Warnings(n, p)}, nil
}

func applyProbe(n *db.Node, p *sshx.ProbeResult) {
	n.SudoReady, n.SELinuxMode, n.SwapEnabled = p.SudoReady, p.SELinux, p.SwapEnabled
	n.OSFamily, n.OSCodename, n.PackageManager = p.OSFamily, p.OSCodename, p.PackageManager
	n.DockerMode, n.DockerStatus, n.DockerVersion = p.DockerMode, p.DockerStatus, p.DockerVersion
	n.MachineID, n.TimeSync, n.ClockSkewMS = p.MachineID, p.TimeSync, p.ClockSkewMS
	n.OSInfo, n.Arch, n.Status = p.OSInfo, p.Arch, "online"
	b, _ := json.Marshal(p)
	n.ProbeJSON = string(b)
}

// MaxClockSkew is the tolerated clock difference with the control plane.
const MaxClockSkew = 30 * time.Second

// Warnings lists preflight problems found by a probe.
func Warnings(n *db.Node, p *sshx.ProbeResult) []string {
	var w []string
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
		w = append(w, "已启用未加密的 Swap：部署 Vault 前需禁用或改为加密 Swap")
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
