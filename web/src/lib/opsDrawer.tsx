import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Copy, ExternalLink, RefreshCw, Terminal as TerminalIcon } from 'lucide-react';
import { apiGet, fmtTime, openSSE } from './api';
import { useAuth } from './auth';
import { copyText } from './clipboard';
import { useI18n } from './i18n';
import { formatActionLabel, formatTaskDuration, isTaskActiveStatus, isTaskFailureStatus } from './actionLabels';
import { Drawer } from '../components/Drawer';
import { Button, EmptyState, StatusBadge } from '../components/UI';
import { useToast } from '../components/Toast';

export interface OperationSummary {
  id: string;
  action: string;
  target_type: string;
  target_id: string;
  lock_mode: string;
  status: string;
  triggered_by: string;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  error_message?: string;
}

type DrawerTarget =
  | { kind: 'list' }
  | { kind: 'task'; taskId: string; title?: string }
  | { kind: 'node-logs'; clusterId: string; nodeId: string; title?: string };

interface OpsDrawerCtx {
  tasks: OperationSummary[];
  runningCount: number;
  unreadCount: number;
  readIds: Set<string>;
  loadingTasks: boolean;
  openTask: (taskId: string, title?: string) => void;
  openTaskList: () => void;
  openNodeLogs: (clusterId: string, nodeId: string, title?: string) => void;
  refreshTasks: () => Promise<void>;
  markTaskRead: (taskId: string) => void;
  markAllRead: () => void;
  close: () => void;
}

const Ctx = createContext<OpsDrawerCtx>({
  tasks: [],
  runningCount: 0,
  unreadCount: 0,
  readIds: new Set(),
  loadingTasks: false,
  openTask: () => {},
  openTaskList: () => {},
  openNodeLogs: () => {},
  refreshTasks: async () => {},
  markTaskRead: () => {},
  markAllRead: () => {},
  close: () => {},
});

