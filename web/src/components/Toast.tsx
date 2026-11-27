import React, { createContext, useCallback, useContext, useState } from 'react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useI18n } from '../lib/i18n';

type ToastKind = 'success' | 'error' | 'info';
type ToastPosition = 'bottom-right' | 'top-right';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
  details?: string[];
  durationMs?: number;
  position?: ToastPosition;
  recordHistory?: boolean;
}

export interface ToastHistoryItem {
  id: string;
  kind: ToastKind;
  text: string;
  details?: string[];
  path: string;
  createdAt: number;
  read: boolean;
}

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  action?: ToastAction;
  details?: string[];
  position: ToastPosition;
}

type ToastArg = ToastAction | ToastOptions;

interface ToastContextValue {
  success: (text: string, arg?: ToastArg) => void;
  error: (text: string, arg?: ToastArg) => void;
  info: (text: string, arg?: ToastArg) => void;
  history: ToastHistoryItem[];
  unreadCount: number;
  unreadErrorCount: number;
  markHistoryRead: () => void;
  clearHistory: () => void;
  removeHistoryItem: (id: string) => void;
}

const HISTORY_KEY = 'nomad_deck_toast_history_v1';
const MAX_HISTORY = 80;

function loadStoredHistory(): ToastHistoryItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string')
      .slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

function saveStoredHistory(items: ToastHistoryItem[]) {
  if (typeof window === 'undefined') return;
  try {
    if (items.length === 0) {
      window.localStorage.removeItem(HISTORY_KEY);
    } else {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY)));
    }
  } catch {
    // Ignore storage quota or privacy-mode errors.
  }
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextToastId = 1;

function normalizeToastArg(arg?: ToastArg): ToastOptions {
  if (!arg) return {};
  if ('label' in arg && 'onClick' in arg) {
    return { action: arg };
  }
  return arg;
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { tr } = useI18n();
  const [items, setItems] = useState<ToastItem[]>([]);
  const [history, setHistory] = useState<ToastHistoryItem[]>(() => loadStoredHistory());

  const updateHistory = useCallback((updater: (prev: ToastHistoryItem[]) => ToastHistoryItem[]) => {
    setHistory((prev) => {
      const next = updater(prev).slice(0, MAX_HISTORY);
      saveStoredHistory(next);
      return next;
    });
  }, []);

  const markHistoryRead = useCallback(() => {
    updateHistory((prev) => prev.map((item) => (item.read ? item : { ...item, read: true })));
  }, [updateHistory]);

  const clearHistory = useCallback(() => {
    updateHistory(() => []);
  }, [updateHistory]);

  const removeHistoryItem = useCallback(
    (id: string) => {
      updateHistory((prev) => prev.filter((item) => item.id !== id));
    },
    [updateHistory],
  );

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string, arg?: ToastArg) => {
      if (!text) return;
      const opts = normalizeToastArg(arg);
      // 统一放右下角，避免遮挡顶部栏与页面操作按钮
      const position: ToastPosition = 'bottom-right';
      const id = nextToastId++;
      setItems((prev) => [
        ...prev.slice(-3),
        { id, kind, text, action: opts.action, details: opts.details, position },
      ]);
      if (opts.recordHistory !== false) {
        const hasAttentionContent = kind === 'error' || Boolean(opts.details && opts.details.length > 0);
        const entry: ToastHistoryItem = {
          id: `${Date.now()}-${id}`,
          kind,
          text,
          details: opts.details && opts.details.length > 0 ? [...opts.details] : undefined,
          path: typeof window !== 'undefined' ? window.location.pathname : '/',
          createdAt: Date.now(),
          read: !hasAttentionContent,
        };
        updateHistory((prev) => [entry, ...prev]);
      }
      const duration = opts.durationMs ?? (kind === 'error' ? 6000 : 3800);
      window.setTimeout(() => {
        dismiss(id);
      }, duration);
    },
    [dismiss, updateHistory],
  );

  const unreadCount = history.reduce((acc, item) => acc + (item.read ? 0 : 1), 0);
  const unreadErrorCount = history.reduce(
    (acc, item) => acc + (!item.read && item.kind === 'error' ? 1 : 0),
    0,
  );

  const value: ToastContextValue = {
    success: useCallback((text: string, arg?: ToastArg) => push('success', text, arg), [push]),
    error: useCallback((text: string, arg?: ToastArg) => push('error', text, arg), [push]),
    info: useCallback((text: string, arg?: ToastArg) => push('info', text, arg), [push]),
    history,
    unreadCount,
    unreadErrorCount,
    markHistoryRead,
    clearHistory,
    removeHistoryItem,
  };

  const renderSlot = (position: ToastPosition, positionClass: string) => {
    const slotItems = items.filter((item) => item.position === position);
    if (slotItems.length === 0) return null;
    return (
      <div
        aria-live="polite"
        aria-relevant="additions"
        className={`fixed ${positionClass} z-[110] flex flex-col gap-2 max-w-sm w-[calc(100vw-2rem)] pointer-events-none`}
      >
        {slotItems.map((item) => {
          const style =
            item.kind === 'success'
              ? 'bg-emerald-50/95 border-emerald-200/90 text-emerald-900 dark:bg-emerald-950/95 dark:border-emerald-800/80 dark:text-emerald-100'
              : item.kind === 'error'
              ? 'bg-rose-50/95 border-rose-200/90 text-rose-900 dark:bg-rose-950/95 dark:border-rose-800/80 dark:text-rose-100'
              : 'bg-white/95 border-indigo-200/90 text-slate-900 dark:bg-slate-900/95 dark:border-indigo-500/40 dark:text-slate-100';
          const icon =
            item.kind === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
            ) : item.kind === 'error' ? (
              <XCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
            ) : (
              <Info className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
            );
          return (
            <div
              key={item.id}
              role={item.kind === 'error' ? 'alert' : 'status'}
              className={`nd-toast-in pointer-events-auto flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl border shadow-xl backdrop-blur-md text-[13px] ${style}`}
            >
              {icon}
              <div className="flex-1 min-w-0 break-words">
                <div className="font-medium">{item.text}</div>
                {item.details && item.details.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs opacity-90">
                    {item.details.map((line, idx) => (
                      <li key={idx} className="break-words leading-5">
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
                {item.action && (
                  <button
                    type="button"
                    onClick={() => {
                      item.action?.onClick();
                      dismiss(item.id);
                    }}
                    className="mt-1 inline-flex items-center font-semibold underline underline-offset-2 hover:opacity-80"
                  >
                    {item.action.label}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="p-0.5 rounded opacity-60 hover:opacity-100 shrink-0"
                aria-label={tr('关闭通知', 'Close notification')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {renderSlot('top-right', 'top-4 right-4 sm:top-5 sm:right-5')}
      {renderSlot('bottom-right', 'bottom-4 right-4 sm:bottom-5 sm:right-5')}
    </ToastContext.Provider>
  );
};

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}
