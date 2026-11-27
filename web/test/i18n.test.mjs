import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLocale, readInitialLocale, setCurrentLocale, trText } from '../src/lib/locale.ts';
import { formatDuration } from '../src/lib/selfUpdate.ts';
import { describeCron } from '../src/lib/cron.ts';
import { parseKVPath } from '../src/lib/vaultHelpers.ts';
import {
  ACTION_LABELS_EN,
  ACTION_LABELS_ZH,
  RESOURCE_LABELS_EN,
  RESOURCE_LABELS_ZH,
  formatActionLabel,
  formatResourceLabel,
  formatTaskDuration,
} from '../src/lib/actionLabels.ts';
import {
  STARTER_SAMPLES,
  getBlueprintDesc,
  getBlueprintLabel,
  getBlueprintTags,
} from '../src/lib/jobBlueprints.ts';

describe('i18n helpers', () => {
  it('defaults to zh without window and switches current locale via trText', () => {
    assert.equal(readInitialLocale(), 'zh');
    const prev = getLocale();
    try {
      setCurrentLocale('en');
      assert.equal(trText('中文', 'English'), 'English');
      setCurrentLocale('zh');
      assert.equal(trText('中文', 'English'), '中文');
    } finally {
      setCurrentLocale(prev);
    }
  });

  it('formats durations and task durations in zh and en', () => {
    assert.equal(formatDuration(90, 'zh'), '1 分钟 30 秒');
    assert.equal(formatDuration(90, 'en'), '1m 30s');
    assert.equal(formatDuration(7200, 'en'), '2h');
    assert.equal(formatTaskDuration('2026-01-01T00:00:00Z', '2026-01-01T00:02:05Z', null, 0, 'en'), '2m 5s');
    assert.equal(formatTaskDuration('2026-01-01T00:00:00Z', '2026-01-01T00:02:05Z', null, 0, 'zh'), '2 分 5 秒');
  });

  it('describes cron schedules in both locales', () => {
    assert.equal(describeCron('*/5 * * * *', 'zh'), '每 5 分钟');
    assert.equal(describeCron('*/5 * * * *', 'en'), 'Every 5 min');
    assert.equal(describeCron('0 2 * * 1', 'en'), 'Every Mon at 02:00');
  });

  it('translates vault wildcard placeholders cleanly', () => {
    assert.equal(parseKVPath('secret/data/apps/*', 'secret', 'zh').templateExamplePath, 'secret/data/apps/<你的密钥名>');
    assert.equal(parseKVPath('secret/data/apps/*', 'secret', 'en').templateExamplePath, 'secret/data/apps/<secret-name>');
  });

  it('keeps English and Chinese action/resource labels aligned cleanly', () => {
    assert.deepEqual(Object.keys(ACTION_LABELS_EN).sort(), Object.keys(ACTION_LABELS_ZH).sort());
    assert.deepEqual(Object.keys(RESOURCE_LABELS_EN).sort(), Object.keys(RESOURCE_LABELS_ZH).sort());
    for (const [k, v] of Object.entries(ACTION_LABELS_EN)) {
      assert.ok(v.trim().length > 0, `empty EN label for ${k}`);
      assert.equal(/[\u4e00-\u9fff]/.test(v), false, `EN action label contains Han chars: ${k}=${v}`);
    }
    assert.equal(formatActionLabel('cluster.deploy', 'en'), 'Deploy Cluster');
    assert.equal(formatResourceLabel('node', 'en'), 'Linux Host');
  });

  it('provides full English metadata for every starter job blueprint', () => {
    for (const bp of STARTER_SAMPLES) {
      const labelEn = getBlueprintLabel(bp, 'en');
      const descEn = getBlueprintDesc(bp, 'en');
      const tagsEn = getBlueprintTags(bp, 'en');
      assert.ok(bp.labelEn, `missing labelEn on ${bp.id}`);
      assert.ok(bp.descEn, `missing descEn on ${bp.id}`);
      assert.ok(bp.tagsEn && bp.tagsEn.length > 0, `missing tagsEn on ${bp.id}`);
      assert.equal(/[\u4e00-\u9fff]/.test(labelEn), false, `Han in labelEn for ${bp.id}`);
      assert.equal(/[\u4e00-\u9fff]/.test(descEn), false, `Han in descEn for ${bp.id}`);
      assert.equal(tagsEn.some((t) => /[\u4e00-\u9fff]/.test(t)), false, `Han in tagsEn for ${bp.id}`);
    }
  });
});
