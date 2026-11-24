# NomadDeck

NomadDeck 是一个使用 Go 开发的 Nomad 与 Vault 集群可视化运维控制面，内置 Web 管理端（`go:embed` 单二进制交付）。系统通过原生 SSH/SFTP 管理集群主机生命周期，通过 Nomad / Vault HTTP API 管理集群运行态与 Job 生命周期，并支持加密托管 Vault Unseal Keys、Nomad-Vault JWT Workload Identity 联动、定时任务、全量审计日志与口令加密的一键环境迁移。

服务默认监听 `0.0.0.0:8555`（HTTPS），单端口承载 Web 管理端、REST API 与 SSE。控制面支持从 GitHub Release 拉取新版本完成自更新（签名与 SHA256 校验、升级前数据库备份、原子切换、启动失败自动回退），也支持预约在新版本发布后自动升级。

## 设计方案

完整的架构设计、数据库表结构、核心机制、API 规范、Web 页面规划与交付验收清单见：[docs/DESIGN.md](./docs/DESIGN.md)。

## 参考脚本目录

本项目的运维流程与配置规范参考自以下本地目录中的原型脚本（仅用于研发阶段本地对照，正式对外发布前清理路径引用；本项目全新设计集群布局，不兼容既有单机脚本安装的旧节点）：

- Nomad 参考脚本：`/Users/eagle/.local/apps/init/tools/nomad`
- Vault 参考脚本：`/Users/eagle/.local/apps/init/tools/vault`
