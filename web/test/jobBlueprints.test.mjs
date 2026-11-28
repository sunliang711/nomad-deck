import assert from 'node:assert/strict';
import test from 'node:test';
import { getBlueprintNotes, getBlueprintRequires, STARTER_SAMPLES } from '../src/lib/jobBlueprints.ts';

test('STARTER_SAMPLES include all expected built-in blueprints with structured prerequisites and clean HCL', () => {
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
    assert.ok(sample.requires.length > 0, `${sample.id} must declare structured requires badges`);
    assert.match(sample.hcl, /^job\s+"[^"]+"\s+\{/, `${sample.id} must start with job block`);
    assert.equal(sample.hcl.includes('前置依赖'), false, `${sample.id} should keep prerequisites in structured metadata, not HCL comment walls`);
    assert.ok(!sample.hcl.includes('undefined'), `${sample.id} contains unexpected undefined`);
  }

  // Vault-backed blueprints declare Vault role/KV requirements in structured metadata and HCL.
  for (const id of ['acme-cert-sync', 'postgres', 'mysql', 'redis', 'rabbitmq', 'grafana']) {
    const bp = STARTER_SAMPLES.find((s) => s.id === id);
    assert.ok(bp, `missing ${id}`);
    const reqs = getBlueprintRequires(bp, 'zh');
    assert.ok(reqs.some((r) => r.kind === 'vault'), `${id} must declare vault requirement badge`);
    assert.ok(bp.hcl.includes('vault {'), `${id} must include vault block`);
  }

  // Optional advanced gateway / telemetry setup guides live in structured notes.
  const traefik = STARTER_SAMPLES.find((s) => s.id === 'traefik');
  assert.ok(traefik);
  const traefikNotes = getBlueprintNotes(traefik, 'zh').map((n) => n.detail).join('\n');
  assert.ok(
    traefikNotes.includes('签发 Client Token') && traefikNotes.includes('ACL Policies'),
    'traefik structured notes must document how to issue a Nomad read-only token',
  );

  const prometheus = STARTER_SAMPLES.find((s) => s.id === 'prometheus');
  assert.ok(prometheus);
  const promNotes = getBlueprintNotes(prometheus, 'zh').map((n) => n.detail).join('\n');
  assert.ok(
    promNotes.includes('prometheus_metrics') && promNotes.includes('签发 Client Token'),
    'prometheus structured notes must document telemetry setting and ACL token acquisition',
  );

  const rocketmq = STARTER_SAMPLES.find((s) => s.id === 'rocketmq');
  assert.ok(rocketmq?.hcl.includes('${NOMAD_ADDR_namesrv}'), 'rocketmq broker must reference NOMAD_ADDR_namesrv');

  const nginxGw = STARTER_SAMPLES.find((s) => s.id === 'nginx-gateway');
  assert.ok(nginxGw?.hcl.includes('nginx:alpine') && nginxGw?.hcl.includes('SIGHUP'), 'nginx-gateway must use nginx:alpine and SIGHUP');
  const openrestyGw = STARTER_SAMPLES.find((s) => s.id === 'openresty-gateway');
  assert.ok(openrestyGw?.hcl.includes('openresty/openresty:alpine') && openrestyGw?.hcl.includes('ban-check.lua'), 'openresty-gateway must include Lua WAF');
  const acmeSync = STARTER_SAMPLES.find((s) => s.id === 'acme-cert-sync');
  assert.ok(acmeSync && acmeSync.hcl.includes('periodic') && acmeSync.hcl.includes('acme.sh'), 'acme-cert-sync must be a periodic acme.sh job');
  assert.ok(
    getBlueprintNotes(acmeSync, 'zh').some((n) => n.detail.includes('secret/data/certs/tls')),
    'acme-cert-sync notes must explain read/write custom policy',
  );

  for (const id of ['caddy', 'traefik', 'nginx-gateway', 'openresty-gateway', 'rabbitmq', 'rocketmq', 'prometheus', 'grafana', 'docker_registry']) {
    const bp = STARTER_SAMPLES.find((s) => s.id === id);
    assert.ok(bp?.hcl.includes('shutdown_delay'), `${id} with service block must define shutdown_delay`);
  }
});
