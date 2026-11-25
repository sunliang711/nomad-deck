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
3. **纯 Go 原生 SSH + SFTP 远端执行**：控制面直接通过 Go SSH/SFTP 完成文件分发、二进制部署、服务控制与日志流读取，**被管主机无需安装 Python、Ansible 或任何常驻 Agent**。Nomad、Vault、CNI Plugins 与 Docker 的安装包一律由控制面下载、校验后中转分发，被管主机不需要访问外网发布源。
4. **Vault Unseal Keys 由平台加密托管**：Vault 初始化产出的 Unseal Keys 由控制面主密钥加密落库并按代际保留，日常 API 调用使用初始化后派生的专用 Admin Policy Token，初始化完成后即吊销 Root Token，应急时凭托管的 Unseal Keys 临时生成；支持在 UI 中一键解封、滚动升级后自动解封及可选的巡检自动解封，避免在 Vault 节点磁盘明文存放解封密钥。
5. **预留 Consul 扩展位（可选）**：核心数据模型、集群驱动接口、联动模型与前端路由均预留 `consul` 类型接口；`v1.0.0` 聚焦 Nomad + Vault，Consul 作为后续按需启用的可选扩展。
6. **一次性发版（`v1.0.0`）**：全部既定功能在 `v1.0.0` 统一交付并完成端到端验收，不拆分多阶段灰度发布。
7. **支持的产品版本与版本下限**：Nomad `1.9.0` 及以上，Vault `1.15.0` 及以上，`v1.0.0` 仅支持两者的 Community 版。Vault Enterprise 的 Autopilot 自动升级迁移等机制与本方案的手动滚动升级流程冲突，部署、纳管与升级前检查通过版本信息识别 Edition（如 Enterprise 版本号带 `+ent` 后缀），遇到 Enterprise 版即拒绝并说明原因；Nomad 同样只接受 Community 版。Nomad 下限取 1.9 的原因：Workload Identity、`default_identity` 与 Job Actions 自 1.7 提供，而 1.9 之前 Nomad 的根密钥（用于 Variables 加密与 Workload Identity 签名）保存在各 Server 本地的 keystore 目录中、不进入 Raft，仅凭 Raft 快照无法在全部 Server 磁盘丢失后恢复；自 1.9 起根密钥以封装形式存入 Raft，随快照一同备份。NomadDeck 不为 Nomad 配置外部 KEK 提供方，保证快照自包含。部署、扩容与升级的版本选择列表只展示满足下限的版本；部署前检查与 Doctor 对低于下限的节点给出 `FAIL`。少数依赖更高版本的能力（如动态 Host Volume 需 Nomad `1.10` 及以上）按集群实际版本自动启用或隐藏。

---

## 2. 设计目标与技术选型

| 维度 | 选型 | 说明 |
| :--- | :--- | :--- |
| **后端语言与框架** | Go 1.26+、`chi/v5` | 单二进制编译部署，低资源占用，原生高并发 |
| **远端执行引擎** | `golang.org/x/crypto/ssh`、`github.com/pkg/sftp` | 原生 SSH/SFTP 连接池、流式输出、无 Agent 侵入 |
| **数据库** | SQLite WAL（`modernc.org/sqlite`） | 纯 Go 零 CGO 依赖，单文件存储；采用读写分离连接池（单写连接 + `busy_timeout`）消除并发写锁冲突 |
| **加密与鉴权** | AES-256-GCM、Argon2id、Ed25519、`ProtonMail/go-crypto/openpgp` | 主密钥信封加密敏感凭据、口令加密迁移包、HTTPS `Secure`+`HttpOnly` Cookie 承载服务端会话、HashiCorp 官方 PGP 签名校验、NomadDeck 自身发布包 Ed25519 签名校验 |
| **定时任务** | `robfig/cron/v3` | 内置运维巡检、证书监控、自动解封巡检与 Raft 快照定时调度（支持防重入与漏执行策略） |
| **实时推送** | SSE（Server-Sent Events）为主，WebSocket 仅用于交互式终端 | SSE 统一用于单向实时推流（SSH 运维任务日志、`journalctl` 节点日志、Nomad Allocation 日志、Nomad 运行态变化），绑定会话可即时撤销；只有 Nomad Exec 与 Job Actions 的双向终端使用 WebSocket，并以一次性票据与严格同源校验防范跨站劫持 |
| **前端可视化组件** | `xterm.js`、轻量图表库 | 浏览器内交互式终端；资源利用实时折线与拓扑容量条 |
| **灾备备份目标** | `github.com/pkg/sftp`、`minio/minio-go/v7` | 控制面灾备包写入 SFTP 与 S3 兼容对象存储 |
| **唯一 ID 与配置解析** | `oklog/ulid/v2`、`BurntSushi/toml`、`gopkg.in/yaml.v3`、`hashicorp/hcl/v2` | 时间有序 ID；极简 TOML 启动配置；纯 Go 解析 Compose YAML；官方 HCL2 AST 解析与 `hclwrite` 编码渲染 |
| **前端技术栈** | React 18 + TypeScript + Vite + Tailwind CSS + `lucide-react` + CodeMirror 6（HCL 编辑） | 编译后通过 `go:embed` 直接打入后端二进制 |
| **服务监听与发布** | 默认监听 `0.0.0.0:8555`（HTTPS）、GitHub Releases | 单端口同时承载 Web 管理端、REST API 与 SSE；控制面从 GitHub Release 拉取新版本完成自更新 |

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
                                          │ HTTPS :8555 / REST + SSE
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
- **HTTP/HTTPS API 通道**用于高频控制面与业务操作：查询 Nomad 集群拓扑与 Leader 状态、Job 校验/Plan/提交/启停/重启/Purge、Deployment/Allocation/Client 节点等运行态查看与操作、资源利用统计、Allocation 文件浏览与交互式终端、流式拉取 Allocation 日志、查询 Vault 健康与密封状态、执行初始化/解封/Auth/Policy/KV 管理、触发 Raft Snapshot。

### 3.2 被管节点目录规范（全新集群布局）

目标 Linux 主机由 NomadDeck 独占管理，**每台主机每种产品（Nomad / Vault / Consul）最多归属一个集群**（由数据库唯一约束 `UNIQUE(node_id, cluster_type)` 强制保证，防止跨集群覆盖目录与 systemd 单元）。所有托管配置文件首行统一写入 `# Managed by NomadDeck`，多文件配置目录采用**版本代际目录 + 原子软链切换**保证整组一致性：

- **Nomad 节点（`/opt/nomad-deck/nomad`）**
  - 二进制版本目录：`/opt/nomad-deck/nomad/bin/versions/nomad-<ver>`，原子软链 `/opt/nomad-deck/nomad/bin/nomad` 与 `/usr/local/bin/nomad`
  - 配置代际目录：`/opt/nomad-deck/nomad/etc/releases/<gen>/`，经 `nomad config validate` 整目录校验通过后，由原子软链 `/opt/nomad-deck/nomad/etc/nomad.d` 切换指向生效代际：
    - `10-base.hcl`（datacenter、region、bind/advertise、server/client 角色与 `retry_join`、Gossip 加密、ACL）
    - `30-tls.hcl`（集群 TLS 证书配置，显式配置 `http`、`rpc`、`verify_server_hostname`、`verify_https_client`；`verify_https_client` 默认 `false`，HTTP API 的调用方身份由 ACL Token 鉴别）
    - `35-ui.hcl`（Nomad 原生 UI 开关与跨链接）
    - `40-telemetry.hcl`（Prometheus 指标配置）
    - `60-vault.hcl`（Vault Workload Identity 联动配置）
    - `65-consul.hcl`（预留：Consul 联动配置）
    - `70-host-volume-<name>.hcl`（Client Host Volumes）
    - `72-client-meta.hcl`（Client 调度标签）
    - `80-docker.hcl`、`81-raw-exec.hcl`、`82-driver-denylist.hcl`、`83-cni.hcl`
    - `tls/`（本代际引用的全部 TLS 材料：集群 CA 信任链、节点证书与私钥、联动用的 `vault-ca.crt`。本代际的 HCL 一律以指向**本代际目录的绝对路径**引用这些文件，如 `/opt/nomad-deck/nomad/etc/releases/<gen>/tls/server.pem`，不经 `nomad.d` 软链、不依赖进程工作目录，因此候选代际在切换前即可完整校验；`nomad config validate` 只解析顶层 `.hcl` 文件，不受该子目录影响）
  - 配置代际中的证书、私钥与信任链随 HCL 一起构成不可变的整组材料：任何证书续期、CA 轮换步骤或联动 CA 变更都生成新代际，切回上一代际即同时恢复上一组配置与 TLS 材料；默认保留最近 5 个代际。切换前对候选代际做两层校验：控制面在生成时校验证书链、私钥与证书匹配、SAN 与有效期；节点侧在候选代际目录中对每个 TLS 文件复核 SHA256，并执行 `nomad config validate`，全部通过后才切换软链
  - 数据与卷目录：`/opt/nomad-deck/nomad/data/`、`/opt/nomad-deck/nomad/volumes/`
  - 操作锁标记：`/opt/nomad-deck/nomad/.op.lock`（记录当前远端任务 `remote_op_id` 与对应的临时 systemd 单元名，用于控制面崩溃重启后核对远端在途步骤）
  - systemd 单元：`/etc/systemd/system/nomad.service`（纯 Server 节点以低权系统用户 `nomad` 运行；含 Client 角色的 `client` / `server_client` 节点以 `root` 运行，以满足 cgroups、CNI 网络命名空间、Host Volume 挂载与 Docker socket 权限要求）
- **Vault 节点（`/opt/nomad-deck/vault`）**
  - 二进制版本目录：`/opt/nomad-deck/vault/bin/versions/vault-<ver>`，原子软链 `/opt/nomad-deck/vault/bin/vault` 与 `/usr/local/bin/vault`
  - 配置代际目录：`/opt/nomad-deck/vault/etc/releases/<gen>/{config.hcl,tls/ca.crt,tls/server.crt,tls/server.key}`，由原子软链 `/opt/nomad-deck/vault/etc/vault.d` 指向生效代际，`vault.service` 以 `-config=/opt/nomad-deck/vault/etc/vault.d/config.hcl` 启动（`config.hcl` 在 Raft 模式下显式配置 `disable_mlock = true`、`api_addr` 与 `cluster_addr`，TLS 文件一律以指向本代际目录的绝对路径引用，不依赖工作目录）；证书续期与 CA 轮换同样以新代际切换，切换前按 Nomad 相同的两层校验检查候选代际，切回上一代际即同时恢复配置与证书
  - 数据目录：`/opt/nomad-deck/vault/data/raft/`
  - 审计日志：`/opt/nomad-deck/vault/logs/audit.log`（Vault 文件审计设备输出，由托管的 logrotate 配置按大小轮转，轮转后向 Vault 发送 `SIGHUP` 重新打开文件）
  - 操作锁标记：`/opt/nomad-deck/vault/.op.lock`（语义同 Nomad；按产品分别存放，与「主机产品级锁」一一对应，同一主机上的 Nomad 与 Vault 任务互不覆盖）
  - systemd 单元：`/etc/systemd/system/vault.service`（以低权系统用户 `vault` 运行并显式设置 `LimitCORE=0` 禁止 core dump；因 Raft 模式启用 `disable_mlock = true`，Vault 主机部署预检要求禁用 Swap 或采用明确批准的加密 Swap；不安装本地明文自动解封单元，解封由 NomadDeck 控制面通过 API 完成）
- **Docker Engine（主机级，`managed` 模式）**
  - 安装来源：Docker 官方软件仓库的 `docker-ce`、`docker-ce-cli`、`containerd.io`、`docker-buildx-plugin`、`docker-compose-plugin` 安装包，由控制面中转后以本地包方式安装，系统包管理器锁定版本
  - 守护进程配置：`/etc/docker/daemon.json`（托管标记文件 `/etc/docker/daemon.json.managed-by-nomad-deck`；含代理认证信息时权限 `0600`）
  - systemd 单元：使用安装包自带的 `docker.service`、`docker.socket` 与 `containerd.service`；`external` 模式下镜像拉取代理写入 `/etc/systemd/system/docker.service.d/nomad-deck-proxy.conf`
  - 操作锁标记：`/opt/nomad-deck/docker/.op.lock`
- **安装包 staging 目录**：`/opt/nomad-deck/.staging/<remote_op_id>/`（权限 `0700`，存放控制面经 SFTP 传来的 gzip 压缩二进制与 Docker 安装包，校验与安装完成后删除）

### 3.3 仓库目录结构规划

