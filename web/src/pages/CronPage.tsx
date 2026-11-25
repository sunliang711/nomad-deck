import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Plus, RefreshCw, Shield, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { describeCron } from '../lib/cron';
import { useOpsDrawer } from '../lib/opsDrawer';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { Drawer } from '../components/Drawer';
import {
  Button,
  EmptyState,
  ErrorAlert,
  Input,
  LoadingState,
  Modal,
  PageHeader,
  PasswordConfirmModal,
  SecretInput,
  Select,
  StatusBadge,
  Switch,
  TermLabel,
} from '../components/UI';

const defaultSafeKeepTarget = {
  id: '',
  name: '',
  type: 'safekeep',
  enabled: true,
  retention_count: 14,
  snapshot_retention_count: 7,
  safekeep_url: '',
  safekeep_api_key: '',
  safekeep_api_key_set: false,
  safekeep_targets: '',
  safekeep_subpath: 'nomad-deck',
  safekeep_mode: 'sync',
  safekeep_insecure_tls: false,
};

const BASE_PRESETS = [
  { label: '每 2 分钟', value: '*/2 * * * *' },
  { label: '每 5 分钟', value: '*/5 * * * *' },
  { label: '每 15 分钟', value: '*/15 * * * *' },
  { label: '每小时整点', value: '0 * * * *' },
  { label: '每 6 小时整点', value: '0 */6 * * *' },
  { label: '每天凌晨 02:00', value: '0 2 * * *' },
  { label: '每天凌晨 03:00', value: '0 3 * * *' },
  { label: '每天凌晨 04:00', value: '0 4 * * *' },
  { label: '每周一 05:00', value: '0 5 * * 1' },
  { label: '每月 1 日 04:00', value: '0 4 1 * *' },
  { label: '自定义表达式', value: 'custom' },
];

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  cluster_health_check: '定时探测纳管主机在线状态、时钟偏差以及 Nomad / Vault 集群健康情况。',
  cert_expiry_check: '巡检集群 mTLS CA 与节点证书剩余有效期，触发仪表盘预警。',
  vault_token_renew: '自动续租 Vault 运维 Token，防止托管运维权限过期。',
  vault_auto_unseal_watch: '巡检已启用自动解封的 Vault 节点并在重启密封后自动解封。',
  raft_snapshot_backup: '定期采集 Nomad 与 Vault 集群 Raft 状态快照并按策略清理旧快照。',
  control_plane_backup: '将控制面数据库与集群快照打包加密，同步至配置的灾备目标。',
  self_update_check: '检查 GitHub Release 新版本并更新仪表盘新版本提示状态。',
  cleanup_audit_logs: '按系统设置保留天数清理过期的审计日志记录。',
  cleanup_operation_logs: '按系统设置保留天数清理过期的异步运维任务日志。',
};

