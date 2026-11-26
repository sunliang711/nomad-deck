import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeAt } from '../src/lib/hclBuilder.ts';
import {
  addGroupPort,
  addGroupService,
  addJobConstraint,
  addReadyGroup,
  addReadyTask,
  addServiceCheck,
  addTaskEnvRow,
  addTaskTemplateBlock,
  findJobPath,
  getAttrExpr,
  listChildBlocks,
  listGroupPorts,
  listTaskEnvRows,
  listUnhandledBlocks,
  parseLiteralStringList,
  setGroupEphemeralDisk,
  setJobPeriodic,
  setJobUpdateStrategy,
  setTaskDriver,
  setTaskResources,
  setTaskVault,
  toggleTaskDockerPort,
  unwrapHeredocOrString,
  updateGroupPort,
  updateTaskTemplateBlock,
  wrapHeredoc,
} from '../src/lib/hclVisualModel.ts';

function baseDoc() {
  return {
    nodes: [
      {
        kind: 'block',
        name: 'job',
        labels: ['demo'],
        leading: '# top comment\n',
        body: {
          nodes: [
            { kind: 'attribute', name: 'datacenters', expression: '["dc1"]', leading: '\n' },
            { kind: 'attribute', name: 'type', expression: '"service"', leading: '\n' },
          ],
          trailing: '\n',
        },
      },
    ],
    trailing: '\n',
  };
}

test('addReadyGroup and addReadyTask scaffold valid docker tasks while preserving top comments', () => {
  const doc0 = baseDoc();
  const jobPath = findJobPath(doc0);
  assert.deepEqual(jobPath, [0]);

  const { document: doc1, path: groupPath } = addReadyGroup(doc0, jobPath, { name: 'web', count: 2 });
  assert.equal(nodeAt(doc1, [0]).leading, '# top comment\n');
  assert.equal(nodeAt(doc1, groupPath).labels[0], 'web');
  assert.equal(getAttrExpr(doc1, groupPath, 'count'), '2');

  const tasks = listChildBlocks(doc1, groupPath, 'task');
  assert.equal(tasks.length, 1);
  assert.equal(getAttrExpr(doc1, tasks[0].path, 'driver'), '"docker"');

  const { document: doc2, path: task2Path } = addReadyTask(doc1, groupPath, { name: 'sidecar', image: 'busybox:latest', cpu: 50, memory: 64 });
  assert.equal(nodeAt(doc2, task2Path).labels[0], 'sidecar');
  assert.equal(listChildBlocks(doc2, groupPath, 'task').length, 2);
});

test('group ports, task docker port binding, resources, env, and driver switching mutate cleanly', () => {
  let doc = baseDoc();
  const jobPath = findJobPath(doc);
  const { document: withGrp, path: groupPath } = addReadyGroup(doc, jobPath, { name: 'app' });
  doc = addGroupPort(withGrp, groupPath, { label: 'http', staticPort: 8080, toPort: 80 });

  let ports = listGroupPorts(doc, groupPath);
  assert.equal(ports.length, 1);
  assert.equal(ports[0].label, 'http');
  assert.equal(ports[0].staticPort, '8080');
  assert.equal(ports[0].toPort, '80');

  doc = updateGroupPort(doc, ports[0].path, { staticPort: '', toPort: '8081' });
  ports = listGroupPorts(doc, groupPath);
  assert.equal(ports[0].staticPort, '');
  assert.equal(ports[0].toPort, '8081');

  const taskPath = listChildBlocks(doc, groupPath, 'task')[0].path;
  doc = toggleTaskDockerPort(doc, taskPath, 'http');
  const cfgPath = listChildBlocks(doc, taskPath, 'config')[0].path;
  assert.deepEqual(parseLiteralStringList(getAttrExpr(doc, cfgPath, 'ports')), ['http']);

  doc = toggleTaskDockerPort(doc, taskPath, 'http');
  assert.equal(getAttrExpr(doc, cfgPath, 'ports'), undefined);

  doc = setTaskResources(doc, taskPath, { cpu: 500, memory: 512 });
  const resPath = listChildBlocks(doc, taskPath, 'resources')[0].path;
  assert.equal(getAttrExpr(doc, resPath, 'cpu'), '500');
  assert.equal(getAttrExpr(doc, resPath, 'memory'), '512');

  doc = addTaskEnvRow(doc, taskPath, 'LOG_LEVEL', 'debug');
  const envInfo = listTaskEnvRows(doc, taskPath);
  assert.equal(envInfo.mode, 'block');
  assert.equal(envInfo.rows.length, 1);
  assert.equal(envInfo.rows[0].key, 'LOG_LEVEL');
  assert.equal(envInfo.rows[0].value, 'debug');

  doc = setTaskDriver(doc, taskPath, 'raw_exec');
  assert.equal(getAttrExpr(doc, taskPath, 'driver'), '"raw_exec"');
  assert.equal(getAttrExpr(doc, cfgPath, 'command'), '"/bin/sh"');
});