```text
nomad-deck/
├── cmd/
│   └── nomad-deck/
│       └── main.go                 # 进程入口、配置加载、优雅关闭、本机运维子命令（重置密码、版本回退、离线备份解密）
├── internal/
│   ├── config/                     # 启动配置（TOML + 环境变量覆盖）
│   ├── crypto/                     # 主密钥加载与轮换、AES-256-GCM 信封加密、Argon2id、SSH/TLS 密钥签发
│   ├── db/                         # SQLite WAL 读写分离连接池、内嵌 Schema 迁移、Repository 封装
│   ├── auth/                       # Admin 认证与账号管理、Setup Wizard、防爆破限流、服务端会话与 CSRF 校验
│   ├── sshx/                       # 纯 Go SSH/SFTP 连接池、主机指纹校验、sudo 封装、流式执行
│   ├── release/                    # HashiCorp / CNI 版本解析、SHA256 校验、控制面中转下载与预解压缓存
│   ├── driver/                     # 集群通用驱动接口（ClusterDriver / NodeProvisioner，预留 Consul）
│   ├── nomad/                      # Nomad 节点 SSH 编排、HCL 渲染、扩缩容与滚动升级、Nomad HTTP API 客户端
│   ├── vault/                      # Vault 节点 SSH 编排、Raft 集群组网、托管解封、扩缩容与滚动升级、Vault HTTP API 客户端
│   ├── integration/                # Nomad <-> Vault JWT Workload Identity 双向联动编排与四段式体检
│   ├── job/                        # Job 生命周期、可视化动态编排模型与 HCL 渲染/反解、纯 Go Compose 转 HCL、实时 Alloc 日志代理
│   ├── workbench/                  # Nomad 运行态工作台：阻塞查询订阅复用、资源统计采样、文件浏览、Exec/Action WebSocket 转发
│   ├── ops/                        # 异步长任务引擎（任务队列、集群级互斥锁、步骤状态机、SSE 实时日志广播、崩溃恢复）
│   ├── cron/                       # 平台定时任务调度与执行历史
│   ├── audit/                      # 统一审计记录与敏感字段强制脱敏
│   ├── migration/                  # .ndbundle 加密导出、Dry-Run 预检与事务导入还原
│   ├── selfupdate/                 # GitHub Release 版本查询、签名与 SHA256 校验、原子替换、预约升级与回退
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

所有主键均使用 ULID 字符串，时间字段统一使用 RFC3339 UTC 文本；凡后缀为 `_encrypted` 的列均由控制面主密钥经 AES-256-GCM 加密存储（附随机 12 字节 Nonce 与主密钥标识 Key ID 前缀，主密钥轮换流程见 5.1）。

`key_rotation_journal`（主密钥轮换进度）：`id`、`old_key_id`、`new_key_id`、`state`（`running` / `verifying` / `completed` / `failed`）、`progress_json`（按加密字段清单记录每类位置的已处理数量与最后处理位置）、`started_by`、`started_at`、`finished_at`、`error_message`。

### 4.1 `admins` 与 `admin_sessions`（管理端账号与会话）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | TEXT PK | ULID |
| `username` | TEXT UNIQUE | 管理员用户名 |
| `password_hash` | TEXT | Argon2id 密码哈希 |
| `role` | TEXT | 账号角色：`admin`（全部权限）/ `viewer`（只读运维），权限边界见 5.1 |
| `is_disabled` | INTEGER | 账号停用标记（`0` 启用 / `1` 停用；停用时立即吊销该账号全部会话） |
| `failed_attempts` | INTEGER | 连续登录失败次数 |
| `locked_until` | TEXT | 防爆破锁定截止时间（可空） |
| `last_login_at` | TEXT | 最近登录时间 |
| `created_at` / `updated_at` | TEXT | 时间戳 |

`admin_sessions`（服务端会话）：`id`（ULID）、`admin_id` FK、`token_hash`（会话 Cookie 中随机令牌的 SHA256，库内不存原文）、`csrf_token_hash`、`client_ip`、`user_agent`、`created_at`、`last_seen_at`、`expires_at`。登出删除当前会话；修改密码、停用账号或管理员手动「注销其他设备」时删除该账号的其他会话或全部会话；会话表不参与环境迁移导出，迁移导入时整表清空。

### 4.2 `system_settings`（系统全局设置）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `key` | TEXT PK | 配置键（如 `release.mirror_url`、`release.pgp_public_key`、`ssh.timeout_sec`、`ssh.max_concurrency`、`proxy.config`、`proxy.password`、`proxy.use_for_releases`、`proxy.use_for_self_update`、`audit.retention_days`、`ops.retention_days`、`snapshot.dir`、`auth.session_ttl_hours`、`auth.session_idle_minutes`、`cron.timezone`、`defaults.nomad_version`、`defaults.vault_version`、`defaults.docker_version`、`release.docker_pgp_public_key`、`release.transfer_rate_limit`、`release.cni_checksums`、`upgrade.max_minor_skip`、`nomad.stats_interval_seconds`、`nomad.exec_idle_minutes`、`nomad.exec_max_minutes`、`observability.grafana_url_template`、`self_update.channel`、`self_update.schedule`、`self_update.last_result`、`self_update.backup_retention`、`backup.enabled`、`backup.passphrase`、`backup.targets`、`backup.include_history`、`control_plane.activated`） |
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
| `os_family` / `os_codename` / `package_manager` | TEXT | 探测得到的发行版系列（如 `debian`、`rhel`）、版本代号（如 `jammy`、`9`）与包管理器（`apt` / `dnf` / `yum`），用于选择 Docker 安装包 |
| `docker_mode` | TEXT | Docker 管理模式（`managed` / `external` / `absent`，见 5.3） |
| `docker_status` | TEXT | 探测得到的 Docker Engine 运行状态（`running` / `installed_stopped` / `absent`） |
| `docker_version` | TEXT | 当前 Docker Engine 版本 |
| `docker_config_json` | TEXT | 主机级 Docker 守护进程配置覆盖项（版本、镜像拉取代理、镜像加速、日志轮转、`data-root`；代理密码字段加密存储） |
| `machine_id` | TEXT UNIQUE | 探测得到的 `/etc/machine-id`，作为物理主机的规范身份：同一 `machine_id` 只能对应一条主机记录（以不同 IP 或域名重复登记时拒绝，并提示为已有主机添加地址别名）；也用于拒绝把控制面宿主机自身纳管为集群节点 |
| `address_aliases_json` | TEXT | 同一主机的其他 IP 或域名别名（仅用于识别与展示，不作为独立主机） |
| `time_sync` | TEXT | 探测得到的时间同步状态（`synced` / `unsynced` / `unknown`）及与控制面的时钟偏差，用于证书签发与 JWT 校验前置检查 |
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
| `tls_config_json` | TEXT | 显式 TLS 配置（Nomad 区分 `http`/`rpc`/`verify_server_hostname`/`verify_https_client`，其中 `verify_https_client` 默认 `false`；含非生产环境的 `allow_insecure_http` 显式开关与 TLS 终止模式说明） |
| `ca_cert_pem` | TEXT | 集群统一 CA 证书（PEM，CA 轮换期间包含新旧重叠 CA 链） |
| `ca_key_encrypted` | TEXT | 加密存储的集群 CA 私钥（用于签发新扩容节点与续期证书） |
| `ca_expires_at` | TEXT | 集群 CA 证书到期时间（供证书临期巡检使用） |
| `client_cert_pem` | TEXT | 控制面专用客户端 TLS 证书（Nomad 开启 `verify_https_client` 时用于 mTLS 鉴权） |
| `client_key_encrypted` | TEXT | 加密存储的控制面专用客户端 TLS 私钥 |
| `client_cert_expires_at` | TEXT | 控制面客户端 TLS 证书到期时间（纳入临期巡检与续期范围） |
| `gossip_key_encrypted` | TEXT | 加密存储的当前生效 Nomad Gossip 密钥（16/32 字节 Base64；轮换期间另存待生效密钥，轮换完成后替换） |
| `gossip_key_pending_encrypted` | TEXT | 加密存储的待生效 Nomad Gossip 密钥（仅在 Gossip 密钥轮换期间存在，轮换中断后重新发起时沿用同一密钥续做，轮换完成后清空） |
| `public_api_url` | TEXT | 集群对外统一业务入口（如 LB/VIP/域名，优先用于 Nomad ↔ Vault 联动的 `jwks_url` 与 `vault.address`） |
| `api_endpoints_json` | TEXT | 控制面访问该集群的故障切换 HTTP API 入口列表（逐节点直连操作仍优先使用 `cluster_nodes.api_addr`） |
| `admin_token_encrypted` | TEXT | 加密存储的管理 Token（Nomad Management Token，其 Secret 由控制面预先生成并在 Bootstrap 前落库；Vault 日常管理 Token 见托管表） |
| `init_state` | TEXT | 集群初始化状态（`uninitialized` / `init_in_doubt` / `initialized`；在调用 Init/Bootstrap 前先置为 `init_in_doubt`，确认结果并持久落库后置为 `initialized`） |
| `maintenance_mode` | INTEGER | 集群维护/隔离模式（`0` 正常 / `1` 维护或待核对，期间暂停自动巡检与自动解封） |
| `maintenance_reason` | TEXT | 维护/隔离原因（如 `snapshot_restore`、`needs_reconcile`、`manual_maintenance`） |
| `config_json` | TEXT | 集群级默认配置（如 Nomad `job_gc_threshold`、Telemetry、UI、`exec_enabled` 交互式终端开关、`docker_defaults` 集群默认 Docker 配置；Vault API/Cluster 端口策略） |
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
| `raft_role` | TEXT | Nomad Server：`leader` / `follower`；Vault：`active`（HA 主节点，同时为 Raft Leader）/ `standby`（Raft Follower）/ `performance_standby`（预留）；非 Raft 成员为 `none` |
| `is_voter` | INTEGER | Raft 节点是否具备投票权（`0` / `1`） |
| `is_sealed` | INTEGER | Vault 节点级密封状态（`0` 已解封 / `1` 已密封 / `NULL` 非 Vault 或未知） |
| `node_config_json` | TEXT | 节点级特化配置（Nomad Client 的 Docker/CNI/raw_exec/denylist/host_volumes/meta、节点证书 SAN 等） |
| `cert_expires_at` | TEXT | 该节点 TLS 证书到期时间 |
| `last_synced_at` | TEXT | 最近状态同步时间 |
| `created_at` / `updated_at` | TEXT | 时间戳 |

> 唯一约束：`UNIQUE(cluster_id, node_id)` 与 `UNIQUE(node_id, cluster_type)`。同一台主机可同时加入一个 Nomad 集群和一个 Vault 集群，但每种产品在同一主机上最多归属一个集群，杜绝固定目录布局下的跨集群覆盖。

### 4.7 `vault_secrets_custody` 与 `vault_unseal_key_generations`（Vault 密钥加密托管与代际表）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `cluster_id` | TEXT PK FK | 关联 `clusters.id`（`type='vault'`） |
| `initialized` | INTEGER | `0` / `1` |
| `key_shares` | INTEGER | Shamir 分片总数（默认 `5`） |
| `key_threshold` | INTEGER | 解封阈值（默认 `3`） |
| `seal_generation` | INTEGER | 指向当前生效代际的指针（初始化为 `1`）。Rekey 生成的新代际编号一律取该集群 `vault_unseal_key_generations` 中历史最大编号加 `1`，与本指针无关；快照恢复只移动本指针，不复用、不覆盖任何已有代际编号 |
| `bootstrap_root_token_encrypted` | TEXT | 初始化过渡期暂存的 Root Token（仅在“初始化 → 派生运维 Token → 吊销 Root Token”流程中存在，吊销成功后立即清空；常态为空） |
| `admin_token_encrypted` | TEXT | AES-256-GCM 加密的专用运维 Admin Policy Token（无父级的 orphan 周期性 Token，不随任何父 Token 吊销而失效，供日常 API 与集群联动使用） |
| `admin_token_expires_at` | TEXT | 专用运维 Token 到期时间（由定时任务自动续租与临期告警） |
| `auto_unseal_by_deck` | INTEGER | 是否开启“控制面自动解封”（升级后及定时巡检发现 Sealed 时自动调用 API 解封） |
| `unseal_suppressed_reason` | TEXT | 自动解封抑制原因（如 `manual_seal` / `incident_lock` / `snapshot_restore`，非空时禁止自动解封） |
| `initialized_at` | TEXT | 初始化时间 |
| `last_unsealed_at` | TEXT | 最近一次解封时间 |
| `updated_at` | TEXT | 更新时间 |

`vault_unseal_key_generations`（Unseal Key 代际表）：`cluster_id` FK、`generation`、`key_shares`、`key_threshold`、`unseal_keys_encrypted`（AES-256-GCM 加密的 Unseal Keys JSON 数组）、`rekey_verification_nonce`（在 `pending_verification` 与 `verification_in_doubt` 两个未决状态下均保留 Rekey 验证所需的 nonce；核对过程中若 Vault 返回新的 nonce 则同步刷新；进入 `active` 或 `abandoned` 后清空）、`state`（`pending_verification` / `verification_in_doubt` / `active` / `retired` / `abandoned`）、`created_at`、`activated_at`、`retired_at`，主键为 `(cluster_id, generation)`。同一集群任一时刻仅有一个 `active` 代际；退役代际继续保留，供恢复 Rekey 之前生成的 Raft 快照时解封使用。

### 4.8 `cluster_integrations` 与 `integration_roles`（集群联动与工作负载 Role）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | TEXT PK | ULID |
| `name` | TEXT UNIQUE | 联动配置名称（Profile 名，如 `prod-nomad-vault`） |
| `integration_type` | TEXT | `nomad_vault_jwt`（预留 `nomad_consul`） |
| `source_cluster_id` | TEXT FK | 源集群（Nomad 集群 ID） |
| `target_cluster_id` | TEXT FK | 目标集群（Vault 集群 ID） |
| `auth_path` | TEXT | 目标 Vault 上的 JWT Auth Mount 路径（默认按 Nomad 集群名隔离，如 `jwt-nomad-<cluster>`） |
| `config_json` | TEXT | 联动级参数（`aud`、`jwks_url`、`jwks_mode`、`default_role`、身份令牌 `ttl`；工作负载 Role 与 Policy 见 `integration_roles`） |
| `nomad_config_sha256` | TEXT | 最近一次下发到 Nomad 节点的 `60-vault.hcl` 渲染内容摘要（用于判断 Apply 是否需要滚动重启 Nomad） |
| `nomad_side_enabled` | INTEGER | Nomad 侧联动配置（`60-vault.hcl` 与 `tls/vault-ca.crt`）是否已纳入源集群的配置代际（首次 Apply 开始下发 Nomad 侧时置 `1`，删除联动时先置 `0` 并滚动移除后再删除记录） |
| `status` | TEXT | `draft` / `applied` / `drifted` / `failed` |
| `last_doctor_json` | TEXT | 最近一次四段式全链路体检结果快照 |
| `last_applied_at` | TEXT | 最近一次下发时间 |
| `created_at` / `updated_at` | TEXT | 时间戳 |

> 唯一与归属约束：`UNIQUE(target_cluster_id, auth_path)`（防止多个 Nomad 集群复用同一 Vault JWT Auth Mount 互相覆盖 `jwks_url`）；Nomad Community 版每个 `source_cluster_id` 仅允许绑定一个生效中的 `nomad_vault_jwt` 目标集群（匹配社区版单 `vault {}` 块限制），删除 Profile 时仅清理归属该 Profile 的资源。

`integration_roles`（联动下的工作负载 Role）：`id`、`integration_id` FK、`role_name`、`policy_name`、`policy_mode`（`explicit` 按 `secret_paths` 精确授权 / `templated` 按身份元数据模板化授权）、`secret_paths_json`、`custom_policy_hcl`（可空）、`bound_claims_json`（至少包含 `nomad_namespace`）、`token_period`、`status`（`draft` / `applied` / `drifted` / `failed`）、`last_applied_at`、`created_at`、`updated_at`，唯一约束 `UNIQUE(integration_id, role_name)`。一个联动可挂载多个 Role，每个应用或 Namespace 使用独立 Role；Role 与 Policy 的增删改只作用于 Vault 侧，不触发 Nomad 重启。

### 4.9 `job_templates` 与 `job_revisions`（Nomad Job 模板与版本历史）
- `job_templates`：`id`、`cluster_id`（可空表示跨集群通用模板）、`name`、`job_id`、`namespace`、`edit_mode`（`visual` / `hcl`）、`renderer_version`、`form_spec_json`（可视化动态编排结构 JSON，可空）、`hcl_content`、`hcl_sha256`、`source_type`（`visual` / `hcl` / `compose` / `imported`）、`description`、`created_at`、`updated_at`。
- `job_revisions`：`id`、`cluster_id`、`namespace`、`job_id`、`revision_no`、`source`（由 NomadDeck 发起的变更来源：`workbench` 编排工作台提交 / `scale` 扩缩副本数 / `revert` 版本回滚 / `stop_archive` 停止前归档）、`edit_mode`（`visual` / `hcl` / `json`）、`renderer_version`、`form_spec_json`（可空）、`hcl_content`（可空，JSON 模式无源码）、`hcl_sha256`、`variables_encrypted`（本次提交使用的 HCL 变量覆盖值，可能含敏感值，加密存储）、`job_json_encrypted`（实际提交给 Nomad 的最终 Job JSON，加密存储——HCL 变量展开后的值会出现在其中，必须与变量输入同等保护；重新提交与回滚以它为准）、`operation_id`（扩缩等操作的唯一操作 ID，用于对账认领）、`base_job_modify_index`（提交或扩缩前的现网 `JobModifyIndex`）、`result_job_modify_index`（Nomad 响应返回的修改索引）、`remote_job_version`、`eval_id`、`submit_status`（`submitted` / `in_doubt` / `confirmed` / `failed` / `needs_review`）、`plan_summary`、`count_overridden_json`（扩缩后 HCL 中无法原位改写 `count` 的 Group 及其现网副本数，可空）、`submitted_by`、`created_at`（支持现网漂移检测、版本对比与按权威表示回填；回滚优先使用 Nomad 原生 Job 版本，本表负责保存每个 Nomad 版本对应的可视化编排结构、原始 HCL、变量输入与最终 Job JSON，并在 Nomad 已回收旧版本时以 `job_json_encrypted` 解密后的 JSON 作为重新提交的来源）。

### 4.10 `operation_tasks` 与 `operation_task_steps`（异步运维任务与步骤追踪）
- `operation_tasks`：`id`、`action`（如 `nomad.install`、`nomad.upgrade`、`vault.init`、`vault.unseal`、`cluster.node_join`、`cluster.node_remove`、`cluster.cert_renew`、`cluster.gossip_rotate`、`vault.rekey`、`docker.install`、`docker.upgrade`、`docker.config`、`integration.apply`、`cluster.uninstall`、`snapshot.restore`、`system.self_update`）、`target_type`、`target_id`、`lock_mode`（`exclusive` / `shared`）、`remote_op_id`（写入目标机 `/opt/nomad-deck/<product>/.op.lock` 的幂等标识，同时作为远端临时 systemd 单元名 `nomad-deck-op-<remote_op_id>-<step>` 的组成部分）、`intent_json`（结构化执行意图与步骤检查点，用于崩溃后核对，不含明文凭据）、`status`（`pending` / `running` / `success` / `failed` / `rolled_back` / `interrupted` / `needs_reconcile` / `cancelled`）、`params_redacted_json`、`triggered_by`、`started_at`、`finished_at`、`error_message`。
- `operation_task_steps`：`id`、`task_id` FK、`step_order`、`node_id`（可空）、`name`、`status`、`log_path`（经流式脱敏后的步骤执行日志文件，相对控制面数据目录存放；环境迁移导出运维任务时日志文件随包导出）、`remote_unit`（远端临时 systemd 单元名，可空）、`exit_code`、`started_at`、`finished_at`、`error_message`。

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
| `seal_generation` | INTEGER | Vault 快照生成时生效的 Unseal Key 代际号（Nomad 为空；恢复时据此选取 `vault_unseal_key_generations` 中对应代际的密钥解封） |
| `credential_generation` | TEXT | 快照对应集群凭据代际标识（用于判断恢复后是否需要重验或重置控制面凭据） |
| `file_path` | TEXT | 加密落盘的快照文件路径（文件使用独立随机数据密钥加密，数据密钥由主密钥包裹后写入文件头） |
| `size_bytes` | INTEGER | 快照文件大小（字节） |
| `sha256` | TEXT | 快照正文密文的 SHA256 校验值（不含文件头；文件头含主密钥 Key ID 与被包裹的数据密钥，由其认证标签单独保护，主密钥轮换只改写文件头） |
| `trigger_type` | TEXT | `scheduled` / `manual` / `uploaded` / `pre_upgrade`（滚动升级前自动生成） |
| `triggered_by` | TEXT | 管理员或 `system:cron` |
| `created_at` | TEXT | 创建时间 |

### 4.13 `audit_logs`（全量审计日志）
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | TEXT PK | ULID |
| `actor_id` / `actor_name` | TEXT | 操作管理员或 `system:cron` |
| `client_ip` | TEXT | 请求来源 IP |
| `action` | TEXT | 动作标识（如 `auth.login`、`admin.create`、`admin.role_change`、`ssh_key.generate`、`node.create`、`nomad.upgrade`、`vault.unseal`、`vault.rekey`、`job.submit`、`job.purge`、`migration.export`、`migration.import`、`system.self_update`、`system.master_key_rotate`） |
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

1. **安全信任边界（威胁模型）**：
   - 控制面同时持有全部 Vault Unseal Keys、Vault 运维 Token、Nomad Management Token、集群 CA 私钥与 SSH 私钥，以及解密上述材料的主密钥。**NomadDeck 宿主机的安全等级即等于被管 Vault 与 Nomad 集群的安全等级**：取得该宿主机 root 权限或同时取得数据库与主密钥，即可解封 Vault 并接管集群。
   - Shamir 分片（默认 5 份、阈值 3）由控制面全部持有，在本系统中不提供“多人共管”的防护，仅用于与 Vault 原生流程保持一致并支持后续把部分分片移交人工保管；这一取舍以换取无人值守解封为目的，是有意为之。
   - 配套的约束：控制面宿主机仅承载 NomadDeck，不纳管为集群节点，SSH 登录仅限少数运维人员；主密钥与数据库分离存放；离线紧急备份（见 5.4）保存在与控制面宿主机隔离的介质上，作为控制面整体失效时人工解封的唯一依据。
2. **独立部署与主密钥加载**：
   - 控制面独立部署在被管集群之外的宿主机，节点纳管时比对目标主机 `machine_id`，拒绝把控制面宿主机自身加入任何集群。
   - 主密钥（32 字节）按以下优先级加载：systemd 凭据目录中的 `master_key`（由 unit 的 `LoadCredential=` 或 `LoadCredentialEncrypted=` 提供，进程环境与 unit 文件中均不出现密钥原文）→ 环境变量 `NOMAD_DECK_MASTER_KEY`（Hex/Base64）→ 数据目录下的 `master.key`（权限 `0600`，均未提供时首次启动自动生成）。生产环境使用 systemd 凭据方式，避免主密钥与 SQLite 数据库同目录存放或被一并归档泄露；使用环境变量时，同机 root 可通过进程环境读取主密钥，部署文档对此明确提示。
   - **加密字段登记**：所有使用主密钥加密的数据位置统一登记在加密字段清单中，包括 `_encrypted` 列、`is_secret=1` 的系统设置、JSON 字段内的加密子字段（如 `nodes.docker_config_json` 中的代理密码、`backup.targets` 中的存储凭据）、加密快照文件头与升级前数据库备份。每段密文都带有主密钥标识（Key ID）前缀，服务启动时自检：若存在引用未加载主密钥的密文则拒绝启动并列出位置。
   - **主密钥轮换（双密钥过渡 + 持久化进度）**：数据库事务无法覆盖快照文件与主密钥来源本身，因此轮换不依赖单一事务，而是按以下可中断、可续做的流程执行：
     1. 管理员在主密钥来源中新增新密钥（systemd 凭据 `master_key_next`、环境变量 `NOMAD_DECK_MASTER_KEY_NEXT` 或文件 `master.key.next`）并重启服务。服务同时加载新旧两把密钥，新写入的密文一律使用新密钥，读取时按密文的 Key ID 选择密钥。
     2. 管理员在「系统设置」发起轮换（二次验密），任务在 `key_rotation_journal` 中记录新旧 Key ID 与逐项进度，按加密字段清单逐条重加密：数据库字段每条以独立小事务更新；快照文件只重新包裹文件头中的数据密钥，写入临时文件、`fsync` 后原子改名替换（快照文件由“文件头 + 正文密文”组成，`cluster_snapshots.sha256` 只覆盖正文密文，文件头由包裹密钥自身的认证标签保护，因此重新包裹不改变索引中的校验值，不存在文件与索引不一致的窗口）；轮换期间对正在处理的快照文件加文件级锁，阻止其下载、恢复与删除，进度记录逐个文件登记“已包裹”状态，崩溃恢复时按文件头中的 Key ID 判断该文件是否已完成；升级前数据库备份逐个打开并按同样方式重加密。中途崩溃或重启后从进度记录继续，已完成的条目因 Key ID 已是新密钥而自动跳过。
     3. 全部条目完成后执行一次全量核验（扫描清单中所有位置，确认不再存在旧 Key ID），通过后进度记录置为 `completed`，界面提示管理员把新密钥改为 `master_key`、移除旧密钥并重启。
     4. 重启时启动自检确认无旧 Key ID 引用；若管理员过早移除旧密钥，服务拒绝启动并提示恢复旧密钥后续做轮换。
     全过程写入审计日志；控制面定时灾备包与迁移包使用各自的口令加密，不受主密钥轮换影响。
3. **首次初始化安全（Setup Wizard + 一次性 Setup Token）**：
   - 当 `admins` 表为空时，控制面启动即生成一次性随机 **Setup Token**（仅输出至本地终端并写入权限 `0600` 的 `setup.token`，默认仅建议经本地或受控网络访问）。
   - `POST /api/v1/auth/setup` 在单一 `BEGIN IMMEDIATE` 事务内原子完成“校验并消耗 Setup Token → 断言 `COUNT(admins) == 0` → 创建首个 `admin` 角色账号 → 生成默认 Ed25519 SSH 密钥对”，消除公网抢注与并发创建多个初始管理员的窗口。
4. **认证、CSRF、会话撤销与 SSE 生命周期**：
   - 密码采用 Argon2id 哈希；生产环境强制经 HTTPS 访问，登录态使用 `Secure + HttpOnly + SameSite=Lax` Cookie 承载随机会话令牌，服务端在 `admin_sessions` 中保存其哈希并逐请求校验（含绝对过期 `auth.session_ttl_hours` 与空闲过期 `auth.session_idle_minutes`）。
   - 会话按设备独立管理：登出只删除当前会话；修改密码时保留当前会话并删除该账号其他会话；停用账号或变更其角色时删除该账号的全部会话（同时关闭其已建立的 SSE 流与交互式终端、作废未使用的 Exec 票据）；管理员可在「账号与会话」页查看并注销任意会话；迁移导入整表清空会话。
   - 所有变更类请求强制校验 `Origin`/`Referer` 及与会话绑定的 CSRF Token（`X-CSRF-Token`），严格限制带凭据 CORS 仅允许同源或显式白名单。同源判定以启动配置 `server.public_url`（浏览器访问管理端使用的外部地址，如 `https://deck.example.com`）为准，不信任请求自带的 `Host`；未配置时默认取监听地址与本机主机名，以反向代理方式部署（`tls.mode = proxy`）时必须配置。
   - 活跃 SSE 连接与交互式终端 WebSocket 均绑定 `session_id`，会话被删除或过期时主动断开对应的 SSE 流与终端，并对单会话并发流数量、缓冲区大小与慢消费者实施上限保护。WebSocket 仅用于交互式终端，其票据与同源校验机制见 5.7。
   - 同一账号或来源 IP 连续失败达阈值（默认 5 次）触发指数退避锁定，并写入审计日志。
5. **账号角色、账号管理与本机救援**：
   - **两种角色**：
     - `admin`：全部权限，包括所有变更操作、交互式终端、Variables 原文查看、Allocation 文件下载、Vault 离线备份与迁移/灾备导出、账号管理与系统设置；
     - `viewer`（只读运维）：可查看仪表盘、主机、集群、Job 与运行态工作台全部视图（含运行端口、资源利用、Allocation 日志、Evaluation）、运维任务日志、定时任务历史与审计日志；不能执行任何变更操作。
   - **敏感读取的权限矩阵**：以“能否取得内容”而不是“是否有下载按钮”划分，同一内容的所有读取路径（预览、分段读取、下载、导出）适用同一规则：

     | 内容 | `admin` | `viewer` |
     | :--- | :--- | :--- |
     | Allocation 日志（stdout/stderr） | 可读 | 可读 |
     | Allocation 文件列表与元数据 | 可读 | 可读 |
     | Allocation 文件内容（文本预览、分段读取、下载） | 可读 | 不可读 |
     | Job 结构化摘要（见下文“Job 安全投影”） | 可读 | 可读 |
     | Job 完整定义（现网 JSON、原始 HCL、Submission、历史版本内容与完整 Diff） | 可读 | 不可读 |
     | Job 变量覆盖值 | 可读 | 不可读 |
     | Nomad Variables 原文 | 可读（写审计） | 仅路径与元数据 |
     | Vault KV 原文与版本内容 | 可读（写审计） | 仅挂载点、路径与元数据 |
     | Vault Policy、Auth 方法配置 | 可读 | 可读 |
     | Raft 快照下载、迁移包与灾备包导出、离线密钥备份 | 可用（二次验密） | 不可用 |
     | 交互式终端与 Job Action | 可用 | 不可用 |
     | 系统设置中的敏感项（代理密码、备份口令等） | 仅“已设置”标记 | 不可见 |

   - **Job 安全投影**：HCL 变量在解析后会被展开进 Job 定义（如 `PASSWORD = var.password` 在 JSON 中即为明文），`env`、`template` 内容、命令参数、`artifact` 地址与 `meta` 中也可能直接写有凭据，按字段脱敏无法可靠识别所有敏感值。因此 `viewer` 从不获得任何形式的完整 Job 定义，只获得由服务端按白名单生成的结构化摘要：Job 的 ID、类型、Namespace、Region、Datacenter、Node Pool、优先级、`update`/`periodic` 策略；Group 的副本数、网络模式与端口标签、服务名称与健康检查类型、卷名称与类型；Task 的名称、驱动、Docker 镜像、资源配额、生命周期、挂载目标路径与服务注册。版本对比对 `viewer` 只展示摘要字段的差异。完整定义的全部读取路径（Job 详情原文、Submission、历史版本、完整 Diff、导出）仅限 `admin`。Nomad 原生 UI 不受 NomadDeck 角色控制，能否在其中查看 Job 定义取决于登录所用 Nomad ACL Token 的权限；为人员签发 Token 时（见 5.3）应按同样原则只授予必要的 Namespace 读取权限。

   - 权限在服务端按接口强制校验：所有变更类接口与上述敏感读取接口要求 `admin` 角色，`viewer` 调用时返回 403；前端只做隐藏按钮的体验优化，不作为权限依据。
   - Setup 向导创建的首个账号为 `admin`。`admin` 可新增账号并指定角色、修改他人角色、停用或启用账号、为他人重置密码，所有操作二次验证当前密码并写入审计；系统禁止停用或降级最后一个启用状态的 `admin`。
   - 全部管理员遗忘密码时，在控制面宿主机本机执行 `nomad-deck admin reset-password --username <name>` 子命令重置密码、解除锁定并清空该账号会话；该命令要求能读取数据目录与主密钥，执行结果写入审计日志。
6. **敏感凭据与日志保护边界**：
   - 所有 API 响应永不返回明文私钥、Unseal Keys 或管理 Token（仅返回是否已配置、指纹、前缀或更新时间）；Vault 离线紧急备份与环境迁移导出均须二次复核当前管理员密码，且授权严格绑定当次导出参数与范围。
   - 涉及敏感凭据的 SSH/API 操作不记录原始输入输出（仅写结构化状态）；所有运维步骤日志在落盘和经 SSE 广播前均通过流式脱敏器过滤（匹配 Token、PEM 私钥、Vault 密钥、Bearer 头及常见密钥模式）。
   - 明确界定存储语义：Nomad Job 的 `hcl_content` 与 `form_spec_json` 按应用编排清单明文存库（并非 KMS 密库），UI 明确提示工作负载机密应通过 Vault Workload Identity 与 `template` 注入，避免在 `env` 中硬编码明文密码。
7. **SQLite 并发隔离、多维互斥锁与安全崩溃恢复**：
   - 数据库层采用读写分离连接池：写连接池上限固定为 1 并配置 `busy_timeout`，消除异步任务、定时巡检与审计写入同时争抢写锁导致的 `SQLITE_BUSY`；长耗时任务只在状态变更时短暂持有写事务。
   - 异步任务引擎维护两级读写锁：**集群级锁（`cluster_id`）**与**主机产品级锁（`(node_id, cluster_type)`）**，每种锁区分**共享模式**与**独占模式**：
     - 共享模式：Raft 快照导出、Doctor 体检、健康巡检等不改变集群状态且有明确结束时间的任务，彼此可并行；每个共享任务都有超时上限（默认 30 分钟），超时即中止并释放锁；
     - 不占用运维锁：日志订阅（`journalctl`、Allocation 日志）、运行态视图、资源统计、交互式终端等长连接或只读查询只在建立时读取一次资源状态，不持有任何运维锁，因此无论打开多久都不会阻塞变更任务；
     - 独占模式：部署、扩缩容、升级、配置变更、证书与密钥轮换、快照恢复、卸载、联动 Apply 等变更任务，与任何其他任务互斥；
     - 自动解封与手动解封按共享模式加集群锁、按独占模式加对应主机产品锁，因此快照备份或体检期间节点意外密封仍能被及时解封，而升级、恢复等独占任务进行期间由该任务自身负责解封。
   - 跨集群任务（如 Nomad ↔ Vault 联动 Apply）按固定 `cluster_id` 字典序加锁避免死锁。
   - **远端步骤脱离 SSH 会话执行**：SSH 会话断开时，远端会话内的进程默认随之终止。因此所有可能超过数秒的远端步骤（下载解压、安装、配置切换、服务重启与验活脚本）均通过 `systemd-run --unit=nomad-deck-op-<remote_op_id>-<step>` 作为临时 systemd 单元执行，控制面崩溃或网络中断不会中止远端步骤。
   - **步骤结果持久化**：临时单元在成功结束后会被 systemd 回收，主机重启也会使其消失，因此结果不依赖 systemd 的内存状态。每个远端步骤由 NomadDeck 下发的固定包装脚本执行：开始时写入 `/opt/nomad-deck/<product>/.op-results/<remote_op_id>-<step>.json`（状态 `running`、开始时间），步骤输出同时写入同目录的日志文件，结束时写入状态、退出码、结束时间与结果摘要并 `fsync` 后才退出。控制面跟随日志文件获取实时输出，重连后以结果文件判定步骤结局；结果文件在所属任务结束并完成核对后清理。
   - 控制面启动时扫描残留的 `running` 任务（`system.self_update` 任务除外，它由新版本的就绪确认或自动回退流程收尾，见 5.12），将其标记为 `needs_reconcile` 并将关联集群置为 `maintenance_mode=1`（`maintenance_reason=needs_reconcile`），**不盲目释放锁**。管理员或恢复核对流程通过 SSH 读取目标机 `/opt/nomad-deck/<product>/.op.lock`（比对 `remote_op_id`），读取 `.op-results` 中对应步骤的结果文件（结果为 `running` 时再确认临时单元是否仍在运行，单元已不存在则判定为被中断），并结合远端服务与 Raft 实时状态判定步骤是已完成、仍在运行、已失败还是被中断，再执行安全补偿与解锁。

