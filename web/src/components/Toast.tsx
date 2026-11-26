import React, { createContext, useCallback, useContext, useState } from 'react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';

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
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string, arg?: ToastArg) => {
      if (!text) return;
      const opts = normalizeToastArg(arg);
      const position: ToastPosition = opts.position || 'bottom-right';
      const id = nextToastId++;
      setItems((prev) => [
        ...prev.slice(-4),
        { id, kind, text, action: opts.action, details: opts.details, position },
      ]);
      const duration = opts.durationMs ?? (kind === 'error' ? 6000 : 4000);
      window.setTimeout(() => {
        dismiss(id);
      }, duration);
    },
    [dismiss],
  );

  const value: ToastContextValue = {
    success: useCallback((text: string, arg?: ToastArg) => push('success', text, arg), [push]),
    error: useCallback((text: string, arg?: ToastArg) => push('error', text, arg), [push]),
    info: useCallback((text: string, arg?: ToastArg) => push('info', text, arg), [push]),
  };

  const renderSlot = (position: ToastPosition, positionClass: string) => {
    const slotItems = items.filter((item) => item.position === position);
    if (slotItems.length === 0) return null;
    return (
      <div
        aria-live="polite"
        aria-relevant="additions"
        className={`fixed ${positionClass} z-[110] flex flex-col gap-2 max-w-md w-[calc(100vw-2rem)] pointer-events-none`}
      >
        {slotItems.map((item) => {
          const style =
            item.kind === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900 dark:bg-emerald-950/95 dark:border-emerald-800 dark:text-emerald-100'
              : item.kind === 'error'
              ? 'bg-rose-50 border-rose-200 text-rose-900 dark:bg-rose-950/95 dark:border-rose-800 dark:text-rose-100'
              : 'bg-indigo-50 border-indigo-200 text-indigo-900 dark:bg-indigo-950/95 dark:border-indigo-800 dark:text-indigo-100';
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
              className={`pointer-events-auto flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl border shadow-lg text-sm ${style}`}
            >
              {icon}
              <div className="flex-1 min-w-0 break-words">
                <div className="font-medium">{item.text}</div>
                {item.details && item.details.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs opacity-90">
                    {item.details.map((line, idx) => (
                      <li key={idx} className="truncate font-mono">
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
                aria-label="关闭通知"
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
