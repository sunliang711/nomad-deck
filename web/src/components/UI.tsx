import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle, Eye, EyeOff, Info, ExternalLink, Copy, Check, Inbox, Loader2, ChevronDown, Search, Languages, Moon, Sun } from 'lucide-react';
import { copyText } from '../lib/clipboard';
import { useI18n } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import { useToast } from './Toast';
import { isTopDialog, registerDialog } from './dialogLayers';

export function LocaleToggleButton() {
  const { locale, toggleLocale, tr } = useI18n();
  const label = tr('Switch to English', '切换为中文');
  return (
    <button
      type="button"
      onClick={toggleLocale}
      title={label}
      aria-label={label}
      data-testid="locale-toggle"
      className="inline-flex items-center justify-center gap-1.5 h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/80 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white transition"
    >
      <Languages className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
      <span>{locale === 'zh' ? '中文' : 'EN'}</span>
    </button>
  );
}

export function ThemeToggleButton() {
  const { theme, toggle } = useTheme();
  const { tr } = useI18n();
  const label =
    theme === 'dark'
      ? tr('切换到浅色主题', 'Switch to light theme')
      : tr('切换到深色主题', 'Switch to dark theme');
  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      className="inline-flex items-center justify-center h-8 w-8 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/80 text-slate-600 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white transition"
    >
      {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
    </button>
  );
}

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
      {actions && <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className = '',
  bodyClassName = 'p-5',
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-[#e3e8f1] bg-white shadow-[0_2px_10px_rgba(15,23,42,0.03)] dark:border-slate-800/90 dark:bg-[#0f172a]/95 dark:shadow-[0_4px_20px_rgba(2,6,23,0.4)] ${className}`}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5 dark:border-slate-800/90">
          <div className="min-w-0">
            <div className="font-semibold text-sm text-slate-900 dark:text-slate-100">{title}</div>
            {description && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">{actions}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}

type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue';

const statusLabelsZh: Record<string, string> = {
  healthy: '健康', online: '在线', running: '运行中', success: '成功', succeeded: '成功', successful: '成功',
  active: '运行中', ok: '正常', completed: '已完成', complete: '已完成', enabled: '已启用', ready: '就绪',
  alive: '存活', leaving: '离开中', left: '已退出', stopped: '已停止', ineligible: '不可调度', draining: '排空中',
  initialized: '已初始化', uninitialized: '待部署', unknown: '待探测', degraded: '状态异常',
  pending: '等待中', waiting: '等待中', upgrading: '升级中', warn: '需关注', sealed: '已密封',
  init_in_doubt: '初始化待核对', needs_reconcile: '需核对', needs_reapply: '需重新应用', partial_success: '部分成功',
  timeout: '已超时', failed: '失败', failure: '失败', offline: '离线', unreachable: '无法连接',
  fail: '异常', rolled_back: '已回退', anomaly: '异常', timed_out: '已超时', cancelled: '已取消', idle: '空闲', disabled: '已停用',
  inactive: '未运行', interrupted: '已中断', sync: '同步', async: '异步', applied: '已应用', draft: '草稿', drifted: '已漂移', skipped: '已跳过',
};

const statusLabelsEn: Record<string, string> = {
  healthy: 'Healthy', online: 'Online', running: 'Running', success: 'Success', succeeded: 'Succeeded', successful: 'Succeeded',
  active: 'Active', ok: 'OK', completed: 'Completed', complete: 'Complete', enabled: 'Enabled', ready: 'Ready',
  alive: 'Alive', leaving: 'Leaving', left: 'Left', stopped: 'Stopped', ineligible: 'Ineligible', draining: 'Draining',
  initialized: 'Initialized', uninitialized: 'Pending Deploy', unknown: 'Pending Probe', degraded: 'Degraded',
  pending: 'Pending', waiting: 'Waiting', upgrading: 'Upgrading', warn: 'Warning', sealed: 'Sealed',
  init_in_doubt: 'Init Uncertain', needs_reconcile: 'Needs Reconcile', needs_reapply: 'Needs Re-apply', partial_success: 'Partial Success',
  timeout: 'Timed Out', failed: 'Failed', failure: 'Failure', offline: 'Offline', unreachable: 'Unreachable',
  fail: 'Error', rolled_back: 'Rolled Back', anomaly: 'Anomaly', timed_out: 'Timed Out', cancelled: 'Cancelled', idle: 'Idle', disabled: 'Disabled',
  inactive: 'Inactive', interrupted: 'Interrupted', sync: 'Sync', async: 'Async', applied: 'Applied', draft: 'Draft', drifted: 'Drifted', skipped: 'Skipped',
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
  const { isEn, tr } = useI18n();
  const v = (value || '').toLowerCase();
  const tone = statusTone(v);
  const animated = v === 'running' || v === 'upgrading' || v === 'waiting';
  const labels = isEn ? statusLabelsEn : statusLabelsZh;
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneMap[tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${animated ? 'animate-pulse' : ''}`} aria-hidden="true" />
      <span title={value}>{label || labels[v] || value || tr('待探测', 'Pending Probe')}</span>
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
    case 'successful':
    case 'active':
    case 'ok':
    case 'completed':
    case 'complete':
    case 'enabled':
    case 'ready':
    case 'alive':
    case 'initialized':
    case 'applied':
      return 'green';
    case 'degraded':
    case 'pending':
    case 'waiting':
    case 'upgrading':
    case 'warn':
    case 'sealed':
    case 'draining':
    case 'leaving':
    case 'ineligible':
    case 'init_in_doubt':
    case 'needs_reconcile':
    case 'needs_reapply':
    case 'partial_success':
    case 'timeout':
    case 'drifted':
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
  variant?: 'primary' | 'secondary' | 'danger' | 'danger-outline' | 'ghost';
  size?: 'sm' | 'md';
  loading?: boolean;
}) {
  const variants = {
    primary:
      'bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-400 shadow-[0_2px_6px_rgba(79,70,229,0.22)]',
    secondary:
      'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-300 dark:border-slate-700/90 dark:bg-slate-800/90 dark:text-slate-200 dark:hover:bg-slate-700/90 dark:hover:border-slate-600',
    danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-400 shadow-[0_2px_6px_rgba(225,29,72,0.18)]',
    'danger-outline':
      'border border-rose-200/90 bg-white text-rose-600 hover:bg-rose-50 hover:border-rose-300 dark:border-rose-500/35 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:bg-rose-500/20 dark:hover:border-rose-500/50',
    ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white',
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
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium transition disabled:cursor-not-allowed disabled:opacity-55 ${variants[variant]} ${sizes[size]} ${className}`}
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
        className="ml-1 inline-flex cursor-help items-center align-middle text-slate-400 transition hover:text-indigo-600 focus:outline-none dark:text-slate-500 dark:hover:text-indigo-400"
      >
        <Info className="h-3.5 w-3.5" />
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
    <span className="inline-flex items-center">
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
  const { tr } = useI18n();
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
          title={showPlain ? tr('隐藏明文', 'Hide plaintext') : tr('显示明文', 'Show plaintext')}
          aria-label={showPlain ? tr('隐藏明文', 'Hide plaintext') : tr('显示明文', 'Show plaintext')}
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
  const { tr } = useI18n();
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await copyText(value);
      setCopied(true);
      toast.success(tr('已复制到剪贴板', 'Copied to clipboard'), { recordHistory: false });
      window.setTimeout(() => setCopied(false), 1500);
    } catch (ex: any) {
      toast.error(ex?.message || tr('复制失败，请手动复制', 'Copy failed, please copy manually'));
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-indigo-200/70 bg-indigo-50/50 px-3.5 py-2.5 dark:border-indigo-500/30 dark:bg-indigo-950/30">
      <div className="flex items-center justify-between gap-2">
        {label ? (
          <span className="min-w-0 text-xs font-medium text-slate-700 dark:text-slate-200">{label}</span>
        ) : (
          <span />
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" size="sm" onClick={() => setShow((v) => !v)}>
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            <span>{show ? tr('隐藏明文', 'Hide') : tr('显示明文', 'Reveal')}</span>
          </Button>
          <Button type="button" size="sm" onClick={() => void copy()}>
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? tr('已复制', 'Copied') : tr('复制', 'Copy')}</span>
          </Button>
        </div>
      </div>
      <code className="block w-full rounded-lg bg-slate-900 px-3 py-2 font-mono text-xs text-indigo-300 dark:bg-slate-950 break-all">
        {show ? value : '****************'}
      </code>
    </div>
  );
}

interface ParsedSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
}

function extractSelectText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractSelectText).join('');
  if (React.isValidElement(node)) return extractSelectText((node.props as any).children);
  return '';
}

