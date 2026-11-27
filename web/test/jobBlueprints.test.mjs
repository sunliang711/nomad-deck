import assert from 'node:assert/strict';
import test from 'node:test';
import { STARTER_SAMPLES } from '../src/lib/jobBlueprints.ts';

test('STARTER_SAMPLES include all expected built-in blueprints with unique ids and valid HCL envelopes', () => {
  const ids = STARTER_SAMPLES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'blueprint ids must be unique');

  for (const id of [
    'docker',
    'caddy',
    'traefik',
    'nginx-gateway',
    'openresty-gateway',
    'acme-cert-sync',
    'postgres',
    'mysql',
    'redis',
    'rabbitmq',
    'rocketmq',
    'prometheus',
    'grafana',
    'docker_registry',
    'raw_exec',
    'batch',
  ]) {
    assert.ok(ids.includes(id), `missing blueprint ${id}`);
  }

  for (const sample of STARTER_SAMPLES) {
    assert.ok(sample.label.trim().length > 0, `${sample.id} missing label`);
    assert.ok(sample.desc.trim().length > 0, `${sample.id} missing desc`);
    assert.ok(sample.tags.length > 0, `${sample.id} missing tags`);
    assert.match(sample.hcl, /^job\s+"[^"]+"\s+\{/, `${sample.id} must start with job block`);
    assert.ok(sample.hcl.includes('前置依赖'), `${sample.id} must document prerequisite dependencies in HCL comments`);
    assert.ok(!sample.hcl.includes('undefined'), `${sample.id} contains unexpected undefined`);
  }

  for (const id of ['traefik', 'nginx-gateway', 'openresty-gateway', 'acme-cert-sync', 'postgres', 'mysql', 'redis', 'rabbitmq', 'grafana']) {
    const bp = STARTER_SAMPLES.find((s) => s.id === id);
    assert.ok(bp?.hcl.includes('Role') && bp?.hcl.includes('应用联动'), `${id} must document Vault Role and Apply Integration step`);
  }

  const rocketmq = STARTER_SAMPLES.find((s) => s.id === 'rocketmq');
  assert.ok(rocketmq?.hcl.includes('${NOMAD_ADDR_namesrv}'), 'rocketmq broker must reference NOMAD_ADDR_namesrv');

  const nginxGw = STARTER_SAMPLES.find((s) => s.id === 'nginx-gateway');
  assert.ok(nginxGw?.hcl.includes('nginx:alpine') && nginxGw?.hcl.includes('SIGHUP'), 'nginx-gateway must use nginx:alpine and SIGHUP');
  const openrestyGw = STARTER_SAMPLES.find((s) => s.id === 'openresty-gateway');
  assert.ok(openrestyGw?.hcl.includes('openresty/openresty:alpine') && openrestyGw?.hcl.includes('ban-check.lua'), 'openresty-gateway must include Lua WAF');
  const acmeSync = STARTER_SAMPLES.find((s) => s.id === 'acme-cert-sync');
  assert.ok(acmeSync?.hcl.includes('periodic') && acmeSync?.hcl.includes('acme.sh'), 'acme-cert-sync must be a periodic acme.sh job');
  assert.ok(
    acmeSync?.hcl.includes('secret/data/certs/tls') && acmeSync?.hcl.includes('"create", "update", "read"'),
    'acme-cert-sync must document custom Policy HCL in comments',
  );

  for (const id of ['caddy', 'traefik', 'nginx-gateway', 'openresty-gateway', 'rabbitmq', 'rocketmq', 'prometheus', 'grafana', 'docker_registry']) {
    const bp = STARTER_SAMPLES.find((s) => s.id === id);
    assert.ok(bp?.hcl.includes('shutdown_delay'), `${id} with service block must define shutdown_delay`);
  }
});
