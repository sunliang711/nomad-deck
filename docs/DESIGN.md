# NomadDeck 服务架构与设计方案

> **目标版本**：`v1.0.0`（一次性完整交付全部核心功能）  
> **定位**：基于 Go 单二进制 + 内嵌 Web UI 的 Nomad 与 Vault 集群统一管理控制面（预留 Consul 扩展能力）

---

## 1. 背景与参考实现来源

本项目用于将命令行单机运维脚本升级为面向集群的 Web 可视化控制面，所有日常与高危运维操作均在管理端 UI 中完成。

### 1.1 参考脚本目录

以下目录中的 Python 运维脚本作为研发阶段的领域逻辑与最佳实践参考（仅用于本地研发对照，正式对外发布前清理路径引用）：

| 模块 | 参考脚本所在目录 | 主要参考内容 |
| :--- | :--- | :--- |
| **Nomad 节点与集成管理** | `/Users/eagle/.local/apps/init/tools/nomad`（`nomad-manager`、`nomad_tools/manager.py`、`nomad_tools/common.py`） | 版本化二进制目录与原子软链切换、升级失败自动回滚、编号分片配置与托管标记、`nomad config validate` 校验与回滚、Docker/CNI/Host Volume/Client Meta/TLS/Telemetry/UI 配置生成、ACL Bootstrap、Nomad-Vault JWT Workload Identity 双向配置与四段式链路体检、Job 导出与命令行审计脱敏 |
| **Nomad Job 脚手架与工作流** | `/Users/eagle/.local/apps/init/tools/nomad`（`nomad-job`、`nomad_tools/job.py`） | Docker Job 脚手架生成、Docker Compose 转 Nomad HCL、`validate -> plan -> apply` 预览再提交工作流、Job 启停与 Purge |
| **Vault 节点与生命周期管理** | `/Users/eagle/.local/apps/init/tools/vault`（`vault-manager`、`vault_tools/manager.py`、`vault_tools/common.py`） | 版本化安装与原子切换回滚、自签 CA 与 SAN TLS 证书签发与到期预警、Raft 存储配置、初始化与逐把解封流程、Auth/Policy 管理、`501/503` 健康状态解读与 `doctor` 诊断 |

### 1.2 明确的设计取舍（已确认决策）

1. **全新设计，不兼容已有旧节点**：目标主机采用 NomadDeck 统一规划的集群级目录布局、systemd 单元与配置模板，不承担旧版单机脚本的历史迁移与兼容包袱。
2. **控制面独立部署于被管集群之外**：NomadDeck 必须运行在被管 Nomad/Vault 集群之外的独立宿主机，避免机房断电重启后出现“Vault 密封 → 托管在 Nomad 内的控制面无法启动 → 无法自动解封”的循环死锁。
3. **纯 Go 原生 SSH + SFTP 远端执行**：控制面直接通过 Go SSH/SFTP 完成文件分发、二进制部署、服务控制与日志流读取，**被管主机无需安装 Python、Ansible 或任何常驻 Agent**。
4. **Vault Unseal Keys 由平台加密托管**：Vault 初始化产出的 Unseal Keys 与 Root Token 由控制面主密钥加密落库，日常 API 调用优先使用初始化后派生的专用 Admin Policy Token；支持在 UI 中一键解封、滚动升级后自动解封及可选的巡检自动解封，避免在 Vault 节点磁盘明文存放解封密钥。
5. **预留 Consul 扩展位（可选）**：核心数据模型、集群驱动接口、联动模型与前端路由均预留 `consul` 类型接口；`v1.0.0` 聚焦 Nomad + Vault，Consul 作为后续按需启用的可选扩展。
6. **一次性发版（`v1.0.0`）**：全部既定功能在 `v1.0.0` 统一交付并完成端到端验收，不拆分多阶段灰度发布。

---

## 2. 设计目标与技术选型

| 维度 | 选型 | 说明 |
| :--- | :--- | :--- |
| **后端语言与框架** | Go 1.26+、`chi/v5` | 单二进制编译部署，低资源占用，原生高并发 |
| **远端执行引擎** | `golang.org/x/crypto/ssh`、`github.com/pkg/sftp` | 原生 SSH/SFTP 连接池、流式输出、无 Agent 侵入 |
| **数据库** | SQLite WAL（`modernc.org/sqlite`） | 纯 Go 零 CGO 依赖，单文件存储；采用读写分离连接池（单写连接 + `busy_timeout`）消除并发写锁冲突 |
| **加密与鉴权** | AES-256-GCM、Argon2id、`golang-jwt/jwt/v5` | 主密钥加密敏感凭据、口令加密迁移包、HttpOnly Cookie/JWT + `token_version` 校验 |
| **定时任务** | `robfig/cron/v3` | 内置运维巡检、证书监控、自动解封巡检与 Raft 快照定时调度 |
| **实时推送** | SSE（Server-Sent Events） | 统一用于单向实时推流（SSH 运维任务日志、`journalctl` 节点日志、Nomad Allocation 日志），规避跨站 WebSocket 劫持与反代 Upgrade 兼容问题 |
| **唯一 ID 与配置解析** | `oklog/ulid/v2`、`BurntSushi/toml`、`gopkg.in/yaml.v3` | 时间有序 ID；极简 TOML 启动配置；纯 Go 解析 Docker Compose YAML（无需控制面安装 Docker CLI） |
| **前端技术栈** | React 18 + TypeScript + Vite + Tailwind CSS + `lucide-react` + CodeMirror 6（HCL 编辑） | 编译后通过 `go:embed` 直接打入后端二进制 |

---

## 3. 系统总体架构与目录规划

### 3.1 总体架构（双通道设计）

控制面按职责划分为**机器运维通道（SSH + SFTP）**与**集群业务通道（HTTP API）**：

```text
                        ┌────────────────────────────────────┐
                        │      Web 管理端 UI (Admin Auth)     │
                        │  节点 / 集群 / 联动 / Job / 定时 /  │
                        │  审计 / 迁移 / 系统设置             │
                        └─────────────────┬──────────────────┘
                                          │ HTTPS / REST + SSE
                        ┌─────────────────▼──────────────────┐
                        │     NomadDeck Control Plane (Go)    │
                        │                                     │
                        │  ┌───────────┐  ┌────────────────┐  │
                        │  │ Auth/Audit│  │ Operation Queue│  │
                        │  ├───────────┤  ├────────────────┤  │
                        │  │ Crypto KMS│  │ Cron Scheduler │  │
                        │  ├───────────┤  ├────────────────┤  │
                        │  │ Migration │  │ Cluster Drivers│  │
                        │  └─────┬─────┘  └───────┬────────┘  │
                        │        │                │           │
                        │  ┌─────▼────────────────▼────────┐  │
                        │  │    SQLite (WAL) + master.key  │  │
                        │  └───────────────────────────────┘  │
                        └────────┬───────────────────┬────────┘
                                 │                   │
            SSH + SFTP 通道      │                   │ HTTP/HTTPS API 通道
       (安装/升级/配置/启停/     │                   │ (Job管理/Alloc日志/状态查询/
        journalctl/主机体检)     │                   │  Vault解封/Auth/Policy/KV)
                                 ▼                   ▼
              ┌────────────────────────────────────────────────┐
              │              被管集群节点（Linux）               │
              │  ┌──────────────────┐    ┌──────────────────┐  │
              │  │  Nomad Cluster   │◄──►│  Vault Cluster   │  │
              │  │ Server / Client  │JWT │  Raft HA + TLS   │  │
              │  └──────────────────┘    └──────────────────┘  │
              │              [可选扩展位: Consul Cluster]       │
              └────────────────────────────────────────────────┘
```

- **SSH + SFTP 通道**仅用于操作系统与进程层操作：探测主机架构、安装/卸载/升级二进制、分发配置文件与 TLS 证书、执行 `systemctl` 启停重启、读取 `journalctl` 服务日志、配置 Docker/CNI/Host Volume。
- **HTTP/HTTPS API 通道**用于高频控制面与业务操作：查询 Nomad 集群拓扑与 Leader 状态、Job 校验/Plan/提交/启停/重启/Purge、流式拉取 Allocation 日志、查询 Vault 健康与密封状态、执行初始化/解封/Auth/Policy/KV 管理、触发 Raft Snapshot。

### 3.2 被管节点目录规范（全新集群布局）

目标 Linux 主机由 NomadDeck 独占管理，所有托管配置文件首行统一写入 `# Managed by NomadDeck`：

