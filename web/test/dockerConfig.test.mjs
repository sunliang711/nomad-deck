import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDockerConfigPayload,
  dockerConfigDraftFrom,
  emptyDockerConfigDraft,
} from '../src/lib/dockerConfig.ts';

describe('dockerConfig helpers', () => {
  it('hydrates draft from cluster/host config with encrypted password flag', () => {
    const draft = dockerConfigDraftFrom({
      registry_mirrors: ['https://m1.example.com', 'https://m2.example.com'],
      data_root: '/data/docker',
      log_max_size: '100m',
      log_max_file: 5,
      pull_proxy: {
        mode: 'custom',
        url: 'http://10.0.0.2:3128',
        username: 'alice',
        password_set: true,
        no_proxy: ['registry.internal', '10.0.0.0/8'],
      },
    });
    assert.equal(draft.registry_mirrors, 'https://m1.example.com, https://m2.example.com');
    assert.equal(draft.data_root, '/data/docker');
    assert.equal(draft.log_max_size, '100m');
    assert.equal(draft.log_max_file, '5');
    assert.equal(draft.pull_proxy_mode, 'custom');
    assert.equal(draft.pull_proxy_password_set, true);
    assert.equal(draft.pull_proxy_no_proxy, 'registry.internal, 10.0.0.0/8');
  });

  it('builds external-mode payload with pull_proxy only and respects includeDataRoot', () => {
    const draft = {
      ...emptyDockerConfigDraft(),
      registry_mirrors: 'https://m1.example.com',
      data_root: '/mnt/docker',
      log_max_size: '80m',
      log_max_file: '4',
      pull_proxy_mode: 'custom',
      pull_proxy_url: 'http://proxy.internal:3128',
      pull_proxy_username: 'ops',
      pull_proxy_password: 'secret',
      pull_proxy_no_proxy: '127.0.0.1, localhost',
    };

    const ext = buildDockerConfigPayload(draft, { externalOnly: true });
    assert.equal('registry_mirrors' in ext, false);
    assert.equal('data_root' in ext, false);
    assert.equal('log_max_size' in ext, false);
    assert.equal(ext.pull_proxy.mode, 'custom');
    assert.equal(ext.pull_proxy_password, 'secret');
    assert.deepEqual(ext.pull_proxy.no_proxy, ['127.0.0.1', 'localhost']);

    const full = buildDockerConfigPayload(draft, { includeDataRoot: true });
    assert.deepEqual(full.registry_mirrors, ['https://m1.example.com']);
    assert.equal(full.data_root, '/mnt/docker');
    assert.equal(full.log_max_size, '80m');
    assert.equal(full.log_max_file, 4);
  });
});
