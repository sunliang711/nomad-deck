import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { isTopDialog, registerDialog } from './dialogLayers';

interface ConfirmOptions {
  title?: string;
  confirmText?: string;
  danger?: boolean;
}

type Confirm = (message: string, options?: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<Confirm | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const { tr } = useI18n();
  const descriptionId = useId();
  const [request, setRequest] = useState<({ message: string } & ConfirmOptions) | null>(null);
  const pending = useRef<((confirmed: boolean) => void) | null>(null);

  const askConfirm = useCallback<Confirm>((message, options = {}) => new Promise((resolve) => {
    // 同一个确认尚未处理时忽略重复触发，避免重复提交危险操作。
    if (pending.current) {
      resolve(false);
      return;
    }
    pending.current = resolve;
    setRequest({ message, ...options });
  }), []);

  useEffect(() => () => {
    pending.current?.(false);
    pending.current = null;
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(confirmed);
  }, []);

  return (
    <ConfirmContext.Provider value={askConfirm}>
      {children}
      {request && (
        <ConfirmDialogModal
          title={request.title || tr('操作确认', 'Confirm Action')}
          message={request.message}
          confirmText={request.confirmText || tr('确认', 'Confirm')}
          danger={Boolean(request.danger)}
          descriptionId={descriptionId}
          onClose={() => settle(false)}
          onConfirm={() => settle(true)}
        />
      )}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialogModal({
  title,
  message,
  confirmText,
  danger,
  descriptionId,
  onClose,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmText: string;
  danger: boolean;
  descriptionId: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { tr } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const unregister = registerDialog(el);
    const cancelBtn = el.querySelector<HTMLElement>('[data-autofocus]');
    cancelBtn?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopDialog(el)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      }
      if (event.key === 'Tab') {
        const focusables = Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled)')).filter(
          (node) => node.getClientRects().length > 0,
        );
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first) return;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === el)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      unregister();
    };
  }, []);

  return createPortal(
    <div className="modal-backdrop !z-[65]">
      <div
        ref={root}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="modal-container max-w-md"
      >
        <div className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl p-6 space-y-5">
          <button type="button" onClick={onClose} aria-label={tr('关闭确认框', 'Close confirmation dialog')} className="modal-close absolute right-3 top-3">
            <X className="w-4 h-4" />
          </button>
          <div className="flex items-start gap-3 pr-5">
            <div
              className={`w-10 h-10 shrink-0 rounded-xl grid place-items-center ${
                danger
                  ? 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400'
                  : 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400'
              }`}
            >
              <AlertTriangle aria-hidden="true" className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
              <p id={descriptionId} className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300 whitespace-pre-line break-words">
                {message}
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2.5">
            <button
              type="button"
              data-autofocus
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              {tr('取消', 'Cancel')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className={`px-4 py-2 rounded-lg text-sm font-medium text-white ${
                danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-indigo-600 hover:bg-indigo-500'
              }`}
            >
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used within ConfirmProvider');
  return confirm;
}

export interface BeforeNavigateDetail {
  waitUntil: (check: Promise<boolean>) => void;
}

export async function allowNavigation(): Promise<boolean> {
  const checks: Promise<boolean>[] = [];
  const event = new CustomEvent<BeforeNavigateDetail>('nomad-deck:before-navigate', {
    cancelable: true,
    detail: { waitUntil: (check) => checks.push(check) },
  });
  if (!window.dispatchEvent(event)) return false;
  return (await Promise.all(checks)).every(Boolean);
}
