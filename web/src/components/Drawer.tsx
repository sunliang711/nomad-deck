import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { isTopDialog, registerDialog } from './dialogLayers';

interface DrawerProps {
  title: React.ReactNode;
  subtitle?: string;
  onClose: () => void;
  busy?: boolean;
  width?: 'md' | 'lg' | 'xl' | '2xl';
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  bodyClassName?: string;
}

const widthClasses: Record<NonNullable<DrawerProps['width']>, string> = {
  md: 'max-w-[460px]',
  lg: 'max-w-[540px]',
  xl: 'max-w-[680px]',
  '2xl': 'max-w-[780px]',
};

export function Drawer({
  title,
  subtitle,
  onClose,
  busy = false,
  width = 'md',
  headerExtra,
  footer,
  children,
  bodyClassName = 'px-6 py-5 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200',
}: DrawerProps) {
  const { tr } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const blocked = useRef(false);
  close.current = onClose;
  blocked.current = busy;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const unregister = registerDialog(el);
    const focusable = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ),
      ).filter((node) => node.getClientRects().length > 0);

    (focusable()[0] || el)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopDialog(el)) return;
      if (event.key === 'Escape' && !blocked.current) {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key === 'Tab') {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first) {
          event.preventDefault();
          el.focus();
        } else if (event.shiftKey && (document.activeElement === first || document.activeElement === el)) {
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
    <div
      className="drawer-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : tr('详情抽屉', 'Details drawer')}
        aria-busy={busy}
        tabIndex={-1}
        className={`drawer-panel ${widthClasses[width]}`}
      >
        <div className="px-6 py-4 border-b border-slate-200/80 dark:border-slate-800 flex items-start justify-between gap-3 shrink-0 bg-white dark:bg-slate-900">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 truncate flex items-center gap-2">
              {title}
            </h2>
            {subtitle && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">{subtitle}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {headerExtra}
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label={tr('关闭抽屉', 'Close drawer')}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className={`flex-1 overflow-y-auto overscroll-contain ${bodyClassName}`}>{children}</div>
        {footer && (
          <div className="px-6 py-3.5 border-t border-slate-200/80 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 flex items-center justify-end gap-2 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
