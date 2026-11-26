export type NodePath = number[];

export interface HCLDocument {
  nodes: HCLNode[];
  trailing: string;
}

export interface HCLNode {
  kind: 'block' | 'attribute';
  name: string;
  labels?: string[];
  expression?: string;
  body?: HCLDocument;
  leading: string;
}

export interface AttributeRule {
  name: string;
  kind: 'string' | 'number' | 'bool' | 'list' | 'expression';
  required?: boolean;
}

export interface BlockRule {
  name: string;
  type: string;
  max: number;
  labels: number;
}

export interface BodyRule {
  attributes: AttributeRule[];
  blocks: BlockRule[];
  labels: number;
  map_kind?: 'string' | 'expression';
}

export interface BuilderSchema {
  version: string;
  types: Record<string, BodyRule>;
}

export interface BuilderDiagnostic {
  path: number[] | null;
  severity: string;
  message: string;
}

export interface BuilderResult {
  hcl: string;
  valid: boolean;
  diagnostics: BuilderDiagnostic[];
}

const emptyRule: BodyRule = { attributes: [], blocks: [], labels: 0, map_kind: 'expression' };

// nodeAt resolves an outline path without reading or evaluating an expression.
export function nodeAt(doc: HCLDocument, path: NodePath): HCLNode | undefined {
  let body = doc;
  let node: HCLNode | undefined;
  for (const index of path) {
    node = body.nodes[index];
    if (!node) return undefined;
    body = node.body || { nodes: [], trailing: '' };
  }
  return node;
}

// bodyAt resolves a block's children; the empty path denotes the document root.
export function bodyAt(doc: HCLDocument, path: NodePath): HCLDocument {
  const body = path.length ? nodeAt(doc, path)?.body : doc;
  if (!body) throw new Error('当前元素没有可添加的子层级');
  return body;
}

// contextAt follows Nomad block rules and selects the config schema of the task driver.
export function contextAt(doc: HCLDocument, path: NodePath, schema: BuilderSchema): string {
  let context = 'Document';
  let body = doc;
  for (const index of path) {
    const node = body.nodes[index];
    if (!node || node.kind !== 'block') return '';
    context = schema.types[context]?.blocks.find((rule) => rule.name === node.name)?.type || '';
    if (context === 'DriverConfig') {
      const expression = body.nodes.find((item) => item.kind === 'attribute' && item.name === 'driver')?.expression || '';
      try {
        const driver = JSON.parse(expression);
        if (typeof driver === 'string' && schema.types[`driver.${driver}`]) context = `driver.${driver}`;
      } catch {
        // Computed drivers retain an unrestricted config body until Nomad resolves them.
      }
    }
    body = node.body || { nodes: [], trailing: '' };
  }
  return context;
}

// ruleAt supplies the applicable field palette, including opaque extension bodies.
export function ruleAt(doc: HCLDocument, path: NodePath, schema: BuilderSchema): BodyRule {
  return schema.types[contextAt(doc, path, schema)] || emptyRule;
}

// editDocument isolates each mutation so undo and pending renders keep immutable snapshots.
export function editDocument(doc: HCLDocument, change: (draft: HCLDocument) => void): HCLDocument {
  const draft = structuredClone(doc);
  change(draft);
  return draft;
}

// canInsert enforces singleton attributes, allowed parent levels and unique labeled siblings.
export function canInsert(doc: HCLDocument, parent: NodePath, node: HCLNode, schema: BuilderSchema): boolean {
  const body = bodyAt(doc, parent);
  const rule = ruleAt(doc, parent, schema);
  if (node.kind === 'attribute') {
    return !body.nodes.some((item) => item.kind === 'attribute' && item.name === node.name)
      && !body.nodes.some((item) => item.kind === 'block' && item.name === node.name)
      && Boolean(rule.map_kind || rule.attributes.some((item) => item.name === node.name));
  }
  const block = rule.blocks.find((item) => item.name === node.name);
  if (!block) return false;
  const siblings = body.nodes.filter((item) => item.kind === 'block' && item.name === node.name);
  return !body.nodes.some((item) => item.kind === 'attribute' && item.name === node.name)
    && (!block.max || siblings.length < block.max)
    && (!block.labels || !siblings.some((item) => JSON.stringify(item.labels) === JSON.stringify(node.labels)));
}