- **Nomad 节点（`/opt/nomad-deck/nomad`）**
  - 二进制版本目录：`/opt/nomad-deck/nomad/bin/versions/nomad-<ver>`，原子软链 `/opt/nomad-deck/nomad/bin/nomad` 与 `/usr/local/bin/nomad`
  - 配置目录：`/opt/nomad-deck/nomad/etc/nomad.d/`
    - `10-base.hcl`（datacenter、region、bind/advertise、server/client 角色与 `retry_join`、Gossip 加密、ACL）
    - `30-tls.hcl`（集群 TLS 证书配置）
    - `35-ui.hcl`（Nomad 原生 UI 开关与跨链接）
    - `40-telemetry.hcl`（Prometheus 指标配置）
    - `60-vault.hcl`（Vault Workload Identity 联动配置）
    - `65-consul.hcl`（预留：Consul 联动配置）
    - `70-host-volume-<name>.hcl`（Client Host Volumes）
    - `72-client-meta.hcl`（Client 调度标签）
    - `80-docker.hcl`、`81-raw-exec.hcl`、`82-driver-denylist.hcl`、`83-cni.hcl`
  - 证书目录：`/opt/nomad-deck/nomad/etc/tls/`
  - 数据与卷目录：`/opt/nomad-deck/nomad/data/`、`/opt/nomad-deck/nomad/volumes/`
  - systemd 单元：`/etc/systemd/system/nomad.service`（纯 Server 节点以低权系统用户 `nomad` 运行；含 Client 角色的 `client` / `server_client` 节点以 `root` 运行，以满足 cgroups、CNI 网络命名空间、Host Volume 挂载与 Docker socket 权限要求）
- **Vault 节点（`/opt/nomad-deck/vault`）**
  - 二进制版本目录：`/opt/nomad-deck/vault/bin/versions/vault-<ver>`，原子软链 `/opt/nomad-deck/vault/bin/vault` 与 `/usr/local/bin/vault`
  - 配置与证书：`/opt/nomad-deck/vault/etc/config.hcl`（Raft 模式下显式配置 `disable_mlock = true`、`api_addr` 与 `cluster_addr`）、`/opt/nomad-deck/vault/etc/tls/{ca.crt,server.crt,server.key}`
  - 数据目录：`/opt/nomad-deck/vault/data/raft/`
  - systemd 单元：`/etc/systemd/system/vault.service`（以低权系统用户 `vault` 运行；不安装本地明文自动解封单元，解封由 NomadDeck 控制面通过 API 完成）

### 3.3 仓库目录结构规划

```text
nomad-deck/
├── cmd/
│   └── nomad-deck/
│       └── main.go                 # 进程入口、配置加载、优雅关闭
├── internal/
│   ├── config/                     # 启动配置（TOML + 环境变量覆盖）
│   ├── crypto/                     # master.key 管理、AES-256-GCM 信封加密、Argon2id、SSH/TLS 密钥签发
│   ├── db/                         # SQLite WAL 读写分离连接池、内嵌 Schema 迁移、Repository 封装
│   ├── auth/                       # Admin 认证、Setup Wizard、防爆破限流、Cookie JWT 与 token_version 校验
│   ├── sshx/                       # 纯 Go SSH/SFTP 连接池、主机指纹校验、sudo 封装、流式执行
│   ├── release/                    # HashiCorp / CNI 版本解析、SHA256 校验、控制面中转下载与预解压缓存
│   ├── driver/                     # 集群通用驱动接口（ClusterDriver / NodeProvisioner，预留 Consul）
│   ├── nomad/                      # Nomad 节点 SSH 编排、HCL 渲染、扩缩容与滚动升级、Nomad HTTP API 客户端
│   ├── vault/                      # Vault 节点 SSH 编排、Raft 集群组网、托管解封、扩缩容与滚动升级、Vault HTTP API 客户端
│   ├── integration/                # Nomad <-> Vault JWT Workload Identity 双向联动编排与四段式体检
│   ├── job/                        # Job 生命周期、可视化动态编排模型与 HCL 渲染/反解、纯 Go Compose 转 HCL、实时 Alloc 日志代理
│   ├── ops/                        # 异步长任务引擎（任务队列、集群级互斥锁、步骤状态机、SSE 实时日志广播、崩溃恢复）
│   ├── cron/                       # 平台定时任务调度与执行历史
│   ├── audit/                      # 统一审计记录与敏感字段强制脱敏
│   ├── migration/                  # .ndbundle 加密导出、Dry-Run 预检与事务导入还原
│   ├── api/                        # chi HTTP 路由、中间件、REST/SSE Handler
│   └── ui/                         # go:embed 前端静态资源与 SPA Fallback
├── web/                            # React + TypeScript + Vite + Tailwind 管理端工程
├── deploy/                         # systemd 单元模板、Dockerfile、docker-compose.yml
├── docs/
│   └── DESIGN.md                   # 本设计方案
├── Makefile
├── go.mod
└── README.md
```

---

## 4. 数据库表结构设计（SQLite WAL）

所有主键均使用 ULID 字符串，时间字段统一使用 RFC3339 UTC 文本；凡后缀为 `_encrypted` 的列均由控制面 `master.key` 经 AES-256-GCM 加密存储（附随机 12 字节 Nonce 与版本前缀，支持后续密钥轮换）。

### 4.1 `admins`（管理端账号）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | TEXT PK | ULID |
| `username` | TEXT UNIQUE | 管理员用户名 |
| `password_hash` | TEXT | Argon2id 密码哈希 |
| `token_version` | INTEGER | JWT 版本号（默认 `1`；主动登出或修改密码时自增，使既有 Token 即时失效） |
| `failed_attempts` | INTEGER | 连续登录失败次数 |
| `locked_until` | TEXT | 防爆破锁定截止时间（可空） |
| `last_login_at` | TEXT | 最近登录时间 |
| `created_at` / `updated_at` | TEXT | 时间戳 |

### 4.2 `system_settings`（系统全局设置）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `key` | TEXT PK | 配置键（如 `release.mirror_url`、`release.download_mode`、`ssh.timeout_sec`、`ssh.max_concurrency`、`proxy.url`、`audit.retention_days`、`ops.retention_days`、`snapshot.dir`、`auth.session_ttl_hours`、`defaults.nomad_version`、`defaults.vault_version`） |
| `value` | TEXT | JSON 序列化配置值（含敏感项的设置使用 `is_secret=1` 并存入加密值） |
| `is_secret` | INTEGER | `0` 明文 / `1` AES-256-GCM 密文 |
| `updated_at` | TEXT | 更新时间 |

### 4.3 `ssh_keys`（SSH 密钥库）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | TEXT PK | ULID |
| `name` | TEXT UNIQUE | 密钥名称（如 `default-cluster-key`） |
| `algorithm` | TEXT | `ed25519` / `rsa` / `ecdsa` |
| `public_key` | TEXT | OpenSSH 公钥字符串 |
| `private_key_encrypted` | TEXT | 加密后的 PEM/OpenSSH 私钥 |
| `fingerprint` | TEXT | SHA256 指纹 |
| `is_default` | INTEGER | 是否默认集群密钥 |
| `created_at` / `updated_at` | TEXT | 时间戳 |

### 4.4 `nodes`（主机资产表）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | TEXT PK | ULID |
| `name` | TEXT UNIQUE | 主机显示名（如 `prod-node-01`） |
| `host` | TEXT | SSH 连接 IP 或域名 |
| `ssh_port` | INTEGER | 默认 `22` |
| `ssh_user` | TEXT | SSH 登录用户（如 `root` 或具备免密 `sudo` 的运维用户） |
| `ssh_key_id` | TEXT FK | 关联 `ssh_keys.id` |
| `use_sudo` | INTEGER | 是否通过 `sudo -n` 提权执行 |
| `sudo_ready` | INTEGER | 探测得到的免密 `sudo` 可用性（`0` 不可用 / `1` 可用） |
| `selinux_mode` | TEXT | 探测得到的 SELinux 状态（`enforcing` / `permissive` / `disabled` / `unknown`） |
| `host_key_fingerprint` | TEXT | 首次信任（TOFU）记录的远端主机公钥指纹 |
| `os_info` | TEXT | 探测到的系统信息（发行版/内核） |
| `arch` | TEXT | 探测到的 CPU 架构（`amd64` / `arm64`） |
| `status` | TEXT | `online` / `offline` / `unknown` |
| `last_checked_at` | TEXT | 最近连通性检测时间 |
| `labels_json` | TEXT | 自定义主机标签 JSON |
| `notes` | TEXT | 备注 |
| `created_at` / `updated_at` | TEXT | 时间戳 |

### 4.5 `clusters`（集群表）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | TEXT PK | ULID |
| `name` | TEXT UNIQUE | 集群名称 |
| `type` | TEXT | `nomad` / `vault` / `consul`（预留） |
| `mode` | TEXT | `single`（单机） / `cluster`（多节点集群） |
| `region` | TEXT | 区域（Nomad 默认 `global`） |
| `datacenter` | TEXT | 数据中心（Nomad 默认 `dc1`） |
| `tls_enabled` | INTEGER | 是否开启集群 TLS |
| `ca_cert_pem` | TEXT | 集群统一 CA 证书（PEM） |
| `ca_key_encrypted` | TEXT | 加密存储的集群 CA 私钥（用于签发新扩容节点与续期证书） |
| `ca_expires_at` | TEXT | 集群 CA 证书到期时间（供证书临期巡检使用） |
| `client_cert_pem` | TEXT | 控制面专用客户端 TLS 证书（Nomad 开启 `verify_https_client` 时用于 mTLS 鉴权） |
| `client_key_encrypted` | TEXT | 加密存储的控制面专用客户端 TLS 私钥 |
| `gossip_key_encrypted` | TEXT | 加密存储的 Nomad Gossip 密钥（16/32 字节 Base64） |
| `public_api_url` | TEXT | 集群对外统一业务入口（如 LB/VIP/域名，优先用于 Nomad ↔ Vault 联动的 `jwks_url` 与 `vault.address`） |
| `api_endpoints_json` | TEXT | 控制面访问该集群的故障切换 HTTP API 入口列表（逐节点直连操作仍优先使用 `cluster_nodes.api_addr`） |
| `admin_token_encrypted` | TEXT | 加密存储的管理 Token（Nomad Management Token；Vault 日常管理 Token 见托管表） |
| `config_json` | TEXT | 集群级默认配置（如 Nomad `job_gc_threshold`、Telemetry、UI、TLS 选项；Vault API/Cluster 端口策略） |
| `health_status` | TEXT | `healthy` / `degraded` / `sealed` / `uninitialized` / `unreachable` |
| `created_at` / `updated_at` | TEXT | 时间戳 |