export function OpsDrawerProvider({ children }: { children: React.ReactNode }) {
  const { user, authenticated } = useAuth();
  const { locale, tr } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();

  const [target, setTarget] = useState<DrawerTarget | null>(null);
  const [listFilter, setListFilter] = useState<'all' | 'unread'>('all');
  const [tasks, setTasks] = useState<OperationSummary[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());

  const [detailTask, setDetailTask] = useState<OperationSummary | null>(null);
  const [steps, setSteps] = useState<Array<{ id?: string; name: string; status: string; error?: string }>>([]);
  const [taskStatus, setTaskStatus] = useState('');
  const [logs, setLogs] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const logRef = useRef<HTMLPreElement>(null);

  const knownStatusRef = useRef<Map<string, string>>(new Map());
  const trackedRef = useRef<Set<string>>(new Set());
  const deliveredRef = useRef<Set<string>>(new Set());
  const targetRef = useRef<DrawerTarget | null>(null);
  const tasksRef = useRef<OperationSummary[]>([]);
  const readIdsRef = useRef<Set<string>>(new Set());

  targetRef.current = target;
  tasksRef.current = tasks;

  const storageKey = `nd_ops_read:${user?.username || 'anon'}`;

  useEffect(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || '[]');
      const next = new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
      readIdsRef.current = next;
      setReadIds(next);
    } catch {
      const empty = new Set<string>();
      readIdsRef.current = empty;
      setReadIds(empty);
    }
  }, [storageKey]);

  const persistRead = useCallback(
    (next: Set<string>) => {
      readIdsRef.current = next;
      setReadIds(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next].slice(-500)));
      } catch {
        // Ignore storage errors in private browsing mode.
      }
    },
    [storageKey],
  );

  const markRead = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      const next = new Set(readIdsRef.current);
      let changed = false;
      for (const id of ids) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      if (changed) persistRead(next);
    },
    [persistRead],
  );

  const markTaskRead = useCallback((taskId: string) => markRead([taskId]), [markRead]);

  const refreshTasks = useCallback(async () => {
    if (!authenticated) return;
    setLoadingTasks(true);
    try {
      const res = await apiGet<{ operations: OperationSummary[] }>('/api/v1/operations?limit=100');
      const list = res.operations || [];
      tasksRef.current = list;
      setTasks(list);

      const known = knownStatusRef.current;
      for (const item of list) {
        const prev = known.get(item.id);
        known.set(item.id, item.status);
        const activeBefore = prev === 'pending' || prev === 'running';
        const doneNow = !isTaskActiveStatus(item.status);
        if (doneNow && !deliveredRef.current.has(item.id) && (trackedRef.current.has(item.id) || activeBefore)) {
          deliveredRef.current.add(item.id);
          trackedRef.current.delete(item.id);
          const viewingThisTask = targetRef.current?.kind === 'task' && targetRef.current.taskId === item.id;
          if (viewingThisTask) {
            if (isTaskFailureStatus(item.status)) {
              markRead([item.id]);
            }
            continue;
          }
          const label = formatActionLabel(item.action);
          const viewAction = {
            label: tr('查看详情', 'View Details'),
            onClick: () => setTarget({ kind: 'task', taskId: item.id, title: label }),
          };
          if (isTaskFailureStatus(item.status)) {
            toast.error(
              tr(`${label}失败${item.error_message ? `：${item.error_message}` : ''}`, `${label} failed${item.error_message ? `: ${item.error_message}` : ''}`),
              viewAction,
            );
          } else {
            toast.success(tr(`${label}已完成`, `${label} completed`), viewAction);
          }
        }
      }
    } catch {
      // Background polling swallows transient errors silently.
    } finally {
      setLoadingTasks(false);
    }
  }, [authenticated, markRead, toast]);

  const runningCount = useMemo(
    () => tasks.filter((t) => isTaskActiveStatus(t.status)).length,
    [tasks],
  );

  const unreadIds = useMemo(
    () => tasks.filter((t) => isTaskFailureStatus(t.status) && !readIds.has(t.id)).map((t) => t.id),
    [readIds, tasks],
  );

  useEffect(() => {
    if (!authenticated) {
      setTasks([]);
      knownStatusRef.current.clear();
      trackedRef.current.clear();
      deliveredRef.current.clear();
      return;
    }
    void refreshTasks();
    const timer = window.setInterval(() => void refreshTasks(), runningCount > 0 || target ? 3000 : 8000);
    return () => window.clearInterval(timer);
  }, [authenticated, refreshTasks, runningCount, target]);

  useEffect(() => {
    if (!target && runningCount === 0) return;
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [runningCount, target]);

  useEffect(() => {
    if (!target || target.kind === 'list') return;
    setDetailTask(null);
    setSteps([]);
    setTaskStatus('');
    setLogs('');
    setAutoScroll(true);
    let stop: (() => void) | undefined;

    if (target.kind === 'task') {
      markRead([target.taskId]);
      void apiGet<{ operation: OperationSummary; steps: any[] }>(`/api/v1/operations/${target.taskId}`)
        .then((res) => {
          const op = res.operation || null;
          const st = op?.status || '';
          if (st) {
            knownStatusRef.current.set(target.taskId, st);
            if (!isTaskActiveStatus(st)) {
              deliveredRef.current.add(target.taskId);
              trackedRef.current.delete(target.taskId);
              if (isTaskFailureStatus(st)) markRead([target.taskId]);
            }
          }
          setDetailTask(op);
          setTaskStatus(st);
          setSteps(
            (res.steps || []).map((s) => ({
              id: s.id,
              name: s.name,
              status: s.status,
              error: s.error_message,
            })),
          );
        })
        .catch(() => {});

      stop = openSSE(`/api/v1/operations/${target.taskId}/stream`, {
        onEvent: (ev, data) => {
          if (ev === 'step' && data) {
            setSteps((prev) => {
              const idx = prev.findIndex((x) => (x.id && x.id === data.step_id) || x.name === data.name);
              const next = { id: data.step_id, name: data.name, status: data.status, error: data.error };
              if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = next;
                return copy;
              }
              return [...prev, next];
            });
          } else if (ev === 'log' && data?.data) {
            setLogs((prev) => prev + data.data);
          } else if (ev === 'done' && data) {
            const doneStatus = data.status || 'done';
            deliveredRef.current.add(target.taskId);
            trackedRef.current.delete(target.taskId);
            if (isTaskFailureStatus(doneStatus)) {
              markRead([target.taskId]);
            }
            setTaskStatus(doneStatus);
            setDetailTask((prev) =>
              prev ? { ...prev, status: doneStatus || prev.status, error_message: data.error || prev.error_message, finished_at: new Date().toISOString() } : prev,
            );
            if (data.error) {
              setLogs((prev) => prev + `\n[${tr('完成', 'Done')}: ${doneStatus}] ${data.error}\n`);
            }
            void refreshTasks();
            stop?.();
          }
        },
      });
    } else {
      stop = openSSE(
        `/api/v1/clusters/${target.clusterId}/nodes/${target.nodeId}/logs/stream?lines=200&follow=true`,
        {
          onEvent: (ev, data) => {
            if (ev === 'log' && data?.data) {
              setLogs((prev) => prev + data.data);
            } else if (ev === 'done') {
              if (data?.error) {
                setLogs((prev) => prev + `\n[${tr('流结束', 'Stream ended')}] ${data.error}\n`);
              }
              stop?.();
            }
          },
          onError: () => {
            setLogs((prev) => prev + `\n[${tr('连接已关闭', 'Connection closed')}]\n`);
          },
        },
      );
    }

    return () => stop?.();
  }, [markRead, refreshTasks, target, tr]);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const openTask = useCallback(
    (taskId: string, title?: string) => {
      const known = knownStatusRef.current.get(taskId) || tasksRef.current.find((t) => t.id === taskId)?.status;
      if (known && !isTaskActiveStatus(known)) {
        deliveredRef.current.add(taskId);
        trackedRef.current.delete(taskId);
        if (isTaskFailureStatus(known)) {
          markRead([taskId]);
        }
      } else {
        trackedRef.current.add(taskId);
      }
      setTarget({ kind: 'task', taskId, title });
      void refreshTasks();
    },
    [markRead, refreshTasks],
  );

  const openTaskList = useCallback(() => {
    setListFilter('all');
    setTarget({ kind: 'list' });
    void refreshTasks();
  }, [refreshTasks]);

  const openNodeLogs = useCallback((clusterId: string, nodeId: string, title?: string) => {
    setTarget({ kind: 'node-logs', clusterId, nodeId, title });
  }, []);

  const close = useCallback(() => setTarget(null), []);

  const markAllRead = useCallback(() => markRead(unreadIds), [markRead, unreadIds]);

  const unreadSet = useMemo(() => new Set(unreadIds), [unreadIds]);
  const displayedTasks = useMemo(
    () => (listFilter === 'unread' ? tasks.filter((t) => unreadSet.has(t.id)) : tasks),
    [listFilter, tasks, unreadSet],
  );

  const handleCopyLogs = async () => {
    if (!logs) return;
    try {
      await copyText(logs);
      setCopied(true);
      toast.success(tr('日志已复制到剪贴板', 'Logs copied to clipboard'));
      window.setTimeout(() => setCopied(false), 1500);
    } catch (ex: any) {
      toast.error(ex?.message || tr('复制失败', 'Copy failed'));
    }
  };

  const drawerTitle =
    target?.kind === 'list' ? (
      <>
        <TerminalIcon className="h-4 w-4 text-indigo-500 shrink-0" />
        <span>{tr('后台运维任务', 'Background Tasks')}</span>
      </>
    ) : target?.kind === 'task' ? (
      <>
        <TerminalIcon className="h-4 w-4 text-indigo-500 shrink-0" />
        <span className="truncate">{target.title || formatActionLabel(detailTask?.action || '', locale)}</span>
        {taskStatus && <StatusBadge value={taskStatus} />}
      </>
    ) : (
      <>
        <TerminalIcon className="h-4 w-4 text-indigo-500 shrink-0" />
        <span className="truncate">{target?.title || tr('节点实时服务日志', 'Live Node Service Logs')}</span>
      </>
    );

  const drawerSubtitle =
    target?.kind === 'list'
      ? runningCount > 0
        ? tr(`${runningCount} 个任务正在后台执行，切走页面不会中断`, `${runningCount} task(s) running in the background; navigating away will not interrupt them`)
        : tr('当前没有运行中的后台任务，展示最近任务记录', 'No active background tasks; showing recent task records')
      : target?.kind === 'task'
      ? `${tr('任务 ID', 'Task ID')}: ${target.taskId}${detailTask ? ` · ${tr('耗时', 'Duration')} ${formatTaskDuration(detailTask.started_at, detailTask.finished_at, detailTask.created_at, nowMs, locale)}` : ''}`
      : tr('实时流式输出（SSH journalctl）', 'Live streaming output (SSH journalctl)');

  return (
    <Ctx.Provider
      value={{
        tasks,
        runningCount,
        unreadCount: unreadIds.length,
        readIds,
        loadingTasks,
        openTask,
        openTaskList,
        openNodeLogs,
        refreshTasks,
        markTaskRead,
        markAllRead,
        close,
      }}
    >
      {children}
      {target && (
        <Drawer
          title={drawerTitle}
          subtitle={drawerSubtitle}
          width={target.kind === 'list' ? 'xl' : '2xl'}
          onClose={close}
          headerExtra={
            target.kind === 'list' ? (
              <Button size="sm" onClick={() => void refreshTasks()} loading={loadingTasks}>
                {!loadingTasks && <RefreshCw className="w-3.5 h-3.5" />}
                <span>{tr('刷新', 'Refresh')}</span>
              </Button>
            ) : target.kind === 'task' ? (
              <div className="flex items-center gap-1.5">
                <Button size="sm" onClick={openTaskList}>
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{tr('任务列表', 'Task List')}</span>
                </Button>
                <label className="hidden sm:inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 mx-1">
                  <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
                  <span>{tr('自动滚动', 'Auto-scroll')}</span>
                </label>
                <button
                  type="button"
                  disabled={!logs}
                  onClick={() => void handleCopyLogs()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? tr('已复制', 'Copied') : tr('复制日志', 'Copy Logs')}</span>
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <label className="hidden sm:inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 mr-1">
                  <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
                  <span>{tr('自动滚动', 'Auto-scroll')}</span>
                </label>
                <button
                  type="button"
                  disabled={!logs}
                  onClick={() => void handleCopyLogs()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? tr('已复制', 'Copied') : tr('复制日志', 'Copy Logs')}</span>
                </button>
              </div>
            )
          }
          bodyClassName={target.kind === 'list' ? 'px-5 py-4 space-y-3 bg-white dark:bg-slate-900' : 'flex flex-col p-0 overflow-hidden bg-slate-950'}
          footer={
            <div className="flex items-center justify-between gap-2 w-full text-xs">
              <button
                type="button"
                onClick={() => {
                  close();
                  navigate('/audit');
                }}
                className="inline-flex items-center gap-1 text-indigo-600 hover:underline dark:text-indigo-400 font-medium"
              >
                <span>{tr('前往审计日志', 'Go to Audit Logs')}</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
              {target.kind === 'list' && unreadIds.length > 0 && (
                <Button size="sm" onClick={markAllRead}>
                  {tr('异常提醒全部已读', 'Mark All Alerts Read')}
                </Button>
              )}
            </div>
          }
        >
          {target.kind === 'list' ? (
            tasks.length === 0 ? (
              <EmptyState
                title={tr('暂无运维任务记录', 'No Operations Tasks Yet')}
                description={tr('发起集群部署、升级或节点维护操作后，这里会实时展示任务进度。', 'Live task progress will appear here after you start a cluster deployment, upgrade, or node maintenance operation.')}
              />
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 px-3 py-2">
                  <div className="inline-flex items-center gap-1 rounded-lg bg-white dark:bg-slate-900 p-0.5 border border-slate-200/80 dark:border-slate-800">
                    <button
                      type="button"
                      onClick={() => setListFilter('all')}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                        listFilter === 'all'
                          ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'
                          : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                      }`}
                    >
                      {tr('全部', 'All')} ({tasks.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setListFilter('unread')}
                      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
                        listFilter === 'unread'
                          ? 'bg-rose-50 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300'
                          : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                      }`}
                    >
                      <span>{tr('未读异常', 'Unread Errors')}</span>
                      {unreadIds.length > 0 && (
                        <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-rose-600 text-white text-[10px] font-semibold">
                          {unreadIds.length}
                        </span>
                      )}
                    </button>
                  </div>
                  {unreadIds.length > 0 ? (
                    <Button size="sm" onClick={markAllRead}>
                      {tr('全部标为已读', 'Mark All Read')} ({unreadIds.length})
                    </Button>
                  ) : (
                    <span className="text-[11px] text-slate-400 dark:text-slate-500">{tr('所有异常已阅', 'All errors read')}</span>
                  )}
                </div>

                {displayedTasks.length === 0 ? (
                  <EmptyState
                    title={tr('没有未读异常任务', 'No Unread Error Tasks')}
                    description={tr('所有失败或待核对任务均已阅读，点击「全部」可查看历史记录。', 'All failed or pending-reconcile tasks have been read. Switch to "All" to view history.')}
                    action={
                      <Button size="sm" onClick={() => setListFilter('all')}>
                        {tr('查看全部任务', 'View All Tasks')}
                      </Button>
                    }
                  />
                ) : (
                  <div role="list" className="space-y-2.5">
                    {displayedTasks.map((t) => {
                      const failed = isTaskFailureStatus(t.status);
                      const isUnread = failed && !readIds.has(t.id);
                      const label = formatActionLabel(t.action, locale);
                      return (
                        <div
                          key={t.id}
                          role="listitem"
                          className={`rounded-xl border transition p-3.5 space-y-2 ${
                            isUnread
                              ? 'border-rose-200/90 border-l-4 border-l-rose-500 bg-rose-50/45 dark:border-rose-500/35 dark:border-l-rose-500 dark:bg-rose-950/20'
                              : 'border-slate-200/80 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-500/40'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => openTask(t.id, label)}
                            className="w-full text-left space-y-1.5 group focus:outline-none"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-sm text-slate-900 dark:text-slate-100 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 truncate">
                                    {label}
                                  </span>
                                  {failed &&
                                    (isUnread ? (
                                      <span className="inline-flex items-center gap-1 shrink-0 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">
                                        <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                                        {tr('未读', 'Unread')}
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                                        {tr('已读', 'Read')}
                                      </span>
                                    ))}
                                </div>
                                <div className="font-mono text-[11px] text-slate-400 truncate">
                                  {t.action} · {t.target_type}:{t.target_id}
                                </div>
                              </div>
                              <StatusBadge value={t.status} />
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap gap-x-3 gap-y-0.5">
                              <span>{tr('触发人：', 'Triggered by: ')}{t.triggered_by || '-'}</span>
                              <span>{tr('开始：', 'Started: ')}{fmtTime(t.started_at || t.created_at, locale)}</span>
                              <span>{tr('耗时：', 'Duration: ')}{formatTaskDuration(t.started_at, t.finished_at, t.created_at, nowMs, locale)}</span>
                            </div>
                            {t.error_message && (
                              <div className="text-xs text-rose-600 dark:text-rose-400 line-clamp-2 break-words">
                                {t.error_message}
                              </div>
                            )}
                          </button>
                          {isUnread && (
                            <div className="flex items-center justify-end pt-1 border-t border-rose-200/60 dark:border-rose-500/20">
                              <button
                                type="button"
                                onClick={() => markTaskRead(t.id)}
                                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100/80 dark:text-rose-300 dark:hover:bg-rose-500/20 transition"
                              >
                                <Check className="w-3 h-3" />
                                <span>{tr('标为已读', 'Mark as Read')}</span>
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )
          ) : (
            <>
              {target.kind === 'task' && detailTask?.error_message && (
                <div className="px-6 py-2.5 bg-rose-50 dark:bg-rose-950/60 border-b border-rose-200/80 dark:border-rose-900 text-xs text-rose-800 dark:text-rose-200 shrink-0 break-words">
                  {detailTask.error_message}
                </div>
              )}
              {steps.length > 0 && (
                <div className="max-h-52 overflow-y-auto border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 py-3 shrink-0">
                  <div className="space-y-2 text-xs">
                    {steps.map((s, idx) => (
                      <div key={s.id || idx} className="space-y-0.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium text-slate-700 dark:text-slate-200">{s.name}</span>
                          <StatusBadge value={s.status} />
                        </div>
                        {s.error && <div className="text-[11px] text-rose-600 dark:text-rose-400 break-words">{s.error}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <pre
                ref={logRef}
                className="flex-1 overflow-auto bg-slate-950 p-5 font-mono text-xs leading-relaxed text-slate-100 whitespace-pre-wrap break-all"
              >
                {logs || tr('任务正在后台执行，等待实时日志输出...', 'Task is running in the background, waiting for live logs...')}
              </pre>
            </>
          )}
        </Drawer>
      )}
    </Ctx.Provider>
  );
}

export function useOpsDrawer() {
  return useContext(Ctx);
}
