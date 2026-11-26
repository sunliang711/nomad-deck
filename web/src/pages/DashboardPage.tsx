import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Clock,
  FileWarning,
  Info,
  RefreshCw,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { apiGet, fmtTime } from '../lib/api';
import { useOpsDrawer } from '../lib/opsDrawer';
import { Badge, Button, Card, EmptyState, ErrorAlert, LoadingState, PageHeader, StatusBadge } from '../components/UI';
import { GettingStarted } from '../components/GettingStarted';
import { RESOURCE_LABELS, formatActionLabel } from '../lib/actionLabels';

export function DashboardPage() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const { openTask, openTaskList } = useOpsDrawer();

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

  const clusterItems = (clusters.items || []) as any[];
  const hasHosts = (nodes.total ?? 0) > 0;
  const hasNomad = (clusters.nomad ?? 0) > 0;
  const hasVault = (clusters.vault ?? 0) > 0;
  const hasReadyNomad = clusterItems.some((c) => c.type === 'nomad' && c.init_state === 'initialized' && c.health_status === 'healthy');
  const hasReadyVault = clusterItems.some((c) => c.type === 'vault' && c.init_state === 'initialized' && c.health_status === 'healthy');

  const cards = [
    {
      icon: <Server className="w-4 h-4" />,
      label: '托管主机',
      value: nodes.total ?? 0,
      sub: `在线 ${nodes.online ?? 0} · 离线 ${nodes.offline ?? 0}`,
      tone: (nodes.offline ?? 0) > 0 ? 'amber' : (nodes.online ?? 0) > 0 ? 'green' : 'indigo',
      to: '/infra',
    },
    {
      icon: <Boxes className="w-4 h-4" />,
      label: '纳管集群',
      value: clusters.total ?? 0,
      sub: `Nomad ${clusters.nomad ?? 0} · Vault ${clusters.vault ?? 0}`,
      tone: (clusters.total ?? 0) > 0 ? 'indigo' : 'neutral',
      to: hasNomad ? '/nomad' : '/vault',
    },
    {
      icon: <ShieldCheck className="w-4 h-4" />,
      label: '证书临期预警',
      value: certAlerts.length,
      sub: certAlerts.length > 0 ? '请尽快执行续期或轮换' : (clusters.total ?? 0) > 0 ? '所有集群证书有效期正常' : '部署集群后自动监控',
      tone: certAlerts.length > 0 ? 'amber' : (clusters.total ?? 0) > 0 ? 'green' : 'neutral',
      to: hasVault ? '/vault' : '/nomad',
    },
    {
      icon: <FileWarning className="w-4 h-4" />,
      label: '待核对异常任务',
      value: reconcileTasks.length,
      sub: reconcileTasks.length > 0 ? '需人工确认远端实际状态' : '所有编排任务状态一致',
      tone: reconcileTasks.length > 0 ? 'red' : 'neutral',
      onClick: openTaskList,
    },
  ];

  const kpiIconTones: Record<string, string> = {
    green: 'text-emerald-600 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-500/15',
    amber: 'text-amber-600 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/15',
    red: 'text-rose-600 bg-rose-50 dark:text-rose-300 dark:bg-rose-500/15',
    indigo: 'text-indigo-600 bg-indigo-50 dark:text-indigo-300 dark:bg-indigo-500/15',
    neutral: 'text-slate-500 bg-slate-100 dark:text-slate-400 dark:bg-slate-800',
  };

  const hasAlertsOrTips =
    vaultAlerts.length > 0 ||
    clockAlerts.length > 0 ||
    certAlerts.length > 0 ||
    Boolean(backupAlerts?.missing_offsite_target && (clusters.total ?? 0) > 0);

  const recentOps = (data?.recent_operations || []).slice(0, 6);
  const recentAudit = (data?.recent_audit_logs || []).slice(0, 6);

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

      {/* Critical actionable alerts */}
      {(cp.activated === false || cp.maintenance_barrier || cp.update_available || (backupAlerts && backupAlerts.consecutive_failures > 0)) && (
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
          {backupAlerts && backupAlerts.consecutive_failures > 0 && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-200">
              灾备告警：控制面灾备备份已连续失败 {backupAlerts.consecutive_failures} 次。
            </div>
          )}
        </div>
      )}

      {/* Unified onboarding / ready banner */}
      <GettingStarted
        hasHosts={hasHosts}
        hasNomad={hasNomad}
        hasReadyNomad={hasReadyNomad}
        hasVault={hasVault}
        hasReadyVault={hasReadyVault}
      />

      {/* KPI cards */}
      <div className="grid grid-cols-1 min-[420px]:grid-cols-2 xl:grid-cols-4 gap-4">
        {cards.map((c: any) => {
          const cardClass =
            'group text-left bg-white dark:bg-[#0f172a]/95 rounded-2xl border border-[#e3e8f1] dark:border-slate-800/90 shadow-[0_2px_10px_rgba(15,23,42,0.03)] p-4 sm:p-5 flex flex-col justify-between hover:border-indigo-300 dark:hover:border-indigo-500/40 transition';
          const content = (
            <>
              <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                <span className="font-medium group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                  {c.label}
                </span>
                <span className={`p-2 rounded-xl shrink-0 ${kpiIconTones[c.tone] || kpiIconTones.indigo}`}>
                  {c.icon}
                </span>
              </div>
              <div className="mt-3">
                <div className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 tabular-nums">
                  {c.value}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{c.sub}</div>
              </div>
            </>
          );
          return c.onClick ? (
            <button key={c.label} type="button" onClick={c.onClick} className={cardClass}>
              {content}
            </button>
          ) : (
            <Link key={c.label} to={c.to} className={cardClass}>
              {content}
            </Link>
          );
        })}
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
          {clusterItems.length === 0 ? (
            <EmptyState
              icon={<Boxes className="w-6 h-6" />}
              title="暂无纳管集群"
              description="先接入 Linux 主机，再前往 Nomad 或 Vault 页面创建第一个集群。"
              action={
                <Link to={hasHosts ? '/nomad' : '/infra'} className="text-xs text-indigo-600 dark:text-indigo-400 font-medium inline-flex items-center gap-1">
                  {hasHosts ? '去创建 Nomad 集群' : '先去接入主机'} <ArrowRight className="w-3 h-3" />
                </Link>
              }
            />
          ) : (
            <div className="space-y-2.5">
              {clusterItems.map((c: any) => {
                const detailHref = c.type === 'vault' ? `/vault?id=${c.id}` : `/nomad?id=${c.id}`;
                return (
                  <div
                    key={c.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Link
                          to={detailHref}
                          className="text-sm font-semibold text-slate-900 hover:text-indigo-600 dark:text-slate-100 dark:hover:text-indigo-400 truncate"
                        >
                          {c.name}
                        </Link>
                        <Badge tone="blue">{c.type === 'vault' ? 'Vault' : 'Nomad'}</Badge>
                        <Badge>{c.mode === 'single' ? '单机' : '高可用'}</Badge>
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        {c.init_state === 'initialized' ? '已完成初始化' : '等待部署或初始化'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {c.maintenance_mode && <Badge tone="amber">维护中</Badge>}
                      <StatusBadge value={c.init_state === 'uninitialized' && c.health_status === 'unreachable' ? 'uninitialized' : c.health_status} />
                      <Link
                        to={c.type === 'nomad' && c.init_state === 'initialized' ? `/jobs?cluster_id=${encodeURIComponent(c.id)}` : detailHref}
                        className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400 inline-flex items-center gap-0.5 ml-1"
                      >
                        {c.type === 'nomad' && c.init_state === 'initialized' ? '运行 Job' : '管理'}
                        <ArrowUpRight className="h-3 w-3" />
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card
          title="健康巡检与待办建议"
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
          {!hasAlertsOrTips ? (
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
                const targetCluster = clusterItems.find((c: any) => c.id === ca.cluster_id);
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
              {backupAlerts?.missing_offsite_target && (clusters.total ?? 0) > 0 && (
                <Link
                  to="/cron"
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-slate-700 hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-200 dark:hover:border-indigo-500/40 transition"
                >
                  <span className="flex items-start gap-2 min-w-0 leading-5">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" />
                    <span>尚未配置 SafeKeep 异地灾备目标，生产环境建议在定时任务中开启定时灾备。</span>
                  </span>
                  <Badge tone="blue">建议配置</Badge>
                </Link>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* Recent Operations + Audit */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card
          title="最近运维任务"
          actions={
            <button
              type="button"
              onClick={openTaskList}
              className="inline-flex items-center gap-0.5 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
            >
              全部任务 <ArrowUpRight className="h-3 w-3" />
            </button>
          }
        >
          {recentOps.length === 0 ? (
            <EmptyState
              icon={<Clock className="w-6 h-6" />}
              title="暂无运维任务"
              description="集群部署、升级与自更新任务将在此展示。"
            />
          ) : (
            <div className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
              {recentOps.map((t: any) => (
                <div key={t.id} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => openTask(t.id, formatActionLabel(t.action))}
                      className="font-medium text-indigo-600 hover:underline dark:text-indigo-400 truncate"
                    >
                      {formatActionLabel(t.action)}
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
          {recentAudit.length === 0 ? (
            <EmptyState title="暂无审计日志" description="控制面操作与登录记录将自动写入审计日志。" />
          ) : (
            <div className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
              {recentAudit.map((l: any) => (
                <div key={l.id} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-800 dark:text-slate-100">
                      <span>{formatActionLabel(l.action)}</span>
                      <span className="mx-1.5 text-slate-400">·</span>
                      <span className="text-slate-500 dark:text-slate-400 font-normal">
                        {l.resource_name || RESOURCE_LABELS[l.resource_type] || l.resource_type}
                      </span>
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
