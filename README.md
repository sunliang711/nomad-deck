# NomadDeck

NomadDeck 是一个独立部署的 HashiCorp 基础设施管理平台，采用 Go 单二进制架构并内嵌 React Web 管理台，覆盖宿主机纳管、Vault PKI / Secrets 运维、Nomad 集群与工作台管控，以及控制面高可用备份、迁移与自更新。

## 核心能力

- **基础设施纳管（Hosts / SSH Keys）**：通过系统原生 Ed25519 SSH 密钥接入 Linux 宿主机，支持节点巡检、系统服务状态检查与容器运行时（Docker / Containerd / CNI）安装管理。
- **Vault 集群管理**：支持在线下载、SHA256 校验与初始化 Vault 集群，提供自动解封（Auto-Unseal）与受控 Seal/Unseal/Step-Down、Raft 快照管理、PKI 引擎向导，以及 AppRole / KV v2 / Token 运维。
- **Nomad 集群与工作台**：支持 Server/Client 全生命周期部署与动态扩缩容、Gossip 加密、mTLS 自动续期与 Vault Workload Identity 集成，并内置 Job 中心、Allocation 日志流、WebSocket 交互式终端、Volume 与 ACL 治理。
- **安全与高可用治理**：支持控制面出口代理配置（含脱敏与连通性测试）、Cron 定时巡检与证书/备份调度、全量加密导出与迁移导入、Local / SFTP / S3 自动灾备快照、审计日志，以及基于 GitHub Release + Ed25519 签名的控制面自更新与双保险回滚。
- **单二进制部署**：前端 React 18 + Vite 构建产物通过 `go:embed` 直接打包进单个静态 Go 可执行文件，零外部运行时依赖。

## 快速构建

环境要求：Go 1.26+、Node.js 22+。

```bash
# 构建前端与 Go 单二进制（产物位于 bin/nomad-deck）
make build

# 分别构建
make web
make build-go
```

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
