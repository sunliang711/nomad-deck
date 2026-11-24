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
| **加密与鉴权** | AES-256-GCM、Argon2id、`golang-jwt/jwt/v5`、`ProtonMail/go-crypto/openpgp` | 主密钥加密敏感凭据、口令加密迁移包、HTTPS `Secure`+`HttpOnly` Cookie/JWT + `token_version`/`session_epoch`、HashiCorp 官方 PGP 签名校验 |
| **定时任务** | `robfig/cron/v3` | 内置运维巡检、证书监控、自动解封巡检与 Raft 快照定时调度（支持防重入与漏执行策略） |
| **实时推送** | SSE（Server-Sent Events） | 统一用于单向实时推流（SSH 运维任务日志、`journalctl` 节点日志、Nomad Allocation 日志），绑定会话可即时撤销，规避跨站 WebSocket 劫持与反代 Upgrade 兼容问题 |
| **唯一 ID 与配置解析** | `oklog/ulid/v2`、`BurntSushi/toml`、`gopkg.in/yaml.v3`、`hashicorp/hcl/v2` | 时间有序 ID；极简 TOML 启动配置；纯 Go 解析 Compose YAML；官方 HCL2 AST 解析与 `hclwrite` 编码渲染 |
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

目标 Linux 主机由 NomadDeck 独占管理，**每台主机每种产品（Nomad / Vault / Consul）最多归属一个集群**（由数据库唯一约束 `UNIQUE(node_id, cluster_type)` 强制保证，防止跨集群覆盖目录与 systemd 单元）。所有托管配置文件首行统一写入 `# Managed by NomadDeck`，多文件配置目录采用**版本代际目录 + 原子软链切换**保证整组一致性：

- **Nomad 节点（`/opt/nomad-deck/nomad`）**
  - 二进制版本目录：`/opt/nomad-deck/nomad/bin/versions/nomad-<ver>`，原子软链 `/opt/nomad-deck/nomad/bin/nomad` 与 `/usr/local/bin/nomad`
  - 配置代际目录：`/opt/nomad-deck/nomad/etc/releases/<gen>/`，经 `nomad config validate` 整目录校验通过后，由原子软链 `/opt/nomad-deck/nomad/etc/nomad.d` 切换指向生效代际：
    - `10-base.hcl`（datacenter、region、bind/advertise、server/client 角色与 `retry_join`、Gossip 加密、ACL）
    - `30-tls.hcl`（集群 TLS 证书配置，显式配置 `http`、`rpc`、`verify_server_hostname`、`verify_https_client`）
    - `35-ui.hcl`（Nomad 原生 UI 开关与跨链接）
    - `40-telemetry.hcl`（Prometheus 指标配置）
    - `60-vault.hcl`（Vault Workload Identity 联动配置）
    - `65-consul.hcl`（预留：Consul 联动配置）
    - `70-host-volume-<name>.hcl`（Client Host Volumes）
    - `72-client-meta.hcl`（Client 调度标签）
    - `80-docker.hcl`、`81-raw-exec.hcl`、`82-driver-denylist.hcl`、`83-cni.hcl`
  - 证书目录：`/opt/nomad-deck/nomad/etc/tls/`
  - 数据与卷目录：`/opt/nomad-deck/nomad/data/`、`/opt/nomad-deck/nomad/volumes/`
  - 操作锁标记：`/opt/nomad-deck/.op.lock`（记录当前远端任务 `remote_op_id` 与 PID，用于控制面崩溃重启后核对远端在途命令）
  - systemd 单元：`/etc/systemd/system/nomad.service`（纯 Server 节点以低权系统用户 `nomad` 运行；含 Client 角色的 `client` / `server_client` 节点以 `root` 运行，以满足 cgroups、CNI 网络命名空间、Host Volume 挂载与 Docker socket 权限要求）
- **Vault 节点（`/opt/nomad-deck/vault`）**
  - 二进制版本目录：`/opt/nomad-deck/vault/bin/versions/vault-<ver>`，原子软链 `/opt/nomad-deck/vault/bin/vault` 与 `/usr/local/bin/vault`
  - 配置与证书：`/opt/nomad-deck/vault/etc/config.hcl`（Raft 模式下显式配置 `disable_mlock = true`、`api_addr` 与 `cluster_addr`）、`/opt/nomad-deck/vault/etc/tls/{ca.crt,server.crt,server.key}`
  - 数据目录：`/opt/nomad-deck/vault/data/raft/`
  - systemd 单元：`/etc/systemd/system/vault.service`（以低权系统用户 `vault` 运行并显式设置 `LimitCORE=0` 禁止 core dump；因 Raft 模式启用 `disable_mlock = true`，Vault 主机部署预检要求禁用 Swap 或采用明确批准的加密 Swap；不安装本地明文自动解封单元，解封由 NomadDeck 控制面通过 API 完成）

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
| `key` | TEXT PK | 配置键（如 `release.mirror_url`、`release.download_mode`、`release.pgp_public_key`、`ssh.timeout_sec`、`ssh.max_concurrency`、`proxy.url`、`audit.retention_days`、`ops.retention_days`、`snapshot.dir`、`auth.session_ttl_hours`、`auth.session_epoch`、`cron.timezone`、`defaults.nomad_version`、`defaults.vault_version`） |
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
| `swap_enabled` | INTEGER | 探测得到的宿主机 Swap 启用状态（`0` 已禁用 / `1` 已启用，用于 Vault 节点安全预检） |
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
| `tls_enabled` | INTEGER | 是否开启集群 TLS（生产集群默认且强制为 `1`） |
| `tls_config_json` | TEXT | 显式 TLS 配置（Nomad 区分 `http`/`rpc`/`verify_server_hostname`/`verify_https_client`；含非生产环境的 `allow_insecure_http` 显式开关与 TLS 终止模式说明） |
| `ca_cert_pem` | TEXT | 集群统一 CA 证书（PEM，CA 轮换期间包含新旧重叠 CA 链） |
| `ca_key_encrypted` | TEXT | 加密存储的集群 CA 私钥（用于签发新扩容节点与续期证书） |
| `ca_expires_at` | TEXT | 集群 CA 证书到期时间（供证书临期巡检使用） |
| `client_cert_pem` | TEXT | 控制面专用客户端 TLS 证书（Nomad 开启 `verify_https_client` 时用于 mTLS 鉴权） |
| `client_key_encrypted` | TEXT | 加密存储的控制面专用客户端 TLS 私钥 |
| `client_cert_expires_at` | TEXT | 控制面客户端 TLS 证书到期时间（纳入临期巡检与续期范围） |
| `gossip_key_encrypted` | TEXT | 加密存储的 Nomad Gossip 密钥（16/32 字节 Base64） |
| `public_api_url` | TEXT | 集群对外统一业务入口（如 LB/VIP/域名，优先用于 Nomad ↔ Vault 联动的 `jwks_url` 与 `vault.address`） |
| `api_endpoints_json` | TEXT | 控制面访问该集群的故障切换 HTTP API 入口列表（逐节点直连操作仍优先使用 `cluster_nodes.api_addr`） |
| `admin_token_encrypted` | TEXT | 加密存储的管理 Token（Nomad Management Token；Vault 日常管理 Token 见托管表） |
| `init_state` | TEXT | 集群初始化状态（`uninitialized` / `init_in_doubt` / `initialized`；在调用 Init/Bootstrap 前先置为 `init_in_doubt`，持久落库后置为 `initialized`） |
| `maintenance_mode` | INTEGER | 集群维护/隔离模式（`0` 正常 / `1` 维护或待核对，期间暂停自动巡检与自动解封） |
| `maintenance_reason` | TEXT | 维护/隔离原因（如 `snapshot_restore`、`needs_reconcile`、`manual_maintenance`） |
| `config_json` | TEXT | 集群级默认配置（如 Nomad `job_gc_threshold`、Telemetry、UI、Edition；Vault API/Cluster 端口策略） |
| `health_status` | TEXT | `healthy` / `degraded` / `sealed` / `uninitialized` / `unreachable` |
| `created_at` / `updated_at` | TEXT | 时间戳 |

### 4.6 `cluster_nodes`（集群成员角色表）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | TEXT PK | ULID |
| `cluster_id` | TEXT FK | 关联 `clusters.id` |
| `cluster_type` | TEXT | 冗余存储所属集群类型（`nomad` / `vault` / `consul`），用于强约束单机单实例目录隔离 |
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

> 唯一约束：`UNIQUE(cluster_id, node_id)` 与 `UNIQUE(node_id, cluster_type)`。同一台主机可同时加入一个 Nomad 集群和一个 Vault 集群，但每种产品在同一主机上最多归属一个集群，杜绝固定目录布局下的跨集群覆盖。

