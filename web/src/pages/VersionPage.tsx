import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { api, apiDelete, apiGet, apiPost, apiPut, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOpsDrawer } from '../lib/opsDrawer';
import {
  formatDurationZh,
  upgradeStage,
  VersionCheckTimeoutError,
  waitForVersion,
  type UpgradeStage,
} from '../lib/selfUpdate';
import { useTaskProgress } from '../lib/useTaskProgress';
import { useConfirm } from '../components/ConfirmDialog';
import { ScheduleModal } from '../components/ScheduleModal';
import { useToast } from '../components/Toast';
import { UpgradeProgress } from '../components/UpgradeProgress';
import { Badge, Button, Card, ErrorAlert, Modal, PageHeader, StatusBadge } from '../components/UI';

type UpdatePhase =
  | 'idle'
  | 'submitting'
  | 'unknown'
  | 'updating'
  | 'restarting'
  | 'verifying'
  | 'complete'
  | 'failed'
  | 'timeout';

const hasTime = (value?: string | null) => Boolean(value && !value.startsWith('0001'));

export function VersionPage() {
  const { isAdmin } = useAuth();
  const { openTask, openTaskList } = useOpsDrawer();
  const toast = useToast();
  const askConfirm = useConfirm();

  const [info, setInfo] = useState<any>(null);
  const [useProxy, setUseProxy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // 预约升级状态
  const [schedule, setSchedule] = useState<any>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState('');
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleUnreachable, setScheduleUnreachable] = useState(false);

  // 立即更新 / 回退模态窗状态
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('idle');
  const [updateError, setUpdateError] = useState('');
  const [updateTarget, setUpdateTarget] = useState('');
  const [updateTaskId, setUpdateTaskId] = useState('');
  const [lastStage, setLastStage] = useState<UpgradeStage>('resolve');

  const submitCtrlRef = useRef<AbortController | null>(null);
  const probeCtrlRef = useRef<AbortController | null>(null);
  const reloadTimerRef = useRef<number | undefined>(undefined);
  const scheduleReloadTimerRef = useRef<number | undefined>(undefined);
  const prevScheduleActiveRef = useRef(false);
  const scheduleStatusRef = useRef('');
  scheduleStatusRef.current = schedule?.status || '';

  const scheduleActive = schedule?.status === 'waiting' || schedule?.status === 'upgrading';
  const scheduleFinished = Boolean(schedule && !scheduleActive && schedule.status !== 'idle');

  const clearUpgradeSchedule = useCallback(async () => {
    try {
      const r = await apiDelete('/api/v1/system/self-update/schedule');
      if (r?.schedule) setSchedule(r.schedule);
    } catch {
      // 清除已结束预约失败时不阻断后续检查操作。
    }
  }, []);

  const checkUpdate = useCallback(
    async (proxyOverride?: boolean, clearFinished = false) => {
      setChecking(true);
      setCheckError('');
      if (clearFinished && isAdmin) {
        await clearUpgradeSchedule();
      }
      try {
        const q = new URLSearchParams({ refresh: 'true' });
        if (proxyOverride !== undefined) q.set('use_proxy', String(proxyOverride));
        const res = await apiGet(`/api/v1/system/version?${q.toString()}`);
        setInfo(res.system);
        setCheckedAt(new Date());
      } catch (ex: any) {
        setCheckedAt(new Date());
        setCheckError(ex?.message || '检查新版本失败');
      } finally {
        setChecking(false);
      }
    },
    [clearUpgradeSchedule, isAdmin],
  );

  const loadSchedule = useCallback(async () => {
    try {
      const res = await apiGet('/api/v1/system/self-update/schedule');
      setScheduleUnreachable(false);
      const next = res.schedule;
      const wasActive = prevScheduleActiveRef.current;
      prevScheduleActiveRef.current = next?.status === 'waiting' || next?.status === 'upgrading';
      setSchedule(next);
      if (wasActive && next?.status === 'completed' && scheduleReloadTimerRef.current === undefined) {
        scheduleReloadTimerRef.current = window.setTimeout(() => window.location.reload(), 1200);
      }
      return next;
    } catch {
      setScheduleUnreachable(scheduleStatusRef.current === 'upgrading');
      return undefined;
    }
  }, []);

  // 页面加载：读取系统信息、代理偏好和预约状态；若当前无进行中的预约，自动检查一次新版本。
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const [vRes, sRes, setRes] = await Promise.all([
          apiGet('/api/v1/system/version'),
          apiGet('/api/v1/system/self-update/schedule'),
          apiGet('/api/v1/settings').catch(() => ({ settings: {} })),
        ]);
        if (!mounted) return;
        setInfo(vRes.system);
        if (vRes.system?.latest?.checked_at) {
          const parsed = new Date(vRes.system.latest.checked_at);
          if (!Number.isNaN(parsed.getTime())) setCheckedAt(parsed);
        }
        const sc = sRes.schedule;
        setSchedule(sc);
        const activeNow = sc?.status === 'waiting' || sc?.status === 'upgrading';
        prevScheduleActiveRef.current = activeNow;
        setUseProxy(Boolean(setRes?.settings?.['proxy.use_for_self_update']));
        if (!activeNow) {
          void checkUpdate();
        }
      } catch (ex: any) {
        if (mounted) setCheckError(ex?.message || '获取版本信息失败');
      }
    })();

    return () => {
      mounted = false;
    };
    // 仅在挂载时初始化加载一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 预约等待/升级期间每秒推进倒计时，每 5 秒同步后台预约状态。
  useEffect(() => {
    if (!scheduleActive) return;
    const tick = window.setInterval(() => setNowMs(Date.now()), 1000);
    const poll = window.setInterval(() => {
      void loadSchedule();
    }, 5000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [loadSchedule, scheduleActive]);

  useEffect(
    () => () => {
      submitCtrlRef.current?.abort();
      submitCtrlRef.current = null;
      probeCtrlRef.current?.abort();
      probeCtrlRef.current = null;
      if (reloadTimerRef.current !== undefined) window.clearTimeout(reloadTimerRef.current);
      if (scheduleReloadTimerRef.current !== undefined) window.clearTimeout(scheduleReloadTimerRef.current);
    },
    [],
  );

  const stopUpdateMonitor = useCallback(() => {
    probeCtrlRef.current?.abort();
    probeCtrlRef.current = null;
  }, []);

  const startUpdateMonitor = useCallback(
    (targetVersion: string) => {
      stopUpdateMonitor();
      const ctrl = new AbortController();
      probeCtrlRef.current = ctrl;
      void waitForVersion({
        targetVersion,
        signal: ctrl.signal,
        probe: async (signal) => {
          const resp = await fetch('/api/v1/system/version', { credentials: 'same-origin', signal });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const json = await resp.json();
          const cur = json?.system?.current_version;
          if (!cur) throw new Error('system version unavailable');
          return cur;
        },
        onReachable: () => {
          setUpdatePhase((prev) => (prev === 'restarting' ? 'verifying' : prev));
        },
        onUnavailable: () => {
          setUpdatePhase((prev) => (prev !== 'complete' ? 'restarting' : prev));
        },
      })
        .then(() => {
          if (probeCtrlRef.current !== ctrl) return;
          probeCtrlRef.current = null;
          setUpdatePhase('complete');
          reloadTimerRef.current = window.setTimeout(() => window.location.reload(), 1200);
        })
        .catch((cause) => {
          if (ctrl.signal.aborted || probeCtrlRef.current !== ctrl) return;
          probeCtrlRef.current = null;
          if (cause instanceof VersionCheckTimeoutError) {
            setUpdateError(`等待 ${targetVersion} 启动超时，请检查服务状态后手动刷新页面`);
            setUpdatePhase('timeout');
          } else {
            setUpdateError('检查更新结果失败，请手动刷新页面');
            setUpdatePhase('failed');
          }
        });
    },
    [stopUpdateMonitor],
  );

  // 立即更新模态窗的任务进度订阅
  const updateTask = useTaskProgress(updateTaskId || null, {
    onRestartStage: () => {
      if (!updateTarget) return;
      setUpdatePhase('restarting');
      startUpdateMonitor(updateTarget);
    },
    onDone: (status, errMsg) => {
      if (updatePhase === 'complete') return;
      if (status && status !== 'success' && status !== 'succeeded') {
        stopUpdateMonitor();
        setUpdateError(errMsg || '更新任务失败，请查看任务日志');
        setUpdatePhase('failed');
      } else if (updateTarget) {
        setUpdatePhase('restarting');
        startUpdateMonitor(updateTarget);
      }
    },
    onError: (stageWhenClosed) => {
      if ((stageWhenClosed === 'restart' || stageWhenClosed === 'install') && updateTarget) {
        setUpdatePhase('restarting');
        startUpdateMonitor(updateTarget);
      }
    },
  });

  // 预约升级自动进入 upgrading 时的内联进度订阅
  const scheduleTaskId = schedule?.status === 'upgrading' ? schedule.task_id || null : null;
  const scheduleTask = useTaskProgress(scheduleTaskId, {
    onDone: () => {
      void loadSchedule();
    },
  });

  const liveStage: UpgradeStage = useMemo(() => {
    switch (updatePhase) {
      case 'updating':
        return upgradeStage(updateTask.progress?.stage) ?? 'resolve';
      case 'restarting':
        return 'restart';
      case 'verifying':
        return 'confirm';
      case 'complete':
        return 'done';
      case 'timeout':
        return 'confirm';
      default:
        return 'resolve';
    }
  }, [updatePhase, updateTask.progress?.stage]);

  useEffect(() => {
    if (updatePhase !== 'failed') setLastStage(liveStage);
  }, [liveStage, updatePhase]);

  const effectiveStage = updatePhase === 'failed' ? lastStage : liveStage;
  const updateBusy = !['idle', 'failed', 'timeout'].includes(updatePhase);
  const updateModalVisible = updatePhase !== 'idle';
  const updateModalClosable = ['failed', 'timeout', 'unknown'].includes(updatePhase);
  const updateModalTitle = {
    idle: '',
    submitting: `更新到 ${updateTarget}`,
    unknown: '更新状态待确认',
    updating: `更新到 ${updateTarget}`,
    restarting: `更新到 ${updateTarget}`,
    verifying: `更新到 ${updateTarget}`,
    complete: '更新完成',
    failed: '更新失败',
    timeout: '确认更新超时',
  }[updatePhase];

  const handleToggleProxy = async (next: boolean) => {
    setUseProxy(next);
    if (!isAdmin) return;
    try {
      await apiPut('/api/v1/settings', { 'proxy.use_for_self_update': next });
      toast.success(next ? '已保存：版本检查与自更新走系统代理' : '已保存：版本检查与自更新直连');
    } catch (ex: any) {
      toast.error(ex?.message || '保存代理设置失败');
    }
  };

  const runImmediateUpdate = async () => {
    const latestVer = info?.latest?.version;
    if (!info?.update_available || !latestVer || updateBusy) return;
    if (scheduleActive) {
      setCheckError('请先取消正在进行的预约升级');
      return;
    }
    if (!info.available) {
      setCheckError(info.unavailable_reason || '当前环境不支持原地自更新');
      return;
    }
    const ok = await askConfirm(
      `下载并校验 ${latestVer} 后将自动备份数据库、替换程序并重启控制面，页面会短暂断开，托管中的 Nomad / Vault 集群不受影响。继续？`,
      { title: `更新到 ${latestVer}`, confirmText: '立即更新' },
    );
    if (!ok) return;

    setCheckError('');
    setUpdateError('');
    setUpdateTarget(latestVer);
    setUpdateTaskId('');
    setLastStage('resolve');
    setUpdatePhase('submitting');

    const ctrl = new AbortController();
    submitCtrlRef.current = ctrl;
    try {
      const res = await api('/api/v1/system/self-update', {
        method: 'POST',
        body: JSON.stringify({ target_version: latestVer, use_proxy: useProxy }),
        signal: ctrl.signal,
      });
      if (submitCtrlRef.current !== ctrl) return;
      submitCtrlRef.current = null;
      const tid = res?.task?.id || '';
      setUpdateTaskId(tid);
      setUpdatePhase('updating');
    } catch (ex: any) {
      if (ctrl.signal.aborted || submitCtrlRef.current !== ctrl) return;
      submitCtrlRef.current = null;
      if (ex instanceof TypeError) {
        setUpdatePhase('unknown');
      } else {
        setUpdateError(ex?.message || '发起更新失败');
        setUpdatePhase('failed');
      }
    }
  };

  const handleCreateSchedule = async (payload: {
    target_version: string;
    wait_seconds: number;
    interval_seconds: number;
  }) => {
    setScheduleBusy(true);
    setScheduleError('');
    try {
      const res = await apiPost('/api/v1/system/self-update/schedule', {
        ...payload,
        use_proxy: useProxy,
      });
      setSchedule(res.schedule);
      prevScheduleActiveRef.current = true;
      setScheduleModalOpen(false);
    } catch (ex: any) {
      setScheduleError(ex?.message || '预约升级失败');
    } finally {
      setScheduleBusy(false);
    }
  };

  const handleCancelSchedule = async () => {
    setScheduleBusy(true);
    try {
      const res = await apiDelete('/api/v1/system/self-update/schedule');
      setSchedule(res.schedule);
      prevScheduleActiveRef.current = false;
    } catch (ex: any) {
      setCheckError(ex?.message || '取消预约升级失败');
    } finally {
      setScheduleBusy(false);
    }
  };

  const handleManualRollback = async () => {
    const target = info?.manual_rollback?.target_version;
    if (!target) return;
    const ok = await askConfirm(`确认将控制面回退到上一版本 ${target} 吗？`, {
      title: '确认版本回退',
      confirmText: '确认回退',
      danger: true,
    });
    if (!ok) return;

    setRollbackBusy(true);
    try {
      const res = await apiPost('/api/v1/system/self-update/rollback');
      setUpdateError('');
      setUpdateTarget(target);
      setUpdateTaskId(res?.task?.id || '');
      setLastStage('restart');
      setUpdatePhase('restarting');
      startUpdateMonitor(target);
    } catch (ex: any) {
      toast.error(ex?.message || '版本回退失败');
    } finally {
      setRollbackBusy(false);
    }
  };

  const closeUpdateModal = () => {
    if (!updateModalClosable) return;
    stopUpdateMonitor();
    setUpdatePhase('idle');
    setUpdateError('');
  };

  // 预约状态展示视图（对齐 proxystack-web SystemView.vue）
  const scheduleStage: UpgradeStage = scheduleUnreachable
    ? 'restart'
    : upgradeStage(scheduleTask.progress?.stage) ?? 'resolve';

  const scheduleView = useMemo(() => {
    if (!schedule) return { border: 'border-l-indigo-500', tone: 'blue' as const, label: '' };
    const isLatest = schedule.target_version === 'latest';
    const ver = schedule.resolved_version || schedule.target_version;
    switch (schedule.status) {
      case 'waiting':
        return {
          border: 'border-l-indigo-500',
          tone: 'blue' as const,
          label: isLatest ? '等待新版本发布' : `等待 ${schedule.target_version} 发布`,
        };
      case 'upgrading':
        return {
          border: 'border-l-indigo-500',
          tone: 'blue' as const,
          label: `正在升级到 ${ver}`,
        };
      case 'completed':
        return {
          border: 'border-l-emerald-500',
          tone: 'green' as const,
          label: `已升级到 ${ver}`,
        };
      case 'timed_out':
        return isLatest
          ? { border: 'border-l-indigo-500', tone: 'blue' as const, label: '等待结束，没有发布新版本' }
          : { border: 'border-l-amber-500', tone: 'amber' as const, label: `等待结束，${schedule.target_version} 没有发布` };
      case 'cancelled':
        return { border: 'border-l-slate-400', tone: 'neutral' as const, label: '已取消' };
      default:
        return { border: 'border-l-rose-500', tone: 'red' as const, label: '升级失败' };
    }
  }, [schedule]);

  const scheduleWaitPercent = useMemo(() => {
    if (!schedule || schedule.status !== 'waiting') return 0;
    const start = Date.parse(schedule.created_at);
    const end = Date.parse(schedule.deadline_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
    return Math.min(100, Math.max(0, Math.round(((nowMs - start) / (end - start)) * 100)));
  }, [nowMs, schedule]);

  const scheduleRemaining = useMemo(() => {
    if (!schedule?.deadline_at) return '0 秒';
    const sec = Math.max(0, Math.round((Date.parse(schedule.deadline_at) - nowMs) / 1000));
    return formatDurationZh(sec);
  }, [nowMs, schedule?.deadline_at]);

  const scheduleNextCheck = useMemo(() => {
    if (!schedule?.next_check_at) return '';
    const next = Date.parse(schedule.next_check_at);
    if (!Number.isFinite(next) || next <= 0) return '';
    const sec = Math.round((next - nowMs) / 1000);
    return sec > 0 ? `${sec} 秒后` : '马上';
  }, [nowMs, schedule?.next_check_at]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="版本与升级"
        subtitle="检查 NomadDeck 控制面 Release 更新、实时进度升级、预约升级或回退上一版本"
      />

      <Card title="系统信息">
        {info ? (
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs sm:text-sm">
            <div className="rounded-xl border border-slate-200/70 bg-slate-50/60 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-950/40">
              <dt className="text-[11px] text-slate-500 dark:text-slate-400">构建提交</dt>
              <dd className="mt-1 font-mono font-medium text-slate-800 dark:text-slate-200 truncate">{info.commit || 'dev'}</dd>
            </div>
            <div className="rounded-xl border border-slate-200/70 bg-slate-50/60 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-950/40">
              <dt className="text-[11px] text-slate-500 dark:text-slate-400">构建时间</dt>
              <dd className="mt-1 font-mono font-medium text-slate-800 dark:text-slate-200 truncate">{info.build_date || '-'}</dd>
            </div>
            <div className="rounded-xl border border-slate-200/70 bg-slate-50/60 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-950/40">
              <dt className="text-[11px] text-slate-500 dark:text-slate-400">运行环境</dt>
              <dd className="mt-1 font-mono font-medium text-slate-800 dark:text-slate-200 truncate">
                {[info.go_version, info.platform].filter(Boolean).join(' · ') || '-'}
              </dd>
            </div>
            <div className="rounded-xl border border-slate-200/70 bg-slate-50/60 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-950/40">
              <dt className="text-[11px] text-slate-500 dark:text-slate-400">发布通道</dt>
              <dd className="mt-1 flex flex-wrap items-center gap-2 text-slate-800 dark:text-slate-200">
                <span className="font-medium">{info.channel === 'prerelease' ? '预发布' : '正式版 (stable)'}</span>
                <Link to="/settings" className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline">
                  调整
                </Link>
              </dd>
            </div>
          </dl>
        ) : (
          <div className="flex items-center gap-2 py-4 text-xs text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
            <span>正在加载系统信息…</span>
          </div>
        )}
      </Card>

      <Card title="版本与升级">
        <div className="space-y-4">
          {/* 双栏版本对比框 */}
          <div className="flex flex-col md:flex-row md:items-stretch gap-3">
            <div className="flex-1 rounded-xl border border-slate-200/80 bg-slate-50/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/60">
              <span className="block text-xs text-slate-500 dark:text-slate-400">当前版本</span>
              <div className="my-1 flex flex-wrap items-center gap-2 min-h-[30px]">
                <strong className="text-lg font-mono font-semibold text-slate-900 dark:text-slate-100">
                  {info?.current_version ?? '…'}
                </strong>
                {info?.dev_mode ? (
                  <Badge tone="amber">开发模式</Badge>
                ) : info && !info.available ? (
                  <Badge tone="amber">不可自更新</Badge>
                ) : info?.available ? (
                  <Badge tone="green">支持自更新</Badge>
                ) : null}
              </div>
            </div>

            <div className="hidden md:flex items-center text-lg text-slate-400 dark:text-slate-500 select-none" aria-hidden="true">
              →
            </div>

            <div className="flex-1 rounded-xl border border-slate-200/80 bg-slate-50/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/60">
              <span className="block text-xs text-slate-500 dark:text-slate-400">最新版本</span>
              <div className="my-1 flex flex-wrap items-center gap-2 min-h-[30px]">
                {checking ? (
                  <span className="inline-flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />
                    <span>正在检查…</span>
                  </span>
                ) : checkError && !info?.latest ? (
                  <span className="text-sm font-medium text-rose-600 dark:text-rose-400">检查失败</span>
                ) : info?.latest ? (
                  <>
                    <strong className="text-lg font-mono font-semibold text-slate-900 dark:text-slate-100">
                      {info.latest.version}
                    </strong>
                    {info.update_available ? <Badge tone="green">有新版本</Badge> : <Badge tone="neutral">已是最新</Badge>}
                  </>
                ) : (
                  <span className="text-sm text-slate-400 dark:text-slate-500">未检查</span>
                )}
              </div>
              {checkedAt && !checking && (
                <span className="block text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  检查于 {checkedAt.toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
              )}
            </div>
          </div>

          {/* 操作按钮栏 + 代理开关 */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {isAdmin && info?.update_available && info?.latest?.version && (
                <Button
                  variant="primary"
                  loading={updateBusy}
                  disabled={updateBusy || !info?.available || scheduleActive}
                  onClick={() => void runImmediateUpdate()}
                >
                  立即更新到 {info.latest.version}
                </Button>
              )}
              <Button
                loading={checking}
                disabled={updateBusy || scheduleActive}
                onClick={() => void checkUpdate(useProxy, scheduleFinished)}
              >
                {!checking && <RefreshCw className="h-3.5 w-3.5" />}
                <span>重新检查</span>
              </Button>
              {isAdmin && (
                <Button
                  disabled={updateBusy || !info?.available || scheduleActive}
                  onClick={() => {
                    setScheduleError('');
                    setScheduleModalOpen(true);
                  }}
                >
                  预约升级
                </Button>
              )}
            </div>

            <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 select-none cursor-pointer">
              <input
                type="checkbox"
                checked={useProxy}
                disabled={!isAdmin || updateBusy}
                onChange={(e) => void handleToggleProxy(e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span>使用系统代理访问 GitHub（自动保存）</span>
            </label>
          </div>

          <ErrorAlert message={checkError} onClose={() => setCheckError('')} />

          {info && !info.available && info.unavailable_reason && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/90 px-3.5 py-2.5 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              {info.unavailable_reason}，「立即更新」和「预约升级」仅在正式部署环境中可用。
            </div>
          )}

          {/* 更新说明（发现新版本时默认展开） */}
          {info?.update_available && info?.latest?.notes && (
            <details
              open
              className="rounded-xl border border-slate-200/80 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-950/60"
            >
              <summary className="cursor-pointer px-4 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 select-none">
                {info.latest.version} 更新说明
              </summary>
              <pre className="border-t border-slate-200/70 dark:border-slate-800 px-4 py-3 text-xs leading-relaxed whitespace-pre-wrap font-sans text-slate-700 dark:text-slate-300 max-h-60 overflow-auto">
                {info.latest.notes}
              </pre>
            </details>
          )}

          {/* 预约升级内联卡片（参考 proxystack-web） */}
          {schedule && schedule.status !== 'idle' && (
            <div
              className={`rounded-xl border border-slate-200/90 border-l-[3px] ${scheduleView.border} bg-white px-4 py-3.5 space-y-2.5 dark:border-slate-800 dark:bg-slate-900/70`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm text-slate-900 dark:text-slate-100">预约升级</strong>
                <Badge tone={scheduleView.tone}>{scheduleView.label}</Badge>
                <div className="ml-auto flex items-center gap-3">
                  {isAdmin && schedule.status === 'waiting' && (
                    <Button size="sm" loading={scheduleBusy} onClick={() => void handleCancelSchedule()}>
                      取消预约
                    </Button>
                  )}
                  {schedule.task_id && (
                    <button
                      type="button"
                      onClick={() => openTask(schedule.task_id, '预约自更新任务')}
                      className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      查看任务
                    </button>
                  )}
                  {isAdmin && scheduleFinished && (
                    <button
                      type="button"
                      disabled={scheduleBusy}
                      onClick={() => void clearUpgradeSchedule()}
                      className="text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                    >
                      清除
                    </button>
                  )}
                </div>
              </div>

              {schedule.status === 'waiting' ? (
                <>
                  <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-indigo-500 transition-all duration-500 animate-pulse"
                      style={{ width: `${scheduleWaitPercent}%` }}
                    />
                  </div>
                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    <span>目标：{schedule.target_version === 'latest' ? '最新正式版' : schedule.target_version}</span>
                    <span>剩余 {scheduleRemaining}（截止 {fmtTime(schedule.deadline_at)}）</span>
                    <span>
                      每 {formatDurationZh(schedule.interval_seconds)}检查一次
                      {scheduleNextCheck ? `，下次 ${scheduleNextCheck}` : ''}
                    </span>
                    {hasTime(schedule.last_checked_at) && <span>上次检查 {fmtTime(schedule.last_checked_at)}</span>}
                  </div>
                  {schedule.resolved_version && schedule.target_version === 'latest' && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      目前最新为 {schedule.resolved_version}，不比当前版本新，继续等待。
                    </p>
                  )}
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    控制面在后台检查，不需要保持页面打开。
                  </p>
                </>
              ) : schedule.status === 'upgrading' ? (
                <>
                  <UpgradeProgress
                    stage={scheduleStage}
                    progress={scheduleTask.progress}
                    speed={scheduleTask.speed}
                    target={schedule.resolved_version || schedule.target_version}
                  />
                  {scheduleUnreachable && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      控制面正在重启，恢复后页面自动刷新。
                    </p>
                  )}
                </>
              ) : (
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  <span>目标：{schedule.target_version === 'latest' ? '最新正式版' : schedule.target_version}</span>
                  {hasTime(schedule.finished_at) && <span>结束于 {fmtTime(schedule.finished_at)}</span>}
                </div>
              )}

              {schedule.message && (
                <p
                  className={`text-xs ${
                    schedule.status === 'failed' || schedule.status === 'waiting'
                      ? 'text-rose-600 dark:text-rose-400'
                      : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {schedule.message}
                </p>
              )}
            </div>
          )}

          <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            更新只替换控制面服务本身，托管中的 Nomad / Vault 集群不受影响。如勾选「使用系统代理」，版本检查与下载会经由「系统设置 → 代理」；替换前会校验 Ed25519 签名与 SHA-256、试运行新程序并在线备份数据库，保留上一版本。
          </p>
        </div>
      </Card>

      <Card title="上次自更新与手动回退">
        <div className="space-y-3 text-xs">
          {info?.last_result ? (
            <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3.5 space-y-2 dark:border-slate-800 dark:bg-slate-950/60">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-500 dark:text-slate-400">状态：</span>
                <StatusBadge value={info.last_result.state} />
                <span className="font-mono font-medium text-slate-800 dark:text-slate-200">
                  {info.last_result.from_version} → {info.last_result.to_version}
                </span>
                {info.last_result.finished_at && (
                  <span className="text-slate-400 dark:text-slate-500 tabular-nums">
                    {fmtTime(info.last_result.finished_at)}
                  </span>
                )}
              </div>
              {info.last_result.error_message && (
                <div className="text-rose-600 dark:text-rose-400 break-words">{info.last_result.error_message}</div>
              )}
              {info.last_result.task_id && (
                <div>
                  <Button size="sm" onClick={() => openTask(info.last_result.task_id, '控制面自更新日志')}>
                    查看该次任务日志
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-slate-500 dark:text-slate-400">暂无自更新记录</div>
          )}

          {isAdmin &&
            (info?.manual_rollback?.available ? (
              <Button variant="danger-outline" loading={rollbackBusy} onClick={() => void handleManualRollback()}>
                <RotateCcw className="h-3.5 w-3.5" />
                <span>回退到 {info.manual_rollback.target_version}</span>
              </Button>
            ) : info?.manual_rollback?.unavailable_note ? (
              <div className="text-slate-500 dark:text-slate-400">{info.manual_rollback.unavailable_note}</div>
            ) : null)}
        </div>
      </Card>

      <ScheduleModal
        open={scheduleModalOpen}
        currentVersion={info?.current_version}
        suggestedVersion={info?.update_available ? info?.latest?.version : undefined}
        busy={scheduleBusy}
        error={scheduleError}
        onClearError={() => setScheduleError('')}
        onClose={() => !scheduleBusy && setScheduleModalOpen(false)}
        onSubmit={handleCreateSchedule}
      />

      <Modal
        open={updateModalVisible}
        title={updateModalTitle}
        size="md"
        busy={!updateModalClosable}
        dismissible={updateModalClosable}
        onClose={closeUpdateModal}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            {updateTaskId ? (
              <Button size="sm" onClick={() => openTask(updateTaskId, '控制面自更新日志')}>
                查看任务日志
              </Button>
            ) : updatePhase === 'unknown' ? (
              <Button size="sm" onClick={openTaskList}>
                打开后台任务
              </Button>
            ) : null}
            {(updatePhase === 'unknown' || updatePhase === 'failed' || updatePhase === 'timeout') && (
              <Button size="sm" onClick={() => window.location.reload()}>
                刷新页面
              </Button>
            )}
            {updateModalClosable && (
              <Button size="sm" variant="primary" onClick={closeUpdateModal}>
                关闭
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          {updatePhase === 'unknown' ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200 leading-relaxed">
              没有收到提交结果，可能是网络中断或控制面正在重启。请在后台任务中确认是否已创建自更新任务，再决定是否重试。
            </div>
          ) : (
            <>
              <UpgradeProgress
                stage={effectiveStage}
                failed={updatePhase === 'failed' || updatePhase === 'timeout'}
                progress={updateTask.progress}
                speed={updateTask.speed}
                target={updateTarget}
              />
              {updatePhase === 'complete' && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200">
                  已更新到 {updateTarget}，正在刷新页面…
                </div>
              )}
              {updateError && (
                <div
                  className={`rounded-xl border px-3.5 py-2.5 text-xs break-words ${
                    updatePhase === 'timeout'
                      ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200'
                      : 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-200'
                  }`}
                >
                  {updateError}
                </div>
              )}
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