### 5.2 纯 Go SSH + SFTP 远端执行与节点纳管

1. **密钥分发体验**：
   - 在「SSH 密钥」页可一键生成新 Ed25519 密钥对或导入已有私钥。
   - 在「添加主机」页支持两种免密配置方式：
     - **手动粘贴模式**：UI 提供公钥文本和一条可复制的 `mkdir -p ~/.ssh && ...` 初始化命令；
     - **一键推送公钥模式**：管理员在表单临时输入目标机 SSH 密码，后端通过 Go SSH 建立一次性连接，先检查 `~/.ssh/authorized_keys` 去重后再追加写入公钥并校验目录/文件权限（`0700`/`0600`）；若目标机启用 SELinux，自动尝试执行 `restorecon -Rv ~/.ssh`。**密码仅驻留内存、执行完即销毁、绝不落库和写审计**。
2. **连接安全、命令边界与环境探测**：
   - 首次连接采用 TOFU 策略记录目标机 Host Key 指纹；后续连接强制比对，如主机重装导致指纹变化，UI 明确告警并允许管理员确认后重置。
   - **提权命令与文件信任边界**：所有远端 SSH 命令均采用固定模板执行，严禁直接拼接未校验用户输入；版本号、路径、服务名、卷名与日志参数均通过严格白名单正则校验、POSIX 单引号转义并附加 `--` 选项终结符。通过 `sudo` 落位敏感文件前，先传入受保护的 `0700` staging 目录，由特权步骤校验其为普通文件、非符号链接且 SHA256 与预期一致，再执行同文件系统 `fsync` + `mv -Tf`（`rename`）原子替换。
   - 连通性测试同时自动探测：Linux 发行版、版本代号与包管理器（`os_family`、`os_codename`、`package_manager`，用于选择 Docker 安装包）、CPU 架构（`amd64`/`arm64`）、`systemctl`/`journalctl`/`tar`/`gzip`/`sha256sum` 可用性、当前用户免密 `sudo` 权限（`sudo_ready`）、SELinux 状态（`selinux_mode`）、Swap 启用状态（`swap_enabled`）、Docker Engine 安装来源、运行状态与版本（`docker_mode`、`docker_status`、`docker_version`）、`machine_id`、时间同步状态（`time_sync`，读取 systemd-timesyncd 或 chrony 的同步标记，并比较目标机与控制面的时钟偏差）以及 `/opt/nomad-deck` 可写性。
   - **时间同步前置检查**：TLS 证书有效期与 Workload Identity JWT 校验都依赖准确时钟。部署、扩容、证书签发与联动 Apply 前，目标节点未同步或与控制面偏差超过 30 秒时拦截并展示配置指引；健康巡检持续检测并在偏差超限时告警。
   - **Docker Engine**：由 NomadDeck 安装、升级并托管其守护进程配置（含镜像拉取代理），机制见 5.3 第 6 项。节点启用 Nomad Docker 驱动时，部署与配置变更前置检查要求 Docker 处于运行状态；未安装时可在同一任务中自动安装。
   - 若普通用户未配置免密 `sudo`，UI 展示明确的 `sudoers` 配置指引并在发起需提权的运维任务前拦截；若目标机处于 SELinux `enforcing` 或开启防火墙，在节点详情和部署前预检中给出上下文标签与端口放行提示（Nomad `4646/4647/4648`、Vault `8200/8201` 及业务端口）；Vault 节点预检发现未加密 Swap 开启时阻断生产部署或要求显式确认。
3. **可信校验、原子分发与下载中转**：
   - **统一由控制面中转分发**：Nomad、Vault、CNI Plugins 与 Docker 的全部安装包只由控制面下载并完成校验，再分发给目标节点。**被管节点从不访问外网发布源**，无需外网或代理出口，也无需安装 `unzip` 与额外的包下载工具；同一版本无论安装多少节点都只下载一次。
   - **PGP 签名 + SHA256 双重校验**：下载官方或镜像源 release 时，不仅比对 `*_SHA256SUMS`，还必须使用内置固定的 HashiCorp Release Security PGP 公钥（支持系统设置轮换）验证 `*_SHA256SUMS.sig` 签名，防止镜像源被篡改后同时替换二进制与摘要。控制面本地缓存按 `(product, version, os, arch, verified_sha256)` 严格隔离。
   - **CNI Plugins 校验**：CNI Plugins 由 containernetworking 项目在 GitHub 发布，不带 HashiCorp PGP 签名，因此采用固定摘要校验：每个 NomadDeck 发布版本内置一份经构建流程核对的 CNI 版本与各架构压缩包 SHA256 对照表，只允许安装表内版本；管理员如需安装表外版本，须在系统设置 `release.cni_checksums` 中手工登记该版本各架构的 SHA256（登记操作写审计），下载后严格比对，上游同目录的摘要文件仅作提示、不作为信任依据。
   - **Docker 安装包校验**：Docker 官方软件仓库的元数据由 Docker 发布 GPG 密钥签名，Debian 系仓库与 RHEL 系仓库各使用一把密钥（指纹分别为 `9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88` 与 `060A 61C5 1B55 8A7F 742B 77AA C52F EB6B 621E 9F35`）。控制面内置这两把公钥并在启动使用前核对指纹，系统设置 `release.docker_pgp_public_key` 可填入一个或多个 ASCII 装甲公钥块整体替换内置密钥以完成轮换。校验链为：先验证仓库签名元数据（Debian 系为 `InRelease` 的明文签名，并核对其中的发行版代号与目标主机一致；RHEL 系为 `repomd.xml` 及其 `.asc` 分离签名）→ 按签名元数据中登记的 SHA256 与大小校验软件包索引（Debian 系为 `Packages.gz`，RHEL 系为 `primary` 元数据，并在解压后核对其解压后摘要）→ 从已验证的索引中取得各安装包的路径与 SHA256，下载后逐一比对。索引中的安装包路径须为仓库内相对路径且文件名为 `.deb`/`.rpm`，否则拒绝。`docker-ce` 与 `docker-ce-cli` 取目标版本，`containerd.io`、`docker-buildx-plugin`、`docker-compose-plugin` 取仓库中的最新版本。RHEL 系安装包本身的 GPG 签名在节点安装时再次校验。可安装的 Docker 版本列表同样只取自已验证的索引，按主机的发行版、版本代号与架构查询。
   - **缓存与压缩分发**：
     - 控制面对已校验的安装包按 `(product, version, os, arch, verified_sha256)` 缓存。Nomad、Vault、CNI 在控制面解压出目标二进制后，以 gzip 压缩形式经 SFTP 传到目标节点的受保护 staging 目录（gzip 为各发行版基础组件），传输量与原始压缩包相当；Docker 安装包（`.deb`/`.rpm`）原样传输。
     - 节点侧解压后使用 `sha256sum` 校验解压出的二进制（或安装包）与控制面给出的预期值一致，校验通过才进入安装步骤，防止传输损坏或 staging 目录被篡改。
     - 同时向多个节点分发时，并发数受系统设置 `ssh.max_concurrency` 限制，并可通过 `release.transfer_rate_limit` 限制单节点传输速率，避免占满控制面上行带宽。
4. **系统代理（HTTP / HTTPS / SOCKS5）**：
   - **单一代理配置**：控制面只有一个系统代理，在系统设置中配置类型（`http`、`https`、`socks5`）、主机、端口、可选用户名与密码，以及不走代理的地址列表（`no_proxy`）。SOCKS5 代理由代理端解析目标域名（等同 `socks5h` 语义），适用于本地 DNS 无法解析外网域名的环境。代理密码以 `is_secret=1` 加密存储，接口只返回“已设置”标记，编辑时留空表示保持原值。
   - **连通性测试**：代理表单提供「测试」按钮，可在保存前用表单当前值测试（密码留空时使用已保存的密码）。控制面经该代理依次请求 HashiCorp Release 站点（或系统设置中的镜像源）、Docker 软件仓库、GitHub API 与 GitHub Release 文件下载域名，逐项返回是否成功、HTTP 状态码、耗时与失败原因（代理拒绝连接、认证失败、TLS 错误、超时等），并展示经代理访问时的出口 IP。测试结果仅展示、不落库，测试操作写审计（不含密码）。
   - **按任务勾选**：Nomad、Vault、CNI Plugins 与 Docker 的安装、扩容、升级任务，以及控制面立即自更新与预约自更新的发起表单中，均提供「使用系统代理」勾选项。默认勾选状态取自系统设置（`proxy.use_for_releases` 控制 Nomad/Vault/CNI/Docker 相关任务，`proxy.use_for_self_update` 控制自更新）；未配置系统代理时勾选项置灰并提示先到系统设置配置。选择结果作为任务参数记录在 `operation_tasks.params_redacted_json`（只记录是否使用及代理地址，不含凭据），预约自更新的选择保存在 `self_update.schedule` 中，执行时沿用。版本列表查询按 `proxy.use_for_releases` 的默认状态决定是否经代理，界面可临时切换。
   - **作用范围**：系统代理只作用于控制面访问外网发布源（版本列表、签名与摘要文件、安装包、自更新）。被管节点从不访问外网发布源，因此不涉及节点侧代理；控制面与 Nomad/Vault HTTP API 之间的通信、SSH/SFTP 连接与灾备备份上传也不经过系统代理。节点上 Docker 拉取镜像使用的代理是 Docker 守护进程自身的配置，见 5.3 第 6 项。
   - 未勾选时直接连接；勾选后代理不可用即视为下载失败，不自动回退为直连，避免在限制出网的环境中绕过代理。签名与摘要校验不受是否使用代理影响。
5. **实时日志流**：所有 SSH 命令执行均实时捕获 `stdout`/`stderr`，经流式脱敏后写入步骤日志文件并通过绑定会话的内存 PubSub 经 **SSE** 实时推流到前端终端面板；查看节点服务日志时，通过参数校验后的固定模板执行 `journalctl -u nomad|vault -n <lines> [--since ...] [-f]` 并将流式输出经 SSE 转发到浏览器。

### 5.3 Nomad 节点与集群管理

1. **集群与节点安装编排**：
   - 支持**单机模式（Server+Client）**与**集群模式（推荐 3/5 台 Server + N 台 Client）**。
   - **TLS 强制边界与显式配置**：生产集群默认且强制启用 TLS，显式配置 `http`、`rpc`、`verify_server_hostname` 与 `verify_https_client`（禁止静默跳过证书验证）；仅在非生产实验环境允许显式勾选 `allow_insecure_http` 并持续展示安全警告。
   - **`verify_https_client` 默认关闭**：Nomad 启用 ACL 后，HTTP API 调用方身份已由 ACL Token 鉴别。开启该项会要求所有 HTTP 客户端出示集群 CA 签发的证书，导致浏览器无法直接访问 Nomad 原生 UI、Vault 无法拉取 JWKS（Vault JWT Auth 不支持客户端证书）。管理员在集群向导中显式开启时，界面列出上述影响，并要求为联动选择 5.5 所述的替代方案。
   - 创建集群并选择节点角色、目标版本与是否使用系统代理（见 5.2）后，点击「一键部署」进入异步运维任务；节点扩容与版本升级的发起表单同样提供系统代理勾选：
     1. 自动签发集群统一 CA（记录 `ca_expires_at`）、控制面专用客户端证书（`cli.<region>.nomad`，记录 `client_cert_expires_at`）以及各节点 TLS 证书。节点证书强制包含 Nomad 专属 DNS SAN（Server 包含 `server.<region>.nomad`，Client 包含 `client.<region>.nomad`，同时包含 `localhost`、`127.0.0.1`、`::1`、节点 `advertise_addr`/域名以及 TLS 透传场景下的 `public_api_url` 主机名/IP）；同时自动生成 Gossip 加密密钥。
     2. 并发安装各节点 Nomad 二进制（版本目录 + 原子软链）、创建目录与 `nomad.service`：**纯 Server 节点以低权系统用户 `nomad` 运行，含 Client 角色（`client` / `server_client`）的节点以 `root` 运行**，以满足 cgroups、CNI、Host Volume 与 Docker socket 权限要求。
     3. 按角色渲染托管配置片段至首个配置代际目录并原子软链至 `nomad.d`（`10-base.hcl`、`30-tls.hcl`、`40-telemetry.hcl`、`80-docker.hcl` 等）。
     4. 如节点启用 CNI，自动下发 CNI Plugins 到 `/opt/cni/bin`、写入 bridge sysctl 与 `83-cni.hcl`；如 Client 启用 Docker 驱动而主机尚未安装 Docker（`docker_mode=absent`），按本节第 6 项以集群默认 Docker 配置自动安装。
     5. 先启动全部 Server 并等待 Leader 选出，随后以**控制面预生成 Secret** 的方式完成 ACL Bootstrap：
        - 控制面本地生成随机 UUID 作为 Management Token Secret，加密写入 `clusters.admin_token_encrypted` 并将 `init_state` 置为 `init_in_doubt`，两者在同一事务内落库；
        - 调用 `/v1/acl/bootstrap` 并在请求体 `BootstrapSecret` 中携带该 Secret；
        - 无论调用是否收到响应，均按以下顺序确认结果（ACL 尚未初始化与已被他人初始化时，任意未知 Token 调用 `/v1/acl/token/self` 都返回相同的拒绝，无法据此区分，因此以再次 Bootstrap 的结果判定）：
          1. 以该 Secret 调用 `/v1/acl/token/self`，成功即置为 `initialized`；
          2. 失败时以同一 Secret 再次调用 `/v1/acl/bootstrap`：成功即置为 `initialized`；返回“ACL 已初始化”（附 reset index）说明集群已被其他来源 Bootstrap，保持 `init_in_doubt` 并转入受控恢复；网络错误则保持 `init_in_doubt` 并按退避重试本确认流程。
        - 由于 Secret 在调用前已经持久化，“Bootstrap 成功但凭据未保存”的窗口不存在。受控恢复入口提供两种方式：补录已有 Management Token；或按 Nomad 官方重置流程，读取 Bootstrap 失败响应中的 reset index，经 SSH 写入 Leader 数据目录下的 `server/acl-bootstrap-reset` 文件后重新执行上述 Bootstrap。
     6. 启动全部 Client，通过 Nomad HTTP API 验证所有节点进入 `ready` 状态。
2. **统一 Raft 仲裁门禁、扩缩容、证书轮换与配置变更**：
   - **统一仲裁门禁**：所有可能中断 Server 节点的变更入口（单节点/批量停服、重启、卸载、配置变更、缩容、升级）均强制经过统一 Raft 仲裁门禁——读取 Autopilot 健康接口 `/v1/operator/autopilot/health`（逐台给出 `Healthy`、`Voter`、`LastContact` 与日志索引，以及集群级 `FailureTolerance`），并以 `/v1/operator/raft/configuration` 核对成员列表；容错数取 Autopilot 报告值与“健康 Voter 数减多数派所需数”中较严格者（Autopilot 的报告在成员变更后可能滞后于 Raft 配置），仅当目标节点下线后剩余健康 Voter 仍满足多数派时才放行（目标节点健康时要求当前 `FailureTolerance ≥ 1`；目标节点本身已不健康时要求其余健康 Voter 构成多数派），批量操作逐台重新评估（单机或显式维护操作须二次强确认）。
   - **单节点安全扩缩容**：
     - **扩容（Join）**：向已有集群新增 Server 或 Client 节点，自动签发新节点证书、分发二进制与配置、按需刷新既有 Server/Client 的 `retry_join` 配置并确认新节点加入 Raft 且追平或进入 `ready` 状态；
     - **缩容（Remove）**：摘除 Client 时先标记 `ineligible`、触发 `drain` 并**轮询等待疏散完全结束**；摘除 Server 时先经仲裁门禁校验剩余在线健康 Voter 满足多数派，若目标为 Leader 则先经 Raft 领导权移交接口交给其他投票成员，随后停止该节点服务、等待剩余成员确认 Leader，再调用 `operator raft remove-peer` 移出成员并将其从 Gossip 成员中剔除，最后清理该节点的目录与 systemd 单元，防止其借 `retry_join` 重新加入（仍在运行的 Server 被移出 Raft 后会被 Leader 依据 Gossip 成员重新加入，因此移出成员必须在停服之后执行）；**`server_client` 双角色节点严格按顺序同时执行 Client 疏散与 Server 移出两套流程**。
   - **完整证书生命周期**：支持节点证书与控制面客户端证书一键续期并滚动分发；支持受控 CA 轮换（先下发包含新旧双 CA 的信任链并同步更新联动 Vault 的 `jwks_ca_pem` → 滚动重签节点与客户端证书 → 验证全部切换后移除旧 CA）。
   - **Gossip 密钥轮换**：生成新密钥并暂存 → 经 Nomad Gossip Keyring 接口在全部 Server 安装新密钥 → 切换为主用密钥 → 确认全部 Server 已使用新密钥后移除旧密钥 → 以新配置代际更新 `10-base.hcl` 中的 `encrypt`，保证后续重启使用新密钥 → 替换 `gossip_key_encrypted`。整个过程无需重启 Server。
   - 配置托管管理（UI 表单化编辑）：Docker 驱动（privileged、volumes、image GC、私有仓库 auth）、CNI、raw_exec、Driver Denylist、Host Volumes（支持远端自动创建目录与防误删校验）、Client Meta、UI 跨链接与环境标签、Telemetry。
   - **Client 主机前置条件与资源指纹**：含 Client 角色的主机须具备 `ip` 命令（iproute2），缺失时部署前检查直接拦截；无法识别 CPU 频率的主机（部分虚拟化或 ARM 环境）可在节点托管配置中设置 `cpu_total_compute` 覆盖 CPU 总算力，否则该 Client 没有可调度的 CPU 资源。
   - **版本代际原子配置变更**：构建全新完整配置代际目录 `/opt/nomad-deck/nomad/etc/releases/<gen>/`（含本代际引用的全部 TLS 材料）→ 对整目录执行 `nomad config validate` → 校验通过后通过原子软链将 `nomad.d` 指向新代际 → 经仲裁门禁按顺序重启服务 → HTTP API 验活；若验活失败立即原子切回上一代际软链并重启恢复。
3. **版本升级、版本跨度校验与安全熔断**：
   - 升级前强制展示升级计划（Dry-Run 预览：当前版本、目标版本、版本跨度校验结果、节点执行顺序、保留版本数、是否使用系统代理），并**自动执行一次升级前 Raft 快照与配置备份（校验通过后才允许继续）**。
   - **版本跨度规则**（Nomad 与 Vault 共用）：禁止降级；禁止跨主版本升级；一次跨越的小版本数超过系统设置 `upgrade.max_minor_skip`（默认 `2`）时须管理员显式确认；每个 NomadDeck 发布版本内置一份“须人工确认的版本清单”（对应官方升级说明中含破坏性变更或特殊步骤的版本），升级路径经过清单中的版本时，在升级计划中展示对应说明并要求逐项确认。规则判定不依赖手工维护的完整兼容矩阵。
   - 区分两类故障回滚策略：**新版本尚未初始化存储/变更数据格式前的启动失败**，可安全原子切回旧版二进制软链并重启恢复；**新版本已加入集群或可能已完成磁盘状态迁移后的异常（以及跨小版本/大版本升级）**，禁止自动降级二进制，立即熔断中止后续节点并引导管理员按升级前快照执行标准恢复。
   - 集群滚动顺序：**先所有非 Leader Server（逐台校验重新加入 Raft、在线 Voter 与复制进度恢复正常）→ 再 Leader Server → 最后按批次升级 Client（可选先 Drain 等待疏散完成再升级再取消 Drain）**。
4. **节点与集群 Doctor 体检**：检查 systemd 状态、运行用户与角色匹配性、二进制与元数据版本一致性、托管配置代际完整性、TLS 证书链与到期时间、HTTP API 可达性、Raft Leader 与在线 Voter 健康、Docker/CNI/Vault/Consul 集成状态，返回结构化检查项列表（`OK`/`WARN`/`FAIL` 及修复建议）。
5. **Namespace、Node Pool 与 ACL 治理（走 Nomad HTTP API）**：
   - **Namespace 管理**：列表、创建、编辑描述、删除（存在运行中 Job 时禁止删除）；集群部署完成后自动确保 `default` Namespace 存在。Namespace 是 Nomad ↔ Vault 联动中 `bound_claims` 的授权边界，联动 Role 与 Job 编排器的 Namespace 下拉均引用此处的列表。
   - **ACL Policy 管理**：Policy HCL 在线编辑、校验与删除，提供“只读运维”“单 Namespace 部署者”等常用模板。
   - **ACL Role 管理**：创建与编辑聚合多个 Policy 的 Role，签发 Token 时可绑定 Role。
   - **Node Pool 管理**：列表、创建、编辑描述与 Meta、删除（存在节点或 Job 引用时禁止删除），并展示每个 Pool 的节点数与运行中 Job 数；Client 托管配置与 Job 编排器的 Node Pool 下拉引用此处的列表。
   - **ACL Token 管理**：为人员或 CI 签发绑定 Policy 或 Role 的 Client Token（可设过期时间），Secret 仅在签发时展示一次、不入库；支持查看、吊销。控制面自身持有的 Management Token 不在列表中暴露 Secret。
