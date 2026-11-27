import {
  bodyAt,
  editDocument,
  nodeAt,
  uniqueLabel,
  type HCLDocument,
  type HCLNode,
  type NodePath,
} from './hclBuilder.ts';
import { trText } from './locale.ts';

export interface IndexedBlock {
  path: NodePath;
  node: HCLNode;
  name: string;
  label: string;
}

export function parseLiteralString(expression?: string): string | undefined {
  if (!expression) return undefined;
  try {
    const val = JSON.parse(expression);
    if (typeof val === 'string') return val;
  } catch {
    // Non-JSON literal (e.g. heredoc or HCL traversal).
  }
  return undefined;
}

export function parseLiteralNumber(expression?: string): number | undefined {
  if (!expression) return undefined;
  try {
    const val = JSON.parse(expression);
    if (typeof val === 'number' && Number.isFinite(val)) return val;
  } catch {
    // Non-numeric expression.
  }
  return undefined;
}

export function parseLiteralBool(expression?: string): boolean | undefined {
  if (!expression) return undefined;
  try {
    const val = JSON.parse(expression);
    if (typeof val === 'boolean') return val;
  } catch {
    // Non-boolean expression.
  }
  return undefined;
}

export function parseLiteralStringList(expression?: string): string[] | undefined {
  if (!expression) return undefined;
  try {
    const val = JSON.parse(expression);
    if (Array.isArray(val) && val.every((item) => typeof item === 'string')) return val;
  } catch {
    // Dynamic HCL list expression.
  }
  return undefined;
}

/**
 * Extracts readable multiline text from either a quoted string literal or an
 * HCL heredoc (`<<EOT\n...\nEOT` / `<<-EOT\n...\nEOT`).
 */
export function unwrapHeredocOrString(expression?: string): { text: string; editable: boolean; marker: string; indented: boolean } {
  if (!expression) return { text: '', editable: true, marker: 'EOT', indented: false };
  const quoted = parseLiteralString(expression);
  if (quoted !== undefined) {
    return { text: quoted, editable: true, marker: 'EOT', indented: false };
  }
  const match = expression.match(/^<<(-)?([A-Za-z_][A-Za-z0-9_]*)\r?\n([\s\S]*?)\r?\n[ \t]*\2$/);
  if (match) {
    return {
      text: match[3],
      editable: true,
      marker: match[2],
      indented: Boolean(match[1]),
    };
  }
  const emptyMatch = expression.match(/^<<(-)?([A-Za-z_][A-Za-z0-9_]*)\r?\n[ \t]*\2$/);
  if (emptyMatch) {
    return {
      text: '',
      editable: true,
      marker: emptyMatch[2],
      indented: Boolean(emptyMatch[1]),
    };
  }
  return { text: expression, editable: false, marker: 'EOT', indented: false };
}

/**
 * Formats multiline template content safely as an HCL heredoc expression,
 * picking a non-colliding delimiter if needed.
 */
export function wrapHeredoc(text: string, preferredMarker = 'EOT', indented = false): string {
  const normalized = text.replace(/\r\n/g, '\n');
  let marker = preferredMarker || 'EOT';
  const lines = normalized.split('\n');
  while (lines.some((line) => line.trim() === marker)) {
    marker = `${marker}_END`;
  }
  const body = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  return `<<${indented ? '-' : ''}${marker}\n${body}${marker}`;
}

export function findJobPath(doc: HCLDocument): NodePath | null {
  const idx = doc.nodes.findIndex((n) => n.kind === 'block' && n.name === 'job');
  return idx >= 0 ? [idx] : null;
}

export function listChildBlocks(doc: HCLDocument, parentPath: NodePath, blockName: string): IndexedBlock[] {
  const body = bodyAt(doc, parentPath);
  const result: IndexedBlock[] = [];
  body.nodes.forEach((node, index) => {
    if (node.kind === 'block' && node.name === blockName) {
      result.push({
        path: [...parentPath, index],
        node,
        name: node.name,
        label: node.labels?.[0] || '',
      });
    }
  });
  return result;
}

export function findChildBlock(doc: HCLDocument, parentPath: NodePath, blockName: string): IndexedBlock | null {
  return listChildBlocks(doc, parentPath, blockName)[0] || null;
}

