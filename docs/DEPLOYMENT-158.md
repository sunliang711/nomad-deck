# 10.2.156.158 部署与验收记录

验收日期：2026-11-28。控制面版本：v0.9.0。

## 环境与访问

| 项目 | 当前配置 |
| --- | --- |
| 主机 | Debian 13 amd64，2 CPU、1973 MiB 内存 |
| 控制面 | `https://10.2.156.158:8555`，systemd 原生部署，服务名 `nomad-deck` |
| 控制面目录 | `/opt/nomad-deck-control`；配置在 `etc/nomad-deck.toml`，数据库与主密钥在 `data` |
| Nomad | `nomad-single`，2.1.1，单节点 Server + Client，dc1 / global，启用 CNI、raw_exec 与 Docker 宿主机卷 |
| Vault | `vault-single`，2.2.2，单节点 Raft，已初始化、托管密钥并启用自动解封 |
| Docker | 29.10.1，控制面托管 |
| 集群数据 | `/opt/nomad-deck/nomad/data`、`/opt/nomad-deck/vault/data` |
| 集群联动 | `nomad-vault`，JWT 挂载 `jwt-nomad`，KV v2 挂载 `secret` |
| 出站代理 | `10.2.1.115:9605`，已在系统设置配置认证与全部下载范围；内网直连 |

控制面管理员为 `admin`，交付凭据保存在操作端本地权限为 0600 的临时文件 `/tmp/nomad-deck-158-access.json`。文档不保存密码、代理口令、Vault Token 或解封密钥。Vault 初始化 Root Token 已吊销。

Nomad、Vault 的节点页面提供免密进入各自 UI 的入口。控制面的二进制按版本保存在 `bin/versions`，`bin/nomad-deck` 指向当前版本。本轮通过 SSH 更新控制面，未执行产品内的实际自更新。

## 内置模板验收

所有 Job 均从控制面真实 Web UI 载入模板，经 Plan 后提交。内存较大的服务以及占用 80/443 的网关逐个验收，避免单机资源与端口冲突。停止的示例仍保留 Job 定义和运行记录，方便从 Job 中心再次启动。

| 模板 | 验收结果与证据 |
| --- | --- |
| Nginx | 实例运行，显示动态映射端口 `23885 → 80` |
| Caddy | Deployment 成功，浏览器显示 `NomadDeck Caddy ready` |
| Traefik | Deployment 成功，80/443/8080 分配完成，访问 Dashboard |
| PostgreSQL + Vault | Vault 注入成功，日志显示数据库已可接受连接 |
| MySQL + Vault | 建库、用户初始化成功，日志显示 `ready for connections` |
| Redis + Vault | 日志显示 `Ready to accept connections tcp` |
| RabbitMQ + Vault | Deployment 成功，浏览器显示 Management 登录页 |
| Shell 守护脚本 | raw_exec 实例持续运行 |
| 批处理 | 1 个实例正常完成、0 个失败；Job 为预期的 dead 状态 |
| Nginx 网关 | Deployment 成功；浏览器就绪页及 `/healthz` 显示纯文本 |
| OpenResty 网关 + Lua WAF | Deployment 成功；就绪页、健康页正常；敏感路径断开连接，重复探测触发临时封禁 |
| Docker Registry | Deployment 成功，浏览器访问 `/v2/` 返回 `{}` |
| Prometheus | 前置权限任务正常退出，主任务运行，浏览器打开 Query 页面 |
| Grafana + Vault | 前置权限任务正常退出，主任务运行，浏览器打开登录页 |
| RocketMQ | namesrv 与 broker 运行，两个组件日志均显示 `boot success` |
| ACME 证书续期 | 按用户要求仅检查配置与前置校验；Docker、卷挂载、Vault 联动、CA 就绪，准确提示缺少 Role 和 DNS 密钥；未注册周期任务、未签发证书 |

验收后保留 Nginx、OpenResty 网关、Shell 守护脚本、Prometheus、Grafana 作为运行示例，其余长驻服务停止，批处理保留完成记录。用于准备 SSH 公钥的一次性任务已清理。

## 界面检查与修正

检查了总览、基础设施、Docker、Nomad、Vault、集群联动、Job 中心、定时任务、审计、环境迁移、系统设置、账号、版本共 13 个主页面，覆盖桌面与 390×844 手机视口、浅色及深色主题。页面没有整页横向溢出；宽数据表在自己的容器内横向滚动。

补查了主机密钥库、Docker 配置与巡检、集群策略、Nomad 运维及配置、Clients、Servers、容量、CSI、Variables、Evaluations、Namespace / Pool / ACL、Vault 初始化托管、快照、KV / Policy / Auth，以及设置各分区。集群创建、主机接入、密钥补齐、日志抽屉和停止确认等交互也在实际部署过程中检查。

本轮优化总览手机指标为两列，减少首屏纵向占用；为页签增加可见滚动提示，并使当前项在容器内滚入可视区；蓝图增加名称、用途、标签搜索、数量反馈、空结果及清除入口。实测搜索 Vault 命中 8/16，空查询恢复 16/16，手机末尾页签保持可见。

修正下拉菜单选项滚动带动整页的问题，菜单与触发器保持在视口内。Job 列表补齐实际分配资源，直接显示真实地址与端口，与实例详情一致。

## 模板修复与验证

Prometheus、Grafana、RocketMQ 的镜像以非 root 用户运行，自动创建的宿主机目录原本归 root，导致数据目录不可写。模板增加一次性 prestart 任务，将共享分配目录归属服务用户；主任务保持镜像默认用户。共享卷从任务目录通过 `../alloc/data` 定位，确保准备任务与主任务访问同一目录。Grafana 的密码模板指定服务用户所有权，同时保持 0600 权限。

Nginx 与 OpenResty 网关的就绪页、健康页明确返回 `text/plain`，解决浏览器将响应当作下载的问题。

自动验证包含前端 53 项测试、TypeScript 检查及构建；workbench、jobs、nomad 包测试与真实 Nomad 集成用例；Allocation 合并与真实动态端口断言；workbench 静态检查和差异空白检查。修复后完成远端重新部署与真实 UI 复测。

## 使用边界

该环境只有一台约 2 GiB 内存的主机，不具备 Nomad / Vault 高可用能力。所有模板不适合同时常驻；Plan 会显示资源不足，应先停止已验收的较大实例。数据库和监控示例使用分配目录，跨节点重调度或清理实例前需要另行配置持久化存储与备份。

ACME 后续启用需要合法域名、对应 DNS API 授权及读写 Role；本轮没有创建真实 DNS 凭据或触发证书签发。Redis 日志存在宿主机 `vm.overcommit_memory` 建议，验收未修改宿主机内核参数。
