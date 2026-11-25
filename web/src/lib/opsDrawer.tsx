import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Check, Copy, Terminal as TerminalIcon } from 'lucide-react';
import { apiGet, openSSE } from './api';
import { copyText } from './clipboard';
import { Drawer } from '../components/Drawer';
import { StatusBadge } from '../components/UI';
import { useToast } from '../components/Toast';

type DrawerTarget =
  | { kind: 'task'; taskId: string; title?: string }
  | { kind: 'node-logs'; clusterId: string; nodeId: string; title?: string };

interface OpsDrawerCtx {
  openTask: (taskId: string, title?: string) => void;
  openNodeLogs: (clusterId: string, nodeId: string, title?: string) => void;
  close: () => void;
}

const Ctx = createContext<OpsDrawerCtx>({
  openTask: () => {},
  openNodeLogs: () => {},
  close: () => {},
});

export function OpsDrawerProvider({ children }: { children: React.ReactNode }) {
  const toast = useToast();
  const [target, setTarget] = useState<DrawerTarget | null>(null);
  const [steps, setSteps] = useState<Array<{ id?: string; name: string; status: string; error?: string }>>([]);
  const [taskStatus, setTaskStatus] = useState('');
  const [logs, setLogs] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!target) return;
    setSteps([]);
    setTaskStatus('');
    setLogs('');
    setAutoScroll(true);
    let stop: (() => void) | undefined;

    if (target.kind === 'task') {
      void apiGet<{ operation: { status: string; action: string }; steps: any[] }>(`/api/v1/operations/${target.taskId}`)
        .then((res) => {
          setTaskStatus(res.operation?.status || '');
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
            setTaskStatus(data.status || 'done');
            if (data.error) {
              setLogs((prev) => prev + `\n[完成: ${data.status}] ${data.error}\n`);
            }
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
                setLogs((prev) => prev + `\n[流结束] ${data.error}\n`);
              }
              stop?.();
            }
          },
          onError: () => {
            setLogs((prev) => prev + '\n[连接已关闭]\n');
          },
        },
      );
    }

    return () => stop?.();
  }, [target]);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const openTask = (taskId: string, title?: string) => setTarget({ kind: 'task', taskId, title });
  const openNodeLogs = (clusterId: string, nodeId: string, title?: string) =>
    setTarget({ kind: 'node-logs', clusterId, nodeId, title });
  const close = () => setTarget(null);

  const handleCopyLogs = async () => {
    if (!logs) return;
    try {
      await copyText(logs);
      setCopied(true);
      toast.success('日志已复制到剪贴板');
      window.setTimeout(() => setCopied(false), 1500);
    } catch (ex: any) {
      toast.error(ex?.message || '复制失败');
    }
  };

  return (
    <Ctx.Provider value={{ openTask, openNodeLogs, close }}>
      {children}
      {target && (
        <Drawer
          title={
            <>
              <TerminalIcon className="h-4 w-4 text-indigo-500 shrink-0" />
              <span className="truncate">
                {target.kind === 'task'
                  ? target.title || `运维任务 ${target.taskId}`
                  : target.title || '节点实时服务日志'}
              </span>
              {taskStatus && <StatusBadge value={taskStatus} />}
            </>
          }
          subtitle={target.kind === 'task' ? `任务 ID: ${target.taskId}` : '实时流式输出（SSH journalctl）'}
          width="2xl"
          onClose={close}
          headerExtra={
            <div className="flex items-center gap-1.5">
              <label className="hidden sm:inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 mr-1">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                />
                <span>自动滚动</span>
              </label>
              <button
                type="button"
                disabled={!logs}
                onClick={() => void handleCopyLogs()}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? '已复制' : '复制日志'}</span>
              </button>
            </div>
          }
          bodyClassName="flex flex-col p-0 overflow-hidden bg-slate-950"
        >
          {steps.length > 0 && (
            <div className="max-h-48 overflow-y-auto border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 py-3 shrink-0">
              <div className="space-y-2 text-xs">
                {steps.map((s, idx) => (
                  <div key={s.id || idx} className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-slate-700 dark:text-slate-200">{s.name}</span>
                    <StatusBadge value={s.status} />
                  </div>
                ))}
              </div>
            </div>
          )}
          <pre
            ref={logRef}
            className="flex-1 overflow-auto bg-slate-950 p-5 font-mono text-xs leading-relaxed text-slate-100 whitespace-pre-wrap break-all"
          >
            {logs || '等待日志输出...'}
          </pre>
        </Drawer>
      )}
    </Ctx.Provider>
  );
}

export function useOpsDrawer() {
  return useContext(Ctx);
}
