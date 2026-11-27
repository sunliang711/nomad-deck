import { useId, useState } from 'react';
import {
  ALLOC_STATS_WINDOW_MS,
  AllocCapacity,
  buildTimeAxisTicks,
  computeYAxisScale,
  formatChartPercent,
  formatMiB,
  ResourceSample,
} from '../lib/allocResourceChart';
import { useI18n } from '../lib/i18n';

interface UtilizationChartCardProps {
  title: string;
  samples: ResourceSample[];
  nowTs: number;
  strokeColor: string;
  fillColor: string;
  barClassName: string;
  usedText: string;
  totalText: string;
  formatRaw: (raw: number) => string;
}

const SVG_W = 380;
const SVG_H = 148;
const PAD_L = 8;
const PAD_T = 10;
const PAD_R = 40;
const PAD_B = 24;
const PLOT_W = SVG_W - PAD_L - PAD_R;
const PLOT_H = SVG_H - PAD_T - PAD_B;

function UtilizationChartCard({
  title,
  samples,
  nowTs,
  strokeColor,
  fillColor,
  barClassName,
  usedText,
  totalText,
  formatRaw,
}: UtilizationChartCardProps) {
  const { isEn } = useI18n();
  const gradId = useId();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const windowEnd = Math.max(nowTs, samples[samples.length - 1]?.ts || nowTs);
  const windowStart = windowEnd - ALLOC_STATS_WINDOW_MS;
  const { maxPct, ticks: yTicks } = computeYAxisScale(samples.map((s) => s.value));
  const xTicks = buildTimeAxisTicks(windowEnd, ALLOC_STATS_WINDOW_MS);

  const coords = samples.map((s) => {
    const ratioX = Math.min(1, Math.max(0, (s.ts - windowStart) / ALLOC_STATS_WINDOW_MS));
    const ratioY = Math.min(1, Math.max(0, s.value / maxPct));
    return {
      x: PAD_L + ratioX * PLOT_W,
      y: PAD_T + (1 - ratioY) * PLOT_H,
      sample: s,
    };
  });

  const latest = samples[samples.length - 1];
  const latestPct = latest?.value ?? 0;
  const activeCoord = hoverIdx !== null && coords[hoverIdx] ? coords[hoverIdx] : null;

  const polylinePoints =
    coords.length === 1
      ? `${Math.max(PAD_L, coords[0].x - 6).toFixed(1)},${coords[0].y.toFixed(1)} ${coords[0].x.toFixed(1)},${coords[0].y.toFixed(1)}`
      : coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');

  const areaPoints =
    coords.length >= 2
      ? `${coords[0].x.toFixed(1)},${(PAD_T + PLOT_H).toFixed(1)} ${polylinePoints} ${coords[coords.length - 1].x.toFixed(1)},${(PAD_T + PLOT_H).toFixed(1)}`
      : coords.length === 1
        ? `${Math.max(PAD_L, coords[0].x - 6).toFixed(1)},${(PAD_T + PLOT_H).toFixed(1)} ${polylinePoints} ${coords[0].x.toFixed(1)},${(PAD_T + PLOT_H).toFixed(1)}`
        : '';

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (coords.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const svgX = ((e.clientX - rect.left) / rect.width) * SVG_W;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const dist = Math.abs(coords[i].x - svgX);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    setHoverIdx(bestDist <= 28 ? bestIdx : null);
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3.5 dark:border-slate-800 dark:bg-slate-950/40">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{title}</span>
        {activeCoord && (
          <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
            {new Date(activeCoord.sample.ts).toLocaleTimeString(isEn ? 'en-US' : 'zh-CN', { hour12: false })} ·{' '}
            {formatRaw(activeCoord.sample.raw)} ({formatChartPercent(activeCoord.sample.value)})
          </span>
        )}
      </div>

      <svg
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        className="h-36 w-full select-none"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={fillColor} stopOpacity="0.22" />
            <stop offset="100%" stopColor={fillColor} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Horizontal dashed gridlines & right Y-axis labels */}
        {yTicks.map((tick) => {
          const y = PAD_T + (1 - tick / maxPct) * PLOT_H;
          return (
            <g key={tick}>
              <line
                x1={PAD_L}
                y1={y}
                x2={PAD_L + PLOT_W}
                y2={y}
                className="stroke-slate-200 dark:stroke-slate-800"
                strokeWidth="1"
                strokeDasharray={tick === 0 ? undefined : '3 3'}
              />
              <line
                x1={PAD_L + PLOT_W}
                y1={y}
                x2={PAD_L + PLOT_W + 4}
                y2={y}
                className="stroke-slate-300 dark:stroke-slate-700"
                strokeWidth="1"
              />
              <text
                x={PAD_L + PLOT_W + 7}
                y={y + 3.5}
                fontSize="10"
                className="fill-slate-500 font-mono dark:fill-slate-400"
              >
                {Math.round(tick)}%
              </text>
            </g>
          );
        })}

        {/* Right & bottom axis lines */}
        <line
          x1={PAD_L + PLOT_W}
          y1={PAD_T}
          x2={PAD_L + PLOT_W}
          y2={PAD_T + PLOT_H}
          className="stroke-slate-300 dark:stroke-slate-700"
          strokeWidth="1"
        />
        <line
          x1={PAD_L}
          y1={PAD_T + PLOT_H}
          x2={PAD_L + PLOT_W}
          y2={PAD_T + PLOT_H}
          className="stroke-slate-300 dark:stroke-slate-700"
          strokeWidth="1"
        />
        <line
          x1={PAD_L}
          y1={PAD_T + PLOT_H}
          x2={PAD_L}
          y2={PAD_T + PLOT_H + 4}
          className="stroke-slate-300 dark:stroke-slate-700"
          strokeWidth="1"
        />

        {/* Minute time ticks */}
        {xTicks.map((tick) => {
          const x = PAD_L + tick.ratio * PLOT_W;
          const showLabel = x >= PAD_L + 18 && x <= PAD_L + PLOT_W - 18;
          return (
            <g key={tick.ts}>
              <line
                x1={x}
                y1={PAD_T + PLOT_H}
                x2={x}
                y2={PAD_T + PLOT_H + 4}
                className="stroke-slate-300 dark:stroke-slate-700"
                strokeWidth="1"
              />
              {showLabel && (
                <text
                  x={x}
                  y={PAD_T + PLOT_H + 16}
                  textAnchor="middle"
                  fontSize="10"
                  className="fill-slate-500 font-mono dark:fill-slate-400"
                >
                  {tick.label}
                </text>
              )}
            </g>
          );
        })}

        {/* Area & line */}
        {areaPoints && <polygon points={areaPoints} fill={`url(#${gradId})`} />}
        {polylinePoints && (
          <polyline
            fill="none"
            stroke={strokeColor}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={polylinePoints}
          />
        )}

        {/* Hover crosshair */}
        {activeCoord && (
          <g>
            <line
              x1={activeCoord.x}
              y1={PAD_T}
              x2={activeCoord.x}
              y2={PAD_T + PLOT_H}
              stroke={strokeColor}
              strokeOpacity="0.45"
              strokeWidth="1"
              strokeDasharray="2 2"
            />
            <circle cx={activeCoord.x} cy={activeCoord.y} r="3.5" fill={strokeColor} />
          </g>
        )}
      </svg>

      {/* Bottom progress bar + percentage + capacity summary */}
      <div className="mt-2 space-y-1.5">
        <div className="flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
              className={`h-full rounded-full transition-all duration-300 ${barClassName}`}
              style={{ width: `${Math.min(100, Math.max(0, latestPct))}%` }}
            />
          </div>
          <span className="w-10 text-right font-mono text-xs text-slate-600 dark:text-slate-300">
            {formatChartPercent(latestPct)}
          </span>
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          <strong className="font-semibold text-slate-900 dark:text-slate-100">{usedText}</strong> / {totalText}
        </div>
      </div>
    </div>
  );
}