6. **Docker Engine 安装、升级与守护进程配置**：
   - **管理范围与模式**：Docker 是主机级组件（同一主机可能同时属于 Nomad 与 Vault 集群，但只有 Nomad Client 需要 Docker）。每台主机的 Docker 处于三种模式之一：`managed`（由 NomadDeck 从 Docker 官方仓库安装，可安装、升级与托管配置）、`external`（主机上已存在非 NomadDeck 安装的 Docker，如发行版自带的 `docker.io`，NomadDeck 只检测状态并可托管镜像拉取代理，不执行安装与升级）、`absent`（未安装）。`external` 主机可由管理员确认后“转为托管”：先卸载原有包（存在运行中容器时拦截），再按托管方式安装。
   - **支持范围**：Docker 官方仓库覆盖的发行版（Ubuntu、Debian、RHEL 及其兼容发行版 Rocky/AlmaLinux/CentOS Stream、Fedora）与架构（`amd64`、`arm64`）；不在范围内的主机只能使用 `external` 模式。
   - **安装（全程控制面中转）**：
     1. 控制面根据主机的 `os_family`、`os_codename`、`package_manager` 与架构，经（可勾选的）系统代理从 Docker 官方仓库获取签名元数据并按 5.2 校验，确定目标版本对应的 `docker-ce`、`docker-ce-cli`、`containerd.io`、`docker-buildx-plugin`、`docker-compose-plugin` 安装包及其 SHA256，下载、校验并缓存；
     2. 经 SFTP 将安装包传到节点 staging 目录并复核 SHA256；
     3. 依赖预检：Debian 系执行 `apt-get install --simulate`、RHEL 系执行 `dnf install --assumeno` 检查安装这些本地包还缺哪些系统依赖（如 `iptables`、`container-selinux`）。缺失的依赖须能从节点已配置的发行版软件源（通常为内网镜像）获得，否则拦截并列出缺失项；
     4. 以本地包方式安装（Debian 系为 `apt-get install ./<pkg>.deb ...`，RHEL 系为 `dnf install ./<pkg>.rpm ...`，并导入 Docker GPG 公钥以校验 RPM 签名），锁定已安装版本防止系统例行升级时被意外更新（Debian 系 `apt-mark hold`，RHEL 系 `versionlock` 或 `exclude`）；
     5. 写入托管的 `/etc/docker/daemon.json`，启用并启动 `docker` 与 `containerd`，以 `docker info` 与 Nomad 节点的 Docker 驱动健康状态验活。
   - **升级**：以集群为单位滚动执行（也可单节点执行），版本只允许前进，主版本跨越须显式确认。Docker 官方只保证同一小版本内的补丁升级（如 27.3.0 → 27.3.1）能在 `live-restore` 下重新接管运行中的容器，跨小版本、跨主版本或跳过版本时不作保证，因此按升级类型区分流程：
     - **原地升级（不 Drain）**：只在同时满足以下条件时允许，此时依赖 `live-restore` 保持容器运行，管理员也可选择先 Drain：目标版本是当前版本所在小版本的**下一个补丁版本**（不跳过任何补丁版本）；`containerd.io` 同样只做补丁升级；同一任务中不修改 `daemon.json`（尤其是 `data-root`、存储驱动、cgroup 与运行时相关选项）；
     - **Drain 后升级**：不满足上述条件的升级（跳过补丁版本、小版本或主版本升级、伴随守护进程配置变更）强制先将该 Client 标记为不可调度并 Drain，等待疏散完成后再升级，或由管理员显式确认在维护窗口内接受容器中断；
     - 逐台执行：（按上述规则 Drain）→ 解除版本锁定、以本地包方式升级、重新锁定 → 重启 Docker → 验证 → 恢复调度。验证分两种情形：
       - 原地升级：`docker info` 正常；升级前记录的每个运行中容器（按容器 ID）仍处于运行状态且可被 Docker 正常管理（可执行 inspect）；对应 Nomad Allocation 健康检查通过；Nomad Docker 驱动恢复健康；
       - Drain 后升级：`docker info` 正常；Nomad Docker 驱动恢复健康；在该节点上运行一个临时测试容器验证拉取与启动；恢复调度后被疏散的 Allocation 已在集群中（本节点或其他节点）恢复健康；
     - 任一节点验证失败即熔断并停止后续节点。只有原地升级（下一个补丁版本）允许按缓存的上一版本安装包降级回退；其余升级路径不承诺可回退（Docker 可能已迁移本地数据格式），失败节点保持不可调度并引导人工处理。
   - **托管的守护进程配置**（`/etc/docker/daemon.json`；JSON 不支持注释，托管标记记录在同目录的 `daemon.json.managed-by-nomad-deck` 文件中）：
     - `live-restore: true`（Docker 守护进程重启及补丁版本升级期间容器继续运行，Nomad 任务不中断；跨小版本或主版本升级的处理见上文）；
     - 日志驱动与轮转（默认 `json-file`，`max-size`/`max-file`）；
     - 可选的镜像加速地址（`registry-mirrors`）与数据目录（`data-root`，仅允许在首次安装时设置）；
     - **镜像拉取代理**：Docker 守护进程拉取镜像时使用的 HTTP/HTTPS 代理及 `no-proxy` 列表，写入 `daemon.json` 的 `proxies` 字段（`external` 模式下若版本过低不支持该字段，改为写入 `docker.service` 的 systemd drop-in 环境变量）。代理可选择“沿用系统代理”或单独填写节点可达的代理地址（节点访问代理的网络路径可能与控制面不同）；含认证信息时配置文件权限设为 `0600`。`no-proxy` 默认包含 `localhost`、`127.0.0.1`、集群节点网段与私有镜像仓库地址。
     - 配置变更按“写入新文件 → `dockerd --validate` 校验 → 原子替换 → 重启 Docker → 验活，失败则恢复旧文件并重启”执行；
     - **代理测试**：配置表单提供「从节点测试」按钮，经 SSH 在所选节点上使用待保存的代理访问 Docker Hub（或配置的镜像仓库）的 Registry 接口，返回是否成功、状态码、耗时与失败原因。
   - **默认值继承**：Nomad 集群级配置（`clusters.config_json.docker_defaults`）定义默认 Docker 版本、镜像拉取代理、镜像加速与日志轮转，主机级配置（`nodes.docker_config_json`）可逐项覆盖。
   - Docker 的安装、升级与配置变更以 `docker.install`、`docker.upgrade`、`docker.config` 异步任务执行，按独占模式加主机产品级锁 `(node_id, docker)`，并以共享模式加该主机所属 Nomad 集群的集群锁（与该集群的独占任务互斥），步骤日志与审计同其他运维任务。

### 5.4 Vault 节点与集群管理（含加密托管解封）

1. **安装与 Raft 集群部署**：
   - 支持单机与多节点 Raft HA 集群（推荐 3/5 节点）。部署、扩容与升级的发起表单与 Nomad 一致，提供目标版本与是否使用系统代理的选择（见 5.2）。
   - 生产集群强制启用 TLS（非生产环境须显式勾选 `allow_insecure_http` 并禁止在明文 HTTP 下启用托管自动解封）。由控制面自动签发集群统一 CA（记录 `ca_expires_at`）与各节点 SAN 证书（覆盖 `localhost`、`127.0.0.1`、`::1`、节点 `advertise_addr`/域名及 `public_api_url` 域名），写入 `config.hcl` 的 `disable_mlock = true`、`api_addr`、`cluster_addr`、`storage "raft"` 与 `retry_join`（附 `leader_ca_cert_file`）；Vault 2.0 及以上版本默认拒绝未认证的 `generate-root` 与 Rekey 请求，控制面对 Rekey 请求携带运维 Token，并为这些版本写入 `enable_unauthenticated_access = ["generate-root"]`，使运维 Token 失效时仍可凭阈值数量的 Unseal Key 走应急恢复流程，`vault.service` 设置 `LimitCORE=0`，部署预检核查宿主机 Swap 已禁用（或已批准加密 Swap）。
   - 启动服务后，Vault 默认处于未初始化、密封状态（HTTP 501）。
2. **初始化、Shamir 两阶段 Raft 加入与凭证生命周期**：
   - 管理员在 UI 点击「初始化集群」，设定 `key_shares`（默认 5）与 `key_threshold`（默认 3）。
   - **不可原子化窗口治理**：调用首节点 `/v1/sys/init` 前，先将集群 `init_state` 置为 `init_in_doubt`；收到响应后立即把 Unseal Keys 作为第 `1` 代 `active` 密钥写入 `vault_unseal_key_generations`、把 Root Token 暂存于 `bootstrap_root_token_encrypted`，完成后续凭据收敛与离线备份确认提示后，才置为 `initialized` 并允许接入业务。若调用途中断网或崩溃导致集群处于 `init_in_doubt`，严禁盲目重试 Init，仅允许管理员补录已取得的密钥或针对确认无业务的新集群执行受控清理重建。
   - **Vault Shamir Raft 两阶段加入顺序（关键协议）**：
     1. 仅对首个节点执行 Init，随后直连首节点 `api_addr` 提交 Unseal Keys 完成解封使其成为 Active Leader；
     2. 其他节点**严禁单独执行 Init**：启动 `retry_join` 或显式调用 `/v1/sys/storage/raft/join` 进入 Shamir Join 挑战阶段 → 控制面直连该加入节点 `api_addr` **提交现集群的 Unseal Keys 进行解封以完成两阶段挑战** → 轮询确认该节点已加入 Raft Peers 列表、日志追平且 `sealed=false`、`raft_role=standby`、`is_voter=1`。
   - **派生专用运维 Token 并吊销 Root Token**：首节点解封后，控制面依次执行：
     1. 写入最小必需运维 Policy；
     2. 以 orphan 方式创建周期性 Admin Token（`token_period` 默认 `168h`），使其不挂在 Root Token 之下、不会因 Root Token 被吊销而连带失效；
     3. 将 Admin Token 加密写入 `vault_secrets_custody.admin_token_encrypted` 并记录 `admin_token_expires_at`；
     4. 以新 Admin Token 验证可用后吊销 Root Token，并清空 `bootstrap_root_token_encrypted`。
     任一步骤中断时集群保持 `init_in_doubt`，恢复流程按暂存材料从中断处继续执行。常态下系统内不存在长期有效的 Root Token。
   - **启用 Vault 审计设备**：初始化完成后立即启用文件审计设备，写入各节点 `/opt/nomad-deck/vault/logs/audit.log`，同时下发 logrotate 配置。Vault 在全部审计设备都写入失败时会拒绝服务请求，因此部署前检查要求日志所在分区预留足够空间，健康巡检与 Doctor 监测该分区使用率（默认超过 80% 告警），审计设备异常时在仪表盘告警。管理员可在 Vault 管理页追加 syslog 等第二审计设备作为冗余。
   - **运维 Token 生命周期与应急恢复**：内置定时任务每 6 小时续租一次 Admin Token，`token_period` 远大于续租间隔，控制面短时停机不会导致 Token 过期；续租失败立即告警。Token 已失效时，**禁止静默提权**，仅允许管理员显式发起应急恢复并二次验密：控制面使用当前代际 Unseal Keys 走 Vault `generate-root` 流程生成临时 Root Token，用其重新签发 orphan Admin Token 后立即吊销该临时 Root Token，全过程写入审计。
3. **节点级托管解封与安全封存抑制**：
   - **手动一键解封与安全封存**：UI 展示每台 Vault 节点独立的 `is_sealed` 状态，提供单节点/全集群解封与手动安全封存（Seal）按钮；所有解封与探测始终直连目标节点 `cluster_nodes.api_addr`（不经统一 VIP/LB）。Vault 只允许经 API 封存 Active 节点，对 Standby 节点的封存请求会被拒绝，因此 Standby 节点的封存以经 SSH 重启其 `vault.service` 实现（重启后节点处于密封状态）；全集群封存先逐台重启封存 Standby，最后经 API 封存 Active 节点。
   - **控制面自动解封与抑制机制**：仅在 `auto_unseal_by_deck=1`、集群未处于维护模式且 `unseal_suppressed_reason` 为空时生效。管理员手动 Seal 或触发安全封存锁定时自动写入 `unseal_suppressed_reason`（如 `manual_seal` / `incident_lock`），此后自动解封巡检持续跳过该集群，直至管理员显式解除抑制。节点磁盘不存放明文 Unseal Key 配置文件，配合禁用 Swap 与 `LimitCORE=0` 降低内存密钥落盘风险。
   - **离线紧急备份**：二次验密后导出当前代际（可选包含全部历史代际）Unseal Keys 的离线备份文件，以管理员设置的备份口令经 Argon2id + AES-256-GCM 加密。备份文件记录集群名称与密钥代际，Rekey 后界面提示重新导出。
   - **离线解密工具与格式**：备份文件采用公开的稳定格式（魔数与格式版本、Argon2id 参数与盐、AES-GCM Nonce、加密的 JSON 载荷，载荷含集群名、代际、阈值与密钥列表），格式说明随发布物提供。NomadDeck 程序内置不依赖服务、数据库与主密钥的离线子命令 `nomad-deck offline-backup decrypt <文件>`，在任意机器上仅凭备份文件与口令即可解出密钥；随后在装有 Vault CLI 的机器上逐台对 Vault 节点执行 `vault operator unseal` 并提交阈值数量的密钥。
4. **Unseal Key 轮换（Rekey）**：
   - 管理员二次验密后发起，控制面以 `require_verification=true` 调用 Rekey 接口并提交当前代际的阈值数量密钥；
   - 收到新密钥后立即以“历史最大编号加 1”作为新代际编号写入 `vault_unseal_key_generations`（`state=pending_verification`），同时保存 Vault 返回的 `verification_nonce`（验证阶段必须携带），此时 Vault 仍使用旧密钥；
   - 提交最后一份（达到阈值的）新密钥进行验证之前，先把新代际状态置为 `verification_in_doubt` 并落库，再提交；收到验证成功响应后，在同一事务内将新代际置为 `active`、原生效代际置为 `retired`，并把 `seal_generation` 指向新代际；
   - **中断处理**：
     - 新密钥落库前中断：新密钥因未经验证而从未生效，控制面取消本次 Rekey 后可安全重试；
     - 落库后、尚未提交最后一份验证密钥前中断（`pending_verification`）：以已落库的新密钥与 nonce 继续验证；
     - 已提交最后一份验证密钥但未收到或未记录响应（`verification_in_doubt`）：Vault 可能已经切换到新密钥，**禁止取消并重试**。控制面先查询 Rekey 验证状态，若验证流程仍在进行则继续提交；若已不存在进行中的验证，则选择一个核对节点执行受控封存后再解封：多节点集群在仲裁门禁允许的前提下选择一台 Standby，以重启其服务的方式封存；单节点集群只能封存唯一节点，会造成服务中断，须管理员显式授权维护窗口后才执行。解封结果按证据判定：
       - 以新代际密钥解封成功：确认 Vault 已切换，按上一步完成本地激活；
       - 新代际密钥被 Vault 明确判定为无效密钥（而非网络、存储或服务异常），且随后以原代际密钥解封成功：确认 Rekey 未生效，将新代际置为 `abandoned` 保留备查；
       - 其他任何情况（请求超时、连接失败、Vault 返回非密钥类错误、两代密钥都被拒绝等）均视为证据不足：不改变任何代际状态，两代密钥均保留，集群保持维护态与自动解封抑制，界面提示管理员排查后重新执行核对。
       整个核对过程中集群处于维护态并暂停自动解封。
   - 旧代际密钥持续保留，用于恢复 Rekey 之前生成的快照。
5. **日常运维、仲裁门禁、扩缩容、证书续期、升级与 KV v2 治理**：
   - 所有可能中断节点的操作（停服、重启、配置更新、缩容、升级、卸载）均统一经由 Raft 仲裁门禁：读取 Autopilot 状态接口 `/v1/sys/storage/raft/autopilot/state`（逐台给出 `healthy`、`status`、`last_contact` 与日志索引，以及集群级 `failure_tolerance`），并以 `/v1/sys/storage/raft/configuration` 核对成员列表，放行规则与 Nomad 一致。
   - **单节点扩缩容与证书轮换**：
     - **扩容（Join）**：签发新节点证书、安装并写入 `retry_join`（严禁对新节点执行 Init）→ 触发/等待进入 Join 挑战阶段 → 直连新节点提交现集群 Unseal Keys 完成两阶段加入 → 验证追平并成为健康 `standby`；
     - **安全缩容（Remove）**：若目标为 Active 先执行 `step-down`，校验剩余在线健康 Voter 满足仲裁后调用 `/v1/sys/storage/raft/remove-peer` 移出节点，随后停服并清理配置防止其借 `retry_join` 重新加入；
     - **证书续期与 CA 轮换**：支持节点证书一键续期（Standby → Active 顺序滚动分发、生效并解封）与双 CA 重叠轮换（同步更新联动 Nomad 节点的 `vault-ca.crt`）。
   - **滚动升级与安全熔断**：升级前按 5.3 的版本跨度规则校验并生成/验证升级前 Raft 快照；顺序为**逐台升级 Standby（升级 → 重启 → 直连自动解封 → 校验恢复健康 `standby` 且 `is_voter=1` 与复制正常）→ 全部 Standby 健康后正常停止旧版本的 Active 节点（不使用 `step-down`，避免升级流程中领导权回到旧版本节点），确认已升级的节点接管为 Active 后，再升级原 Active 节点、启动并解封，校验其以健康 `standby` 重新加入**；若新版本可能已修改存储状态则严禁自动降级回切旧二进制，立即熔断并引导按快照恢复。
   - **Vault 业务管理页（走 Vault HTTP API）**：Auth 方法管理、Policy HCL 在线编辑、**多引擎 KV 安全管理**（支持嵌套挂载路径，如 `apps/prod/kv/`，API 通过查询参数传递 `mount` 与 `path`；KV v2 读取携带 `version`，写入强制传 `cas` 防并发覆盖，冲突返回 409 要求刷新重读；明确区分 `soft-delete` 软删除、`destroy` 销毁版本与 `delete-metadata` 删除元数据三种动作）、证书到期检查与 `doctor` 诊断。

### 5.5 Nomad 与 Vault 集群级联动（Workload Identity / JWT）

在 UI 中通过「集群联动」模块将 Nomad 集群与 Vault 集群打通，严格执行资源归属隔离（`UNIQUE(target_cluster_id, auth_path)`，Nomad Community 版每个源集群仅允许绑定一个生效 Vault 集群），支持 **Plan 预览 → Apply 执行 → 四段式 Doctor 体检**。一个联动由两层组成：联动级配置（JWT Auth Mount、JWKS 来源、Nomad 侧 `60-vault.hcl`）与其下的多个工作负载 Role（每个应用或 Namespace 一个 Role 及其 Policy）：

1. **Plan 预检**：
   - 检查 Vault 是否已初始化且全节点已解封、派生运维 Token 有效性与权限、资源归属与唯一性约束（防止覆盖其他集群共用的 Auth Mount 或 `60-vault.hcl`）、Nomad 集群 JWKS 端点可达性；
   - **mTLS 冲突校验与公钥轮换方案**：Nomad 集群默认 `verify_https_client = false`，JWKS 可被 Vault 直接拉取；若管理员显式开启了 `verify_https_client = true`，Plan 阶段明确拦截并提示冲突（Vault 拉取 `jwks_url` 不支持 mTLS 客户端证书），提供两种受控方案：① 关闭 `verify_https_client`（或在 JWKS 路径前置仅暴露 `/.well-known/jwks.json` 的受限只读代理以保留其余管理接口 mTLS）；② 切换为静态 `jwt_validation_pubkeys` 模式，并自动启用配套的**公钥重叠轮换任务**（提前拉取新公钥与旧公钥合并写入 Vault，待旧 JWT 过期后再移除退休公钥）；
   - **高可用入口检查**：优先采用 Nomad 与 Vault 集群的 `public_api_url`（VIP/域名）生成 `jwks_url` 与 `vault.address`；若多节点集群未配置统一入口而回退指向单台节点地址，Plan 阶段显式给出单点故障告警；
   - 展示待生成的 Vault Policy、完整 JWT Role JSON 与 Nomad `60-vault.hcl` 预览，并标明本次变更的作用范围：仅 Vault 侧（Role/Policy/Mount 配置）或同时涉及 Nomad 侧（`60-vault.hcl` 渲染摘要与 `nomad_config_sha256` 不同），后者才需要滚动重启 Nomad。
2. **Apply 编排**（按固定 ID 顺序同时获取 Nomad 与 Vault 集群互斥锁）：
   - **双向 TLS 信任配置**：
     - 将 Vault 集群 `ca.crt` 作为 `tls/vault-ca.crt` 写入 Nomad 集群全部节点的新配置代际（仅在内容变化时生成新代际）；
     - 将 Nomad 集群 `ca.crt` 写入 Vault JWT Auth 配置的 `jwks_ca_pem` 字段（确保 Vault 验签 JWKS 信任 Nomad CA）。
   - 通过 Vault API 启用/校验归属该联动的独立 JWT Auth Mount（默认 `jwt-nomad-<nomad_cluster>`），写入配置（`jwks_url` + `jwks_ca_pem` 或 `jwt_validation_pubkeys`、`jwt_supported_algs=RS256,EdDSA`、`default_role`）；
   - **最小权限工作负载 Role 与 Policy**（逐个处理 `integration_roles` 中的 Role）：
     - Policy 采用默认拒绝策略，支持两种模式：`explicit` 模式仅按 KV v2 精确授权 `secret_paths` 中目标路径的 `/data/` 与 `/metadata/`；`templated` 模式使用身份元数据模板（如按 `nomad_namespace`、`nomad_job_id` 拼接路径），一个 Role 即可覆盖“每个 Job 只能读取自己路径”的约定，新增应用无需修改 Policy；
     - JWT Role 显式配置完整必填字段：`role_type="jwt"`（避免默认 OIDC 类型）、`user_claim_json_pointer=true`、`user_claim="/sub"`（或按 Namespace 隔离的唯一身份声明，防止不同 Namespace 同名 Job 合并 Entity Alias）、**强制配置 `bound_claims`**（至少绑定 `nomad_namespace`，可选叠加 `nomad_job_id`/`nomad_task` 作为授权边界）、`bound_audiences`、`claim_mappings`（映射 `nomad_namespace`/`nomad_job_id`/`nomad_task`）与 `token_period`；
   - **按需更新 Nomad 侧**：渲染各节点 `60-vault.hcl`（`vault` 块默认未启用，Server 与 Client 两侧都显式写入 `enabled = true`；Server 侧配置 `default_identity`，Client 侧配置 `address`/`ca_file`/`jwt_auth_backend_path`，`server_client` 双角色节点同时包含两侧配置）并与 `nomad_config_sha256` 比对；内容不变时跳过 Nomad 侧全部步骤，仅新增或修改 Role/Policy 的 Apply 不重启任何 Nomad 节点。内容变化时才分发 `vault-ca.crt` 与 `60-vault.hcl`，经配置代际目录 `config validate` 通过后原子切换软链并经仲裁门禁**滚动重启（restart）**生效，完成后更新 `nomad_config_sha256`。
3. **四段式链路体检（Doctor）**：逐段校验 ① Nomad JWKS 可达性、TLS 证书链与签发 Audience → ② Nomad `60-vault.hcl` 指向的 Auth Path、Vault 地址与 CA → ③ Vault JWT Auth Mount、`jwks_url`/`jwks_ca_pem` 或静态公钥同步状态 → ④ Vault Role 完整字段（`role_type`、`bound_claims`、`user_claim_json_pointer`）、Policy 与 Secret Engine 挂载状态，并在测试验证阶段**执行真实端到端 JWT Login 换票取密验证**。
4. **示例 Job 生成**：在联动详情页可选择任一 Role 一键生成引用该 Role（匹配其 `bound_claims` 对应 Namespace/Job）与指定 KV 路径的测试 Nomad Job HCL，直接跳转到 Job 提交页验证端到端取密。

### 5.6 Nomad Job 全生命周期管理

通过 Nomad HTTP API（自动携带该集群加密托管的 Management Token，支持按集群多入口自动故障切换）实现全部操作：

1. **Job 列表与详情**：按集群、Namespace、类型（`service`/`batch`/`system`/`sysbatch` + Periodic/Parameterized 标识）、状态过滤；详情页的概览、版本、定义、部署、Allocation、Evaluation、服务、子 Job 等视图以及运行端口、资源利用、文件浏览与交互式终端见 5.7。
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
     - **字段取值与插值规则**：表单中的标量字段可以填写字面量或 `var.<name>` 引用；字符串字段中的 `${var.<name>}` 渲染为 HCL 变量插值，其余 `${...}`（如 `${attr.kernel.name}`、`${NOMAD_PORT_http}`）以及模板中的 `%{...}` 一律转义原样保留，由 Nomad 在运行时解析。
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
   - Plan 接口（`job-ops/plan`）接受两种显式标明的输入类型：`input_type=hcl`（渲染后的 HCL 与变量覆盖值，先经 `/v1/jobs/parse` 解析为 Nomad Job JSON）与 `input_type=json`（Nomad Job JSON，来自 JSON 编辑器、本地归档或历史版本，跳过解析、直接经 `/v1/validate/job` 校验）。随后对该 JSON 执行 Plan，返回结构化 Diff、当前现网 `JobModifyIndex`、内容摘要 `plan_hash`（Job JSON + 集群 + Namespace 的 SHA256，仅用于完整性校验）以及**本次 Plan 独有的 `plan_id`**（随机生成、不可预测）。控制面在内存中以 `plan_id` 为键保存一条不可变的 Plan 记录（默认 15 分钟有效），记录在服务端绑定：集群、Namespace、Job ID、Job JSON、`plan_hash`、Plan 时读取的 `JobModifyIndex`、提交选项（如 `PolicyOverride`）、输入类型与 HCL 源码、变量输入、发起会话与账号。内容相同的多次 Plan 各自生成独立记录，后一次 Plan 不会覆盖前一次；
   - Apply 接口（`job-ops/apply`）只携带 `plan_id`。每条 Plan 记录只能被 Apply 使用一次（首次调用即作废，无论成功与否）；控制面校验发起会话与账号一致、重新计算 `plan_hash` 与记录一致后，提交记录中**与审阅时完全相同的 Job JSON**，并使用该记录中的 `JobModifyIndex`（客户端无法替换），不重新解析 HCL（避免 HCL 函数、变量或解析器差异导致审阅内容与提交内容不一致）；提交至 Nomad 时开启 `EnforceIndex=true` 防止审阅与提交之间被他人并发覆盖（冲突或缓存过期返回 409 要求重新 Plan）；HCL 输入时注册请求同时携带 `Submission`（只含 HCL 源码与格式，不携带变量值——变量值仅由 NomadDeck 加密保存，避免在 Nomad 中多留一份明文），使 Nomad 能为该版本保存原始源码；提交前写入 `job_revisions`（`submit_status=in_doubt`，含加密的 Job JSON、加密的变量输入与 `base_job_modify_index`），收到 Nomad 响应后回写 `remote_job_version`、`result_job_modify_index`、`eval_id` 与 `confirmed`，支持提交途中断网时的状态对账。
   - **版本回滚**：回滚到 Nomad 仍保留的历史版本时，调用 Nomad 原生 Revert 接口并携带 `EnforcePriorVersion` 防止并发；回滚完成后按目标版本对应的 `job_revisions` 记录恢复可视化编排结构。Nomad 只保留有限数量的历史版本，目标版本已被回收时，改为以 `job_revisions` 中该版本的最终 Job JSON 作为 `input_type=json` 输入，走完整的 Plan → Apply 流程重新提交（保证与当时提交的定义完全一致，不依赖重新解析 HCL）。
