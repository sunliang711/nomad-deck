export const ACTION_LABELS: Record<string, string> = {
  'cluster.deploy': '部署集群',
  'cluster.upgrade': '滚动升级集群',
  'cluster.node_join': '集群扩容节点',
  'cluster.node_remove': '集群缩容节点',
  'cluster.node_service': '节点服务启停',
  'cluster.certs_renew': '续期集群证书',
  'cluster.ca_rotate': '轮换集群 CA',
  'cluster.gossip_rotate': '轮换 Gossip 密钥',
  'cluster.snapshot': '创建 Raft 快照',
  'cluster.restore': '恢复 Raft 快照',
  'cluster.rollback_generation': '回滚节点配置代际',
  'cluster.uninstall': '卸载集群',
  'system.self_update': '控制面自更新',
  'system.self_update_rollback': '控制面版本回退',
  'cron.run': '定时任务执行',
  'docker.install': '安装 Docker',
  'docker.upgrade': '升级 Docker',
  'integration.sync': '同步集群联动',
  'integration.delete': '删除集群联动',
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