export function getAttrNode(body: HCLDocument | undefined, name: string): HCLNode | undefined {
  return body?.nodes.find((n) => n.kind === 'attribute' && n.name === name);
}

export function getAttrExpr(doc: HCLDocument, bodyPath: NodePath, name: string): string | undefined {
  return getAttrNode(bodyAt(doc, bodyPath), name)?.expression;
}

/**
 * Sets an attribute expression on a block body, or removes it when `expression` is null.
 */
export function setAttrExpr(
  doc: HCLDocument,
  bodyPath: NodePath,
  name: string,
  expression: string | null,
): HCLDocument {
  return editDocument(doc, (draft) => {
    const body = bodyAt(draft, bodyPath);
    const idx = body.nodes.findIndex((n) => n.kind === 'attribute' && n.name === name);
    if (expression === null) {
      if (idx >= 0) body.nodes.splice(idx, 1);
      return;
    }
    if (idx >= 0) {
      body.nodes[idx].expression = expression;
    } else {
      body.nodes.push({ kind: 'attribute', name, expression, leading: '\n' });
    }
  });
}

export function setBlockLabel(doc: HCLDocument, blockPath: NodePath, label: string, index = 0): HCLDocument {
  return editDocument(doc, (draft) => {
    const target = nodeAt(draft, blockPath);
    if (!target || target.kind !== 'block') return;
    target.labels = target.labels ? [...target.labels] : [];
    target.labels[index] = label;
  });
}

export function ensureChildBlockInDraft(
  draft: HCLDocument,
  parentPath: NodePath,
  blockName: string,
  labels: string[] = [],
): HCLNode {
  const body = bodyAt(draft, parentPath);
  let blk = body.nodes.find((n) => n.kind === 'block' && n.name === blockName);
  if (!blk) {
    blk = {
      kind: 'block',
      name: blockName,
      labels,
      leading: '\n',
      body: { nodes: [], trailing: '\n' },
    };
    body.nodes.push(blk);
  }
  blk.body = blk.body || { nodes: [], trailing: '\n' };
  return blk;
}

export function upsertAttrInBody(body: HCLDocument, name: string, expression: string | null) {
  const idx = body.nodes.findIndex((n) => n.kind === 'attribute' && n.name === name);
  if (expression === null) {
    if (idx >= 0) body.nodes.splice(idx, 1);
    return;
  }
  if (idx >= 0) {
    body.nodes[idx].expression = expression;
  } else {
    body.nodes.push({ kind: 'attribute', name, expression, leading: '\n' });
  }
}

export function removeNodeAtPath(doc: HCLDocument, path: NodePath): HCLDocument {
  if (!path.length) return doc;
  return editDocument(doc, (draft) => {
    const parent = bodyAt(draft, path.slice(0, -1));
    parent.nodes.splice(path[path.length - 1], 1);
  });
}

/**
 * Adds a ready-to-run Task block (docker driver + image + resources) inside a Group.
 */
export function addReadyTask(
  doc: HCLDocument,
  groupPath: NodePath,
  preset: { name?: string; driver?: string; image?: string; cpu?: number; memory?: number } = {},
): { document: HCLDocument; path: NodePath } {
  const groupBody = bodyAt(doc, groupPath);
  const taskName = uniqueLabel(groupBody, 'task', preset.name || 'app');
  const driver = preset.driver || 'docker';
  const cpu = preset.cpu ?? 100;
  const memory = preset.memory ?? 128;

  const configNodes: HCLNode[] =
    driver === 'docker'
      ? [{ kind: 'attribute', name: 'image', expression: JSON.stringify(preset.image || 'nginx:alpine'), leading: '\n' }]
      : [
          { kind: 'attribute', name: 'command', expression: '"/bin/sh"', leading: '\n' },
          { kind: 'attribute', name: 'args', expression: '["-c", "echo hello && sleep 3600"]', leading: '\n' },
        ];

  const taskNode: HCLNode = {
    kind: 'block',
    name: 'task',
    labels: [taskName],
    leading: '\n',
    body: {
      nodes: [
        { kind: 'attribute', name: 'driver', expression: JSON.stringify(driver), leading: '\n' },
        { kind: 'block', name: 'config', labels: [], leading: '\n', body: { nodes: configNodes, trailing: '\n' } },
        {
          kind: 'block',
          name: 'resources',
          labels: [],
          leading: '\n',
          body: {
            nodes: [
              { kind: 'attribute', name: 'cpu', expression: String(cpu), leading: '\n' },
              { kind: 'attribute', name: 'memory', expression: String(memory), leading: '\n' },
            ],
            trailing: '\n',
          },
        },
      ],
      trailing: '\n',
    },
  };

  const nextIdx = groupBody.nodes.length;
  const nextDoc = editDocument(doc, (draft) => {
    bodyAt(draft, groupPath).nodes.push(taskNode);
  });
  return { document: nextDoc, path: [...groupPath, nextIdx] };
}

