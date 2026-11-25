import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle, Eye, EyeOff, Info, ExternalLink, Copy, Check, Inbox, Loader2 } from 'lucide-react';
import { copyText } from '../lib/clipboard';
import { useToast } from './Toast';
import { isTopDialog, registerDialog } from './dialogLayers';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-[#e3e8f1] bg-white shadow-[0_3px_12px_rgba(15,23,42,0.03)] dark:border-slate-800 dark:bg-slate-900 dark:shadow-[0_3px_16px_rgba(2,6,23,0.35)] ${className}`}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5 dark:border-slate-800">
          <div className="font-semibold text-sm text-slate-900 dark:text-slate-100">{title}</div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  );
}

type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue';

const statusLabels: Record<string, string> = {
  healthy: '健康', online: '在线', running: '运行中', success: '成功', succeeded: '成功',
  active: '运行中', ok: '正常', completed: '已完成', enabled: '已启用', ready: '就绪',
  initialized: '已初始化', uninitialized: '待部署', unknown: '待探测', degraded: '状态异常',
  pending: '等待中', waiting: '等待中', upgrading: '升级中', warn: '需关注', sealed: '已密封',
  init_in_doubt: '初始化待核对', needs_reconcile: '需核对', partial_success: '部分成功',
  timeout: '已超时', failed: '失败', failure: '失败', offline: '离线', unreachable: '无法连接',
  fail: '异常', rolled_back: '已回退', anomaly: '异常', timed_out: '已超时', disabled: '已停用',
  inactive: '未运行', interrupted: '已中断', sync: '同步', async: '异步', applied: '已应用',
};

