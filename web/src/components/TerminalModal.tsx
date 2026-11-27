import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { apiPost, wsURL } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Button, ErrorAlert, Modal } from './UI';

const utf8Encoder = new TextEncoder();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function strToB64(s: string): string {
  const bytes = utf8Encoder.encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

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
  const { tr } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');
  const [statusKey, setStatusKey] = useState<'connecting' | 'ticket' | 'ws' | 'connected' | 'closed' | 'failed'>('connecting');
  const [closeReason, setCloseReason] = useState('');
  const [revision, setRevision] = useState(0);

  const statusText =
    statusKey === 'ticket'
      ? tr('正在申请一次性终端票据...', 'Requesting one-time terminal ticket...')
      : statusKey === 'ws'
      ? tr('正在建立 WebSocket 终端...', 'Connecting WebSocket terminal...')
      : statusKey === 'connected'
      ? tr('已连接', 'Connected')
      : statusKey === 'closed'
      ? tr(`已断开 (${closeReason})`, `Disconnected (${closeReason})`)
      : statusKey === 'failed'
      ? tr('失败', 'Failed')
      : tr('连接中...', 'Connecting...');

  useEffect(() => {
    if (!open || !clusterId || !allocId || !task) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let ro: ResizeObserver | null = null;

    setErr('');
    setCloseReason('');
    setStatusKey('ticket');

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

        setStatusKey('ws');
        ws = new WebSocket(wsURL(`/api/v1/nomad/${clusterId}/allocs/${allocId}/exec?ticket=${encodeURIComponent(res.ticket)}`));
        ws.onopen = () => {
          setStatusKey('connected');
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
                term.write(b64ToBytes(frame.stdout.data));
              } else if (frame.stderr?.data) {
                term.write(b64ToBytes(frame.stderr.data));
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
          setCloseReason(String(ev.reason || ev.code));
          setStatusKey('closed');
        };
        ws.onerror = () => {
          setErr(tr('终端连接出错', 'Terminal connection error'));
        };
        term.onData((d) => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ stdin: { data: strToB64(d) } }));
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
        setErr(ex?.message || tr('无法打开终端', 'Unable to open terminal'));
        setStatusKey('failed');
      }
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      ws?.close();
      term?.dispose();
    };
  }, [open, clusterId, allocId, task, action, JSON.stringify(command), revision]);

  return (
    <Modal open={open} title={title || tr(`交互式终端 (${task})`, `Interactive Terminal (${task})`)} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span className="break-all">Allocation: {allocId}</span>
          <span role="status">{tr('状态：', 'Status: ')}{statusText}</span>
          {(err || statusKey === 'closed') && <Button size="sm" onClick={() => setRevision((value) => value + 1)}>{tr('重新连接', 'Reconnect')}</Button>}
        </div>
        <ErrorAlert message={err} />
        <div ref={containerRef} className="h-[420px] w-full overflow-hidden rounded bg-slate-950 p-1" />
      </div>
    </Modal>
  );
}
