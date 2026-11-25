# 三节点 Web 管理台验收修复

## 验收环境

控制面位于 10.2.69.8 的 8555 HTTPS 端口，采用 Docker 单二进制部署。10.2.69.8、10.2.86.228、10.2.108.152 同时承担三个 Nomad server_client 节点和三个 Vault Raft 节点。集群操作和业务验收通过 Web 页面完成。自更新、预约更新和控制面版本回退不执行。

## 修复内容

- Vault 支持在页面启用 KV v2 挂载、创建 Secret，保持 CAS 并发保护并采用服务端返回的版本。
- Vault 概要随实时状态刷新，未知密封状态显示 Unknown，部署时由管理员明确确认未加密 Swap 风险。
- Nomad 和 Vault 支持页面扩容，Nomad 刷新按钮同步刷新成员、快照和治理信息。
- Nomad Namespace、Node Pool、ACL Role 以及 Vault Auth 方法具备管理入口，自定义 Policy 可以删除。
- Vault 自动解封可以启停，手动封存的抑制状态可以经二次验密解除。
- Variable 删除携带当前 CAS 版本，未运行 Task 的终端及重启操作不可用。
- Job 停止状态使用 Stop 标记，列表通过共享事件流刷新；JSON 定义和原变量能够正确载入，内容变化清除旧 Plan。
- Job 与 Allocation 详情切换时清除旧数据，忽略过期请求的响应，展示 Task 事件。
- 单二进制内嵌时区数据，精简容器可以使用 Asia/Singapore；部署表单读取系统默认版本和代理设置。
- Docker 安装、升级可以选择代理、疏散和中断确认；Nomad 客户端默认先疏散。
- Docker 包安装期间临时抑制运行时的包脚本启停动作，退出时恢复宿主原有策略；恢复失败服务、避免重复重启、核对真实回退结果，空测试镜像使用内置默认值。
- 治理测试等待调度完成后清理任务，避免触发 Nomad 1.11 的调度竞态。

## 验证结果

前端类型检查及生产构建、Go 静态检查、全量 race 测试通过。Docker 脚本回归覆盖已更新服务、旧服务、失败服务恢复、启动失败、原有安装策略保留及安装失败清理。

页面验证通过集群创建、初始化、三节点仲裁、缩容及重新加入、滚动升级、证书续期、双向 CA 信任链更新、Gossip 轮换、Rekey、封存及解封。Nomad Doctor 为 30 OK / 0 WARN / 0 FAIL；Vault Doctor 为 28 OK / 3 WARN / 0 FAIL，警告对应宿主机未加密 Swap。

普通 Docker Job 与 Vault Workload Identity Secret Job 均存在运行中的 Allocation，并输出指定验证标记。文件预览、WebSocket 终端、Job 启停与回滚、批处理、Periodic 触发及 Parameterized 派发通过。Namespace、Pool、Role、Policy、Token 和 Variable 管理通过。

本地、SFTP、S3 兼容存储备份均完成上传及回读校验。两类 Raft 快照完成加密下载、上传登记及恢复；S3 异地快照可列出并登记回集群。Vault 离线备份可以解密为第二代五份密钥、三份阈值，验证过程不输出密钥内容。

主密钥轮换完成十九条记录和七份快照重加密，切换新主密钥并重启后可以继续备份。迁移包在临时空白控制面执行 replace 恢复，原实例停止后完成激活和健康巡检；重复 merge 导入被名称及主机归属冲突保护拦截。

## 运行边界

Nomad Docker 驱动在 Docker 连接断开时可能以 unexpected EOF 结束 Task，因此客户端升级默认疏散，需要其他可调度节点。两个集群没有配置统一业务入口，联动体检明确提示单节点入口回退，不能据此宣称业务入口具备高可用能力。

设计说明中尚未实现的业务能力不在本次范围内。没有 Web 入口的 API 独有操作不使用直接 API 或远程命令替代页面验收。正向应急重签因运维 Token 仍有效而未触发，仅验证了拒绝保护。

临时 S3 服务、批处理及周期性测试 Job 清理，保留 ui-hello、ui-vault-secret 两个示例和本地、SFTP 灾备目标。测试只读账号停用，临时恢复控制面停止。
