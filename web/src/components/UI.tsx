import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle, Eye, EyeOff, Info, ExternalLink, Copy, Check } from 'lucide-react';

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
      className={`rounded-lg border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900 ${className}`}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div className="font-semibold text-sm text-slate-900 dark:text-slate-100">{title}</div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue';

const toneMap: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  red: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
  blue: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${toneMap[tone]}`}>
      {children}
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
      return 'green';
    case 'degraded':
    case 'pending':
    case 'waiting':
    case 'upgrading':
    case 'warn':
    case 'sealed':
    case 'init_in_doubt':
    case 'needs_reconcile':
      return 'amber';
    case 'failed':
    case 'offline':
    case 'unreachable':
    case 'fail':
    case 'rolled_back':
    case 'anomaly':
    case 'timed_out':
      return 'red';
    default:
      return 'neutral';
  }
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
}) {
  const variants = {
    primary: 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-400',
    secondary:
      'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700',
    danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-400',
    ghost: 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
  };
  const sizes = {
    sm: 'px-2.5 py-1 text-xs',
    md: 'px-3.5 py-1.5 text-sm',
  };
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {children}
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
        className="ml-0.5 inline-flex -translate-y-0.5 cursor-help items-center align-super text-slate-400 transition hover:text-emerald-600 focus:outline-none dark:text-slate-500 dark:hover:text-emerald-400"
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
            className="pointer-events-none z-50 w-64 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-2 text-[11px] font-normal leading-relaxed text-slate-100 shadow-lg dark:border-slate-600 dark:bg-slate-800"
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
        className="inline-flex items-center gap-1 font-mono text-emerald-600 hover:underline dark:text-emerald-400"
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
    <label className="block space-y-1">
      {label && <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">{label}</span>}
      <input
        {...rest}
        className={`w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 ${className}`}
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
    <label className="block space-y-1">
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
          className={`w-full rounded-md border border-slate-300 bg-white py-1.5 pl-3 pr-9 text-sm text-slate-900 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 ${className}`}
        />
        <button
          type="button"
          disabled={revealing}
          onClick={() => void toggleShow()}
          title={showPlain ? '隐藏明文' : '显示明文'}
          aria-label={showPlain ? '隐藏明文' : '显示明文'}
          className="absolute inset-y-0 right-0 flex items-center px-2.5 text-slate-400 hover:text-slate-700 disabled:opacity-50 dark:text-slate-500 dark:hover:text-slate-200"
        >
          {showPlain ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function MaskedSecret({ value, label }: { value: string; label?: React.ReactNode }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {label && <span className="text-slate-600 dark:text-slate-300">{label}</span>}
      <code className="rounded bg-slate-900 px-2 py-1 font-mono text-xs text-emerald-300 dark:bg-slate-950">
        {show ? value : '****************'}
      </code>
      <Button type="button" size="sm" onClick={() => setShow((v) => !v)}>
        {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        <span>{show ? '隐藏明文' : '显示明文'}</span>
      </Button>
      <Button type="button" size="sm" onClick={copy}>
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
    <label className="block space-y-1">
      {label && <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">{label}</span>}
      <select
        {...rest}
        className={`w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-emerald-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 ${className}`}
      >
        {children}
      </select>
    </label>
  );
}

export function ErrorAlert({ message, onClose }: { message: string; onClose?: () => void }) {
  if (!message) return null;
  return (
    <div className="flex items-start justify-between gap-2 rounded-md border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-200">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{message}</span>
      </div>
      {onClose && (
        <button onClick={onClose} className="rounded p-0.5 hover:bg-rose-100 dark:hover:bg-rose-900">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export function EmptyState({ text }: { text: string }) {
  return <div className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">{text}</div>;
}

export function Modal({
  open,
  title,
  onClose,
  children,
  wide = false,
}: {
  open: boolean;
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div
        className={`max-h-[90vh] w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900 ${
          wide ? 'max-w-4xl' : 'max-w-lg'
        }`}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <h3 className="font-semibold text-sm">{title}</h3>
          <button onClick={onClose} className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
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
    <Modal open={open} title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {description && <p className="text-sm text-slate-600 dark:text-slate-300">{description}</p>}
        <ErrorAlert message={err} />
        <SecretInput
          label="当前管理员密码（二次验证）"
          required
          value={pw}
          onChangeValue={setPw}
          resetKey={open}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
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
  tabs: Array<{ id: string; label: React.ReactNode; tip?: string }>;
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`inline-flex items-center border-b-2 px-3.5 py-2 text-sm font-medium transition ${
            active === t.id
              ? 'border-emerald-600 text-emerald-600 dark:border-emerald-400 dark:text-emerald-400'
              : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
          }`}
        >
          <span>{t.label}</span>
          {t.tip && <InfoTip text={t.tip} />}
        </button>
      ))}
    </div>
  );
}

export function Sparkline({
  values,
  max = 100,
  color = '#10b981',
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
      <svg width="160" height="40" className="rounded bg-slate-100 dark:bg-slate-950">
        <polyline fill="none" stroke={color} strokeWidth="2" points={coords} />
      </svg>
      {label && <span className="text-xs font-mono text-slate-600 dark:text-slate-300">{label}</span>}
    </div>
  );
}
