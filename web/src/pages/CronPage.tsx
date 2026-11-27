import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Play, Plus, RefreshCw, Shield, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { describeCron } from '../lib/cron';
import { useI18n } from '../lib/i18n';
import type { Locale } from '../lib/locale';
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

const PLAN_PRESETS: Record<string, string> = {
  every_minute: '* * * * *',
  every_5_minutes: '*/5 * * * *',
  every_10_minutes: '*/10 * * * *',
  hourly: '0 * * * *',
  daily: '0 0 * * *',
  weekly: '0 0 * * 1',
  monthly: '0 0 1 * *',
};

const SCHEDULE_OPTIONS = [
  { value: 'every_minute', label: '每分钟 (* * * * *)', labelEn: 'Every minute (* * * * *)' },
  { value: 'every_5_minutes', label: '每五分钟 (*/5 * * * *)', labelEn: 'Every 5 minutes (*/5 * * * *)' },
  { value: 'every_10_minutes', label: '每10分钟 (*/10 * * * *)', labelEn: 'Every 10 minutes (*/10 * * * *)' },
  { value: 'hourly', label: '每小时 (0 * * * *)', labelEn: 'Hourly (0 * * * *)' },
  { value: 'daily', label: '每天 (0点 · 0 0 * * *)', labelEn: 'Daily (00:00 · 0 0 * * *)' },
  { value: 'weekly', label: '每周 (周一0点 · 0 0 * * 1)', labelEn: 'Weekly (Mon 00:00 · 0 0 * * 1)' },
  { value: 'monthly', label: '每月 (1号0点 · 0 0 1 * *)', labelEn: 'Monthly (1st 00:00 · 0 0 1 * *)' },
  { value: 'cron', label: '自定义', labelEn: 'Custom' },
];

const RETENTION_CHIPS = [
  { label: '1 天', labelEn: '1 day', value: '24h' },
  { label: '7 天', labelEn: '7 days', value: '7d' },
  { label: '30 天', labelEn: '30 days', value: '30d' },
  { label: '90 天', labelEn: '90 days', value: '90d' },
  { label: '180 天', labelEn: '180 days', value: '180d' },
];

const COMMON_TIMEZONES = ['Asia/Singapore', 'Asia/Shanghai', 'UTC', 'America/New_York', 'Europe/London'];

const BUILTIN_DESCRIPTIONS: Record<string, { zh: string; en: string }> = {
  cluster_health_check: {
    zh: '定时探测纳管主机在线状态、时钟偏差以及 Nomad / Vault 集群健康情况。',
    en: 'Periodically probes managed host reachability, clock skew, and Nomad / Vault cluster health.',
  },
  cert_expiry_check: {
    zh: '巡检集群 mTLS CA 与节点证书剩余有效期，触发仪表盘预警。',
    en: 'Checks remaining validity of cluster mTLS CAs and node certificates and raises dashboard warnings.',
  },
  vault_token_renew: {
    zh: '自动续租 Vault 运维 Token，防止托管运维权限过期。',
    en: 'Automatically renews Vault management tokens to prevent expiration of managed permissions.',
  },
  vault_auto_unseal_watch: {
    zh: '巡检已启用自动解封的 Vault 节点并在重启密封后自动解封。',
    en: 'Watches auto-unseal Vault nodes and unseals them automatically if sealed after a restart.',
  },
  raft_snapshot_backup: {
    zh: '定期采集 Nomad 与 Vault 集群 Raft 状态快照并按策略清理旧快照。',
    en: 'Periodically captures Nomad & Vault Raft snapshots and prunes old snapshots according to retention policy.',
  },
  control_plane_backup: {
    zh: '将控制面数据库与集群快照打包加密，同步至 SafeKeep 灾备目标。',
    en: 'Packages and encrypts the control-plane database and cluster snapshots to SafeKeep DR targets.',
  },
  self_update_check: {
    zh: '检查 GitHub Release 新版本并更新仪表盘新版本提示状态。',
    en: 'Checks GitHub Releases for newer versions and updates the dashboard update notice.',
  },
  system_proxy_check: {
    zh: '定时通过已配置的系统代理探测 HashiCorp、Docker 与 GitHub 目标连通性及出口 IP。',
    en: 'Periodically probes HashiCorp, Docker, and GitHub connectivity and egress IP via the configured system proxy.',
  },
  cleanup_audit_logs: {
    zh: '按保留时长清理过期的审计日志记录。',
    en: 'Prunes expired audit log records based on retention duration.',
  },
  cleanup_operation_logs: {
    zh: '按保留时长清理过期的异步运维任务日志与定时执行历史。',
    en: 'Prunes expired async operation task logs and cron run history based on retention duration.',
  },
};

function formatScheduleTime(value: string, timezone?: string, locale: Locale = 'zh'): string {
  if (!value || value.startsWith('0001-01-01')) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
      timeZone: timezone || 'Asia/Singapore',
      dateStyle: 'medium',
      timeStyle: 'medium',
      hour12: false,
    }).format(d);
  } catch {
    return fmtTime(value, locale);
  }
}

