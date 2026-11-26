import { useEffect, useRef, useState } from 'react';
import { apiGet, openSSE } from './api';
import type { TaskProgress } from './selfUpdate';

interface TaskStreamCallbacks {
  onRestartStage?: () => void;
  onDone?: (status: string, error?: string) => void;
  onError?: (lastStage: string) => void;
}

/**
 * 跟踪一个后台自更新/回退任务的阶段进度：先读取一次任务详情快照（刷新页面后可接着显示），
 * 随后通过 SSE 持续接收实时阶段与下载速率（字节/秒）。
 */
export function useTaskProgress(taskId: string | null | undefined, callbacks?: TaskStreamCallbacks) {
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [status, setStatus] = useState('');
  const [speed, setSpeed] = useState(0);

  const sampleRef = useRef<{ at: number; done: number } | null>(null);
  const stageRef = useRef('');
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  useEffect(() => {
    setProgress(null);
    setStatus('');
    setSpeed(0);
    sampleRef.current = null;
    stageRef.current = '';

    if (!taskId) return;
    let active = true;
    let restartedNotified = false;

    const accept = (next: TaskProgress | null | undefined) => {
      if (!active || !next) return;
      if (next.stage) stageRef.current = next.stage;
      if (next.stage === 'download' && typeof next.done === 'number' && next.done > 0) {
        const now = Date.now();
        const prev = sampleRef.current;
        if (prev && next.done > prev.done && now > prev.at) {
          const instant = ((next.done - prev.done) * 1000) / (now - prev.at);
          setSpeed((s) => (s ? s * 0.6 + instant * 0.4 : instant));
        }
        sampleRef.current = { at: now, done: next.done };
      }
      setProgress(next);
      if (next.stage === 'restart' && !restartedNotified) {
        restartedNotified = true;
        cbRef.current?.onRestartStage?.();
      }
    };

    void apiGet<{ operation?: { status?: string }; progress?: TaskProgress | null }>(`/api/v1/operations/${taskId}`)
      .then((res) => {
        if (!active) return;
        if (res.operation?.status) setStatus(res.operation.status);
        if (res.progress) accept(res.progress);
      })
      .catch(() => {});

    const close = openSSE(`/api/v1/operations/${taskId}/stream`, {
      onEvent: (ev, data) => {
        if (!active) return;
        if (ev === 'progress' && data?.progress) {
          accept(data.progress as TaskProgress);
        } else if (ev === 'done' && data) {
          close();
          const st = data.status || '';
          setStatus(st);
          cbRef.current?.onDone?.(st, data.error);
        }
      },
      onError: () => {
        if (!active) return;
        cbRef.current?.onError?.(stageRef.current);
      },
    });

    return () => {
      active = false;
      close();
    };
  }, [taskId]);

  return { progress, status, speed };
}