const toneMap: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  green: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30',
  amber: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
  red: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30',
  blue: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-500/30',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneMap[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ value, label }: { value?: string; label?: string }) {
  const v = (value || '').toLowerCase();
  const tone = statusTone(v);
  const animated = v === 'running' || v === 'upgrading' || v === 'waiting';
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneMap[tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${animated ? 'animate-pulse' : ''}`} aria-hidden="true" />
      <span title={value}>{label || statusLabels[v] || value || '待探测'}</span>
    </span>
  );
}

export function statusTone(status?: string): Tone {
  switch ((status || '').toLowerCase()) {
    case 'healthy':
    case 'online':
    case 'running':
    case 'success':
    case 'succeeded':
    case 'active':
    case 'ok':
    case 'completed':
    case 'enabled':
    case 'ready':
    case 'initialized':
    case 'applied':
      return 'green';
    case 'degraded':
    case 'pending':
    case 'waiting':
    case 'upgrading':
    case 'warn':
    case 'sealed':
    case 'init_in_doubt':
    case 'needs_reconcile':
    case 'partial_success':
    case 'timeout':
      return 'amber';
    case 'failed':
    case 'failure':
    case 'offline':
    case 'unreachable':
    case 'fail':
    case 'rolled_back':
    case 'anomaly':
    case 'timed_out':
    case 'disabled':
    case 'inactive':
    case 'interrupted':
      return 'red';
    case 'sync':
    case 'async':
      return 'blue';
    default:
      return 'neutral';
  }
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  className = '',
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  loading?: boolean;
}) {
  const variants = {
    primary:
      'bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-400 shadow-[0_2px_6px_rgba(79,70,229,0.18)]',
    secondary:
      'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700',
    danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-400',
    ghost: 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
  };
  const sizes = {
    sm: 'px-2.5 py-1.5 text-xs rounded-lg',
    md: 'px-3.5 py-2 text-sm rounded-[10px]',
  };
  return (
    <button
      type={rest.type || 'button'}
      {...rest}
      disabled={Boolean(disabled || loading)}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-1.5 font-medium transition disabled:cursor-not-allowed disabled:opacity-55 ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />}
      {children}
    </button>
  );
}

export function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-indigo-500 disabled:opacity-50 ${
        checked ? 'bg-indigo-600' : 'bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}

export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; below: boolean }>({ top: 0, left: 0, below: false });
  const ref = useRef<HTMLSpanElement>(null);

  const show = () => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const below = rect.top < 110;
    const left = Math.min(Math.max(rect.left + rect.width / 2, 136), window.innerWidth - 136);
    setPos({
      top: below ? rect.bottom + 6 : rect.top - 6,
      left,
      below,
    });
    setOpen(true);
  };

  return (
    <>
      <span
        ref={ref}
        tabIndex={0}
        role="note"
        aria-label={text}
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={(e) => e.stopPropagation()}
        className="ml-0.5 inline-flex -translate-y-0.5 cursor-help items-center align-super text-slate-400 transition hover:text-indigo-600 focus:outline-none dark:text-slate-500 dark:hover:text-indigo-400"
      >
        <Info className="h-3 w-3" />
      </span>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              transform: pos.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            }}
            className="pointer-events-none z-[80] w-64 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-[11px] font-normal leading-relaxed text-slate-100 shadow-lg dark:border-slate-600 dark:bg-slate-800"
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}

export function TermLabel({ term, tip }: { term: React.ReactNode; tip: string }) {
  return (
    <span className="inline-flex items-baseline">
      <span>{term}</span>
      <InfoTip text={tip} />
    </span>
  );
}

export function ExternalUrlLink({ url, empty = '-' }: { url?: string; empty?: string }) {
  const val = (url || '').trim();
  if (!val) return <span className="font-mono text-slate-500">{empty}</span>;
  if (/^https?:\/\//i.test(val)) {
    return (
      <a
        href={val}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 font-mono text-indigo-600 hover:underline dark:text-indigo-400"
      >
        <span>{val}</span>
        <ExternalLink className="h-3 w-3 shrink-0" />
      </a>
    );
  }
  return <span className="font-mono text-slate-500">{val}</span>;
}

export function Input({
  label,
  hint,
  className = '',
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label?: React.ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1.5">
      {label && <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">{label}</span>}
      <input
        {...rest}
        className={`w-full rounded-lg border border-[#dce3ee] bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 ${className}`}
      />
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

const STORED_MASK = '********';

export function SecretInput({
  label,
  hint,
  value,
  onChangeValue,
  hasStoredValue = false,
  onRevealStored,
  resetKey,
  className = '',
  disabled,
  required,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  label?: React.ReactNode;
  hint?: string;
  value: string;
  onChangeValue: (val: string) => void;
  hasStoredValue?: boolean;
  onRevealStored?: () => Promise<string>;
  resetKey?: string | number | boolean;
}) {
  const [showPlain, setShowPlain] = useState(false);
  const [touched, setTouched] = useState(false);
  const [revealedText, setRevealedText] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);

  useEffect(() => {
    setTouched(false);
    setRevealedText(null);
    setShowPlain(false);
  }, [hasStoredValue, resetKey]);

  const showingStoredMask = hasStoredValue && !touched && value === '' && revealedText === null;
  const showingRevealed = hasStoredValue && !touched && value === '' && revealedText !== null;
  const displayValue = showingStoredMask ? STORED_MASK : showingRevealed ? revealedText : value;

  const toggleShow = async () => {
    if (showPlain) {
      setShowPlain(false);
      return;
    }
    if (showingStoredMask && onRevealStored) {
      setRevealing(true);
      try {
        const pt = await onRevealStored();
        setRevealedText(pt);
        setShowPlain(true);
      } finally {
        setRevealing(false);
      }
      return;
    }
    setShowPlain(true);
  };

  return (
    <label className="block space-y-1.5">
      {label && <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">{label}</span>}
      <div className="relative">
        <input
          {...rest}
          disabled={disabled}
          required={required && !hasStoredValue}
          type={showPlain ? 'text' : 'password'}
          value={displayValue}
          onFocus={(e) => {
            if (showingStoredMask) {
              e.currentTarget.select();
            }
            rest.onFocus?.(e);
          }}
          onChange={(e) => {
            let next = e.target.value;
            if (showingStoredMask && next.startsWith(STORED_MASK) && next.length > STORED_MASK.length) {
              next = next.slice(STORED_MASK.length);
            }
            setTouched(true);
            setRevealedText(null);
            onChangeValue(next);
          }}
          className={`w-full rounded-lg border border-[#dce3ee] bg-white py-2 pl-3 pr-10 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 ${className}`}
        />
        <button
          type="button"
          disabled={revealing}
          onClick={() => void toggleShow()}
          title={showPlain ? '隐藏明文' : '显示明文'}
          aria-label={showPlain ? '隐藏明文' : '显示明文'}
          className="absolute inset-y-0 right-0 flex items-center px-2.5 text-slate-400 hover:text-indigo-600 disabled:opacity-50 dark:text-slate-500 dark:hover:text-indigo-400"
        >
          {revealing ? <Loader2 className="h-4 w-4 animate-spin" /> : showPlain ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function MaskedSecret({ value, label }: { value: string; label?: React.ReactNode }) {
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await copyText(value);
      setCopied(true);
      toast.success('已复制到剪贴板');
      window.setTimeout(() => setCopied(false), 1500);
    } catch (ex: any) {
      toast.error(ex?.message || '复制失败，请手动复制');
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-indigo-200/70 bg-indigo-50/50 px-3.5 py-2.5 dark:border-indigo-500/30 dark:bg-indigo-950/30">
      {label && <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{label}</span>}
      <code className="rounded-lg bg-slate-900 px-2.5 py-1 font-mono text-xs text-indigo-300 dark:bg-slate-950 break-all">
        {show ? value : '****************'}
      </code>
      <Button type="button" size="sm" onClick={() => setShow((v) => !v)}>
        {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        <span>{show ? '隐藏明文' : '显示明文'}</span>
      </Button>
      <Button type="button" size="sm" onClick={() => void copy()}>
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
        <span>{copied ? '已复制' : '复制'}</span>
      </Button>
    </div>
  );
}

export function Select({
  label,
  children,
  className = '',
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      {label && <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">{label}</span>}
      <select
        {...rest}
        className={`w-full rounded-lg border border-[#dce3ee] bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 ${className}`}
      >
        {children}
      </select>
    </label>
  );
}

export function ErrorAlert({ message, onClose }: { message: string; onClose?: () => void }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-200"
    >
      <div className="flex items-start gap-2.5 min-w-0">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
        <span className="break-words">{message}</span>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭错误提示"
          className="rounded-lg p-1 hover:bg-rose-100 dark:hover:bg-rose-900/60"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  text,
  title,
  description,
  action,
  icon,
}: {
  text?: string;
  title?: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  const heading = title || text || '暂无数据';
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon || <Inbox className="h-6 w-6" />}</div>
      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{heading}</div>
      {description && <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm leading-6">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = '正在加载...' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 p-10 text-sm text-slate-500 dark:text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin text-indigo-500 dark:text-indigo-400" />
      <span>{label}</span>
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  wide = false,
  size,
  busy = false,
  dismissible = true,
  backdropClassName = '',
  footer,
}: {
  open: boolean;
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  size?: 'md' | 'lg' | 'xl';
  busy?: boolean;
  dismissible?: boolean;
  backdropClassName?: string;
  footer?: React.ReactNode;
}) {
  if (!open) return null;
  const resolvedSize = size || (wide ? 'xl' : 'lg');
  return (
    <ModalDialog
      title={title}
      onClose={onClose}
      size={resolvedSize}
      busy={busy}
      dismissible={dismissible}
      backdropClassName={backdropClassName}
      footer={footer}
    >
      {children}
    </ModalDialog>
  );
}

function ModalDialog({
  title,
  onClose,
  children,
  size,
  busy,
  dismissible,
  backdropClassName,
  footer,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  size: 'md' | 'lg' | 'xl';
  busy: boolean;
  dismissible: boolean;
  backdropClassName: string;
  footer?: React.ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const blockedRef = useRef(false);
  closeRef.current = onClose;
  blockedRef.current = busy || !dismissible;

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

    const first =
      el.querySelector<HTMLElement>('[data-autofocus]') ||
      el.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)');
    (first || focusable()[0] || el)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopDialog(el)) return;
      if (event.key === 'Escape' && !blockedRef.current) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === 'Tab') {
        const elements = focusable();
        const firstEl = elements[0];
        const lastEl = elements[elements.length - 1];
        if (!firstEl) {
          event.preventDefault();
          el.focus();
        } else if (event.shiftKey && (document.activeElement === firstEl || document.activeElement === el)) {
          event.preventDefault();
          lastEl.focus();
        } else if (!event.shiftKey && document.activeElement === lastEl) {
          event.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      unregister();
    };
  }, []);

  const maxW = size === 'md' ? 'max-w-md' : size === 'xl' ? 'max-w-4xl' : 'max-w-xl';

  return createPortal(
    <div
      className={`modal-backdrop ${backdropClassName}`.trim()}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy && dismissible) onClose();
      }}
    >
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : '对话窗口'}
        aria-busy={busy}
        tabIndex={-1}
        className={`modal-container ${maxW} max-h-[calc(100dvh-40px)] flex flex-col overflow-hidden border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200/80 px-6 py-4 shrink-0 dark:border-slate-800">
          <h3 className="font-semibold text-base text-slate-900 dark:text-slate-100 truncate">{title}</h3>
          {dismissible && (
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              aria-label="关闭弹窗"
              className="modal-close shrink-0 disabled:opacity-40"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain p-6">{children}</div>
        {footer && <div className="shrink-0 border-t border-slate-200 bg-white px-6 py-4 dark:border-slate-800 dark:bg-slate-900">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function PasswordConfirmModal({
  open,
  title,
  description,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  onConfirm: (password: string) => Promise<void>;
}) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPw('');
      setErr('');
    }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await onConfirm(pw);
      setPw('');
      onClose();
    } catch (ex: any) {
      setErr(ex?.message || '操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={title} onClose={onClose} size="md" busy={busy}>
      <form onSubmit={submit} className="space-y-4">
        {description && <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">{description}</p>}
        <ErrorAlert message={err} onClose={() => setErr('')} />
        <SecretInput
          label="当前管理员密码（二次验证）"
          required
          data-autofocus
          value={pw}
          onChangeValue={setPw}
          resetKey={open}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? '验证中...' : '确认执行'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function SectionTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: string; label: React.ReactNode; tip?: string; badge?: string | number }>;
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <nav
      role="tablist"
      aria-label="页面分区"
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        onChange(tabs[next].id);
        buttons[next]?.focus();
      }}
      className="max-w-full overflow-x-auto bg-white dark:bg-slate-900 rounded-xl border border-[#e3e8f1] dark:border-slate-800 p-1.5 inline-flex items-center gap-1 shadow-[0_2px_8px_rgba(15,23,42,0.02)]"
    >
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-[10px] px-3.5 py-2 text-xs sm:text-sm transition whitespace-nowrap border ${
              isActive
                ? 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-500/30 font-semibold'
                : 'border-transparent text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white font-medium'
            }`}
          >
            <span>{t.label}</span>
            {t.tip && <InfoTip text={t.tip} />}
            {t.badge !== undefined && (
              <span
                className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded font-medium leading-none ${
                  isActive
                    ? 'bg-indigo-100 dark:bg-indigo-500/25 text-indigo-700 dark:text-indigo-200'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                }`}
              >
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

export function Sparkline({
  values,
  max = 100,
  color = '#4f46e5',
  label,
}: {
  values: number[];
  max?: number;
  color?: string;
  label?: string;
}) {
  const pts = values.length > 1 ? values : [values[0] || 0, values[0] || 0];
  const m = Math.max(max, ...pts, 1);
  const coords = pts
    .map((v, i) => {
      const x = (i / (pts.length - 1)) * 160;
      const y = 36 - (Math.min(v, m) / m) * 32;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <div className="flex items-center gap-2">
      <svg width="160" height="40" className="rounded-lg bg-slate-100 dark:bg-slate-950">
        <polyline fill="none" stroke={color} strokeWidth="2" points={coords} />
      </svg>
      {label && <span className="text-xs font-mono text-slate-600 dark:text-slate-300">{label}</span>}
    </div>
  );
}
