import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBackdropClickGuard } from '../src/components/dialogLayers.ts';

describe('createBackdropClickGuard', () => {
  const backdrop = { id: 'backdrop' };
  const input = { id: 'input' };

  it('does not allow closing when closeOnBackdrop is disabled', () => {
    const guard = createBackdropClickGuard();
    guard.onPointerDown({ button: 0, target: backdrop, currentTarget: backdrop });
    guard.onPointerUp({ button: 0, target: backdrop, currentTarget: backdrop });
    assert.equal(guard.shouldCloseOnClick({ target: backdrop, currentTarget: backdrop }, false), false);
  });

  it('prevents closing when pointer selection starts inside dialog and ends on backdrop', () => {
    const guard = createBackdropClickGuard();
    guard.onPointerDown({ button: 0, target: input, currentTarget: backdrop });
    guard.onPointerUp({ button: 0, target: backdrop, currentTarget: backdrop });
    assert.equal(guard.shouldCloseOnClick({ target: backdrop, currentTarget: backdrop }, true), false);
  });

  it('prevents closing when pointer starts on backdrop and ends inside dialog', () => {
    const guard = createBackdropClickGuard();
    guard.onPointerDown({ button: 0, target: backdrop, currentTarget: backdrop });
    guard.onPointerUp({ button: 0, target: input, currentTarget: backdrop });
    assert.equal(guard.shouldCloseOnClick({ target: backdrop, currentTarget: backdrop }, true), false);
  });

  it('allows closing only when enabled and both pointerdown and pointerup occur on backdrop', () => {
    const guard = createBackdropClickGuard();
    guard.onPointerDown({ button: 0, target: backdrop, currentTarget: backdrop });
    guard.onPointerUp({ button: 0, target: backdrop, currentTarget: backdrop });
    assert.equal(guard.shouldCloseOnClick({ target: backdrop, currentTarget: backdrop }, true), true);
    // Consumed after click so a subsequent click cannot reuse stale state.
    assert.equal(guard.shouldCloseOnClick({ target: backdrop, currentTarget: backdrop }, true), false);
  });
});
