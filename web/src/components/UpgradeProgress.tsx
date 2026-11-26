import React, { useMemo } from 'react';
import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { formatMiB, type TaskProgress, type UpgradeStage } from '../lib/selfUpdate';

const UPGRADE_STEPS: Array<{ key: Exclude<UpgradeStage, 'done'>; title: string; detail: string }> = [
  { key: 'resolve', title: '查找版本', detail: '查询发布信息并核对当前平台程序包' },
  { key: 'download', title: '下载', detail: '下载对应架构程序包与校验文件' },
  { key: 'verify', title: '校验', detail: '核对 Ed25519 签名、SHA-256 并试运行新版本' },
  { key: 'install', title: '替换程序', detail: '在线备份数据库并原子替换可执行文件，保留上一版本' },
  { key: 'restart', title: '重启控制面服务', detail: '页面会短暂断开，托管中的 Nomad / Vault 集群不受影响' },
  { key: 'confirm', title: '确认新版本', detail: '等待重启后的服务报告目标版本' },
];

export function UpgradeProgress({
  stage,
  failed = false,
  progress = null,
  speed = 0,
  target = '',
}: {
  stage: UpgradeStage;
  failed?: boolean;
  progress?: TaskProgress | null;
  /** 下载速度（字节/秒）。 */
  speed?: number;
  target?: string;
}) {
  const activeIdx = stage === 'done' ? UPGRADE_STEPS.length : Math.max(0, UPGRADE_STEPS.findIndex((s) => s.key === stage));

  const download = useMemo(() => {
    if (stage !== 'download' || !progress || progress.stage !== 'download') return null;
    const done = progress.done ?? 0;
    const total = progress.total ?? 0;
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
    const parts = [total > 0 ? `${formatMiB(done)} / ${formatMiB(total)}` : `已下载 ${formatMiB(done)}`];
    if (speed > 0 && !failed) {
      parts.push(`${formatMiB(speed)}/s`);
      if (total > done) {
        parts.push(`剩余约 ${Math.max(1, Math.ceil((total - done) / speed))} 秒`);
      }
    }
    return { percent, text: parts.join(' · ') };
  }, [failed, progress, speed, stage]);

  return (
    <ol className="space-y-3 text-left">
      {UPGRADE_STEPS.map((step, idx) => {
        const isFailedHere = failed && idx === activeIdx;
        const isDone = stage === 'done' || idx < activeIdx;
        const isActive = !isFailedHere && idx === activeIdx;

        return (
          <li key={step.key} className="flex items-start gap-3">
            <div className="mt-0.5 shrink-0">
              {isFailedHere ? (
                <XCircle className="h-4 w-4 text-rose-500" />
              ) : isDone ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              ) : isActive ? (
                <Loader2 className="h-4 w-4 text-indigo-500 animate-spin" />
              ) : (
                <Clock className="h-4 w-4 text-slate-300 dark:text-slate-700" />
              )}
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <div
                className={`text-xs font-semibold ${
                  isFailedHere
                    ? 'text-rose-600 dark:text-rose-400'
                    : isActive
                    ? 'text-indigo-700 dark:text-indigo-300'
                    : isDone
                    ? 'text-slate-800 dark:text-slate-100'
                    : 'text-slate-400 dark:text-slate-500'
                }`}
              >
                {step.title}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                {step.key === 'resolve' && target ? `目标版本 ${target}` : step.detail}
              </div>
              {step.key === 'download' && download && (
                <div className="pt-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <div className="h-2 flex-1 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full transition-all duration-200 ${
                          failed ? 'bg-rose-500' : 'bg-indigo-600'
                        } ${download.percent === null && !failed ? 'animate-pulse' : ''}`}
                        style={{ width: `${download.percent ?? 100}%` }}
                      />
                    </div>
                    {download.percent !== null && (
                      <span className="text-[11px] font-medium tabular-nums text-slate-600 dark:text-slate-300">
                        {download.percent}%
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">{download.text}</div>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