/**
 * Adds a ready-to-run Task Group (count = 1 + starter task) inside a Job.
 */
export function addReadyGroup(
  doc: HCLDocument,
  jobPath: NodePath,
  preset: { name?: string; count?: number; taskName?: string; image?: string } = {},
): { document: HCLDocument; path: NodePath } {
  const jobBody = bodyAt(doc, jobPath);
  const groupName = uniqueLabel(jobBody, 'group', preset.name || 'service');
  const nextIdx = jobBody.nodes.length;
  const withGroup = editDocument(doc, (draft) => {
    bodyAt(draft, jobPath).nodes.push({
      kind: 'block',
      name: 'group',
      labels: [groupName],
      leading: '\n',
      body: {
        nodes: [{ kind: 'attribute', name: 'count', expression: String(preset.count ?? 1), leading: '\n' }],
        trailing: '\n',
      },
    });
  });
  const groupPath = [...jobPath, nextIdx];
  const withTask = addReadyTask(withGroup, groupPath, {
    name: preset.taskName || 'server',
    image: preset.image || 'nginx:alpine',
  });
  return { document: withTask.document, path: groupPath };
}

export interface GroupPortInfo {
  path: NodePath;
  label: string;
  staticPort: string;
  toPort: string;
  hostNetwork: string;
}

export function listGroupPorts(doc: HCLDocument, groupPath: NodePath): GroupPortInfo[] {
  const net = findChildBlock(doc, groupPath, 'network');
  if (!net || !net.node.body) return [];
  const ports: GroupPortInfo[] = [];
  net.node.body.nodes.forEach((n, idx) => {
    if (n.kind !== 'block' || n.name !== 'port') return;
    const s = parseLiteralNumber(getAttrNode(n.body, 'static')?.expression);
    const t = parseLiteralNumber(getAttrNode(n.body, 'to')?.expression);
    const hn = parseLiteralString(getAttrNode(n.body, 'host_network')?.expression);
    ports.push({
      path: [...net.path, idx],
      label: n.labels?.[0] || '',
      staticPort: s !== undefined ? String(s) : '',
      toPort: t !== undefined ? String(t) : '',
      hostNetwork: hn || '',
    });
  });
  return ports;
}

export function addGroupPort(
  doc: HCLDocument,
  groupPath: NodePath,
  opts: { label?: string; staticPort?: number | null; toPort?: number | null } = {},
): HCLDocument {
  return editDocument(doc, (draft) => {
    const net = ensureChildBlockInDraft(draft, groupPath, 'network');
    const netBody = net.body!;
    const label = uniqueLabel(netBody, 'port', opts.label || 'http');
    const nodes: HCLNode[] = [];
    if (opts.staticPort != null && opts.staticPort > 0) {
      nodes.push({ kind: 'attribute', name: 'static', expression: String(opts.staticPort), leading: '\n' });
    }
    if (opts.toPort != null && opts.toPort > 0) {
      nodes.push({ kind: 'attribute', name: 'to', expression: String(opts.toPort), leading: '\n' });
    }
    netBody.nodes.push({
      kind: 'block',
      name: 'port',
      labels: [label],
      leading: '\n',
      body: { nodes, trailing: '\n' },
    });
  });
}

