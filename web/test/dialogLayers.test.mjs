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

  it('allows closing on double-click on backdrop even when single-click backdrop close is disabled', () => {
    const guard = createBackdropClickGuard();
    // First click on backdrop
    guard.onPointerDown({ button: 0, target: backdrop, currentTarget: backdrop });
    guard.onPointerUp({ button: 0, target: backdrop, currentTarget: backdrop });
    assert.equal(guard.shouldCloseOnClick({ detail: 1, target: backdrop, currentTarget: backdrop }, false), false);
    // Second click on backdrop
    guard.onPointerDown({ button: 0, target: backdrop, currentTarget: backdrop });
    guard.onPointerUp({ button: 0, target: backdrop, currentTarget: backdrop });
    assert.equal(guard.shouldCloseOnClick({ detail: 2, target: backdrop, currentTarget: backdrop }, false), false);
    // Double-click closes
    assert.equal(guard.shouldCloseOnDoubleClick({ detail: 2, target: backdrop, currentTarget: backdrop }, true), true);
    // Consumed after double-click
    assert.equal(guard.shouldCloseOnDoubleClick({ detail: 2, target: backdrop, currentTarget: backdrop }, true), false);
  });

  it('does not close on double-click when disabled or when first gesture started inside dialog', () => {
    const guard = createBackdropClickGuard();
    // Drag from inside dialog to backdrop, then one backdrop click -> not a clean double-click
    guard.onPointerDown({ button: 0, target: input, currentTarget: backdrop });
    guard.onPointerUp({ button: 0, target: backdrop, currentTarget: backdrop });
    assert.equal(guard.shouldCloseOnClick({ detail: 1, target: backdrop, currentTarget: backdrop }, false), false);
    guard.onPointerDown({ button: 0, target: backdrop, currentTarget: backdrop });
    guard.onPointerUp({ button: 0, target: backdrop, currentTarget: backdrop });
    assert.equal(guard.shouldCloseOnClick({ detail: 2, target: backdrop, currentTarget: backdrop }, false), false);
    assert.equal(guard.shouldCloseOnDoubleClick({ detail: 2, target: backdrop, currentTarget: backdrop }, true), false);

    // Double-click inside dialog never closes
    guard.onPointerDown({ button: 0, target: input, currentTarget: backdrop });
    guard.onPointerUp({ button: 0, target: input, currentTarget: backdrop });
    guard.shouldCloseOnClick({ detail: 1, target: input, currentTarget: backdrop }, false);
    guard.onPointerDown({ button: 0, target: input, currentTarget: backdrop });
    guard.onPointerUp({ button: 0, target: input, currentTarget: backdrop });
    guard.shouldCloseOnClick({ detail: 2, target: input, currentTarget: backdrop }, false);
    assert.equal(guard.shouldCloseOnDoubleClick({ detail: 2, target: input, currentTarget: backdrop }, true), false);

    // Double-click on backdrop with enabled=false (e.g. busy/non-dismissible) never closes
    guard.onPointerDown({ button: 0, target: backdrop, currentTarget: backdrop });
    guard.onPointerUp({ button: 0, target: backdrop, currentTarget: backdrop });
    guard.shouldCloseOnClick({ detail: 1, target: backdrop, currentTarget: backdrop }, false);
    guard.onPointerDown({ button: 0, target: backdrop, currentTarget: backdrop });
    guard.onPointerUp({ button: 0, target: backdrop, currentTarget: backdrop });
    guard.shouldCloseOnClick({ detail: 2, target: backdrop, currentTarget: backdrop }, false);
    assert.equal(guard.shouldCloseOnDoubleClick({ detail: 2, target: backdrop, currentTarget: backdrop }, false), false);
  });
});
