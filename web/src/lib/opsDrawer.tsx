import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { X, Terminal as TerminalIcon } from 'lucide-react';
import { apiGet, openSSE } from './api';

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
  const [target, setTarget] = useState<DrawerTarget | null>(null);
  const [steps, setSteps] = useState<Array<{ id?: string; name: string; status: string; error?: string }>>([]);
  const [taskStatus, setTaskStatus] = useState('');
  const [logs, setLogs] = useState('');
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!target) return;
    setSteps([]);
    setTaskStatus('');
    setLogs('');
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
            } else if (ev === 'done' && data?.error) {
              setLogs((prev) => prev + `\n[流结束] ${data.error}\n`);
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
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const openTask = (taskId: string, title?: string) => setTarget({ kind: 'task', taskId, title });
  const openNodeLogs = (clusterId: string, nodeId: string, title?: string) =>
    setTarget({ kind: 'node-logs', clusterId, nodeId, title });
  const close = () => setTarget(null);

  return (
    <Ctx.Provider value={{ openTask, openNodeLogs, close }}>
      {children}
      {target && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
          <div className="flex h-full w-full max-w-3xl flex-col bg-white shadow-2xl dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <TerminalIcon className="h-4 w-4 text-emerald-500" />
                <span className="font-semibold text-sm">
                  {target.kind === 'task'
                    ? target.title || `运维任务 ${target.taskId}`
                    : target.title || '节点实时服务日志'}
                </span>
                {taskStatus && (
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium dark:bg-slate-800">
                    {taskStatus}
                  </span>
                )}
              </div>
              <button
                onClick={close}
                className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {steps.length > 0 && (
              <div className="max-h-44 overflow-y-auto border-b border-slate-200 px-5 py-3 dark:border-slate-800">
                <div className="space-y-1.5 text-xs">
                  {steps.map((s, idx) => (
                    <div key={s.id || idx} className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{s.name}</span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 font-mono ${
                          s.status === 'success'
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                            : s.status === 'failed'
                              ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'
                              : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                        }`}
                      >
                        {s.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <pre
              ref={logRef}
              className="flex-1 overflow-auto bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-100 whitespace-pre-wrap break-all"
            >
              {logs || '等待日志输出...'}
            </pre>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useOpsDrawer() {
  return useContext(Ctx);
}