4. **生命周期控制**：
   - **启动 / 恢复**：对已停止（`dead`）的 Job 一键重新提交/启动；
   - **停止（Stop）**：停止前先读取现网 Job JSON 与（如有）提交源码，以 `source=stop_archive` 写入 `job_revisions`，再调用 `DELETE /v1/job/{id}`。Nomad 会按垃圾回收策略在一段时间后清除已停止 Job 的定义，界面对已停止的 Job 提示“远端定义可能被回收”；重新启动时若远端定义仍在，直接按其重新提交，若已被回收，则以本地归档的 Job JSON 作为 `input_type=json` 输入走 Plan → Apply 流程。
   - **重启**：支持按 Job、Task Group 或单个 Allocation 触发滚动重启；
   - **彻底删除（Purge）**：调用 `DELETE /v1/job/{id}?purge=true`，UI 强制输入 Job 名二次确认。
5. **实时 Allocation 日志**：选择任意 Allocation 与 Task，支持切换 `stdout` / `stderr`、拉取尾部历史行与开启实时 Follow 流（后端对接 Nomad `/v1/client/fs/logs/{alloc_id}?follow=true` 经 **SSE** 推送至前端日志终端，支持关键字过滤与日志下载）。
6. **Job 导出**：支持单 Job 或整集群批量导出 `.nomad.hcl` 压缩包。

### 5.7 Nomad 运行态工作台（原生 Web UI 常用能力集成）

NomadDeck 在管理端内集成 Nomad 原生 Web UI 的常用查看与操作能力，管理员无需另行登录原生 UI。全部请求由控制面携带该集群托管的 Management Token 代理至 Nomad HTTP API，浏览器不接触任何 Nomad Token；全部变更类操作写审计。Nomad 原生 UI 保持开启并保留跨链接，作为企业版专属功能（Sentinel、资源配额、Optimize 等）的入口。高于版本下限（Nomad 1.9）的能力（如动态 Host Volume 需 1.10 及以上）按集群实际版本自动启用或隐藏。

1. **实时刷新机制**：
   - 列表与详情数据由控制面以 Nomad 阻塞查询（`index` + `wait` 参数）感知变化，再经 SSE 推送到浏览器；同一集群的同一查询被多个浏览器订阅时共享一个上游阻塞查询，订阅全部断开 60 秒后回收。
   - 每个浏览器标签页使用一条 SSE 连接复用该页全部订阅；控制面在 HTTPS 下启用 HTTP/2，规避浏览器对同一来源的并发连接数限制。
   - 页面切到后台时，前端暂停订阅与资源统计轮询，回到前台后重新同步。
2. **全局导航与搜索**：Region 与 Namespace 切换器（含“全部 Namespace”）；顶部全局搜索调用 Nomad 模糊搜索接口 `/v1/search/fuzzy`，可直接跳转 Job、Allocation、Client 节点、Namespace、Variables 与 CSI 卷。
3. **Job 视图**：
   - **列表**：按状态、类型、Namespace、Node Pool、Datacenter 过滤，每行展示 Allocation 状态分布条与最近一次 Deployment 状态；Periodic/Parameterized 父 Job 展示子 Job 数量。
   - **概览**：运行状态面板（期望、运行中、启动中、失败、丢失的 Allocation 计数，当前 Deployment 进度与健康 Allocation 数）、Task Group 列表、最近 Allocation 与最近 Evaluation 摘要。
   - **版本（Versions）**：基于 `/v1/job/:id/versions?diffs=true` 展示各版本及逐字段 Diff，回滚按 5.6 执行。
   - **定义（Definition）**：展示 Job JSON 与原始 HCL 源码，可切换查看任一历史版本。某一版本的 HCL 按以下顺序查找，界面在源码上方标明来源：
     1. **Nomad 提交记录**：经 `/v1/job/:id/submission?version=<n>` 查询。仅当该版本注册时附带了源码才存在（NomadDeck 自身提交始终附带；外部以纯 JSON 注册的版本没有源码），且 Nomad 只保留最近有限数量版本的源码；
     2. **NomadDeck 本地归档**：Nomad 查不到时，取 `job_revisions` 中同一集群、Namespace、Job 且 `remote_job_version` 等于该版本、状态为 `confirmed` 的记录中保存的 HCL。若 Nomad 仍保留该版本的定义，先将本地记录中解密后的 Job JSON 与 Nomad 返回的该版本定义做规范化比对（忽略 Nomad 服务端填充的字段），一致才展示并允许据此编辑；不一致则显示警告、只读展示且不提供编辑入口。若 Nomad 已回收该版本，界面标注“Nomad 中已无该版本，以下为本地归档”；
     3. **无源码**：两处都没有时只展示 Job JSON，并说明原始 HCL 不可用。
     HCL 源码中只有变量引用（如 `var.password`），不含变量值；`admin` 可在该版本的历史记录中单独查看解密后的变量值，基于本地归档进入编辑时自动带入这些变量值。有源码时可一键进入编排工作台以 HCL 编辑；没有源码时进入 JSON 编辑模式（CodeMirror JSON 编辑器，以 `input_type=json` 走 Plan → Apply），界面明确说明原始 HCL 不可用。JSON 也可经结构映射转入可视化模型（与 HCL 反解相同，无法映射的字段逐条列出并要求确认），但不能进入基于 HCL 语法树的反解流程。定义页仅 `admin` 可见。
   - **部署（Deployments）**：Deployment 历史及各 Task Group 的期望、已放置、健康、不健康、金丝雀计数；对待确认的金丝雀执行 Promote（全部或指定 Task Group），对异常部署执行 Fail、暂停或恢复。
   - **Allocations 与 Clients**：Allocation 列表（按状态、Client 节点、Task Group 过滤）；`system` 与 `sysbatch` Job 额外提供按 Client 节点展示的运行状态矩阵。
   - **Evaluations**：该 Job 的 Evaluation 列表，展开查看触发原因、状态与调度失败详情（资源不足的维度、被约束排除的节点数及原因），用于排查 Allocation 未能放置的原因。
   - **服务（Services）**：该 Job 注册的 Nomad 原生服务，以及每个实例的地址、端口、标签与健康检查结果。
   - **Periodic 与 Parameterized**：Periodic Job 展示下次触发时间并支持立即触发（`periodic/force`）与查看历次子 Job；Parameterized Job 依据 `meta_required`、`meta_optional` 与 `payload` 要求生成派发表单（Payload 支持文本与文件上传，并提示 Nomad 的 16 KiB 上限），派发后跳转到生成的子 Job。
   - **扩缩副本数**：在 Task Group 卡片上直接调整 `count`（Job 定义了 `scaling` 块时限制在 `min` 与 `max` 之间），经 `/v1/job/:id/scale` 提交并填写原因。为避免漏记与误认，扩缩按以下协议执行：
     - **发送前**：生成唯一操作 ID（`operation_id`），先写入 `source=scale`、`submit_status=in_doubt` 的 `job_revisions` 意图记录（含操作 ID、目标 Group、目标副本数与 `base_job_modify_index`）；
     - **发送**：请求携带 `EnforceIndex=true` 与 `base_job_modify_index`，并把操作 ID 写入扩缩请求的 `Meta`（`nomaddeck_operation_id`），Nomad 会将其保存在该 Group 的扩缩事件中；
     - **明确未执行**：Nomad 在提交前即拒绝的情况（参数校验失败、索引冲突、存在进行中的 Deployment）记为 `failed`，界面提示原因；
     - **成功响应**：以响应体中的 `JobModifyIndex` 定位 Nomad 生成的新版本，回写 `result_job_modify_index` 并置为 `confirmed`；
     - **结果不确定**（超时、连接中断、服务端错误等可能发生在提交之后的失败）：一律保持 `in_doubt`，不自动重试，由对账流程核对——在该 Group 的扩缩事件中查找携带本操作 ID 的事件，找到即按其关联的版本确认；未找到且 `base_job_modify_index` 之后 Job 未发生任何变化，判定为未执行（`failed`）；Job 已有变化但找不到本操作 ID 的事件（Nomad 分别写入 Job 更新、Evaluation 与扩缩事件，后两步可能失败），证据不足以唯一归属，置为 `needs_review` 交由管理员确认，禁止仅凭副本数相同自动认领；
     - 存在进行中的 Deployment 时 Nomad 会拒绝扩缩，界面提前提示该限制。扩缩记录不会被判定为外部漂移。由于 Nomad 重新提交 Job 时以定义中的 `count` 为准，保存的编排内容必须同步，否则下一次 Apply 会撤销扩缩结果：
     - 可视化模式同步更新 `form_spec_json` 中的 `count` 并重新渲染 HCL；
     - HCL 模式下，若该 Group 的 `count` 为字面量，使用 `hclwrite` 原位改写该属性（不改动其余内容）；若为变量或表达式无法安全改写，则写入 `job_revisions.count_overridden_json`，再次编辑该 Job 时显著提示“本次提交将把副本数恢复为定义值”，Plan 的 Diff 中同时高亮该项。
4. **Task Group 视图**：组内全部 Allocation、组内运行中 Allocation 的 CPU 与内存实际用量合计及其与申请量的对比、Volume 请求、扩缩副本数入口与 Scaling 事件历史。
5. **Allocation 与 Task 视图**：
   - **基本信息**：所在 Client 节点、Datacenter、客户端状态与期望状态、所属 Job 版本、状态描述、重调度链（前驱与后继 Allocation 及原因）、抢占信息。
   - **运行端口**：读取 Allocation 的已分配网络资源，逐条展示端口标签、宿主机地址与端口（`HostIP:Value`）、容器内映射端口（`to`）及网络模式，可一键复制访问地址；Job 列表与概览同时汇总展示各 Allocation 的对外地址。
   - **资源利用**：经 `/v1/client/allocation/:id/stats` 按系统设置 `nomad.stats_interval_seconds`（默认 2 秒）获取各 Task 的实时用量：CPU（MHz、占申请量百分比、被限流时间）与内存（RSS、Cache、总用量、是否超出 `memory` 动用 `memory_max`）。前端保留最近 5 分钟数据绘制折线，数据不在控制面持久化；同一 Allocation 被多个页面查看时，控制面在一个采样周期内只请求一次。历史趋势依赖 Nomad Telemetry 指标与外部 Prometheus/Grafana，详情页按系统设置 `observability.grafana_url_template` 生成 Grafana 跳转链接。
   - **Task 状态与事件**：各 Task 的生命周期类型（prestart、sidecar、poststart、poststop）、状态、重启次数与完整事件时间线（镜像拉取、启动失败原因、OOM、被信号终止等）。
   - **健康检查**：Nomad 原生服务检查结果（`/v1/allocation/:id/checks`）及 Deployment 健康判定。
   - **日志**：stdout/stderr、尾部历史、实时跟随、关键字过滤与下载，机制见 5.6。
   - **文件浏览**：经 `/v1/client/fs/ls` 与 `/v1/client/fs/stat` 浏览 Allocation 目录（`alloc/`、`<task>/local/`、`<task>/secrets/` 等）；文本文件在线预览（经 `/v1/client/fs/readat` 读取，单次预览上限 1 MiB）与流式下载，读取文件内容仅限 `admin`（权限矩阵见 5.1），预览与下载均写审计。Nomad 拒绝经文件接口读取 `secrets/` 目录下的文件内容，界面对该目录只列出文件名、大小与修改时间，并说明需通过交互式终端在 Task 内查看。
   - **操作**：重启单个 Task、重启 Allocation 内全部 Task、停止 Allocation（由调度器重新放置）、向 Task 发送信号，均写审计。
6. **交互式终端（Exec）与 Job Actions**：
   - 在 Task 上打开浏览器内终端，默认命令 `/bin/sh`，可改为其他命令；Job 中 `action` 块定义的预置动作以按钮列出，点击后在同一终端组件中执行并展示输出。
   - Nomad 的 Exec 与 Action 接口基于 WebSocket，这是 NomadDeck 中唯一使用 WebSocket 的场景。控制面在浏览器与 Nomad 之间双向转发数据帧，并施加以下约束：
     - 浏览器先通过受 CSRF 保护的 `POST` 申请一次性 Exec 票据（绑定会话、集群、Allocation、Task 与命令或 Action 名称，30 秒内有效，仅可使用一次），再携带票据发起 WebSocket 升级；申请票据与升级连接时都重新校验账号角色为 `admin` 且该集群 `exec_enabled` 为开启；
     - 升级请求严格校验 `Origin` 与 `server.public_url` 同源，并校验票据所属会话与当前会话一致；
     - 会话被注销或过期时立即关闭其全部终端；单会话并发终端数（默认 5）、空闲超时（默认 15 分钟）与最长时长（默认 4 小时）均有上限；
     - 审计记录终端的开始与结束时间、集群、Allocation、Task、命令与时长，不记录键盘输入与终端输出（可能包含机密）；
     - 每个集群可在集群配置中关闭 Exec（`clusters.config_json` 的 `exec_enabled`，默认开启），Client 托管配置同时提供 Nomad 侧的 `disable_remote_exec` 开关。
   - 以反向代理方式部署（`tls.mode = proxy`）时，代理须放行 WebSocket 升级，部署文档提供示例配置。
7. **Client 节点视图**：
   - **列表**：状态、调度资格、Drain 状态、Node Pool、Datacenter、Nomad 版本、运行中 Allocation 数、已分配 CPU 与内存占比；与 NomadDeck 主机资产及集群成员一一关联，可互相跳转。
   - **详情**：宿主机实时资源利用（`/v1/client/stats` 返回的 CPU、内存与磁盘用量，前端保留最近 5 分钟折线）、已分配资源与容量对比、运行中 Allocation、驱动检测与健康状态、Host Volume、CSI 插件、节点属性与 Meta、节点事件。
   - **操作**：切换调度资格；发起 Drain（可设截止时间、是否保留 system Job、是否立即强制 Drain）与取消 Drain；对已下线节点执行 Purge。Client Meta 的修改统一经托管配置 `72-client-meta.hcl` 下发，Nomad 动态 Meta 只读展示，避免两套来源互相覆盖。
8. **Server 视图**：Server 成员列表（地址、状态、Region、Datacenter、版本、是否 Leader）、Raft 成员与投票状态、Autopilot 健康，与 5.3 的集群管理页联动。
9. **拓扑视图（Topology）**：按 Datacenter 分组展示全部 Client 节点，每个节点以内存与 CPU 两条容量条呈现各 Allocation 的占用，可按 Job 或 Namespace 高亮，点击跳转对应 Allocation；顶部汇总集群总容量、已分配量与剩余量，用于判断剩余容量与调度是否均衡。
10. **存储视图**：CSI 卷列表与详情（所属插件、访问模式、读写占用、占用该卷的 Allocation）、CSI 插件列表及健康的 Controller 与 Node 数量，支持注销未被占用的 CSI 卷；Nomad 1.10 及以上版本额外展示动态 Host Volume。
11. **Variables**：按 Namespace 与路径树浏览 Nomad Variables，支持创建、编辑与删除；写入携带 `cas` 防止并发覆盖（冲突返回 409 要求刷新重读）；值默认遮蔽，显示原文需主动点击并写审计；界面标注 `nomad/jobs/<job_id>` 等可被对应 Job 直接读取的约定路径。
12. **Evaluation 全局视图**：集群全部 Evaluation 列表，可按状态（含 blocked）、触发类型与 Job 过滤，用于排查调度积压。

### 5.8 定时任务与 Raft 快照恢复体系

使用 `robfig/cron/v3` 驱动平台级后台定时任务，所有任务按统一配置时区（`cron.timezone`）调度，具备 `overlap_policy`（默认 `skip_if_running`，防止上次未结束或手工触发与定时任务重叠）、`misfire_policy`（重启后默认 `skip` 避免补跑风暴）与 `operation_task_id` 关联（最终执行结果由底层异步任务驱动）：

| `job_key` | 默认周期 | 用途说明 |
| :--- | :--- | :--- |
| `cluster_health_check` | `*/5 * * * *`（每 5 分钟） | 巡检所有主机 SSH 连通性、Nomad/Vault 服务状态，逐台直连节点同步 Raft Leader/Voter 与 Vault 节点级密封状态（跳过维护模式集群），刷新仪表盘健康总览 |
| `cert_expiry_check` | `0 8 * * *`（每日 08:00） | 检查所有集群 CA（`ca_expires_at`）、控制面客户端证书（`client_cert_expires_at`）及节点 TLS 证书（`cert_expires_at`）剩余有效期，小于阈值（默认 30 天）高亮告警 |
| `vault_token_renew` | `0 */6 * * *`（每 6 小时） | 续租各 Vault 集群的 orphan 周期性运维 Admin Token 并刷新 `admin_token_expires_at`；续租失败时立即告警，不自动执行 `generate-root` 应急流程 |
| `vault_auto_unseal_watch` | `*/2 * * * *`（每 2 分钟） | 扫描开启 `auto_unseal_by_deck`、未处于维护模式且 `unseal_suppressed_reason` 为空的 Vault 集群，逐台直连 `api_addr` 探测并自动解封 Sealed 节点 |
| `raft_snapshot_backup` | `0 3 * * *`（每日 03:00） | 以共享模式加集群锁，对已启用的 Nomad / Vault 集群执行 Raft Snapshot 导出（**Nomad 使用 `GET /v1/operator/snapshot`，Vault 使用 `GET /v1/sys/storage/raft/snapshot`**），校验 HTTP 200 与流完整性后加密落盘并写入 `cluster_snapshots`（记录 `product_version`、`seal_generation`、`credential_generation`）；随后将同一快照以备份口令封装为可移植归档，写入全部已配置的灾备备份目标并回读校验（见 5.10）；按保留份数轮转清理时与下载/恢复任务互斥 |
| `control_plane_backup` | `30 1 * * *`（每日 01:30） | 生成以备份口令加密的控制面灾备包（`.ndbundle`），写入全部已配置的备份目标并回读校验，按目标轮转清理（见 5.10） |
| `self_update_check` | `0 */6 * * *`（每 6 小时） | 查询 NomadDeck 自身 GitHub Release 最新正式版，有新版本时在仪表盘与「版本与升级」页提示；仅检查不安装 |
| `cleanup_audit_logs` | `0 2 * * *`（每日 02:00） | 清理超过保留天数（默认 90 天）的审计日志 |
| `cleanup_operation_logs` | `30 2 * * *`（每日 02:30） | 清理超过保留天数（默认 60 天）的运维任务步骤日志与 Cron 执行记录 |

> **Raft 快照安全恢复协议**：快照恢复由独立异步状态机按以下固定顺序执行，每一步完成后在任务的 `intent_json` 中持久化检查点，控制面中断后从最后一个检查点继续：
>
> 1. **预检**：校验快照 `product_version` 兼容性；Vault 快照按其 `seal_generation` 在 `vault_unseal_key_generations` 中定位对应代际的密钥，找不到时拒绝恢复；快照代际与当前生效代际不同时须使用 Vault `snapshot-force` 强制恢复，该操作独立授权。
> 2. **进入维护态**：持久化 `maintenance_mode=1`（`snapshot_restore`）并写入自动解封抑制，暂停该集群的变更操作、巡检与自动解封；本步落库完成前不执行任何恢复动作。
> 3. **执行恢复**：普通恢复使用 Nomad `PUT /v1/operator/snapshot` / Vault `POST /v1/sys/storage/raft/snapshot`（必要时为 `snapshot-force`）。
> 4. **确认集群恢复**：轮询等待 Leader 重选；Vault 各节点以快照对应代际的密钥逐台解封，直到全部节点解封且所有 Raft Peers 追平。
> 5. **更新密钥代际**：在单一事务内把 `seal_generation` 指针移到快照对应代际并将其置为 `active`，原生效代际改为 `retired`（全部代际编号与密钥均保留，此后 Rekey 生成的新代际仍取历史最大编号加 1）。
> 6. **凭据与联动核对**：
>    - Vault 的托管 Admin Token 在旧快照中可能尚未签发或已被吊销。由于系统常态下不保留 Root Token，恢复状态机检测到 Admin Token 无效时，自动使用快照对应代际的 Unseal Keys 执行 `generate-root` 生成临时 Root Token，重新签发 orphan Admin Token 并立即吊销临时 Root Token（该步骤属于本次已授权的恢复操作，全程写入审计）；
>    - Nomad 管理 Token 在旧快照中无效时，保持维护态并引导管理员补录或按 5.3 的受控重置流程恢复；
>    - 集群联动的 JWT Auth Mount、Role 与 Policy 若因回到旧快照而缺失或不一致，标记联动为 `drifted` 并引导重新 Apply。
> 7. **退出维护态**：以上全部通过后解除自动解封抑制并退出维护态；任一步失败则保持维护态并在任务中标明停留的步骤。

> **自定义定时任务**：同时支持管理员新增自定义定时任务（支持类型：指定集群 Raft 快照、指定节点/集群 Doctor 体检、指定 Nomad 集群 Job 全量导出备份、静态 Vault JWKS 公钥同步）。Nomad 业务层的 Periodic Job 归口在「Job 管理」页面展示与触发，与平台运维定时任务职责清晰分离。

### 5.9 审计日志与强制脱敏

- **全覆盖**：登录/登出/改密、账号新增/角色变更/停用/重置密码与会话注销、`viewer` 越权调用被拒绝、本机重置密码与主密钥轮换、SSH 密钥管理、节点增删与公钥推送、集群创建/部署/扩缩容/证书续期与 CA 轮换/Gossip 密钥轮换/凭据补录/配置修改/启停/升级/卸载/维护态切换/快照恢复、Nomad Namespace/Node Pool/ACL Policy/ACL Role/ACL Token 管理、Nomad 运行态操作（Deployment Promote/Fail/暂停、扩缩副本数、Periodic 立即触发、Parameterized 派发、Allocation 停止与 Task 重启及发送信号、Client 节点调度资格/Drain/Purge、CSI 卷注销、Variables 增删改与查看原文、Allocation 文件下载、交互式终端与 Job Action 的开始与结束）、Vault 初始化/Root Token 吊销/解封/手动封存/Rekey/应急签发运维 Token/策略与密钥操作、集群联动与 Role 下发、Job 提交/启停/重启/回滚/Purge、定时任务修改与触发、迁移导出/导入与控制面激活、控制面自更新/预约升级/版本回退、系统代理配置修改与连通性测试（记录代理地址，不含密码）、Docker 安装/升级/转为托管/守护进程配置变更与镜像拉取代理测试、系统设置修改全部强制写审计。
- **关联追溯**：涉及异步运维任务的操作，审计记录直接关联 `operation_task_id`，管理员可在审计详情页一键展开查看每台节点的脱敏命令输出与回滚轨迹。
- **强制脱敏**：请求体、命令参数与实时日志流在落盘和推送前统一经脱敏器过滤（匹配 `token`、`password`、`passphrase`、`secret`、`private_key`、`unseal_key`、`gossip_key`、`authorization`、PEM 私钥块及敏感 CLI 参数），全部替换为 `<redacted>`。

