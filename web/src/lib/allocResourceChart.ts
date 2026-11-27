export const ALLOC_STATS_WINDOW_MS = 5 * 60 * 1000;

export interface AllocCapacity {
  cpuMHz: number;
  memMB: number;
}

export interface ResourceSample {
  ts: number;
  value: number; // utilization percentage (0..100+)
  raw: number; // raw used value (MHz for CPU, MiB for Memory)
}

export interface TimeAxisTick {
  ts: number;
  label: string;
  ratio: number; // 0..1 across [windowStart, windowEnd]
}

export interface YAxisScale {
  maxPct: number;
  ticks: number[];
}

/**
 * Extracts total allocated CPU (MHz) and Memory (MiB) from a Nomad allocation object.
 */
export function extractAllocCapacity(alloc: any): AllocCapacity {
  let cpuMHz = 0;
  let memMB = 0;

  const tasksMap = alloc?.AllocatedResources?.Tasks;
  if (tasksMap && typeof tasksMap === 'object') {
    for (const task of Object.values<any>(tasksMap)) {
      cpuMHz += Number(task?.Cpu?.CpuShares || 0);
      memMB += Number(task?.Memory?.MemoryMB || 0);
    }
  }

  if (cpuMHz <= 0 && memMB <= 0 && alloc?.TaskResources && typeof alloc.TaskResources === 'object') {
    for (const res of Object.values<any>(alloc.TaskResources)) {
      cpuMHz += Number(res?.CPU || 0);
      memMB += Number(res?.MemoryMB || 0);
    }
  }

  if (cpuMHz <= 0) {
    cpuMHz = Number(alloc?.Resources?.CPU || 0);
  }
  if (memMB <= 0) {
    memMB = Number(alloc?.Resources?.MemoryMB || 0);
  }

  return { cpuMHz, memMB };
}

/**
 * Converts a Nomad /client/allocation/:id/stats payload into CPU and Memory samples.
 */
export function extractResourceSamples(
  stats: any,
  capacity: AllocCapacity,
  ts = Date.now(),
): { cpu: ResourceSample; mem: ResourceSample } {
  const cpuStats = stats?.ResourceUsage?.CpuStats;
  const memStats = stats?.ResourceUsage?.MemoryStats;

  const hasTicks = typeof cpuStats?.TotalTicks === 'number' && Number.isFinite(cpuStats.TotalTicks);
  const rawTicks = hasTicks ? Math.max(0, cpuStats.TotalTicks) : 0;
  const rawPercent =
    typeof cpuStats?.Percent === 'number' && Number.isFinite(cpuStats.Percent) ? Math.max(0, cpuStats.Percent) : 0;

  let cpuPct: number;
  let cpuMHz: number;
  if (capacity.cpuMHz > 0 && hasTicks) {
    cpuMHz = rawTicks;
    cpuPct = (rawTicks / capacity.cpuMHz) * 100;
  } else if (capacity.cpuMHz > 0) {
    cpuPct = rawPercent;
    cpuMHz = (rawPercent / 100) * capacity.cpuMHz;
  } else {
    cpuMHz = rawTicks;
    cpuPct = rawPercent;
  }

  const rssBytes = typeof memStats?.RSS === 'number' && Number.isFinite(memStats.RSS) ? Math.max(0, memStats.RSS) : 0;
  const memMiB = rssBytes / (1024 * 1024);
  const memPct = capacity.memMB > 0 ? (memMiB / capacity.memMB) * 100 : 0;

  return {
    cpu: { ts, value: cpuPct, raw: cpuMHz },
    mem: { ts, value: memPct, raw: memMiB },
  };
}

/**
 * Appends a sample and prunes entries older than the sliding window.
 */
export function appendResourceSample(
  prev: ResourceSample[],
  next: ResourceSample,
  windowMs = ALLOC_STATS_WINDOW_MS,
): ResourceSample[] {
  const cutoff = next.ts - windowMs;
  const kept = prev.filter((item) => item.ts >= cutoff && item.ts <= next.ts);
  return [...kept, next];
}

/**
 * Builds whole-minute X-axis ticks inside [windowEndTs - windowMs, windowEndTs].
 */
export function buildTimeAxisTicks(windowEndTs: number, windowMs = ALLOC_STATS_WINDOW_MS): TimeAxisTick[] {
  const windowStart = windowEndTs - windowMs;
  if (windowMs <= 0) return [];

  const firstMinute = Math.ceil(windowStart / 60_000) * 60_000;
  const ticks: TimeAxisTick[] = [];
  for (let t = firstMinute; t <= windowEndTs; t += 60_000) {
    const d = new Date(t);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    ticks.push({
      ts: t,
      label: `${hh}:${mm}:${ss}`,
      ratio: (t - windowStart) / windowMs,
    });
  }
  return ticks;
}

/**
 * Computes Y-axis ticks (0%, 25%, 50%, 75%, 100%, scaling cleanly if burst exceeds 100%).
 */
export function computeYAxisScale(values: number[]): YAxisScale {
  const peak = values.reduce((acc, v) => (v > acc ? v : acc), 0);
  const maxPct = peak > 100 ? Math.ceil(peak / 25) * 25 : 100;
  const step = maxPct / 4;
  return {
    maxPct,
    ticks: [0, step, step * 2, step * 3, maxPct],
  };
}

export function formatChartPercent(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return '0%';
  if (pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

export function formatMiB(mib: number): string {
  if (!Number.isFinite(mib) || mib <= 0) return '0 MiB';
  if (mib >= 10) return `${Math.round(mib)} MiB`;
  return `${mib.toFixed(1)} MiB`;
}
