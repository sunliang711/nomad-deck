export const ACTION_LABELS: Record<string, string> = {
  // 异步运维任务
  'cluster.deploy': '部署集群',
  'cluster.upgrade': '滚动升级集群',
  'cluster.node_join': '集群扩容节点',
  'cluster.node_remove': '集群缩容节点',
  'cluster.node_service': '节点服务启停',
  'cluster.node_config': '更新节点配置',
  'cluster.host_volume_add': '创建 Host Volume',
  'cluster.certs_renew': '续期集群证书',
  'cluster.cert_renew': '续期集群证书',
  'cluster.ca_rotate': '轮换集群 CA',
  'cluster.gossip_rotate': '轮换 Gossip 密钥',
  'cluster.snapshot': '创建 Raft 快照',
  'cluster.snapshot_delete': '删除 Raft 快照',
  'cluster.snapshot_download': '下载 Raft 快照',
  'cluster.snapshot_restore': '恢复 Raft 快照',
  'cluster.snapshot_upload': '上传 Raft 快照',
  'cluster.restore': '恢复 Raft 快照',
  'snapshot.restore': '恢复快照',
  'cluster.rollback_generation': '回滚节点配置代际',
  'cluster.config_rollback': '回滚节点配置',
  'cluster.uninstall': '卸载集群',
  'system.self_update': '控制面自更新',
  'system.self_update_confirmed': '确认控制面自更新',
  'system.self_update_rollback': '控制面版本回退',
  'system.self_update_schedule_create': '创建定时自更新',
  'system.self_update_schedule_cancel': '取消定时自更新',
  'system.master_key_rotate': '轮换控制面主密钥',
  'cron.run': '执行定时任务',
  'docker.install': '安装 Docker',
  'docker.upgrade': '升级 Docker',
  'docker.cluster_upgrade': '集群滚动升级 Docker',
  'docker.adopt': '接管外部 Docker',
  'docker.config': '更新 Docker 配置',
  'docker.defaults': '更新集群 Docker 默认配置',
  'docker.proxy_test': '测试 Docker 代理',
  'integration.sync': '同步集群联动',
  'integration.delete': '删除集群联动',
  'integration.vault_ca_rollout': '同步 Vault CA 到 Nomad',

  // 认证与账号审计
  'auth.setup': '初始化系统',
  'auth.login': '管理员登录',
  'auth.logout': '退出登录',
  'auth.password_change': '修改登录密码',
  'auth.session_revoke': '注销会话',
  'admin.create': '新增控制台账号',
  'admin.update': '更新控制台账号',
  'admin.rename': '修改账号名称',
  'admin.role_change': '变更账号角色',
  'admin.reset_password': '重置账号密码',
  'admin.reset_password_local': '本地 CLI 重置密码',
  'admin.disable': '停用账号',
  'admin.enable': '启用账号',

  // 主机与密钥
  'ssh_key.generate': '生成 SSH 密钥',
  'ssh_key.import': '导入 SSH 密钥',
  'ssh_key.set_default': '设为默认 SSH 密钥',
  'ssh_key.delete': '删除 SSH 密钥',
  'node.create': '新增主机节点',
  'node.update': '更新主机节点',
  'node.delete': '删除主机节点',
  'node.test': '探测主机环境',
  'node.push_key': '推送 SSH 公钥',
  'node.reset_fingerprint': '重置主机指纹',
  'node.reset_machine_id': '重生成节点 ID',
  'node.set_aliases': '设置主机别名',

  // 集群与 Vault
  'cluster.create': '创建集群配置',
  'cluster.update': '更新集群配置',
  'cluster.delete': '删除集群配置',
  'cluster.add_nodes': '扩容集群节点',
  'cluster.join_node': '扩容加入节点',
  'cluster.remove_node': '缩容移除节点',
  'cluster.maintenance': '切换维护模式',
  'cluster.reconcile': '核对集群状态',
  'cluster.settings': '更新集群设置',
  'cluster.settings_rollout': '下发集群配置',
  'cluster.credentials': '更新访问凭据',
  'cluster.credentials_supply': '补充托管凭据',
  'cluster.proxy_update': '更新集群代理设置',
  'nomad.install': '部署 Nomad 集群',
  'nomad.management_token_reveal': '查看 Nomad 管理密钥',
  'vault.init': '初始化 Vault 托管',
  'vault.init_reset': '重置 Vault 初始化状态',
  'vault.unseal': '解封 Vault 集群',
  'vault.seal': '封存 Vault 集群',
  'vault.rekey': 'Vault 密钥轮换',
  'vault.recover_token': '恢复 Vault 运维 Token',
  'vault.token_renew': '续期 Vault 运维 Token',
  'vault.custody_update': '更新 Vault 托管策略',
  'vault.custody_backup': '导出 Vault 托管备份',
  'vault.root_token': '签发临时 Root Token',
  'vault.root_token_generate': '签发临时 Root Token',
  'vault.root_token_revoke': '吊销临时 Root Token',
  'vault.root_token_revoke_manual': '手动吊销 Root Token',
  'vault.auth_enable': '启用 Vault Auth',
  'vault.auth_disable': '停用 Vault Auth',
  'vault.policy_put': '保存 Vault 策略',
  'vault.policy_delete': '删除 Vault 策略',
  'vault.kv_mount_enable': '启用 Vault KV 引擎',
  'vault.kv_write': '写入 Vault KV 密钥',
  'vault.kv_read': '读取 Vault KV 密钥',
  'vault.kv_delete': '删除 Vault KV 密钥',

  // 联动 / Job / 定时 / 设置 / 灾备
  'integration.create': '新建集群联动',
  'integration.update': '更新集群联动',
  'integration.apply': '应用联动配置',
  'integration.doctor': '诊断集群联动',
  'integration.role_put': '配置联动角色',
  'integration.role_delete': '删除联动角色',
  'integration.delete_config': '删除联动配置',
  'nomad.job_workbench': '编排提交 Nomad Job',
  'nomad.job_visual': '可视化提交 Nomad Job',
  'nomad.job_compose': 'Compose 导入提交 Job',
  'nomad.job_json': 'JSON 提交 Nomad Job',
  'nomad.job_apply': '提交 Nomad Job',
  'nomad.job_edit_source': '编辑 Job 源码',
  'nomad.job_export': '导出 Nomad Job',
  'nomad.job_restart': '重启 Nomad Job',
  'nomad.job_stop': '停止 Nomad Job',
  'nomad.job_purge': '清理 Nomad Job',
  'nomad.job_template_put': '保存 Job 模板',
  'nomad.job_template_delete': '删除 Job 模板',
  'nomad.job_variables_reveal': '查看 Job 变量密钥',
  'cron.create': '创建定时任务',
  'cron.update': '更新定时任务',
  'cron.delete': '删除定时任务',
  'settings.update': '更新系统设置',
  'settings.proxy_update': '更新系统代理',
  'settings.proxy_test': '测试系统代理',
  'settings.proxy_password_reveal': '查看代理密码',
  'settings.master_key_rotate': '轮换主密钥',
  'backup.config_update': '更新灾备配置',
  'backup.run': '执行控制面灾备',
  'backup.target_test': '测试灾备存储连接',
  'backup.secret_reveal': '查看灾备密钥',
  'migration.export': '导出迁移包',
  'migration.import': '导入迁移包',
  'migration.preview': '预检迁移包',
  'migration.activate': '激活控制面',
  'self_update.start': '发起控制面自更新',
  'self_update.rollback': '回退控制面版本',
};