### 4.7 `vault_secrets_custody`（Vault 密钥加密托管表）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `cluster_id` | TEXT PK FK | 关联 `clusters.id`（`type='vault'`） |
| `initialized` | INTEGER | `0` / `1` |
| `key_shares` | INTEGER | Shamir 分片总数（默认 `5`） |
| `key_threshold` | INTEGER | 解封阈值（默认 `3`） |
| `seal_generation` | INTEGER | 密封/Rekey 代际号（默认 `1`，用于快照恢复前校验解封材料是否匹配） |
| `unseal_keys_encrypted` | TEXT | AES-256-GCM 加密的 Unseal Keys JSON 数组 |
| `root_token_encrypted` | TEXT | AES-256-GCM 加密的 Root Token（仅作托管与紧急兜底，禁止日常静默回退使用） |
| `admin_token_encrypted` | TEXT | AES-256-GCM 加密的专用运维 Admin Policy Token（周期性可续租 Token，供日常 API 与集群联动使用） |
| `admin_token_expires_at` | TEXT | 专用运维 Token 到期时间（由定时任务自动续租与临期告警） |
| `auto_unseal_by_deck` | INTEGER | 是否开启“控制面自动解封”（升级后及定时巡检发现 Sealed 时自动调用 API 解封） |
| `unseal_suppressed_reason` | TEXT | 自动解封抑制原因（如 `manual_seal` / `incident_lock` / `snapshot_restore`，非空时禁止自动解封） |
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
| `auth_path` | TEXT | 目标 Vault 上的 JWT Auth Mount 路径（默认按 Nomad 集群名隔离，如 `jwt-nomad-<cluster>`） |
| `config_json` | TEXT | 联动参数（`role_name`、`policy_name`、`secret_paths`、`aud`、`bound_claims`、`ttl`、`jwks_url`、`jwks_mode`、自定义 Policy HCL 等） |
| `status` | TEXT | `draft` / `applied` / `drifted` / `failed` |
| `last_doctor_json` | TEXT | 最近一次四段式全链路体检结果快照 |
| `last_applied_at` | TEXT | 最近一次下发时间 |
| `created_at` / `updated_at` | TEXT | 时间戳 |

> 唯一与归属约束：`UNIQUE(target_cluster_id, auth_path)`（防止多个 Nomad 集群复用同一 Vault JWT Auth Mount 互相覆盖 `jwks_url`）；Nomad Community 版每个 `source_cluster_id` 仅允许绑定一个生效中的 `nomad_vault_jwt` 目标集群（匹配社区版单 `vault {}` 块限制），删除 Profile 时仅清理归属该 Profile 的资源。

### 4.9 `job_templates` 与 `job_revisions`（Nomad Job 模板与版本历史）
- `job_templates`：`id`、`cluster_id`（可空表示跨集群通用模板）、`name`、`job_id`、`namespace`、`edit_mode`（`visual` / `hcl`）、`renderer_version`、`form_spec_json`（可视化动态编排结构 JSON，可空）、`hcl_content`、`hcl_sha256`、`source_type`（`visual` / `hcl` / `compose` / `imported`）、`description`、`created_at`、`updated_at`。
- `job_revisions`：`id`、`cluster_id`、`namespace`、`job_id`、`revision_no`、`edit_mode`（`visual` / `hcl`）、`renderer_version`、`form_spec_json`（可空）、`hcl_content`、`hcl_sha256`、`remote_job_version`、`eval_id`、`submit_status`（`submitted` / `in_doubt` / `confirmed` / `failed`）、`plan_summary`、`submitted_by`、`created_at`（支持现网漂移检测、版本对比、按权威表示回填与一键回滚）。

### 4.10 `operation_tasks` 与 `operation_task_steps`（异步运维任务与步骤追踪）
- `operation_tasks`：`id`、`action`（如 `nomad.install`、`nomad.upgrade`、`vault.init`、`vault.unseal`、`cluster.node_join`、`cluster.node_remove`、`cluster.cert_renew`、`integration.apply`、`cluster.uninstall`、`snapshot.restore`）、`target_type`、`target_id`、`remote_op_id`（写入目标机 `/opt/nomad-deck/.op.lock` 的幂等标识）、`intent_json`（结构化执行意图与步骤检查点，用于崩溃后核对，不含明文凭据）、`status`（`pending` / `running` / `success` / `failed` / `rolled_back` / `interrupted` / `needs_reconcile` / `cancelled`）、`params_redacted_json`、`triggered_by`、`started_at`、`finished_at`、`error_message`。
- `operation_task_steps`：`id`、`task_id` FK、`step_order`、`node_id`（可空）、`name`、`status`、`log_path`（经流式脱敏后的步骤执行日志路径）、`exit_code`、`started_at`、`finished_at`、`error_message`。

### 4.11 `cron_jobs` 与 `cron_job_runs`（平台定时任务与执行历史）
- `cron_jobs`：`id`、`job_key` UNIQUE、`name`、`cron_expr`、`overlap_policy`（`skip_if_running` / `queue_one`）、`misfire_policy`（`skip` / `run_once`）、`enabled`、`payload_json`、`is_builtin`、`last_run_at`、`last_status`、`next_run_at`、`updated_at`。
- `cron_job_runs`：`id`、`cron_job_id` FK、`run_key` UNIQUE（防同窗口重复触发）、`scheduled_for`、`operation_task_id`（关联实际异步任务，最终状态由真实任务结果驱动）、`trigger_type`（`scheduled` / `manual`）、`status`、`summary`、`detail_log`、`started_at`、`finished_at`。

### 4.12 `cluster_snapshots`（集群 Raft 快照索引表）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | TEXT PK | ULID |
| `cluster_id` | TEXT FK | 关联 `clusters.id` |
| `cluster_type` | TEXT | `nomad` / `vault` |
| `product_version` | TEXT | 快照生成时的 Nomad/Vault 版本（恢复前兼容性校验） |
| `seal_generation` | INTEGER | Vault 快照对应的密封/Rekey 代际号（Nomad 为空） |
| `credential_generation` | TEXT | 快照对应集群凭据代际标识（用于判断恢复后是否需要重验或重置控制面凭据） |
| `file_path` | TEXT | 加密落盘的快照文件路径 |
| `size_bytes` | INTEGER | 快照文件大小（字节） |
| `sha256` | TEXT | 密文文件 SHA256 校验值 |
| `trigger_type` | TEXT | `scheduled` / `manual` / `uploaded` |
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
2. **首次初始化安全（Setup Wizard + 一次性 Setup Token）**：
   - 当 `admins` 表为空时，控制面启动即生成一次性随机 **Setup Token**（仅输出至本地终端并写入权限 `0600` 的 `setup.token`，默认仅建议经本地或受控网络访问）。
   - `POST /api/v1/auth/setup` 在单一 `BEGIN IMMEDIATE` 事务内原子完成“校验并消耗 Setup Token → 断言 `COUNT(admins) == 0` → 创建首个管理员账号 → 生成默认 Ed25519 SSH 密钥对 → 写入默认下载模式与代理配置”，消除公网抢注与并发创建多个初始管理员的窗口。
3. **认证、CSRF、会话撤销与 SSE 生命周期**：
   - 密码采用 Argon2id 哈希；生产环境强制经 HTTPS 访问，登录态使用 `Secure + HttpOnly + SameSite=Lax` Cookie 承载短有效期 JWT（内置 `ver` 与 `epoch` 声明）。
   - 每次鉴权同时校验 `admins.token_version` 与全局 `system_settings["auth.session_epoch"]`；主动登出、修改密码递增 `token_version`，迁移导入递增 `auth.session_epoch`。
   - 所有变更类请求强制校验 `Origin`/`Referer` 及 CSRF Token（`X-CSRF-Token`），严格限制带凭据 CORS 仅允许同源或显式白名单。
   - 活跃 SSE 连接绑定 `(admin_id, token_version, session_epoch)`，登出、改密、会话过期或迁移导入时主动断开所有已建立的 SSE 流，并对单账号并发流数量、缓冲区大小与慢消费者实施上限保护。
   - 同一账号或来源 IP 连续失败达阈值（默认 5 次）触发指数退避锁定，并写入审计日志。
4. **敏感凭据与日志保护边界**：
   - 所有 API 响应永不返回明文私钥、Unseal Keys 或管理 Token（仅返回是否已配置、指纹、前缀或更新时间）；Vault 离线紧急备份与环境迁移导出均须二次复核当前管理员密码，且授权严格绑定当次导出参数与范围。
   - 涉及敏感凭据的 SSH/API 操作不记录原始输入输出（仅写结构化状态）；所有运维步骤日志在落盘和经 SSE 广播前均通过流式脱敏器过滤（匹配 Token、PEM 私钥、Vault 密钥、Bearer 头及常见密钥模式）。
   - 明确界定存储语义：Nomad Job 的 `hcl_content` 与 `form_spec_json` 按应用编排清单明文存库（并非 KMS 密库），UI 明确提示工作负载机密应通过 Vault Workload Identity 与 `template` 注入，避免在 `env` 中硬编码明文密码。
5. **SQLite 并发隔离、多维互斥锁与安全崩溃恢复**：
   - 数据库层采用读写分离连接池：写连接固定为单连接（`SetMaxOpenConns(1)`）并配置 `busy_timeout`，消除异步任务、定时巡检与审计写入同时争抢写锁导致的 `SQLITE_BUSY`。
   - 异步任务引擎维护两级互斥锁：**集群级锁（`cluster_id`）**与**主机产品级锁（`(node_id, cluster_type)`）**。跨集群任务（如 Nomad ↔ Vault 联动 Apply）按固定 `cluster_id` 字典序加锁避免死锁；单节点启停、配置更新、自动解封与快照恢复均纳入同一锁体系。
   - 控制面启动时扫描残留的 `running` 任务，将其标记为 `needs_reconcile` 并将关联集群置为 `maintenance_mode=1`（`maintenance_reason=needs_reconcile`），**不盲目释放锁**。管理员或恢复核对流程通过 SSH 校验目标机 `/opt/nomad-deck/.op.lock`（比对 `remote_op_id` 与在途进程 PID）及远端服务/Raft 实时状态后，再执行安全补偿与解锁。

### 5.2 纯 Go SSH + SFTP 远端执行与节点纳管

1. **密钥分发体验**：
   - 在「SSH 密钥」页可一键生成新 Ed25519 密钥对或导入已有私钥。
   - 在「添加主机」页支持两种免密配置方式：
     - **手动粘贴模式**：UI 提供公钥文本和一条可复制的 `mkdir -p ~/.ssh && ...` 初始化命令；
     - **一键推送公钥模式**：管理员在表单临时输入目标机 SSH 密码，后端通过 Go SSH 建立一次性连接，先检查 `~/.ssh/authorized_keys` 去重后再追加写入公钥并校验目录/文件权限（`0700`/`0600`）；若目标机启用 SELinux，自动尝试执行 `restorecon -Rv ~/.ssh`。**密码仅驻留内存、执行完即销毁、绝不落库和写审计**。