### 4.6 `cluster_nodes`（集群成员角色表）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | TEXT PK | ULID |
| `cluster_id` | TEXT FK | 关联 `clusters.id` |
| `node_id` | TEXT FK | 关联 `nodes.id` |
| `role` | TEXT | Nomad：`server` / `client` / `server_client`；Vault：`raft_node`；Consul（预留）：`server` / `client` |
| `advertise_addr` | TEXT | 集群内部通信 IP（多网卡主机显式指定） |
| `api_addr` | TEXT | 该节点直连 HTTP/HTTPS API 地址（如 `https://10.0.0.11:8200`，用于单节点解封、健康检查与升级验活） |
| `cluster_addr` | TEXT | Vault 节点间 Raft 通信地址（如 `https://10.0.0.11:8201`） |
| `install_state` | TEXT | `pending` / `installed` / `uninstalled` / `failed` |
| `installed_version` | TEXT | 当前运行二进制版本 |
| `kept_versions_json` | TEXT | 节点磁盘保留的历史版本列表 |
| `service_status` | TEXT | `active` / `inactive` / `failed` / `unknown` |
| `raft_role` | TEXT | `leader` / `follower` / `standby` / `none` |
| `is_voter` | INTEGER | Raft 节点是否具备投票权（`0` / `1`） |
| `is_sealed` | INTEGER | Vault 节点级密封状态（`0` 已解封 / `1` 已密封 / `NULL` 非 Vault 或未知） |
| `node_config_json` | TEXT | 节点级特化配置（Nomad Client 的 Docker/CNI/raw_exec/denylist/host_volumes/meta、节点证书 SAN 等） |
| `cert_expires_at` | TEXT | 该节点 TLS 证书到期时间 |
| `last_synced_at` | TEXT | 最近状态同步时间 |
| `created_at` / `updated_at` | TEXT | 时间戳 |

> 唯一约束：`(cluster_id, node_id)`，同一台主机可以同时加入一个 Nomad 集群和一个 Vault 集群，但不能在同一集群重复加入。

### 4.7 `vault_secrets_custody`（Vault 密钥加密托管表）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `cluster_id` | TEXT PK FK | 关联 `clusters.id`（`type='vault'`） |
| `initialized` | INTEGER | `0` / `1` |
| `key_shares` | INTEGER | Shamir 分片总数（默认 `5`） |
| `key_threshold` | INTEGER | 解封阈值（默认 `3`） |
| `unseal_keys_encrypted` | TEXT | AES-256-GCM 加密的 Unseal Keys JSON 数组 |
| `root_token_encrypted` | TEXT | AES-256-GCM 加密的 Root Token（仅作托管与紧急兜底） |
| `admin_token_encrypted` | TEXT | AES-256-GCM 加密的专用运维 Admin Policy Token（初始化后派生，供日常 API 与集群联动使用） |
| `auto_unseal_by_deck` | INTEGER | 是否开启“控制面自动解封”（升级后及定时巡检发现 Sealed 时自动调用 API 解封） |
| `initialized_at` | TEXT | 初始化时间 |
| `last_unsealed_at` | TEXT | 最近一次解封时间 |
| `updated_at` | TEXT | 更新时间 |

### 4.8 `cluster_integrations`（集群联动关系表）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | TEXT PK | ULID |
| `name` | TEXT UNIQUE | 联动配置名称（Profile 名，如 `prod-nomad-vault`） |
| `integration_type` | TEXT | `nomad_vault_jwt`（预留 `nomad_consul`） |
| `source_cluster_id` | TEXT FK | 源集群（Nomad 集群 ID） |
| `target_cluster_id` | TEXT FK | 目标集群（Vault 集群 ID） |
| `config_json` | TEXT | 联动参数（`auth_path`、`role_name`、`policy_name`、`secret_paths`、`aud`、`ttl`、`jwks_url`、自定义 Policy HCL 等） |
| `status` | TEXT | `draft` / `applied` / `drifted` / `failed` |
| `last_doctor_json` | TEXT | 最近一次四段式全链路体检结果快照 |
| `last_applied_at` | TEXT | 最近一次下发时间 |
| `created_at` / `updated_at` | TEXT | 时间戳 |

### 4.9 `job_templates` 与 `job_revisions`（Nomad Job 模板与版本历史）
- `job_templates`：`id`、`cluster_id`（可空表示跨集群通用模板）、`name`、`job_id`、`namespace`、`edit_mode`（`visual` / `hcl`）、`form_spec_json`（可视化动态编排结构 JSON，可空）、`hcl_content`、`source_type`（`visual` / `hcl` / `compose` / `imported`）、`description`、`created_at`、`updated_at`。
- `job_revisions`：`id`、`cluster_id`、`namespace`、`job_id`、`revision_no`、`edit_mode`（`visual` / `hcl`）、`form_spec_json`（可空）、`hcl_content`、`plan_summary`、`submitted_by`、`created_at`（支持在 UI 中对比历史版本、按原编辑模式回填与一键回滚）。

### 4.10 `operation_tasks` 与 `operation_task_steps`（异步运维任务与步骤追踪）
- `operation_tasks`：`id`、`action`（如 `nomad.install`、`nomad.upgrade`、`vault.init`、`vault.unseal`、`cluster.node_join`、`cluster.node_remove`、`cluster.cert_renew`、`integration.apply`、`cluster.uninstall`、`snapshot.restore`）、`target_type`、`target_id`、`status`（`pending` / `running` / `success` / `failed` / `rolled_back` / `interrupted` / `cancelled`）、`params_redacted_json`、`triggered_by`、`started_at`、`finished_at`、`error_message`。
- `operation_task_steps`：`id`、`task_id` FK、`step_order`、`node_id`（可空）、`name`、`status`、`log_path`（步骤完整执行日志文件路径）、`exit_code`、`started_at`、`finished_at`、`error_message`。

### 4.11 `cron_jobs` 与 `cron_job_runs`（平台定时任务与执行历史）
- `cron_jobs`：`id`、`job_key` UNIQUE、`name`、`cron_expr`、`enabled`、`payload_json`、`is_builtin`、`last_run_at`、`last_status`、`next_run_at`、`updated_at`。
- `cron_job_runs`：`id`、`cron_job_id` FK、`trigger_type`（`scheduled` / `manual`）、`status`、`summary`、`detail_log`、`started_at`、`finished_at`。

### 4.12 `cluster_snapshots`（集群 Raft 快照索引表）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | TEXT PK | ULID |
| `cluster_id` | TEXT FK | 关联 `clusters.id` |
| `cluster_type` | TEXT | `nomad` / `vault` |
| `file_path` | TEXT | 加密落盘的快照文件路径 |
| `size_bytes` | INTEGER | 快照文件大小（字节） |
| `sha256` | TEXT | 密文文件 SHA256 校验值 |
| `trigger_type` | TEXT | `scheduled` / `manual` |
| `triggered_by` | TEXT | 管理员或 `system:cron` |
| `created_at` | TEXT | 创建时间 |

### 4.13 `audit_logs`（全量审计日志）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | TEXT PK | ULID |
| `actor_id` / `actor_name` | TEXT | 操作管理员或 `system:cron` |
| `client_ip` | TEXT | 请求来源 IP |
| `action` | TEXT | 动作标识（如 `auth.login`、`ssh_key.generate`、`node.create`、`nomad.upgrade`、`vault.unseal`、`job.submit`、`job.purge`、`migration.export`、`migration.import`） |
| `resource_type` / `resource_id` / `resource_name` | TEXT | 目标资源信息 |
| `request_summary_json` | TEXT | 经强制脱敏处理的参数摘要 |
| `operation_task_id` | TEXT | 关联的长任务 ID（可空，方便从审计直接跳转看完整执行日志） |
| `result` | TEXT | `success` / `failed` |
| `error_message` | TEXT | 失败原因（脱敏） |
| `duration_ms` | INTEGER | 耗时（毫秒） |
| `created_at` | TEXT | 时间戳 |

---

## 5. 核心机制与关键设计细节

### 5.1 零手工配置启动、并发控制与安全边界

1. **独立部署与主密钥初始化**：
   - 控制面独立部署在被管集群之外的宿主机。
   - 启动时优先读取环境变量 `NOMAD_DECK_MASTER_KEY`（32 字节 Hex/Base64）；未设置时自动在数据目录生成 `master.key`（权限 `0600`）。生产环境通过环境变量注入主密钥，避免 `master.key` 与 SQLite 数据库同目录存放或被一并归档泄露。