export function updateGroupPort(
  doc: HCLDocument,
  portPath: NodePath,
  patch: { label?: string; staticPort?: string; toPort?: string; hostNetwork?: string },
): HCLDocument {
  return editDocument(doc, (draft) => {
    const portNode = nodeAt(draft, portPath);
    if (!portNode || portNode.kind !== 'block' || !portNode.body) return;
    if (patch.label !== undefined) {
      portNode.labels = [patch.label];
    }
    if (patch.staticPort !== undefined) {
      const trimmed = patch.staticPort.trim();
      const num = Number(trimmed);
      upsertAttrInBody(portNode.body, 'static', trimmed && Number.isInteger(num) && num > 0 ? String(num) : null);
    }
    if (patch.toPort !== undefined) {
      const trimmed = patch.toPort.trim();
      const num = Number(trimmed);
      upsertAttrInBody(portNode.body, 'to', trimmed && Number.isInteger(num) && num > 0 ? String(num) : null);
    }
    if (patch.hostNetwork !== undefined) {
      const trimmed = patch.hostNetwork.trim();
      upsertAttrInBody(portNode.body, 'host_network', trimmed ? JSON.stringify(trimmed) : null);
    }
  });
}

/**
 * Toggles a Group port label inside a Task's `config.ports` list.
 */
export function toggleTaskDockerPort(doc: HCLDocument, taskPath: NodePath, portLabel: string): HCLDocument {
  return editDocument(doc, (draft) => {
    const cfg = ensureChildBlockInDraft(draft, taskPath, 'config');
    const cfgBody = cfg.body!;
    const current = parseLiteralStringList(getAttrNode(cfgBody, 'ports')?.expression) || [];
    const exists = current.includes(portLabel);
    const next = exists ? current.filter((p) => p !== portLabel) : [...current, portLabel];
    upsertAttrInBody(cfgBody, 'ports', next.length > 0 ? JSON.stringify(next) : null);
  });
}

export function setTaskResources(
  doc: HCLDocument,
  taskPath: NodePath,
  patch: { cpu?: number | null; memory?: number | null; memoryMax?: number | null },
): HCLDocument {
  return editDocument(doc, (draft) => {
    const res = ensureChildBlockInDraft(draft, taskPath, 'resources');
    const resBody = res.body!;
    if (patch.cpu !== undefined) {
      upsertAttrInBody(resBody, 'cpu', patch.cpu != null && patch.cpu > 0 ? String(Math.round(patch.cpu)) : null);
    }
    if (patch.memory !== undefined) {
      upsertAttrInBody(resBody, 'memory', patch.memory != null && patch.memory > 0 ? String(Math.round(patch.memory)) : null);
    }
    if (patch.memoryMax !== undefined) {
      upsertAttrInBody(
        resBody,
        'memory_max',
        patch.memoryMax != null && patch.memoryMax > 0 ? String(Math.round(patch.memoryMax)) : null,
      );
    }
  });
}

export function setTaskConfigAttr(
  doc: HCLDocument,
  taskPath: NodePath,
  attrName: string,
  expression: string | null,
): HCLDocument {
  return editDocument(doc, (draft) => {
    const cfg = ensureChildBlockInDraft(draft, taskPath, 'config');
    upsertAttrInBody(cfg.body!, attrName, expression);
  });
}

export function setTaskDriver(doc: HCLDocument, taskPath: NodePath, nextDriver: string): HCLDocument {
  return editDocument(doc, (draft) => {
    const taskBody = bodyAt(draft, taskPath);
    upsertAttrInBody(taskBody, 'driver', JSON.stringify(nextDriver));
    const cfg = ensureChildBlockInDraft(draft, taskPath, 'config');
    const cfgBody = cfg.body!;
    if (nextDriver === 'docker' && !getAttrNode(cfgBody, 'image')) {
      upsertAttrInBody(cfgBody, 'image', '"nginx:alpine"');
    } else if ((nextDriver === 'exec' || nextDriver === 'raw_exec') && !getAttrNode(cfgBody, 'command')) {
      upsertAttrInBody(cfgBody, 'command', '"/bin/sh"');
    }
  });
}

export interface EnvRowInfo {
  path: NodePath;
  key: string;
  value: string;
  isRawExpression: boolean;
}

export function listTaskEnvRows(doc: HCLDocument, taskPath: NodePath): {
  mode: 'block' | 'attribute' | 'none';
  rows: EnvRowInfo[];
  rawExpression?: string;
} {
  const taskBody = bodyAt(doc, taskPath);
  const envAttr = getAttrNode(taskBody, 'env');
  if (envAttr) {
    return { mode: 'attribute', rows: [], rawExpression: envAttr.expression };
  }
  const envBlock = findChildBlock(doc, taskPath, 'env');
  if (!envBlock || !envBlock.node.body) return { mode: 'none', rows: [] };
  const rows: EnvRowInfo[] = [];
  envBlock.node.body.nodes.forEach((n, idx) => {
    if (n.kind !== 'attribute') return;
    const str = parseLiteralString(n.expression);
    rows.push({
      path: [...envBlock.path, idx],
      key: n.name,
      value: str !== undefined ? str : (n.expression || ''),
      isRawExpression: str === undefined,
    });
  });
  return { mode: 'block', rows };
}

