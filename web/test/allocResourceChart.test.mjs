import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOC_STATS_WINDOW_MS,
  appendResourceSample,
  buildTimeAxisTicks,
  computeYAxisScale,
  extractAllocCapacity,
  extractResourceSamples,
  formatChartPercent,
  formatMiB,
} from '../src/lib/allocResourceChart.ts';

describe('allocResourceChart', () => {
  it('sums CPU MHz and Memory MiB across AllocatedResources.Tasks and falls back to legacy Resources', () => {
    const cap = extractAllocCapacity({
      AllocatedResources: {
        Tasks: {
          postgres: { Cpu: { CpuShares: 200 }, Memory: { MemoryMB: 256 } },
          exporter: { Cpu: { CpuShares: 50 }, Memory: { MemoryMB: 64 } },
        },
      },
    });
    assert.deepEqual(cap, { cpuMHz: 250, memMB: 320 });

    const legacyCap = extractAllocCapacity({
      Resources: { CPU: 100, MemoryMB: 128 },
    });
    assert.deepEqual(legacyCap, { cpuMHz: 100, memMB: 128 });
  });

  it('computes allocation-relative CPU and Memory percentages', () => {
    const { cpu, mem } = extractResourceSamples(
      {
        ResourceUsage: {
          CpuStats: { TotalTicks: 50, Percent: 1.2 },
          MemoryStats: { RSS: 8 * 1024 * 1024 },
        },
      },
      { cpuMHz: 200, memMB: 256 },
      1_700_000_000_000,
    );

    assert.equal(cpu.raw, 50);
    assert.equal(cpu.value, 25);
    assert.equal(mem.raw, 8);
    assert.equal(mem.value, 3.125);
  });

  it('keeps samples within the 5-minute sliding window and prunes expired samples', () => {
    const t0 = 1_700_000_000_000;
    let list = appendResourceSample([], { ts: t0, value: 10, raw: 20 });
    list = appendResourceSample(list, { ts: t0 + 60_000, value: 15, raw: 30 });
    list = appendResourceSample(list, { ts: t0 + ALLOC_STATS_WINDOW_MS + 3_000, value: 20, raw: 40 });

    assert.equal(list.length, 2);
    assert.equal(list[0].ts, t0 + 60_000);
    assert.equal(list[1].ts, t0 + ALLOC_STATS_WINDOW_MS + 3_000);
  });

  it('generates whole-minute X-axis ticks inside the 5-minute window', () => {
    const end = new Date(2026, 10, 27, 11, 1, 25).getTime();
    const ticks = buildTimeAxisTicks(end, ALLOC_STATS_WINDOW_MS);
    assert.deepEqual(
      ticks.map((t) => t.label),
      ['10:57:00', '10:58:00', '10:59:00', '11:00:00', '11:01:00'],
    );
    assert.ok(ticks.every((t) => t.ratio >= 0 && t.ratio <= 1));
  });

  it('scales Y-axis dynamically above 100% and formats summary labels cleanly', () => {
    assert.deepEqual(computeYAxisScale([0, 42]), { maxPct: 100, ticks: [0, 25, 50, 75, 100] });
    assert.deepEqual(computeYAxisScale([112]), { maxPct: 125, ticks: [0, 31.25, 62.5, 93.75, 125] });
    assert.equal(formatChartPercent(0), '0%');
    assert.equal(formatChartPercent(0.35), '0.3%');
    assert.equal(formatChartPercent(3.125), '3%');
    assert.equal(formatMiB(8), '8.0 MiB');
    assert.equal(formatMiB(128.4), '128 MiB');
  });
});