2. **首次初始化向导（Setup Wizard）**：当 `admins` 表为空时，访问 Web 管理端自动跳转至初始化页面，完成：
   - 创建第一个管理员账号与强密码；
   - 自动生成默认 Ed25519 SSH 密钥对存入 `ssh_keys`；
   - 可选配置系统默认下载模式（直连 / 控制面中转）与代理地址。
3. **认证、即时失效与防爆破**：
   - 密码采用 Argon2id 哈希；登录态使用 `HttpOnly + SameSite=Lax` Cookie 承载短有效期 JWT（内置 `ver` 声明），每次鉴权校验 `admins.token_version`，主动登出或修改密码时递增 `token_version` 使历史登录态即时失效。
   - 同一账号或来源 IP 连续失败达阈值（默认 5 次）触发指数退避锁定，并写入审计日志。
4. **敏感凭据不泄露**：所有 API 响应永不返回明文私钥、Unseal Keys 或管理 Token（仅返回是否已配置、指纹、前缀或更新时间）；若管理员在 Vault 初始化后需下载离线紧急备份，须二次校验管理员密码并通过单次响应下载且写入高危审计日志。
5. **SQLite 并发隔离与集群任务互斥**：
   - 数据库层采用读写分离连接池：写连接固定为单连接（`SetMaxOpenConns(1)`）并配置 `busy_timeout`，消除异步任务、定时巡检与审计写入同时争抢写锁导致的 `SQLITE_BUSY`。
   - 异步任务引擎维护按 `cluster_id` 维度的集群级互斥锁，同一集群同一时刻只允许执行一个变更类运维任务（部署、扩缩容、改配置、升级、续期、联动下发、卸载、快照恢复），防止并发覆盖配置文件或交叉重启服务。
   - 控制面启动时自动扫描 `operation_tasks` 中残留的 `running` 任务及步骤，将其标记为 `interrupted` 并释放对应集群锁，同时在运维任务中心给出异常中断提示。

### 5.2 纯 Go SSH + SFTP 远端执行与节点纳管

1. **密钥分发体验**：
   - 在「SSH 密钥」页可一键生成新 Ed25519 密钥对或导入已有私钥。
   - 在「添加主机」页支持两种免密配置方式：
     - **手动粘贴模式**：UI 提供公钥文本和一条可复制的 `mkdir -p ~/.ssh && ...` 初始化命令；
     - **一键推送公钥模式**：管理员在表单临时输入目标机 SSH 密码，后端通过 Go SSH 建立一次性连接，先检查 `~/.ssh/authorized_keys` 去重后再追加写入公钥并校验目录/文件权限（`0700`/`0600`）；若目标机启用 SELinux，自动尝试执行 `restorecon -Rv ~/.ssh`。**密码仅驻留内存、执行完即销毁、绝不落库和写审计**。
2. **连接安全与环境探测**：
   - 首次连接采用 TOFU 策略记录目标机 Host Key 指纹；后续连接强制比对，如主机重装导致指纹变化，UI 明确告警并允许管理员确认后重置。
   - 连通性测试同时自动探测：Linux 发行版、CPU 架构（`amd64`/`arm64`）、`systemctl`/`journalctl`/`tar`/`unzip` 可用性、当前用户免密 `sudo` 权限（`sudo_ready`）、SELinux 状态（`selinux_mode`）以及 `/opt/nomad-deck` 可写性。
   - 若普通用户未配置免密 `sudo`，UI 展示明确的 `sudoers` 配置指引并在发起需提权的运维任务前拦截；若目标机处于 SELinux `enforcing` 或开启防火墙，在节点详情和部署前预检中给出上下文标签与端口放行提示（Nomad `4646/4647/4648`、Vault `8200/8201` 及业务端口）。
3. **原子文件分发与下载中转**：
   - 配置文件与证书通过 SFTP 写入目标机临时文件，随后经 SSH 执行 `install -m <mode> -o <owner> -g <group>` 原子落位。
   - **双下载模式**（可在系统设置或单次任务中切换）：
     - `direct`：目标机直接从官方源或镜像源拉取 release zip、校验 SHA256 并解压；
     - `relay`（推荐用于内网/离线集群）：由 NomadDeck 控制面统一下载 release zip、校验 SHA256 并在**控制面本地预解压出目标二进制文件**后缓存，再直接通过 SFTP 分发二进制给各目标节点——**同版本多节点安装或升级只需下载一次，且目标机无需访问外网也无需安装 `unzip`**。
4. **实时日志流**：所有 SSH 命令执行均实时捕获 `stdout`/`stderr`，写入步骤日志文件并通过内存 PubSub 经 **SSE** 实时推流到前端终端面板；查看节点服务日志时，直接通过 SSH 执行 `journalctl -u nomad|vault -n <lines> [--since ...] [-f]` 并将流式输出经 SSE 转发到浏览器。

### 5.3 Nomad 节点与集群管理

1. **集群与节点安装编排**：
   - 支持**单机模式（Server+Client）**与**集群模式（推荐 3/5 台 Server + N 台 Client）**。
   - 创建集群并选择节点角色后，点击「一键部署」进入异步运维任务：
     1. 开启 TLS 时，自动签发集群统一 CA（记录 `ca_expires_at`）、控制面专用客户端证书（`cli.<region>.nomad`，用于开启 `verify_https_client` 时的 mTLS 访问）以及各节点 TLS 证书。节点证书强制包含 Nomad 要求的专属 DNS SAN（Server 包含 `server.<region>.nomad`，Client 包含 `client.<region>.nomad`，同时包含 `localhost`、`127.0.0.1`、`::1` 及节点 `advertise_addr`/自定义域名）；同时自动生成 Gossip 加密密钥。
     2. 并发安装各节点 Nomad 二进制（版本目录 + 原子软链）、创建目录与 `nomad.service`：**纯 Server 节点以低权系统用户 `nomad` 运行，含 Client 角色（`client` / `server_client`）的节点以 `root` 运行**，以满足 cgroups、CNI、Host Volume 与 Docker socket 权限要求。
     3. 按角色渲染 `10-base.hcl`（Server 自动写入 `bootstrap_expect` 与所有 Server 的 `retry_join`；Client 自动写入 Server 列表）、`30-tls.hcl`、`40-telemetry.hcl`、`80-docker.hcl` 等托管片段。
     4. 如节点启用 CNI，自动下发 CNI Plugins 到 `/opt/cni/bin`、写入 bridge sysctl 与 `83-cni.hcl`。
     5. 先启动全部 Server 并等待 Leader 选出，自动在 Leader 执行 ACL Bootstrap，收到响应后第一时间强制落盘加密写入 `clusters.admin_token_encrypted`（如遇极端中断导致远端已完成 Bootstrap 而库内缺失 Token，可通过 UI 凭据管理入口手动补录或按重置索引恢复）。
     6. 启动全部 Client，通过 Nomad HTTP API 验证所有节点进入 `ready` 状态。
2. **节点运维、扩缩容与配置变更**：
   - 单节点或批量执行：启动、停止、重启、查看实时 `journalctl` 日志、卸载（先展示 Dry-Run 删除计划，支持区分保留数据/清理数据）。
   - **单节点安全扩缩容**：
     - **扩容（Join）**：向已有集群新增 Server 或 Client 节点，自动签发新节点证书、分发二进制与配置、按需刷新既有 Server/Client 的 `retry_join` 配置并确认新节点加入 Raft 或进入 `ready` 状态；
     - **缩容（Remove）**：摘除 Client 前先将其标记为 `ineligible` 并执行 `drain`；摘除 Server 前先校验剩余 Server 满足 Raft 仲裁要求并调用 `operator raft remove-peer` 移出 Raft 成员，确认脱离后再停服卸载。
   - **节点证书一键续期**：支持针对临期节点或整集群使用既有集群 CA 重新签发节点 TLS 证书并按安全顺序滚动下发生效，刷新 `cert_expires_at`。
   - 配置托管管理（UI 表单化编辑）：Docker 驱动（privileged、volumes、image GC、私有仓库 auth）、CNI、raw_exec、Driver Denylist、Host Volumes（支持远端自动创建目录与防误删校验）、Client Meta、UI 跨链接与环境标签、Telemetry。
   - **安全变更闭环**：任一配置变更均不直接覆写现网目录，而是“复制现网 `nomad.d/` 至远端临时目录并写入新片段 → 对临时目录执行 `nomad config validate` → 校验通过后备份旧文件并原子落位 → 重启服务 → HTTP API 验活”，校验失败直接中止，重启验活失败立即回滚旧配置并重启恢复。
3. **版本升级与滚动升级**：
   - 升级前展示升级计划（Dry-Run 预览：当前版本、目标版本、跨小版本风险提示、节点执行顺序、保留版本数）。
   - 单节点升级步骤：下载/中转新版本 → 写入 `versions/nomad-<ver>` → 试跑 `nomad version` 核对版本号 → 原子替换软链 → 重启服务 → 校验服务存活与 HTTP API 就绪 → 清理超出 `keep` 数量的旧版本。
   - 若新版本重启失败，自动原子切回上一版本软链并重启恢复，标记该步骤为 `rolled_back` 并**立即熔断中止后续节点升级**。
   - 集群滚动顺序：**先所有非 Leader Server（逐台确认重新加入 Raft 且集群有 Leader）→ 再 Leader Server → 最后按批次升级 Client（可选先 Drain 再升级再取消 Drain）**。