export const RESOURCE_LABELS: Record<string, string> = {
  admin: '管理员',
  session: '会话',
  ssh_key: 'SSH 密钥',
  node: 'Linux 主机',
  cluster: '集群',
  vault: 'Vault',
  integration: '集群联动',
  nomad_job: 'Nomad Job',
  job_template: 'Job 模板',
  cron_job: '定时任务',
  settings: '系统设置',
  backup: '控制面灾备',
  migration: '环境迁移',
  system: '控制面系统',
};

export function formatActionLabel(action: string): string {
  return ACTION_LABELS[action] || action || '运维任务';
}

export function isTaskActiveStatus(status: string): boolean {
  return status === 'running' || status === 'pending';
}

export function isTaskFailureStatus(status: string): boolean {
  return status === 'failed' || status === 'needs_reconcile' || status === 'interrupted';
}

export function formatTaskDuration(startedAt?: string | null, finishedAt?: string | null, createdAt?: string | null, nowMs = Date.now()): string {
  const startRaw = startedAt || createdAt;
  if (!startRaw) return '—';
  const start = Date.parse(startRaw);
  if (!Number.isFinite(start)) return '—';
  const end = finishedAt ? Date.parse(finishedAt) : nowMs;
  if (!Number.isFinite(end)) return '—';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}
