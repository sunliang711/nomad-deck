import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Clock, Loader2, RefreshCw, RotateCcw, UploadCloud, XCircle } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut, fmtTime, openSSE } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOpsDrawer } from '../lib/opsDrawer';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { Badge, Button, Card, ErrorAlert, Input, Modal, PageHeader, StatusBadge } from '../components/UI';

type UpgradeStage = 'resolve' | 'download' | 'verify' | 'install' | 'restart' | 'confirm' | 'done';
type UpdatePhase = 'idle' | 'submitting' | 'unknown' | 'updating' | 'restarting' | 'verifying' | 'complete' | 'failed' | 'timeout';

interface DownloadProgress {
  stage: string;
  done?: number;
  total?: number;
}

const UPGRADE_STEPS: Array<{ key: Exclude<UpgradeStage, 'done'>; title: string; detail: string }> = [
  { key: 'resolve', title: '查找版本', detail: '查询 GitHub Release 并核对当前平台程序包' },
  { key: 'download', title: '下载程序包', detail: '下载对应架构归档与 SHA256 校验文件' },
  { key: 'verify', title: '安全校验与试运行', detail: '验证 Ed25519 签名、SHA-256 与试运行新版本' },
  { key: 'install', title: '备份数据库并切换版本', detail: '在线备份数据文件并原子切换可执行软链' },
  { key: 'restart', title: '重启控制面服务', detail: '页面会短暂断开，托管中的 Nomad / Vault 集群不受影响' },
  { key: 'confirm', title: '确认新版本', detail: '等待重启后的控制面报告目标版本号' },
];

const mib = (bytes: number) => `${(bytes / (1 << 20)).toFixed(1)} MiB`;

