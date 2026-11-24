package nomad

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"nomad-deck/internal/cluster"
	"nomad-deck/internal/db"
	"nomad-deck/internal/pki"
	"nomad-deck/internal/release"
	"nomad-deck/internal/sshx"
)

const doctorScript = `printf 'active=%s\n' "$(systemctl is-active nomad.service 2>/dev/null)"
printf 'user=%s\n' "$(systemctl show nomad.service -p User --value 2>/dev/null)"
printf 'binary=%s\n' "$(readlink -f ` + BinLink + ` 2>/dev/null)"
printf 'version=%s\n' "$(` + BinLink + ` version 2>/dev/null | head -1)"
printf 'config=%s\n' "$(readlink ` + ConfigLink + ` 2>/dev/null)"
if ` + BinLink + ` config validate ` + ConfigLink + `/ >/dev/null 2>&1; then printf 'validate=ok\n'; else printf 'validate=fail\n'; fi
printf 'unit_managed=%s\n' "$(head -1 ` + UnitFile + ` 2>/dev/null)"
printf 'data_use=%s\n' "$(df -P ` + DataDir + ` 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $5}')"
if [ -x ` + CNIBinDir + `/bridge ]; then printf 'cni=1\n'; else printf 'cni=0\n'; fi
`

// Doctor checks hosts, services, run users, binaries, configuration
// generations, TLS, the API, Raft health, clients and drivers.
func (s *Service) Doctor(ctx context.Context, clusterID string) (*cluster.DoctorReport, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	rep := &cluster.DoctorReport{Cluster: cl.Name, RanAt: time.Now().UTC(), Checks: []cluster.Check{}}
	add := func(node, name, status, msg, hint string) {
		rep.Checks = append(rep.Checks, cluster.Check{Node: node, Name: name, Status: status, Message: msg, Hint: hint})
	}
	now := time.Now()
	var nodes []NodeStub
	var raft []RaftServer
	var ap *AutopilotHealth
	if cl.InitState == db.InitInitialized {
		api, _, err := s.apiClient(ctx, cl, "")
		if err != nil {
			add("", "api", "FAIL", err.Error(), "检查 Server 状态与 Management Token")
		} else {
			if tok, err := api.TokenSelf(ctx); err != nil || tok.Type != "management" {
				add("", "management_token", "FAIL", fmt.Sprintf("Management Token 不可用：%v", err), "通过凭据补录提供有效 Token")
			} else {
				add("", "management_token", "OK", "Management Token 有效", "")
			}
			raft, _ = api.RaftConfiguration(ctx)
			if ap, err = api.Autopilot(ctx); err != nil {
				add("", "raft", "FAIL", "无法读取 Autopilot 健康状态："+err.Error(), "")
			} else {
				status := "OK"
				if !ap.Healthy || (len(servers(members)) > 1 && ap.FailureTolerance < 1) {
					status = "WARN"
				}
				add("", "raft", status, fmt.Sprintf("Raft %d 台 Server，健康=%v，可容忍故障数 %d", len(ap.Servers), ap.Healthy, ap.FailureTolerance), "")
			}
			nodes, _ = api.Nodes(ctx)
		}
	} else {
		add("", "init", "WARN", "集群初始化状态："+cl.InitState, "")
	}
	versions := map[string]bool{}
	for _, m := range members {
		name := m.NodeName
		mc := memberConfig(m)
		func() {
			sctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			_, c, err := s.remote().Connect(sctx, m.NodeID)
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
				add(name, "service", "OK", "nomad.service 运行中", "")
			} else {
				add(name, "service", "FAIL", "nomad.service 状态为 "+kv["active"], "查看节点日志并启动服务")
			}
			if want := RunUser(m.Role); kv["user"] == want {
				add(name, "run_user", "OK", fmt.Sprintf("以 %s 用户运行（角色 %s）", want, m.Role), "")
			} else {
				add(name, "run_user", "FAIL", fmt.Sprintf("运行用户为 %q，角色 %s 应为 %s", kv["user"], m.Role, want), "重新部署以恢复托管的 systemd 单元")
			}
			if !strings.HasPrefix(kv["unit_managed"], ManagedMark) {
				add(name, "unit", "WARN", "systemd 单元不是 NomadDeck 托管版本", "")
			}
			if kv["binary"] == VersionBinary(m.InstalledVersion) {
				add(name, "binary", "OK", kv["version"], "")
			} else {
				add(name, "binary", "WARN", fmt.Sprintf("当前二进制 %s 与登记版本 %s 不一致", kv["binary"], m.InstalledVersion), "")
			}
			gen := mc.ConfigGeneration
			switch {
			case kv["config"] != "releases/"+strconv.Itoa(gen):
				add(name, "config_generation", "FAIL", fmt.Sprintf("nomad.d 指向 %q，登记代际为 %d", kv["config"], gen), "重新下发配置或切回登记代际")
			case kv["validate"] != "ok":
				add(name, "config_generation", "FAIL", fmt.Sprintf("配置代际 %d 未通过 nomad config validate", gen), "")
			default:
				add(name, "config_generation", "OK", fmt.Sprintf("配置代际 %d 生效且通过校验", gen), "")
			}
			if IsClient(m.Role) && mc.CNI && kv["cni"] != "1" {
				add(name, "cni", "FAIL", "已启用 CNI 但缺少 CNI 插件", "更新节点配置以重新安装 CNI")
			}
			if use, err := strconv.Atoi(kv["data_use"]); err == nil && use >= 85 {
				add(name, "data_disk", "WARN", fmt.Sprintf("数据目录分区使用率 %d%%", use), "清理或扩容")
			}
		}()
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
		tok, _ := s.managementToken(cl)
		if c, err := s.client(cl, m, tok); err == nil {
			if self, err := c.Self(ctx); err != nil {
				add(name, "api", "FAIL", "API 不可达："+err.Error(), "")
			} else {
				versions[self.Version] = true
				add(name, "api", "OK", "版本 "+self.Version, "")
				if release.CompareVersions(self.Version, release.MinVersions["nomad"]) < 0 {
					add(name, "version", "FAIL", "版本低于支持下限 "+release.MinVersions["nomad"], "")
				}
			}
		}
		if IsServer(m.Role) && raft != nil {
			sv, ok := raftServerOf(cl, m, raft)
			healthy := false
			if ap != nil {
				for _, h := range ap.Servers {
					if ok && h.ID == sv.ID {
						healthy = h.Healthy
					}
				}
			}
			switch {
			case !ok:
				add(name, "raft_member", "FAIL", "不在 Raft 成员中", "检查 retry_join 与网络")
			case !healthy:
				add(name, "raft_member", "WARN", "Autopilot 判定为不健康", "")
			default:
				add(name, "raft_member", "OK", fmt.Sprintf("Raft 成员（voter=%v，leader=%v）", sv.Voter, sv.Leader), "")
			}
		}
		if IsClient(m.Role) && cl.InitState == db.InitInitialized {
			found := false
			for _, n := range nodes {
				if n.Name != mc.NodeName {
					continue
				}
				found = true
				if n.Status == "ready" {
					add(name, "client", "OK", fmt.Sprintf("Client 就绪（%s，Node Pool %s）", n.SchedulingEligibility, n.NodePool), "")
				} else {
					add(name, "client", "FAIL", "Client 状态为 "+n.Status, "")
				}
				if d, ok := n.Drivers["docker"]; ok && d.Detected && !d.Healthy {
					add(name, "docker_driver", "FAIL", "Docker 驱动不健康", "检查 Docker 守护进程")
				} else if ok && d.Detected {
					add(name, "docker_driver", "OK", "Docker 驱动健康", "")
				} else {
					add(name, "docker_driver", "WARN", "未检测到 Docker 驱动", "如需运行 Docker 任务，请在 Docker 管理中安装")
				}
			}
			if !found {
				add(name, "client", "FAIL", "Client 未注册到集群", "")
			}
		}
	}
	if len(versions) > 1 {
		add("", "versions", "WARN", fmt.Sprintf("集群中存在 %d 个不同版本", len(versions)), "完成滚动升级")
	}
	if cl.TLSEnabled {
		if exp, err := pki.EarliestExpiry(cl.CACertPEM); err == nil {
			if left := exp.Sub(now); left < 90*24*time.Hour {
				add("", "ca", "WARN", fmt.Sprintf("集群 CA 将在 %d 天后到期", int(left.Hours()/24)), "执行 CA 轮换")
			} else {
				add("", "ca", "OK", "CA 有效至 "+exp.UTC().Format("2006-01-02"), "")
			}
		}
		if !cl.ClientCertExpiresAt.IsZero() && cl.ClientCertExpiresAt.Sub(now) < 30*24*time.Hour {
			add("", "client_cert", "WARN", "控制面客户端证书即将到期", "执行证书续期")
		}
		if cl.Settings.VerifyHTTPSClient {
			add("", "verify_https_client", "WARN", "已开启 verify_https_client：浏览器无法直接访问原生 UI，Vault 无法直接拉取 JWKS", "")
		}
	}
	if pending, _ := db.GetClusterGossipPending(ctx, s.DB.Reader, clusterID); pending != "" {
		add("", "gossip", "WARN", "存在未完成的 Gossip 密钥轮换", "重新发起 Gossip 密钥轮换以续做")
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
