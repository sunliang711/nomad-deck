import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDurationZh,
  normalizedVersion,
  upgradeStage,
  VersionCheckTimeoutError,
  waitForVersion,
} from '../src/lib/selfUpdate.ts';

describe('selfUpdate helpers', () => {
  it('maps backend progress stages and rejects unknown stages', () => {
    assert.equal(upgradeStage('resolve'), 'resolve');
    assert.equal(upgradeStage('download'), 'download');
    assert.equal(upgradeStage('verify'), 'verify');
    assert.equal(upgradeStage('install'), 'install');
    assert.equal(upgradeStage('restart'), 'restart');
    assert.equal(upgradeStage('unknown'), null);
    assert.equal(upgradeStage(undefined), null);
  });

  it('normalizes semver tags and formats Chinese durations', () => {
    assert.equal(normalizedVersion(' v0.3.1 '), '0.3.1');
    assert.equal(normalizedVersion('V1.2.3'), '1.2.3');
    assert.equal(formatDurationZh(20), '20 秒');
    assert.equal(formatDurationZh(90), '1 分钟 30 秒');
    assert.equal(formatDurationZh(1800), '30 分钟');
    assert.equal(formatDurationZh(5400), '1 小时 30 分钟');
  });

  it('waitForVersion survives temporary restart disconnects until target version matches', async () => {
    const ctrl = new AbortController();
    let clock = 0;
    let calls = 0;
    const seenReachable = [];
    let unavailableCount = 0;

    const matched = await waitForVersion({
      targetVersion: 'v0.3.1',
      signal: ctrl.signal,
      now: () => clock,
      interval: 1500,
      timeout: 10000,
      delay: async (ms) => {
        clock += ms;
      },
      probe: async () => {
        calls += 1;
        if (calls === 1) return 'v0.3.0';
        if (calls === 2) throw new Error('connection refused during restart');
        return '0.3.1';
      },
      onReachable: (v) => seenReachable.push(v),
      onUnavailable: () => {
        unavailableCount += 1;
      },
    });

    assert.equal(matched, '0.3.1');
    assert.deepEqual(seenReachable, ['v0.3.0']);
    assert.equal(unavailableCount, 1);
  });

  it('waitForVersion throws VersionCheckTimeoutError when deadline expires', async () => {
    const ctrl = new AbortController();
    let clock = 0;
    await assert.rejects(
      () =>
        waitForVersion({
          targetVersion: 'v0.9.9',
          signal: ctrl.signal,
          now: () => clock,
          interval: 2000,
          timeout: 5000,
          delay: async (ms) => {
            clock += ms;
          },
          probe: async () => 'v0.9.0',
        }),
      (err) => err instanceof VersionCheckTimeoutError,
    );
  });
});