export function addTaskEnvRow(doc: HCLDocument, taskPath: NodePath, key = '', value = ''): HCLDocument {
  return editDocument(doc, (draft) => {
    const env = ensureChildBlockInDraft(draft, taskPath, 'env');
    const existing = new Set(env.body!.nodes.filter((n) => n.kind === 'attribute').map((n) => n.name));
    let nextKey = key || 'APP_ENV';
    if (!key) {
      let i = 1;
      while (existing.has(nextKey)) {
        nextKey = `APP_ENV_${++i}`;
      }
    }
    env.body!.nodes.push({
      kind: 'attribute',
      name: nextKey,
      expression: JSON.stringify(value),
      leading: '\n',
    });
  });
}

export function updateTaskEnvRow(
  doc: HCLDocument,
  rowPath: NodePath,
  patch: { key?: string; value?: string; raw?: boolean },
): HCLDocument {
  return editDocument(doc, (draft) => {
    const target = nodeAt(draft, rowPath);
    if (!target || target.kind !== 'attribute') return;
    if (patch.key !== undefined) target.name = patch.key;
    if (patch.value !== undefined) {
      target.expression = patch.raw ? patch.value : JSON.stringify(patch.value);
    }
  });
}

export function setGroupEphemeralDisk(
  doc: HCLDocument,
  groupPath: NodePath,
  enabled: boolean,
  patch?: { size?: number; sticky?: boolean; migrate?: boolean },
): HCLDocument {
  return editDocument(doc, (draft) => {
    const groupBody = bodyAt(draft, groupPath);
    const idx = groupBody.nodes.findIndex((n) => n.kind === 'block' && n.name === 'ephemeral_disk');
    if (!enabled) {
      if (idx >= 0) groupBody.nodes.splice(idx, 1);
      return;
    }
    const blk = ensureChildBlockInDraft(draft, groupPath, 'ephemeral_disk');
    const b = blk.body!;
    if (patch?.size !== undefined) {
      upsertAttrInBody(b, 'size', patch.size > 0 ? String(Math.round(patch.size)) : '300');
    } else if (!getAttrNode(b, 'size')) {
      upsertAttrInBody(b, 'size', '512');
    }
    if (patch?.sticky !== undefined) {
      upsertAttrInBody(b, 'sticky', patch.sticky ? 'true' : 'false');
    }
    if (patch?.migrate !== undefined) {
      upsertAttrInBody(b, 'migrate', patch.migrate ? 'true' : 'false');
    }
  });
}

export function setGroupRestart(
  doc: HCLDocument,
  groupPath: NodePath,
  enabled: boolean,
  patch?: { attempts?: number; interval?: string; delay?: string; mode?: string },
): HCLDocument {
  return editDocument(doc, (draft) => {
    const groupBody = bodyAt(draft, groupPath);
    const idx = groupBody.nodes.findIndex((n) => n.kind === 'block' && n.name === 'restart');
    if (!enabled) {
      if (idx >= 0) groupBody.nodes.splice(idx, 1);
      return;
    }
    const blk = ensureChildBlockInDraft(draft, groupPath, 'restart');
    const b = blk.body!;
    if (patch?.attempts !== undefined) upsertAttrInBody(b, 'attempts', String(Math.max(0, Math.round(patch.attempts))));
    else if (!getAttrNode(b, 'attempts')) upsertAttrInBody(b, 'attempts', '3');
    if (patch?.interval !== undefined) upsertAttrInBody(b, 'interval', JSON.stringify(patch.interval || '10m'));
    else if (!getAttrNode(b, 'interval')) upsertAttrInBody(b, 'interval', '"10m"');
    if (patch?.delay !== undefined) upsertAttrInBody(b, 'delay', JSON.stringify(patch.delay || '15s'));
    else if (!getAttrNode(b, 'delay')) upsertAttrInBody(b, 'delay', '"15s"');
    if (patch?.mode !== undefined) upsertAttrInBody(b, 'mode', JSON.stringify(patch.mode || 'delay'));
    else if (!getAttrNode(b, 'mode')) upsertAttrInBody(b, 'mode', '"delay"');
  });
}