4. **节点与集群 Doctor 体检**：检查 systemd 状态、运行用户与角色匹配性、二进制与元数据版本一致性、托管配置完整性、HTTP API 可达性、Raft Leader 与 Peers 健康、Docker/CNI/Vault/Consul 集成状态，返回结构化检查项列表（`OK`/`WARN`/`FAIL` 及修复建议）。

### 5.4 Vault 节点与集群管理（含加密托管解封）

1. **安装与 Raft 集群部署**：
   - 支持单机与多节点 Raft HA 集群（推荐 3/5 节点）。
   - 开启 TLS 时由控制面自动签发集群统一 CA（记录 `ca_expires_at`）与各节点 SAN 证书（默认覆盖 `localhost`、`127.0.0.1`、`::1`、节点 `advertise_addr`/域名及集群 `public_api_url` 域名），写入 `config.hcl` 的 `disable_mlock = true`、`api_addr`、`cluster_addr`、`storage "raft"` 与 `retry_join`（附 `leader_ca_cert_file`），并将各节点直连 `api_addr` 与 `cluster_addr` 记入 `cluster_nodes`。
   - 启动服务后，Vault 默认处于未初始化、密封状态（HTTP 501）。
2. **初始化、凭证容错与平台加密托管**：
   - 管理员在 UI 点击「初始化集群」，设定 `key_shares`（默认 5）与 `key_threshold`（默认 3）。
   - 控制面直连首个节点 `api_addr` 调用 `/v1/sys/init`，**收到响应后第一时间先将 Unseal Keys 与 Root Token 使用 `master.key` 加密写入临时保护记录并同步提交至 `vault_secrets_custody`**，防止落库中断导致唯一初始化密钥永久丢失；同时在弹窗提示管理员可下载一次离线紧急备份文件，并支持在极端故障下通过 UI 凭据管理入口手动补录托管密钥。
   - 首个节点解封成为 Active Leader 后，控制面自动创建一个具备平台运维权限的专用 Admin Policy Token 加密存入 `vault_secrets_custody.admin_token_encrypted`（日常 Auth/Policy/KV、快照与集群联动操作优先使用该 Token，Root Token 仅保留在托管库应急）。
   - 随后对其他 Raft 节点轮询等待其通过 `retry_join`（或显式 `/v1/sys/storage/raft/join`）同步为 `initialized=true, sealed=true`（HTTP 503），确认加入后再逐台直连节点 `api_addr` 自动解封。
3. **节点级托管解封与重启自愈**：
   - **手动一键解封**：UI 展示每台 Vault 节点独立的 `is_sealed` 状态，针对单节点或整个集群提供「解封」按钮；控制面始终直连目标节点 `cluster_nodes.api_addr`（不经统一 VIP/LB）调用 `/v1/sys/unseal` 逐把提交直至 `sealed=false`。
   - **控制面自动解封（`auto_unseal_by_deck`）**：开启后，不仅在控制面发起的重启/升级后自动完成解封，定时任务 `vault_auto_unseal_watch` 也会逐台直连探测健康状态，若发现节点因宿主机重启进入 `503 Sealed`，自动由控制面远程通过 API 解封并记录审计日志。**Vault 主机磁盘全程不落盘任何明文 Unseal Key**。
4. **日常运维、扩缩容、证书续期与滚动升级**：
   - 支持节点启动/停止/重启、实时查看 `journalctl -u vault` 日志、卸载（Dry-Run 预览，默认保护 Raft 数据目录，须显式勾选“清除数据”并二次确认）。
   - **单节点扩缩容与证书续期**：
     - **扩容（Join）**：签发新节点证书、安装并写入 `retry_join`、确认加入 Raft 后自动解封并验证进入 `standby`；
     - **安全缩容（Remove）**：先校验剩余 Raft Voter 数量满足仲裁，调用 `/v1/sys/storage/raft/remove-peer` 移出节点后再停服卸载；
     - **证书续期**：支持重新签发节点 TLS 证书并按 Standby → Active 顺序滚动分发、重载/重启与自动解封，刷新 `cert_expires_at`。
   - 滚动升级顺序：**先逐台升级 Standby 节点（升级 → 重启 → 控制面直连自动解封 → 校验恢复为健康 `standby` 且 `is_voter=1`）→ 确认全部 Standby 健康后，再对 Active 节点执行 `step-down` 并升级、解封与验活**；任一节点启动失败立即回滚二进制软链并熔断中止。
   - Vault 业务管理页（走 Vault HTTP API）：Auth 方法列表/启用/禁用/读写、Policy HCL 列表与在线编辑、**多引擎 KV 管理**（列出所有已挂载 KV 引擎并区分 KV v1/v2，按指定 `mount` 浏览目录与读写 Secret）、证书到期检查与 `doctor` 诊断。

### 5.5 Nomad 与 Vault 集群级联动（Workload Identity / JWT）

在 UI 中通过「集群联动」模块将任意一个 Nomad 集群与 Vault 集群打通，全流程可视化并支持 **Plan 预览 → Apply 执行 → 四段式 Doctor 体检**：

1. **Plan 预检**：
   - 检查 Vault 是否已初始化且全节点已解封、运维 Token 权限、Nomad 集群 JWKS 端点可达性；
   - **mTLS 冲突校验**：若 Nomad 集群启用了 `verify_https_client = true`（强制客户端证书），Plan 阶段明确拦截并提示冲突（Vault 拉取 `jwks_url` 不支持 mTLS 客户端证书），引导管理员关闭 `verify_https_client` 或切换为静态 `jwt_validation_pubkeys` 验签模式；
   - **高可用入口检查**：优先采用 Nomad 与 Vault 集群的 `public_api_url`（VIP/域名）生成 `jwks_url` 与 `vault.address`；若多节点集群未配置统一入口而回退指向单台节点地址，Plan 阶段显式给出单点故障告警；
   - 展示待生成的 Vault Policy、JWT Role JSON 与 Nomad `60-vault.hcl` 完整预览。
2. **Apply 编排**：
   - **双向 TLS 信任配置**：
     - 若 Vault 启用 TLS，控制面将 Vault 集群 `ca.crt` 经 SFTP 分发至 Nomad 集群全部节点 `/opt/nomad-deck/nomad/etc/tls/vault-ca.crt`；
     - 若 Nomad 启用自签 TLS，控制面同时将 Nomad 集群 `ca.crt` 写入 Vault JWT Auth 配置的 `jwks_ca_pem` 字段，确保 Vault 验签 JWKS 信任 Nomad CA。
   - 通过 Vault API 启用/校验 JWT Auth Mount（默认 `jwt-nomad`），写入配置（`jwks_url`、`jwks_ca_pem` 或 `jwt_validation_pubkeys`、`jwt_supported_algs=RS256,EdDSA`、`default_role`）；
   - 通过 Vault API 写入 Policy（自动按 KV v2 规则补齐 `/data/` 与 `/metadata/` 权限，或使用自定义 HCL）与 JWT Role（`user_claim=/nomad_job_id`、`claim_mappings` 映射 `nomad_namespace`/`nomad_job_id`/`nomad_task`、`bound_audiences`、`token_period`）；
   - 向 Nomad 集群全部节点按角色下发 `60-vault.hcl`（Server 侧配置 `default_identity`，Client 侧配置 `address`/`ca_file`/`jwt_auth_backend_path`），经临时目录 `config validate` 校验通过后按安全顺序**滚动重启（restart）**生效。
3. **四段式链路体检（Doctor）**：逐段校验 ① Nomad JWKS 可达性、TLS 证书链与签发 Audience → ② Nomad `60-vault.hcl` 指向的 Auth Path、Vault 地址与 CA → ③ Vault JWT Auth Mount、`jwks_url` 与 `jwks_ca_pem` 一致性 → ④ Vault Role、Policy 与对应 Secret Engine 挂载状态，可视化展示绿色/红色节点定位断链位置。
4. **示例 Job 生成**：在联动详情页可一键生成引用该 Role 与指定 KV 路径的测试 Nomad Job HCL，直接跳转到 Job 提交页验证端到端取密。

### 5.6 Nomad Job 全生命周期管理

通过 Nomad HTTP API（自动携带该集群加密托管的 Management Token，支持按集群多入口自动故障切换）实现全部操作：

