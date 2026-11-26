import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { applyVaultToTask, canInsert, contextAt, createBlock, duplicateBlock, moveNode, nodeAt } from '../src/lib/hclBuilder.ts';

const schema = JSON.parse(readFileSync(new URL('../../internal/jobspec/builder_schema.json', import.meta.url)));
const attribute = (name, expression) => ({ kind: 'attribute', name, expression, leading: '\n' });
const block = (name, labels, nodes = []) => ({ kind: 'block', name, labels, leading: '\n', body: { nodes, trailing: '\n' } });

// fixture represents multiple groups and tasks with repeated templates and source comments.
function fixture() {
  const task = block('task', ['one'], [attribute('driver', '"docker"'), block('config', [], [attribute('image', 'local.image')]), block('resources', [], [attribute('cpu', 'var.cpu')]), block('template', [], [attribute('destination', '"local/one"')]), block('template', [], [attribute('destination', '"local/two"')])]);
  task.leading = '\n# task comment\n';
  return { nodes: [block('job', ['job'], [block('group', ['app'], [task, block('task', ['two'], [attribute('driver', '"exec"')])]), block('group', ['worker'], [block('task', ['other'], [attribute('driver', '"exec"')])])])], trailing: '\n# trailing\n' };
}

test('Nomad singletons and repeated children follow the pinned HCL schema', () => {
  const doc = fixture();
  assert.equal(canInsert(doc, [0, 0, 0], block('resources', []), schema), false);
  assert.equal(canInsert(doc, [0, 0, 0], block('template', []), schema), true);
  assert.equal(canInsert(doc, [0, 0, 0], block('task', ['nested']), schema), false);
  assert.equal(canInsert(doc, [0], block('task', ['outside']), schema), false);
  assert.equal(canInsert(doc, [0, 0], block('task', ['one']), schema), false);
  assert.equal(canInsert(doc, [0, 0], block('task', ['new']), schema), true);
  assert.equal(canInsert(doc, [0, 0, 0], attribute('driver', '"exec"'), schema), false);
});

test('task copies have unique labels and keep all nested configuration without mutating their source', () => {
  const doc = fixture();
  const original = structuredClone(doc);
  const result = duplicateBlock(doc, [0, 0, 0], schema);
  assert.deepEqual(doc, original);
  const copy = nodeAt(result.document, result.path);
  assert.deepEqual(copy.labels, ['one-copy']);
  assert.deepEqual(copy.body, nodeAt(doc, [0, 0, 0]).body);
  assert.match(copy.leading, /task comment/);
  assert.throws(() => duplicateBlock(doc, [0, 0, 0, 2], schema), /单个块/);
});

test('attribute-form maps also occupy singleton block slots', () => {
  const doc = fixture();
  nodeAt(doc, [0, 0, 0]).body.nodes.push(attribute('env', '{ MODE = "test" }'));
  assert.equal(canInsert(doc, [0, 0, 0], block('env', []), schema), false);
});

test('moving tasks between groups preserves expressions, comments and document history snapshots', () => {
  const doc = fixture();
  const result = moveNode(doc, [0, 0, 0], [0, 1], schema);
  assert.equal(nodeAt(doc, [0, 0]).body.nodes.length, 2);
  assert.equal(nodeAt(result.document, [0, 0]).body.nodes.length, 1);
  assert.equal(nodeAt(result.document, [0, 1]).body.nodes.length, 2);
  assert.equal(nodeAt(result.document, [...result.path, 1, 0]).expression, 'local.image');
  assert.equal(nodeAt(result.document, [...result.path, 2, 0]).expression, 'var.cpu');
  assert.match(nodeAt(result.document, result.path).leading, /task comment/);
  assert.equal(result.document.trailing, doc.trailing);
  assert.throws(() => moveNode(doc, [0, 0], [0, 0, 0], schema), /自身/);
});

test('moving a group service into a later task adjusts the target path after removal', () => {
  const doc = fixture();
  nodeAt(doc, [0, 0]).body.nodes.unshift(block('service', [], [attribute('name', '"web"')]));
  const result = moveNode(doc, [0, 0, 0], [0, 0, 1], schema);
  assert.deepEqual(result.path, [0, 0, 0, 5]);
  assert.equal(nodeAt(result.document, result.path).name, 'service');
  assert.deepEqual(nodeAt(result.document, [0, 0, 0]).labels, ['one']);
});

test('driver config changes its palette while retaining unknown fields for explicit editing', () => {
  const doc = fixture();
  assert.equal(contextAt(doc, [0, 0, 0, 1], schema), 'driver.docker');
  nodeAt(doc, [0, 0, 0, 0]).expression = '"exec"';
  assert.equal(contextAt(doc, [0, 0, 0, 1], schema), 'driver.exec');
  assert.equal(nodeAt(doc, [0, 0, 0, 1, 0]).expression, 'local.image');
  nodeAt(doc, [0, 0, 0, 0]).expression = 'var.driver';
  assert.equal(contextAt(doc, [0, 0, 0, 1], schema), 'DriverConfig');
});

test('new task blocks seed the required driver and avoid existing names', () => {
  const doc = fixture();
  const rule = schema.types.TaskGroup.blocks.find((entry) => entry.name === 'task');
  const task = createBlock(doc, [0, 0], rule, schema);
  assert.equal(task.body.nodes.find((entry) => entry.name === 'driver').expression, '"docker"');
  assert.equal(task.labels[0], 'task');
  nodeAt(doc, [0, 0]).body.nodes.push(task);
  assert.equal(createBlock(doc, [0, 0], rule, schema).labels[0], 'task-2');
});

test('Docker mount blocks repeat while bind options and logging are singletons', () => {
  const docker = schema.types['driver.docker'];
  assert.equal(docker.blocks.find((entry) => entry.name === 'mount').max, 0);
  assert.equal(docker.blocks.find((entry) => entry.name === 'logging').max, 1);
  const mount = schema.types[docker.blocks.find((entry) => entry.name === 'mount').type];
  assert.equal(mount.blocks.find((entry) => entry.name === 'bind_options').max, 1);
  assert.equal(docker.blocks.find((entry) => entry.name === 'auth').max, 1);
});

test('applyVaultToTask inserts vault block, optional secret file env, and template block cleanly', () => {
  const doc = fixture();
  const next = applyVaultToTask(doc, [0, 0, 0], {
    role: 'postgres',
    templateData: '{{ with secret "secret/data/apps/postgres" }}{{ .Data.data.password }}{{ end }}',
    mode: 'file',
    fileName: 'db.pass',
    envVarName: 'DB_PASSWORD_FILE',
  });
  const taskBody = nodeAt(next, [0, 0, 0]).body;
  const vault = taskBody.nodes.find((entry) => entry.kind === 'block' && entry.name === 'vault');
  assert.equal(vault.body.nodes.find((entry) => entry.name === 'role').expression, '"postgres"');
  assert.equal(vault.body.nodes.find((entry) => entry.name === 'env').expression, 'false');
  const env = taskBody.nodes.find((entry) => entry.kind === 'block' && entry.name === 'env');
  assert.equal(env.body.nodes.find((entry) => entry.name === 'DB_PASSWORD_FILE').expression, '"/secrets/db.pass"');
  const templates = taskBody.nodes.filter((entry) => entry.kind === 'block' && entry.name === 'template');
  assert.equal(templates.length, 3);
  assert.equal(templates[2].body.nodes.find((entry) => entry.name === 'destination').expression, '"secrets/db.pass"');
  assert.equal(templates[2].body.nodes.find((entry) => entry.name === 'perms').expression, '"0600"');
});