export function addGroupService(
  doc: HCLDocument,
  groupPath: NodePath,
  defaults: { name?: string; port?: string; provider?: string } = {},
): HCLDocument {
  return editDocument(doc, (draft) => {
    const groupBody = bodyAt(draft, groupPath);
    const nodes: HCLNode[] = [
      { kind: 'attribute', name: 'name', expression: JSON.stringify(defaults.name || 'my-service'), leading: '\n' },
      { kind: 'attribute', name: 'provider', expression: JSON.stringify(defaults.provider || 'nomad'), leading: '\n' },
    ];
    if (defaults.port) {
      nodes.push({ kind: 'attribute', name: 'port', expression: JSON.stringify(defaults.port), leading: '\n' });
    }
    groupBody.nodes.push({
      kind: 'block',
      name: 'service',
      labels: [],
      leading: '\n',
      body: { nodes, trailing: '\n' },
    });
  });
}

export function addServiceCheck(
  doc: HCLDocument,
  servicePath: NodePath,
  defaults: { type?: string; path?: string; interval?: string; timeout?: string } = {},
): HCLDocument {
  return editDocument(doc, (draft) => {
    const svcBody = bodyAt(draft, servicePath);
    const type = defaults.type || 'http';
    const nodes: HCLNode[] = [
      { kind: 'attribute', name: 'type', expression: JSON.stringify(type), leading: '\n' },
      ...(type === 'http'
        ? [{ kind: 'attribute' as const, name: 'path', expression: JSON.stringify(defaults.path || '/'), leading: '\n' }]
        : []),
      { kind: 'attribute', name: 'interval', expression: JSON.stringify(defaults.interval || '10s'), leading: '\n' },
      { kind: 'attribute', name: 'timeout', expression: JSON.stringify(defaults.timeout || '2s'), leading: '\n' },
    ];
    svcBody.nodes.push({
      kind: 'block',
      name: 'check',
      labels: [],
      leading: '\n',
      body: { nodes, trailing: '\n' },
    });
  });
}

export function setJobUpdateStrategy(
  doc: HCLDocument,
  jobPath: NodePath,
  enabled: boolean,
  patch?: { maxParallel?: number; minHealthyTime?: string; healthyDeadline?: string; autoRevert?: boolean },
): HCLDocument {
  return editDocument(doc, (draft) => {
    const jobBody = bodyAt(draft, jobPath);
    const idx = jobBody.nodes.findIndex((n) => n.kind === 'block' && n.name === 'update');
    if (!enabled) {
      if (idx >= 0) jobBody.nodes.splice(idx, 1);
      return;
    }
    const blk = ensureChildBlockInDraft(draft, jobPath, 'update');
    const b = blk.body!;
    if (patch?.maxParallel !== undefined) upsertAttrInBody(b, 'max_parallel', String(Math.max(1, Math.round(patch.maxParallel))));
    else if (!getAttrNode(b, 'max_parallel')) upsertAttrInBody(b, 'max_parallel', '1');
    if (patch?.minHealthyTime !== undefined) upsertAttrInBody(b, 'min_healthy_time', JSON.stringify(patch.minHealthyTime || '10s'));
    else if (!getAttrNode(b, 'min_healthy_time')) upsertAttrInBody(b, 'min_healthy_time', '"10s"');
    if (patch?.healthyDeadline !== undefined) upsertAttrInBody(b, 'healthy_deadline', JSON.stringify(patch.healthyDeadline || '3m'));
    else if (!getAttrNode(b, 'healthy_deadline')) upsertAttrInBody(b, 'healthy_deadline', '"3m"');
    if (patch?.autoRevert !== undefined) upsertAttrInBody(b, 'auto_revert', patch.autoRevert ? 'true' : 'false');
    else if (!getAttrNode(b, 'auto_revert')) upsertAttrInBody(b, 'auto_revert', 'true');
  });
}