1. **Job 列表与详情**：按集群、Namespace、类型（`service`/`batch`/`system`/`sysbatch` + Periodic 标识）、状态过滤；详情页展示 Task Groups、Allocations、部署状态、健康检查与事件时间线。
2. **双模式 Job 编排工作台（可视化动态编排 + 原生 HCL 源码）**：
   - **可视化动态编排模式（Visual Builder）**：
     - 基于结构化 `JobSpec` JSON 模型提供嵌套式动态卡片编辑，左侧增删配置块，右侧实时渲染标准缩进的 Nomad HCL 预览，最终统一以标准 HCL 提交：
       - **Job 级**：基本信息（Job ID、Namespace、类型 `service`/`batch`/`system`/`sysbatch`、Datacenters、Priority）、`periodic` 定时调度、`update` 滚动发布策略；
       - **Group 级（支持动态增删多个）**：副本数 `count`、`network`（网络模式与动态端口映射）、`volume`（Host Volume / CSI 卷声明）、`service`（Nomad / Consul 服务注册及 HTTP/TCP 健康检查）、`restart` 重启策略；
       - **Task 级（每个 Group 下支持动态增删多个）**：驱动配置（`docker` / `exec` / `raw_exec`、镜像、命令、参数、端口）、`env` 动态键值对、`volume_mount` 卷挂载映射、`resources`（CPU/内存）、`vault` 与 `identity`（Workload Identity 取密）、`template`（配置文件与机密渲染模板）。
     - **跨字段联动防呆**：`volume_mount` 下拉联动当前 Group 已声明的 `volume`（声明 Host Volume 时联动展示目标集群 Client 节点已配置的 Host Volume 列表）；`service.port` 与 Task 端口下拉联动当前 Group `network` 已定义的端口名；`vault` / `identity` 下拉联动该 Nomad 集群在「集群联动」中已打通的 Vault Role。
     - **高级 HCL 兜底槽位**：Job、Group、Task 卡片底部各提供折叠式「附加原生 HCL 片段」输入框，少量冷门参数可直接填写并在渲染时原样拼接进对应块，无需为此放弃可视化编辑。
   - **原生 HCL 源码模式**：基于 CodeMirror 6 提供完整 HCL 语法高亮、模板加载、一键调用 `/v1/jobs/parse` 与 `/v1/validate/job` 校验，满足任意复杂 HCL2 语法需求。
   - **双模式切换与防丢规则**：
     - **可视化 → HCL（无损切换）**：随时一键转为 HCL 源码继续编辑高级语法；
     - **已保存可视化 Job 二次编辑**：`job_templates` 与 `job_revisions` 双存 `edit_mode`、`form_spec_json` 与 `hcl_content`，重新编辑或回滚历史版本时直接还原可视化卡片状态；
     - **外部/手写 HCL → 可视化（受控反解）**：调用后端 `parse-to-visual` 接口（底层经 Nomad `/v1/jobs/parse` 转为标准 Job JSON），将常用块映射回可视化表单；若检测到注释或表单未覆盖的高级块（如自定义 `affinity`、`scaling`、`device`），弹窗明确列出未覆盖项与变更风险，经管理员确认后再切入可视化模式。
   - **Docker Compose 导入**：粘贴或上传 `docker-compose.yml`，由后端使用纯 Go（`gopkg.in/yaml.v3`）解析转换（不依赖控制面宿主机安装 Docker CLI），同时产出标准 HCL 与可视化 `JobSpec`（支持导入后进入可视化编排或直接以 HCL 模式审阅修改）。支持转换字段白名单为：`image`、`ports`、`volumes`（bind 与命名卷）、`environment`、`command`、`entrypoint`、`deploy.replicas`、`deploy.resources.limits.{cpus,memory}`（兼容 `cpus`/`mem_limit`）；对 `build`、`depends_on`、`healthcheck`、`networks`、`configs`、`secrets`、`profiles` 等无原生等价结构的字段生成结构化警告并跳过。
3. **Plan 预览再提交与版本回滚**：提交前调用 `/v1/job/{id}/plan` 返回结构化 Diff（新增/修改/销毁的 Task Group 与资源调度预估），管理员确认后再执行提交，并自动记录一份快照（含 `edit_mode`、`form_spec_json` 与 `hcl_content`）到 `job_revisions` 支持后续对比与一键回滚。
4. **生命周期控制**：
   - **启动 / 恢复**：对已停止（`dead`）的 Job 一键重新提交/启动；
   - **停止（Stop）**：调用 `DELETE /v1/job/{id}` 保留历史定义；
   - **重启**：支持按 Job、Task Group 或单个 Allocation 触发滚动重启；
   - **彻底删除（Purge）**：调用 `DELETE /v1/job/{id}?purge=true`，UI 强制输入 Job 名二次确认。
5. **实时 Allocation 日志**：选择任意 Allocation 与 Task，支持切换 `stdout` / `stderr`、拉取尾部历史行与开启实时 Follow 流（后端对接 Nomad `/v1/client/fs/logs/{alloc_id}?follow=true` 经 **SSE** 推送至前端日志终端，支持关键字过滤与日志下载）。
6. **Job 导出**：支持单 Job 或整集群批量导出 `.nomad.hcl` 压缩包。

### 5.7 定时任务体系

使用 `robfig/cron/v3` 驱动平台级后台定时任务，所有任务均可在 Web 端修改 Cron 表达式、启停、配置参数、手动立即触发及查看执行历史：

| `job_key` | 默认周期 | 用途说明 |
| :--- | :--- | :--- |
| `cluster_health_check` | `*/5 * * * *`（每 5 分钟） | 巡检所有主机 SSH 连通性、Nomad/Vault 服务状态，并逐台直连节点同步 Raft Leader/Voter 与 Vault 节点级密封状态，刷新仪表盘健康总览 |
| `cert_expiry_check` | `0 8 * * *`（每日 08:00） | 检查所有集群 CA（`clusters.ca_expires_at`）及节点 TLS 证书（`cluster_nodes.cert_expires_at`）剩余有效期，小于阈值（默认 30 天）在仪表盘高亮告警 |
| `vault_auto_unseal_watch` | `*/2 * * * *`（每 2 分钟） | 扫描开启 `auto_unseal_by_deck` 的 Vault 集群，逐台直连节点 `api_addr` 探测，若发现节点处于 Sealed 状态则自动通过 API 解封并记入审计日志 |
| `raft_snapshot_backup` | `0 3 * * *`（每日 03:00） | 对已启用的 Nomad / Vault 集群执行 Raft Snapshot 导出（走原生 HTTP API `/v1/operator/raft/snapshot` 与 `/v1/sys/storage/raft/snapshot`），加密落盘并写入 `cluster_snapshots` 索引表，按保留份数自动轮转清理旧文件与记录 |
| `cleanup_audit_logs` | `0 2 * * *`（每日 02:00） | 清理超过保留天数（默认 90 天）的审计日志 |
| `cleanup_operation_logs` | `30 2 * * *`（每日 02:30） | 清理超过保留天数（默认 60 天）的运维任务步骤日志与 Cron 执行记录 |

> **自定义定时任务**：同时支持管理员新增自定义定时任务（支持类型：指定集群 Raft 快照、指定节点/集群 Doctor 体检、指定 Nomad 集群 Job 全量导出备份）。Nomad 业务层的 Periodic Job 归口在「Job 管理」页面展示与触发，与平台运维定时任务职责清晰分离。

### 5.8 审计日志与强制脱敏

- **全覆盖**：登录/登出/改密、SSH 密钥管理、节点增删与公钥推送、集群创建/部署/扩缩容/证书续期/凭据补录/配置修改/启停/升级/卸载/快照恢复、Vault 初始化/解封/策略与密钥操作、集群联动下发、Job 提交/启停/重启/Purge、定时任务修改与触发、迁移导出/导入、系统设置修改全部强制写审计。
- **关联追溯**：涉及异步运维任务的操作，审计记录直接关联 `operation_task_id`，管理员可在审计详情页一键展开查看每台节点的完整命令输出与回滚轨迹。
- **强制脱敏**：请求体、命令参数与输出摘要在入库前统一经脱敏器过滤（匹配 `token`、`password`、`passphrase`、`secret`、`private_key`、`unseal_key`、`gossip_key`、`authorization` 等键及敏感 CLI 参数），全部替换为 `<redacted>`。

### 5.9 环境迁移（导出与导入还原）

采用**口令加密的可移植迁移包（`.ndbundle`）**，实现跨机器灾备重建与环境一键复制，消除直接拷贝 SQLite 与 `master.key` 的耦合风险（大体积 Raft 快照文件不打入迁移包，按需在快照管理页单独下载归档）：

1. **导出范围（Web 端可按需勾选）**：
   - **核心配置（必选）**：`system_settings`、`ssh_keys`、`nodes`、`clusters`、`cluster_nodes`、`vault_secrets_custody`、`cluster_integrations`、`job_templates`、`cron_jobs`。
   - **可选历史数据**：`admins`、`job_revisions`、`audit_logs`、`operation_tasks`、`cron_job_runs`。
2. **跨实例重加密协议**：
   - **导出**：服务端使用当前环境的 `master.key` 解密所有敏感列（SSH 私钥、集群 CA 与客户端私钥、Gossip 密钥、Nomad Management Token、Vault Unseal Keys / Root Token / Admin Token、系统代理凭据等），拼装带 `format_version`、`exported_at` 与 `sha256` 校验头的 JSON，经管理员输入的**临时迁移口令**通过 **Argon2id 派生密钥 + AES-256-GCM** 整包加密输出 `.ndbundle` 文件。
   - **导入**：新环境上传 `.ndbundle` 并输入迁移口令 → 解密校验完整性 → 返回 **Dry-Run 预检报告**（格式版本、导出时间、各表条目数、冲突清单）→ 管理员选择还原策略：
     - `replace`（整库灾难恢复，推荐）：在单一 SQLite 事务内清空目标表并完整保留原 ULID 与外键关系还原；
     - `merge`（增量合并）：按外键依赖顺序（`ssh_keys` → `nodes` → `clusters` → `cluster_nodes` / `vault_secrets_custody` → `cluster_integrations` → `job_templates` / `cron_jobs`）导入并维护完整的 `old_id -> target_id` 映射表重写全部外键引用。当同名资源冲突时，支持「跳过」或「覆盖」；涉及强绑定的 `vault_secrets_custody` 与 `cluster_nodes` 仅跟随所属集群整组一致处理（所属集群跳过时自动跳过其从属记录），防止外键断裂或密钥错配。
   - **入库重加密与热重载**：所有敏感字段使用目标环境自身的 `master.key` 重新加密写入；提交事务后自动清空内存 SSH/API 客户端缓存、重新加载 `cron_jobs` 调度器、可选立即触发一次全量节点连通性探测，并写入审计日志。