2. **连接安全、命令边界与环境探测**：
   - 首次连接采用 TOFU 策略记录目标机 Host Key 指纹；后续连接强制比对，如主机重装导致指纹变化，UI 明确告警并允许管理员确认后重置。
   - **提权命令与文件信任边界**：所有远端 SSH 命令均采用固定模板执行，严禁直接拼接未校验用户输入；版本号、路径、服务名、卷名与日志参数均通过严格白名单正则校验、POSIX 单引号转义并附加 `--` 选项终结符。通过 `sudo` 落位敏感文件前，先传入受保护的 `0700` staging 目录，由特权步骤校验其为普通文件、非符号链接且 SHA256 与预期一致，再执行同文件系统 `fsync` + `mv -Tf`（`rename`）原子替换。
   - 连通性测试同时自动探测：Linux 发行版、CPU 架构（`amd64`/`arm64`）、`systemctl`/`journalctl`/`tar`/`unzip` 可用性、当前用户免密 `sudo` 权限（`sudo_ready`）、SELinux 状态（`selinux_mode`）、Swap 启用状态（`swap_enabled`）以及 `/opt/nomad-deck` 可写性。
   - 若普通用户未配置免密 `sudo`，UI 展示明确的 `sudoers` 配置指引并在发起需提权的运维任务前拦截；若目标机处于 SELinux `enforcing` 或开启防火墙，在节点详情和部署前预检中给出上下文标签与端口放行提示（Nomad `4646/4647/4648`、Vault `8200/8201` 及业务端口）；Vault 节点预检发现未加密 Swap 开启时阻断生产部署或要求显式确认。
3. **可信校验、原子分发与下载中转**：
   - **PGP 签名 + SHA256 双重校验**：下载官方或镜像源 release 时，不仅比对 `*_SHA256SUMS`，还必须使用内置固定的 HashiCorp Release Security PGP 公钥（支持系统设置轮换）验证 `*_SHA256SUMS.sig` 签名，防止镜像源被篡改后同时替换二进制与摘要。控制面本地缓存按 `(product, version, os, arch, verified_sha256)` 严格隔离。
   - **双下载模式**（可在系统设置或单次任务中切换）：
     - `direct`：目标机拉取 release zip、校验经控制面验签后的预期 SHA256 并解压；
     - `relay`（推荐用于内网/离线集群）：由 NomadDeck 控制面统一下载、完成 PGP 验签与 SHA256 校验，并在**控制面本地预解压出目标二进制文件**后缓存，再经 SFTP 分发二进制给各目标节点——**同版本多节点安装或升级只需下载一次，且目标机无需访问外网也无需安装 `unzip`**。
4. **实时日志流**：所有 SSH 命令执行均实时捕获 `stdout`/`stderr`，经流式脱敏后写入步骤日志文件并通过绑定会话的内存 PubSub 经 **SSE** 实时推流到前端终端面板；查看节点服务日志时，通过参数校验后的固定模板执行 `journalctl -u nomad|vault -n <lines> [--since ...] [-f]` 并将流式输出经 SSE 转发到浏览器。

### 5.3 Nomad 节点与集群管理

1. **集群与节点安装编排**：
   - 支持**单机模式（Server+Client）**与**集群模式（推荐 3/5 台 Server + N 台 Client）**。
   - **TLS 强制边界与显式配置**：生产集群默认且强制启用 TLS，显式配置 `http`、`rpc`、`verify_server_hostname` 与 `verify_https_client`（禁止静默跳过证书验证）；仅在非生产实验环境允许显式勾选 `allow_insecure_http` 并持续展示安全警告。
   - 创建集群并选择节点角色后，点击「一键部署」进入异步运维任务：
     1. 自动签发集群统一 CA（记录 `ca_expires_at`）、控制面专用客户端证书（`cli.<region>.nomad`，记录 `client_cert_expires_at`）以及各节点 TLS 证书。节点证书强制包含 Nomad 专属 DNS SAN（Server 包含 `server.<region>.nomad`，Client 包含 `client.<region>.nomad`，同时包含 `localhost`、`127.0.0.1`、`::1`、节点 `advertise_addr`/域名以及 TLS 透传场景下的 `public_api_url` 主机名/IP）；同时自动生成 Gossip 加密密钥。
     2. 并发安装各节点 Nomad 二进制（版本目录 + 原子软链）、创建目录与 `nomad.service`：**纯 Server 节点以低权系统用户 `nomad` 运行，含 Client 角色（`client` / `server_client`）的节点以 `root` 运行**，以满足 cgroups、CNI、Host Volume 与 Docker socket 权限要求。
     3. 按角色渲染托管配置片段至首个配置代际目录并原子软链至 `nomad.d`（`10-base.hcl`、`30-tls.hcl`、`40-telemetry.hcl`、`80-docker.hcl` 等）。
     4. 如节点启用 CNI，自动下发 CNI Plugins 到 `/opt/cni/bin`、写入 bridge sysctl 与 `83-cni.hcl`。
     5. 先启动全部 Server 并等待 Leader 选出；调用 `/v1/acl/bootstrap` 前先将集群 `init_state` 置为 `init_in_doubt`，收到响应并加密落库 `clusters.admin_token_encrypted` 后再置为 `initialized`。若落库前网络中断导致集群停留在 `init_in_doubt`，禁止盲目重试，提供手动补录已有 Management Token 或按 `nomad acl bootstrap <reset-index>` 重置的受控恢复入口。
     6. 启动全部 Client，通过 Nomad HTTP API 验证所有节点进入 `ready` 状态。
2. **统一 Raft 仲裁门禁、扩缩容、证书轮换与配置变更**：
   - **统一仲裁门禁**：所有可能中断 Server 节点的变更入口（单节点/批量停服、重启、卸载、配置变更、缩容、升级）均强制经过统一 Raft 仲裁门禁——实时读取 `/v1/operator/raft/configuration` 与节点存活状态，确认剩余在线健康 Voter 数量仍满足多数派且复制状态正常后才放行（单机或显式维护操作须二次强确认）。
   - **单节点安全扩缩容**：
     - **扩容（Join）**：向已有集群新增 Server 或 Client 节点，自动签发新节点证书、分发二进制与配置、按需刷新既有 Server/Client 的 `retry_join` 配置并确认新节点加入 Raft 且追平或进入 `ready` 状态；
     - **缩容（Remove）**：摘除 Client 时先标记 `ineligible`、触发 `drain` 并**轮询等待疏散完全结束**；摘除 Server 时若目标为 Leader 则先执行安全移交/降级，校验剩余在线健康 Voter 满足仲裁后调用 `operator raft remove-peer` 移出成员，随后停止并清理该节点配置防止其借 `retry_join` 重新加入；**`server_client` 双角色节点严格按顺序同时执行 Client 疏散与 Server 移出两套流程**。
   - **完整证书生命周期**：支持节点证书与控制面客户端证书一键续期并滚动分发；支持受控 CA 轮换（先下发包含新旧双 CA 的信任链并同步更新联动 Vault 的 `jwks_ca_pem` → 滚动重签节点与客户端证书 → 验证全部切换后移除旧 CA）。
   - 配置托管管理（UI 表单化编辑）：Docker 驱动（privileged、volumes、image GC、私有仓库 auth）、CNI、raw_exec、Driver Denylist、Host Volumes（支持远端自动创建目录与防误删校验）、Client Meta、UI 跨链接与环境标签、Telemetry。
   - **版本代际原子配置变更**：构建全新完整配置代际目录 `/opt/nomad-deck/nomad/etc/releases/<gen>/` → 对整目录执行 `nomad config validate` → 校验通过后通过原子软链将 `nomad.d` 指向新代际 → 经仲裁门禁按顺序重启服务 → HTTP API 验活；若验活失败立即原子切回上一代际软链并重启恢复。
3. **版本升级、兼容矩阵与安全熔断**：
   - 升级前强制展示升级计划（Dry-Run 预览：当前版本、目标版本、跨小/大版本兼容性矩阵校验、节点执行顺序、保留版本数），并**自动执行一次升级前 Raft 快照与配置备份（校验通过后才允许继续）**。
   - 区分两类故障回滚策略：**新版本尚未初始化存储/变更数据格式前的启动失败**，可安全原子切回旧版二进制软链并重启恢复；**新版本已加入集群或可能已完成磁盘状态迁移后的异常（以及跨小版本/大版本升级）**，禁止自动降级二进制，立即熔断中止后续节点并引导管理员按升级前快照执行标准恢复。
   - 集群滚动顺序：**先所有非 Leader Server（逐台校验重新加入 Raft、在线 Voter 与复制进度恢复正常）→ 再 Leader Server → 最后按批次升级 Client（可选先 Drain 等待疏散完成再升级再取消 Drain）**。
4. **节点与集群 Doctor 体检**：检查 systemd 状态、运行用户与角色匹配性、二进制与元数据版本一致性、托管配置代际完整性、TLS 证书链与到期时间、HTTP API 可达性、Raft Leader 与在线 Voter 健康、Docker/CNI/Vault/Consul 集成状态，返回结构化检查项列表（`OK`/`WARN`/`FAIL` 及修复建议）。

### 5.4 Vault 节点与集群管理（含加密托管解封）

