package vault

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"nomad-deck/internal/db"
	"nomad-deck/internal/pki"
	"nomad-deck/internal/release"
	"nomad-deck/internal/sshx"
)

// Check is one Doctor finding.
type Check struct {
	Node    string `json:"node,omitempty"`
	Name    string `json:"name"`
	Status  string `json:"status"` // OK | WARN | FAIL
	Message string `json:"message"`
	Hint    string `json:"hint,omitempty"`
}

// DoctorReport is the result of a Doctor run.
type DoctorReport struct {
	Cluster string    `json:"cluster"`
	RanAt   time.Time `json:"ran_at"`
	Summary string    `json:"summary"`
	Checks  []Check   `json:"checks"`
}

const doctorScript = `printf 'active=%s\n' "$(systemctl is-active vault.service 2>/dev/null)"
printf 'user=%s\n' "$(systemctl show vault.service -p User --value 2>/dev/null)"
printf 'limitcore=%s\n' "$(systemctl show vault.service -p LimitCORE --value 2>/dev/null)"
printf 'binary=%s\n' "$(readlink -f ` + BinLink + ` 2>/dev/null)"
printf 'version=%s\n' "$(` + BinLink + ` version 2>/dev/null | head -1)"
printf 'config=%s\n' "$(readlink ` + ConfigLink + ` 2>/dev/null)"
if [ -f ` + ConfigLink + `/config.hcl ]; then printf 'config_ok=1\n'; else printf 'config_ok=0\n'; fi
printf 'swap=%s\n' "$(awk 'NR>1' /proc/swaps 2>/dev/null | wc -l | tr -d ' ')"
printf 'logs_use=%s\n' "$(df -P ` + LogDir + ` 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $5}')"
printf 'unit_managed=%s\n' "$(head -1 ` + UnitFile + ` 2>/dev/null)"
`