export function setJobPeriodic(
  doc: HCLDocument,
  jobPath: NodePath,
  enabled: boolean,
  patch?: { cron?: string; prohibitOverlap?: boolean; timeZone?: string },
): HCLDocument {
  return editDocument(doc, (draft) => {
    const jobBody = bodyAt(draft, jobPath);
    const idx = jobBody.nodes.findIndex((n) => n.kind === 'block' && n.name === 'periodic');
    if (!enabled) {
      if (idx >= 0) jobBody.nodes.splice(idx, 1);
      return;
    }
    const blk = ensureChildBlockInDraft(draft, jobPath, 'periodic');
    const b = blk.body!;
    if (patch?.cron !== undefined) upsertAttrInBody(b, 'cron', JSON.stringify(patch.cron || '0 * * * *'));
    else if (!getAttrNode(b, 'cron')) upsertAttrInBody(b, 'cron', '"0 * * * *"');
    if (patch?.prohibitOverlap !== undefined) upsertAttrInBody(b, 'prohibit_overlap', patch.prohibitOverlap ? 'true' : 'false');
    else if (!getAttrNode(b, 'prohibit_overlap')) upsertAttrInBody(b, 'prohibit_overlap', 'true');
    if (patch?.timeZone !== undefined) upsertAttrInBody(b, 'time_zone', patch.timeZone.trim() ? JSON.stringify(patch.timeZone.trim()) : null);
  });
}

export function addJobConstraint(
  doc: HCLDocument,
  targetPath: NodePath,
  defaults: { attribute?: string; operator?: string; value?: string } = {},
): HCLDocument {
  return editDocument(doc, (draft) => {
    const body = bodyAt(draft, targetPath);
    body.nodes.push({
      kind: 'block',
      name: 'constraint',
      labels: [],
      leading: '\n',
      body: {
        nodes: [
          { kind: 'attribute', name: 'attribute', expression: JSON.stringify(defaults.attribute || '${attr.kernel.name}'), leading: '\n' },
          { kind: 'attribute', name: 'operator', expression: JSON.stringify(defaults.operator || '='), leading: '\n' },
          { kind: 'attribute', name: 'value', expression: JSON.stringify(defaults.value || 'linux'), leading: '\n' },
        ],
        trailing: '\n',
      },
    });
  });
}

export function setTaskVault(
  doc: HCLDocument,
  taskPath: NodePath,
  role: string | null,
  opts?: { env?: boolean; changeMode?: string },
): HCLDocument {
  return editDocument(doc, (draft) => {
    const taskBody = bodyAt(draft, taskPath);
    const idx = taskBody.nodes.findIndex((n) => n.kind === 'block' && n.name === 'vault');
    if (role === null) {
      if (idx >= 0) taskBody.nodes.splice(idx, 1);
      return;
    }
    const blk = ensureChildBlockInDraft(draft, taskPath, 'vault');
    const b = blk.body!;
    upsertAttrInBody(b, 'role', JSON.stringify(role));
    if (opts?.env !== undefined) {
      upsertAttrInBody(b, 'env', opts.env ? 'true' : 'false');
    } else if (!getAttrNode(b, 'env')) {
      upsertAttrInBody(b, 'env', 'false');
    }
    if (opts?.changeMode !== undefined) {
      upsertAttrInBody(b, 'change_mode', opts.changeMode ? JSON.stringify(opts.changeMode) : null);
    }
  });
}

export function addTaskTemplateBlock(
  doc: HCLDocument,
  taskPath: NodePath,
  opts: { destination?: string; env?: boolean; perms?: string; changeMode?: string; data?: string } = {},
): HCLDocument {
  return editDocument(doc, (draft) => {
    const taskBody = bodyAt(draft, taskPath);
    const isEnv = Boolean(opts.env);
    const nodes: HCLNode[] = [
      {
        kind: 'attribute',
        name: 'destination',
        expression: JSON.stringify(opts.destination || (isEnv ? 'secrets/app.env' : 'local/app.conf')),
        leading: '\n',
      },
      ...(isEnv
        ? [{ kind: 'attribute' as const, name: 'env', expression: 'true', leading: '\n' }]
        : opts.perms
          ? [{ kind: 'attribute' as const, name: 'perms', expression: JSON.stringify(opts.perms), leading: '\n' }]
          : []),
      {
        kind: 'attribute',
        name: 'change_mode',
        expression: JSON.stringify(opts.changeMode || 'restart'),
        leading: '\n',
      },
      {
        kind: 'attribute',
        name: 'data',
        expression: wrapHeredoc(opts.data || trText('# 模板内容', '# template content')),
        leading: '\n',
      },
    ];
    taskBody.nodes.push({
      kind: 'block',
      name: 'template',
      labels: [],
      leading: '\n',
      body: { nodes, trailing: '\n' },
    });
  });
}

