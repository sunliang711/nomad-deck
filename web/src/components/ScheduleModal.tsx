import React, { useEffect, useMemo, useState } from 'react';
import { formatDurationZh, UPGRADE_VERSION_PATTERN } from '../lib/selfUpdate';
import { Button, ErrorAlert, Input, Modal } from './UI';

const DURATION_OPTIONS = [
  { label: '5 分钟', value: 300 },
  { label: '30 分钟', value: 1800 },
  { label: '1 小时', value: 3600 },
  { label: '6 小时', value: 21600 },
  { label: '24 小时', value: 86400 },
  { label: '自定义', value: 0 },
];

const INTERVAL_OPTIONS = [
  { label: '10 秒', value: 10 },
  { label: '20 秒', value: 20 },
  { label: '1 分钟', value: 60 },
  { label: '5 分钟', value: 300 },
];

export function ScheduleModal({
  open,
  currentVersion,
  suggestedVersion,
  busy,
  error,
  onClearError,
  onClose,
  onSubmit,
}: {
  open: boolean;
  currentVersion?: string;
  suggestedVersion?: string;
  busy: boolean;
  error: string;
  onClearError: () => void;
  onClose: () => void;
  onSubmit: (payload: { target_version: string; wait_seconds: number; interval_seconds: number }) => Promise<void>;
}) {
  const [mode, setMode] = useState<'latest' | 'version'>('latest');
  const [version, setVersion] = useState('');
  const [durationSec, setDurationSec] = useState(1800);
  const [customMinutes, setCustomMinutes] = useState(10);
  const [intervalSec, setIntervalSec] = useState(20);

  useEffect(() => {
    if (!open) return;
    if (suggestedVersion && !version) {
      setVersion(suggestedVersion);
    }
  }, [open, suggestedVersion, version]);

  const versionValid = mode === 'latest' || UPGRADE_VERSION_PATTERN.test(version.trim());
  const versionExample = currentVersion && UPGRADE_VERSION_PATTERN.test(currentVersion) ? currentVersion : 'v0.3.0';
  const waitSeconds = durationSec || Math.max(1, Math.min(1440, Math.round(customMinutes || 1))) * 60;

  const summaryText = useMemo(() => {
    const deadline = new Date(Date.now() + waitSeconds * 1000).toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    const what =
      mode === 'latest'
        ? '是否发布了比当前更新的正式版'
        : ` ${version.trim() || '目标版本'} 是否已发布`;
    return `${formatDurationZh(waitSeconds)}内（约到 ${deadline}）每 ${formatDurationZh(intervalSec)}检查一次${what}，发现后自动下载、校验并升级；到时仍没有则结束预约。`;
  }, [intervalSec, mode, version, waitSeconds]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!versionValid || busy) return;
    await onSubmit({
      target_version: mode === 'latest' ? 'latest' : version.trim(),
      wait_seconds: waitSeconds,
      interval_seconds: intervalSec,
    });
  };

  return (
    <Modal
      open={open}
      title="预约升级"
      size="lg"
      busy={busy}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="schedule-upgrade-form" variant="primary" loading={busy} disabled={!versionValid}>
            开始预约
          </Button>
        </div>
      }
    >
      <form id="schedule-upgrade-form" onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-700 dark:text-slate-300">目标版本</div>
          <div className="inline-flex rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-1 gap-1">
            {[
              { value: 'latest' as const, label: '最新正式版' },
              { value: 'version' as const, label: '指定版本' },
            ].map((opt) => {
              const active = mode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setMode(opt.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                    active
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {mode === 'version' && (
            <div className="pt-1">
              <Input
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder={`例如 ${versionExample}`}
                data-autofocus
              />
              {!versionValid && (
                <div className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">格式如 {versionExample}</div>
              )}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-700 dark:text-slate-300">等待时长</div>
          <div className="flex flex-wrap gap-1.5">
            {DURATION_OPTIONS.map((opt) => {
              const active = durationSec === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setDurationSec(opt.value)}
                  className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition ${
                    active
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-500/60 dark:bg-indigo-500/20 dark:text-indigo-200'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {durationSec === 0 && (
            <div className="flex items-center gap-2 pt-1">
              <input
                type="number"
                min={1}
                max={1440}
                value={customMinutes}
                onChange={(e) => setCustomMinutes(Number(e.target.value) || 1)}
                className="w-32 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <span className="text-xs text-slate-500 dark:text-slate-400">分钟（最长 24 小时）</span>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-700 dark:text-slate-300">检查间隔</div>
          <div className="flex flex-wrap gap-1.5">
            {INTERVAL_OPTIONS.map((opt) => {
              const active = intervalSec === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setIntervalSec(opt.value)}
                  className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition ${
                    active
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-500/60 dark:bg-indigo-500/20 dark:text-indigo-200'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-indigo-200/80 bg-indigo-50/70 px-3.5 py-2.5 text-xs leading-relaxed text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200">
          {summaryText}控制面在后台检查，不需要保持页面打开，服务重启后预约继续。
        </div>

        <ErrorAlert message={error} onClose={onClearError} />
      </form>
    </Modal>
  );
}