// Doctor checks hosts, services, configuration, TLS, API, Raft and custody.
func (s *Service) Doctor(ctx context.Context, clusterID string) (*DoctorReport, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	rep := &DoctorReport{Cluster: cl.Name, RanAt: time.Now().UTC(), Checks: []Check{}}
	add := func(node, name, status, msg, hint string) {
		rep.Checks = append(rep.Checks, Check{Node: node, Name: name, Status: status, Message: msg, Hint: hint})
	}
	now := time.Now()
	for _, m := range members {
		name := m.NodeName
		// Host and service over SSH.
		func() {
			sctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			_, c, err := s.connect(sctx, m)
			if err != nil {
				add(name, "ssh", "FAIL", err.Error(), "检查主机网络与 SSH 凭据")
				return
			}
			r, err := c.Run(sctx, doctorScript, sshx.RunOptions{Sudo: true})
			if err != nil {
				add(name, "ssh", "FAIL", err.Error(), "")
				return
			}
			kv := map[string]string{}
			for _, line := range strings.Split(string(r.Stdout), "\n") {
				if k, v, ok := strings.Cut(line, "="); ok {
					kv[k] = strings.TrimSpace(v)
				}
			}
			if kv["active"] == "active" {
				add(name, "service", "OK", "vault.service 运行中", "")
			} else {
				add(name, "service", "FAIL", "vault.service 状态为 "+kv["active"], "查看节点日志并启动服务")
			}
			if kv["user"] == "vault" {
				add(name, "run_user", "OK", "以 vault 用户运行", "")
			} else {
				add(name, "run_user", "FAIL", "运行用户为 "+kv["user"], "重新部署以恢复托管的 systemd 单元")
			}
			if kv["limitcore"] == "0" {
				add(name, "core_dump", "OK", "LimitCORE=0", "")
			} else {
				add(name, "core_dump", "FAIL", "未禁用 core dump（LimitCORE="+kv["limitcore"]+"）", "")
			}
			if !strings.HasPrefix(kv["unit_managed"], ManagedMark) {
				add(name, "unit", "WARN", "systemd 单元不是 NomadDeck 托管版本", "")
			}
			wantBin := VersionBinary(m.InstalledVersion)
			switch {
			case IsEnterprise(kv["version"]):
				add(name, "edition", "FAIL", "检测到 Vault Enterprise："+kv["version"], "NomadDeck 只支持 Community 版")
			case kv["binary"] != wantBin:
				add(name, "binary", "WARN", fmt.Sprintf("当前二进制 %s 与登记版本 %s 不一致", kv["binary"], m.InstalledVersion), "")
			default:
				add(name, "binary", "OK", kv["version"], "")
			}
			gen := memberConfig(m).ConfigGeneration
			if kv["config"] == "releases/"+strconv.Itoa(gen) && kv["config_ok"] == "1" {
				add(name, "config_generation", "OK", fmt.Sprintf("配置代际 %d 生效且完整", gen), "")
			} else {
				add(name, "config_generation", "FAIL", fmt.Sprintf("vault.d 指向 %q，登记代际为 %d", kv["config"], gen), "重新下发配置")
			}
			if kv["swap"] != "" && kv["swap"] != "0" {
				add(name, "swap", "WARN", "主机启用了 Swap", "Vault 使用 disable_mlock，建议禁用 Swap 或使用加密 Swap")
			}
			if use, err := strconv.Atoi(kv["logs_use"]); err == nil {
				switch {
				case use >= 95:
					add(name, "audit_disk", "FAIL", fmt.Sprintf("审计日志分区使用率 %d%%", use), "审计设备写满会使 Vault 拒绝请求，请立即清理或扩容")
				case use >= 80:
					add(name, "audit_disk", "WARN", fmt.Sprintf("审计日志分区使用率 %d%%", use), "")
				default:
					add(name, "audit_disk", "OK", fmt.Sprintf("审计日志分区使用率 %d%%", use), "")
				}
			}
		}()
		// TLS certificate.
		if cl.TLSEnabled {
			switch left := m.CertExpiresAt.Sub(now); {
			case m.CertExpiresAt.IsZero():
				add(name, "tls_cert", "WARN", "没有证书到期记录", "")
			case left <= 0:
				add(name, "tls_cert", "FAIL", "节点证书已过期", "执行证书续期")
			case left < 30*24*time.Hour:
				add(name, "tls_cert", "WARN", fmt.Sprintf("节点证书将在 %d 天后到期", int(left.Hours()/24)), "执行证书续期")
			default:
				add(name, "tls_cert", "OK", "证书有效至 "+m.CertExpiresAt.UTC().Format("2006-01-02"), "")
			}
		}
		// API.
		c, err := s.client(cl, m, "")
		var h *Health
		if err == nil {
			h, err = c.Health(ctx)
		}
		switch {
		case err != nil:
			add(name, "api", "FAIL", "API 不可达："+err.Error(), "")
		case !h.Initialized:
			add(name, "api", "WARN", "节点未初始化", "")
		case h.Sealed:
			add(name, "api", "FAIL", "节点处于密封状态", "解封节点")
		default:
			role := "standby"
			if !h.Standby {
				role = "active"
			}
			add(name, "api", "OK", "已解封（"+role+"），版本 "+h.Version, "")
			if h.Enterprise || IsEnterprise(h.Version) {
				add(name, "edition", "FAIL", "节点运行 Vault Enterprise", "")
			} else if release.CompareVersions(h.Version, release.MinVersions["vault"]) < 0 {
				add(name, "version", "FAIL", "版本低于支持下限 "+release.MinVersions["vault"], "")
			}
		}
	}
	// Cluster-level checks.
	if cl.TLSEnabled {
		if exp, err := pki.EarliestExpiry(cl.CACertPEM); err == nil {
			if left := exp.Sub(now); left < 90*24*time.Hour {
				add("", "ca", "WARN", fmt.Sprintf("集群 CA 将在 %d 天后到期", int(left.Hours()/24)), "执行 CA 轮换")
			} else {
				add("", "ca", "OK", "CA 有效至 "+exp.UTC().Format("2006-01-02"), "")
			}
		}
	}
	if cl.InitState == db.InitInitialized {
		admin, _, err := s.adminClient(ctx, cl)
		if err != nil {
			add("", "admin_token", "FAIL", err.Error(), "")
		} else if info, err := admin.LookupSelf(ctx); err != nil {
			add("", "admin_token", "FAIL", "运维 Token 不可用："+err.Error(), "使用应急恢复重新签发")
		} else {
			ttl := time.Duration(info.TTL) * time.Second
			if ttl < 24*time.Hour {
				add("", "admin_token", "WARN", fmt.Sprintf("运维 Token 剩余 %s", ttl.Round(time.Minute)), "检查自动续租任务")
			} else {
				add("", "admin_token", "OK", fmt.Sprintf("运维 Token 有效（剩余 %s，orphan=%v）", ttl.Round(time.Hour), info.Orphan), "")
			}
			if ap, err := admin.AutopilotState(ctx); err != nil {
				add("", "raft", "FAIL", "无法读取 Autopilot 状态："+err.Error(), "")
			} else {
				status := "OK"
				if !ap.Healthy || (len(members) > 1 && ap.FailureTolerance < 1) {
					status = "WARN"
				}
				add("", "raft", status, fmt.Sprintf("Raft %d 个投票成员，健康=%v，可容忍故障数 %d", len(ap.Voters), ap.Healthy, ap.FailureTolerance), "")
			}
			if devs, err := admin.ListAudit(ctx); err == nil {
				if _, ok := devs[AuditDeviceName+"/"]; ok {
					add("", "audit_device", "OK", fmt.Sprintf("已启用 %d 个审计设备", len(devs)), "")
				} else {
					add("", "audit_device", "FAIL", "托管的文件审计设备未启用", "")
				}
			}
		}
		gens, _ := db.ListKeyGenerations(ctx, s.DB.Reader, clusterID)
		if p := pendingGeneration(gens); p != nil {
			add("", "rekey", "WARN", fmt.Sprintf("第 %d 代密钥处于 %s", p.Generation, p.State), "重新发起 Rekey 以续做或核对")
		}
		cu, _ := db.GetCustody(ctx, s.DB.Reader, clusterID)
		if cu != nil && cu.UnsealSuppressedReason != "" {
			add("", "auto_unseal", "WARN", "自动解封被抑制："+cu.UnsealSuppressedReason, "确认安全后解除抑制")
		}
	} else {
		add("", "init", "WARN", "集群初始化状态："+cl.InitState, "")
	}
	ok, warn, fail := 0, 0, 0
	for _, c := range rep.Checks {
		switch c.Status {
		case "OK":
			ok++
		case "WARN":
			warn++
		default:
			fail++
		}
	}
	rep.Summary = fmt.Sprintf("%d OK / %d WARN / %d FAIL", ok, warn, fail)
	return rep, nil
}