export function updateTaskTemplateBlock(
  doc: HCLDocument,
  templatePath: NodePath,
  patch: { destination?: string; mode?: 'env' | 'file'; perms?: string; changeMode?: string; dataText?: string },
): HCLDocument {
  return editDocument(doc, (draft) => {
    const tpl = nodeAt(draft, templatePath);
    if (!tpl || tpl.kind !== 'block' || !tpl.body) return;
    const b = tpl.body;
    if (patch.destination !== undefined) {
      upsertAttrInBody(b, 'destination', JSON.stringify(patch.destination));
    }
    if (patch.mode !== undefined) {
      if (patch.mode === 'env') {
        upsertAttrInBody(b, 'env', 'true');
        upsertAttrInBody(b, 'perms', null);
      } else {
        upsertAttrInBody(b, 'env', null);
        if (!getAttrNode(b, 'perms')) upsertAttrInBody(b, 'perms', '"0600"');
      }
    }
    if (patch.perms !== undefined) {
      upsertAttrInBody(b, 'perms', patch.perms.trim() ? JSON.stringify(patch.perms.trim()) : null);
    }
    if (patch.changeMode !== undefined) {
      upsertAttrInBody(b, 'change_mode', patch.changeMode ? JSON.stringify(patch.changeMode) : null);
    }
    if (patch.dataText !== undefined) {
      const prev = unwrapHeredocOrString(getAttrNode(b, 'data')?.expression);
      upsertAttrInBody(b, 'data', wrapHeredoc(patch.dataText, prev.marker || 'EOT', prev.indented));
    }
  });
}

export function addGroupVolume(
  doc: HCLDocument,
  groupPath: NodePath,
  opts: { name?: string; type?: 'host' | 'csi'; source?: string; readOnly?: boolean } = {},
): HCLDocument {
  return editDocument(doc, (draft) => {
    const groupBody = bodyAt(draft, groupPath);
    const volName = uniqueLabel(groupBody, 'volume', opts.name || 'data');
    groupBody.nodes.push({
      kind: 'block',
      name: 'volume',
      labels: [volName],
      leading: '\n',
      body: {
        nodes: [
          { kind: 'attribute', name: 'type', expression: JSON.stringify(opts.type || 'host'), leading: '\n' },
          { kind: 'attribute', name: 'source', expression: JSON.stringify(opts.source || volName), leading: '\n' },
          { kind: 'attribute', name: 'read_only', expression: opts.readOnly ? 'true' : 'false', leading: '\n' },
        ],
        trailing: '\n',
      },
    });
  });
}

export function addTaskVolumeMount(
  doc: HCLDocument,
  taskPath: NodePath,
  opts: { volume?: string; destination?: string; readOnly?: boolean } = {},
): HCLDocument {
  return editDocument(doc, (draft) => {
    const taskBody = bodyAt(draft, taskPath);
    taskBody.nodes.push({
      kind: 'block',
      name: 'volume_mount',
      labels: [],
      leading: '\n',
      body: {
        nodes: [
          { kind: 'attribute', name: 'volume', expression: JSON.stringify(opts.volume || 'data'), leading: '\n' },
          { kind: 'attribute', name: 'destination', expression: JSON.stringify(opts.destination || '/data'), leading: '\n' },
          { kind: 'attribute', name: 'read_only', expression: opts.readOnly ? 'true' : 'false', leading: '\n' },
        ],
        trailing: '\n',
      },
    });
  });
}

export function listUnhandledBlocks(doc: HCLDocument, bodyPath: NodePath, handled: Set<string>): IndexedBlock[] {
  const body = bodyAt(doc, bodyPath);
  const out: IndexedBlock[] = [];
  body.nodes.forEach((node, idx) => {
    if (node.kind === 'block' && !handled.has(node.name)) {
      out.push({
        path: [...bodyPath, idx],
        node,
        name: node.name,
        label: node.labels?.[0] || '',
      });
    }
  });
  return out;
}
