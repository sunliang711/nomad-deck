import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { apiPost, wsURL } from '../lib/api';
import { ErrorAlert, Modal } from './UI';

export function TerminalModal({
  open,
  onClose,
  clusterId,
  allocId,
  task,
  command,
  action,
  title,
}: {
  open: boolean;
  onClose: () => void;
  clusterId: string;
  allocId: string;
  task: string;
  command?: string[];
  action?: string;
  title?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');
  const [status, setStatus] = useState('连接中...');

  useEffect(() => {
    if (!open || !clusterId || !allocId || !task) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let ro: ResizeObserver | null = null;

    setErr('');
    setStatus('正在申请一次性终端票据...');

    (async () => {
      try {
        const res = await apiPost<{ ticket: string }>(
          `/api/v1/nomad/${clusterId}/allocs/${allocId}/exec-ticket`,
          action ? { task, action } : { task, command: command && command.length ? command : ['/bin/sh'] },
        );
        if (disposed || !containerRef.current) return;

        term = new Terminal({
          cursorBlink: true,
          fontSize: 13,
          theme: { background: '#020617', foreground: '#e2e8f0' },
        });
        fit = new FitAddon();
        term.loadAddon(fit);
        term.open(containerRef.current);
        fit.fit();

        setStatus('正在建立 WebSocket 终端...');
        ws = new WebSocket(wsURL(`/api/v1/nomad/${clusterId}/allocs/${allocId}/exec?ticket=${encodeURIComponent(res.ticket)}`));
        ws.onopen = () => {
          setStatus('已连接');
          if (term && ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ version: 1, tty_size: { width: term.cols, height: term.rows } }));
          }
        };
        ws.onmessage = (ev) => {
          if (!term) return;
          if (typeof ev.data === 'string') {
            try {
              const frame = JSON.parse(ev.data);
              if (frame.stdout?.data) {
                term.write(atob(frame.stdout.data));
              } else if (frame.stderr?.data) {
                term.write(atob(frame.stderr.data));
              } else if (frame.error) {
                setErr(frame.error);
              }
              return;
            } catch {
              term.write(ev.data);
              return;
            }
          }
          if (ev.data instanceof Blob) {
            void ev.data.text().then((t) => term?.write(t));
          }
        };
        ws.onclose = (ev) => {
          setStatus(`已断开 (${ev.reason || ev.code})`);
        };
        ws.onerror = () => {
          setErr('终端连接出错');
        };
        term.onData((d) => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ stdin: { data: btoa(d) } }));
          }
        });
        term.onResize(({ cols, rows }) => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ tty_size: { width: cols, height: rows } }));
          }
        });
        ro = new ResizeObserver(() => fit?.fit());
        ro.observe(containerRef.current);
      } catch (ex: any) {
        setErr(ex?.message || '无法打开终端');
        setStatus('失败');
      }
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      ws?.close();
      term?.dispose();
    };
  }, [open, clusterId, allocId, task, action, JSON.stringify(command)]);

  return (
    <Modal open={open} title={title || `交互式终端 (${task})`} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Allocation: {allocId}</span>
          <span>状态：{status}</span>
        </div>
        <ErrorAlert message={err} />
        <div ref={containerRef} className="h-[420px] w-full overflow-hidden rounded bg-slate-950 p-1" />
      </div>
    </Modal>
  );
}
