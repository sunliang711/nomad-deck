import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTabSearchParams,
  resolveClusterSelection,
  resolveJobCenterTab,
  resolveTabParam,
} from '../src/lib/selectionMemory.ts';

describe('selectionMemory', () => {
  const clusters = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];

  it('prefers explicit URL queryId over stored and previous state', () => {
    assert.equal(resolveClusterSelection(clusters, 'c3', 'c2', 'c1'), 'c3');
  });

  it('prefers valid previous selection before stored id, and falls back to stored id on remount', () => {
    assert.equal(resolveClusterSelection(clusters, '', 'c2', 'c1'), 'c2');
    assert.equal(resolveClusterSelection(clusters, '', '', 'c2'), 'c2');
  });

  it('falls back to first cluster when remembered or query id no longer exists', () => {
    assert.equal(resolveClusterSelection(clusters, 'deleted', '', 'also-deleted'), 'c1');
    assert.equal(resolveClusterSelection([], '', 'c2', 'c1'), '');
  });
});

describe('URL tab routing helpers', () => {
  it('resolves JobCenter tab from URL query params', () => {
    assert.equal(resolveJobCenterTab(new URLSearchParams('')), 'list');
    assert.equal(resolveJobCenterTab(new URLSearchParams('tab=templates')), 'templates');
    assert.equal(resolveJobCenterTab(new URLSearchParams('tab=builder')), 'builder');
    assert.equal(resolveJobCenterTab(new URLSearchParams('tab=runtime&job=demo')), 'list');
    assert.equal(resolveJobCenterTab(new URLSearchParams('job=demo')), 'builder');
    assert.equal(resolveJobCenterTab(new URLSearchParams('from=integration&tab=templates')), 'builder');
  });

  it('resolves generic page tab param with default fallback', () => {
    const valid = ['status', 'ops', 'workbench', 'snapshots', 'governance'];
    assert.equal(resolveTabParam(new URLSearchParams('tab=ops'), valid, 'status'), 'ops');
    assert.equal(resolveTabParam(new URLSearchParams('tab=governance'), valid, 'status'), 'governance');
    assert.equal(resolveTabParam(new URLSearchParams('tab=unknown'), valid, 'status'), 'status');
    assert.equal(resolveTabParam(new URLSearchParams(''), valid, 'status'), 'status');
  });

  it('builds tab search params while preserving unrelated params and cleaning one-shot keys', () => {
    const cur = new URLSearchParams('cluster_id=c1&from=integration&job=demo');
    const toTemplates = buildTabSearchParams(cur, 'templates', 'list', { deleteKeys: ['from', 'job'] });
    assert.equal(toTemplates.toString(), 'cluster_id=c1&tab=templates');

    const backToList = buildTabSearchParams(toTemplates, 'list', 'list');
    assert.equal(backToList.toString(), 'cluster_id=c1');
  });
});
