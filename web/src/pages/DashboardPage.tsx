import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Clock,
  FileWarning,
  RefreshCw,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { apiGet, fmtTime } from '../lib/api';
import { useOpsDrawer } from '../lib/opsDrawer';
import { Badge, Button, Card, EmptyState, ErrorAlert, LoadingState, PageHeader, StatusBadge } from '../components/UI';

export function DashboardPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const { openTask } = useOpsDrawer();

  const load = useCallback(async () => {
    setLoading(true);
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

  if (loading && !data) return <LoadingState label="正在加载控制面总览..." />;

  const cp = data?.control_plane || {};
  const nodes = data?.nodes || {};
  const clusters = data?.clusters || {};
  const backupAlerts = data?.backup_alerts;
  const certAlerts = data?.cert_alerts || [];
  const reconcileTasks = data?.pending_reconcile_tasks || [];
  const vaultAlerts = data?.vault_alerts || [];
  const clockAlerts = nodes.clock_skew_alerts || [];

  const cards = [
    {
      icon: <Server className="w-5 h-5" />,
      label: '托管主机',
      value: nodes.total ?? 0,
      sub: `在线 ${nodes.online ?? 0} · 离线 ${nodes.offline ?? 0}`,
      to: '/infra',
    },
    {
      icon: <Boxes className="w-5 h-5" />,
      label: '纳管集群',
      value: clusters.total ?? 0,
      sub: `Nomad ${clusters.nomad ?? 0} · Vault ${clusters.vault ?? 0}`,
      to: '/nomad',
    },
    {
      icon: <ShieldCheck className="w-5 h-5" />,
      label: '证书临期预警',
      value: certAlerts.length,
      sub: certAlerts.length > 0 ? '请尽快执行续期或轮换' : '所有集群证书有效期正常',
      to: '/vault',
    },
    {
      icon: <FileWarning className="w-5 h-5" />,
      label: '待核对异常任务',
      value: reconcileTasks.length,
      sub: reconcileTasks.length > 0 ? '需人工确认远端实际状态' : '所有编排任务状态一致',
      to: '/operations',
    },
  ];

  const hasClusters = (clusters.total ?? 0) > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="总览仪表盘"
        subtitle={
          <span>
            控制面版本 <code className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800">{cp.version || '-'}</code>
            {data?.cron_summary && (
              <>
                {' · '}定时巡检 {data.cron_summary.enabled}/{data.cron_summary.total} 启用
                {data.cron_summary.failed > 0 && (
                  <span className="ml-1 text-rose-600 dark:text-rose-400">
                    （{data.cron_summary.failed} 项上次失败）
                  </span>
                )}
              </>
            )}
          </span>
        }
        actions={
          <Button onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </Button>
        }
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {/* Top actionable alerts */}
      <div className="space-y-2.5">
        {cp.activated === false && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              控制面尚未激活（迁移导入后默认暂停自动调度与解封，以防双活冲突）。
            </span>
            <Link to="/migration-backup" className="font-medium text-amber-800 dark:text-amber-200 underline">
              前往激活
            </Link>
          </div>
        )}
        {cp.maintenance_barrier && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            当前存在全局维护屏障：{cp.maintenance_barrier}
          </div>
        )}
        {cp.update_available && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-200">
            <span>发现 NomadDeck 新版本 {cp.latest_version}</span>
            <Link to="/version" className="inline-flex items-center gap-1 font-medium underline">
              查看更新 <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        )}
        {backupAlerts?.missing_offsite_target && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <span>灾备告警：尚未配置已启用的异地备份目标（SFTP / S3 / SafeKeep）。</span>
            <Link to="/migration-backup" className="font-medium underline">
              配置灾备
            </Link>
          </div>
        )}
        {backupAlerts && backupAlerts.consecutive_failures > 0 && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-200">
            灾备告警：控制面灾备备份已连续失败 {backupAlerts.consecutive_failures} 次。
          </div>
        )}
      </div>

      {/* Hero + KPI cards */}
      <div className="space-y-4">
        <div className="rounded-2xl border border-indigo-100 dark:border-indigo-500/25 bg-gradient-to-r from-indigo-50 via-white to-white dark:from-indigo-950/60 dark:via-slate-900 dark:to-slate-900 p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex gap-4 items-center min-w-0">
            <div className="hidden sm:grid w-11 h-11 place-items-center rounded-2xl bg-white dark:bg-indigo-500/15 border border-indigo-100 dark:border-indigo-500/30 text-indigo-500 dark:text-indigo-300 shrink-0">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium text-indigo-500 dark:text-indigo-400 mb-1">集群控制面状态</div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                {hasClusters ? '集群运行态与生命周期受控' : '从纳管 Linux 主机与集群开始'}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                {hasClusters
                  ? '可直接进入 Nomad Job 中心编排工作负载，或巡检集群状态与 Raft 快照。'
                  : '先添加 Linux 主机并推送 SSH 公钥，随后即可一键初始化部署 Nomad 或 Vault 集群。'}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="primary-button shrink-0"
            onClick={() => navigate(hasClusters ? '/jobs' : '/infra')}
          >
            <span>{hasClusters ? '前往 Job 中心' : '纳管主机'}</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-1 min-[420px]:grid-cols-2 xl:grid-cols-4 gap-4">
          {cards.map((c) => (
            <Link
              key={c.label}
              to={c.to}
              className="group bg-white dark:bg-slate-900 rounded-2xl border border-[#e3e8f1] dark:border-slate-800 shadow-[0_3px_12px_rgba(15,23,42,0.03)] p-5 flex flex-col justify-between hover:border-indigo-300 dark:hover:border-indigo-500/40 transition"
            >
              <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                <span className="font-medium group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                  {c.label}
                </span>
                <span className="text-indigo-500 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-500/15 p-2 rounded-lg shrink-0">
                  {c.icon}
                </span>
              </div>
              <div className="mt-3">
                <div className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 tabular-nums">
                  {c.value}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{c.sub}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Clusters + Alerts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card
          title="集群状态"
          actions={
            <div className="flex items-center gap-3 text-xs">
              <Link to="/nomad" className="inline-flex items-center gap-0.5 text-indigo-600 hover:underline dark:text-indigo-400">
                Nomad <ArrowUpRight className="h-3 w-3" />
              </Link>
              <Link to="/vault" className="inline-flex items-center gap-0.5 text-indigo-600 hover:underline dark:text-indigo-400">
                Vault <ArrowUpRight className="h-3 w-3" />
              </Link>
            </div>
          }
        >
          {(clusters.items || []).length === 0 ? (
            <EmptyState
              icon={<Boxes className="w-6 h-6" />}
              title="暂无纳管集群"
              description="前往 Nomad 或 Vault 页面创建并部署第一个集群。"
              action={
                <Link to="/nomad" className="text-xs text-indigo-600 dark:text-indigo-400 font-medium inline-flex items-center gap-1">
                  创建集群 <ArrowRight className="w-3 h-3" />
                </Link>
              }
            />
          ) : (
            <div className="space-y-2.5">
              {clusters.items.map((c: any) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800"
                >
                  <div className="min-w-0">
                    <Link
                      to={c.type === 'vault' ? `/vault?id=${c.id}` : `/nomad?id=${c.id}`}
                      className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400 truncate"
                    >
                      {c.name}
                    </Link>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {c.type.toUpperCase()} · {c.mode} · {c.init_state}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {c.maintenance_mode && <Badge tone="amber">维护中</Badge>}
                    <StatusBadge value={c.health_status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card
          title="Vault、证书与时钟告警"
          actions={
            <div className="flex items-center gap-3 text-xs">
              <Link to="/infra" className="inline-flex items-center gap-0.5 text-indigo-600 hover:underline dark:text-indigo-400">
                主机 <ArrowUpRight className="h-3 w-3" />
              </Link>
              <Link to="/cron" className="inline-flex items-center gap-0.5 text-indigo-600 hover:underline dark:text-indigo-400">
                定时任务 <ArrowUpRight className="h-3 w-3" />
              </Link>
              <Link to="/migration-backup" className="inline-flex items-center gap-0.5 text-indigo-600 hover:underline dark:text-indigo-400">
                灾备 <ArrowUpRight className="h-3 w-3" />
              </Link>
            </div>
          }
        >
          {vaultAlerts.length === 0 && clockAlerts.length === 0 && certAlerts.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck className="w-6 h-6" />}
              title="一切运行正常"
              description="当前没有 Vault 密封告警、证书临期或主机时钟偏差问题。"
            />
          ) : (
            <div className="space-y-2.5 text-xs">
              {vaultAlerts.map((a: any, i: number) => (
                <Link
                  key={`v-${i}`}
                  to={a.cluster_id ? `/vault?id=${a.cluster_id}` : '/vault'}
                  className="flex items-center justify-between gap-2 rounded-xl border border-amber-200/70 bg-amber-50 px-3.5 py-2.5 text-amber-900 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/20"
                >
                  <span>
                    <b>{a.cluster_name}</b>：{a.message}
                  </span>
                  <Badge tone="amber">{a.kind}</Badge>
                </Link>
              ))}
              {clockAlerts.map((n: any) => (
                <Link
                  key={`c-${n.node_id}`}
                  to="/infra"
                  className="flex items-center justify-between gap-2 rounded-xl border border-rose-200/70 bg-rose-50 px-3.5 py-2.5 text-rose-900 hover:bg-rose-100 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/20"
                >
                  <span>
                    节点 <b>{n.node_name}</b> ({n.host}) 时钟同步异常：{n.time_sync}，偏差 {n.clock_skew_ms} ms
                  </span>
                  <Badge tone="red">时钟告警</Badge>
                </Link>
              ))}
              {certAlerts.map((ca: any, i: number) => {
                const targetCluster = (clusters.items || []).find((c: any) => c.id === ca.cluster_id);
                const certHref =
                  targetCluster?.type === 'nomad' ? `/nomad?id=${ca.cluster_id}` : `/vault?id=${ca.cluster_id || ''}`;
                return (
                  <Link
                    key={`ca-${i}`}
                    to={certHref}
                    className="flex items-center justify-between gap-2 rounded-xl border border-amber-200/70 bg-amber-50 px-3.5 py-2.5 text-amber-900 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/20"
                  >
                    <span>
                      <b>{ca.cluster_name}</b> {ca.node ? `/ ${ca.node}` : ''} {ca.kind} 证书剩余 {ca.days_left} 天
                    </span>
                    <Badge tone="amber">临期</Badge>
                  </Link>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Recent Operations + Audit */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card
          title="最近运维任务"
          actions={
            <Link to="/operations" className="inline-flex items-center gap-0.5 text-xs text-indigo-600 hover:underline dark:text-indigo-400">
              全部任务 <ArrowUpRight className="h-3 w-3" />
            </Link>
          }
        >
          {(data?.recent_operations || []).length === 0 ? (
            <EmptyState
              icon={<Clock className="w-6 h-6" />}
              title="暂无运维任务"
              description="集群部署、升级与自更新任务将在此展示。"
            />
          ) : (
            <div className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
              {data.recent_operations.map((t: any) => (
                <div key={t.id} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => openTask(t.id, `${t.action} (${t.id})`)}
                      className="font-mono font-medium text-indigo-600 hover:underline dark:text-indigo-400 truncate"
                    >
                      {t.action}
                    </button>
                    <div className="text-slate-500 dark:text-slate-400 mt-0.5">
                      {t.triggered_by} · {fmtTime(t.created_at)}
                    </div>
                  </div>
                  <StatusBadge value={t.status} />
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card
          title="最近审计动态"
          actions={
            <Link to="/audit" className="inline-flex items-center gap-0.5 text-xs text-indigo-600 hover:underline dark:text-indigo-400">
              全部日志 <ArrowUpRight className="h-3 w-3" />
            </Link>
          }
        >
          {(data?.recent_audit_logs || []).length === 0 ? (
            <EmptyState title="暂无审计日志" description="控制面操作与登录记录将自动写入审计日志。" />
          ) : (
            <div className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
              {data.recent_audit_logs.map((l: any) => (
                <div key={l.id} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-800 dark:text-slate-100">
                      <span className="font-mono">{l.action}</span> · {l.resource_name || l.resource_type}
                    </div>
                    <div className="text-slate-500 dark:text-slate-400 mt-0.5">
                      {l.actor_name || '-'} · {fmtTime(l.created_at)}
                    </div>
                  </div>
                  <StatusBadge value={l.result} />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
