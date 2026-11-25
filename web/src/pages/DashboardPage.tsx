import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, AlertTriangle, ArrowUpRight } from 'lucide-react';
import { apiGet, fmtTime } from '../lib/api';
import { useOpsDrawer } from '../lib/opsDrawer';
import { Badge, Button, Card, EmptyState, ErrorAlert, statusTone } from '../components/UI';

export function DashboardPage() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const { openTask } = useOpsDrawer();

  const load = useCallback(async () => {
    setErr('');
    try {
      const res = await apiGet('/api/v1/dashboard/summary');
      setData(res);
    } catch (ex: any) {
      setErr(ex?.message || '加载仪表盘失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const cp = data?.control_plane || {};
  const nodes = data?.nodes || {};
  const clusters = data?.clusters || {};
  const backupAlerts = data?.backup_alerts;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">
          控制面版本：<span className="font-mono font-medium text-slate-700 dark:text-slate-300">{cp.version || '-'}</span>
        </div>
        <Button size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>刷新</span>
        </Button>
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {/* Top actionable alerts */}
      <div className="space-y-2">
        {cp.activated === false && (
          <div className="flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              控制面尚未激活（迁移导入后默认暂停自动调度与解封，以防双活冲突）。
            </span>
            <Link to="/migration-backup" className="font-medium underline">
              前往激活
            </Link>
          </div>
        )}
        {cp.maintenance_barrier && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
            当前存在全局维护屏障：{cp.maintenance_barrier}
          </div>
        )}
        {cp.update_available && (
          <div className="flex items-center justify-between rounded-md border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-200">
            <span>发现 NomadDeck 新版本 {cp.latest_version}</span>
            <Link to="/version" className="inline-flex items-center gap-1 font-medium underline">
              查看更新 <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        )}
        {backupAlerts?.missing_offsite_target && (
          <div className="flex items-center justify-between rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
            <span>灾备告警：尚未配置已启用的异地备份目标（SFTP / S3）。</span>
            <Link to="/migration-backup" className="font-medium underline">
              配置灾备
            </Link>
          </div>
        )}
        {backupAlerts && backupAlerts.consecutive_failures > 0 && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200">
            灾备告警：控制面灾备备份已连续失败 {backupAlerts.consecutive_failures} 次。
          </div>
        )}
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card
          title="托管主机"
          actions={
            <Link to="/infra" className="inline-flex items-center gap-0.5 text-xs text-emerald-600 hover:underline dark:text-emerald-400">
              进入 <ArrowUpRight className="h-3 w-3" />
            </Link>
          }
        >
          <div className="flex items-baseline justify-between">
            <Link to="/infra" className="text-2xl font-bold hover:text-emerald-600 dark:hover:text-emerald-400">
              {nodes.total ?? 0}
            </Link>
            <div className="flex gap-1.5 text-xs">
              <Link to="/infra"><Badge tone="green">在线 {nodes.online ?? 0}</Badge></Link>
              <Link to="/infra"><Badge tone={nodes.offline > 0 ? 'red' : 'neutral'}>离线 {nodes.offline ?? 0}</Badge></Link>
            </div>
          </div>
        </Card>
        <Card
          title="纳管集群"
          actions={
            <div className="flex items-center gap-2 text-xs">
              <Link to="/nomad" className="text-emerald-600 hover:underline dark:text-emerald-400">Nomad</Link>
              <Link to="/vault" className="text-emerald-600 hover:underline dark:text-emerald-400">Vault</Link>
            </div>
          }
        >
          <div className="flex items-baseline justify-between">
            <Link to="/nomad" className="text-2xl font-bold hover:text-emerald-600 dark:hover:text-emerald-400">
              {clusters.total ?? 0}
            </Link>
            <div className="flex gap-1.5 text-xs">
              <Link to="/nomad"><Badge tone="blue">Nomad {clusters.nomad ?? 0}</Badge></Link>
              <Link to="/vault"><Badge tone="neutral">Vault {clusters.vault ?? 0}</Badge></Link>
            </div>
          </div>
        </Card>
        <Card
          title="证书临期预警"
          actions={
            <Link to="/vault" className="inline-flex items-center gap-0.5 text-xs text-emerald-600 hover:underline dark:text-emerald-400">
              管理 <ArrowUpRight className="h-3 w-3" />
            </Link>
          }
        >
          <div className="flex items-baseline justify-between">
            <Link to="/vault" className="text-2xl font-bold hover:text-emerald-600 dark:hover:text-emerald-400">
              {(data?.cert_alerts || []).length}
            </Link>
            <Link to="/vault">
              <Badge tone={(data?.cert_alerts || []).length > 0 ? 'amber' : 'green'}>
                {(data?.cert_alerts || []).length > 0 ? '需关注' : '正常'}
              </Badge>
            </Link>
          </div>
        </Card>
        <Card
          title="待核对异常任务"
          actions={
            <Link to="/operations" className="inline-flex items-center gap-0.5 text-xs text-emerald-600 hover:underline dark:text-emerald-400">
              排查 <ArrowUpRight className="h-3 w-3" />
            </Link>
          }
        >
          <div className="flex items-baseline justify-between">
            <Link to="/operations" className="text-2xl font-bold hover:text-emerald-600 dark:hover:text-emerald-400">
              {(data?.pending_reconcile_tasks || []).length}
            </Link>
            <Link to="/operations">
              <Badge tone={(data?.pending_reconcile_tasks || []).length > 0 ? 'red' : 'green'}>
                {(data?.pending_reconcile_tasks || []).length > 0 ? '需人工核对' : '无异常'}
              </Badge>
            </Link>
          </div>
        </Card>
      </div>

      {/* Clusters + Alerts */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card
          title="集群状态"
          actions={
            <div className="flex items-center gap-3 text-xs">
              <Link to="/nomad" className="inline-flex items-center gap-0.5 text-emerald-600 hover:underline dark:text-emerald-400">
                Nomad <ArrowUpRight className="h-3 w-3" />
              </Link>
              <Link to="/vault" className="inline-flex items-center gap-0.5 text-emerald-600 hover:underline dark:text-emerald-400">
                Vault <ArrowUpRight className="h-3 w-3" />
              </Link>
            </div>
          }
        >
          {(clusters.items || []).length === 0 ? (
            <EmptyState text="暂无集群" />
          ) : (
            <div className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {clusters.items.map((c: any) => (
                <div key={c.id} className="flex items-center justify-between py-2">
                  <div>
                    <Link
                      to={c.type === 'vault' ? `/vault?id=${c.id}` : `/nomad?id=${c.id}`}
                      className="font-medium text-emerald-600 hover:underline dark:text-emerald-400"
                    >
                      {c.name}
                    </Link>
                    <span className="ml-2 text-xs text-slate-500">
                      {c.type} · {c.mode}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {c.maintenance_mode && <Badge tone="amber">维护中</Badge>}
                    <Badge tone={statusTone(c.health_status)}>{c.health_status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card
          title="Vault 与时钟告警"
          actions={
            <div className="flex items-center gap-3 text-xs">
              <Link to="/infra" className="inline-flex items-center gap-0.5 text-emerald-600 hover:underline dark:text-emerald-400">
                主机 <ArrowUpRight className="h-3 w-3" />
              </Link>
              <Link to="/cron" className="inline-flex items-center gap-0.5 text-emerald-600 hover:underline dark:text-emerald-400">
                定时任务 <ArrowUpRight className="h-3 w-3" />
              </Link>
              <Link to="/migration-backup" className="inline-flex items-center gap-0.5 text-emerald-600 hover:underline dark:text-emerald-400">
                灾备 <ArrowUpRight className="h-3 w-3" />
              </Link>
            </div>
          }
        >
          <div className="space-y-3 text-sm">
            {(data?.vault_alerts || []).map((a: any, i: number) => (
              <Link
                key={i}
                to={a.cluster_id ? `/vault?id=${a.cluster_id}` : '/vault'}
                className="flex items-center justify-between rounded bg-amber-50 px-3 py-2 text-xs text-amber-900 hover:bg-amber-100 dark:bg-amber-950/60 dark:text-amber-200 dark:hover:bg-amber-950"
              >
                <span>
                  <b>{a.cluster_name}</b>：{a.message}
                </span>
                <Badge tone="amber">{a.kind}</Badge>
              </Link>
            ))}
            {(nodes.clock_skew_alerts || []).map((n: any) => (
              <Link
                key={n.node_id}
                to="/infra"
                className="flex items-center justify-between rounded bg-rose-50 px-3 py-2 text-xs text-rose-900 hover:bg-rose-100 dark:bg-rose-950/60 dark:text-rose-200 dark:hover:bg-rose-950"
              >
                <span>
                  节点 <b>{n.node_name}</b> ({n.host}) 时钟同步异常：{n.time_sync}，偏差 {n.clock_skew_ms} ms
                </span>
                <Badge tone="red">时钟告警</Badge>
              </Link>
            ))}
            {(data?.cert_alerts || []).map((ca: any, i: number) => {
              const targetCluster = (clusters.items || []).find((c: any) => c.id === ca.cluster_id);
              const certHref = targetCluster?.type === 'nomad' ? `/nomad?id=${ca.cluster_id}` : `/vault?id=${ca.cluster_id || ''}`;
              return (
                <Link
                  key={i}
                  to={certHref}
                  className="flex items-center justify-between rounded bg-amber-50 px-3 py-2 text-xs text-amber-900 hover:bg-amber-100 dark:bg-amber-950/60 dark:text-amber-200 dark:hover:bg-amber-950"
                >
                  <span>
                    <b>{ca.cluster_name}</b> {ca.node ? `/ ${ca.node}` : ''} {ca.kind} 证书剩余 {ca.days_left} 天
                  </span>
                  <Badge tone="amber">临期</Badge>
                </Link>
              );
            })}
            {(data?.vault_alerts || []).length === 0 &&
              (nodes.clock_skew_alerts || []).length === 0 &&
              (data?.cert_alerts || []).length === 0 && <EmptyState text="暂无告警" />}
          </div>
        </Card>
      </div>

      {/* Recent Operations + Audit */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card
          title="最近运维任务"
          actions={
            <Link to="/operations" className="inline-flex items-center gap-0.5 text-xs text-emerald-600 hover:underline dark:text-emerald-400">
              全部任务 <ArrowUpRight className="h-3 w-3" />
            </Link>
          }
        >
          {(data?.recent_operations || []).length === 0 ? (
            <EmptyState text="暂无运维任务" />
          ) : (
            <div className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
              {data.recent_operations.map((t: any) => (
                <div key={t.id} className="flex items-center justify-between gap-2 py-2">
                  <div>
                    <button
                      type="button"
                      onClick={() => openTask(t.id, `${t.action} (${t.id})`)}
                      className="font-mono font-medium text-emerald-600 hover:underline dark:text-emerald-400"
                    >
                      {t.action}
                    </button>
                    <div className="text-slate-500">
                      {t.triggered_by} · {fmtTime(t.created_at)}
                    </div>
                  </div>
                  <Badge tone={statusTone(t.status)}>{t.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card
          title="最近审计动态"
          actions={
            <Link to="/audit" className="inline-flex items-center gap-0.5 text-xs text-emerald-600 hover:underline dark:text-emerald-400">
              全部日志 <ArrowUpRight className="h-3 w-3" />
            </Link>
          }
        >
          {(data?.recent_audit_logs || []).length === 0 ? (
            <EmptyState text="暂无审计日志" />
          ) : (
            <div className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
              {data.recent_audit_logs.map((l: any) => (
                <div key={l.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      <span className="font-mono">{l.action}</span> · {l.resource_name || l.resource_type}
                    </div>
                    <div className="text-slate-500">
                      {l.actor_name} · {fmtTime(l.created_at)}
                    </div>
                  </div>
                  <Badge tone={statusTone(l.result)}>{l.result}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