interface ResourceUtilizationPanelProps {
  cpuSamples: ResourceSample[];
  memSamples: ResourceSample[];
  capacity: AllocCapacity;
  nowTs: number;
  hasStats: boolean;
}

export function ResourceUtilizationPanel({
  cpuSamples,
  memSamples,
  capacity,
  nowTs,
  hasStats,
}: ResourceUtilizationPanelProps) {
  const { tr } = useI18n();
  const latestCpuMHz = cpuSamples[cpuSamples.length - 1]?.raw ?? 0;
  const latestMemMiB = memSamples[memSamples.length - 1]?.raw ?? 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-slate-800 dark:text-slate-100">{tr('资源占用', 'Resource Utilization')}</span>
        {hasStats && (
          <span className="text-[11px] text-slate-500 dark:text-slate-400">{tr('每 3 秒采集 · 最近 5 分钟', 'Sampled every 3s · Last 5m')}</span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <UtilizationChartCard
          title="CPU"
          samples={cpuSamples}
          nowTs={nowTs}
          strokeColor="#3b82f6"
          fillColor="#3b82f6"
          barClassName="bg-blue-500"
          usedText={`${Math.round(latestCpuMHz)} MHz`}
          totalText={capacity.cpuMHz > 0 ? `${capacity.cpuMHz} MHz Total` : tr('未限制', 'Unlimited')}
          formatRaw={(mhz) => `${Math.round(mhz)} MHz`}
        />
        <UtilizationChartCard
          title={tr('内存', 'Memory')}
          samples={memSamples}
          nowTs={nowTs}
          strokeColor="#ef4444"
          fillColor="#ef4444"
          barClassName="bg-rose-500"
          usedText={formatMiB(latestMemMiB)}
          totalText={capacity.memMB > 0 ? `${capacity.memMB} MiB Total` : tr('未限制', 'Unlimited')}
          formatRaw={(mib) => formatMiB(mib)}
        />
      </div>
    </div>
  );
}