### 5.10 环境迁移与控制面灾备备份

采用**口令加密的可移植迁移包（`.ndbundle`）**，实现跨机器灾备重建与环境一键复制，消除直接拷贝 SQLite 与 `master.key` 的耦合风险（大体积 Raft 快照文件不打入迁移包，支持在快照管理页下载可移植口令加密快照归档并在目标环境上传登记恢复）：

1. **导出范围（Web 端可按需勾选，完整维护依赖清单）**：
   - **核心配置（必选）**：`system_settings`、`ssh_keys`、`nodes`、`clusters`、`cluster_nodes`、`vault_secrets_custody`、`vault_unseal_key_generations`、`cluster_integrations`、`integration_roles`、`job_templates`、`cron_jobs`。
   - **可选历史数据**：`admins`、`job_revisions`、`audit_logs`、`operation_tasks`（勾选时强制连带导出 `operation_task_steps` 及其引用的全部步骤日志文件，导入时日志文件写入目标数据目录并重写 `log_path`）、`cron_job_runs`。
   - **不导出**：`admin_sessions`（导入时整表清空）、`cluster_snapshots` 索引与快照文件（快照经快照管理页单独下载可移植归档）。
2. **跨实例重加密、维护屏障与双活防护协议**：
   - **导出二次验密**：导出包含全部生产级敏感凭据（SSH 私钥、集群 CA 与客户端私钥、Gossip 密钥、Nomad Management Token、Vault 各代际 Unseal Keys 与 Admin Token、代理凭据），**强制要求复核当前管理员登录密码**（授权仅绑定本次导出参数与范围），再使用管理员输入的临时迁移口令经 **Argon2id + AES-256-GCM** 整包加密输出 `.ndbundle`。
   - **导入预检绑定**：新环境上传 `.ndbundle` 并输入迁移口令 → 解密校验完整性 → 返回 **Dry-Run 预检报告**及一次性 `preview_token`（绑定包 SHA256、还原策略与当前数据库状态版本）；`import/apply` 强制校验 `preview_token` 防止包或目标库状态变化。
   - **全局维护屏障与还原策略**：执行 `import/apply` 前强制进入全局维护状态（拒绝新变更、暂停 Cron、断言无运行中 `operation_tasks`）：
     - `replace`（整库灾难恢复，推荐）：在单一 SQLite 事务内仅清空**迁移包中包含的表**并完整保留原 ULID 与外键关系还原，迁移包未包含的表保持目标库现状，同时清理本机不存在对应文件的过期 `cluster_snapshots` 索引。保留下来的表可能引用已被替换的记录，因此按以下规则处理并在 Dry-Run 报告中逐表列出影响行数：
       - 只做软引用的表（`audit_logs` 与 `operation_tasks` 中的资源 ID、操作人）原样保留，界面对指向已不存在资源的记录标注“资源已不存在”；
       - 存在外键引用的历史表（`cron_job_runs` 引用 `cron_jobs`、`job_revisions` 引用集群、`operation_task_steps` 引用 `operation_tasks`）：引用目标仍存在的记录保留，引用目标已不存在的记录删除；
       - 事务提交前执行 `PRAGMA foreign_key_check`，存在任何违反外键的记录即整体回滚并报告；
     - **登录账号提示**：由于导入后会话全部失效，Dry-Run 预检报告明确列出导入后可用于登录的账号——迁移包含 `admins` 时为包内账号（使用源环境的密码），否则为目标库现有账号；若导入后不存在任何启用状态的 `admin` 角色账号，预检直接拒绝该导入。
     - `merge`（增量合并）：按外键依赖顺序（`ssh_keys` → `nodes` → `clusters` → `cluster_nodes` / `vault_secrets_custody` / `vault_unseal_key_generations` → `cluster_integrations` → `integration_roles` → `job_templates` / `cron_jobs`）导入，维护完整的 `old_id -> target_id` 映射表，**不仅重写 SQL 外键，还按结构化规则重写 JSON 字段内嵌引用**（如 `cron_jobs.payload_json` 中的 `cluster_id`/`node_id`）；强绑定的 `vault_secrets_custody`、`vault_unseal_key_generations` 与 `cluster_nodes` 仅跟随所属集群整组一致处理，`integration_roles` 跟随所属联动整组处理。
   - **重加密、会话隔离与防双活安全接管**：所有敏感字段使用目标环境自身的主密钥重新加密写入；事务内**清空 `admin_sessions`，提交后立即断开所有已建立的 SSE 流**，导入前后的任何会话均不能继续使用；清空内存 SSH/API 客户端缓存后，**`replace` 与 `merge` 两种策略都将导入的集群及其关联定时任务、自动解封置为暂停待命态**（`merge` 只影响本次导入的集群，目标环境原有集群不受影响），避免源、目标两个控制面同时巡检与解封同一集群，待管理员下线旧控制面后手动点击「激活控制面」恢复自动调度，并全流程写入审计日志。
   - **实例本地设置不导入**：`control_plane.activated`、`self_update.*`、`server.public_url` 相关设置以及主密钥来源属于实例自身状态，两种策略均不从迁移包导入；`backup.*` 导入后保持禁用，由管理员确认后重新启用，防止两个实例写入同一备份目标造成轮转互删。
3. **控制面定时灾备备份**：
   - 控制面数据库保存着集群 CA 私钥、Nomad 管理 Token、全部代际 Unseal Keys 与 SSH 私钥，宿主机磁盘损坏将导致这些材料全部丢失（Vault 离线紧急备份只覆盖 Unseal Keys）。因此内置定时任务 `control_plane_backup` 按计划生成灾备包。
   - 灾备包采用与迁移包相同的 `.ndbundle` 格式，固定包含全部核心配置表与 `admins`（可选包含其余历史数据），以管理员设置的**备份口令**经 Argon2id + AES-256-GCM 加密。备份口令以 `is_secret=1` 存入系统设置供定时任务使用，同时必须由管理员另行保管——控制面宿主机损毁后，只能凭该口令解开灾备包。
   - 备份目标支持本机目录（默认 `data/backups/scheduled/`）、SFTP（复用 SSH 密钥库）与 S3 兼容对象存储，可同时配置多个；每个目标独立按份数轮转（默认保留 14 份），上传后回读校验 SHA256。生产环境要求至少配置一个异地目标，未配置时仪表盘持续告警。
   - 启用备份、修改备份口令或目标均需二次验密并写审计；每次备份的结果、大小、目标与校验值记录在定时任务执行历史中，连续失败时仪表盘告警。
   - 灾备恢复即在新宿主机上执行一次 `replace` 迁移导入（上传灾备包并输入备份口令），流程与防双活约束同本节第 2 项。
   - **Raft 快照异地保存**：Raft 快照不进入灾备包，而是由 `raft_snapshot_backup` 在每次生成后以备份口令封装为可移植归档，写入同一组备份目标（独立目录，按目标单独轮转，默认保留 7 份），上传后回读校验。每个灾备包记录生成时各集群最近一次异地快照的 ID 与时间，恢复向导据此提示“控制面材料”与“集群数据恢复点”的对应关系；新环境可直接从备份目标登记这些快照并按 5.8 的协议恢复。

### 5.11 Consul 可选扩展预留

为避免未来接入 Consul 时推倒重来，设计层面预留以下干净边界（`v1.0.0` 仅实现 Nomad 与 Vault）：

1. **驱动抽象**：定义统一的集群驱动接口，覆盖安装、节点加入、节点移除、升级、证书续期、卸载、服务启停、体检、日志读取、快照导出与快照恢复等能力，Nomad 与 Vault 各自注册实现，后续新增 Consul 驱动实现同一接口即可接入。
2. **数据模型通用化**：`clusters.type`、`cluster_nodes.role` 与 `cluster_integrations.integration_type` 均为开放文本枚举，无需改表结构即可承载 Consul 集群与 `nomad_consul` 联动。
3. **Nomad 配置预留**：Nomad 集群配置模型中保留可选 `consul` 配置节与 `65-consul.hcl` 槽位，当前默认关闭。

### 5.12 控制面部署、监听端口与自更新

1. **部署形态与目录**：
   - 推荐以 systemd 服务方式部署在独立 Linux 宿主机，基础目录为 `/opt/nomad-deck-control`（与被管节点的 `/opt/nomad-deck` 区分）：
     - 程序版本目录：`/opt/nomad-deck-control/bin/versions/nomad-deck-<ver>`，原子软链 `/opt/nomad-deck-control/bin/nomad-deck` 指向当前版本，`/opt/nomad-deck-control/bin/nomad-deck.prev` 指向上一版本（每次切换时同步更新，供回退单元以固定路径调用），默认保留当前版本与上一版本；`bin/` 与 `data/` 归属服务用户 `nomad-deck`；
     - 启动配置：`/opt/nomad-deck-control/etc/nomad-deck.toml`；
     - 数据目录：`/opt/nomad-deck-control/data/`（SQLite 数据库、步骤日志、加密快照、升级前数据库备份、`setup.token` 及未使用其他方式提供主密钥时生成的 `master.key`）。
   - systemd 单元以专用低权用户 `nomad-deck` 运行，`ExecStart` 指向软链路径；采用 `Type=notify`，进程完成 Schema 迁移且 `/readyz` 就绪后才向 systemd 发送就绪通知，并设置 `TimeoutStartSec=180`，启动后卡住、迟迟不就绪同样计为启动失败；配置 `Restart=on-failure`、`RestartSec=3` 与 `RestartForceExitStatus=75`（自更新完成后进程以退出码 `75` 退出，由 systemd 立即以新版本拉起）、`StartLimitBurst=3` 与 `StartLimitIntervalSec=900`、`OnFailure=nomad-deck-rollback.service`（见本节第 4 项）、`LoadCredential=master_key:<路径>`（主密钥轮换期间另加 `master_key_next`，见 5.1），并启用 `ProtectSystem=strict`、`ProtectHome=true`、`PrivateTmp=true`、`NoNewPrivileges=true`，仅放开 `ReadWritePaths=/opt/nomad-deck-control`。
   - 同时提供容器镜像部署方式。容器内程序文件随镜像固定，**自更新在容器部署与开发模式下禁用**，界面显示当前版本、最新版本与“请更新镜像”的提示；容器部署通过更换镜像版本升级。
2. **监听端口与 TLS**：
   - 默认监听 `0.0.0.0:8555`，单端口同时承载 Web 管理端、REST API、SSE 流与 `/healthz`、`/readyz` 探针。监听地址可通过启动配置 `listen`、环境变量 `NOMAD_DECK_LISTEN` 或命令行参数 `--listen` 修改（优先级依次升高）。8555 为非特权端口，服务无需 `CAP_NET_BIND_SERVICE`；部署文档提示在宿主机防火墙放行该端口。
   - TLS 模式由启动配置 `tls.mode` 指定：
     - `auto`（默认）：配置了 `tls.cert_file`/`tls.key_file` 时使用该证书；未配置时首次启动在数据目录生成自签证书（SAN 覆盖主机名与全部本机 IP），启动日志与 Setup 向导展示证书 SHA256 指纹供管理员核对；
     - `file`：强制使用指定证书文件，文件缺失时拒绝启动；
     - `proxy`：由前置反向代理终止 TLS，服务以 HTTP 监听；仅当监听地址为回环地址或配置了 `tls.trusted_proxies` 时允许启用，且仅信任来自这些地址的 `X-Forwarded-Proto` 与 `X-Forwarded-For`，用于判定 HTTPS 与客户端 IP；该模式下必须配置 `server.public_url`，否则拒绝启动。
   - `server.public_url` 是管理端的外部访问地址，用于 CSRF 与 WebSocket 的同源校验、自签证书 SAN 补充以及告警与审计中的跳转链接。
3. **版本来源与可信校验**：
   - 新版本来自构建时固化的 NomadDeck GitHub 仓库的 Release，默认只考虑正式版（排除 Draft 与 Pre-release）；系统设置 `self_update.channel` 可切换为 `prerelease` 以包含预发布版本。
   - **代理选择**：立即升级与预约升级的发起表单提供「使用系统代理」勾选项（默认值取自 `proxy.use_for_self_update`，机制见 5.2），版本查询、签名摘要与程序包下载均按所选方式访问 GitHub；预约升级保存该选择并在每次检查与最终下载时沿用。内置定时任务 `self_update_check` 按 `proxy.use_for_self_update` 的默认设置决定是否经系统代理检查。勾选代理后代理不可用即判定本次检查或升级失败，不回退为直连。
   - 每个 Release 附带各平台程序压缩包、`SHA256SUMS` 及其 Ed25519 签名文件 `SHA256SUMS.sig`。签名私钥仅存在于发布流水线，公钥内置于程序中。自更新依次校验：签名有效 → 目标压缩包的 SHA256 与 `SHA256SUMS` 一致 → 压缩包内程序可执行。任一环节失败即中止，不改动现有安装。仅校验 SHA256 无法防止 Release 被篡改后同时替换程序与摘要，因此签名校验为强制步骤。
   - 自更新只允许升级到比当前更高的版本；回到旧版本只能走本节第 5 项的版本回退流程。
4. **升级流程**（作为 `system.self_update` 异步任务执行，全程写入任务日志与审计）：
   1. **进入升级屏障**：拒绝新的变更类任务并暂停 Cron 派发，等待正在运行的运维任务结束（默认最长 10 分钟，超时则中止升级并解除屏障）。屏障状态持久化在 `self_update.last_result` 中，进程重启后继续生效，直到新版本确认就绪。
   2. **查找与下载**：解析目标版本（`latest` 或指定版本号），确认存在当前平台的程序包与签名摘要文件后下载，界面按阶段展示进度。
   3. **校验与试运行**：完成第 3 项的签名与摘要校验，解压到 `bin/versions/nomad-deck-<ver>`，执行新程序的 `--version` 并确认输出与目标版本一致。
   4. **升级前数据库备份**：以 SQLite 在线备份生成 `data/backups/pre-upgrade-<from>-<to>.db`（权限 `0600`，与数据库同等敏感），并记录当前 Schema 版本；升级前备份默认保留最近 3 份（系统设置 `self_update.backup_retention`），超出部分在新版本确认就绪后清理。
   5. **先落库、再切换**：先在 `self_update.last_result` 中持久化 `prepared` 状态（含原版本、目标版本、备份文件、原 Schema 版本与本次 `system.self_update` 任务 ID），再将 `bin/nomad-deck.prev` 指向当前版本、`bin/nomad-deck` 原子切换到新版本，随后把状态更新为 `pending`，写审计后进程以退出码 `75` 退出，由 systemd 拉起新版本。此时该任务在库中仍为 `running`，启动扫描不会把它标记为 `needs_reconcile`。
   6. **新版本确认**：新进程启动后先检查 `self_update.last_result`：
      - 状态为 `prepared` 或 `pending` 且当前运行版本等于目标版本：执行 Schema 迁移，`/readyz` 就绪并向 systemd 发出就绪通知后，把状态置为 `succeeded`、将对应任务置为 `success`、解除升级屏障并恢复 Cron；
      - 状态为 `prepared` 而当前运行版本仍是原版本（切换前断电）：说明软链尚未切换，把任务置为 `failed`（原因“切换前中断”）、清理已解压的新版本目录、解除升级屏障，服务继续以原版本运行；
      - 其余组合视为异常，保持升级屏障并在界面提示管理员处理。前端在重启期间把连接失败视为正常等待，轮询版本接口直至实际运行版本等于目标版本后自动刷新页面；5 分钟内未确认时停止等待并提示查看任务日志。
   - **启动失败自动回退**：新版本若反复崩溃或在 `TimeoutStartSec` 内始终未就绪，触发 systemd 启动次数上限后主单元进入失败状态，由 `OnFailure` 拉起 `nomad-deck-rollback.service`。该 oneshot 单元的权限划分如下，确保 root 权限从不执行服务用户可改写的程序：
     - **回退条件判定**：`ExecCondition` 以服务用户身份执行 `/opt/nomad-deck-control/bin/nomad-deck.prev rollback --check`，仅当 `self_update.last_result` 处于 `prepared` 或 `pending` 且本次升级尚未回退过时以退出码 `0` 结束；否则以退出码 `1` 结束，systemd 据此跳过整个单元（`ExecStart` 与 `ExecStartPost` 均不执行），普通的持续故障因此不会被反复清除启动计数和重启；
     - **执行回退**：`ExecStart` 以服务用户 `nomad-deck` 身份（`User=nomad-deck`，与主服务相同的沙箱设置）执行 `/opt/nomad-deck-control/bin/nomad-deck.prev rollback --auto`：确认主进程已完全退出，将 `bin/nomad-deck` 切回原版本、用升级前备份恢复数据库、把对应任务置为 `rolled_back` 并记录失败原因、解除升级屏障，全部成功才以退出码 `0` 结束；状态在判定后发生变化或任一步失败均以非零退出码结束。每次升级最多自动回退一次（回退后状态变为 `rolled_back`，不再满足判定条件）。由于该程序与主服务同为服务用户权限，即使服务用户已被攻破也无法借此获得更高权限；
     - **重新拉起**：仅有的两条特权命令以 `ExecStartPost=+/usr/bin/systemctl reset-failed nomad-deck.service` 与 `ExecStartPost=+/usr/bin/systemctl start nomad-deck.service` 执行（`+` 前缀表示以完整权限运行，且只在 `ExecStart` 成功后执行），它们只调用系统自带的 `systemctl`，用于清除启动次数计数并重新拉起主服务，否则 `StartLimitIntervalSec` 窗口内的再次启动会被 systemd 拒绝；
     - `ExecStart` 失败时不执行后续命令，主服务保持失败状态，需管理员依据 systemd 日志人工处理；
     - 普通的运行期崩溃（`self_update.last_result` 不处于 `prepared`/`pending`）不会触发回退。新版本未就绪即回退，备份之后不存在需要保留的新数据。控制面宿主机的 systemd 版本须不低于 243（`ExecCondition` 自该版本提供），安装前检查对此校验。
5. **版本回退（手动）**：
   - 已确认成功的升级，在「版本与升级」页可回退到上一版本：两版本 Schema 版本相同时直接切换软链并重启，数据保持不变；Schema 版本不同时界面拒绝回退，并说明只能在本机执行 `nomad-deck rollback --to-backup <文件>`，该命令会用升级前备份覆盖数据库、丢失升级后的全部数据变更，执行前须交互确认。
6. **预约升级**：
   - 适用于新版本即将发布、希望发布后自动升级的场景。管理员设置目标版本（`latest` 或指定版本号）、等待时长（30 秒至 24 小时，默认 5 分钟）、检查间隔（5 秒至 1 小时，默认 20 秒）以及是否使用系统代理。预约状态持久化在 `self_update.schedule`，后台按间隔检查，服务重启后继续等待。
   - 目标为 `latest` 时，等待期内一旦出现比当前更高且附带完整签名摘要的正式版即开始升级；目标为指定版本时，该版本发布且资产完整后开始升级，当前已不低于目标版本则直接结束。到达截止时间仍未满足条件时记录超时。
   - 等待中可随时取消；已开始升级后不可取消，状态跟随对应的升级任务。预约进行中禁止发起立即升级，反之亦然。
   - 内置定时任务 `self_update_check` 仅检查并提示新版本，不自动安装；无人值守安装只能通过管理员显式创建的预约升级发生。

---

## 6. HTTP API 与实时流规范设计

服务默认监听 `0.0.0.0:8555`。所有管理接口统一前缀 `/api/v1`（除登录与初始化接口外均需校验登录态；变更类接口与敏感读取接口还要求 `admin` 角色，见 5.1），运维探针暴露 `/healthz` 与 `/readyz`。

**Nomad Job 的定位规则**：Nomad Job ID 只在 Namespace 内唯一，且 Periodic 与 Parameterized 生成的子 Job ID 含有 `/`（如 `backup/periodic-1700000000`、`render/dispatch-1700000000-ab12cd34`）。因此单个 Job 的接口统一以 `/api/v1/nomad/{cluster_id}/namespaces/{namespace}/jobs/{job_id}` 定位，`job_id` 必须整体做 URL 编码（`/` 编码为 `%2F`），服务端按原始编码路径匹配路由后再解码；不针对单个 Job 的集合操作（渲染、反解、转换、校验、Plan、Apply、导出）统一放在 `/api/v1/nomad/{cluster_id}/job-ops/` 下，与任意 Job ID 都不会冲突。Allocation、Deployment、Evaluation 使用全局唯一 UUID，不需要 Namespace。