function formatDuration(startedAt: string, finishedAt?: string): string {
  if (!finishedAt || finishedAt.startsWith('0001-01-01')) return '';
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

export function CronPage() {
  const { isAdmin } = useAuth();
  const { openTask } = useOpsDrawer();
  const toast = useToast();
  const askConfirm = useConfirm();

  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<any[]>([]);
  const [clusters, setClusters] = useState<any[]>([]);
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [backupCfg, setBackupCfg] = useState<any>(null);
  const [err, setErr] = useState('');
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  // Edit / Create Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [preset, setPreset] = useState('custom');
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [initialSnap, setInitialSnap] = useState('');
  const [form, setForm] = useState({
    name: '',
    cron_expr: '0 4 * * *',
    overlap_policy: 'skip_if_running',
    misfire_policy: 'skip',
    enabled: true,
    payload_type: 'cluster_snapshot',
    cluster_id: '',
    target_id: '',
    integration_id: '',
  });

  // Live schedule preview
  const [previewRuns, setPreviewRuns] = useState<string[]>([]);
  const [previewTimezone, setPreviewTimezone] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const previewSeq = useRef(0);

  // History Drawer
  const [runsJob, setRunsJob] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState('');

  // SafeKeep DR modal
  const [showDrModal, setShowDrModal] = useState(false);
  const [bkEnabled, setBkEnabled] = useState(false);
  const [bkPass, setBkPass] = useState('');
  const [drTargets, setDrTargets] = useState<any[]>([]);
  const [skForm, setSkForm] = useState<any>({ ...defaultSafeKeepTarget });
  const [skTest, setSkTest] = useState<any>(null);
  const [pwAction, setPwAction] = useState<{ title: string; run: (pw: string) => Promise<void> } | null>(null);

  const load = useCallback(async () => {
    setErr('');
    try {
      const reqs: Array<Promise<any>> = [
        apiGet('/api/v1/cron-jobs'),
        apiGet('/api/v1/clusters'),
        apiGet('/api/v1/integrations'),
      ];
      if (isAdmin) reqs.push(apiGet('/api/v1/backup/config'));
      const [cRes, clRes, intRes, bRes] = await Promise.all(reqs);
      setJobs(cRes.cron_jobs || []);
      setClusters(clRes.clusters || []);
      setIntegrations(intRes.integrations || []);
      if (bRes?.backup) {
        setBackupCfg(bRes.backup);
        setBkEnabled(Boolean(bRes.backup.enabled));
        setDrTargets(bRes.backup.targets || []);
      }
    } catch (ex: any) {
      setErr(ex?.message || '加载定时任务失败');
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const safekeepTargets = (backupCfg?.targets || []).filter((t: any) => t.type === 'safekeep');

  // Live preview of next 5 execution times whenever cron_expr changes inside Drawer
  useEffect(() => {
    if (!drawerOpen) return;
    const expr = form.cron_expr.trim();
    if (!expr) {
      setPreviewRuns([]);
      setPreviewError('Cron 表达式不能为空');
      return;
    }
    const seq = ++previewSeq.current;
    const timer = window.setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const res = await apiPost<{ next_runs: string[]; timezone?: string }>('/api/v1/cron-jobs/preview', {
          schedule: expr,
        });
        if (previewSeq.current !== seq) return;
        setPreviewRuns(res.next_runs || []);
        setPreviewTimezone(res.timezone || '');
        setPreviewError('');
      } catch (ex: any) {
        if (previewSeq.current !== seq) return;
        setPreviewRuns([]);
        setPreviewError(ex?.message || 'Cron 表达式无效');
      } finally {
        if (previewSeq.current === seq) setPreviewLoading(false);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [drawerOpen, form.cron_expr]);

  const openCreateDrawer = () => {
    const next = {
      name: '',
      cron_expr: '0 4 * * *',
      overlap_policy: 'skip_if_running',
      misfire_policy: 'skip',
      enabled: true,
      payload_type: 'cluster_snapshot',
      cluster_id: clusters[0]?.id || '',
      target_id: safekeepTargets[0]?.id || '',
      integration_id: integrations[0]?.id || '',
    };
    setCreating(true);
    setEditing(null);
    setForm(next);
    setPreset(BASE_PRESETS.find((p) => p.value === next.cron_expr)?.value || 'custom');
    setInitialSnap(JSON.stringify(next));
    setFormErr('');
    setPreviewError('');
    setDrawerOpen(true);
  };

  const openEditDrawer = (j: any) => {
    const next = {
      name: j.name,
      cron_expr: j.cron_expr,
      overlap_policy: j.overlap_policy,
      misfire_policy: j.misfire_policy,
      enabled: Boolean(j.enabled),
      payload_type: 'cluster_snapshot',
      cluster_id: '',
      target_id: '',
      integration_id: '',
    };
    setCreating(false);
    setEditing(j);
    setForm(next);
    setPreset(BASE_PRESETS.find((p) => p.value === j.cron_expr)?.value || 'custom');
    setInitialSnap(JSON.stringify(next));
    setFormErr('');
    setPreviewError('');
    setDrawerOpen(true);
  };

  const isDirty = useMemo(() => drawerOpen && JSON.stringify(form) !== initialSnap, [drawerOpen, form, initialSnap]);

  const closeDrawer = async () => {
    if (saving) return;
    if (
      isDirty &&
      !(await askConfirm('有未保存的定时任务配置，确认放弃修改吗？', {
        title: '放弃未保存更改',
        confirmText: '放弃更改',
      }))
    ) {
      return;
    }
    setDrawerOpen(false);
    setCreating(false);
    setEditing(null);
    setFormErr('');
  };

  const handleSave = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (saving || previewError) return;
    setFormErr('');
    setSaving(true);
    try {
      if (creating) {
        const payload: any = { type: form.payload_type };
        if (form.payload_type === 'safekeep_backup') {
          payload.target_id = form.target_id;
          if (form.cluster_id) payload.cluster_id = form.cluster_id;
        } else if (form.payload_type === 'static_jwks_sync') {
          payload.integration_id = form.integration_id;
        } else {
          payload.cluster_id = form.cluster_id;
        }
        await apiPost('/api/v1/cron-jobs', {
          name: form.name.trim(),
          cron_expr: form.cron_expr.trim(),
          overlap_policy: form.overlap_policy,
          misfire_policy: form.misfire_policy,
          enabled: form.enabled,
          payload,
        });
        toast.success('自定义定时任务已创建');
      } else if (editing) {
        await apiPut(`/api/v1/cron-jobs/${editing.id}`, {
          name: form.name.trim(),
          cron_expr: form.cron_expr.trim(),
          overlap_policy: form.overlap_policy,
          misfire_policy: form.misfire_policy,
          enabled: form.enabled,
        });
        toast.success('定时任务配置已保存');
      }
      setDrawerOpen(false);
      setCreating(false);
      setEditing(null);
      await load();
    } catch (ex: any) {
      setFormErr(ex?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const toggleJob = async (j: any, nextEnabled: boolean) => {
    if (togglingId) return;
    setTogglingId(j.id);
    try {
      await apiPut(`/api/v1/cron-jobs/${j.id}`, { enabled: nextEnabled });
      toast.success(`${j.name} 已${nextEnabled ? '启用' : '暂停'}`);
      await load();
    } catch (ex: any) {
      toast.error(ex?.message || '切换开关失败');
    } finally {
      setTogglingId(null);
    }
  };

  const loadRuns = async (job: any) => {
    setRunsError('');
    setRunsLoading(true);
    try {
      const res = await apiGet(`/api/v1/cron-jobs/${job.id}/runs?limit=30`);
      setRuns(res.runs || []);
    } catch (ex: any) {
      setRunsError(ex?.message || '加载执行历史失败');
    } finally {
      setRunsLoading(false);
    }
  };

  const openRuns = (job: any) => {
    setRunsJob(job);
    setRuns([]);
    void loadRuns(job);
  };

  const triggerJob = async (j: any) => {
    if (runningId) return;
    setRunningId(j.id);
    toast.info(`正在触发 ${j.name}...`);
    try {
      await apiPost(`/api/v1/cron-jobs/${j.id}/run`);
      toast.success(`已触发 ${j.name}`);
      await load();
      if (runsJob?.id === j.id) {
        await loadRuns(j);
      }
    } catch (ex: any) {
      toast.error(ex?.message || '触发失败');
    } finally {
      setRunningId(null);
    }
  };

  const deleteCustomJob = async (j: any) => {
    if (
      !(await askConfirm(`确定要删除自定义定时任务「${j.name}」吗？`, {
        title: '删除定时任务',
        confirmText: '确认删除',
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await apiDelete(`/api/v1/cron-jobs/${j.id}`);
      toast.success(`已删除定时任务 ${j.name}`);
      await load();
    } catch (ex: any) {
      toast.error(ex?.message || '删除失败');
    }
  };

  const openDrConfig = () => {
    setBkEnabled(Boolean(backupCfg?.enabled));
    setBkPass('');
    setDrTargets(backupCfg?.targets || []);
    const firstSK = (backupCfg?.targets || []).find((t: any) => t.type === 'safekeep');
    setSkForm(firstSK ? { ...defaultSafeKeepTarget, ...firstSK, safekeep_api_key: '' } : { ...defaultSafeKeepTarget });
    setSkTest(null);
    setShowDrModal(true);
  };

  const buildBackupTargetPayload = (t: any) => {
    const out: any = {
      id: t.id,
      name: t.name,
      type: t.type,
      enabled: Boolean(t.enabled),
      retention_count: Number(t.retention_count || 14),
      snapshot_retention_count: Number(t.snapshot_retention_count || 7),
      path: t.path,
      host: t.host,
      port: Number(t.port || 22),
      username: t.username,
      ssh_key_id: t.ssh_key_id,
      host_key_fingerprint: t.host_key_fingerprint,
      remote_dir: t.remote_dir,
      endpoint: t.endpoint,
      region: t.region,
      bucket: t.bucket,
      prefix: t.prefix,
      access_key_id: t.access_key_id,
      use_ssl: Boolean(t.use_ssl),
      path_style: Boolean(t.path_style),
      safekeep_url: t.safekeep_url || '',
      safekeep_targets: t.safekeep_targets || '',
      safekeep_subpath: t.safekeep_subpath || '',
      safekeep_mode: t.safekeep_mode || 'sync',
      safekeep_insecure_tls: Boolean(t.safekeep_insecure_tls),
    };
    if (t.type === 's3' && t.secret_access_key) out.secret_access_key = t.secret_access_key;
    if (t.type === 'safekeep' && t.safekeep_api_key) out.safekeep_api_key = t.safekeep_api_key;
    return out;
  };

  const applySafeKeepFormToList = () => {
    if (!skForm.safekeep_url?.trim()) return drTargets;
    const item = {
      ...skForm,
      id: skForm.id || 'tgt_' + Math.random().toString(36).slice(2, 10),
      name: skForm.name?.trim() || 'SafeKeep-DR',
      type: 'safekeep',
    };
    const idx = drTargets.findIndex((x) => x.id === item.id);
    if (idx >= 0) {
      const next = [...drTargets];
      next[idx] = item;
      return next;
    }
    return [...drTargets, item];
  };

  const testSafeKeepTarget = async () => {
    setErr('');
    setSkTest(null);
    try {
      const res = await apiPost('/api/v1/backup/targets/test', buildBackupTargetPayload({ ...skForm, type: 'safekeep' }));
      setSkTest(res.result);
    } catch (ex: any) {
      toast.error(ex?.message || 'SafeKeep 测试失败');
    }
  };

  const saveDrConfig = () => {
    const updatedTargets = applySafeKeepFormToList();
    setDrTargets(updatedTargets);
    setPwAction({
      title: '保存 SafeKeep 与灾备定时配置',
      run: async (pw) => {
        const payload: any = {
          current_password: pw,
          enabled: bkEnabled,
          include_history: backupCfg?.include_history || [],
          targets: updatedTargets.map(buildBackupTargetPayload),
        };
        if (bkPass) payload.passphrase = bkPass;
        await apiPut('/api/v1/backup/config', payload);
        setBkPass('');
        setShowDrModal(false);
        toast.success('SafeKeep 与灾备定时配置已保存');
        await load();
      },
    });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="定时任务"
        subtitle={
          <span>
            管理内置巡检、快照备份、SafeKeep 异地灾备与自定义调度任务 · 已配置 SafeKeep 目标{' '}
            <b className="text-slate-700 dark:text-slate-200">{safekeepTargets.length}</b> 个
            {isAdmin && (
              <>
                {' · '}
                <Link to="/migration-backup" className="text-indigo-600 hover:underline dark:text-indigo-400">
                  前往迁移与全量灾备页
                </Link>
              </>
            )}
          </span>
        }
        actions={
          <>
            <Button onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" />
              <span>刷新</span>
            </Button>
            {isAdmin && (
              <>
                <Button onClick={openDrConfig}>
                  <Shield className="h-4 w-4" />
                  <span>配置 SafeKeep / 灾备</span>
                </Button>
                <Button variant="primary" onClick={openCreateDrawer}>
                  <Plus className="h-4 w-4" />
                  <span>新建自定义任务</span>
                </Button>
              </>
            )}
          </>
        }
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-[#e3e8f1] dark:border-slate-800 shadow-[0_3px_12px_rgba(15,23,42,0.03)] overflow-x-auto">
        <table className="cron-table w-full text-sm">
          <thead className="bg-[#f8faff] dark:bg-slate-950/60 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-slate-800">
            <tr>
              <th className="text-left px-4 py-3">任务名称与说明</th>
              <th className="text-left px-4 py-3">调度周期</th>
              <th className="text-left px-4 py-3">
                <TermLabel
                  term="策略"
                  tip="防重入（Overlap）：上次未结束时的处理方式；漏执行（Misfire）：控制面停机错过触发时间后的补跑策略。"
                />
              </th>
              <th className="text-left px-4 py-3">下次执行</th>
              <th className="text-left px-4 py-3">上次执行</th>
              <th className="text-left px-4 py-3">启用</th>
              <th className="text-right px-4 py-3">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {loading && (
              <tr>
                <td colSpan={7}>
                  <LoadingState label="正在加载定时任务..." />
                </td>
              </tr>
            )}
            {!loading && jobs.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState title="暂无定时任务" description="系统启动后将自动初始化内置巡检与维护任务。" />
                </td>
              </tr>
            )}
            {!loading &&
              jobs.map((j) => {
                const scheduleText = describeCron(j.cron_expr);
                const nextTime = j.enabled && j.next_run_at && !j.next_run_at.startsWith('0001-01-01') ? j.next_run_at : '';
                const desc = BUILTIN_DESCRIPTIONS[j.job_key] || (j.is_builtin ? '系统内置调度任务' : '管理员自定义定时任务');
                const isRunning = runningId === j.id;
                return (
                  <tr key={j.id}>
                    <td className="px-4 py-3.5 align-top min-w-[240px] max-w-[340px]">
                      <div className="font-medium text-slate-900 dark:text-slate-100 flex items-center gap-2">
                        <span>{j.name}</span>
                        {!j.is_builtin && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                            自定义
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">{desc}</div>
                      <div className="font-mono text-[11px] text-slate-400 mt-0.5">{j.job_key || j.id}</div>
                    </td>
                    <td className="px-4 py-3.5 align-top min-w-[140px]">
                      {scheduleText && (
                        <div className="text-xs text-slate-700 dark:text-slate-300 mb-1">{scheduleText}</div>
                      )}
                      <code className="font-mono text-[11px] bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 px-1.5 py-0.5 rounded inline-block">
                        {j.cron_expr}
                      </code>
                    </td>
                    <td className="px-4 py-3.5 align-top text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      <div>{j.overlap_policy}</div>
                      <div className="text-[11px] text-slate-400">{j.misfire_policy}</div>
                    </td>
                    <td className="px-4 py-3.5 align-top text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
                      {nextTime ? fmtTime(nextTime) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3.5 align-top text-xs whitespace-nowrap">
                      {!j.last_status ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <div className="space-y-1">
                          <StatusBadge value={j.last_status} />
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">{fmtTime(j.last_run_at)}</div>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3.5 align-top">
                      <div className="pt-0.5">
                        <Switch
                          checked={Boolean(j.enabled)}
                          disabled={!isAdmin || togglingId === j.id}
                          label={`切换 ${j.name} 启用状态`}
                          onChange={(next) => void toggleJob(j, next)}
                        />
                      </div>
                    </td>
                    <td className="px-4 py-3.5 align-top text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        {isAdmin && (
                          <>
                            <button
                              type="button"
                              disabled={Boolean(runningId)}
                              onClick={() => void triggerJob(j)}
                              className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-45 inline-flex items-center gap-1"
                            >
                              {isRunning && <Loader2 className="w-3 h-3 animate-spin" />}
                              <span>{isRunning ? '执行中' : '立即执行'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditDrawer(j)}
                              className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
                            >
                              编辑
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => openRuns(j)}
                          className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
                        >
                          历史
                        </button>
                        {isAdmin && j.job_key === 'control_plane_backup' && (
                          <button
                            type="button"
                            onClick={openDrConfig}
                            className="px-2.5 py-1.5 text-xs rounded-lg border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/70 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-500/25"
                          >
                            灾备参数
                          </button>
                        )}
                        {isAdmin && !j.is_builtin && (
                          <button
                            type="button"
                            aria-label={`删除 ${j.name}`}
                            onClick={() => void deleteCustomJob(j)}
                            className="px-2 py-1.5 text-xs rounded-lg border border-rose-200 dark:border-rose-500/30 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/15"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {/* Edit / Create Drawer */}
      {drawerOpen && (
        <Drawer
          title={creating ? '新建自定义定时任务' : `编辑定时任务：${editing?.name}`}
          subtitle={
            creating
              ? '支持集群快照、SafeKeep 异地灾备、巡检、Job 导出与 JWKS 同步。'
              : BUILTIN_DESCRIPTIONS[editing?.job_key] || '调整任务触发周期、重入与漏执行策略。'
          }
          onClose={() => void closeDrawer()}
          busy={saving}
          width={creating ? 'lg' : 'md'}
          footer={
            <>
              <Button disabled={saving} onClick={() => void closeDrawer()}>
                取消
              </Button>
              <Button
                variant="primary"
                disabled={saving || Boolean(previewError) || (!creating && !isDirty)}
                onClick={() => void handleSave()}
              >
                {saving ? '保存中...' : '保存配置'}
              </Button>
            </>
          }
        >
          <form onSubmit={handleSave} className="space-y-4 text-sm">
            <ErrorAlert message={formErr} onClose={() => setFormErr('')} />

            <Input
              label="任务名称"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例如：每晚 Nomad 快照"
            />

            <div>
              <label htmlFor="cron-preset" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                执行周期预设
              </label>
              <select
                id="cron-preset"
                value={preset}
                onChange={(e) => {
                  const val = e.target.value;
                  setPreset(val);
                  if (val !== 'custom') setForm({ ...form, cron_expr: val });
                }}
                className="w-full px-3 py-2 text-xs border border-[#dce3ee] dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900"
              >
                {BASE_PRESETS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.value === 'custom' ? opt.label : `${opt.label}（${opt.value}）`}
                  </option>
                ))}
              </select>
            </div>

            {preset === 'custom' && (
              <div>
                <label htmlFor="cron-expr" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Cron 表达式（5 段：分 时 日 月 周）
                </label>
                <input
                  id="cron-expr"
                  required
                  value={form.cron_expr}
                  onChange={(e) => setForm({ ...form, cron_expr: e.target.value })}
                  className={`w-full px-3 py-2 text-xs border rounded-lg font-mono ${
                    previewError ? 'border-rose-400 focus:border-rose-500' : 'border-[#dce3ee] dark:border-slate-700'
                  }`}
                />
                {describeCron(form.cron_expr) && (
                  <p className="text-[11px] text-indigo-600 dark:text-indigo-400 mt-1">
                    含义：{describeCron(form.cron_expr)}
                  </p>
                )}
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  接下来 5 次执行时间{previewTimezone ? `（${previewTimezone}）` : ''}
                </span>
                {previewLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
              </div>
              {previewError ? (
                <div className="text-xs text-rose-600 dark:text-rose-400">{previewError}</div>
              ) : (
                <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700 px-3.5 py-2.5 space-y-1">
                  {previewRuns.length > 0 ? (
                    previewRuns.map((rawTime) => (
                      <div key={rawTime} className="text-xs font-mono text-slate-600 dark:text-slate-300">
                        {fmtTime(rawTime)}
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-slate-400">—</div>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Select
                label={<TermLabel term="防重入策略" tip="skip_if_running：前一次尚未跑完则跳过本次；queue_one：排入 1 个等待槽位。" />}
                value={form.overlap_policy}
                onChange={(e) => setForm({ ...form, overlap_policy: e.target.value })}
              >
                <option value="skip_if_running">skip_if_running</option>
                <option value="queue_one">queue_one</option>
              </Select>
              <Select
                label={<TermLabel term="漏执行策略" tip="控制面重启导致错过触发窗口时：skip 放弃补跑，run_once 立即补偿执行一次。" />}
                value={form.misfire_policy}
                onChange={(e) => setForm({ ...form, misfire_policy: e.target.value })}
              >
                <option value="skip">skip</option>
                <option value="run_once">run_once</option>
              </Select>
            </div>

            <div>
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">调度开关</span>
              <div className="flex items-center gap-2.5">
                <Switch checked={form.enabled} label="启用该定时任务" onChange={(next) => setForm({ ...form, enabled: next })} />
                <span className="text-xs text-slate-600 dark:text-slate-300">{form.enabled ? '已启用' : '已暂停'}</span>
              </div>
            </div>

            {creating && (
              <div className="space-y-3 border-t border-slate-200 dark:border-slate-800 pt-4">
                <Select
                  label="任务类型"
                  value={form.payload_type}
                  onChange={(e) => {
                    const pt = e.target.value;
                    setForm({
                      ...form,
                      payload_type: pt,
                      cluster_id: pt === 'safekeep_backup' ? '' : form.cluster_id || clusters[0]?.id || '',
                      target_id: pt === 'safekeep_backup' ? form.target_id || safekeepTargets[0]?.id || '' : '',
                    });
                  }}
                >
                  <option value="cluster_snapshot">cluster_snapshot（集群 Raft 快照）</option>
                  <option value="safekeep_backup">safekeep_backup（SafeKeep 定时灾备）</option>
                  <option value="doctor">doctor（集群体检）</option>
                  <option value="nomad_job_export">nomad_job_export（导出 Nomad Jobs）</option>
                  <option value="static_jwks_sync">static_jwks_sync（同步静态 JWKS）</option>
                </Select>

                {form.payload_type === 'safekeep_backup' ? (
                  <div className="space-y-3 rounded-xl border border-slate-200 dark:border-slate-700 p-3.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium">SafeKeep 目标配置</span>
                      <button
                        type="button"
                        onClick={openDrConfig}
                        className="text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        + 新增/管理 SafeKeep 目标
                      </button>
                    </div>
                    <Select
                      label="SafeKeep 目标"
                      required
                      value={form.target_id}
                      onChange={(e) => setForm({ ...form, target_id: e.target.value })}
                    >
                      <option value="">请选择 SafeKeep 目标...</option>
                      {safekeepTargets.map((t: any) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.safekeep_url}){t.enabled ? '' : ' [已停用]'}
                        </option>
                      ))}
                    </Select>
                    <Select
                      label="备份范围"
                      value={form.cluster_id}
                      onChange={(e) => setForm({ ...form, cluster_id: e.target.value })}
                    >
                      <option value="">控制面全量灾备 (.ndbundle)</option>
                      {clusters.map((c: any) => (
                        <option key={c.id} value={c.id}>
                          集群 Raft 快照：{c.name} ({c.type})
                        </option>
                      ))}
                    </Select>
                  </div>
                ) : form.payload_type === 'static_jwks_sync' ? (
                  <Select
                    label="关联联动"
                    required
                    value={form.integration_id}
                    onChange={(e) => setForm({ ...form, integration_id: e.target.value })}
                  >
                    <option value="">请选择 Nomad-Vault 联动...</option>
                    {integrations.map((i: any) => (
                      <option key={i.id} value={i.id}>{i.name}</option>
                    ))}
                  </Select>
                ) : clusters.length > 0 ? (
                  <Select
                    label="关联集群"
                    required
                    value={form.cluster_id}
                    onChange={(e) => setForm({ ...form, cluster_id: e.target.value })}
                  >
                    <option value="">请选择集群...</option>
                    {clusters.map((c: any) => (
                      <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    label="关联集群 ID"
                    required
                    value={form.cluster_id}
                    onChange={(e) => setForm({ ...form, cluster_id: e.target.value })}
                  />
                )}
              </div>
            )}
          </form>
        </Drawer>
      )}

      {/* History Drawer */}
      {runsJob && (
        <Drawer
          title={`执行历史：${runsJob.name}`}
          subtitle={BUILTIN_DESCRIPTIONS[runsJob.job_key] || runsJob.cron_expr}
          onClose={() => setRunsJob(null)}
          width="lg"
          headerExtra={
            <Button size="sm" onClick={() => void loadRuns(runsJob)} disabled={runsLoading}>
              <RefreshCw className={`w-3.5 h-3.5 ${runsLoading ? 'animate-spin' : ''}`} />
              <span>刷新</span>
            </Button>
          }
        >
          {runsLoading ? (
            <LoadingState label="正在加载执行历史..." />
          ) : runsError ? (
            <ErrorAlert message={runsError} />
          ) : runs.length === 0 ? (
            <EmptyState title="暂无执行记录" description="该任务尚未产生历史运行记录。" />
          ) : (
            <div className="space-y-3 text-xs">
              {runs.map((r) => {
                const dur = formatDuration(r.started_at, r.finished_at);
                return (
                  <div
                    key={r.id}
                    className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-2 bg-slate-50/60 dark:bg-slate-800/40"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <StatusBadge value={r.status} />
                        <span className="px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-mono text-[11px]">
                          {r.trigger_type}
                        </span>
                        {dur && <span className="font-mono text-slate-400">{dur}</span>}
                      </div>
                      <span className="text-slate-500 dark:text-slate-400">{fmtTime(r.started_at)}</span>
                    </div>
                    <div className="text-slate-700 dark:text-slate-200 leading-relaxed">{r.summary || '无摘要输出'}</div>
                    {r.operation_task_id && (
                      <div className="pt-1">
                        <Button size="sm" onClick={() => openTask(r.operation_task_id, `${runsJob.name} (${r.operation_task_id})`)}>
                          查看关联运维任务日志
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Drawer>
      )}

      <Modal open={showDrModal} title="SafeKeep 灾备目标与加密配置" onClose={() => setShowDrModal(false)} wide>
        <div className="space-y-4 text-xs">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 font-medium pt-2">
              <input type="checkbox" checked={bkEnabled} onChange={(e) => setBkEnabled(e.target.checked)} />
              <span>启用控制面定时灾备（control_plane_backup）</span>
            </label>
            <SecretInput
              label="灾备加密口令（至少 12 位）"
              value={bkPass}
              hasStoredValue={Boolean(backupCfg?.passphrase_set)}
              resetKey={showDrModal ? 'open' : 'closed'}
              onChangeValue={setBkPass}
              onRevealStored={async () => {
                const r = await apiPost('/api/v1/backup/secrets/reveal', { kind: 'passphrase' });
                return r.secret || '';
              }}
            />
          </div>

          {safekeepTargets.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {safekeepTargets.map((t: any) => (
                <Button
                  key={t.id}
                  size="sm"
                  variant={skForm.id === t.id ? 'primary' : 'secondary'}
                  onClick={() => setSkForm({ ...defaultSafeKeepTarget, ...t, safekeep_api_key: '' })}
                >
                  {t.name}
                </Button>
              ))}
              <Button size="sm" onClick={() => setSkForm({ ...defaultSafeKeepTarget })}>
                + 新建 SafeKeep 目标
              </Button>
            </div>
          )}

          <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                label="目标名称"
                placeholder="SafeKeep-DR"
                value={skForm.name}
                onChange={(e) => setSkForm({ ...skForm, name: e.target.value })}
              />
              <Input
                label="SafeKeep 服务地址"
                placeholder="https://safekeep.example.com:8080"
                value={skForm.safekeep_url}
                onChange={(e) => setSkForm({ ...skForm, safekeep_url: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <SecretInput
                label="SafeKeep X-API-Key"
                value={skForm.safekeep_api_key || ''}
                hasStoredValue={Boolean(skForm.safekeep_api_key_set)}
                resetKey={skForm.id || 'new'}
                onChangeValue={(v) => setSkForm({ ...skForm, safekeep_api_key: v })}
                onRevealStored={
                  skForm.id && skForm.safekeep_api_key_set
                    ? async () => {
                        const r = await apiPost('/api/v1/backup/secrets/reveal', {
                          kind: 'target_secret',
                          target_id: skForm.id,
                        });
                        return r.secret || '';
                      }
                    : undefined
                }
              />
              <Input
                label="远端子路径 (X-Backup-Path)"
                value={skForm.safekeep_subpath || ''}
                onChange={(e) => setSkForm({ ...skForm, safekeep_subpath: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Input
                label="上游目标 (X-Backup-Targets)"
                placeholder="留空按 SafeKeep 默认"
                value={skForm.safekeep_targets || ''}
                onChange={(e) => setSkForm({ ...skForm, safekeep_targets: e.target.value })}
              />
              <Select
                label="模式 (X-Backup-Mode)"
                value={skForm.safekeep_mode || 'sync'}
                onChange={(e) => setSkForm({ ...skForm, safekeep_mode: e.target.value })}
              >
                <option value="sync">sync</option>
                <option value="async">async</option>
              </Select>
              <label className="flex items-center gap-1.5 pt-5">
                <input
                  type="checkbox"
                  checked={Boolean(skForm.safekeep_insecure_tls)}
                  onChange={(e) => setSkForm({ ...skForm, safekeep_insecure_tls: e.target.checked })}
                />
                <span>跳过 TLS 校验</span>
              </label>
            </div>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={Boolean(skForm.enabled)}
                onChange={(e) => setSkForm({ ...skForm, enabled: e.target.checked })}
              />
              <span>启用该 SafeKeep 目标</span>
            </label>
            {skTest && (
              <div className="rounded-lg bg-slate-100 p-2.5 dark:bg-slate-950">
                测试结果：<b>{skTest.ok ? '连通正常' : '失败'}</b>（{skTest.latency_ms} ms）
                {skTest.error && <span className="ml-2 text-rose-600">{skTest.error}</span>}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setShowDrModal(false)}>取消</Button>
            <Button onClick={() => void testSafeKeepTarget()}>测试 SafeKeep 连通性</Button>
            <Button variant="primary" onClick={saveDrConfig}>保存配置</Button>
          </div>
        </div>
      </Modal>

      <PasswordConfirmModal
        open={Boolean(pwAction)}
        title={pwAction?.title || ''}
        onClose={() => setPwAction(null)}
        onConfirm={async (pw) => {
          if (pwAction) await pwAction.run(pw);
        }}
      />
    </div>
  );
}