1. **安装与 Raft 集群部署**：
   - 支持单机与多节点 Raft HA 集群（推荐 3/5 节点）。
   - 生产集群强制启用 TLS（非生产环境须显式勾选 `allow_insecure_http` 并禁止在明文 HTTP 下启用托管自动解封）。由控制面自动签发集群统一 CA（记录 `ca_expires_at`）与各节点 SAN 证书（覆盖 `localhost`、`127.0.0.1`、`::1`、节点 `advertise_addr`/域名及 `public_api_url` 域名），写入 `config.hcl` 的 `disable_mlock = true`、`api_addr`、`cluster_addr`、`storage "raft"` 与 `retry_join`（附 `leader_ca_cert_file`），`vault.service` 设置 `LimitCORE=0`，部署预检核查宿主机 Swap 已禁用（或已批准加密 Swap）。
   - 启动服务后，Vault 默认处于未初始化、密封状态（HTTP 501）。
2. **初始化、Shamir 两阶段 Raft 加入与凭证生命周期**：
   - 管理员在 UI 点击「初始化集群」，设定 `key_shares`（默认 5）与 `key_threshold`（默认 3）。
   - **不可原子化窗口治理**：调用首节点 `/v1/sys/init` 前，先将集群 `init_state` 置为 `init_in_doubt`；收到响应并完成加密落库 `vault_secrets_custody`（及离线备份确认提示）后，才置为 `initialized` 并允许接入业务。若调用途中断网或崩溃导致集群处于 `init_in_doubt`，严禁盲目重试 Init，仅允许管理员补录已取得的密钥或针对确认无业务的新集群执行受控清理重建。
   - **Vault Shamir Raft 两阶段加入顺序（关键协议）**：
     1. 仅对首个节点执行 Init，随后直连首节点 `api_addr` 提交 Unseal Keys 完成解封使其成为 Active Leader；
     2. 其他节点**严禁单独执行 Init**：启动 `retry_join` 或显式调用 `/v1/sys/storage/raft/join` 进入 Shamir Join 挑战阶段 → 控制面直连该加入节点 `api_addr` **提交现集群的 Unseal Keys 进行解封以完成两阶段挑战** → 轮询确认该节点已加入 Raft Peers 列表、日志追平且 `sealed=false`、`raft_role=standby`、`is_voter=1`。
   - **派生专用运维 Token 与生命周期治理**：首节点解封后，控制面自动创建一个具备最小必需运维 Policy 的周期性可续租 Admin Token 存入 `vault_secrets_custody.admin_token_encrypted` 并记录 `admin_token_expires_at`，由内置定时任务在到期前自动续租并在续租异常时告警；**严禁在运维 Token 失效时静默回退使用 Root Token**，仅在管理员显式发起应急恢复并二次验密时动用托管 Root Token 重新签发。
3. **节点级托管解封与安全封存抑制**：
   - **手动一键解封与安全封存**：UI 展示每台 Vault 节点独立的 `is_sealed` 状态，提供单节点/全集群解封与手动安全封存（Seal）按钮；所有解封与探测始终直连目标节点 `cluster_nodes.api_addr`（不经统一 VIP/LB）。
   - **控制面自动解封与抑制机制**：仅在 `auto_unseal_by_deck=1`、集群未处于维护模式且 `unseal_suppressed_reason` 为空时生效。管理员手动 Seal 或触发安全封存锁定时自动写入 `unseal_suppressed_reason`（如 `manual_seal` / `incident_lock`），**阻止定时任务在 2 分钟内自动解封**，直至管理员显式解除抑制。节点磁盘不存放明文 Unseal Key 配置文件，配合禁用 Swap 与 `LimitCORE=0` 降低内存密钥落盘风险。
4. **日常运维、仲裁门禁、扩缩容、证书续期、升级与 KV v2 治理**：
   - 所有可能中断节点的操作（停服、重启、配置更新、缩容、升级、卸载）均统一经由 Raft 仲裁门禁，实时核查 `/v1/sys/storage/raft/configuration` 及在线健康 Voter 状态。
   - **单节点扩缩容与证书轮换**：
     - **扩容（Join）**：签发新节点证书、安装并写入 `retry_join`（严禁对新节点执行 Init）→ 触发/等待进入 Join 挑战阶段 → 直连新节点提交现集群 Unseal Keys 完成两阶段加入 → 验证追平并成为健康 `standby`；
     - **安全缩容（Remove）**：若目标为 Active 先执行 `step-down`，校验剩余在线健康 Voter 满足仲裁后调用 `/v1/sys/storage/raft/remove-peer` 移出节点，随后停服并清理配置防止其借 `retry_join` 重新加入；
     - **证书续期与 CA 轮换**：支持节点证书一键续期（Standby → Active 顺序滚动分发、生效并解封）与双 CA 重叠轮换（同步更新联动 Nomad 节点的 `vault-ca.crt`）。
   - **滚动升级与安全熔断**：升级前强制校验版本兼容矩阵并生成/验证升级前 Raft 快照；顺序为**逐台升级 Standby（升级 → 重启 → 直连自动解封 → 校验恢复健康 `standby` 且 `is_voter=1` 与复制正常）→ 全部 Standby 健康后对 Active 执行 `step-down` 再升级解封**；若新版本可能已修改存储状态则严禁自动降级回切旧二进制，立即熔断并引导按快照恢复。
   - **Vault 业务管理页（走 Vault HTTP API）**：Auth 方法管理、Policy HCL 在线编辑、**多引擎 KV 安全管理**（支持嵌套挂载路径，如 `apps/prod/kv/`，API 通过查询参数传递 `mount` 与 `path`；KV v2 读取携带 `version`，写入强制传 `cas` 防并发覆盖，冲突返回 409 要求刷新重读；明确区分 `soft-delete` 软删除、`destroy` 销毁版本与 `delete-metadata` 删除元数据三种动作）、证书到期检查与 `doctor` 诊断。

### 5.5 Nomad 与 Vault 集群级联动（Workload Identity / JWT）

在 UI 中通过「集群联动」模块将 Nomad 集群与 Vault 集群打通，严格执行资源归属隔离（`UNIQUE(target_cluster_id, auth_path)`，Nomad Community 版每个源集群仅允许绑定一个生效 Vault 集群），支持 **Plan 预览 → Apply 执行 → 四段式 Doctor 体检**：

1. **Plan 预检**：
   - 检查 Vault 是否已初始化且全节点已解封、派生运维 Token 有效性与权限、资源归属与唯一性约束（防止覆盖其他集群共用的 Auth Mount 或 `60-vault.hcl`）、Nomad 集群 JWKS 端点可达性；
   - **mTLS 冲突校验与公钥轮换方案**：若 Nomad 集群启用 `verify_https_client = true`，Plan 阶段明确拦截并提示冲突（Vault 拉取 `jwks_url` 不支持 mTLS 客户端证书），提供两种受控方案：① 关闭 `verify_https_client`（或在 JWKS 路径前置仅暴露 `/.well-known/jwks.json` 的受限只读代理以保留其余管理接口 mTLS）；② 切换为静态 `jwt_validation_pubkeys` 模式，并自动启用配套的**公钥重叠轮换任务**（提前拉取新公钥与旧公钥合并写入 Vault，待旧 JWT 过期后再移除退休公钥）；
   - **高可用入口检查**：优先采用 Nomad 与 Vault 集群的 `public_api_url`（VIP/域名）生成 `jwks_url` 与 `vault.address`；若多节点集群未配置统一入口而回退指向单台节点地址，Plan 阶段显式给出单点故障告警；
   - 展示待生成的 Vault Policy、完整 JWT Role JSON 与 Nomad `60-vault.hcl` 预览。
2. **Apply 编排**（按固定 ID 顺序同时获取 Nomad 与 Vault 集群互斥锁）：
   - **双向 TLS 信任配置**：
     - 将 Vault 集群 `ca.crt` 分发至 Nomad 集群全部节点 `/opt/nomad-deck/nomad/etc/tls/vault-ca.crt`；
     - 将 Nomad 集群 `ca.crt` 写入 Vault JWT Auth 配置的 `jwks_ca_pem` 字段（确保 Vault 验签 JWKS 信任 Nomad CA）。
   - 通过 Vault API 启用/校验归属该联动的独立 JWT Auth Mount（默认 `jwt-nomad-<nomad_cluster>`），写入配置（`jwks_url` + `jwks_ca_pem` 或 `jwt_validation_pubkeys`、`jwt_supported_algs=RS256,EdDSA`、`default_role`）；
   - **最小权限工作负载 Role 与 Policy**：
     - Policy 采用默认拒绝策略，仅按 KV v2 精确授权目标路径的 `/data/` 与 `/metadata/`；
     - JWT Role 显式配置完整必填字段：`role_type="jwt"`（避免默认 OIDC 类型）、`user_claim_json_pointer=true`、`user_claim="/sub"`（或按 Namespace 隔离的唯一身份声明，防止不同 Namespace 同名 Job 合并 Entity Alias）、**强制配置 `bound_claims`**（至少绑定 `nomad_namespace`，可选叠加 `nomad_job_id`/`nomad_task` 作为授权边界）、`bound_audiences`、`claim_mappings`（映射 `nomad_namespace`/`nomad_job_id`/`nomad_task`）与 `token_period`；
   - 向 Nomad 集群全部节点按角色下发 `60-vault.hcl`（Server 侧配置 `default_identity`，Client 侧配置 `address`/`ca_file`/`jwt_auth_backend_path`），经配置代际目录 `config validate` 通过后原子切换软链并经仲裁门禁**滚动重启（restart）**生效。
3. **四段式链路体检（Doctor）**：逐段校验 ① Nomad JWKS 可达性、TLS 证书链与签发 Audience → ② Nomad `60-vault.hcl` 指向的 Auth Path、Vault 地址与 CA → ③ Vault JWT Auth Mount、`jwks_url`/`jwks_ca_pem` 或静态公钥同步状态 → ④ Vault Role 完整字段（`role_type`、`bound_claims`、`user_claim_json_pointer`）、Policy 与 Secret Engine 挂载状态，并在测试验证阶段**执行真实端到端 JWT Login 换票取密验证**。
4. **示例 Job 生成**：在联动详情页可一键生成引用该 Role（匹配其 `bound_claims` 对应 Namespace/Job）与指定 KV 路径的测试 Nomad Job HCL，直接跳转到 Job 提交页验证端到端取密。