test('heredoc unwrap/wrap and template editing preserve non-colliding delimiters', () => {
  const raw = '<<EOT\n{{ with secret "secret/data/apps/db" }}{{ .Data.data.password }}{{ end }}\nEOT';
  const parsed = unwrapHeredocOrString(raw);
  assert.equal(parsed.editable, true);
  assert.equal(parsed.marker, 'EOT');
  assert.match(parsed.text, /secret\/data\/apps\/db/);

  const wrapped = wrapHeredoc('line1\nEOT\nline2', 'EOT');
  assert.match(wrapped, /^<<EOT_END\n/);
  assert.match(wrapped, /\nEOT_END$/);

  let doc = baseDoc();
  const { document: d1, path: gp } = addReadyGroup(doc, [0]);
  const tp = listChildBlocks(d1, gp, 'task')[0].path;
  doc = setTaskVault(d1, tp, 'postgres', { env: false });
  doc = addTaskTemplateBlock(doc, tp, { destination: 'secrets/db.pass', env: false, perms: '0600', data: 'abc' });
  const tplPath = listChildBlocks(doc, tp, 'template')[0].path;
  doc = updateTaskTemplateBlock(doc, tplPath, { mode: 'env', dataText: 'FOO=bar' });
  assert.equal(getAttrExpr(doc, tplPath, 'env'), 'true');
  assert.equal(getAttrExpr(doc, tplPath, 'perms'), undefined);
  assert.match(getAttrExpr(doc, tplPath, 'data'), /<<EOT\nFOO=bar\nEOT/);
});

test('optional Job/Group features and unhandled block detection work cleanly', () => {
  let doc = baseDoc();
  doc = setJobUpdateStrategy(doc, [0], true, { maxParallel: 2, autoRevert: true });
  doc = setJobPeriodic(doc, [0], true, { cron: '*/5 * * * *', prohibitOverlap: true });
  doc = addJobConstraint(doc, [0], { attribute: '${node.class}', operator: '=', value: 'db' });

  const { document: d1, path: gp } = addReadyGroup(doc, [0]);
  doc = setGroupEphemeralDisk(d1, gp, true, { size: 1024, sticky: true });
  doc = addGroupService(doc, gp, { name: 'pg', port: 'db', provider: 'nomad' });
  const svcPath = listChildBlocks(doc, gp, 'service')[0].path;
  doc = addServiceCheck(doc, svcPath, { type: 'tcp', interval: '10s', timeout: '2s' });

  assert.equal(listChildBlocks(doc, [0], 'update').length, 1);
  assert.equal(listChildBlocks(doc, [0], 'periodic').length, 1);
  assert.equal(listChildBlocks(doc, [0], 'constraint').length, 1);
  assert.equal(listChildBlocks(doc, svcPath, 'check').length, 1);

  const extra = listUnhandledBlocks(doc, gp, new Set(['task', 'network', 'ephemeral_disk']));
  assert.equal(extra.length, 1);
  assert.equal(extra[0].name, 'service');
});
