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
    assert.ok(!sample.hcl.includes('undefined'), `${sample.id} contains unexpected undefined`);
  }

  const rocketmq = STARTER_SAMPLES.find((s) => s.id === 'rocketmq');
  assert.ok(rocketmq?.hcl.includes('${NOMAD_ADDR_namesrv}'), 'rocketmq broker must reference NOMAD_ADDR_namesrv');
});
