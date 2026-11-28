# 10.2.250.51 部署与连接验收

验收日期：2026-11-28。控制面版本：v0.9.6。

## 环境与访问

| 项目 | 当前配置 |
| --- | --- |
| 主机 | Debian 13 amd64，2 CPU、1973 MiB 内存 |
| 控制面 | `https://10.2.250.51:8555`，systemd 服务 `nomad-deck` |
| 控制面目录 | `/opt/nomad-deck-control` |
| Docker | 29.10.1，控制面托管 |
| Nomad | `nomad-single`，2.1.1，单节点 Server + Client，dc1 / global，启用 CNI、raw_exec 和 Docker 宿主机卷 |
| Vault | `vault-single`，2.2.2，单节点 Raft，已初始化、托管密钥、自动解封 |
| 集群联动 | `nomad-vault`，JWT 挂载 `jwt-nomad`，KV v2 挂载 `secret` |
| 出站代理 | `10.2.1.115:9605`，全部下载范围及 Docker 拉取启用，回环和内网直连 |

管理员为 `admin`，密码保存在操作端本地 `/tmp/nomad-deck-51-access.json`，权限 0600。文档不记录密码、代理口令、Vault Token 或解封密钥。

控制面通过 SSH 安装与更新。主机接入、Docker 安装、集群创建、初始化、联动配置、密钥补齐、所有 Job 提交与停止均使用真实 Web UI。SSH 只读诊断用于核对进程、监听、镜像和资源。

## 模板与独立调用方验收

内置模板共 16 个，15 个非证书模板均通过 Web UI 载入、预览计划并运行。调用方采用「连接与使用」提供的片段；通用服务按卡片提示补充应用配置，RabbitMQ 和 Grafana 另补只读 Vault 模板。测试不把凭据输出到日志。

| 模板 | 运行与连接结果 |
| --- | --- |
| Nginx 容器服务 | 原始动态端口运行正常；按卡片添加服务注册，独立 Job 发现服务并收到默认页，`NGINX_HTTP_OK 200` |
| Caddy | 独立 Job 发现服务并读取就绪页，`CADDY_HTTP_OK 200` |
| Traefik | 独立 Job 发现服务并请求 HTTP 入口，默认未配置路由返回预期 404，`TRAEFIK_HTTP_OK 404` |
| Nginx 网关 | 独立 Job 请求 `/healthz`，`NGINX_GATEWAY_HTTP_OK 200` |
| OpenResty 网关 | 独立 Job 请求 `/healthz`，`OPENRESTY_GATEWAY_HTTP_OK 200` |
| PostgreSQL + Vault | 使用业务凭据完成建临时表、插入与查询，`POSTGRES_READ_WRITE_OK` |
| MySQL + Vault | 使用业务用户完成读写，`MYSQL_READ_WRITE_OK` |
| Redis + Vault | 完成 SET、GET、DEL，`REDIS_READ_WRITE_OK` |
| RabbitMQ + Vault | 从独立 Job 完成 AMQP 认证、建队列、发布、消费、删队列，`RABBITMQ_AMQP_PUBLISH_CONSUME_OK` |
| RocketMQ | NameServer 返回 Broker 注册；独立 Job 创建测试 Topic 并发送、消费消息，`ROCKETMQ_SEND_CONSUME_OK` |
| Prometheus | 权限准备任务退出正常；独立 Job 请求 `/-/healthy`，`PROMETHEUS_HTTP_OK 200` |
| Grafana + Vault | 权限准备任务退出正常；独立 Job 使用 Vault 凭据访问认证接口，`GRAFANA_VAULT_LOGIN_OK` |
| Docker Registry | 独立 Job 请求 `/v2/` 返回 `{}`，`DOCKER_REGISTRY_HTTP_OK 200` |
| Shell 守护脚本 | raw_exec 持续输出带时间的日志，无网络监听 |
| 一次性批处理 | Allocation 正常完成，输出 `Batch task finished on debian13`；Job 的 dead 状态符合预期 |
| ACME 证书续期 | 按要求跳过运行，不注册周期任务、不申请证书 |

另一个独立 Job 同时引用 PostgreSQL 和 Redis，Task 仅保留一个 Vault 块，并分别保留两个环境模板；两种服务均读写成功，输出 `MULTI_POSTGRES_REDIS_OK`。

## 连接指引规则与复测

连接卡片依据当前配置生成，不能代替运行健康检查。未注册服务但已声明端口时，注册示例使用对应 Group 的实际端口标签。无端口的后台任务提示查看日志；需要网络服务时，先让应用监听、声明并绑定端口，再注册服务。

真实复现确认：给无端口 Shell 任务直接添加引用 `http` 的服务注册，Allocation 会因端口标签不存在而启动失败。当前卡片不为这种任务生成虚构端口。远端页面复测覆盖 Shell 无端口提示、Nginx 默认 `http` 标签、改为 `api` 后指引同步，以及 JSON 模式端口识别。按 `api` 指引生成的提供方与独立调用方实际连接成功。

服务发现返回实际注册地址。调用方容器必须能访问该地址；本次 Traefik 返回 IPv6，默认 Docker IPv4 网络访问失败。调用方使用具备 IPv6 连通性的网络并为 URL 地址添加方括号后，HTTP 请求成功。卡片说明覆盖这两个条件。

前端 66 项测试、TypeScript 检查和生产构建通过；运行页面和修正后的卡片均在目标主机复测。

## 运行与资源

约 2 GiB 内存无法让全部模板同时常驻，网关也共用 80/443。本环境分批验收，保留所有已验收的 Job 定义和日志；诊断用的无端口错误注册 Job 已清理。常驻示例为 Nginx、Shell、PostgreSQL、Redis、Prometheus、Grafana，其他长期服务保持停止，批处理保留完成记录。

重新运行 RocketMQ 等较大实例前，应先停止其他示例并等待资源释放，再重新预览计划。启动初期发现服务不代表应用已可连接，调用方需要等待依赖就绪。MySQL 使用镜像支持的默认安全连接协商。

数据库和监控模板使用分配目录；清理实例或跨节点重新调度前，需要自行配置持久存储与备份。网关此次验证默认 HTTP 模式，未启用可选 Vault 证书和 HTTPS 配置。