function formatDurationMs(ms?: number, startedAt?: string, finishedAt?: string): string {
  if (typeof ms === 'number' && ms > 0) {
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m${s}s`;
  }
  if (!startedAt || !finishedAt || finishedAt.startsWith('0001-01-01')) return '';
  const diff = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(diff) || diff < 0) return '';
  return `${diff} ms`;
}

function resolveScheduleType(rawType?: string, expr?: string): string {
  const t = (rawType || '').trim();
  const c = (expr || '').trim();
  if (t && PLAN_PRESETS[t] && PLAN_PRESETS[t] === c) return t;
  const matched = Object.keys(PLAN_PRESETS).find((k) => PLAN_PRESETS[k] === c);
  return matched && t !== 'cron' ? matched : 'cron';
}

export function CronPage() {
  const { isAdmin } = useAuth();
  const { locale, isEn, tr } = useI18n();
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
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [initialSnap, setInitialSnap] = useState('');
  const [form, setForm] = useState({
    name: '',
    schedule_type: 'daily',
    cron_expr: PLAN_PRESETS.daily,
    timezone: 'Asia/Singapore',
    timeout_seconds: 600,
    overlap_policy: 'skip_if_running',
    misfire_policy: 'skip',
    enabled: true,
    retention: '',
    payload_type: 'cluster_snapshot',
    cluster_id: '',
    target_id: '',
    integration_id: '',
  });

  // Live schedule preview (5 occurrences)
  const [previewRuns, setPreviewRuns] = useState<string[]>([]);
  const [previewTimezone, setPreviewTimezone] = useState('');
  const [previewValid, setPreviewValid] = useState(false);
  const [previewStatus, setPreviewStatus] = useState('');
  const [previewError, setPreviewError] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewSeq = useRef(0);
  const previewTimer = useRef<number | null>(null);

  // Paginated History Drawer
  const [runsJob, setRunsJob] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [runsPage, setRunsPage] = useState(1);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsFailedOnly, setRunsFailedOnly] = useState(false);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState('');
  const runsSeq = useRef(0);
  const runsPageSize = 20;

  // SafeKeep DR modal
  const [showDrModal, setShowDrModal] = useState(false);
  const [bkPass, setBkPass] = useState('');
  const [bkPassTouched, setBkPassTouched] = useState(false);
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
        setDrTargets(bRes.backup.targets || []);
      }
    } catch (ex: any) {
      setErr(ex?.message || tr('加载定时任务失败', 'Failed to load cron jobs'));
    } finally {
      setLoading(false);
    }
  }, [isAdmin, tr]);

  useEffect(() => {
    void load();
  }, [load]);

  const safekeepTargets = (backupCfg?.targets || []).filter((t: any) => t.type === 'safekeep');

  const requestPreview = useCallback(
    (draft: { schedule_type: string; cron_expr: string; timezone: string }, immediate = false) => {
      if (previewTimer.current) {
        window.clearTimeout(previewTimer.current);
        previewTimer.current = null;
      }
      const seq = ++previewSeq.current;
      setPreviewValid(false);
      setPreviewRuns([]);
      setPreviewError(false);

      const expr = (PLAN_PRESETS[draft.schedule_type] || draft.cron_expr).trim();
      const tz = draft.timezone.trim();
      if (!expr) {
        setPreviewStatus(tr('请填写有效的五字段 Cron 表达式（分 时 日 月 周）。', 'Please enter a valid 5-field cron expression (min hour day month weekday).'));
        setPreviewError(true);
        setPreviewLoading(false);
        return;
      }
      if (!tz) {
        setPreviewStatus(tr('请填写有效的执行时区，例如 Asia/Singapore 或 UTC。', 'Please enter a valid timezone, e.g. Asia/Singapore or UTC.'));
        setPreviewError(true);
        setPreviewLoading(false);
        return;
      }

      setPreviewStatus(tr('正在计算执行时间…', 'Calculating next runs...'));
      setPreviewLoading(true);
      const run = async () => {
        try {
          const res = await apiPost<{ next_runs: string[]; timezone?: string }>('/api/v1/cron-jobs/preview', {
            schedule_type: draft.schedule_type,
            cron_expression: expr,
            timezone: tz,
          });
          if (previewSeq.current !== seq) return;
          const times = res.next_runs || [];
          if (times.length === 0) throw new Error(tr('无法计算未来 5 次执行时间。', 'Unable to calculate the next 5 execution times.'));
          setPreviewRuns(times);
          setPreviewTimezone(res.timezone || tz);
          setPreviewStatus(describeCron(expr, locale) || expr);
          setPreviewError(false);
          setPreviewValid(true);
        } catch (ex: any) {
          if (previewSeq.current !== seq) return;
          setPreviewRuns([]);
          setPreviewStatus(ex?.message || tr('Cron 表达式或时区无效', 'Invalid cron expression or timezone'));
          setPreviewError(true);
          setPreviewValid(false);
        } finally {
          if (previewSeq.current === seq) setPreviewLoading(false);
        }
      };

      if (immediate) {
        void run();
      } else {
        previewTimer.current = window.setTimeout(() => void run(), 250);
      }
    },
    [locale, tr],
  );

  useEffect(() => {
    return () => {
      if (previewTimer.current) window.clearTimeout(previewTimer.current);
    };
  }, []);

  const updateDraft = (patch: Partial<typeof form>, repreview = false) => {
    setForm((prev) => {
      const next = { ...prev, ...patch };
      if (patch.schedule_type && PLAN_PRESETS[patch.schedule_type]) {
        next.cron_expr = PLAN_PRESETS[patch.schedule_type];
      }
      if (repreview && drawerOpen) {
        requestPreview({
          schedule_type: next.schedule_type,
          cron_expr: next.cron_expr,
          timezone: next.timezone,
        });
      }
      return next;
    });
  };

  const openCreateDrawer = () => {
    const next = {
      name: '',
      schedule_type: 'daily',
      cron_expr: PLAN_PRESETS.daily,
      timezone: 'Asia/Singapore',
      timeout_seconds: 600,
      overlap_policy: 'skip_if_running',
      misfire_policy: 'skip',
      enabled: true,
      retention: '',
      payload_type: 'cluster_snapshot',
      cluster_id: clusters[0]?.id || '',
      target_id: safekeepTargets[0]?.id || '',
      integration_id: integrations[0]?.id || '',
    };
    setCreating(true);
    setEditing(null);
    setForm(next);
    setInitialSnap(JSON.stringify(next));
    setFormErr('');
    setDrawerOpen(true);
    requestPreview(next, true);
  };

  const openEditDrawer = (j: any) => {
    const st = resolveScheduleType(j.schedule_type, j.cron_expr);
    const tz = j.timezone || j.effective_timezone || 'Asia/Singapore';
    const next = {
      name: j.name || '',
      schedule_type: st,
      cron_expr: PLAN_PRESETS[st] || j.cron_expr || PLAN_PRESETS.daily,
      timezone: tz,
      timeout_seconds: Number(j.timeout_seconds || 600),
      overlap_policy: j.overlap_policy || 'skip_if_running',
      misfire_policy: j.misfire_policy || 'skip',
      enabled: Boolean(j.enabled),
      retention: j.config?.retention || '',
      payload_type: 'cluster_snapshot',
      cluster_id: '',
      target_id: '',
      integration_id: '',
    };
    setCreating(false);
    setEditing(j);
    setForm(next);
    setInitialSnap(JSON.stringify(next));
    setFormErr('');
    setDrawerOpen(true);
    requestPreview(next, true);
  };

  const isDirty = useMemo(() => drawerOpen && JSON.stringify(form) !== initialSnap, [drawerOpen, form, initialSnap]);

  const closeDrawer = async () => {
    if (saving) return;
    if (
      isDirty &&
      !(await askConfirm(tr('有未保存的定时任务配置，确认放弃修改吗？', 'There are unsaved cron job changes. Discard them?'), {
        title: tr('放弃未保存更改', 'Discard Unsaved Changes'),
        confirmText: tr('放弃更改', 'Discard'),
      }))
    ) {
      return;
    }
    if (previewTimer.current) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    previewSeq.current++;
    setDrawerOpen(false);
    setCreating(false);
    setEditing(null);
    setFormErr('');
  };

  const handleSave = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (saving || !previewValid) return;
    setFormErr('');
    setSaving(true);
    try {
      const expr = (PLAN_PRESETS[form.schedule_type] || form.cron_expr).trim();
      const timeoutSec = Number(form.timeout_seconds);
      if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 86400) {
        throw new Error(tr('超时时间需在 1 ~ 86400 秒之间', 'Timeout must be between 1 and 86400 seconds'));
      }
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
          schedule_type: form.schedule_type,
          cron_expr: expr,
          timezone: form.timezone.trim(),
          timeout_seconds: timeoutSec,
          overlap_policy: form.overlap_policy,
          misfire_policy: form.misfire_policy,
          enabled: form.enabled,
          payload,
        });
        toast.success(tr('自定义定时任务已创建', 'Custom cron job created'));
      } else if (editing) {
        const body: any = {
          schedule_type: form.schedule_type,
          cron_expr: expr,
          timezone: form.timezone.trim(),
          timeout_seconds: timeoutSec,
          overlap_policy: form.overlap_policy,
          misfire_policy: form.misfire_policy,
          enabled: form.enabled,
        };
        if (!editing.is_builtin) body.name = form.name.trim();
        if (editing.job_key === 'cleanup_audit_logs' || editing.job_key === 'cleanup_operation_logs') {
          body.config = form.retention.trim() ? { retention: form.retention.trim() } : {};
        }
        await apiPut(`/api/v1/cron-jobs/${editing.id}`, body);
        toast.success(tr('定时任务配置已保存', 'Cron job settings saved'));
      }
      setDrawerOpen(false);
      setCreating(false);
      setEditing(null);
      await load();
    } catch (ex: any) {
      setFormErr(ex?.message || tr('保存失败', 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  const toggleJob = async (j: any, nextEnabled: boolean) => {
    if (togglingId) return;
    setTogglingId(j.id);
    try {
      await apiPut(`/api/v1/cron-jobs/${j.id}`, { enabled: nextEnabled });
      toast.success(
        isEn
          ? `${j.name} ${nextEnabled ? 'enabled' : 'disabled'}`
          : `${j.name} 已${nextEnabled ? '启用' : '停用'}`,
      );
      await load();
    } catch (ex: any) {
      toast.error(ex?.message || tr('切换开关失败', 'Failed to toggle cron job'));
    } finally {
      setTogglingId(null);
    }
  };

  const loadRuns = useCallback(async (job: any, page = 1, failedOnly = false) => {
    const seq = ++runsSeq.current;
    setRunsError('');
    setRunsLoading(true);
    try {
      const qs = new URLSearchParams({
        page: String(page),
        page_size: String(runsPageSize),
        failed_only: failedOnly ? 'true' : 'false',
      });
      const res = await apiGet(`/api/v1/cron-jobs/${job.id}/runs?${qs.toString()}`);
      if (runsSeq.current !== seq) return;
      setRuns(res.items || res.runs || []);
      setRunsTotal(Number(res.total ?? (res.items || res.runs || []).length));
      setRunsPage(Number(res.page ?? page));
    } catch (ex: any) {
      if (runsSeq.current !== seq) return;
      setRunsError(ex?.message || tr('加载执行记录失败', 'Failed to load run history'));
    } finally {
      if (runsSeq.current === seq) setRunsLoading(false);
    }
  }, [tr]);

  const openRuns = (job: any) => {
    setRunsJob(job);
    setRuns([]);
    setRunsPage(1);
    setRunsTotal(0);
    setRunsFailedOnly(false);
    void loadRuns(job, 1, false);
  };

  const closeRuns = () => {
    runsSeq.current++;
    setRunsJob(null);
    setRuns([]);
  };

  const triggerJob = async (j: any) => {
    if (runningId) return;
    setRunningId(j.id);
    toast.info(tr(`正在触发 ${j.name}...`, `Triggering ${j.name}...`));
    try {
      await apiPost(`/api/v1/cron-jobs/${j.id}/run`);
      toast.success(tr(`已触发 ${j.name}`, `Triggered ${j.name}`));
      await load();
      if (runsJob?.id === j.id) {
        await loadRuns(j, runsPage, runsFailedOnly);
      }
    } catch (ex: any) {
      toast.error(ex?.message || tr('触发失败', 'Failed to trigger cron job'));
    } finally {
      setRunningId(null);
    }
  };

  const deleteCustomJob = async (j: any) => {
    if (
      !(await askConfirm(tr(`确定要删除自定义定时任务「${j.name}」吗？`, `Delete custom cron job "${j.name}"?`), {
        title: tr('删除定时任务', 'Delete Cron Job'),
        confirmText: tr('确认删除', 'Delete'),
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await apiDelete(`/api/v1/cron-jobs/${j.id}`);
      toast.success(tr(`已删除定时任务 ${j.name}`, `Deleted cron job ${j.name}`));
      await load();
    } catch (ex: any) {
      toast.error(ex?.message || tr('删除失败', 'Failed to delete cron job'));
    }
  };

  const openDrConfig = () => {
    setBkPass('');
    setBkPassTouched(false);
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
      type: 'safekeep',
      enabled: true,
      retention_count: Number(t.retention_count || 14),
      snapshot_retention_count: Number(t.snapshot_retention_count || 7),
      safekeep_url: t.safekeep_url || '',
      safekeep_targets: t.safekeep_targets || '',
      safekeep_subpath: t.safekeep_subpath || '',
      safekeep_mode: t.safekeep_mode || 'sync',
      safekeep_insecure_tls: Boolean(t.safekeep_insecure_tls),
    };
    if (t.safekeep_api_key) out.safekeep_api_key = t.safekeep_api_key;
    return out;
  };

  const applySafeKeepFormToList = () => {
    if (!skForm.safekeep_url?.trim()) return drTargets.filter((t) => t.type === 'safekeep');
    const item = {
      ...skForm,
      id: skForm.id || 'tgt_' + Math.random().toString(36).slice(2, 10),
      name: skForm.name?.trim() || 'SafeKeep-DR',
      type: 'safekeep',
      enabled: true,
    };
    const skOnly = drTargets.filter((t) => t.type === 'safekeep');
    const idx = skOnly.findIndex((x) => x.id === item.id);
    if (idx >= 0) {
      const next = [...skOnly];
      next[idx] = item;
      return next;
    }
    return [...skOnly, item];
  };

  const testSafeKeepTarget = async () => {
    setErr('');
    setSkTest(null);
    try {
      const res = await apiPost('/api/v1/backup/targets/test', buildBackupTargetPayload({ ...skForm, type: 'safekeep' }));
      setSkTest(res.result);
    } catch (ex: any) {
      toast.error(ex?.message || tr('SafeKeep 测试失败', 'SafeKeep connection test failed'));
    }
  };

  const saveDrConfig = () => {
    if (bkPassTouched && bkPass && bkPass.length < 6) {
      toast.error(tr('灾备加密口令至少 6 位（或留空不加密）', 'DR encryption passphrase must be at least 6 characters (or leave blank for unencrypted)'));
      return;
    }
    const updatedTargets = applySafeKeepFormToList();
    setDrTargets(updatedTargets);
    setPwAction({
      title: tr('保存 SafeKeep 与灾备定时配置', 'Save SafeKeep & DR Schedule Settings'),
      run: async (pw) => {
        const payload: any = {
          current_password: pw,
          enabled: updatedTargets.length > 0,
          include_history: backupCfg?.include_history || [],
          targets: updatedTargets.map(buildBackupTargetPayload),
        };
        if (bkPassTouched) payload.passphrase = bkPass;
        await apiPut('/api/v1/backup/config', payload);
        setBkPass('');
        setBkPassTouched(false);
        setShowDrModal(false);
        toast.success(tr('SafeKeep 与灾备定时配置已保存', 'SafeKeep & DR schedule settings saved'));
        await load();
      },
    });
  };

  const isCleanupEditing = editing?.job_key === 'cleanup_audit_logs' || editing?.job_key === 'cleanup_operation_logs';
  const isBackupEditing = editing?.job_key === 'control_plane_backup';
  const totalPages = Math.max(1, Math.ceil(runsTotal / runsPageSize));

  return (
    <div className="space-y-5">
      <PageHeader
        title={tr('定时任务', 'Cron Jobs')}
        subtitle={tr('管理内置与自定义定时任务的启用状态、执行计划与任务参数，支持立即手动触发并查看执行历史。', 'Manage enabled state, schedules, and parameters for built-in and custom cron jobs, with manual triggers and run history.')}
        actions={
          <>
            <Button onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" />
              <span>{tr('刷新', 'Refresh')}</span>
            </Button>
            {isAdmin && (
              <>
                <Button onClick={openDrConfig}>
                  <Shield className="h-4 w-4" />
                  <span>{tr('配置 SafeKeep', 'Configure SafeKeep')}</span>
                </Button>
                <Button variant="primary" onClick={openCreateDrawer}>
                  <Plus className="h-4 w-4" />
                  <span>{tr('新建自定义任务', 'New Custom Job')}</span>
                </Button>
              </>
            )}
          </>
        }
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-[#e3e8f1] dark:border-slate-800 shadow-[0_3px_12px_rgba(15,23,42,0.03)] overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-4 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{tr('任务计划', 'Schedules')}</h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">{tr('按计划自动运行，也可随时手动触发', 'Runs automatically on schedule, or trigger manually anytime')}</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] table-fixed text-sm">
            <thead className="bg-[#f8faff] dark:bg-slate-950/60 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-slate-800">
              <tr>
                <th className="text-left px-6 py-3 font-medium w-[29%]">{tr('任务', 'Job')}</th>
                <th className="text-left px-4 py-3 font-medium w-[16%]">{tr('计划', 'Schedule')}</th>
                <th className="text-left px-4 py-3 font-medium w-[17%]">{tr('下次执行', 'Next Run')}</th>
                <th className="text-left px-4 py-3 font-medium w-[18%]">{tr('最近一次', 'Last Run')}</th>
                <th className="text-left px-4 py-3 font-medium w-[72px]">{tr('启用', 'Enabled')}</th>
                <th className="text-right px-6 py-3 font-medium w-[220px]">{tr('操作', 'Actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {loading && (
                <tr>
                  <td colSpan={6}>
                    <LoadingState label={tr('正在加载定时任务...', 'Loading cron jobs...')} />
                  </td>
                </tr>
              )}
              {!loading && jobs.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <EmptyState title={tr('暂无定时任务', 'No Cron Jobs')} description={tr('系统启动后将自动初始化内置巡检与维护任务。', 'Built-in health check and maintenance jobs initialize automatically on startup.')} />
                  </td>
                </tr>
              )}
              {!loading &&
                jobs.map((j) => {
                  const tz = j.effective_timezone || j.timezone || 'UTC';
                  const scheduleText = describeCron(j.cron_expr, locale);
                  const nextTime = j.enabled && j.next_run_at && !j.next_run_at.startsWith('0001-01-01') ? j.next_run_at : '';
                  const builtinDesc = BUILTIN_DESCRIPTIONS[j.job_key];
                  const desc = (isEn ? builtinDesc?.en : builtinDesc?.zh) || j.description || (j.is_builtin ? tr('系统内置调度任务', 'Built-in scheduled task') : tr('管理员自定义定时任务', 'Custom scheduled task'));
                  const isRunning = runningId === j.id;
                  const lastSummary = j.last_summary || '—';
                  return (
                    <tr key={j.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
                      <td className="px-6 py-4 align-middle">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{j.name}</span>
                          {!j.is_builtin && (
                            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                              {tr('自定义', 'Custom')}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed line-clamp-2" title={desc}>
                          {desc}
                        </p>
                      </td>
                      <td className="px-4 py-4 align-middle">
                        {scheduleText && (
                          <div className="text-xs text-slate-700 dark:text-slate-200">{scheduleText}</div>
                        )}
                        <code className="mt-1 inline-block font-mono text-[11px] bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 px-1.5 py-0.5 rounded">
                          {j.cron_expr}
                        </code>
                        <div className="text-[11px] text-slate-400 mt-1 truncate">{tz}</div>
                      </td>
                      <td className="px-4 py-4 align-middle text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap tabular-nums">
                        {nextTime ? formatScheduleTime(nextTime, tz, locale) : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-4 py-4 align-middle text-xs min-w-0">
                        {!j.last_status ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          <div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <StatusBadge value={j.last_status} />
                              <span className="text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap tabular-nums">
                                {formatScheduleTime(j.last_run_at, tz, locale)}
                              </span>
                            </div>
                            <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-300 truncate" title={lastSummary}>
                              {lastSummary}
                            </p>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-4 align-middle">
                        <Switch
                          checked={Boolean(j.enabled)}
                          disabled={!isAdmin || togglingId === j.id}
                          label={`${j.name} · ${j.enabled ? tr('停用', 'Disable') : tr('启用', 'Enable')}`}
                          onChange={(next) => void toggleJob(j, next)}
                        />
                      </td>
                      <td className="px-6 py-4 align-middle text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          {isAdmin && (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={Boolean(runningId)}
                                onClick={() => void triggerJob(j)}
                              >
                                {isRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3 text-indigo-600 dark:text-indigo-400" />}
                                <span>{isRunning ? tr('执行中', 'Running') : tr('立即执行', 'Run Now')}</span>
                              </Button>
                              <Button size="sm" onClick={() => openEditDrawer(j)}>
                                {tr('编辑', 'Edit')}
                              </Button>
                            </>
                          )}
                          <Button size="sm" onClick={() => openRuns(j)}>
                            {tr('记录', 'History')}
                          </Button>
                          {isAdmin && !j.is_builtin && (
                            <Button
                              size="sm"
                              variant="danger-outline"
                              aria-label={tr(`删除 ${j.name}`, `Delete ${j.name}`)}
                              onClick={() => void deleteCustomJob(j)}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit / Create Drawer (460px width aligned with engram) */}
      {drawerOpen && (
        <Drawer
          title={creating ? tr('新建自定义定时任务', 'New Custom Cron Job') : editing?.name || tr('配置定时任务', 'Configure Cron Job')}
          subtitle={
            creating
              ? tr('支持集群快照、SafeKeep 异地灾备、巡检、Job 导出与 JWKS 同步。', 'Supports cluster snapshots, SafeKeep offsite DR, doctor checks, job export, and JWKS sync.')
              : (isEn ? BUILTIN_DESCRIPTIONS[editing?.job_key]?.en : BUILTIN_DESCRIPTIONS[editing?.job_key]?.zh) || editing?.description || tr('调整任务触发周期、执行时区、超时与运行策略。', 'Adjust schedule interval, timezone, timeout, and execution policies.')
          }
          onClose={() => void closeDrawer()}
          busy={saving}
          width="md"
          footer={
            <>
              <Button disabled={saving} onClick={() => void closeDrawer()}>
                {tr('取消', 'Cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={saving || !previewValid || (!creating && !isDirty)}
                onClick={() => void handleSave()}
              >
                {saving ? tr('保存中...', 'Saving...') : tr('保存配置', 'Save Settings')}
              </Button>
            </>
          }
        >
          <form onSubmit={handleSave} className="space-y-4 text-xs">
            <ErrorAlert message={formErr} onClose={() => setFormErr('')} />

            {(creating || !editing?.is_builtin) && (
              <Input
                label={tr('任务名称', 'Job Name')}
                required
                value={form.name}
                onChange={(e) => updateDraft({ name: e.target.value })}
                placeholder={tr('例如：每晚 Nomad 快照', 'e.g. Nightly Nomad Snapshot')}
              />
            )}

            <Select
              label={tr('计划', 'Schedule')}
              value={form.schedule_type}
              onChange={(e) => updateDraft({ schedule_type: e.target.value }, true)}
            >
              {SCHEDULE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {isEn ? opt.labelEn : opt.label}
                </option>
              ))}
            </Select>

            {form.schedule_type === 'cron' && (
              <div className="space-y-1.5">
                <label htmlFor="cron-expr" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  {tr('Cron 表达式（分 时 日 月 周）', 'Cron Expression (min hour day month weekday)')}
                </label>
                <input
                  id="cron-expr"
                  required
                  value={form.cron_expr}
                  placeholder={tr('例如 0 2 * * 1（每周一 02:00）', 'e.g. 0 2 * * 1 (Mondays at 02:00)')}
                  onChange={(e) => updateDraft({ cron_expr: e.target.value }, true)}
                  className={`w-full rounded-lg border px-3 py-2 text-xs font-mono bg-white dark:bg-slate-950 focus:outline-none ${
                    previewError
                      ? 'border-rose-400 focus:border-rose-500'
                      : 'border-[#dce3ee] dark:border-slate-700 focus:border-indigo-400'
                  }`}
                />
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {tr('支持五字段 Cron、列表、范围和步长；星期 0 表示周日。', 'Supports 5-field cron, lists, ranges, and steps; weekday 0 means Sunday.')}
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor="cron-timezone" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                {tr('执行时区', 'Timezone')}
              </label>
              <input
                id="cron-timezone"
                list="cron-timezone-presets"
                required
                value={form.timezone}
                onChange={(e) => updateDraft({ timezone: e.target.value }, true)}
                className="w-full rounded-lg border border-[#dce3ee] dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs focus:border-indigo-400 focus:outline-none"
              />
              <datalist id="cron-timezone-presets">
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </div>

            <div className="space-y-1.5" aria-live="polite" aria-atomic="true">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{tr('未来执行时间', 'Upcoming Runs')}</span>
                {previewLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
              </div>
              <p className={`text-[11px] ${previewError ? 'text-rose-600 dark:text-rose-400' : 'text-indigo-600 dark:text-indigo-400'}`}>
                {previewStatus || '—'}
              </p>
              {!previewError && (
                <ol className="list-decimal list-inside rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700 px-3.5 py-2.5 space-y-1">
                  {previewRuns.length > 0 ? (
                    previewRuns.map((rawTime) => (
                      <li key={rawTime} className="text-xs font-mono text-slate-600 dark:text-slate-300 tabular-nums">
                        {formatScheduleTime(rawTime, previewTimezone || form.timezone, locale)}
                      </li>
                    ))
                  ) : (
                    <li className="list-none text-xs text-slate-400">—</li>
                  )}
                </ol>
              )}
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{tr('预览未来 5 次执行时间，按所选时区显示。', 'Preview of the next 5 execution times in the selected timezone.')}</p>
            </div>

            <div className="grid grid-cols-2 gap-3.5 items-start">
              <Input
                label={tr('超时（秒）', 'Timeout (sec)')}
                type="number"
                min={1}
                max={86400}
                required
                hint={tr('范围 1 ~ 86400 秒。', 'Range: 1 to 86400 seconds.')}
                value={form.timeout_seconds}
                onChange={(e) => updateDraft({ timeout_seconds: Number(e.target.value) })}
              />
              <div className="space-y-1.5">
                <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">{tr('启用状态', 'Enabled')}</span>
                <label className="flex items-center gap-2 min-h-[38px] cursor-pointer text-slate-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => updateDraft({ enabled: e.target.checked })}
                  />
                  <span>{tr('启用此定时任务', 'Enable this cron job')}</span>
                </label>
              </div>
            </div>

            {isCleanupEditing && (
              <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
                <Input
                  label={editing.job_key === 'cleanup_audit_logs' ? tr('审计日志保留时长', 'Audit Log Retention') : tr('运维任务日志保留时长', 'Operation Log Retention')}
                  placeholder={tr('例如 30d、720h（留空沿用系统设置）', 'e.g. 30d, 720h (leave blank for system default)')}
                  hint={tr('支持时长格式如 24h、7d、30d（最小 1m）；留空则沿用系统设置中的保留天数。', 'Supports durations like 24h, 7d, 30d (min 1m); leave blank to inherit System Settings.')}
                  value={form.retention}
                  onChange={(e) => updateDraft({ retention: e.target.value })}
                />
                <div className="flex flex-wrap gap-1.5">
                  {RETENTION_CHIPS.map((chip) => (
                    <Button
                      key={chip.value}
                      size="sm"
                      variant={form.retention === chip.value ? 'primary' : 'secondary'}
                      onClick={() => updateDraft({ retention: chip.value })}
                    >
                      {isEn ? chip.labelEn : chip.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {isBackupEditing && (
              <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/40 p-4 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-[13px] text-slate-900 dark:text-slate-100">{tr('SafeKeep 上传配置', 'SafeKeep Upload Settings')}</strong>
                    <Button size="sm" onClick={openDrConfig}>
                      {tr('修改上传配置', 'Edit Upload Settings')}
                    </Button>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {tr('统一使用定时任务中的 SafeKeep 网关与加密口令配置。', 'Uses the unified SafeKeep gateway and encryption passphrase configured here.')}
                  </p>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
                    <dt className="text-slate-500">{tr('SafeKeep 目标', 'SafeKeep Target')}</dt>
                    <dd className="text-right break-all">
                      {safekeepTargets[0]?.safekeep_url || tr('未配置', 'Not configured')}
                      {safekeepTargets.length > 1 ? tr(`（共 ${safekeepTargets.length} 个）`, ` (${safekeepTargets.length} total)`) : ''}
                    </dd>
                    <dt className="text-slate-500">{tr('上传模式', 'Upload Mode')}</dt>
                    <dd className="text-right">
                      {safekeepTargets[0]?.safekeep_mode === 'async' ? tr('异步上传（async）', 'Async upload') : tr('同步上传（sync）', 'Sync upload')}
                    </dd>
                    <dt className="text-slate-500">{tr('备份加密', 'Encryption')}</dt>
                    <dd className="text-right">{backupCfg?.passphrase_set ? tr('已设置', 'Configured') : tr('未设置（不加密）', 'Not set (unencrypted)')}</dd>
                  </dl>
                </div>
              </div>
            )}

            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 gap-3">
              <Select
                label={<TermLabel term={tr('防重入策略', 'Overlap Policy')} tip={tr('skip_if_running：前一次尚未跑完则跳过本次；queue_one：排入 1 个等待槽位。', 'skip_if_running: skip if previous run is still active; queue_one: queue 1 pending run.')} />}
                value={form.overlap_policy}
                onChange={(e) => updateDraft({ overlap_policy: e.target.value })}
              >
                <option value="skip_if_running">{tr('运行中跳过 (skip_if_running)', 'Skip if running')}</option>
                <option value="queue_one">{tr('排队一次 (queue_one)', 'Queue one')}</option>
              </Select>
              <Select
                label={<TermLabel term={tr('漏执行策略', 'Misfire Policy')} tip={tr('控制面重启导致错过触发窗口时：skip 放弃补跑，run_once 立即补偿执行一次。', 'When a trigger window is missed during restart: skip ignores it, run_once catches up once.')} />}
                value={form.misfire_policy}
                onChange={(e) => updateDraft({ misfire_policy: e.target.value })}
              >
                <option value="skip">{tr('漏过不补 (skip)', 'Skip missed')}</option>
                <option value="run_once">{tr('补跑一次 (run_once)', 'Run once to catch up')}</option>
              </Select>
            </div>

            {creating && (
              <div className="space-y-3 border-t border-slate-200 dark:border-slate-800 pt-4">
                <Select
                  label={tr('任务类型', 'Job Type')}
                  value={form.payload_type}
                  onChange={(e) => {
                    const pt = e.target.value;
                    updateDraft({
                      payload_type: pt,
                      cluster_id: pt === 'safekeep_backup' ? '' : form.cluster_id || clusters[0]?.id || '',
                      target_id: pt === 'safekeep_backup' ? form.target_id || safekeepTargets[0]?.id || '' : '',
                    });
                  }}
                >
                  <option value="cluster_snapshot">{tr('cluster_snapshot（集群 Raft 快照）', 'cluster_snapshot (Cluster Raft Snapshot)')}</option>
                  <option value="safekeep_backup">{tr('safekeep_backup（SafeKeep 定时灾备）', 'safekeep_backup (SafeKeep Scheduled DR)')}</option>
                  <option value="doctor">{tr('doctor（集群体检）', 'doctor (Cluster Health Doctor)')}</option>
                  <option value="nomad_job_export">{tr('nomad_job_export（导出 Nomad Jobs）', 'nomad_job_export (Export Nomad Jobs)')}</option>
                  <option value="static_jwks_sync">{tr('static_jwks_sync（同步静态 JWKS）', 'static_jwks_sync (Sync Static JWKS)')}</option>
                </Select>

                {form.payload_type === 'safekeep_backup' ? (
                  <div className="space-y-3 rounded-xl border border-slate-200 dark:border-slate-700 p-3.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium">{tr('SafeKeep 目标配置', 'SafeKeep Target Config')}</span>
                      <button
                        type="button"
                        onClick={openDrConfig}
                        className="text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        {tr('+ 新增/管理 SafeKeep 目标', '+ Add/Manage Targets')}
                      </button>
                    </div>
                    <Select
                      label={tr('SafeKeep 目标', 'SafeKeep Target')}
                      required
                      value={form.target_id}
                      onChange={(e) => updateDraft({ target_id: e.target.value })}
                    >
                      <option value="">{tr('请选择 SafeKeep 目标...', 'Select SafeKeep target...')}</option>
                      {safekeepTargets.map((t: any) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.safekeep_url}){t.enabled ? '' : tr(' [已停用]', ' [Disabled]')}
                        </option>
                      ))}
                    </Select>
                    <Select
                      label={tr('备份范围', 'Backup Scope')}
                      value={form.cluster_id}
                      onChange={(e) => updateDraft({ cluster_id: e.target.value })}
                    >
                      <option value="">{tr('控制面全量灾备 (.ndbundle)', 'Full Control-Plane DR (.ndbundle)')}</option>
                      {clusters.map((c: any) => (
                        <option key={c.id} value={c.id}>
                          {tr('集群 Raft 快照：', 'Cluster Raft Snapshot: ')}{c.name} ({c.type})
                        </option>
                      ))}
                    </Select>
                  </div>
                ) : form.payload_type === 'static_jwks_sync' ? (
                  <Select
                    label={tr('关联联动', 'Integration')}
                    required
                    value={form.integration_id}
                    onChange={(e) => updateDraft({ integration_id: e.target.value })}
                  >
                    <option value="">{tr('请选择 Nomad-Vault 联动...', 'Select Nomad-Vault integration...')}</option>
                    {integrations.map((i: any) => (
                      <option key={i.id} value={i.id}>{i.name}</option>
                    ))}
                  </Select>
                ) : clusters.length > 0 ? (
                  <Select
                    label={tr('关联集群', 'Target Cluster')}
                    required
                    value={form.cluster_id}
                    onChange={(e) => updateDraft({ cluster_id: e.target.value })}
                  >
                    <option value="">{tr('请选择集群...', 'Select cluster...')}</option>
                    {clusters.map((c: any) => (
                      <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    label={tr('关联集群 ID', 'Cluster ID')}
                    required
                    value={form.cluster_id}
                    onChange={(e) => updateDraft({ cluster_id: e.target.value })}
                  />
                )}
              </div>
            )}
          </form>
        </Drawer>
      )}

      {/* Paginated History Drawer (aligned with engram scheduler-history-drawer) */}
      {runsJob && (
        <Drawer
          title={tr(`${runsJob.name} · 执行记录`, `${runsJob.name} · Run History`)}
          subtitle={(isEn ? BUILTIN_DESCRIPTIONS[runsJob.job_key]?.en : BUILTIN_DESCRIPTIONS[runsJob.job_key]?.zh) || runsJob.description || runsJob.cron_expr}
          onClose={closeRuns}
          width="xl"
          headerExtra={
            <div className="flex items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={runsFailedOnly}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setRunsFailedOnly(next);
                    setRunsPage(1);
                    void loadRuns(runsJob, 1, next);
                  }}
                />
                <span>{tr('仅看异常', 'Failures only')}</span>
              </label>
              <Button size="sm" onClick={() => void loadRuns(runsJob, runsPage, runsFailedOnly)} disabled={runsLoading}>
                <RefreshCw className={`w-3.5 h-3.5 ${runsLoading ? 'animate-spin' : ''}`} />
                <span>{tr('刷新', 'Refresh')}</span>
              </Button>
            </div>
          }
          footer={
            <div className="flex items-center justify-between gap-2 w-full text-xs">
              <span className="text-slate-500 dark:text-slate-400">
                {tr(`第 ${runsPage} / ${totalPages} 页 · 共 ${runsTotal} 条`, `Page ${runsPage} / ${totalPages} · ${runsTotal} total`)}
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  disabled={runsLoading || runsPage <= 1}
                  onClick={() => void loadRuns(runsJob, runsPage - 1, runsFailedOnly)}
                >
                  {tr('上一页', 'Prev')}
                </Button>
                <Button
                  size="sm"
                  disabled={runsLoading || runsPage >= totalPages}
                  onClick={() => void loadRuns(runsJob, runsPage + 1, runsFailedOnly)}
                >
                  {tr('下一页', 'Next')}
                </Button>
              </div>
            </div>
          }
        >
          {runsLoading ? (
            <LoadingState label={tr('正在加载执行记录…', 'Loading run history...')} />
          ) : runsError ? (
            <ErrorAlert message={runsError} />
          ) : runs.length === 0 ? (
            <EmptyState
              title={runsFailedOnly ? tr('没有异常执行记录', 'No Failed Runs') : tr('暂无执行记录', 'No Run History')}
              description={runsFailedOnly ? tr('当前筛选条件下没有失败或超时记录。', 'No failed or timed-out runs match this filter.') : tr('该任务尚未产生历史运行记录。', 'No executions recorded for this job yet.')}
            />
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
              {runs.map((r) => {
                const dur = formatDurationMs(r.duration_ms, r.started_at, r.finished_at);
                const tz = runsJob.effective_timezone || runsJob.timezone || 'UTC';
                return (
                  <article key={r.id} className="py-4 first:pt-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <StatusBadge value={r.status} />
                      <time className="text-slate-500 dark:text-slate-400 tabular-nums" dateTime={r.started_at}>
                        {formatScheduleTime(r.started_at, tz, locale)}
                      </time>
                      <span className="text-slate-400">
                        {r.trigger_type === 'manual' ? tr('手动触发', 'Manual') : tr('自动调度', 'Scheduled')}
                      </span>
                      {dur && <span className="font-mono text-slate-400 tabular-nums">{dur}</span>}
                    </div>
                    <p className="text-[13px] text-slate-700 dark:text-slate-200 leading-relaxed break-words">
                      {r.summary || '—'}
                    </p>
                    {r.detail_log && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-indigo-600 dark:text-indigo-400 hover:underline">{tr('详情', 'Details')}</summary>
                        <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg bg-slate-100 dark:bg-slate-950 p-2.5 font-mono text-[11px] text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-all">
                          {r.detail_log}
                        </pre>
                      </details>
                    )}
                    {r.operation_task_id && (
                      <div className="pt-1">
                        <Button size="sm" onClick={() => openTask(r.operation_task_id, `${runsJob.name} (${r.operation_task_id})`)}>
                          {tr('查看关联运维任务日志', 'View Linked Task Logs')}
                        </Button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </Drawer>
      )}

      <Modal open={showDrModal} title={tr('SafeKeep 灾备目标与加密配置', 'SafeKeep DR Targets & Encryption')} onClose={() => setShowDrModal(false)} wide>
        <div className="space-y-4 text-xs">
          <div className="flex items-center justify-between gap-2 text-slate-500 dark:text-slate-400">
            <span>{tr('配置控制面与 Raft 快照异地灾备的 SafeKeep 网关（是否定时执行由对应定时任务开关控制）。', 'Configure SafeKeep gateways for offsite DR of control-plane and Raft snapshots (scheduled runs are controlled by the cron job toggle).')}</span>
            <Link to="/migration-backup" className="text-indigo-600 hover:underline dark:text-indigo-400 shrink-0">
              {tr('前往环境迁移页', 'Open Migration & Backup')}
            </Link>
          </div>
          <SecretInput
            label={tr('灾备加密口令（可选，填写则至少 6 位）', 'DR Encryption Passphrase (optional, min 6 chars)')}
            value={bkPass}
            hasStoredValue={Boolean(backupCfg?.passphrase_set)}
            resetKey={showDrModal ? 'open' : 'closed'}
            onChangeValue={(v) => {
              setBkPass(v);
              setBkPassTouched(true);
            }}
            onRevealStored={async () => {
              const r = await apiPost('/api/v1/backup/secrets/reveal', { kind: 'passphrase' });
              return r.secret || '';
            }}
          />

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
                {tr('+ 新建 SafeKeep 目标', '+ New SafeKeep Target')}
              </Button>
            </div>
          )}

          <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                label={tr('目标名称', 'Target Name')}
                placeholder="SafeKeep-DR"
                value={skForm.name}
                onChange={(e) => setSkForm({ ...skForm, name: e.target.value })}
              />
              <Input
                label={tr('SafeKeep 服务地址', 'SafeKeep Endpoint URL')}
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
                label={tr('远端子路径 (X-Backup-Path)', 'Remote Subpath (X-Backup-Path)')}
                value={skForm.safekeep_subpath || ''}
                onChange={(e) => setSkForm({ ...skForm, safekeep_subpath: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Input
                label={tr('上游目标 (X-Backup-Targets)', 'Upstream Targets (X-Backup-Targets)')}
                placeholder={tr('留空按 SafeKeep 默认', 'Leave blank for SafeKeep default')}
                value={skForm.safekeep_targets || ''}
                onChange={(e) => setSkForm({ ...skForm, safekeep_targets: e.target.value })}
              />
              <Select
                label={tr('模式 (X-Backup-Mode)', 'Mode (X-Backup-Mode)')}
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
                <span>{tr('跳过 TLS 校验', 'Skip TLS verify')}</span>
              </label>
            </div>
            {skTest && (
              <div className="rounded-lg bg-slate-100 p-2.5 dark:bg-slate-950">
                {tr('测试结果：', 'Test Result: ')}<b>{skTest.ok ? tr('连通正常', 'Reachable') : tr('失败', 'Failed')}</b>（{skTest.latency_ms} ms）
                {skTest.error && <span className="ml-2 text-rose-600">{skTest.error}</span>}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => setShowDrModal(false)}>{tr('取消', 'Cancel')}</Button>
            <Button type="button" onClick={() => void testSafeKeepTarget()}>{tr('测试 SafeKeep 连通性', 'Test Connection')}</Button>
            <Button type="button" variant="primary" onClick={saveDrConfig}>{tr('保存配置', 'Save')}</Button>
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
