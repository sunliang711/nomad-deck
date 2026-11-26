import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Check, CheckCircle2, Copy, Info, Trash2, XCircle } from 'lucide-react';
import { copyText } from '../lib/clipboard';
import { Drawer } from './Drawer';
import { Button, EmptyState } from './UI';
import { allowNavigation } from './ConfirmDialog';
import { useToast, type ToastHistoryItem } from './Toast';

function formatHistoryTime(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '-';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString('zh-CN', { hour12: false })}`;
}

export function NotificationDrawer({
  onClose,
  labelForPath,
}: {
  onClose: () => void;
  labelForPath: (path: string) => string;
}) {
  const navigate = useNavigate();
  const { history, unreadCount, markHistoryRead, clearHistory, removeHistoryItem } = useToast();
  const [filter, setFilter] = useState<'all' | 'error'>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const errorCount = history.filter((item) => item.kind === 'error').length;
  const visible = filter === 'error' ? history.filter((item) => item.kind === 'error') : history;

  const handleCopy = async (item: ToastHistoryItem) => {
    const body = item.details?.length ? `${item.text}\n${item.details.join('\n')}` : item.text;
    try {
      await copyText(body);
      setCopiedId(item.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === item.id ? null : cur)), 1500);
    } catch {
      // Clipboard unsupported; ignore silently inside notification drawer.
    }
  };

  const handleJump = async (path: string) => {
    if (!path) return;
    if (!(await allowNavigation())) return;
    onClose();
    navigate(path);
  };

  return (
    <Drawer
      title={
        <>
          <Bell className="h-4 w-4 text-indigo-500 shrink-0" />
          <span>消息历史</span>
        </>
      }
      subtitle="仅保存在当前浏览器本地（最多 80 条），退出登录后自动清除。"
      width="md"
      onClose={onClose}
      headerExtra={
        <div className="flex items-center gap-1.5">
          {unreadCount > 0 && (
            <Button size="sm" onClick={markHistoryRead}>
              全部已读
            </Button>
          )}
          {history.length > 0 && (
            <Button size="sm" onClick={clearHistory}>
              清空
            </Button>
          )}
        </div>
      }
      footer={
        <Button size="sm" variant="primary" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
              filter === 'all'
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
            }`}
          >
            全部 ({history.length})
          </button>
          <button
            type="button"
            onClick={() => setFilter('error')}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
              filter === 'error'
                ? 'bg-rose-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
            }`}
          >
            仅异常 ({errorCount})
          </button>
        </div>

        {visible.length === 0 ? (
          <EmptyState
            icon={<Bell className="h-6 w-6" />}
            title={filter === 'error' ? '暂无异常消息' : '暂无历史消息'}
            description={
              filter === 'error'
                ? '当前本地缓存中没有记录到错误提示。'
                : '主机探测、集群操作和接口反馈的提示消息会自动缓存在这里。'
            }
          />
        ) : (
          <div className="space-y-2.5">
            {visible.map((item) => {
              const Icon =
                item.kind === 'success' ? CheckCircle2 : item.kind === 'error' ? XCircle : Info;
              const toneCls =
                item.kind === 'success'
                  ? 'border-emerald-200/80 bg-emerald-50/50 dark:border-emerald-500/25 dark:bg-emerald-500/10'
                  : item.kind === 'error'
                    ? 'border-rose-200/80 bg-rose-50/50 dark:border-rose-500/25 dark:bg-rose-500/10'
                    : 'border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-950/40';
              const iconCls =
                item.kind === 'success'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : item.kind === 'error'
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-indigo-600 dark:text-indigo-400';

              return (
                <div key={item.id} className={`rounded-xl border p-3 text-xs ${toneCls}`}>
                  <div className="flex items-start gap-2.5">
                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconCls}`} />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-medium text-slate-900 dark:text-slate-100 break-words leading-5">
                          {!item.read && (
                            <span
                              aria-label="未读"
                              className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-indigo-500 align-middle"
                            />
                          )}
                          {item.text}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeHistoryItem(item.id)}
                          aria-label="删除此条消息"
                          className="rounded p-1 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200 shrink-0"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>

                      {item.details && item.details.length > 0 && (
                        <ul className="list-disc space-y-0.5 pl-4 text-slate-600 dark:text-slate-300 leading-5 break-words">
                          {item.details.map((line, i) => (
                            <li key={i}>{line}</li>
                          ))}
                        </ul>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                        <div className="flex items-center gap-2">
                          <span className="font-mono">{formatHistoryTime(item.createdAt)}</span>
                          <span>·</span>
                          <button
                            type="button"
                            onClick={() => void handleJump(item.path)}
                            className="text-indigo-600 hover:underline dark:text-indigo-400"
                          >
                            {labelForPath(item.path)}
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleCopy(item)}
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-200/70 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        >
                          {copiedId === item.id ? (
                            <>
                              <Check className="h-3 w-3 text-emerald-500" />
                              <span>已复制</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" />
                              <span>复制</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Drawer>
  );
}