### 5.6 Nomad Job 全生命周期管理

通过 Nomad HTTP API（自动携带该集群加密托管的 Management Token，支持按集群多入口自动故障切换）实现全部操作：

1. **Job 列表与详情**：按集群、Namespace、类型（`service`/`batch`/`system`/`sysbatch` + Periodic 标识）、状态过滤；详情页展示 Task Groups、Allocations、部署状态、健康检查与事件时间线。
2. **双模式 Job 编排工作台（可视化动态编排 + 原生 HCL 源码）**：
   - **可视化动态编排模式（Visual Builder）**：
     - 基于结构化 `JobSpec` JSON 模型提供嵌套式动态卡片编辑，后端统一使用 **`hashicorp/hcl/v2/hclwrite`** 以 HCL Token 编码渲染标准 HCL（不做字符串拼接，天然正确处理引号、插值与 heredoc），最低覆盖以下全部层级的可视化动态块与配置项：
       - **顶层（Root 级）**：支持动态增删多个 `variable "<name>"` 块（`type`、`default`、`description`），供下游字段通过 `var.<name>` 引用，并在 Plan/Apply 时支持填写变量覆盖值（`hcl2.vars`）。
       - **Job 级**：基本信息（Job ID、Namespace、Region、Node Pool、类型 `service`/`batch`/`system`/`sysbatch`、Datacenters、Priority）、动态增删多个 `constraint` 块（`attribute`、`operator`、`value`）、`periodic` 定时调度、`update` 滚动发布策略。
       - **Group 级（支持动态增删多个）**：副本数 `count`、动态增删 `constraint` 块、`network` 块（`mode` 如 `bridge`/`host` + 动态增删多个 `port "<label>"` 的 `to`/`static`）、`volume "<name>"` 块（`type`、`source`、`read_only`）、`service` 块（`name`、`port`、`provider`、`address_mode` + 动态增删多个 `check` 的 `name`/`type`/`path`/`port`/`interval`/`timeout`）、`restart` 块（`attempts`、`interval`、`delay`、`mode`）、`reschedule` 块（`attempts`、`interval`、`delay`、`delay_function`、`unlimited`）、`update` 块（`max_parallel`、`health_check`、`min_healthy_time`、`healthy_deadline`、`auto_revert`）、`ephemeral_disk` 块（`size`、`migrate`、`sticky`）。
       - **Task 级（每个 Group 下支持动态增删多个）**：
         - **生命周期**：`lifecycle` 块（`hook` 如 `prestart`/`poststart`/`poststop`、`sidecar` 布尔开关），完整支持初始化任务与 Sidecar 容器；
         - **驱动与容器配置（`config`）**：支持 `docker` / `exec` / `raw_exec`；Docker 驱动覆盖 `image`、`force_pull`、`command`、`args`、`ports`、`network_mode`、`privileged`、`auth`、快捷 `volumes` 列表、动态增删多个结构化 `mount` 块（`type`、`source`、`target`、`readonly` 及嵌套 `bind_options { propagation }`）与 `logging` 块（`type` 及嵌套 `config { max-size, max-file }`）；
         - **环境与存储**：`env` 动态键值对、`volume_mount` 块（`volume`、`destination`、`read_only`、`propagation_mode`）；
         - **资源与日志**：`resources` 块（`cpu`、`memory`、`memory_max`）、`logs` 块（`max_files`、`max_file_size`）、`restart` 块（Task 级覆盖）；
         - **Task 级服务注册**：支持在 Task 级动态增删 `service` 块（`name`、`port`、`provider`、`address_mode` + 动态增删 `check` 的 `name`/`type`/`path`/`port`/`interval`/`timeout`）；
         - **机密与模板**：`vault` 块（`role`、`cluster`、`change_mode`、`env`）、动态增删多个 `identity` 块（`name`、`aud`、`file`、`ttl`）、动态增删多个 `template` 块（`destination`、`data`、`env`、`perms`、`change_mode`、`left_delimiter`/`right_delimiter`/`splay`）。
     - **跨字段联动防呆**：`volume_mount` 下拉联动当前 Group 已声明的 `volume`（声明 Host Volume 时联动展示目标集群 Client 节点已配置的 Host Volume 列表）；Group/Task 级 `service.port`、`check.port` 与 Task `config.ports` 下拉联动当前 Group `network` 已定义的端口名；`vault` / `identity` 下拉联动该 Nomad 集群在「集群联动」中已打通的 Vault Role。
     - **受限 AST 校验的附加 HCL 槽位**：Job、Group、Task 卡片底部各提供折叠式「附加原生 HCL 片段」输入框；后端使用 `hashicorp/hcl/v2` 将该片段解析为严格限定在对应层级的 AST，拒绝语法错误、闭合括号越界以及与可视化表单已托管属性/唯一块（如 `network`/`vault`/`identity`/`lifecycle`）冲突的定义；最终 Plan 与 Apply 始终针对完整渲染结果执行。
   - **原生 HCL 源码模式**：基于 CodeMirror 6 提供完整 HCL 语法高亮、模板加载、一键调用 `/v1/jobs/parse` 与 `/v1/validate/job` 校验，满足任意复杂 HCL2 语法需求。
   - **双模式权威源、漂移检测与受控反解**：
     - **可视化 → HCL（无损切换）**：随时一键转为 HCL 源码继续编辑高级语法；
     - **权威表示与现网漂移检测**：每次提交在 `job_revisions` 记录 `edit_mode`、`renderer_version`、`form_spec_json`、`hcl_content`、`hcl_sha256`、`remote_job_version` 与 `eval_id`。再次打开现网 Job 编辑前，先比对 Nomad 现网 Job 版本与最近一次本地记录：若现网曾被 CLI 或外部修改导致漂移，禁止静默回填旧 `form_spec_json`，须由管理员选择以现网 HCL 编辑或重新解析现网定义；
     - **外部/手写 HCL → 可视化（本地 HCL2 AST 先检 + 语义映射）**：调用 `parse-to-visual` 时，后端先通过 **`hashicorp/hcl/v2`** 解析原始 HCL 语法树，将顶层 `variable` 及上述受支持块直接映射进可视化模型，同时精确识别注释、`locals`、`dynamic` 块、复杂表达式及表单未覆盖的高级块并逐条列出位置与差异，再结合 Nomad `/v1/jobs/parse` 校验语义一致性；存在无法等价保留的语法时明确提示保留 HCL 模式或经管理员确认后转换。
   - **Docker Compose 导入**：粘贴或上传 `docker-compose.yml`，由后端使用纯 Go（`gopkg.in/yaml.v3`）解析转换（不依赖控制面宿主机安装 Docker CLI），同时产出标准 HCL 与可视化 `JobSpec`。明确转换映射与阻断规则：
     - 每个 Compose `service` 映射为一个独立 Nomad `group` + `task`；
     - 端口：`target` 映射为动态端口（`to = target`），`published:target` 映射为静态宿主端口（`static = published, to = target`），当 `replicas > 1` 且含静态端口时给出端口冲突告警；
     - 卷：`bind` 挂载映射为 Docker mount，命名卷强制要求管理员在向导中绑定目标 Host Volume / CSI 卷（禁止静默降级为无持久保证的节点临时目录）；
     - 关键字段阻断：对无原生等价的 `secrets`、`configs` 与仅含 `build` 无 `image` 的服务标记为**阻断级错误**（需人工在表单/HCL 补齐后方可提交），对 `depends_on`、`healthcheck`、`networks`、`profiles` 生成结构化告警。
3. **Plan-Apply 绑定、防并发覆盖与版本回滚**：
   - `jobs/plan` 返回结构化 Diff、本次审阅的内容摘要 `plan_hash`（渲染后 HCL + Namespace 的 SHA256）以及当前现网 `JobModifyIndex`；
   - `jobs/apply` 必须携带 `plan_hash` 与 `JobModifyIndex`，提交至 Nomad 时开启 `EnforceIndex=true` 防止审阅与提交之间被他人并发覆盖（冲突返回 409 要求重新 Plan）；提交前写入 `job_revisions`（`submit_status=in_doubt`），收到 Nomad 响应后回写 `remote_job_version`、`eval_id` 与 `confirmed`，支持提交途中断网时的状态对账。
4. **生命周期控制**：
   - **启动 / 恢复**：对已停止（`dead`）的 Job 一键重新提交/启动；
   - **停止（Stop）**：调用 `DELETE /v1/job/{id}` 保留历史定义；
   - **重启**：支持按 Job、Task Group 或单个 Allocation 触发滚动重启；
   - **彻底删除（Purge）**：调用 `DELETE /v1/job/{id}?purge=true`，UI 强制输入 Job 名二次确认。
5. **实时 Allocation 日志**：选择任意 Allocation 与 Task，支持切换 `stdout` / `stderr`、拉取尾部历史行与开启实时 Follow 流（后端对接 Nomad `/v1/client/fs/logs/{alloc_id}?follow=true` 经 **SSE** 推送至前端日志终端，支持关键字过滤与日志下载）。
6. **Job 导出**：支持单 Job 或整集群批量导出 `.nomad.hcl` 压缩包。

### 5.7 定时任务与 Raft 快照恢复体系

使用 `robfig/cron/v3` 驱动平台级后台定时任务，所有任务按统一配置时区（`cron.timezone`）调度，具备 `overlap_policy`（默认 `skip_if_running`，防止上次未结束或手工触发与定时任务重叠）、`misfire_policy`（重启后默认 `skip` 避免补跑风暴）与 `operation_task_id` 关联（最终执行结果由底层异步任务驱动）：