export function VersionPage() {
  const { isAdmin } = useAuth();
  const { openTask, openTaskList } = useOpsDrawer();
  const toast = useToast();
  const askConfirm = useConfirm();

  const [info, setInfo] = useState<any>(null);
  const [schedule, setSchedule] = useState<any>(null);
  const [useProxy, setUseProxy] = useState(false);
  const [targetVer, setTargetVer] = useState('latest');
  const [waitSec, setWaitSec] = useState(300);
  const [intervalSec, setIntervalSec] = useState(20);
  const [checking, setChecking] = useState(false);
  const [schedBusy, setSchedBusy] = useState(false);
  const [cancelingSched, setCancelingSched] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [err, setErr] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());

  // 立即更新向导（参考 proxystack-web UpgradeProgress 体验）
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('idle');
  const [updateTarget, setUpdateTarget] = useState('');
  const [updateTaskId, setUpdateTaskId] = useState('');
  const [updateError, setUpdateError] = useState('');
  const [lastStage, setLastStage] = useState<UpgradeStage>('resolve');
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloadSpeed, setDownloadSpeed] = useState(0);

  const speedSampleRef = useRef<{ at: number; done: number } | null>(null);
  const sseCloseRef = useRef<(() => void) | null>(null);
  const pollStopRef = useRef<(() => void) | null>(null);

  const load = useCallback(
    async (refresh = false, proxy?: boolean) => {
      if (refresh) setChecking(true);
      setErr('');
      try {
        const q = new URLSearchParams();
        if (refresh) q.set('refresh', 'true');
        if (proxy !== undefined) q.set('use_proxy', String(proxy));
        const [vRes, sRes] = await Promise.all([
          apiGet(`/api/v1/system/version${q.toString() ? `?${q.toString()}` : ''}`),
          apiGet('/api/v1/system/self-update/schedule'),
        ]);
        setInfo(vRes.system);
        setSchedule(sRes.schedule);
        if (refresh) toast.success('版本检查已完成');
      } catch (ex: any) {
        setErr(ex?.message || '获取版本信息失败');
      } finally {
        if (refresh) setChecking(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load(false);
    void apiGet('/api/v1/settings')
      .then((r) => setUseProxy(Boolean(r.settings?.['proxy.use_for_self_update'])))
      .catch(() => {});
  }, [load]);

  useEffect(() => {
    if (schedule?.status !== 'waiting' && schedule?.status !== 'upgrading') return;
    const tick = window.setInterval(() => setNowMs(Date.now()), 1000);
    const poll = window.setInterval(() => {
      void apiGet('/api/v1/system/self-update/schedule')
        .then((r) => setSchedule(r.schedule))
        .catch(() => {});
    }, 5000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [schedule?.status]);

  useEffect(
    () => () => {
      sseCloseRef.current?.();
      pollStopRef.current?.();
    },
    [],
  );

  const handleToggleProxy = async (next: boolean) => {
    setUseProxy(next);
    if (!isAdmin) return;
    try {
      await apiPut('/api/v1/settings', { 'proxy.use_for_self_update': next });
      toast.success(next ? '已保存：自更新与版本检查默认走代理' : '已保存：自更新与版本检查直连');
    } catch (ex: any) {
      toast.error(ex?.message || '保存代理设置失败');
    }
  };

  const liveStage: UpgradeStage = useMemo(() => {
    if (updatePhase === 'restarting') return 'restart';
    if (updatePhase === 'verifying') return 'confirm';
    if (updatePhase === 'complete') return 'done';
    if (updatePhase === 'timeout') return 'confirm';
    if (updatePhase === 'updating') {
      const s = progress?.stage;
      if (s === 'resolve' || s === 'download' || s === 'verify' || s === 'install' || s === 'restart') {
        return s;
      }
      return 'resolve';
    }
    return 'resolve';
  }, [progress?.stage, updatePhase]);

  useEffect(() => {
    if (updatePhase !== 'failed') setLastStage(liveStage);
  }, [liveStage, updatePhase]);

  const effectiveStage = updatePhase === 'failed' ? lastStage : liveStage;

  const startVersionProbe = useCallback((expectedVersion: string) => {
    pollStopRef.current?.();
    let cancelled = false;
    const deadline = Date.now() + 5 * 60 * 1000;
    const norm = (v: string) => v.trim().replace(/^v/, '');

    const timer = window.setInterval(async () => {
      if (cancelled) return;
      if (Date.now() > deadline) {
        window.clearInterval(timer);
        setUpdateError(`等待 ${expectedVersion || '新版本'} 启动超时（5 分钟），请检查服务状态后刷新页面`);
        setUpdatePhase('timeout');
        return;
      }
      try {
        const res = await fetch('/api/v1/system/version', { credentials: 'same-origin' });
        if (!res.ok) return;
        const j = await res.json();
        const cur = j?.system?.current_version;
        if (!cur) return;
        setUpdatePhase((prev) => (prev === 'restarting' ? 'verifying' : prev));
        if (!expectedVersion || norm(cur) === norm(expectedVersion)) {
          window.clearInterval(timer);
          setUpdatePhase('complete');
          window.setTimeout(() => window.location.reload(), 1200);
        }
      } catch {
        // 控制面正在退出重启时连接报错是正常的。
        setUpdatePhase((prev) => (prev === 'verifying' ? 'restarting' : prev));
      }
    }, 1500);

    pollStopRef.current = () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const attachUpdateStream = useCallback(
    (taskId: string, expectedVersion: string) => {
      sseCloseRef.current?.();
      let handedOver = false;
      const close = openSSE(`/api/v1/operations/${taskId}/stream`, {
        onEvent: (ev, data) => {
          if (ev === 'progress' && data?.progress) {
            const p = data.progress as DownloadProgress;
            if (p.stage === 'download' && typeof p.done === 'number') {
              const now = Date.now();
              const prev = speedSampleRef.current;
              if (prev && p.done > prev.done && now > prev.at) {
                const instant = ((p.done - prev.done) * 1000) / (now - prev.at);
                setDownloadSpeed((s) => (s ? s * 0.6 + instant * 0.4 : instant));
              }
              speedSampleRef.current = { at: now, done: p.done };
            }
            if (p.stage === 'restart') {
              handedOver = true;
              setUpdatePhase('restarting');
              startVersionProbe(expectedVersion);
            }
            setProgress(p);
          } else if (ev === 'done' && data) {
            close();
            if (data.status === 'failed' || data.status === 'cancelled') {
              setUpdateError(data.error || '自更新任务失败，请查看任务日志');
              setUpdatePhase('failed');
            } else {
              handedOver = true;
              setUpdatePhase('restarting');
              startVersionProbe(expectedVersion);
            }
          }
        },
        onError: () => {
          if (handedOver || lastStage === 'restart' || lastStage === 'install') {
            setUpdatePhase('restarting');
            startVersionProbe(expectedVersion);
          }
        },
      });
      sseCloseRef.current = close;
    },
    [lastStage, startVersionProbe],
  );

  const startUpgrade = async () => {
    const ver = targetVer.trim() || 'latest';
    const displayTarget = ver === 'latest' && info?.latest?.version ? info.latest.version : ver;
    if (
      !(await askConfirm(`确认立即原地升级控制面到 ${displayTarget} 吗？升级前会自动备份数据库，重启期间页面将短暂断开。`, {
        title: '发起控制面自更新',
        confirmText: '确认升级',
      }))
    ) {
      return;
    }
    setErr('');
    setUpdateError('');
    setUpdateTaskId('');
    setProgress(null);
    setDownloadSpeed(0);
    speedSampleRef.current = null;
    setLastStage('resolve');
    setUpdateTarget(displayTarget);
    setUpdatePhase('submitting');

    try {
      const res = await apiPost('/api/v1/system/self-update', {
        target_version: ver,
        use_proxy: useProxy,
      });
      const tid = res.task?.id || '';
      const resolvedExpected =
        ver === 'latest' ? info?.latest?.version || '' : ver.startsWith('v') ? ver : `v${ver}`;
      setUpdateTaskId(tid);
      setUpdatePhase('updating');
      if (tid) {
        attachUpdateStream(tid, resolvedExpected);
      } else {
        setUpdatePhase('restarting');
        startVersionProbe(resolvedExpected);
      }
    } catch (ex: any) {
      if (ex instanceof TypeError) {
        setUpdatePhase('unknown');
      } else {
        setUpdateError(ex?.message || '发起自更新失败');
        setUpdatePhase('failed');
      }
    }
  };

  const createSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setSchedBusy(true);
    try {
      const res = await apiPost('/api/v1/system/self-update/schedule', {
        target_version: targetVer.trim() || 'latest',
        wait_seconds: Number(waitSec),
        interval_seconds: Number(intervalSec),
        use_proxy: useProxy,
      });
      setSchedule(res.schedule);
      toast.success('已创建预约升级计划');
    } catch (ex: any) {
      toast.error(ex?.message || '创建预约升级失败');
    } finally {
      setSchedBusy(false);
    }
  };

  const manualRollback = async () => {
    const target = info?.manual_rollback?.target_version;
    if (
      !(await askConfirm(`确认将控制面回退到上一版本 ${target} 吗？`, {
        title: '确认版本回退',
        confirmText: '确认回退',
        danger: true,
      }))
    ) {
      return;
    }
    setErr('');
    setRollbackBusy(true);
    try {
      const res = await apiPost('/api/v1/system/self-update/rollback');
      setUpdateError('');
      setUpdateTarget(target || '上一版本');
      setUpdateTaskId(res.task?.id || '');
      setProgress(null);
      setLastStage('restart');
      setUpdatePhase('restarting');
      if (target) startVersionProbe(target);
    } catch (ex: any) {
      toast.error(ex?.message || '回退失败');
    } finally {
      setRollbackBusy(false);
    }
  };

  const modalVisible = updatePhase !== 'idle';
  const modalClosable = ['failed', 'timeout', 'unknown'].includes(updatePhase);
  const modalTitle = {
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

  const activeStepIdx =
    effectiveStage === 'done'
      ? UPGRADE_STEPS.length
      : Math.max(0, UPGRADE_STEPS.findIndex((s) => s.key === effectiveStage));

  const downloadPercent =
    progress?.stage === 'download' && progress.total && progress.total > 0
      ? Math.min(100, Math.round(((progress.done || 0) / progress.total) * 100))
      : null;

  const schedWaitPercent = useMemo(() => {
    if (!schedule || schedule.status !== 'waiting') return 0;
    const start = Date.parse(schedule.created_at);
    const end = Date.parse(schedule.deadline_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
    return Math.min(100, Math.max(0, Math.round(((nowMs - start) / (end - start)) * 100)));
  }, [nowMs, schedule]);

  const schedRemainSec = schedule?.deadline_at
    ? Math.max(0, Math.round((Date.parse(schedule.deadline_at) - nowMs) / 1000))
    : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="版本与升级"
        subtitle="检查 NomadDeck 官方 Release 更新、实时进度自更新或预约升级与版本回退"
        actions={
          <Button onClick={() => void load(true, useProxy)} loading={checking}>
            <RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
            <span>{checking ? '检查中...' : '检查更新'}</span>
          </Button>
        }
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="当前与最新版本">
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between py-1 border-b border-slate-100 dark:border-slate-800">
              <span className="text-slate-500">当前运行版本</span>
              <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">{info?.current_version || '-'}</span>
            </div>
            <div className="flex items-center justify-between py-1 border-b border-slate-100 dark:border-slate-800">
              <span className="text-slate-500">GitHub 最新版本</span>
              <span className="font-mono font-semibold inline-flex items-center gap-2">
                <span>{info?.latest?.version || '尚未检查'}</span>
                {info?.update_available && <Badge tone="green">可升级</Badge>}
              </span>
            </div>
            <div className="flex items-center justify-between py-1">
              <span className="text-slate-500">自更新可用性</span>
              <Badge tone={info?.available ? 'green' : 'amber'}>
                {info?.available ? '支持原地自更新' : '已禁用'}
              </Badge>
            </div>
            {!info?.available && info?.unavailable_reason && (
              <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                {info.unavailable_reason}
              </div>
            )}
            {info?.latest?.notes && (
              <pre className="max-h-48 overflow-auto rounded-xl bg-slate-50 border border-slate-200/70 p-3 font-mono text-xs whitespace-pre-wrap dark:bg-slate-950 dark:border-slate-800">
                {info.latest.notes}
              </pre>
            )}
          </div>
        </Card>

        <Card title="发起升级 / 预约升级">
          <div className="space-y-4 text-xs">
            {info && !info.available && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-slate-600 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-400">
                当前构建未启用自更新（缺少发布验签公钥），以下原地升级与预约升级操作已锁定；如需更新请使用安装脚本或替换二进制文件。
              </div>
            )}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={useProxy} onChange={(e) => void handleToggleProxy(e.target.checked)} />
              <span>使用系统代理访问 GitHub Release（自动保存）</span>
            </label>
            <Input
              label="目标版本（latest 或具体版本号，如 v1.2.0）"
              disabled={info ? !info.available : false}
              value={targetVer}
              onChange={(e) => setTargetVer(e.target.value)}
            />
            {isAdmin && (
              <Button variant="primary" loading={modalVisible} disabled={!info?.available || modalVisible} onClick={() => void startUpgrade()}>
                <UploadCloud className="h-3.5 w-3.5" />
                <span>立即升级</span>
              </Button>
            )}

            <form onSubmit={createSchedule} className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
              <div className="font-semibold text-sm text-slate-800 dark:text-slate-100">预约升级（等待新版本发布后自动升级）</div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="等待时长（秒）" type="number" disabled={info ? !info.available : false} value={waitSec} onChange={(e) => setWaitSec(Number(e.target.value))} />
                <Input label="检查间隔（秒）" type="number" disabled={info ? !info.available : false} value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))} />
              </div>
              {isAdmin && (
                <div className="flex gap-2">
                  <Button type="submit" loading={schedBusy} disabled={!info?.available || schedule?.status === 'waiting'}>创建预约升级</Button>
                  {schedule?.status === 'waiting' && (
                    <Button
                      variant="danger"
                      loading={cancelingSched}
                      onClick={async () => {
                        setCancelingSched(true);
                        try {
                          const r = await apiDelete('/api/v1/system/self-update/schedule');
                          setSchedule(r.schedule);
                          toast.success('已取消预约升级');
                        } catch (ex: any) {
                          toast.error(ex?.message || '取消预约失败');
                        } finally {
                          setCancelingSched(false);
                        }
                      }}
                    >
                      取消预约
                    </Button>
                  )}
                </div>
              )}
              {schedule && (
                <div className="rounded-xl bg-slate-50 border border-slate-200/70 p-3 space-y-2 dark:bg-slate-950 dark:border-slate-800">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span>状态：</span>
                      <StatusBadge value={schedule.status} />
                      <span className="font-mono">目标：{schedule.target_version}</span>
                    </div>
                    {schedule.task_id && (
                      <button
                        type="button"
                        onClick={() => openTask(schedule.task_id, '预约自更新任务')}
                        className="text-indigo-600 dark:text-indigo-400 hover:underline font-medium"
                      >
                        查看任务日志
                      </button>
                    )}
                  </div>
                  {schedule.status === 'waiting' && (
                    <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                      <div className="h-full bg-indigo-500 transition-all duration-500" style={{ width: `${schedWaitPercent}%` }} />
                    </div>
                  )}
                  <div className="text-slate-500 flex flex-wrap gap-x-3 gap-y-1">
                    {schedule.status === 'waiting' && <span>剩余约 {schedRemainSec} 秒</span>}
                    <span>截止：{fmtTime(schedule.deadline_at)}</span>
                    {schedule.message && <span>{schedule.message}</span>}
                  </div>
                </div>
              )}
            </form>
          </div>
        </Card>
      </div>

      <Card title="上次自更新与手动回退">
        <div className="space-y-3 text-xs">
          {info?.last_result ? (
            <div className="rounded-xl bg-slate-50 border border-slate-200/70 p-3.5 space-y-1.5 dark:bg-slate-950 dark:border-slate-800">
              <div>
                状态：<StatusBadge value={info.last_result.state} />{' '}
                <span className="ml-2 font-mono">
                  {info.last_result.from_version} → {info.last_result.to_version}
                </span>
              </div>
              {info.last_result.error_message && <div className="text-rose-600">{info.last_result.error_message}</div>}
              {info.last_result.task_id && (
                <div>
                  <Button size="sm" onClick={() => openTask(info.last_result.task_id, '控制面自更新日志')}>
                    查看该次任务日志
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-slate-500">暂无自更新记录</div>
          )}

          {isAdmin &&
            (info?.manual_rollback?.available ? (
              <Button variant="danger" loading={rollbackBusy} onClick={() => void manualRollback()}>
                <RotateCcw className="h-3.5 w-3.5" />
                <span>回退到 {info.manual_rollback.target_version}</span>
              </Button>
            ) : (
              <div className="text-slate-500">{info?.manual_rollback?.unavailable_note}</div>
            ))}
        </div>
      </Card>

      <Modal
        open={modalVisible}
        title={modalTitle}
        busy={!modalClosable}
        dismissible={modalClosable}
        onClose={() => {
          if (!modalClosable) return;
          sseCloseRef.current?.();
          pollStopRef.current?.();
          setUpdatePhase('idle');
          setUpdateError('');
        }}
      >
        <div className="space-y-4">
          {updatePhase === 'unknown' ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200 leading-relaxed">
              没有收到提交结果，可能是网络短暂中断或控制面正在重启。请在后台任务列表确认是否已创建自更新任务，再决定是否重试。
            </div>
          ) : (
            <ol className="space-y-3">
              {UPGRADE_STEPS.map((step, idx) => {
                const isFailedHere = (updatePhase === 'failed' || updatePhase === 'timeout') && idx === activeStepIdx;
                const isDone = effectiveStage === 'done' || idx < activeStepIdx;
                const isActive = !isFailedHere && idx === activeStepIdx;

                return (
                  <li key={step.key} className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0">
                      {isFailedHere ? (
                        <XCircle className="h-4 w-4 text-rose-500" />
                      ) : isDone ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      ) : isActive ? (
                        <Loader2 className="h-4 w-4 text-indigo-500 animate-spin" />
                      ) : (
                        <Clock className="h-4 w-4 text-slate-300 dark:text-slate-700" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div
                        className={`text-xs font-semibold ${
                          isFailedHere
                            ? 'text-rose-600 dark:text-rose-400'
                            : isActive
                            ? 'text-indigo-700 dark:text-indigo-300'
                            : isDone
                            ? 'text-slate-800 dark:text-slate-100'
                            : 'text-slate-400 dark:text-slate-500'
                        }`}
                      >
                        {step.title}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {step.key === 'resolve' && updateTarget ? `目标版本：${updateTarget}` : step.detail}
                      </div>
                      {step.key === 'download' && isActive && progress?.stage === 'download' && (
                        <div className="pt-1 space-y-1">
                          <div className="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                            <div
                              className="h-full bg-indigo-600 transition-all duration-200"
                              style={{ width: `${downloadPercent ?? 100}%` }}
                            />
                          </div>
                          <div className="text-[11px] text-slate-500 tabular-nums">
                            {progress.total && progress.total > 0
                              ? `${mib(progress.done || 0)} / ${mib(progress.total)} (${downloadPercent}%)`
                              : `已下载 ${mib(progress.done || 0)}`}
                            {downloadSpeed > 0 && ` · ${mib(downloadSpeed)}/s`}
                            {downloadSpeed > 0 && progress.total && progress.total > (progress.done || 0)
                              ? ` · 剩余约 ${Math.max(1, Math.ceil((progress.total - (progress.done || 0)) / downloadSpeed))} 秒`
                              : ''}
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          {updatePhase === 'complete' && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200">
              已更新到 {updateTarget}，正在刷新页面...
            </div>
          )}

          {updateError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-200 break-words">
              {updateError}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
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
            {modalClosable && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  sseCloseRef.current?.();
                  pollStopRef.current?.();
                  setUpdatePhase('idle');
                  setUpdateError('');
                }}
              >
                关闭
              </Button>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