function parseSelectChildren(nodes: React.ReactNode, group?: string): ParsedSelectOption[] {
  const out: ParsedSelectOption[] = [];
  React.Children.forEach(nodes, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.type === React.Fragment) {
      out.push(...parseSelectChildren((child.props as any).children, group));
      return;
    }
    const props = child.props as any;
    if (child.type === 'optgroup') {
      out.push(...parseSelectChildren(props.children, props.label ? String(props.label) : undefined));
      return;
    }
    if (child.type === 'option') {
      const label = extractSelectText(props.children);
      const val = props.value !== undefined ? String(props.value) : label;
      out.push({
        value: val,
        label: label || val,
        disabled: Boolean(props.disabled),
        group,
      });
    }
  });
  return out;
}

export function Select({
  label,
  children,
  className = '',
  size = 'md',
  searchable,
  value,
  defaultValue,
  disabled = false,
  required,
  name,
  id: propId,
  onChange,
  'aria-label': ariaLabel,
  title: propTitle,
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'children'> & {
  label?: React.ReactNode;
  size?: 'sm' | 'md';
  searchable?: boolean;
  children?: React.ReactNode;
}) {
  const { tr } = useI18n();
  const autoId = useId();
  const triggerId = propId || `${autoId}-trigger`;
  const listboxId = `${autoId}-listbox`;

  const options = useMemo(() => parseSelectChildren(children), [children]);
  const isControlled = value !== undefined;
  const [internalVal, setInternalVal] = useState<string>(() => {
    if (defaultValue !== undefined) return String(defaultValue);
    return options.find((o) => !o.disabled)?.value ?? '';
  });

  const currentVal = isControlled ? String(value) : internalVal;
  const selectedIdx = options.findIndex((o) => o.value === currentVal);
  const selectedOpt = selectedIdx >= 0 ? options[selectedIdx] : null;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typeaheadRef = useRef({ text: '', at: 0 });

  const showSearch = searchable ?? options.length >= 10;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!showSearch || !q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        (o.group && o.group.toLowerCase().includes(q)),
    );
  }, [options, query, showSearch]);

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    setQuery('');
    if (restoreFocus) triggerRef.current?.focus();
  };

  const openMenu = () => {
    if (disabled) return;
    setQuery('');
    const initial =
      selectedIdx >= 0 && !options[selectedIdx]?.disabled
        ? selectedIdx
        : Math.max(0, options.findIndex((o) => !o.disabled));
    setActiveIdx(initial);
    setOpen(true);
  };

  const commitValue = (opt: ParsedSelectOption) => {
    if (opt.disabled) return;
    if (!isControlled) setInternalVal(opt.value);
    if (onChange && opt.value !== currentVal) {
      const target = { value: opt.value, name: name || '' };
      onChange({ target, currentTarget: target } as unknown as React.ChangeEvent<HTMLSelectElement>);
    }
    closeMenu(true);
  };

  useLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const trg = triggerRef.current;
      if (!trg) return;
      const rect = trg.getBoundingClientRect();
      const maxH = 300;
      const below = Math.max(0, window.innerHeight - rect.bottom - 12);
      const above = Math.max(0, rect.top - 12);
      const estimatedH = panelRef.current ? Math.min(panelRef.current.scrollHeight, maxH) : Math.min(options.length * 36 + 56, maxH);
      const openUpwards = below < Math.min(estimatedH, 200) && above > below;
      const menuWidth = Math.min(Math.max(rect.width, 168), window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12));
      setMenuStyle({
        position: 'fixed',
        left,
        top: openUpwards ? undefined : rect.bottom + 6,
        bottom: openUpwards ? window.innerHeight - rect.top + 6 : undefined,
        width: menuWidth,
        maxHeight: Math.max(120, Math.min(maxH, openUpwards ? above : below)),
        visibility: 'visible',
      });
    };

    const onPointerDown = (e: Event) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !panelRef.current?.contains(t)) {
        closeMenu(false);
      }
    };

    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(true);
      }
    };

    place();
    const raf = window.requestAnimationFrame(place);
    if (showSearch) {
      window.setTimeout(() => searchRef.current?.focus(), 0);
    }
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onWindowKeyDown, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onWindowKeyDown, true);
    };
  }, [open, options.length, showSearch]);

  useEffect(() => {
    if (!open || filtered.length === 0) return;
    if (activeIdx >= filtered.length) {
      const next = filtered.findIndex((o) => !o.disabled);
      setActiveIdx(next >= 0 ? next : 0);
    }
    const el = panelRef.current?.querySelector<HTMLElement>(`[data-opt-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, filtered, open]);

  const moveActive = (delta: number) => {
    if (filtered.length === 0) return;
    for (let step = 1; step <= filtered.length; step++) {
      const idx = (activeIdx + delta * step + filtered.length * step) % filtered.length;
      if (!filtered[idx]?.disabled) {
        setActiveIdx(idx);
        return;
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openMenu();
      else moveActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) openMenu();
      else moveActive(-1);
    } else if (e.key === 'Home' && open) {
      e.preventDefault();
      const first = filtered.findIndex((o) => !o.disabled);
      if (first >= 0) setActiveIdx(first);
    } else if (e.key === 'End' && open) {
      e.preventDefault();
      for (let i = filtered.length - 1; i >= 0; i--) {
        if (!filtered[i].disabled) {
          setActiveIdx(i);
          break;
        }
      }
    } else if (e.key === 'Enter' || (e.key === ' ' && !showSearch)) {
      e.preventDefault();
      if (open) {
        const opt = filtered[activeIdx];
        if (opt && !opt.disabled) commitValue(opt);
      } else {
        openMenu();
      }
    } else if (e.key === 'Tab') {
      if (open) closeMenu(false);
    } else if (!showSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      typeaheadRef.current.text =
        (now - typeaheadRef.current.at < 700 ? typeaheadRef.current.text : '') + e.key.toLowerCase();
      typeaheadRef.current.at = now;
      const idx = filtered.findIndex(
        (o) => !o.disabled && o.label.toLowerCase().startsWith(typeaheadRef.current.text),
      );
      if (idx >= 0) {
        e.preventDefault();
        if (!open) setOpen(true);
        setActiveIdx(idx);
      }
    }
  };

  const triggerSizing =
    size === 'sm' ? 'px-2.5 py-1.5 text-xs rounded-lg gap-1.5' : 'px-3 py-2 text-sm rounded-lg gap-2';

  const isPlaceholder = selectedOpt ? selectedOpt.value === '' : !currentVal;
  const displayLabel = selectedOpt ? selectedOpt.label : currentVal || tr('请选择', 'Select...');

  return (
    <div className="relative block space-y-1.5">
      {label && (
        <label
          htmlFor={triggerId}
          onClick={(e) => {
            e.preventDefault();
            triggerRef.current?.focus();
          }}
          className="block text-xs font-medium text-slate-700 dark:text-slate-300 cursor-default"
        >
          {label}
        </label>
      )}
      {required && (
        <input
          type="text"
          tabIndex={-1}
          aria-hidden="true"
          required
          disabled={disabled}
          value={currentVal}
          onChange={() => {}}
          className="sr-only pointer-events-none absolute inset-0 h-0 w-0 opacity-0"
        />
      )}
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        aria-label={typeof ariaLabel === 'string' ? ariaLabel : typeof label === 'string' ? label : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        title={propTitle || displayLabel}
        onClick={(e) => {
          e.stopPropagation();
          if (open) closeMenu(false);
          else openMenu();
        }}
        onKeyDown={handleKeyDown}
        className={`flex w-full items-center justify-between border text-left transition focus:outline-none ${triggerSizing} ${
          disabled
            ? 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-500'
            : open
            ? 'border-indigo-400 bg-white text-slate-900 shadow-[0_0_0_3px_rgba(99,102,241,0.12)] dark:border-indigo-500 dark:bg-slate-950 dark:text-slate-100 dark:shadow-[0_0_0_3px_rgba(99,102,241,0.2)]'
            : 'border-[#dce3ee] bg-white text-slate-900 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:hover:border-slate-600'
        } ${className}`}
      >
        <span className={`min-w-0 flex-1 truncate ${isPlaceholder ? 'text-slate-400 dark:text-slate-500' : ''}`}>
          {displayLabel}
        </span>
        <ChevronDown
          className={`shrink-0 text-slate-400 transition-transform duration-150 ${
            size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'
          } ${open ? 'rotate-180 text-indigo-500 dark:text-indigo-400' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            id={listboxId}
            role="listbox"
            aria-label={typeof ariaLabel === 'string' ? ariaLabel : typeof label === 'string' ? label : tr('选项列表', 'Options')}
            style={menuStyle}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            className="nd-select-panel z-[90] flex flex-col overflow-hidden rounded-xl border border-slate-200/95 bg-white/98 p-1.5 shadow-[0_14px_38px_rgba(15,23,42,0.14),0_2px_8px_rgba(15,23,42,0.06)] backdrop-blur-md dark:border-slate-700/95 dark:bg-slate-900/98 dark:shadow-[0_18px_44px_rgba(2,6,23,0.72)]"
          >
            {showSearch && (
              <div className="relative mb-1.5 shrink-0">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActiveIdx(0);
                  }}
                  placeholder={tr('搜索选项…', 'Search options...')}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </div>
            )}

            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain">
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-slate-400 dark:text-slate-500">
                  {tr('没有匹配的选项', 'No matching options')}
                </div>
              ) : (
                filtered.map((opt, idx) => {
                  const prevGroup = idx > 0 ? filtered[idx - 1].group : undefined;
                  const showGroupHeader = Boolean(opt.group && opt.group !== prevGroup);
                  const isSelected = opt.value === currentVal;
                  const isActive = idx === activeIdx;

                  return (
                    <React.Fragment key={`${opt.group || ''}:${opt.value}:${idx}`}>
                      {showGroupHeader && (
                        <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold text-slate-400 dark:text-slate-500">
                          {opt.group}
                        </div>
                      )}
                      <button
                        type="button"
                        role="option"
                        data-opt-idx={idx}
                        aria-selected={isSelected}
                        aria-disabled={opt.disabled || undefined}
                        disabled={opt.disabled}
                        onMouseEnter={() => !opt.disabled && setActiveIdx(idx)}
                        onClick={(e) => {
                          e.stopPropagation();
                          commitValue(opt);
                        }}
                        className={`flex w-full items-center justify-between gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                          size === 'sm' ? 'text-xs' : 'text-[13px]'
                        } ${
                          opt.disabled
                            ? 'cursor-not-allowed text-slate-400 opacity-50 dark:text-slate-500'
                            : isSelected
                            ? 'bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200'
                            : isActive
                            ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                            : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'
                        }`}
                      >
                        <span className="min-w-0 flex-1 break-words leading-snug">{opt.label}</span>
                        {isSelected && (
                          <Check className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-300" aria-hidden="true" />
                        )}
                      </button>
                    </React.Fragment>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export function ErrorAlert({ message, onClose }: { message: string; onClose?: () => void }) {
  const { tr } = useI18n();
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
          aria-label={tr('关闭错误提示', 'Dismiss error')}
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
  const { tr } = useI18n();
  const heading = title || text || tr('暂无数据', 'No Data');
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon || <Inbox className="h-6 w-6" />}</div>
      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{heading}</div>
      {description && <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm leading-6">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function LoadingState({ label }: { label?: string }) {
  const { tr } = useI18n();
  return (
    <div role="status" className="flex items-center justify-center gap-2 p-10 text-sm text-slate-500 dark:text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin text-indigo-500 dark:text-indigo-400" />
      <span>{label || tr('正在加载...', 'Loading...')}</span>
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
  placement = 'center',
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
  placement?: 'center' | 'right';
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
      placement={placement}
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
  placement,
  footer,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  size: 'md' | 'lg' | 'xl';
  busy: boolean;
  dismissible: boolean;
  backdropClassName: string;
  placement: 'center' | 'right';
  footer?: React.ReactNode;
}) {
  const { tr } = useI18n();
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
      className={`modal-backdrop ${placement === 'right' ? 'justify-end p-0' : ''} ${backdropClassName}`.trim()}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy && dismissible) onClose();
      }}
    >
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : tr('对话窗口', 'Dialog')}
        aria-busy={busy}
        tabIndex={-1}
        className={`modal-container ${maxW} ${placement === 'right' ? 'h-dvh rounded-none sm:rounded-l-2xl' : 'max-h-[calc(100dvh-40px)]'} flex flex-col overflow-hidden border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200/80 px-6 py-4 shrink-0 dark:border-slate-800">
          <h3 className="font-semibold text-base text-slate-900 dark:text-slate-100 truncate">{title}</h3>
          {dismissible && (
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              aria-label={tr('关闭弹窗', 'Close modal')}
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
  const { tr } = useI18n();
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
      setErr(ex?.message || tr('操作失败', 'Operation failed'));
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
          label={tr('当前管理员密码（二次验证）', 'Current Admin Password (Verification)')}
          required
          data-autofocus
          value={pw}
          onChangeValue={setPw}
          resetKey={open}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? tr('验证中...', 'Verifying...') : tr('确认执行', 'Confirm')}
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
  variant = 'pill',
}: {
  tabs: Array<{ id: string; label: React.ReactNode; tip?: string; title?: string; badge?: string | number }>;
  active: string;
  onChange: (id: string) => void;
  variant?: 'pill' | 'underline';
}) {
  const { tr } = useI18n();
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    onChange(tabs[next].id);
    buttons[next]?.focus();
  };

  if (variant === 'underline') {
    return (
      <nav
        role="tablist"
        aria-label={tr('页面分区', 'Page sections')}
        onKeyDown={handleKeyDown}
        className="max-w-full overflow-x-auto scrollbar-none inline-flex items-center gap-1 border-b border-slate-200/80 dark:border-slate-800"
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
              title={t.title || t.tip}
              onClick={() => onChange(t.id)}
              className={`relative inline-flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-xs sm:text-[13px] whitespace-nowrap transition ${
                isActive
                  ? 'font-semibold text-indigo-600 dark:text-indigo-300'
                  : 'font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
              }`}
            >
              <span>{t.label}</span>
              {t.badge !== undefined && (
                <span
                  className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium leading-none ${
                    isActive
                      ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/25 dark:text-indigo-200'
                      : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                  }`}
                >
                  {t.badge}
                </span>
              )}
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-indigo-600 dark:bg-indigo-400"
                />
              )}
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <nav
      role="tablist"
      aria-label={tr('页面分区', 'Page sections')}
      onKeyDown={handleKeyDown}
      className="max-w-full overflow-x-auto scrollbar-none bg-white dark:bg-slate-900/95 rounded-xl border border-[#e3e8f1] dark:border-slate-800 p-1 inline-flex items-center gap-1 shadow-[0_2px_8px_rgba(15,23,42,0.02)]"
    >
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <div
            key={t.id}
            className={`inline-flex shrink-0 items-center rounded-[9px] transition border ${
              isActive
                ? 'bg-indigo-50/90 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-200 border-indigo-200/80 dark:border-indigo-500/35 shadow-[0_1px_2px_rgba(79,70,229,0.08)]'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/80 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              title={t.title}
              onClick={() => onChange(t.id)}
              className={`inline-flex items-center gap-1.5 rounded-[9px] py-1.5 text-xs sm:text-[13px] whitespace-nowrap ${
                t.tip ? 'pl-3 pr-1' : 'px-3'
              } ${isActive ? 'font-semibold' : 'font-medium'}`}
            >
              <span>{t.label}</span>
              {t.badge !== undefined && (
                <span
                  className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-md font-medium leading-none ${
                    isActive
                      ? 'bg-indigo-100 dark:bg-indigo-500/30 text-indigo-700 dark:text-indigo-100'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {t.badge}
                </span>
              )}
            </button>
            {t.tip && (
              <span className="pr-2 flex items-center">
                <InfoTip text={t.tip} />
              </span>
            )}
          </div>
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
