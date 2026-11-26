import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseKVPath } from '../src/lib/vaultHelpers.ts';

describe('parseKVPath', () => {
  it('parses exact secret path without wildcard or trailing slash', () => {
    const parsed = parseKVPath('secret/apps/postgres');
    assert.equal(parsed.rolePath, 'secret/apps/postgres');
    assert.equal(parsed.templatePath, 'secret/data/apps/postgres');
    assert.equal(parsed.templateExamplePath, 'secret/data/apps/postgres');
    assert.equal(parsed.hadDataPrefix, false);
    assert.equal(parsed.hasTrailingSlash, false);
    assert.equal(parsed.isWildcard, false);
  });

  it('detects trailing slash on explicit paths so UI can warn against directory misunderstanding', () => {
    const parsed = parseKVPath('secret/apps/');
    assert.equal(parsed.rolePath, 'secret/apps');
    assert.equal(parsed.templatePath, 'secret/data/apps');
    assert.equal(parsed.hasTrailingSlash, true);
    assert.equal(parsed.isWildcard, false);
  });

  it('strips accidental data/ prefix and preserves wildcard metadata', () => {
    const parsed = parseKVPath('secret/data/apps/*');
    assert.equal(parsed.rolePath, 'secret/apps/*');
    assert.equal(parsed.templatePath, 'secret/data/apps/*');
    assert.equal(parsed.templateExamplePath, 'secret/data/apps/<你的密钥名>');
    assert.equal(parsed.hadDataPrefix, true);
    assert.equal(parsed.hasTrailingSlash, false);
    assert.equal(parsed.isWildcard, true);
  });
});