| 模块 | 核心接口 | 说明 |
| :--- | :--- | :--- |
| **认证与初始化** | `GET /api/v1/auth/status`<br>`POST /api/v1/auth/setup`<br>`POST /api/v1/auth/login`<br>`POST /api/v1/auth/logout`<br>`PUT /api/v1/auth/password`<br>`GET /api/v1/auth/sessions`<br>`DELETE /api/v1/auth/sessions/{session_id}` | 检查是否需初始化、凭一次性 Setup Token 原子创建首个管理员、登录/登出（删除当前会话并断开其 SSE）、修改密码（注销其他会话）、查看与注销会话 |
| **账号管理**（`admin`） | `GET/POST /api/v1/admins`<br>`PUT /api/v1/admins/{id}`<br>`PUT /api/v1/admins/{id}/role`<br>`POST /api/v1/admins/{id}/reset-password`<br>`POST /api/v1/admins/{id}/{disable\|enable}` | 账号列表、新增（指定 `admin`/`viewer` 角色）、编辑、修改角色、重置他人密码、停用/启用（均需二次验密，禁止停用或降级最后一个启用的 `admin`） |
| **总览仪表盘** | `GET /api/v1/dashboard/summary` | 集群数量、节点在线率、Nomad Job 统计、Vault 密封状态、证书临期预警、待核对任务与审计动态 |
| **SSH 密钥管理** | `GET/POST /api/v1/ssh-keys`<br>`POST /api/v1/ssh-keys/generate`<br>`PUT /api/v1/ssh-keys/{id}/default`<br>`DELETE /api/v1/ssh-keys/{id}` | 列表、导入、生成 Ed25519 密钥对、设为默认、删除（被主机引用时禁止删除） |
| **主机节点管理** | `GET/POST /api/v1/nodes`<br>`GET/PUT/DELETE /api/v1/nodes/{id}`<br>`POST /api/v1/nodes/{id}/push-key`<br>`POST /api/v1/nodes/{id}/test`<br>`POST /api/v1/nodes/{id}/reset-fingerprint` | 主机增删改查、一次性密码幂等推公钥、SSH 连通与环境探测（架构/sudo/SELinux/Swap/Docker/时间同步/`machine_id`）、重置主机指纹 |
| **集群与成员编排** | `GET/POST /api/v1/clusters`<br>`GET/PUT/DELETE /api/v1/clusters/{id}`<br>`POST /api/v1/clusters/{id}/nodes`<br>`POST /api/v1/clusters/{id}/nodes/{node_id}/join`<br>`POST /api/v1/clusters/{id}/nodes/{node_id}/remove`<br>`POST /api/v1/clusters/{id}/deploy`<br>`POST /api/v1/clusters/{id}/upgrade/plan`<br>`POST /api/v1/clusters/{id}/upgrade`<br>`POST /api/v1/clusters/{id}/certs/renew`<br>`POST /api/v1/clusters/{id}/ca/rotate`<br>`POST /api/v1/clusters/{id}/gossip/rotate`<br>`PUT /api/v1/clusters/{id}/credentials`<br>`POST /api/v1/clusters/{id}/reconcile`<br>`PUT /api/v1/clusters/{id}/maintenance`<br>`POST /api/v1/clusters/{id}/uninstall/plan`<br>`POST /api/v1/clusters/{id}/uninstall`<br>`POST /api/v1/clusters/{id}/doctor`<br>`POST /api/v1/clusters/{id}/preflight`<br>`GET /api/v1/clusters/{id}/status`<br>`GET /api/v1/clusters/{id}/gate?node_id=...` | 集群创建与纳管节点、单节点扩容 Join 与安全缩容 Remove、一键部署、滚动升级、节点/客户端证书续期、CA 重叠轮换、Nomad Gossip 密钥轮换、管理凭据补录/恢复、崩溃后状态核对与解锁、维护模式开关、卸载、健康体检、部署前检查报告、逐节点实时状态、指定节点的仲裁门禁预览 |
| **集群 Raft 快照** | `GET /api/v1/clusters/{id}/snapshots`<br>`POST /api/v1/clusters/{id}/snapshots`<br>`POST /api/v1/clusters/{id}/snapshots/upload`<br>`POST /api/v1/clusters/{id}/snapshots/{snapshot_id}/download`<br>`POST /api/v1/clusters/{id}/snapshots/{snapshot_id}/restore`<br>`DELETE /api/v1/clusters/{id}/snapshots/{snapshot_id}` | 快照列表查询、手动创建加密快照、上传登记可移植快照归档、下载归档（请求体携带二次验密的当前密码与归档口令，口令不出现在 URL 中）、状态机驱动的安全快照恢复（区分标准与 force 模式）、删除过期快照 |
| **单节点服务与日志** | `POST /api/v1/clusters/{id}/nodes/{node_id}/service/{start\|stop\|restart}`<br>`PUT /api/v1/clusters/{id}/nodes/{node_id}/config`<br>`GET /api/v1/clusters/{id}/nodes/{node_id}/logs/stream` (SSE) | 经仲裁门禁的单节点服务启停重启、托管配置更新（代际目录校验+原子软链+回滚）、实时 `journalctl` 日志流 |
| **Vault 专有能力** | `POST /api/v1/vault/{cluster_id}/init`<br>`POST /api/v1/vault/{cluster_id}/unseal`<br>`POST /api/v1/vault/{cluster_id}/seal`<br>`PUT /api/v1/vault/{cluster_id}/custody`<br>`POST /api/v1/vault/{cluster_id}/custody/backup`<br>`POST /api/v1/vault/{cluster_id}/custody/recover-token`<br>`POST /api/v1/vault/{cluster_id}/rekey`<br>`GET /api/v1/vault/{cluster_id}/key-generations`<br>`GET/POST/DELETE /api/v1/vault/{cluster_id}/auth`<br>`GET/PUT/DELETE /api/v1/vault/{cluster_id}/policies/{name}`<br>`GET /api/v1/vault/{cluster_id}/kv/mounts`<br>`GET /api/v1/vault/{cluster_id}/kv/list?mount=...&path=...`<br>`GET /api/v1/vault/{cluster_id}/kv/metadata?mount=...&path=...`<br>`GET/PUT/DELETE /api/v1/vault/{cluster_id}/kv/item?mount=...&path=...` | 集群初始化并加密托管（初始化后吊销 Root Token）、单节点/全集群一键解封、手动安全封存（写入自动解封抑制）、自动解封开关、二次验密离线备份、经 `generate-root` 应急重签运维 Token、带验证的 Unseal Key 轮换与代际查看（不返回密钥原文）、Auth/Policy 管理、支持嵌套 Mount 路径与 CAS/区分删除语义的 KV 管理（键列表与 KV v2 元数据对 `viewer` 可见，读取密钥内容仅限 `admin` 并写审计） |
| **Nomad 治理** | `GET/POST/PUT/DELETE /api/v1/nomad/{cluster_id}/namespaces`<br>`GET/POST/PUT/DELETE /api/v1/nomad/{cluster_id}/node-pools`<br>`GET/PUT/DELETE /api/v1/nomad/{cluster_id}/acl/policies/{name}`<br>`GET/POST/PUT/DELETE /api/v1/nomad/{cluster_id}/acl/roles`<br>`GET/POST /api/v1/nomad/{cluster_id}/acl/tokens`<br>`DELETE /api/v1/nomad/{cluster_id}/acl/tokens/{accessor_id}` | Namespace 与 Node Pool 管理、ACL Policy 与 Role 编辑、Client Token 签发（Secret 仅返回一次）与吊销 |
| **Nomad 运行态：订阅与搜索** | `GET /api/v1/nomad/{cluster_id}/watch?topics=...` (SSE)<br>`GET /api/v1/nomad/{cluster_id}/search?q=...` | 单连接复用的运行态变化订阅（基于共享阻塞查询）、全局模糊搜索 |
| **Nomad 运行态：Job 视图** | `GET /api/v1/nomad/{cluster_id}/namespaces/{namespace}/jobs/{job_id}/{summary\|versions\|submission\|deployments\|allocations\|evaluations\|services\|children\|scale}`<br>`POST /api/v1/nomad/{cluster_id}/namespaces/{namespace}/jobs/{job_id}/scale`<br>`POST /api/v1/nomad/{cluster_id}/namespaces/{namespace}/jobs/{job_id}/periodic/force`<br>`POST /api/v1/nomad/{cluster_id}/namespaces/{namespace}/jobs/{job_id}/dispatch`<br>`POST /api/v1/nomad/{cluster_id}/deployments/{deployment_id}/{promote\|fail\|pause\|resume}` | Job 概览、版本 Diff、原始提交源码、Deployment、Allocation、Evaluation、服务、子 Job 与扩缩状态；扩缩副本数、Periodic 立即触发、Parameterized 派发、金丝雀 Promote 与部署 Fail/暂停/恢复 |
| **Nomad 运行态：Allocation** | `GET /api/v1/nomad/{cluster_id}/allocs/{alloc_id}`<br>`GET /api/v1/nomad/{cluster_id}/allocs/{alloc_id}/stats`<br>`GET /api/v1/nomad/{cluster_id}/allocs/{alloc_id}/checks`<br>`GET /api/v1/nomad/{cluster_id}/allocs/{alloc_id}/fs/{ls\|stat\|readat\|download}?path=...`<br>`POST /api/v1/nomad/{cluster_id}/allocs/{alloc_id}/{restart\|stop\|signal}`<br>`POST /api/v1/nomad/{cluster_id}/allocs/{alloc_id}/exec-ticket`<br>`GET /api/v1/nomad/{cluster_id}/allocs/{alloc_id}/exec?ticket=...` (WebSocket) | Allocation 详情（含运行端口、Task 事件与重调度链）、实时资源用量、健康检查、文件浏览预览与下载、重启/停止/发送信号、申请一次性终端票据、交互式终端与 Job Action 双向转发 |
| **Nomad 运行态：节点与集群** | `GET /api/v1/nomad/{cluster_id}/clients`<br>`GET /api/v1/nomad/{cluster_id}/clients/{node_id}`<br>`GET /api/v1/nomad/{cluster_id}/clients/{node_id}/stats`<br>`POST /api/v1/nomad/{cluster_id}/clients/{node_id}/{eligibility\|drain\|purge}`<br>`GET /api/v1/nomad/{cluster_id}/servers`<br>`GET /api/v1/nomad/{cluster_id}/topology`<br>`GET /api/v1/nomad/{cluster_id}/evaluations` | Client 节点列表与详情、宿主机实时资源用量、调度资格/Drain/Purge、Server 成员、拓扑容量视图、全局 Evaluation 列表 |
| **Nomad 运行态：存储与 Variables** | `GET /api/v1/nomad/{cluster_id}/volumes`<br>`GET/DELETE /api/v1/nomad/{cluster_id}/volumes/{volume_id}`<br>`GET /api/v1/nomad/{cluster_id}/plugins`<br>`GET /api/v1/nomad/{cluster_id}/variables?prefix=...`<br>`GET/PUT/DELETE /api/v1/nomad/{cluster_id}/variables/item?path=...&namespace=...`<br>`POST /api/v1/nomad/{cluster_id}/variables/item/reveal?path=...&namespace=...` | CSI 卷与插件、动态 Host Volume、注销 CSI 卷；Variables 路径树浏览、带 `cas` 的增删改、默认遮蔽与审计的原文查看 |
| **Nomad-Vault 联动** | `GET/POST/PUT/DELETE /api/v1/integrations`<br>`GET/POST/PUT/DELETE /api/v1/integrations/{id}/roles`<br>`POST /api/v1/integrations/{id}/plan`<br>`POST /api/v1/integrations/{id}/apply`<br>`POST /api/v1/integrations/{id}/doctor`<br>`POST /api/v1/integrations/{id}/job-example` | 联动配置与工作负载 Role 管理、变更预览（含作用范围、mTLS 冲突、资源归属与入口高可用检测）、双锁一键下发（仅 Nomad 侧配置变化时滚动重启）、四段式体检与真实 JWT Login 验证、按 Role 生成测试 Job |
| **Nomad Job 管理** | `GET /api/v1/nomad/{cluster_id}/jobs?namespace=...`<br>`GET /api/v1/nomad/{cluster_id}/namespaces/{namespace}/jobs/{job_id}`<br>`GET/POST/PUT/DELETE /api/v1/job-templates`<br>`POST /api/v1/nomad/{cluster_id}/job-ops/{render\|parse-to-visual\|compose-convert\|validate\|plan\|apply}`<br>`POST /api/v1/nomad/{cluster_id}/job-ops/export`<br>`POST /api/v1/nomad/{cluster_id}/namespaces/{namespace}/jobs/{job_id}/{start\|stop\|restart\|purge\|revert}`<br>`GET /api/v1/nomad/{cluster_id}/namespaces/{namespace}/jobs/{job_id}/revisions`<br>`GET /api/v1/nomad/{cluster_id}/allocs/{alloc_id}/logs/stream` (SSE) | Job 查询与详情、Job 模板管理、可视化 Spec 经 `hclwrite` 渲染 HCL、HCL 本地 AST 预检+受控反解、Compose 转换、HCL/JSON 两种输入的 Plan 与凭一次性 `plan_id` 的 Apply（服务端绑定 `JobModifyIndex`）、启动/停止/重启/Purge、现网漂移检测与版本回滚、Allocation 实时日志流、批量导出 HCL（仅 `admin`） |
| **运维任务追踪** | `GET /api/v1/operations`<br>`GET /api/v1/operations/{task_id}`<br>`GET /api/v1/operations/{task_id}/stream` (SSE) | 查看历史运维任务、逐节点步骤状态与实时脱敏终端输出流 |
| **定时任务** | `GET/POST/PUT/DELETE /api/v1/cron-jobs`<br>`POST /api/v1/cron-jobs/{id}/run`<br>`GET /api/v1/cron-jobs/{id}/runs` | 定时任务管理、启停与 Cron/防重入/漏执行策略修改、手动触发、关联 `operation_task_id` 的执行历史查看 |
| **审计日志** | `GET /api/v1/audit-logs`<br>`GET /api/v1/audit-logs/{id}` | 多条件分页检索（时间、动作、资源、结果、关键字）与脱敏详情查看 |
| **环境迁移** | `POST /api/v1/migration/export`<br>`POST /api/v1/migration/import/preview`<br>`POST /api/v1/migration/import/apply`<br>`POST /api/v1/migration/activate` | 二次验密加密导出 `.ndbundle`、上传口令预检（签发绑定 `preview_token`）、全局维护屏障下事务导入还原、迁移后显式激活控制面自动调度 |
| **控制面灾备备份**（`admin`） | `GET/PUT /api/v1/backup/config`<br>`POST /api/v1/backup/targets/test`<br>`POST /api/v1/backup/run`<br>`GET /api/v1/backup/history` | 备份开关、备份口令、目标（本机目录/SFTP/S3 兼容存储）与保留份数配置（二次验密）、目标连通性测试、立即备份、备份历史与校验结果 |
| **系统设置** | `GET/PUT /api/v1/settings`<br>`GET /api/v1/releases/{nomad\|vault\|cni\|docker}?use_proxy=...` | 全局系统参数管理（含 PGP 公钥、CNI 摘要登记、版本跨度、代理默认勾选与时区）、拉取官方/镜像源可用版本列表（可指定是否经代理及所用代理配置；Docker 版本列表须以 `node_id` 指定主机，或以 `distro`、`release`、`arch` 指定仓库） |
| **Docker 管理** | `GET /api/v1/nodes/{id}/docker`<br>`POST /api/v1/nodes/{id}/docker/{install\|upgrade\|adopt}`<br>`PUT /api/v1/nodes/{id}/docker/config`<br>`POST /api/v1/nodes/{id}/docker/proxy-test`<br>`POST /api/v1/clusters/{id}/docker/upgrade/plan`<br>`POST /api/v1/clusters/{id}/docker/upgrade`<br>`PUT /api/v1/clusters/{id}/docker/defaults` | 主机 Docker 模式、版本、运行状态与生效配置；单主机安装、升级与“转为托管”；守护进程配置（镜像拉取代理、镜像加速、日志轮转）变更；从节点测试镜像拉取代理；集群级滚动升级计划与执行；集群默认 Docker 配置 |
| **主密钥轮换**（`admin`） | `GET /api/v1/settings/master-key`<br>`POST /api/v1/settings/master-key/rotate`<br>`GET /api/v1/settings/master-key/rotation` | 当前已加载的主密钥 Key ID（不含密钥本身）与是否存在待轮换新密钥；发起轮换（二次验密）；轮换进度、核验结果与下一步提示 |
| **系统代理**（`admin`） | `GET/PUT /api/v1/settings/proxy`<br>`POST /api/v1/settings/proxy/test` | 读取与保存唯一的系统代理（密码只返回是否已设置，留空保持原值）；连通性测试（可传表单当前值，逐项返回 HashiCorp、Docker 仓库、GitHub 的成功与否、状态码、耗时、失败原因与出口 IP） |
| **任务的代理参数** | Nomad/Vault/CNI/Docker 的部署、扩容、安装、升级与自更新（立即/预约）接口的请求体统一包含 `use_proxy`（布尔值，仅决定控制面下载时是否经系统代理，与 Docker 镜像拉取代理无关） | 未传时按系统设置的默认勾选状态处理；`use_proxy=true` 而未配置系统代理时返回 400 |
| **控制面版本与自更新** | `GET /api/v1/system/version`<br>`POST /api/v1/system/self-update`<br>`GET/POST/DELETE /api/v1/system/self-update/schedule`<br>`GET /api/v1/system/self-update/result`<br>`POST /api/v1/system/self-update/rollback` | 当前版本、最新版本、更新说明与自更新可用性（容器/开发模式返回不可用原因）；立即升级到最新版或指定版本（返回运维任务 ID）；预约升级的查询、创建与取消；最近一次升级结果；同 Schema 版本下回退到上一版本 |

---

## 7. Web 管理端 UI 规划

管理端采用简洁的深/浅色自适应控制台风格，所有操作闭环在浏览器内完成，无需人工 SSH 登录目标节点：

1. **首次初始化向导 / 登录页**：检测未初始化时要求输入本机生成的一次性 Setup Token 引导创建 Admin 账号并生成默认 SSH 密钥；后续进入标准登录页。
2. **总览仪表盘（Dashboard）**：Nomad/Vault 集群健康卡、主机在线概览、Vault 密封/抑制告警、Vault 运维 Token 续租异常告警、Vault 审计设备与审计日志分区告警、节点时钟偏差告警、控制面灾备备份失败或缺少异地目标告警、CA/节点/客户端证书到期告警、待核对异常任务提示、Nomad 运行中 Job/Alloc 计数、NomadDeck 新版本提示、最近运维任务与审计动态。
3. **基础设施（Infrastructure）**：
   - **SSH 密钥库**：生成/导入/复制公钥、一键生成目标机配置命令、查看引用主机；
   - **主机节点**：主机列表、一键密码推公钥、Docker 面板（模式、版本、运行状态、安装/升级/转为托管、守护进程配置与镜像拉取代理及「从节点测试」按钮）、SSH 探测（系统架构、免密 `sudo`、SELinux、Swap、Docker、时间同步与 `machine_id` 状态展示及配置指引）、主机指纹管理。
4. **Nomad 集群**：
   - 集群向导（单机/多节点 Server+Client 拓扑、统一业务入口、显式 TLS/Gossip/ACL 一键配置、目标版本与「使用系统代理」勾选；扩容与升级向导提供同样的代理勾选）；
   - 节点管理（安装、单节点扩容 Join 与安全缩容 Remove、经仲裁门禁的启停重启、托管配置表单：Docker 驱动/CNI/Host Volume/Meta/TLS/Telemetry/UI、集群默认 Docker 配置与 Docker 滚动升级向导、版本升级与滚动升级向导、节点/客户端证书续期与 CA 轮换、维护态与崩溃核对解锁、凭据应急恢复、Dry-Run 卸载、Doctor 体检）；
   - 快照管理子页（Raft 快照列表、手动创建、上传登记、下载与安全恢复向导）；
   - 治理子页（Namespace 与 Node Pool 管理、ACL Policy 编辑器与模板、ACL Role、Client Token 签发与吊销）；
   - **运行态工作台**（与 Nomad 原生 UI 常用页面对应，顶部提供 Region/Namespace 切换与全局搜索，数据实时刷新）：
     - Jobs：列表与状态分布条、Job 详情（概览、版本 Diff、定义与原始提交源码、Deployments 与金丝雀 Promote、Allocations、system Job 的节点矩阵、Evaluations 调度失败详情、Services、子 Job、扩缩副本数、Periodic 立即触发、Parameterized 派发表单）；
     - Task Group 与 Allocation 详情：运行端口与访问地址、Task 实时 CPU/内存折线、Task 事件时间线、健康检查、日志终端、文件浏览器、交互式终端与 Job Action 按钮、重启/停止/发送信号；
     - Clients：节点列表、节点详情（宿主机实时资源折线、已分配与容量对比、驱动健康、Host Volume、事件）、调度资格切换与 Drain；
     - Servers、Topology 拓扑容量视图、Storage（CSI 卷与插件、动态 Host Volume）、Variables（路径树、遮蔽显示、CAS 编辑）、全局 Evaluations；
   - 内嵌实时终端抽屉（经 SSE 查看 `journalctl -u nomad` 实时日志与部署/升级实时输出）。
5. **Vault 集群**：
   - Raft 集群部署向导（自动 CA/TLS 证书签发、Swap 预检与统一业务入口配置、目标版本与「使用系统代理」勾选；扩容与升级向导提供同样的代理勾选）；
   - 集群状态详情页（进入页面及手动刷新时逐台直连节点实时探测，页面停留期间每 30 秒自动刷新一次）：
     - 集群概要：整体健康状态（`healthy` / `degraded` / `sealed` / `uninitialized` / `unreachable`）、初始化状态、维护态及其原因、当前 Active 节点、运行版本、TLS 状态与 CA 到期时间、统一业务入口；
     - Raft 仲裁概览：投票成员总数、其中健康的数量、Autopilot 给出的当前可容忍故障数，可容忍故障数为 0 时醒目提示“再有一台节点下线将失去多数派”；
     - 节点列表：每台节点的 API 地址、可达性、是否已初始化、密封状态、Raft 角色（Active / Standby）、是否投票成员、Autopilot 健康状态、最后联系时间与日志索引（用于判断是否追平）、运行版本与登记版本是否一致、生效的配置代际、证书到期时间、服务状态与最近一次状态同步时间；不可达或密封的节点标红并给出对应操作入口（解封、查看日志、Doctor 体检）；
     - 版本一致性：各节点运行版本不一致时提示（常见于滚动升级中断），并链接到对应的运维任务；
     - 托管状态摘要：当前生效的密钥代际、是否存在未完成的 Rekey 代际、运维 Token 剩余有效期、自动解封开关与抑制原因、最近一次解封时间；
     - 最近运维任务：该集群最近的部署、升级、解封、Rekey、快照与恢复任务及其状态，待核对的任务置顶显示；
     - 每台节点提供仲裁门禁预览，在执行停服、重启、缩容等操作前展示该操作是否会被门禁拦截及原因；
   - 初始化与密钥托管面板（一键初始化与 `init_in_doubt` 异常处置、Root Token 吊销状态、逐节点密封状态展示、一键单节点/全集群解封与手动安全封存、自动解封开关与抑制解除、运维 Token 有效期与 `generate-root` 应急重签、Unseal Key 轮换与代际列表、二次验密导出离线备份、凭据应急补录）；
   - 节点运维（单节点扩容 Join 与安全缩容 Remove、经仲裁门禁启停重启、滚动升级、节点证书续期与 CA 轮换、实时 `journalctl -u vault` 日志、Doctor 体检、Raft 快照列表/上传/下载/标准及 force 恢复）；
   - Vault 管理子页（Auth 方法、Policy HCL 编辑器、支持嵌套挂载路径与 CAS 并发保护的多引擎 KV 浏览与 Secret 编辑）。
6. **集群联动（Integrations）**：Nomad ↔ Vault JWT Workload Identity 配置列表、联动下的工作负载 Role 列表（每个 Role 配置 `bound_claims` 权限边界与 `explicit`/`templated` Policy 模式）、标明作用范围（仅 Vault 侧或需重启 Nomad）的 Plan 预览、一键 Apply、可视化四段式链路体检图（含端到端 JWT Login 验证）、一键生成示例 Job。
7. **Nomad Job 中心**：
   - Job 列表与详情（与「运行态工作台」中的 Jobs 视图为同一组页面，详情页可直接进入编辑）；
   - 双模式 Job 创建/编辑工作台：可视化动态编排器（覆盖顶层 `variable`、Job/Group 级 `constraint`/`update`、Group 级 `network`/`port`/`volume`/`service`/`check`/`restart`/`reschedule`/`ephemeral_disk`、Task 级 `lifecycle`（Sidecar）、Docker `config`（含 `mount`/`bind_options`/`logging`/`force_pull`/`network_mode`/`volumes`）、`env`/`volume_mount`/`resources`（含 `memory_max`）/`logs`/`service`/`check`/`vault`/`identity`/`template` 动态增删 + 跨字段联动下拉 + AST 校验的附加原生 HCL 片段 + 右侧实时 HCL 预览）与原生 HCL CodeMirror 编辑器，支持模板保存、现网漂移检测、Compose 导入（含阻断级校验）、本地 HCL2 AST 预检+受控反解、Validate → 绑定 `JobModifyIndex` 的 Plan Diff 预览 → Apply；
   - 启动/停止/重启/Purge、历史版本 Diff 与一键回滚、导出 HCL。
