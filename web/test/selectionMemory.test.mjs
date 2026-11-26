import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClusterSelection } from '../src/lib/selectionMemory.ts';

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