### 5.10 Consul 可选扩展预留

为避免未来接入 Consul 时推倒重来，设计层面预留以下干净边界（`v1.0.0` 仅实现 Nomad 与 Vault）：

1. **驱动抽象**：定义 `driver.ClusterDriver` 接口（`Install`、`JoinNode`、`RemoveNode`、`Upgrade`、`RenewCerts`、`Uninstall`、`ServiceAction`、`Doctor`、`FetchLogs`、`Snapshot`、`RestoreSnapshot`），Nomad 与 Vault 各自注册实现，后续新增 `internal/consul` 实现同一接口即可接入。
2. **数据模型通用化**：`clusters.type`、`cluster_nodes.role` 与 `cluster_integrations.integration_type` 均为开放文本枚举，无需改表结构即可承载 Consul 集群与 `nomad_consul` 联动。
3. **Nomad 配置预留**：Nomad 集群配置模型中保留可选 `consul` 配置节与 `65-consul.hcl` 槽位，当前默认关闭。

---

## 6. HTTP API 与实时流规范设计

所有管理接口统一前缀 `/api/v1`（除登录与初始化接口外均需校验 Admin 登录态），运维探针暴露 `/healthz` 与 `/readyz`。

| 模块 | 核心接口 | 说明 |
| :--- | :--- | :--- |
| **认证与初始化** | `GET /api/v1/auth/status`<br>`POST /api/v1/auth/setup`<br>`POST /api/v1/auth/login`<br>`POST /api/v1/auth/logout`<br>`PUT /api/v1/auth/password` | 检查是否需初始化、首次创建管理员、登录/登出、修改密码 |
| **总览仪表盘** | `GET /api/v1/dashboard/summary` | 集群数量、节点在线率、Nomad Job 统计、Vault 密封状态、证书临期预警、近期运维任务与审计 |
| **SSH 密钥管理** | `GET/POST /api/v1/ssh-keys`<br>`POST /api/v1/ssh-keys/generate`<br>`PUT /api/v1/ssh-keys/{id}/default`<br>`DELETE /api/v1/ssh-keys/{id}` | 列表、导入、生成 Ed25519 密钥对、设为默认、删除（被主机引用时禁止删除） |
| **主机节点管理** | `GET/POST /api/v1/nodes`<br>`GET/PUT/DELETE /api/v1/nodes/{id}`<br>`POST /api/v1/nodes/{id}/push-key`<br>`POST /api/v1/nodes/{id}/test`<br>`POST /api/v1/nodes/{id}/reset-fingerprint` | 主机增删改查、一次性密码推送公钥、SSH 连通与环境探测、重置主机指纹 |
| **集群与成员编排** | `GET/POST /api/v1/clusters`<br>`GET/PUT/DELETE /api/v1/clusters/{id}`<br>`POST /api/v1/clusters/{id}/nodes`<br>`POST /api/v1/clusters/{id}/nodes/{node_id}/join`<br>`POST /api/v1/clusters/{id}/nodes/{node_id}/remove`<br>`POST /api/v1/clusters/{id}/deploy`<br>`POST /api/v1/clusters/{id}/upgrade/plan`<br>`POST /api/v1/clusters/{id}/upgrade`<br>`POST /api/v1/clusters/{id}/certs/renew`<br>`PUT /api/v1/clusters/{id}/credentials`<br>`POST /api/v1/clusters/{id}/uninstall/plan`<br>`POST /api/v1/clusters/{id}/uninstall`<br>`POST /api/v1/clusters/{id}/doctor` | 集群创建与纳管节点、单节点扩容 Join 与安全缩容 Remove、一键部署、滚动升级、节点证书一键续期、管理凭据补录/恢复、卸载、健康体检 |
| **集群 Raft 快照** | `GET /api/v1/clusters/{id}/snapshots`<br>`POST /api/v1/clusters/{id}/snapshots`<br>`GET /api/v1/clusters/{id}/snapshots/{snapshot_id}/download`<br>`POST /api/v1/clusters/{id}/snapshots/{snapshot_id}/restore`<br>`DELETE /api/v1/clusters/{id}/snapshots/{snapshot_id}` | 快照列表查询、手动创建加密快照、下载归档、带强确认的快照恢复、删除过期快照 |
| **单节点服务与日志** | `POST /api/v1/clusters/{id}/nodes/{node_id}/service/{start\|stop\|restart}`<br>`PUT /api/v1/clusters/{id}/nodes/{node_id}/config`<br>`GET /api/v1/clusters/{id}/nodes/{node_id}/logs/stream` (SSE) | 单节点服务启停重启、托管配置更新（临时目录校验+原子落位+回滚）、实时 `journalctl` 日志流 |
| **Vault 专有能力** | `POST /api/v1/vault/{cluster_id}/init`<br>`POST /api/v1/vault/{cluster_id}/unseal`<br>`PUT /api/v1/vault/{cluster_id}/custody`<br>`POST /api/v1/vault/{cluster_id}/custody/backup`<br>`GET/POST/DELETE /api/v1/vault/{cluster_id}/auth`<br>`GET/PUT/DELETE /api/v1/vault/{cluster_id}/policies/{name}`<br>`GET /api/v1/vault/{cluster_id}/kv/mounts`<br>`GET/PUT/DELETE /api/v1/vault/{cluster_id}/kv/{mount}/*` | 集群初始化并加密托管、单节点/全集群一键解封、自动解封开关、二次验密离线备份、Auth/Policy 管理、多引擎 KV 挂载查询与 Secret 读写 |
| **Nomad-Vault 联动** | `GET/POST/PUT/DELETE /api/v1/integrations`<br>`POST /api/v1/integrations/{id}/plan`<br>`POST /api/v1/integrations/{id}/apply`<br>`POST /api/v1/integrations/{id}/doctor`<br>`POST /api/v1/integrations/{id}/job-example` | 联动配置管理、变更预览（含 mTLS 冲突与入口高可用检测）、双向一键下发、四段式链路体检、测试 Job 生成 |
| **Nomad Job 管理** | `GET /api/v1/nomad/{cluster_id}/jobs`<br>`GET /api/v1/nomad/{cluster_id}/jobs/{job_id}`<br>`GET/POST/PUT/DELETE /api/v1/job-templates`<br>`POST /api/v1/nomad/{cluster_id}/jobs/render`<br>`POST /api/v1/nomad/{cluster_id}/jobs/parse-to-visual`<br>`POST /api/v1/nomad/{cluster_id}/jobs/compose-convert`<br>`POST /api/v1/nomad/{cluster_id}/jobs/validate`<br>`POST /api/v1/nomad/{cluster_id}/jobs/plan`<br>`POST /api/v1/nomad/{cluster_id}/jobs/apply`<br>`POST /api/v1/nomad/{cluster_id}/jobs/{job_id}/{start\|stop\|restart\|purge}`<br>`GET /api/v1/nomad/{cluster_id}/jobs/{job_id}/revisions`<br>`GET /api/v1/nomad/{cluster_id}/allocs/{alloc_id}/logs/stream` (SSE)<br>`GET /api/v1/nomad/{cluster_id}/jobs/export` | Job 查询与详情、Job 模板管理、可视化 Spec 渲染 HCL、HCL 受控反解为可视化 Spec、Compose 转换、校验/Plan/提交、启动/停止/重启/Purge、历史版本回滚、Allocation 实时日志流、批量导出 HCL |
| **运维任务追踪** | `GET /api/v1/operations`<br>`GET /api/v1/operations/{task_id}`<br>`GET /api/v1/operations/{task_id}/stream` (SSE) | 查看历史运维任务、逐节点步骤状态与实时终端输出流 |
| **定时任务** | `GET/POST/PUT/DELETE /api/v1/cron-jobs`<br>`POST /api/v1/cron-jobs/{id}/run`<br>`GET /api/v1/cron-jobs/{id}/runs` | 定时任务管理、启停与 Cron 修改、手动触发、执行历史查看 |
| **审计日志** | `GET /api/v1/audit-logs`<br>`GET /api/v1/audit-logs/{id}` | 多条件分页检索（时间、动作、资源、结果、关键字）与脱敏详情查看 |
| **环境迁移** | `POST /api/v1/migration/export`<br>`POST /api/v1/migration/import/preview`<br>`POST /api/v1/migration/import/apply` | 加密导出 `.ndbundle`、上传口令预检（Dry-Run）、事务导入还原 |
| **系统设置** | `GET/PUT /api/v1/settings`<br>`GET /api/v1/releases/{nomad\|vault}` | 全局系统参数管理、拉取官方/镜像源可用版本列表 |

---

## 7. Web 管理端 UI 规划

管理端采用简洁的深/浅色自适应控制台风格，所有操作闭环在浏览器内完成，无需人工 SSH 登录目标节点：