| `job_key` | 默认周期 | 用途说明 |
| :--- | :--- | :--- |
| `cluster_health_check` | `*/5 * * * *`（每 5 分钟） | 巡检所有主机 SSH 连通性、Nomad/Vault 服务状态，逐台直连节点同步 Raft Leader/Voter 与 Vault 节点级密封状态（跳过维护模式集群），刷新仪表盘健康总览 |
| `cert_expiry_check` | `0 8 * * *`（每日 08:00） | 检查所有集群 CA（`ca_expires_at`）、控制面客户端证书（`client_cert_expires_at`）及节点 TLS 证书（`cert_expires_at`）剩余有效期，小于阈值（默认 30 天）高亮告警 |
| `vault_token_renew` | `0 */6 * * *`（每 6 小时） | 巡检各 Vault 集群派生运维 Admin Token 的剩余有效期（`admin_token_expires_at`），临期自动续租；续租失败时立即告警且不静默回退 Root Token |
| `vault_auto_unseal_watch` | `*/2 * * * *`（每 2 分钟） | 扫描开启 `auto_unseal_by_deck`、未处于维护模式且 `unseal_suppressed_reason` 为空的 Vault 集群，逐台直连 `api_addr` 探测并自动解封 Sealed 节点 |
| `raft_snapshot_backup` | `0 3 * * *`（每日 03:00） | 对已启用的 Nomad / Vault 集群执行 Raft Snapshot 导出（**Nomad 使用 `GET /v1/operator/snapshot`，Vault 使用 `GET /v1/sys/storage/raft/snapshot`**），校验 HTTP 200 与流完整性后加密落盘并写入 `cluster_snapshots`（记录 `product_version`、`seal_generation`、`credential_generation`）；按保留份数轮转清理时与下载/恢复任务互斥 |
| `cleanup_audit_logs` | `0 2 * * *`（每日 02:00） | 清理超过保留天数（默认 90 天）的审计日志 |
| `cleanup_operation_logs` | `30 2 * * *`（每日 02:30） | 清理超过保留天数（默认 60 天）的运维任务步骤日志与 Cron 执行记录 |

> **Raft 快照安全恢复协议**：快照恢复通过独立异步状态机执行——① 校验快照 `product_version` 兼容性与 `seal_generation`（普通恢复使用 Nomad `PUT /v1/operator/snapshot` / Vault `POST /v1/sys/storage/raft/snapshot`；Vault `snapshot-force` 强制恢复独立授权并要求先核对控制面持有与快照匹配的 Unseal Keys）；② 集群进入 `maintenance_mode=1`（`snapshot_restore`），暂停变更操作、巡检与自动解封；③ 执行恢复并轮询等待 Leader 重选、Vault 节点重载/解封完成及所有 Raft Peers 追平；④ 恢复完成后自动重验托管凭据、Raft 成员及集群联动状态（若凭据或配置因回滚到旧快照而漂移，保持维护态并引导核对/补录凭据与重刷联动），全部通过后退出维护态。

> **自定义定时任务**：同时支持管理员新增自定义定时任务（支持类型：指定集群 Raft 快照、指定节点/集群 Doctor 体检、指定 Nomad 集群 Job 全量导出备份、静态 Vault JWKS 公钥同步）。Nomad 业务层的 Periodic Job 归口在「Job 管理」页面展示与触发，与平台运维定时任务职责清晰分离。

### 5.8 审计日志与强制脱敏

- **全覆盖**：登录/登出/改密、SSH 密钥管理、节点增删与公钥推送、集群创建/部署/扩缩容/证书续期与 CA 轮换/凭据补录/配置修改/启停/升级/卸载/维护态切换/快照恢复、Vault 初始化/解封/手动封存/策略与密钥操作、集群联动下发、Job 提交/启停/重启/Purge、定时任务修改与触发、迁移导出/导入与控制面激活、系统设置修改全部强制写审计。
- **关联追溯**：涉及异步运维任务的操作，审计记录直接关联 `operation_task_id`，管理员可在审计详情页一键展开查看每台节点的脱敏命令输出与回滚轨迹。
- **强制脱敏**：请求体、命令参数与实时日志流在落盘和推送前统一经脱敏器过滤（匹配 `token`、`password`、`passphrase`、`secret`、`private_key`、`unseal_key`、`gossip_key`、`authorization`、PEM 私钥块及敏感 CLI 参数），全部替换为 `<redacted>`。

### 5.9 环境迁移（导出与导入还原）

采用**口令加密的可移植迁移包（`.ndbundle`）**，实现跨机器灾备重建与环境一键复制，消除直接拷贝 SQLite 与 `master.key` 的耦合风险（大体积 Raft 快照文件不打入迁移包，支持在快照管理页下载可移植口令加密快照归档并在目标环境上传登记恢复）：

1. **导出范围（Web 端可按需勾选，完整维护依赖清单）**：
   - **核心配置（必选）**：`system_settings`、`ssh_keys`、`nodes`、`clusters`、`cluster_nodes`、`vault_secrets_custody`、`cluster_integrations`、`job_templates`、`cron_jobs`。
   - **可选历史数据**：`admins`、`job_revisions`、`audit_logs`、`operation_tasks`（勾选时强制连带导出 `operation_task_steps`）、`cron_job_runs`。
