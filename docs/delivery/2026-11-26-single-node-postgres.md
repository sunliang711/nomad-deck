# 单节点部署与 PostgreSQL 使用验收

## 环境与入口

验收日期为 2026 年 11 月 26 日。控制面运行于 Debian 13 主机 10.2.13.123，采用原生 systemd 服务，访问地址为 https://10.2.13.123:8555。

管理员账号为 admin。初始管理员凭据存放于远程主机的 /opt/nomad-deck-control/initial-admin.json，文件权限为 0600。文档、任务定义与验收截图均不包含实际密码、Token 或解封分片。

| 服务 | 名称 | 版本 | 状态 |
| --- | --- | --- | --- |
| NomadDeck | 控制面 | v0.1.4 | 原生服务 |
| Docker Engine | deck-node-1 | 29.10.1 | 平台托管 |
| Nomad | nomad-single | 2.1.1 | 单节点 Server + Client，健康 |
| Vault | vault-single | 2.2.2 | 单节点 Raft，初始化并解封，健康 |
| PostgreSQL | postgres | 17.12 | Docker 任务运行中 |

控制面与集群服务共用一台主机，资源为 2 CPU、约 1.9 GiB 内存。该环境用于入门体验与功能验证，不具备节点故障容灾能力。

## 页面操作流程

主机登记、连通性探测、Docker 安装、镜像代理配置、Nomad 与 Vault 建群、Vault 初始化托管、Secret 写入、联动应用以及 Job 提交均通过真实 Web UI 完成。SSH 用于控制面部署、SSH 公钥授权和只读环境诊断。

1. 在基础设施登记 deck-node-1，确认 SSH 在线与时间同步。
2. 打开 Docker 管理，安装版本留空，安装官方仓库最新版；镜像下载沿用控制面系统代理。
3. 分别创建 nomad-single 与 vault-single，选择同一台主机并执行部署。
4. 在 Vault 页面初始化托管，启用自动解封与 KV v2 存储空间 secret。
5. 创建 apps/postgres，保存 username、password、database 三个字段。用户名为 app，数据库为 appdb，密码为随机值。
6. 创建 nomad-vault 联动和 postgres Role，仅授权 secret/apps/postgres，绑定 default 命名空间。应用时确认单节点维护，等待任务成功。
7. 在 Job 中心选择 PostgreSQL + Vault，依次校验、预览计划和确认运行。

## 凭据与数据库访问

数据库入口为 10.2.13.123:5432，数据库 appdb，用户 app。密码通过 Vault 页面读取 secret/apps/postgres。

Role 配置使用 secret/apps/postgres；任务模板读取 KV v2 的 API 路径 secret/data/apps/postgres。密码模板写入容器 secrets 目录中的权限为 0600 的文件，PostgreSQL 通过 POSTGRES_PASSWORD_FILE 使用该文件。任务定义不包含密码明文，Vault Token 不注入应用环境变量。

Vault 的初始 Root Token 在派生运维 Token 后吊销。解封分片由控制面加密托管。控制面安装目录与数据目录应按管理凭据级别保护。

## 验收结果

- 联动应用完成，JWKS、配置下发、Agent、JWT 挂载、认证配置与 postgres Role 检查均正常。
- PostgreSQL 的 Deployment 成功，Allocation 与 Task 均运行中，stderr 日志包含数据库接受连接的就绪信息。
- 网页终端能够连接容器并执行 SQL，返回数据库 appdb、用户 app 和 PostgreSQL 17.12。
- 使用 Vault 密码通过主机 5432 端口执行查询成功；使用错误密码被 SCRAM 认证拒绝，客户端退出码为 2。容器内回环地址采用镜像默认的本地 trust 规则，因此密码校验以主机网络入口为准。
- Docker 非法版本在弹窗内显示错误，空升级版本不能提交；未触发实际升级或容器中断。
- 单节点联动确认框支持取消，确认后才提交维护任务，完成后状态自动更新。
- 桌面、390 × 844 窄屏及浅色、深色主题均进行页面检查；联动、Job 与 Docker 弹窗无横向溢出，长内容通过局部滚动查看。
- 全量 Go 竞态检查、静态检查、TypeScript 类型检查、前端生产构建和八项 HCL 编排检查通过。终端回归覆盖 HTTP/2 请求后的 TLS WebSocket 连接。

## 数据与维护边界

PostgreSQL 数据目录位于当前 Allocation 的 local/pgdata，使用 sticky 临时磁盘。任务进程重启可以复用当前 Allocation 数据，但重新调度、Allocation 清理或主机故障可能导致数据丢失；正式承载业务前应配置持久卷与数据库备份。

Vault 密码更新不会自动修改 PostgreSQL 中已经初始化的数据库密码。轮换时应协调数据库角色密码、Vault Secret 和任务文件更新，不能仅修改 Secret。

单节点 Nomad 重启期间调度与 API 会短暂中断。Docker 守护进程维护可能中断容器。该环境没有替代节点，也未配置异地备份目标。