1. **首次初始化向导 / 登录页**：检测未初始化时引导创建 Admin 账号并生成默认 SSH 密钥；后续进入标准登录页。
2. **总览仪表盘（Dashboard）**：Nomad/Vault 集群健康卡、主机在线概览、Vault 密封与 TLS 证书到期告警、Nomad 运行中 Job/Alloc 计数、最近运维任务与审计动态。
3. **基础设施（Infrastructure）**：
   - **SSH 密钥库**：生成/导入/复制公钥、一键生成目标机配置命令、查看引用主机；
   - **主机节点**：主机列表、一键密码推公钥、SSH 探测（系统架构、免密 `sudo` 与 SELinux 状态展示与配置指引）、主机指纹管理。
4. **Nomad 集群**：
   - 集群向导（单机/多节点 Server+Client 拓扑、统一业务入口、TLS/Gossip/ACL 一键配置）；
   - 节点管理（安装、单节点扩容 Join 与安全缩容 Remove、启停重启、托管配置表单：Docker/CNI/Host Volume/Meta/TLS/Telemetry/UI、版本升级与滚动升级向导、节点证书一键续期、凭据应急恢复、Dry-Run 卸载、Doctor 体检）；
   - 快照管理子页（Raft 快照列表、手动创建、下载与恢复）；
   - 内嵌实时终端抽屉（经 SSE 查看 `journalctl -u nomad` 实时日志与部署/升级实时输出）。
5. **Vault 集群**：
   - Raft 集群部署向导（自动 CA/TLS 证书签发与统一业务入口配置）；
   - 初始化与密钥托管面板（一键初始化、逐节点密封状态展示、一键单节点/全集群解封、控制面自动解封开关、二次验密导出离线备份、凭据应急补录）；
   - 节点运维（单节点扩容 Join 与安全缩容 Remove、启停重启、滚动升级、节点证书一键续期、实时 `journalctl -u vault` 日志、Doctor 体检、Raft 快照列表/下载/恢复）；
   - Vault 管理子页（Auth 方法、Policy HCL 编辑器、多引擎 KV 浏览与 Secret 编辑）。
6. **集群联动（Integrations）**：Nomad ↔ Vault JWT Workload Identity 配置列表、Plan 预览、一键双向 Apply、可视化四段式链路体检图、一键生成示例 Job。
7. **Nomad Job 中心**：
   - Job 列表与详情（Allocation 状态、资源、事件、实时日志终端）；
   - 双模式 Job 创建/编辑工作台：可视化动态编排器（嵌套增删 `group`/`task`/`network`/`volume`/`volume_mount`/`service`/`env`/`template`/`vault` 块 + 跨字段联动下拉 + 附加原生 HCL 片段 + 右侧实时 HCL 预览）与原生 HCL CodeMirror 编辑器，支持模板保存、Compose 导入、受控反解、Validate → Plan Diff 预览 → Apply；
   - 启动/停止/重启/Purge、历史版本 Diff 与一键回滚、导出 HCL。
8. **运维任务中心（Operations）**：所有长耗时任务的时间线、逐节点步骤状态与可回放的完整终端日志。
9. **定时任务（Schedules）**：内置与自定义定时任务列表、Cron 表达式编辑、启停开关、立即执行与历史记录。
10. **审计日志（Audit Logs）**：按动作/资源/结果/时间筛选、查看脱敏操作摘要与关联的运维任务日志。
11. **环境迁移（Migration）**：向导式导出（勾选范围 + 设置加密口令下载 `.ndbundle`）与导入（上传 + 口令解密 → Dry-Run 冲突预检 → 选择 `replace`/`merge` 一键还原）。
12. **系统设置（Settings）**：下载模式（直连/中转）、镜像源与 HTTP/SOCKS5 代理、默认版本号、SSH 超时与并发度、日志与快照保留天数、管理员改密。

---

## 8. 一次性交付（`v1.0.0`）实施顺序与验收清单

本项目按单次完整发布（`v1.0.0`）推进，研发与联调按以下依赖顺序落地：

1. **底座层**：Go 工程骨架、TOML 配置、`master.key` 与 AES-256-GCM/Argon2id/TLS/SSH 密钥库、SQLite WAL 读写分离连接池与 Schema 迁移、Admin 认证（含 `token_version`）与 Setup Wizard、审计脱敏中间件。
2. **远端执行与任务引擎**：纯 Go SSH/SFTP 连接池、TOFU 指纹校验、幂等一键推公钥、SELinux/免密 `sudo` 探测、控制面预解压中转下载与 SHA256 校验、异步长任务队列（含集群互斥锁、崩溃恢复与 SSE 实时日志推流）。
3. **Vault 驱动与托管解封**：Vault 集群部署（TLS + Raft + `disable_mlock`）、初始化与加密托管（含专用运维 Token 派生）、节点级 API 一键解封与自动解封巡检、单节点扩缩容与证书续期、滚动升级与自动回滚、Raft 快照管理、Auth/Policy/多引擎 KV 管理、Doctor 体检。
4. **Nomad 驱动与集群联动**：Nomad 单机/集群部署（按角色区分 `nomad`/`root` 运行用户、专属 SAN 证书、Gossip/ACL）、临时目录校验+原子落位配置管理、单节点扩缩容与证书续期、滚动升级与自动回滚、Nomad-Vault JWT 双向 TLS 信任联动与四段式体检、Consul 扩展接口预留。
5. **Nomad Job 中心**：Job 列表/详情、可视化动态编排与 HCL 渲染/受控反解、原生 HCL 编辑、纯 Go Compose 转换、模板管理、Validate/Plan/Apply、启停重启与 Purge、版本回滚、Allocation SSE 实时日志流、HCL 导出。
6. **平台运营闭环**：定时任务（含节点级健康巡检、CA/节点证书告警、自动解封巡检、Raft 快照登记与轮转、日志清理）、加密迁移包（`.ndbundle`）导出/预检/外键一致导入还原、系统设置。
7. **Web 管理端与单二进制打包**：React + Tailwind 全套管理端页面、`go:embed` 静态资源嵌入、Makefile 与 systemd/Docker 部署产物。

### 端到端核心验收场景

- [ ] **零配置启动与鉴权**：全新空目录启动 `nomad-deck`，自动生成 `master.key` 与 SQLite，浏览器完成 Setup Wizard 创建管理员并生成默认 SSH 密钥；验证改密/登出后旧 Cookie 经 `token_version` 即时失效。
- [ ] **节点纳管**：添加 3 台 Linux 主机（验证手动粘贴公钥与临时密码幂等推公钥两种方式），完成 SSH 连通性、架构、免密 `sudo` 与 SELinux 状态探测。
- [ ] **Vault 集群全流程**：在 UI 一键部署 3 节点 TLS + Raft Vault 集群 → 一键初始化并验证 Unseal Keys/Root Token/派生 Admin Token 加密托管（节点磁盘无明文密钥）→ 重启某台 Vault 节点验证单节点状态展示与控制面一键解封/自动解封生效 → 验证单节点扩容 Join、证书一键续期、安全缩容 Remove 与滚动升级（含故障回滚演练）→ 实时 SSE 查看 `journalctl` 日志与 Raft 快照创建/下载。
- [ ] **Nomad 集群全流程**：在 UI 部署 3 节点 Nomad 集群（验证纯 Server 运行于 `nomad` 用户、Client 运行于 `root` 用户，含 Docker/CNI/Host Volume 配置与专属 SAN TLS 证书）→ 启停重启单节点与实时 SSE 日志查看 → 验证单节点扩容 Join、证书一键续期、安全缩容 Remove 与滚动升级/自动回滚演练 → 验证同集群并发操作互斥拦截 → 运行 Doctor 体检全绿。
- [ ] **Nomad + Vault 联动**：在 Nomad 与 Vault 均启用自签 TLS 的前提下创建联动配置 → Plan 预览（验证 mTLS 冲突检测与单点入口告警）→ Apply 一键双向打通（含 Nomad CA 写入 Vault `jwks_ca_pem` 与滚动重启 Nomad）→ 四段式体检全绿 → 运行生成的测试 Job 成功从 Vault 指定 KV 引擎读取机密。
- [ ] **Job 全生命周期**：分别通过可视化动态编排器（动态增删 `group`/`task`/`volume`/`service`/`env`/`vault` 块与附加 HCL 片段、验证二次编辑回填）、纯 Go Compose 导入与原生 HCL 编辑器（含受控反解警告验证）提交 Job → Plan Diff 预览后下发 → 经 SSE 实时查看 Allocation 日志 → 停止/重新启动/修改版本并回滚/Purge 删除。
- [ ] **定时任务与审计**：手动触发健康巡检、CA/节点证书检查与 Raft 快照任务均成功；审计日志完整记录全部操作且无任何明文私钥/Token/Unseal Key 泄露。
- [ ] **环境迁移还原**：导出加密 `.ndbundle` → 在全新空实例启动 `nomad-deck`（不同 `master.key`）→ 上传迁移包完成 Dry-Run 预检并 `replace` 还原 → 还原后直接免重新配置连接全部主机、集群、触发 Vault 解封与管理 Nomad Job；并验证 `merge` 模式在存在同名冲突时外键引用保持一致。
