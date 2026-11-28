import { useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import { getBlueprintNotes, type JobBlueprint } from '../lib/jobBlueprints';
import { Badge, Button } from './UI';
import type { PreflightCheck, PreflightFixAction } from './PreflightQuickFixModals';

export function JobPreflightPanel({
  checks,
  loading,
  error,
  blueprint,
  customDescription,
  clusterName,
  needsDeployment,
  isAdmin,
  onRefresh,
  onFixAction,
  defaultExpanded,
}: {
  checks: PreflightCheck[];
  loading: boolean;
  error?: string;
  blueprint?: JobBlueprint | null;
  customDescription?: string;
  clusterName?: string;
  needsDeployment?: boolean;
  isAdmin: boolean;
  onRefresh: () => void;
  onFixAction: (action: PreflightFixAction) => void;
  defaultExpanded?: boolean;
}) {
  const { locale, tr } = useI18n();
  const [userExpanded, setUserExpanded] = useState<boolean | null>(defaultExpanded ?? null);

  const errCount = checks.filter((c) => c.status === 'error').length;
  const warnCount = checks.filter((c) => c.status === 'warning').length;
  const okCount = checks.filter((c) => c.status === 'ok').length;
  const notes = blueprint ? getBlueprintNotes(blueprint, locale) : [];
  const hasNotes = notes.length > 0 || Boolean(customDescription?.trim());

  // Auto-expand whenever there are blockers or warnings; allow manual toggle anytime.
  const expanded = userExpanded !== null ? userExpanded : errCount > 0 || warnCount > 0 || Boolean(error);

  if (!loading && checks.length === 0 && !error && !hasNotes && !needsDeployment) {
    return null;
  }

  const borderTone =
    errCount > 0
      ? 'border-rose-200/90 bg-rose-50/40 dark:border-rose-500/35 dark:bg-rose-950/20'
      : warnCount > 0
        ? 'border-amber-200/90 bg-amber-50/40 dark:border-amber-500/35 dark:bg-amber-950/15'
        : 'border-slate-200/90 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-950/40';

  return (
    <div className={`rounded-xl border text-xs transition ${borderTone}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
        <button
          type="button"
          onClick={() => setUserExpanded(!expanded)}
          className="flex flex-wrap items-center gap-2 text-left"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          )}
          <span className="font-semibold text-slate-800 dark:text-slate-100">
            {tr('前置条件与环境体检', 'Prerequisites & Live Preflight')}
          </span>
          {clusterName && (
            <span className="text-[11px] text-slate-400 dark:text-slate-500">· {clusterName}</span>
          )}
          {loading ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              {tr('体检中…', 'Checking...')}
            </span>
          ) : needsDeployment ? (
            <Badge tone="neutral">{tr('集群尚未部署', 'Cluster not deployed')}</Badge>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {errCount > 0 && (
                <Badge tone="red">{tr(`${errCount} 项待补齐`, `${errCount} missing`)}</Badge>
              )}
              {warnCount > 0 && (
                <Badge tone="amber">{tr(`${warnCount} 项提醒`, `${warnCount} warning`)}</Badge>
              )}
              {okCount > 0 && (
                <Badge tone="green">{tr(`${okCount} 项已就绪`, `${okCount} ready`)}</Badge>
              )}
              {hasNotes && (
                <Badge tone="neutral">
                  {tr(`${notes.length + (customDescription?.trim() ? 1 : 0)} 条说明`, `${notes.length + (customDescription?.trim() ? 1 : 0)} note(s)`)}
                </Badge>
              )}
            </div>
          )}
        </button>

        {!needsDeployment && (
          <Button size="sm" disabled={loading} onClick={onRefresh}>
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            <span>{tr('重新体检', 'Re-check')}</span>
          </Button>
        )}
      </div>

      {expanded && (
        <div className="space-y-2.5 border-t border-slate-200/70 px-3.5 py-3 dark:border-slate-800/80">
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/25 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="leading-5">{error}</span>
            </div>
          )}

          {checks.length > 0 && (
            <div className="space-y-1.5">
              {checks.map((chk) => {
                const title = locale === 'en' ? chk.title_en || chk.title : chk.title;
                const detail = locale === 'en' ? chk.detail_en || chk.detail : chk.detail;
                const fix = chk.fix_action;
                const fixLabel = fix ? (locale === 'en' ? fix.label_en || fix.label : fix.label) : '';

                const rowStyle =
                  chk.status === 'error'
                    ? 'border-rose-200/80 bg-white dark:border-rose-500/30 dark:bg-slate-900/80'
                    : chk.status === 'warning'
                      ? 'border-amber-200/80 bg-white dark:border-amber-500/30 dark:bg-slate-900/80'
                      : 'border-emerald-200/70 bg-white/80 dark:border-emerald-500/20 dark:bg-slate-900/50';

                return (
                  <div
                    key={chk.id}
                    className={`flex flex-wrap items-center justify-between gap-2.5 rounded-lg border px-3 py-2 ${rowStyle}`}
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-2">
                      {chk.status === 'ok' ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      ) : chk.status === 'warning' ? (
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400" />
                      ) : (
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500 dark:text-rose-400" />
                      )}
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900 dark:text-slate-100">{title}</div>
                        {detail && (
                          <p className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{detail}</p>
                        )}
                      </div>
                    </div>

                    {fix && (
                      <div className="shrink-0">
                        {fix.type === 'link' && fix.path ? (
                          <Link
                            to={fix.path}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-indigo-500/50 dark:hover:text-indigo-300"
                          >
                            <span>{fixLabel || tr('前往配置', 'Configure')}</span>
                            <ArrowUpRight className="h-3 w-3" />
                          </Link>
                        ) : isAdmin && (fix.type === 'vault_role' || fix.type === 'vault_kv') ? (
                          <Button size="sm" variant="primary" onClick={() => onFixAction(fix)}>
                            {fix.type === 'vault_role' ? (
                              <ShieldCheck className="h-3.5 w-3.5" />
                            ) : (
                              <KeyRound className="h-3.5 w-3.5" />
                            )}
                            <span>{fixLabel || tr('一键补齐', 'Quick Fix')}</span>
                          </Button>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {customDescription?.trim() && (
            <div className="flex items-start gap-2 rounded-lg border border-slate-200/80 bg-white/80 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/60">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-500" />
              <div>
                <div className="font-medium text-slate-800 dark:text-slate-100">
                  {tr('自定义模板说明', 'Custom Template Note')}
                </div>
                <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-4 text-slate-600 dark:text-slate-300">
                  {customDescription.trim()}
                </p>
              </div>
            </div>
          )}

          {notes.length > 0 && (
            <div className="space-y-1.5 pt-0.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                <Sparkles className="h-3 w-3 text-indigo-500" />
                <span>{tr('使用说明与可选进阶', 'Notes & Optional Capabilities')}</span>
              </div>
              {notes.map((n, idx) => (
                <div
                  key={idx}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-slate-200/70 bg-white/80 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-slate-800 dark:text-slate-100">{n.title}</span>
                      <Badge tone={n.optional ? 'blue' : 'neutral'}>
                        {n.optional ? tr('可选进阶', 'Optional') : tr('运行说明', 'Runtime Note')}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{n.detail}</p>
                  </div>
                  {n.linkTo && (
                    <Link
                      to={n.linkTo}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                    >
                      <span>{n.linkLabel || tr('前往', 'Open')}</span>
                      <ArrowUpRight className="h-3 w-3" />
                    </Link>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