8. **运维任务中心（Operations）**：所有长耗时任务的时间线、逐节点步骤状态、崩溃后待核对任务操作与可回放的脱敏终端日志。
9. **定时任务（Schedules）**：内置与自定义定时任务列表、Cron 表达式与防重入/漏执行策略编辑、启停开关、立即执行与关联 `operation_task_id` 的历史记录。
10. **审计日志（Audit Logs）**：按动作/资源/结果/时间筛选、查看脱敏操作摘要与关联的运维任务日志。
11. **环境迁移与灾备（Migration & Backup）**：向导式导出（二次验密 + 勾选范围 + 设置迁移口令下载 `.ndbundle`）与导入（上传 + 口令解密 → Dry-Run 绑定预检，列出导入后可登录的账号 → 全局维护屏障下选择 `replace`/`merge` 一键还原 → 确认旧实例下线后一键「激活控制面」）；灾备备份配置（备份口令、本机/SFTP/S3 目标与连通性测试、保留份数）、立即备份与备份历史，未配置异地目标时持续提示。
12. **系统设置（Settings）**：镜像源、HashiCorp 与 Docker 验签公钥、分发传输限速、Docker 默认版本、CNI 版本摘要登记、升级版本跨度上限、资源统计采样间隔、交互式终端空闲与最长时长、Grafana 跳转链接模板、系统代理（类型 HTTP/HTTPS/SOCKS5、地址、认证、`no_proxy` 列表、「测试」按钮与逐项测试结果；Nomad/Vault/CNI/Docker 任务与自更新是否默认勾选系统代理的两个开关）、时区、默认版本号、SSH 超时与并发度、会话有效期、日志与快照保留天数。
13. **账号与会话（Accounts）**：当前账号改密、本人活跃会话列表与注销；（`admin`）账号列表、新增并指定角色、修改角色、停用/启用与重置密码。`viewer` 登录后所有变更按钮、终端入口与敏感操作入口均隐藏，顶部显示“只读”标识。
14. **版本与升级（Version）**：并排显示当前版本与最新版本及更新说明（检查新版本时可勾选是否经代理），提供立即升级（发起前可勾选「使用系统代理」；分阶段展示下载、校验、备份、重启、确认，完成后自动刷新页面）、预约升级（目标版本、等待时长、检查间隔、是否使用系统代理、剩余时间与下次检查倒计时）、最近一次升级结果与回退到上一版本；容器部署或开发模式下禁用升级操作并说明原因。

---

## 8. 一次性交付（`v1.0.0`）实施顺序与验收清单

本项目按单次完整发布（`v1.0.0`）推进，研发与联调按以下依赖顺序落地：

1. **底座层**：Go 工程骨架、TOML 配置与默认 `0.0.0.0:8555` 监听（`auto`/`file`/`proxy` 三种 TLS 模式）、主密钥多来源加载（systemd 凭据/环境变量/文件）与 Key ID 信封加密、加密字段清单与启动自检、双密钥过渡的可续做主密钥轮换、Argon2id/TLS/SSH 密钥库、SQLite WAL 读写分离连接池与 Schema 迁移、一次性 Setup Token + Admin 认证（`Secure` Cookie 服务端会话、以 `server.public_url` 为准的 CSRF/Origin 校验、SSE 会话绑定）、`admin`/`viewer` 角色与服务端权限校验、账号管理与本机重置密码、流式审计脱敏中间件。
2. **远端执行与任务引擎**：纯 Go SSH/SFTP 连接池、TOFU 指纹校验、基于 `machine_id` 的主机规范身份与地址别名、远端步骤包装脚本与 `.op-results` 结果持久化、有超时的共享任务与不占锁的长连接、固定命令模板与参数白名单/受保护 staging 原子落位、幂等一键推公钥、SELinux/免密 `sudo`/Swap/Docker/时间同步/`machine_id` 探测与产品版本下限校验、PGP 签名+SHA256 双校验与 CNI 固定摘要校验、单一系统代理（HTTP/HTTPS/SOCKS5、连通性测试、按任务勾选）、全部安装包经控制面中转并以 gzip 压缩分发、节点侧 SHA256 复核与并发限速、Docker 仓库 GPG 签名元数据校验、异步长任务队列（共享/独占两种模式的集群锁与主机产品锁、远端步骤以临时 systemd 单元执行、按产品分离的 `.op.lock` 崩溃核对与 SSE 实时日志推流）。
3. **Vault 驱动与托管解封**：Vault 集群部署（TLS + Raft + `disable_mlock` + `LimitCORE=0` + Swap 预检 + 文件审计设备与日志轮转 + 含证书的配置代际）、`init_in_doubt` 治理与 Shamir 两阶段 Raft 加入、密钥代际托管（生效指针与独立递增编号）、`verification_in_doubt` 核对流程、不使用 `step-down` 的滚动升级、离线备份格式与离线解密子命令、orphan 周期性 Admin Token 与 Root Token 吊销、`generate-root` 应急重签、保存验证 nonce 的带验证 Rekey、快照恢复后自动重签 Admin Token、手动安全封存抑制与节点级解封、离线紧急备份、基于 Autopilot 的统一 Raft 仲裁门禁、单节点扩缩容与证书/CA 轮换、版本跨度校验与升级前快照/熔断、按密钥代际的 Raft 快照安全恢复状态机、Auth/Policy/支持嵌套路径与 CAS 的 KV v2 管理、Doctor 体检。
4. **Nomad 驱动与集群联动**：Nomad 单机/集群部署（按角色区分 `nomad`/`root` 运行用户、显式 TLS 配置且 `verify_https_client` 默认关闭、专属 SAN 证书、Gossip 与预生成 Secret 的 ACL Bootstrap）、版本代际目录原子软链配置管理、基于 Autopilot 的统一 Raft 仲裁门禁、单节点扩缩容（含 `server_client` 双角色与 Drain 等待）、证书/CA/Gossip 密钥轮换、版本跨度校验升级与熔断、Namespace/Node Pool/ACL Policy/ACL Role/ACL Token 治理、Docker Engine 中转安装与滚动升级（`managed`/`external` 模式、依赖预检、版本锁定、`live-restore`、托管 `daemon.json` 与镜像拉取代理及节点侧测试）、Nomad-Vault 双向 TLS 信任联动（多 Role 模型、`explicit`/`templated` Policy、`role_type="jwt"`、`user_claim_json_pointer`、`bound_claims`、资源归属隔离、仅 Nomad 侧配置变化时滚动重启）及端到端 JWT Login 体检、Consul 扩展接口预留。
5. **Nomad Job 中心**：按 Namespace 与 URL 编码 Job ID 定位的接口路由（兼容含 `/` 的子 Job）、`viewer` 白名单结构化摘要与加密保存的 Job JSON、HCL/JSON 两种输入的 Plan 与一次性 `plan_id`、Job 列表/详情、基于 `hcl/v2` 的可视化动态编排与受限 AST 附加片段、本地 AST 预检+受控反解、原生 HCL 编辑、纯 Go Compose 转换（含阻断校验）、模板管理、现网漂移检测、按 `plan_hash` 提交审阅时 Job JSON 并绑定 `JobModifyIndex` 的 Validate/Plan/Apply、启停重启与 Purge、基于 Nomad 原生 Revert 的版本回滚、Allocation SSE 实时日志流、HCL 导出；Nomad 运行态工作台（共享阻塞查询的 SSE 订阅、全局搜索、Job 各视图与 Deployment/扩缩（同步编排内容中的 `count`、操作 ID 写入扩缩事件的对账协议）/Periodic/Dispatch 操作、运行端口、Task 与节点实时资源统计、Allocation 文件浏览、基于一次性票据的 Exec/Action WebSocket 终端、Client 节点调度资格与 Drain、Server/拓扑/存储/Variables/Evaluation 视图）。
6. **平台运营闭环**：定时任务（含防重入/漏执行/关联 `operation_task_id`、节点级健康巡检、CA/客户端/节点证书告警、Vault Token 续租、自动解封巡检、共享锁模式的 Raft 快照登记与互斥轮转、自更新版本检查、日志清理）、二次验密加密迁移包（`.ndbundle`，含步骤日志文件）导出/绑定预检（含导入后登录账号检查）/全局维护屏障下外键与 JSON 内引用一致还原（未包含的表保持现状）/防双活激活、控制面定时灾备备份（本机/SFTP/S3 目标、轮转与回读校验）、系统设置。
7. **控制面自更新**：可勾选代理的 GitHub Release 版本查询、以 `ExecCondition` 判定的单次自动回退、Ed25519 签名与 SHA256 校验、升级屏障、升级前数据库备份与保留上限、软链与 `.prev` 软链原子切换、退出码 `75` 重启、`Type=notify` 就绪确认与启动超时、启动失败自动回退、手动回退、预约升级；发布流水线产出各平台程序包、`SHA256SUMS` 与 `SHA256SUMS.sig`。
8. **Web 管理端与单二进制打包**：React + Tailwind 全套管理端页面、`go:embed` 静态资源嵌入、Makefile 与 systemd（主服务与回退单元）/Docker 部署产物。

### 端到端核心验收场景

- [ ] **零配置启动、Setup 防抢注与会话撤销**：全新空目录启动 `nomad-deck`，验证默认在 `8555` 端口以自签证书提供 HTTPS，并自动生成 `master.key`、`setup.token` 与 SQLite；验证以 systemd 凭据提供主密钥时不生成 `master.key`；验证无 Setup Token 拒绝 `/auth/setup`，凭 Token 原子创建首个管理员并生成默认 SSH 密钥；验证登出只使当前设备会话失效、改密注销其他设备会话，被注销会话已建立的 SSE 日志流立即断开；验证变更请求缺少 CSRF/Origin 时被拒绝。
- [ ] **账号角色与本机救援**：新增一个 `admin` 与一个 `viewer` 账号；验证 `viewer` 能查看全部运行态视图与日志，但调用任意变更接口、打开交互式终端、读取 Allocation 文件内容（预览、分段读取与下载）、查看 Variables 或 Vault KV 原文、导出备份均返回 403；把一个已打开交互式终端的 `admin` 降为 `viewer`，验证其会话、终端与未使用的票据立即失效；停用账号后其会话立即失效，禁止停用或降级最后一个启用的 `admin`；本机执行重置密码子命令后可登录；按双密钥过渡流程执行主密钥轮换，在轮换中途杀死控制面进程后能从进度记录续做，完成后全部凭据、JSON 内加密字段、快照与升级前备份均可解密，过早移除旧密钥时服务拒绝启动并给出提示。 另外验证：主密钥轮换后 `cluster_snapshots.sha256` 无需更新即可校验通过，轮换进行中的快照下载与恢复被拒绝。
- [ ] **节点纳管与隔离约束**：添加 3 台 Linux 主机（验证手动粘贴公钥与临时密码幂等推公钥），完成 SSH 连通性、架构、免密 `sudo`、SELinux、Swap、Docker、时间同步与 `machine_id` 探测，验证时钟偏差超过 30 秒的节点在部署前被拦截；验证同一主机无法同时加入两个同类集群（`UNIQUE(node_id, cluster_type)` 生效）、同一主机以另一个 IP 或域名重复登记时按 `machine_id` 被拒绝，控制面宿主机自身无法被纳管。
- [ ] **系统代理与中转分发**：配置一个带认证的系统代理（分别以 HTTP 与 SOCKS5 类型各验证一次），保存前用表单值测试，验证逐项结果与出口 IP 正确，故意填错密码与端口时分别返回认证失败与连接失败 → 在控制面只能经代理出网、被管节点完全不能访问外网的环境中，勾选系统代理部署 Vault 与 Nomad 集群（含 CNI 与 Docker），全部成功，且节点侧无任何外网请求 → 验证分发采用 gzip 压缩、节点侧 SHA256 复核生效（人为篡改 staging 文件时安装中止）、并发与限速设置生效 → 取消勾选代理时下载失败且不会回退为直连 → 勾选代理完成 Nomad 滚动升级与 NomadDeck 立即自更新，创建勾选代理的预约升级并验证检查与下载均经代理 → 审计中可见代理选择与测试记录且无密码。
- [ ] **Vault 集群全流程**：在 UI 部署 3 节点 TLS + Raft Vault 集群（验证 Swap 预检与 `LimitCORE=0`）→ 初始化并验证 Shamir 两阶段 Raft 加入成功、Unseal Keys 与 orphan Admin Token 加密托管、Root Token 已吊销且库内不存在 → 手动安全封存节点验证自动解封抑制持续生效、解除抑制后自动解封恢复 → 快照备份进行期间封存一个节点，验证自动解封不被阻塞 → 使 Admin Token 失效后经 `generate-root` 应急重签成功且临时 Root Token 已吊销 → 验证文件审计设备已启用且审计日志按轮转配置切分 → 执行 Rekey 并验证新旧代际状态，在验证阶段前中断控制面后能凭已保存的 nonce 继续完成 Rekey → 恢复 Rekey 之前的快照时使用旧代际密钥成功解封，且快照中不存在的 Admin Token 被自动重签 → 验证单节点扩容 Join、证书续期、安全缩容 Remove（含仲裁门禁拦截）、升级前快照与版本跨度校验 → 验证支持嵌套路径与 CAS 冲突保护的 KV v2 编辑。 另外验证：滚动升级时旧 Active 以正常停止交出领导权、全程未使用 `step-down`；在提交最后一份验证密钥后人为丢弃响应，核对流程经受控封存与解封正确判定 Rekey 结局；先 Rekey 两次再恢复第 1 代快照，随后再次 Rekey，新代际编号为 4 且第 1～3 代密钥均完整保留；将证书续期后切回上一配置代际，验证证书同时回到旧版本；不依赖 NomadDeck 服务，仅用 `nomad-deck offline-backup decrypt` 与备份口令解出密钥并手工解封。 另外验证：单节点 Vault 集群的 Rekey 核对需管理员授权维护窗口后才封存唯一节点；核对期间模拟网络中断，代际状态保持不变且集群停留在维护态；快照恢复在第 3 步后中断控制面，重启后从检查点继续并完成代际更新与凭据核对；纳管或部署 Vault Enterprise 版本时被拒绝。
- [ ] **Nomad 集群全流程**：在 UI 部署 3 节点 Nomad 集群（验证纯 Server 跑 `nomad` 用户、Client 跑 `root` 用户、专属 SAN 与 `public_api_url` 证书、版本代际原子软链配置、`verify_https_client` 默认关闭且浏览器可直接打开 Nomad 原生 UI）→ 验证 ACL Bootstrap 前 Secret 已落库，模拟 Bootstrap 响应丢失后经 `/v1/acl/token/self` 确认进入 `initialized`，并模拟集群已被其他 Token 抢先 Bootstrap 时经二次 Bootstrap 判定转入受控恢复 → 验证单节点扩容 Join、证书续期、Gossip 密钥轮换、`server_client` 双角色缩容（等待 Drain 完成 + Raft `remove-peer`）、仲裁门禁拦截多数派停服、升级前快照与熔断策略 → 验证共享/独占锁互斥规则，并在远端步骤执行中杀死控制面进程，验证远端临时单元继续运行、重启后进入 `needs_reconcile` 并按单元状态完成核对恢复 → 验证 Namespace、ACL Policy 与 Client Token 管理 → 验证 Nomad `GET /v1/operator/snapshot` 备份与恢复。 另外验证：远端步骤执行中重启目标主机，控制面重连后依据 `.op-results` 结果文件判定该步骤被中断；持续打开节点日志页面期间仍可发起并完成配置变更；全部 Server 磁盘清空后由 Raft 快照重建集群，Variables 可读且原有 Workload Identity 仍能通过 Vault 校验；渲染的 `60-vault.hcl` 两侧均含 `enabled = true`。 另外验证：配置代际中的 HCL 以绝对路径引用本代际 TLS 文件，候选代际在切换前通过 SHA256 复核与 `nomad config validate`。
- [ ] **Docker 管理**：在一台 Ubuntu 与一台 Rocky Linux 主机上（节点均不能访问外网）由 NomadDeck 中转安装指定版本 Docker，验证安装包签名与 SHA256 校验、依赖预检、版本锁定与托管 `daemon.json` 生效 → 为一台预装发行版 `docker.io` 的主机验证识别为 `external`，并在无运行中容器时完成“转为托管” → 配置镜像拉取代理（分别验证沿用系统代理与单独填写），用「从节点测试」验证连通，之后 Nomad 部署的 Docker Job 能经该代理拉取镜像 → 对 Nomad 集群执行 Docker 滚动升级：升级到下一个补丁版本时验证原地升级下运行中容器按 ID 全部保留、Nomad 任务不中断；跨小版本升级时验证被强制 Drain，升级后测试容器可正常启动、被疏散的 Allocation 恢复健康；人为让某节点原地升级后验活失败，验证熔断并可回退到上一补丁版本，跨小版本升级失败时验证节点保持不可调度且不提供自动回退。 另外验证：跳过补丁版本或同时修改 `daemon.json` 的升级不允许原地执行。
- [ ] **Nomad + Vault 联动**：在 Nomad 与 Vault 均启用自签 TLS 的前提下创建联动配置，并添加两个分别限制不同 Namespace 的 Role（其中一个使用 `templated` Policy）→ Plan 预览（验证作用范围标识、Auth Mount 归属隔离与单点入口告警；临时开启 `verify_https_client` 时验证 mTLS 冲突检测）→ 首次 Apply 双向打通（Nomad CA 写入 Vault `jwks_ca_pem`、完整 JWT Role 参数、滚动重启 Nomad）→ 再新增一个 Role 并 Apply，验证 Nomad 节点未重启 → Doctor 四段式体检并验证真实 JWT Login 成功，且越权 Namespace Job 被 Vault 拒绝。
- [ ] **Job 全生命周期**：分别通过可视化动态编排器（覆盖顶层 `variable`、`constraint`、`reschedule`、`update`、`lifecycle` Sidecar、Docker `mount`/`bind_options`/`logging`、`resources.memory_max`、Group/Task 级 `service`/`check`、`volume`/`volume_mount`、`env`/`template`/`vault`/`identity` 块与 AST 校验附加片段，验证现网漂移检测与回填）、纯 Go Compose 导入（含阻断项校验）与原生 HCL 编辑器（含本地 HCL2 AST 差异警告）提交 Job → 验证 Apply 提交的 Job JSON 与 Plan 审阅内容一致、绑定 `JobModifyIndex` 的并发冲突保护与 Plan Diff 后下发 → 经 SSE 实时查看 Allocation 日志 → 停止/重新启动/修改版本并经 Nomad 原生 Revert 回滚（回滚后可视化结构同步恢复）/Purge 删除。 另外验证：带变量覆盖值提交后，`job_revisions` 保存了加密的变量输入与最终 Job JSON，Nomad 可按版本返回原始源码；外部以纯 JSON 注册的版本在定义页提示原始 HCL 不可用；Plan 之后由他人修改 Job，再调用 Apply 时即使客户端伪造新的 `JobModifyIndex` 也被拒绝；停止 Job 并等其被 Nomad 垃圾回收后，仍可由本地归档重新 Plan 并启动。 另外验证：`viewer` 在 Job 详情、版本对比与导出接口只能拿到白名单结构化摘要，使用 `var.password` 注入 `env` 的 Job 不会向 `viewer` 泄露明文，`job_revisions` 中的 Job JSON 为密文；同一内容在两个标签页分别 Plan，外部修改后用第一个 `plan_id` Apply 被拒绝，且同一 `plan_id` 不能重复使用；历史版本被 Nomad 回收后以归档 JSON 走 `input_type=json` 回滚成功；外部以纯 JSON 注册的 Job 可在 JSON 编辑模式下修改并提交。 等 Nomad 回收某个由 NomadDeck 提交版本的源码后，定义页从本地归档展示该版本 HCL 并标明来源，且可据此编辑（变量值自动带入）；人为篡改本地归档使其与 Nomad 中该版本定义不一致时，定义页显示警告且不提供编辑入口。
- [ ] **Nomad 运行态工作台**：在不登录 Nomad 原生 UI 的前提下完成以下验证 → 两个浏览器同时打开同一 Job，验证状态变化实时刷新且控制面对 Nomad 只发起一路阻塞查询 → 验证 Allocation 详情展示的宿主机地址与端口可直接访问服务，Task 实时 CPU/内存折线与 `nomad alloc status -stats` 一致 → 发起带金丝雀的更新并在 Deployments 中 Promote，再对另一次部署执行 Fail → 经 Task Group 卡片扩缩副本数，验证生成 `source=scale` 的版本记录且不被判定为漂移，可视化模式与字面量 `count` 的 HCL 模式均已同步、再次 Apply 不会撤销扩缩，`count` 为变量的 HCL 模式在编辑时出现恢复提示 → 立即触发 Periodic Job 并派发一个 Parameterized Job，验证 ID 含 `/` 的子 Job 详情、版本与操作接口均可正常访问，不同 Namespace 下的同名 Job 互不混淆 → 用文件浏览器预览日志文件并下载，验证 `secrets/` 目录只列出文件名且不可读取内容 → 打开交互式终端执行命令、运行一个 Job Action，验证票据重放与跨站 `Origin` 被拒绝、注销会话后终端立即断开，审计中有开始与结束记录且无输入输出内容 → 对 Client 节点切换调度资格并 Drain，在拓扑视图中观察 Allocation 迁移 → 在 Evaluations 中查看一次资源不足导致的调度失败详情 → 创建、带 `cas` 修改并删除 Variable，验证原文查看写审计 → 查看 CSI 卷/插件与 Server 列表。 另外验证：扩缩副本数时他人并发修改该 Job，扩缩以冲突失败而非覆盖；扩缩响应丢失后对账流程正确认领结果且不重复扩缩；`viewer` 预览或分段读取 Allocation 文件内容返回 403。 另外验证：扩缩请求携带的操作 ID 出现在 Nomad 扩缩事件中；人为制造“Job 已变更但扩缩事件缺失”的情形时，记录被置为 `needs_review` 而非自动认领。
- [ ] **定时任务与审计**：验证防重入、手动触发与关联 `operation_task_id` 的健康巡检、CA/客户端/节点证书检查、Vault Token 续租、Raft 快照与自更新版本检查任务均成功；验证审计日志完整且步骤日志、SSE 流与审计均无明文私钥/Token/Unseal Key 泄露。
- [ ] **环境迁移还原**：二次验密导出加密 `.ndbundle`（含 `operation_task_steps` 与步骤日志文件）→ 在全新空实例启动 `nomad-deck`（不同主密钥）→ 上传迁移包完成绑定 `preview_token` 的预检并在维护屏障下执行 `replace` 还原 → 验证会话表已清空、历史会话全部失效、导入的运维任务日志可正常查看，且自动任务默认暂停防双活 → 点击「激活控制面」后正常连接全部主机、集群、触发解封与管理 Job；验证 `merge` 模式同步重写 SQL 外键与 `cron_jobs.payload_json` 内嵌引用；验证不含 `admins` 的迁移包导入后目标库原有账号保留，且预检正确列出可登录账号。 另外验证：目标库保留的 `cron_job_runs` 中引用已被替换定时任务的记录在预检中列出并被清理，提交前外键检查通过；以 `merge` 导入的集群同样处于暂停待命态，目标环境原有集群的自动任务不受影响；`control_plane.activated`、`self_update.*` 等实例本地设置未被导入，`backup.*` 导入后处于禁用状态。
- [ ] **控制面灾备备份**：配置备份口令与本机、SFTP 两个目标，立即备份并验证两处均生成灾备包且回读校验通过、超出保留份数后轮转清理；断开 SFTP 目标验证仪表盘告警；在全新宿主机上用灾备包与备份口令执行 `replace` 恢复，验证集群凭据、Unseal Keys 与账号完整可用。 另外验证：每日快照任务把可移植快照归档写入备份目标并回读校验；在全新宿主机上仅凭灾备包、异地快照归档与备份口令，同时恢复控制面与集群数据。
- [ ] **控制面自更新**：发布一个更高版本的 Release，在「版本与升级」页立即升级，验证签名或摘要被篡改时中止且现有安装不变；正常情况下验证升级屏障、升级前数据库备份、软链切换、以退出码 `75` 重启、新版本确认后页面自动刷新；分别发布一个启动即崩溃的版本与一个启动后始终不就绪的版本并升级，验证两种情况都由 systemd 触发自动回退、恢复原版本与升级前数据库，对应任务记为 `rolled_back` 而非 `needs_reconcile`；验证升级前备份只保留最近 3 份；验证同 Schema 版本下的手动回退；验证预约升级在等待期内发布新版本后自动完成、超时与取消；验证容器部署下自更新入口禁用。 另外验证：在写入 `prepared` 之后、切换软链之前断电，重启后服务以原版本运行且任务记为 `failed`；回退单元的 `ExecStart` 以 `nomad-deck` 用户运行，root 权限只执行 `systemctl reset-failed` 与 `systemctl start`，回退后主服务在启动次数限制窗口内仍能被重新拉起。 另外验证：在非升级状态下让主服务反复崩溃，回退单元因 `ExecCondition` 被跳过，不会执行 `reset-failed` 与重启；同一次升级最多自动回退一次。
