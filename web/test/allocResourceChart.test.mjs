import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOC_STATS_WINDOW_MS,
  appendResourceSample,
  buildTimeAxisTicks,
  computeYAxisScale,
  extractAllocCapacity,
  extractAllocPorts,
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

  it('extracts port mappings from AllocatedResources.Shared.Ports and legacy Networks', () => {
    assert.deepEqual(
      extractAllocPorts({
        AllocatedResources: {
          Shared: {
            Ports: [
              { Label: 'http', Value: 26854, To: 80, HostIP: '10.2.24.178' },
              { Label: 'metrics', Value: 9090, To: 0, HostIP: '::1' },
            ],
          },
        },
      }),
      [
        {
          label: 'http',
          hostIP: '10.2.24.178',
          hostPort: 26854,
          mappedPort: 80,
          hostAddress: '10.2.24.178:26854',
        },
        {
          label: 'metrics',
          hostIP: '::1',
          hostPort: 9090,
          mappedPort: undefined,
          hostAddress: '[::1]:9090',
        },
      ],
    );

    assert.deepEqual(
      extractAllocPorts({
        Resources: {
          Networks: [
            {
              IP: '127.0.0.1',
              ReservedPorts: [{ Label: 'db', Value: 5432, To: 5432 }],
              DynamicPorts: [{ Label: 'http', Value: 24001 }],
            },
          ],
        },
      }),
      [
        {
          label: 'db',
          hostIP: '127.0.0.1',
          hostPort: 5432,
          mappedPort: 5432,
          hostAddress: '127.0.0.1:5432',
        },
        {
          label: 'http',
          hostIP: '127.0.0.1',
          hostPort: 24001,
          mappedPort: undefined,
          hostAddress: '127.0.0.1:24001',
        },
      ],
    );

    assert.deepEqual(extractAllocPorts({}), []);
  });
});
