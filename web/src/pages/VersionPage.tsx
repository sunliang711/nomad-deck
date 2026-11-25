import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, RotateCcw, UploadCloud } from 'lucide-react';
import { apiDelete, apiGet, apiPost, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOpsDrawer } from '../lib/opsDrawer';
import { Badge, Button, Card, ErrorAlert, Input, statusTone } from '../components/UI';

export function VersionPage() {
  const { isAdmin } = useAuth();
  const { openTask } = useOpsDrawer();
  const [info, setInfo] = useState<any>(null);
  const [schedule, setSchedule] = useState<any>(null);
  const [useProxy, setUseProxy] = useState(false);
  const [targetVer, setTargetVer] = useState('latest');
  const [waitSec, setWaitSec] = useState(300);
  const [intervalSec, setIntervalSec] = useState(20);
  const [restartingTo, setRestartingTo] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async (refresh = false, proxy?: boolean) => {
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
    } catch (ex: any) {
      setErr(ex?.message || '获取版本信息失败');
    }
  }, []);

  useEffect(() => {
    void load(false);
    void apiGet('/api/v1/settings')
      .then((r) => setUseProxy(Boolean(r.settings?.['proxy.use_for_self_update'])))
      .catch(() => {});
  }, [load]);

  // Poll /api/v1/system/version across exit-75 restart until target version is live.
  useEffect(() => {
    if (!restartingTo) return;
    const deadline = Date.now() + 5 * 60 * 1000;
    const timer = window.setInterval(async () => {
      if (Date.now() > deadline) {
        window.clearInterval(timer);
        setErr('等待新版本就绪超时（5 分钟），请查看运维任务日志');
        setRestartingTo('');
        return;
      }
      try {
        const res = await fetch('/api/v1/system/version', { credentials: 'same-origin' });
        if (!res.ok) return;
        const j = await res.json();
        const cur = j?.system?.current_version;
        if (cur && cur === restartingTo) {
          window.clearInterval(timer);
          window.location.reload();
        }
      } catch {
        // Expected while control plane restarts.
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [restartingTo]);

  const startUpgrade = async () => {
    setErr('');
    try {
      const res = await apiPost('/api/v1/system/self-update', {
        target_version: targetVer.trim() || 'latest',
        use_proxy: useProxy,
      });
      if (res.task?.id) openTask(res.task.id, '控制面自更新');
      if (info?.latest?.version && (targetVer === 'latest' || !targetVer)) {
        setRestartingTo(info.latest.version);
      } else if (targetVer && targetVer !== 'latest') {
        setRestartingTo(targetVer.startsWith('v') ? targetVer : `v${targetVer}`);
      }
    } catch (ex: any) {
      setErr(ex?.message || '发起自更新失败');
    }
  };

  const createSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const res = await apiPost('/api/v1/system/self-update/schedule', {
        target_version: targetVer.trim() || 'latest',
        wait_seconds: Number(waitSec),
        interval_seconds: Number(intervalSec),
        use_proxy: useProxy,
      });
      setSchedule(res.schedule);
    } catch (ex: any) {
      setErr(ex?.message || '创建预约升级失败');
    }
  };

  const manualRollback = async () => {
    setErr('');
    try {
      const res = await apiPost('/api/v1/system/self-update/rollback');
      if (res.task?.id) openTask(res.task.id, '控制面版本回退');
      if (info?.manual_rollback?.target_version) {
        setRestartingTo(info.manual_rollback.target_version);
      }
    } catch (ex: any) {
      setErr(ex?.message || '回退失败');
    }
  };

  return (
    <div className="space-y-5">
      <ErrorAlert message={err} onClose={() => setErr('')} />
      {restartingTo && (
        <div className="rounded-md border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-200">
          控制面正在切换并重启到 {restartingTo}，等待新版本就绪后将自动刷新页面...
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card
          title="当前与最新版本"
          actions={
            <Button size="sm" onClick={() => void load(true, useProxy)}>
              <RefreshCw className="h-3.5 w-3.5" /> 检查更新
            </Button>
          }
        >
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">当前运行版本</span>
              <span className="font-mono font-semibold">{info?.current_version || '-'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">GitHub 最新版本</span>
              <span className="font-mono font-semibold">
                {info?.latest?.version || '尚未检查'}
                {info?.update_available && <Badge tone="green">可升级</Badge>}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">自更新可用性</span>
              <Badge tone={info?.available ? 'green' : 'amber'}>
                {info?.available ? '支持原地自更新' : '已禁用'}
              </Badge>
            </div>
            {!info?.available && info?.unavailable_reason && (
              <div className="rounded bg-amber-50 p-2.5 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                {info.unavailable_reason}
              </div>
            )}
            {info?.latest?.notes && (
              <pre className="max-h-40 overflow-auto rounded bg-slate-100 p-2.5 font-mono text-xs whitespace-pre-wrap dark:bg-slate-950">
                {info.latest.notes}
              </pre>
            )}
          </div>
        </Card>

        <Card title="发起升级 / 预约升级">
          <div className="space-y-4 text-xs">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} />
              <span>使用系统代理访问 GitHub Release</span>
            </label>
            <Input
              label="目标版本（latest 或具体版本号，如 v1.2.0）"
              value={targetVer}
              onChange={(e) => setTargetVer(e.target.value)}
            />
            {isAdmin && (
              <Button variant="primary" disabled={!info?.available} onClick={() => void startUpgrade()}>
                <UploadCloud className="h-3.5 w-3.5" /> 立即升级
              </Button>
            )}

            <form onSubmit={createSchedule} className="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800">
              <div className="font-semibold">预约升级（等待新版本发布后自动升级）</div>
              <div className="grid grid-cols-2 gap-2">
                <Input label="等待时长（秒）" type="number" value={waitSec} onChange={(e) => setWaitSec(Number(e.target.value))} />
                <Input label="检查间隔（秒）" type="number" value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))} />
              </div>
              {isAdmin && (
                <div className="flex gap-2">
                  <Button type="submit" disabled={!info?.available}>创建预约升级</Button>
                  {schedule?.status === 'waiting' && (
                    <Button
                      type="button"
                      variant="danger"
                      onClick={() =>
                        void apiDelete('/api/v1/system/self-update/schedule')
                          .then((r) => setSchedule(r.schedule))
                          .catch((ex) => setErr(ex.message))
                      }
                    >
                      取消预约
                    </Button>
                  )}
                </div>
              )}
              {schedule && (
                <div className="rounded bg-slate-50 p-2.5 dark:bg-slate-950">
                  状态：<Badge tone={statusTone(schedule.status)}>{schedule.status}</Badge>{' '}
                  <span className="ml-2">目标：{schedule.target_version}</span>
                  <div className="mt-1 text-slate-500">
                    截止：{fmtTime(schedule.deadline_at)} · {schedule.message}
                  </div>
                </div>
              )}
            </form>
          </div>
        </Card>
      </div>

      <Card title="最近升级结果与版本回退">
        <div className="space-y-3 text-xs">
          {info?.last_result ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <Badge tone={statusTone(info.last_result.state)}>{info.last_result.state}</Badge>{' '}
                <span className="ml-2 font-mono">
                  {info.last_result.from_version} → {info.last_result.to_version}
                </span>
                {info.last_result.error_message && (
                  <span className="ml-2 text-rose-600">{info.last_result.error_message}</span>
                )}
              </div>
              {info.last_result.task_id && (
                <Button size="sm" onClick={() => openTask(info.last_result.task_id)}>查看任务日志</Button>
              )}
            </div>
          ) : (
            <div className="text-slate-500">暂无自更新记录</div>
          )}

          {isAdmin && info?.manual_rollback && (
            <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
              {info.manual_rollback.available ? (
                <Button variant="danger" onClick={() => void manualRollback()}>
                  <RotateCcw className="h-3.5 w-3.5" /> 回退到 {info.manual_rollback.target_version}
                </Button>
              ) : (
                <div className="text-slate-500">{info.manual_rollback.unavailable_note}</div>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