2. **跨实例重加密、维护屏障与双活防护协议**：
   - **导出二次验密**：导出包含全部生产级敏感凭据（SSH 私钥、集群 CA 与客户端私钥、Gossip 密钥、Nomad Management Token、Vault Unseal Keys / Root Token / Admin Token、代理凭据），**强制要求复核当前管理员登录密码**（授权仅绑定本次导出参数与范围），再使用管理员输入的临时迁移口令经 **Argon2id + AES-256-GCM** 整包加密输出 `.ndbundle`。
   - **导入预检绑定**：新环境上传 `.ndbundle` 并输入迁移口令 → 解密校验完整性 → 返回 **Dry-Run 预检报告**及一次性 `preview_token`（绑定包 SHA256、还原策略与当前数据库状态版本）；`import/apply` 强制校验 `preview_token` 防止包或目标库状态变化。
   - **全局维护屏障与还原策略**：执行 `import/apply` 前强制进入全局维护状态（拒绝新变更、暂停 Cron、断言无运行中 `operation_tasks`）：
     - `replace`（整库灾难恢复，推荐）：在单一 SQLite 事务内清空目标表并完整保留原 ULID 与外键关系还原，同时清理本机不存在对应文件的过期 `cluster_snapshots` 索引；
     - `merge`（增量合并）：按外键依赖顺序（`ssh_keys` → `nodes` → `clusters` → `cluster_nodes` / `vault_secrets_custody` → `cluster_integrations` → `job_templates` / `cron_jobs`）导入，维护完整的 `old_id -> target_id` 映射表，**不仅重写 SQL 外键，还按结构化规则重写 JSON 字段内嵌引用**（如 `cron_jobs.payload_json` 中的 `cluster_id`/`node_id`）；强绑定的 `vault_secrets_custody` 与 `cluster_nodes` 仅跟随所属集群整组一致处理。
   - **重加密、会话隔离与防双活安全接管**：所有敏感字段使用目标环境自身的 `master.key` 重新加密写入；事务提交时**强制递增全局 `auth.session_epoch` 并立即断开所有已建立的 SSE 流**（避免导入旧 `admins` 记录导致 `token_version` 回退而复活历史会话）；清空内存 SSH/API 客户端缓存后，**`replace` 还原默认保持 `cron_jobs` 与 `auto_unseal_by_deck` 处于暂停待命态**，避免源、目标两个控制面同时巡检与解封同一集群，待管理员下线旧控制面后手动点击「激活控制面」恢复自动调度，并全流程写入审计日志。

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
| **认证与初始化** | `GET /api/v1/auth/status`<br>`POST /api/v1/auth/setup`<br>`POST /api/v1/auth/login`<br>`POST /api/v1/auth/logout`<br>`PUT /api/v1/auth/password` | 检查是否需初始化、凭一次性 Setup Token 原子创建首个管理员、登录/登出（主动断开 SSE）、修改密码 |
| **总览仪表盘** | `GET /api/v1/dashboard/summary` | 集群数量、节点在线率、Nomad Job 统计、Vault 密封状态、证书临期预警、待核对任务与审计动态 |
| **SSH 密钥管理** | `GET/POST /api/v1/ssh-keys`<br>`POST /api/v1/ssh-keys/generate`<br>`PUT /api/v1/ssh-keys/{id}/default`<br>`DELETE /api/v1/ssh-keys/{id}` | 列表、导入、生成 Ed25519 密钥对、设为默认、删除（被主机引用时禁止删除） |
| **主机节点管理** | `GET/POST /api/v1/nodes`<br>`GET/PUT/DELETE /api/v1/nodes/{id}`<br>`POST /api/v1/nodes/{id}/push-key`<br>`POST /api/v1/nodes/{id}/test`<br>`POST /api/v1/nodes/{id}/reset-fingerprint` | 主机增删改查、一次性密码幂等推公钥、SSH 连通与环境探测（架构/sudo/SELinux/Swap）、重置主机指纹 |
| **集群与成员编排** | `GET/POST /api/v1/clusters`<br>`GET/PUT/DELETE /api/v1/clusters/{id}`<br>`POST /api/v1/clusters/{id}/nodes`<br>`POST /api/v1/clusters/{id}/nodes/{node_id}/join`<br>`POST /api/v1/clusters/{id}/nodes/{node_id}/remove`<br>`POST /api/v1/clusters/{id}/deploy`<br>`POST /api/v1/clusters/{id}/upgrade/plan`<br>`POST /api/v1/clusters/{id}/upgrade`<br>`POST /api/v1/clusters/{id}/certs/renew`<br>`POST /api/v1/clusters/{id}/ca/rotate`<br>`PUT /api/v1/clusters/{id}/credentials`<br>`POST /api/v1/clusters/{id}/reconcile`<br>`PUT /api/v1/clusters/{id}/maintenance`<br>`POST /api/v1/clusters/{id}/uninstall/plan`<br>`POST /api/v1/clusters/{id}/uninstall`<br>`POST /api/v1/clusters/{id}/doctor` | 集群创建与纳管节点、单节点扩容 Join 与安全缩容 Remove、一键部署、滚动升级、节点/客户端证书续期、CA 重叠轮换、管理凭据补录/恢复、崩溃后状态核对与解锁、维护模式开关、卸载、健康体检 |
| **集群 Raft 快照** | `GET /api/v1/clusters/{id}/snapshots`<br>`POST /api/v1/clusters/{id}/snapshots`<br>`POST /api/v1/clusters/{id}/snapshots/upload`<br>`GET /api/v1/clusters/{id}/snapshots/{snapshot_id}/download`<br>`POST /api/v1/clusters/{id}/snapshots/{snapshot_id}/restore`<br>`DELETE /api/v1/clusters/{id}/snapshots/{snapshot_id}` | 快照列表查询、手动创建加密快照、上传登记可移植快照归档、下载归档、状态机驱动的安全快照恢复（区分标准与 force 模式）、删除过期快照 |
| **单节点服务与日志** | `POST /api/v1/clusters/{id}/nodes/{node_id}/service/{start\|stop\|restart}`<br>`PUT /api/v1/clusters/{id}/nodes/{node_id}/config`<br>`GET /api/v1/clusters/{id}/nodes/{node_id}/logs/stream` (SSE) | 经仲裁门禁的单节点服务启停重启、托管配置更新（代际目录校验+原子软链+回滚）、实时 `journalctl` 日志流 |
| **Vault 专有能力** | `POST /api/v1/vault/{cluster_id}/init`<br>`POST /api/v1/vault/{cluster_id}/unseal`<br>`POST /api/v1/vault/{cluster_id}/seal`<br>`PUT /api/v1/vault/{cluster_id}/custody`<br>`POST /api/v1/vault/{cluster_id}/custody/backup`<br>`POST /api/v1/vault/{cluster_id}/custody/recover-token`<br>`GET/POST/DELETE /api/v1/vault/{cluster_id}/auth`<br>`GET/PUT/DELETE /api/v1/vault/{cluster_id}/policies/{name}`<br>`GET /api/v1/vault/{cluster_id}/kv/mounts`<br>`GET/PUT/DELETE /api/v1/vault/{cluster_id}/kv/item?mount=...&path=...` | 集群初始化并加密托管、单节点/全集群一键解封、手动安全封存（写入自动解封抑制）、自动解封开关、二次验密离线备份、应急签发运维 Token、Auth/Policy 管理、支持嵌套 Mount 路径与 CAS/区分删除语义的 KV 管理 |
| **Nomad-Vault 联动** | `GET/POST/PUT/DELETE /api/v1/integrations`<br>`POST /api/v1/integrations/{id}/plan`<br>`POST /api/v1/integrations/{id}/apply`<br>`POST /api/v1/integrations/{id}/doctor`<br>`POST /api/v1/integrations/{id}/job-example` | 联动配置管理、变更预览（含 mTLS 冲突、资源归属与入口高可用检测）、双锁双向一键下发、四段式体检与真实 JWT Login 验证、测试 Job 生成 |
| **Nomad Job 管理** | `GET /api/v1/nomad/{cluster_id}/jobs`<br>`GET /api/v1/nomad/{cluster_id}/jobs/{job_id}`<br>`GET/POST/PUT/DELETE /api/v1/job-templates`<br>`POST /api/v1/nomad/{cluster_id}/jobs/render`<br>`POST /api/v1/nomad/{cluster_id}/jobs/parse-to-visual`<br>`POST /api/v1/nomad/{cluster_id}/jobs/compose-convert`<br>`POST /api/v1/nomad/{cluster_id}/jobs/validate`<br>`POST /api/v1/nomad/{cluster_id}/jobs/plan`<br>`POST /api/v1/nomad/{cluster_id}/jobs/apply`<br>`POST /api/v1/nomad/{cluster_id}/jobs/{job_id}/{start\|stop\|restart\|purge}`<br>`GET /api/v1/nomad/{cluster_id}/jobs/{job_id}/revisions`<br>`GET /api/v1/nomad/{cluster_id}/allocs/{alloc_id}/logs/stream` (SSE)<br>`GET /api/v1/nomad/{cluster_id}/jobs/export` | Job 查询与详情、Job 模板管理、可视化 Spec 经 `hclwrite` 渲染 HCL、HCL 本地 AST 预检+受控反解、Compose 转换、校验/绑定 `plan_hash` 与 `JobModifyIndex` 的 Plan-Apply、启动/停止/重启/Purge、现网漂移检测与版本回滚、Allocation 实时日志流、批量导出 HCL |
| **运维任务追踪** | `GET /api/v1/operations`<br>`GET /api/v1/operations/{task_id}`<br>`GET /api/v1/operations/{task_id}/stream` (SSE) | 查看历史运维任务、逐节点步骤状态与实时脱敏终端输出流 |
| **定时任务** | `GET/POST/PUT/DELETE /api/v1/cron-jobs`<br>`POST /api/v1/cron-jobs/{id}/run`<br>`GET /api/v1/cron-jobs/{id}/runs` | 定时任务管理、启停与 Cron/防重入/漏执行策略修改、手动触发、关联 `operation_task_id` 的执行历史查看 |
| **审计日志** | `GET /api/v1/audit-logs`<br>`GET /api/v1/audit-logs/{id}` | 多条件分页检索（时间、动作、资源、结果、关键字）与脱敏详情查看 |
| **环境迁移** | `POST /api/v1/migration/export`<br>`POST /api/v1/migration/import/preview`<br>`POST /api/v1/migration/import/apply`<br>`POST /api/v1/migration/activate` | 二次验密加密导出 `.ndbundle`、上传口令预检（签发绑定 `preview_token`）、全局维护屏障下事务导入还原、迁移后显式激活控制面自动调度 |
| **系统设置** | `GET/PUT /api/v1/settings`<br>`GET /api/v1/releases/{nomad\|vault}` | 全局系统参数管理（含 PGP 公钥与时区）、拉取官方/镜像源可用版本列表 |

---

## 7. Web 管理端 UI 规划

管理端采用简洁的深/浅色自适应控制台风格，所有操作闭环在浏览器内完成，无需人工 SSH 登录目标节点：

1. **首次初始化向导 / 登录页**：检测未初始化时要求输入本机生成的一次性 Setup Token 引导创建 Admin 账号并生成默认 SSH 密钥；后续进入标准登录页。
2. **总览仪表盘（Dashboard）**：Nomad/Vault 集群健康卡、主机在线概览、Vault 密封/抑制告警、CA/节点/客户端证书到期告警、待核对异常任务提示、Nomad 运行中 Job/Alloc 计数、最近运维任务与审计动态。
3. **基础设施（Infrastructure）**：
   - **SSH 密钥库**：生成/导入/复制公钥、一键生成目标机配置命令、查看引用主机；
   - **主机节点**：主机列表、一键密码推公钥、SSH 探测（系统架构、免密 `sudo`、SELinux 与 Swap 状态展示及配置指引）、主机指纹管理。
4. **Nomad 集群**：
   - 集群向导（单机/多节点 Server+Client 拓扑、统一业务入口、显式 TLS/Gossip/ACL 一键配置）；
   - 节点管理（安装、单节点扩容 Join 与安全缩容 Remove、经仲裁门禁的启停重启、托管配置表单：Docker/CNI/Host Volume/Meta/TLS/Telemetry/UI、版本升级与滚动升级向导、节点/客户端证书续期与 CA 轮换、维护态与崩溃核对解锁、凭据应急恢复、Dry-Run 卸载、Doctor 体检）；
   - 快照管理子页（Raft 快照列表、手动创建、上传登记、下载与安全恢复向导）；
   - 内嵌实时终端抽屉（经 SSE 查看 `journalctl -u nomad` 实时日志与部署/升级实时输出）。
5. **Vault 集群**：
   - Raft 集群部署向导（自动 CA/TLS 证书签发、Swap 预检与统一业务入口配置）；
   - 初始化与密钥托管面板（一键初始化与 `init_in_doubt` 异常处置、逐节点密封状态展示、一键单节点/全集群解封与手动安全封存、自动解封开关与抑制解除、运维 Token 有效期与应急签发、二次验密导出离线备份、凭据应急补录）；
   - 节点运维（单节点扩容 Join 与安全缩容 Remove、经仲裁门禁启停重启、滚动升级、节点证书续期与 CA 轮换、实时 `journalctl -u vault` 日志、Doctor 体检、Raft 快照列表/上传/下载/标准及 force 恢复）；
   - Vault 管理子页（Auth 方法、Policy HCL 编辑器、支持嵌套挂载路径与 CAS 并发保护的多引擎 KV 浏览与 Secret 编辑）。