// uniqueLabel creates a deterministic name within the immediate HCL parent.
export function uniqueLabel(body: HCLDocument, name: string, base = name): string {
  const names = new Set(body.nodes.filter((node) => node.kind === 'block' && node.name === name).map((node) => node.labels?.[0]));
  if (!names.has(base)) return base;
  let suffix = 2;
  while (names.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

// defaultExpression creates a valid draft value without turning expressions into strings.
export function defaultExpression(field: AttributeRule): string {
  if (field.name === 'driver') return '"docker"';
  if (field.name === 'hook') return '"prestart"';
  if (field.name === 'datacenters') return '["dc1"]';
  if (field.kind === 'number') return field.name === 'cpu' ? '100' : field.name === 'memory' ? '128' : '0';
  if (field.kind === 'bool') return 'false';
  if (field.kind === 'list') return '[]';
  return '""';
}

// createBlock seeds required attributes while leaving optional child blocks under user control.
export function createBlock(doc: HCLDocument, parent: NodePath, rule: BlockRule, schema: BuilderSchema): HCLNode {
  const label = uniqueLabel(bodyAt(doc, parent), rule.name);
  const type = rule.type === 'DriverConfig' ? (() => {
    const driver = bodyAt(doc, parent).nodes.find((node) => node.name === 'driver')?.expression || '';
    try { return schema.types[`driver.${JSON.parse(driver)}`] ? `driver.${JSON.parse(driver)}` : 'DriverConfig'; } catch { return 'DriverConfig'; }
  })() : rule.type;
  const required = schema.types[type]?.attributes.filter((field) => field.required) || [];
  const node: HCLNode = {
    kind: 'block', name: rule.name, labels: Array.from({ length: rule.labels }, (_, i) => i ? `label-${i + 1}` : label), leading: '\n',
    body: { nodes: required.map((field) => ({ kind: 'attribute', name: field.name, expression: defaultExpression(field), leading: '\n' })), trailing: '\n' },
  };
  return node;
}

// duplicateBlock copies a repeatable block, preserving comments and choosing a unique label.
export function duplicateBlock(doc: HCLDocument, path: NodePath, schema: BuilderSchema): { document: HCLDocument; path: NodePath } {
  const node = nodeAt(doc, path);
  const parent = path.slice(0, -1);
  if (!node || node.kind !== 'block') throw new Error('只能复制可重复的块');
  const rule = ruleAt(doc, parent, schema).blocks.find((item) => item.name === node.name);
  if (!rule || rule.max === 1) throw new Error('单个块不能复制');
  const copy = structuredClone(node);
  copy.leading = copy.leading || '\n';
  if (rule.labels) copy.labels = [uniqueLabel(bodyAt(doc, parent), node.name, `${node.labels?.[0] || node.name}-copy`), ...(node.labels || []).slice(1)];
  if (!canInsert(doc, parent, copy, schema)) throw new Error('当前层级不能再添加该元素');
  const index = path[path.length - 1] + 1;
  return { document: editDocument(doc, (draft) => bodyAt(draft, parent).nodes.splice(index, 0, copy)), path: [...parent, index] };
}

// moveNode validates cross-parent drops and never allows a block to contain itself.
export function moveNode(doc: HCLDocument, source: NodePath, target: NodePath, schema: BuilderSchema): { document: HCLDocument; path: NodePath } {
  if (!source.length || target.length >= source.length && source.every((part, i) => target[i] === part)) throw new Error('不能把元素移入自身或它的子元素');
  const node = nodeAt(doc, source);
  if (!node) throw new Error('待移动元素不存在');
  const same = JSON.stringify(source.slice(0, -1)) === JSON.stringify(target);
  if (!same && !canInsert(doc, target, node, schema)) throw new Error('该层级不允许此元素，或已经存在同名单个元素');
  const adjusted = [...target];
  const parent = source.slice(0, -1);
  if (target.length > parent.length && parent.every((part, i) => target[i] === part) && target[parent.length] > source[source.length - 1]) adjusted[parent.length]--;
  const document = editDocument(doc, (draft) => {
    bodyAt(draft, parent).nodes.splice(source[source.length - 1], 1);
    bodyAt(draft, adjusted).nodes.push(structuredClone(node));
  });
  return { document, path: [...adjusted, bodyAt(document, adjusted).nodes.length - 1] };
}

// nodeTitle uses HCL names directly so labels remain consistent with the preview.
export function nodeTitle(node: HCLNode): string {
  return node.kind === 'block' ? `${node.name}${(node.labels || []).map((label) => ` "${label}"`).join('')}` : node.name;
}

export interface TaskVaultInsertOptions {
  role: string;
  templateData: string;
  mode: 'env' | 'file';
  fileName?: string;
  envVarName?: string;
}

function upsertAttribute(body: HCLDocument, name: string, expression: string) {
  const existing = body.nodes.find((item) => item.kind === 'attribute' && item.name === name);
  if (existing) {
    existing.expression = expression;
    return;
  }
  body.nodes.push({ kind: 'attribute', name, expression, leading: '\n' });
}

/**
 * Inserts or updates a task's `vault` block, appends a `template` block, and
 * (in `file` mode) wires an env var pointing to `/secrets/<fileName>`.
 */
export function applyVaultToTask(
  doc: HCLDocument,
  taskPath: NodePath,
  opts: TaskVaultInsertOptions,
): HCLDocument {
  return editDocument(doc, (draft) => {
    const taskBody = bodyAt(draft, taskPath);
    let vaultBlock = taskBody.nodes.find((item) => item.kind === 'block' && item.name === 'vault');
    if (!vaultBlock) {
      vaultBlock = { kind: 'block', name: 'vault', labels: [], leading: '\n', body: { nodes: [], trailing: '\n' } };
      taskBody.nodes.push(vaultBlock);
    }
    vaultBlock.body = vaultBlock.body || { nodes: [], trailing: '\n' };
    upsertAttribute(vaultBlock.body, 'role', JSON.stringify(opts.role || 'default'));
    upsertAttribute(vaultBlock.body, 'env', 'false');

    const safeFile = (opts.fileName || 'app.secret').replace(/^\/+/, '');
    if (opts.mode === 'file') {
      const varName = (opts.envVarName || 'APP_SECRET_FILE').trim() || 'APP_SECRET_FILE';
      let envBlock = taskBody.nodes.find((item) => item.kind === 'block' && item.name === 'env');
      if (!envBlock && !taskBody.nodes.some((item) => item.kind === 'attribute' && item.name === 'env')) {
        envBlock = { kind: 'block', name: 'env', labels: [], leading: '\n', body: { nodes: [], trailing: '\n' } };
        taskBody.nodes.push(envBlock);
      }
      if (envBlock) {
        envBlock.body = envBlock.body || { nodes: [], trailing: '\n' };
        upsertAttribute(envBlock.body, varName, JSON.stringify(`/secrets/${safeFile}`));
      }
    }

    const heredocBody = opts.templateData.endsWith('\n') ? opts.templateData : `${opts.templateData}\n`;
    const tplNodes: HCLNode[] = [
      { kind: 'attribute', name: 'destination', expression: JSON.stringify(opts.mode === 'file' ? `secrets/${safeFile}` : 'secrets/app.env'), leading: '\n' },
      ...(opts.mode === 'file'
        ? [{ kind: 'attribute' as const, name: 'perms', expression: '"0600"', leading: '\n' }]
        : [{ kind: 'attribute' as const, name: 'env', expression: 'true', leading: '\n' }]),
      { kind: 'attribute', name: 'change_mode', expression: '"restart"', leading: '\n' },
      { kind: 'attribute', name: 'data', expression: `<<EOT\n${heredocBody}EOT`, leading: '\n' },
    ];
    taskBody.nodes.push({
      kind: 'block',
      name: 'template',
      labels: [],
      leading: '\n',
      body: { nodes: tplNodes, trailing: '\n' },
    });
  });
}
