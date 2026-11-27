import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackAddress } from '../src/lib/net.ts';

describe('isLoopbackAddress', () => {
  it('detects IPv4, IPv6, and localhost loopback addresses', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress(' localhost '), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('[::1]'), true);
    assert.equal(isLoopbackAddress('10.0.0.11'), false);
    assert.equal(isLoopbackAddress(''), false);
  });
});