6. **集群联动（Integrations）**：Nomad ↔ Vault JWT Workload Identity 配置列表（含 `bound_claims` 权限边界配置）、Plan 预览、一键双向 Apply、可视化四段式链路体检图（含端到端 JWT Login 验证）、一键生成示例 Job。
7. **Nomad Job 中心**：
   - Job 列表与详情（Allocation 状态、资源、事件、实时日志终端）；
   - 双模式 Job 创建/编辑工作台：可视化动态编排器（覆盖顶层 `variable`、Job/Group 级 `constraint`/`update`、Group 级 `network`/`port`/`volume`/`service`/`check`/`restart`/`reschedule`/`ephemeral_disk`、Task 级 `lifecycle`（Sidecar）、Docker `config`（含 `mount`/`bind_options`/`logging`/`force_pull`/`network_mode`/`volumes`）、`env`/`volume_mount`/`resources`（含 `memory_max`）/`logs`/`service`/`check`/`vault`/`identity`/`template` 动态增删 + 跨字段联动下拉 + AST 校验的附加原生 HCL 片段 + 右侧实时 HCL 预览）与原生 HCL CodeMirror 编辑器，支持模板保存、现网漂移检测、Compose 导入（含阻断级校验）、本地 HCL2 AST 预检+受控反解、Validate → 绑定 `JobModifyIndex` 的 Plan Diff 预览 → Apply；
   - 启动/停止/重启/Purge、历史版本 Diff 与一键回滚、导出 HCL。
8. **运维任务中心（Operations）**：所有长耗时任务的时间线、逐节点步骤状态、崩溃后待核对任务操作与可回放的脱敏终端日志。
9. **定时任务（Schedules）**：内置与自定义定时任务列表、Cron 表达式与防重入/漏执行策略编辑、启停开关、立即执行与关联 `operation_task_id` 的历史记录。
10. **审计日志（Audit Logs）**：按动作/资源/结果/时间筛选、查看脱敏操作摘要与关联的运维任务日志。
11. **环境迁移（Migration）**：向导式导出（二次验密 + 勾选范围 + 设置迁移口令下载 `.ndbundle`）与导入（上传 + 口令解密 → Dry-Run 绑定预检 → 全局维护屏障下选择 `replace`/`merge` 一键还原 → 确认旧实例下线后一键「激活控制面」）。
12. **系统设置（Settings）**：下载模式（直连/中转）、镜像源与 PGP 验签公钥、HTTP/SOCKS5 代理、时区、默认版本号、SSH 超时与并发度、日志与快照保留天数、管理员改密。

---

## 8. 一次性交付（`v1.0.0`）实施顺序与验收清单

本项目按单次完整发布（`v1.0.0`）推进，研发与联调按以下依赖顺序落地：

1. **底座层**：Go 工程骨架、TOML 配置、`master.key` 与 AES-256-GCM/Argon2id/TLS/SSH 密钥库、SQLite WAL 读写分离连接池与 Schema 迁移、一次性 Setup Token + Admin 认证（`Secure` Cookie、CSRF/Origin 校验、`token_version`/`session_epoch`、SSE 会话绑定）、流式审计脱敏中间件。
2. **远端执行与任务引擎**：纯 Go SSH/SFTP 连接池、TOFU 指纹校验、固定命令模板与参数白名单/受保护 staging 原子落位、幂等一键推公钥、SELinux/免密 `sudo`/Swap 探测、PGP 签名+SHA256 双校验预解压中转下载、异步长任务队列（集群锁+主机产品锁、远端 `.op.lock` 崩溃核对隔离与 SSE 实时日志推流）。
3. **Vault 驱动与托管解封**：Vault 集群部署（TLS + Raft + `disable_mlock` + `LimitCORE=0` + Swap 预检）、`init_in_doubt` 治理与 Shamir 两阶段 Raft 加入、加密托管与周期性派生 Admin Token、手动安全封存抑制与节点级解封、统一 Raft 仲裁门禁、单节点扩缩容与证书/CA 轮换、兼容矩阵校验与升级前快照/熔断、Raft 快照管理与安全恢复状态机、Auth/Policy/支持嵌套路径与 CAS 的 KV v2 管理、Doctor 体检。
4. **Nomad 驱动与集群联动**：Nomad 单机/集群部署（按角色区分 `nomad`/`root` 运行用户、显式 TLS 配置与专属 SAN 证书、Gossip/ACL 与 `init_in_doubt`）、版本代际目录原子软链配置管理、统一 Raft 仲裁门禁、单节点扩缩容（含 `server_client` 双角色与 Drain 等待）、证书/CA 轮换、兼容矩阵升级与熔断、Nomad-Vault 双向 TLS 信任联动（含 `role_type="jwt"`、`user_claim_json_pointer`、`bound_claims` 与资源归属隔离）及端到端 JWT Login 体检、Consul 扩展接口预留。
5. **Nomad Job 中心**：Job 列表/详情、基于 `hcl/v2` 的可视化动态编排与受限 AST 附加片段、本地 AST 预检+受控反解、原生 HCL 编辑、纯 Go Compose 转换（含阻断校验）、模板管理、现网漂移检测、绑定 `plan_hash` 与 `JobModifyIndex` 的 Validate/Plan/Apply、启停重启与 Purge、版本回滚、Allocation SSE 实时日志流、HCL 导出。
6. **平台运营闭环**：定时任务（含防重入/漏执行/关联 `operation_task_id`、节点级健康巡检、CA/客户端/节点证书告警、Vault Token 续租、自动解封巡检、修正后的 `GET /v1/operator/snapshot` Raft 快照登记与互斥轮转、日志清理）、二次验密加密迁移包（`.ndbundle`）导出/绑定预检/全局维护屏障下外键与 JSON 内引用一致还原/防双活激活、系统设置。
7. **Web 管理端与单二进制打包**：React + Tailwind 全套管理端页面、`go:embed` 静态资源嵌入、Makefile 与 systemd/Docker 部署产物。

### 端到端核心验收场景

- [ ] **零配置启动、Setup 防抢注与会话撤销**：全新空目录启动 `nomad-deck`，自动生成 `master.key`、`setup.token` 与 SQLite；验证无 Setup Token 拒绝 `/auth/setup`，凭 Token 原子创建首个管理员并生成默认 SSH 密钥；验证改密/登出后旧 Cookie 失效且已建立的 SSE 日志流立即断开；验证变更请求缺少 CSRF/Origin 时被拒绝。
- [ ] **节点纳管与隔离约束**：添加 3 台 Linux 主机（验证手动粘贴公钥与临时密码幂等推公钥），完成 SSH 连通性、架构、免密 `sudo`、SELinux 与 Swap 状态探测；验证同一主机无法同时加入两个同类集群（`UNIQUE(node_id, cluster_type)` 生效）。
- [ ] **Vault 集群全流程**：在 UI 部署 3 节点 TLS + Raft Vault 集群（验证 Swap 预检与 `LimitCORE=0`）→ 初始化并验证 Shamir 两阶段 Raft 加入成功、Unseal Keys/Root Token/可续租 Admin Token 加密托管 → 手动安全封存节点验证自动解封抑制生效、解除抑制后自动解封恢复 → 验证单节点扩容 Join、证书续期、安全缩容 Remove（含仲裁门禁拦截）、升级前快照与兼容校验 → 验证支持嵌套路径与 CAS 冲突保护的 KV v2 编辑 → 验证 Raft 快照创建/下载与恢复状态机。
- [ ] **Nomad 集群全流程**：在 UI 部署 3 节点 Nomad 集群（验证纯 Server 跑 `nomad` 用户、Client 跑 `root` 用户、专属 SAN 与 `public_api_url` 证书、版本代际原子软链配置）→ 验证单节点扩容 Join、证书续期、`server_client` 双角色缩容（等待 Drain 完成 + Raft `remove-peer`）、仲裁门禁拦截多数派停服、升级前快照与熔断策略 → 验证集群锁/主机产品锁互斥及模拟控制面崩溃后进入 `needs_reconcile` 核对恢复 → 验证 Nomad `GET /v1/operator/snapshot` 备份与恢复。
- [ ] **Nomad + Vault 联动**：在 Nomad 与 Vault 均启用自签 TLS 的前提下创建联动配置（含 `bound_claims` 限制 Namespace）→ Plan 预览（验证 mTLS 冲突检测、Auth Mount 归属隔离与单点入口告警）→ Apply 双向打通（Nomad CA 写入 Vault `jwks_ca_pem`、完整 JWT Role 参数、滚动重启 Nomad）→ Doctor 四段式体检并验证真实 JWT Login 成功，且越权 Namespace Job 被 Vault 拒绝。
- [ ] **Job 全生命周期**：分别通过可视化动态编排器（覆盖顶层 `variable`、`constraint`、`reschedule`、`update`、`lifecycle` Sidecar、Docker `mount`/`bind_options`/`logging`、`resources.memory_max`、Group/Task 级 `service`/`check`、`volume`/`volume_mount`、`env`/`template`/`vault`/`identity` 块与 AST 校验附加片段，验证现网漂移检测与回填）、纯 Go Compose 导入（含阻断项校验）与原生 HCL 编辑器（含本地 HCL2 AST 差异警告）提交 Job → 验证绑定 `JobModifyIndex` 的并发冲突保护与 Plan Diff 后下发 → 经 SSE 实时查看 Allocation 日志 → 停止/重新启动/修改版本并回滚/Purge 删除。
- [ ] **定时任务与审计**：验证防重入、手动触发与关联 `operation_task_id` 的健康巡检、CA/客户端/节点证书检查、Vault Token 续租与 Raft 快照任务均成功；验证审计日志完整且步骤日志、SSE 流与审计均无明文私钥/Token/Unseal Key 泄露。
- [ ] **环境迁移还原**：二次验密导出加密 `.ndbundle`（含 `operation_task_steps`）→ 在全新空实例启动 `nomad-deck`（不同 `master.key`）→ 上传迁移包完成绑定 `preview_token` 的预检并在维护屏障下执行 `replace` 还原 → 验证历史会话经 `session_epoch` 失效且自动任务默认暂停防双活 → 点击「激活控制面」后正常连接全部主机、集群、触发解封与管理 Job；验证 `merge` 模式同步重写 SQL 外键与 `cron_jobs.payload_json` 内嵌引用。
