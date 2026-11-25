# NomadDeck

NomadDeck 是一个独立部署的 HashiCorp 基础设施管理平台，采用 Go 单二进制架构并内嵌 React Web 管理台，覆盖宿主机纳管、Vault PKI / Secrets 运维、Nomad 集群与工作台管控，以及控制面高可用备份、迁移与自更新。

## 核心能力

- **基础设施纳管（Hosts / SSH Keys）**：通过系统原生 Ed25519 SSH 密钥接入 Linux 宿主机，支持节点巡检、系统服务状态检查与容器运行时（Docker / Containerd / CNI）安装管理。
- **Vault 集群管理**：支持在线下载、SHA256 校验与初始化 Vault 集群，提供自动解封（Auto-Unseal）与受控 Seal/Unseal/Step-Down、Raft 快照管理、PKI 引擎向导，以及 AppRole / KV v2 / Token 运维。
- **Nomad 集群与工作台**：支持 Server/Client 全生命周期部署与动态扩缩容、Gossip 加密、mTLS 自动续期与 Vault Workload Identity 集成，并内置 Job 中心、Allocation 日志流、WebSocket 交互式终端、Volume 与 ACL 治理。
- **安全与高可用治理**：支持控制面出口代理配置（含脱敏与连通性测试）、Cron 定时巡检与证书/备份调度、全量加密导出与迁移导入、Local / SFTP / S3 自动灾备快照、审计日志，以及基于 GitHub Release + Ed25519 签名的控制面自更新与双保险回滚。
- **单二进制部署**：前端 React 18 + Vite 构建产物通过 `go:embed` 直接打包进单个静态 Go 可执行文件，零外部运行时依赖。

## 快速安装（Linux systemd，推荐）

控制面以低权限系统用户 `nomad-deck` 运行在 `/opt/nomad-deck-control`，从 GitHub Release 下载对应架构二进制并自动校验 SHA-256、安装配置 `nomad-deck.service` 与自动回滚服务 `nomad-deck-rollback.service`：

```bash
# 安装最新版本
curl -fsSL https://raw.githubusercontent.com/sunliang711/nomad-deck/main/scripts/install.sh | sudo bash

# 安装指定版本
curl -fsSL https://raw.githubusercontent.com/sunliang711/nomad-deck/main/scripts/install.sh | sudo bash -s -- --version v0.1.0

# 卸载服务（保留 /opt/nomad-deck-control/etc 与 data 数据目录）
curl -fsSL https://raw.githubusercontent.com/sunliang711/nomad-deck/main/scripts/install.sh | sudo bash -s -- --uninstall
```

安装完成后常用管理命令：

```bash
# 查看首次启动生成的管理员初始化 setup_token
sudo journalctl -u nomad-deck -n 50 --no-pager

# 查看服务状态与重启
sudo systemctl status nomad-deck
sudo systemctl restart nomad-deck
```

旧安装若因连续正常重启出现 `start-limit-hit`，可使用更新后的项目脚本修复标准 systemd 单元并重启，保留现有程序、配置与数据：

```bash
sudo bash scripts/install.sh --repair-service
```

服务就绪后会清除启动限流计数；退出码 `75` 作为正常版本交接重启，不触发失败回退。真正就绪前失败仍保留限流与自动回退保护。

默认目录结构：
- 二进制与版本软链：`/opt/nomad-deck-control/bin/nomad-deck`（指向 `bin/versions/nomad-deck-<version>`）
- 配置文件：`/opt/nomad-deck-control/etc/nomad-deck.toml`（覆盖升级时自动保留）
- 数据目录：`/opt/nomad-deck-control/data`

## 快速构建

环境要求：Go 1.26+、Node.js 22+。

```bash
# 构建前端与 Go 单二进制（产物位于 bin/nomad-deck）
make build

# 分别构建
make web
make build-go
```

## GitHub Release 发布签名配置

[`.github/workflows/release.yml`](.github/workflows/release.yml) 在推送 `v*` 标签构建 Release 时会使用 Ed25519 对 `SHA256SUMS` 签名，并将公钥内嵌进二进制用于控制面在线自更新验签。

首次发布前需在本地生成密钥对并配置到 GitHub 仓库的 **Settings → Secrets and variables → Actions**：

```bash
go run ./scripts/sign-release -keygen
```

- 在 **Variables** 添加 `RELEASE_PUBLIC_KEY`
- 在 **Secrets** 添加 `RELEASE_SIGNING_PRIVATE_KEY`

## 运行与配置

```bash
# 启动控制面（默认监听 0.0.0.0:8555，首次启动自动生成自签名 TLS 证书）
./bin/nomad-deck serve

# 指定配置文件或覆盖参数
./bin/nomad-deck serve --config /opt/nomad-deck-control/etc/nomad-deck.toml
```

常用运维子命令：

```bash
./bin/nomad-deck version
./bin/nomad-deck admin reset-password --username <name>
./bin/nomad-deck offline-backup decrypt <backup-file>
./bin/nomad-deck rollback --check
./bin/nomad-deck rollback --auto
```

配置文件示例见 [deploy/nomad-deck.toml.example](deploy/nomad-deck.toml.example)，systemd 服务单元见 [deploy/nomad-deck.service](deploy/nomad-deck.service) 与 [deploy/nomad-deck-rollback.service](deploy/nomad-deck-rollback.service)。

## Docker 部署

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

容器模式会自动将 `NOMAD_DECK_CONTAINER=1` 注入环境变量，数据默认持久化在 `/data`。

## 开发与测试

```bash
# 前端开发服务器（代理 API 与 WebSocket 至 https://127.0.0.1:8555）
cd web && npm run dev

# 后端单元测试与静态检查
make vet
make test
```
