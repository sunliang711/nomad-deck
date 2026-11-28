import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomPolicyPreset, parseKVPath } from '../src/lib/vaultHelpers.ts';

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

describe('buildCustomPolicyPreset', () => {
  it('accepts multiline paths mixed with commas and blank lines', () => {
    const res = buildCustomPolicyPreset('from-paths', {
      policyMode: 'explicit',
      secretPaths: ' secret/apps/postgres\r\n\r\nsecret/data/apps/mysql, secret/apps/redis\n ',
    });
    const expected = buildCustomPolicyPreset('from-paths', {
      policyMode: 'explicit',
      secretPaths: 'secret/apps/postgres,secret/data/apps/mysql,secret/apps/redis',
    });
    assert.equal(res.hcl, expected.hcl);
    assert.equal((res.hcl.match(/path "/g) || []).length, 6);
  });

  it('converts explicit paths above into read-only data and metadata HCL blocks', () => {
    const res = buildCustomPolicyPreset('from-paths', {
      fallbackMount: 'kv',
      policyMode: 'explicit',
      secretPaths: 'kv/data/apps/web, kv/shared/*',
    });
    assert.match(res.hcl, /path "kv\/data\/apps\/web" \{\s+capabilities = \["read"\]/);
    assert.match(res.hcl, /path "kv\/metadata\/apps\/web" \{\s+capabilities = \["read", "list"\]/);
    assert.match(res.hcl, /path "kv\/data\/shared\/\*" \{\s+capabilities = \["read"\]/);
    assert.match(res.hcl, /path "kv\/metadata\/shared\/\*" \{\s+capabilities = \["read", "list"\]/);
  });

  it('generates single-path read/write policy reusing exact explicit path and mount', () => {
    const res = buildCustomPolicyPreset('single-rw', {
      fallbackMount: 'secret',
      roleName: 'api',
      policyMode: 'explicit',
      secretPaths: 'kv2/apps/api',
    });
    assert.match(res.hcl, /path "kv2\/data\/apps\/api" \{\s+capabilities = \["create", "update", "read"\]/);
    assert.match(res.hcl, /path "kv2\/metadata\/apps\/api" \{\s+capabilities = \["read", "list"\]/);
  });

  it('generates directory wildcard read/write/delete policy and shared-read-app-rw policy', () => {
    const dir = buildCustomPolicyPreset('dir-rw', {
      fallbackMount: 'kv',
      roleName: 'worker',
      policyMode: 'explicit',
      secretPaths: 'kv/services/worker',
    });
    assert.match(dir.hcl, /path "kv\/data\/services\/worker\/\*" \{\s+capabilities = \["create", "update", "read", "delete"\]/);
    assert.match(dir.hcl, /path "kv\/metadata\/services\/worker\/\*" \{\s+capabilities = \["read", "list", "delete"\]/);

    const mixed = buildCustomPolicyPreset('shared-read-app-rw', {
      fallbackMount: 'kv',
      roleName: 'worker',
      policyMode: 'explicit',
      secretPaths: '',
    });
    assert.match(mixed.hcl, /path "kv\/data\/shared\/\*" \{\s+capabilities = \["read"\]/);
    assert.match(mixed.hcl, /path "kv\/data\/apps\/worker\/\*" \{\s+capabilities = \["create", "update", "read", "delete"\]/);
  });
});
