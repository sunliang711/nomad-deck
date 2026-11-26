import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, GripVertical, KeyRound, Plus, Trash2 } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import {
  applyVaultToTask, bodyAt, canInsert, contextAt, createBlock, defaultExpression, duplicateBlock, editDocument,
  moveNode, nodeAt, nodeTitle, ruleAt,
  type AttributeRule, type BuilderDiagnostic, type BuilderResult, type BuilderSchema,
  type HCLDocument, type HCLNode, type NodePath,
} from '../lib/hclBuilder';
import {
  buildTemplateData, parseKVPath, type VaultIntegrationOption, type VaultRoleOption,
} from '../lib/vaultHelpers';
import { Badge, Button, ErrorAlert, Input, Select } from './UI';

interface BuilderOptions {
  namespaces: string[];
  node_pools: string[];
  datacenters: string[];
  drivers: string[];
  host_volumes: Record<string, string[]>;
}

export interface VisualJobBuilderHandle {
  flush: () => Promise<BuilderResult>;
}

interface Props {
  clusterId: string;
  source: string;
  readOnly: boolean;
  onSourceChange: (source: string) => void;
  onValidityChange: (valid: boolean) => void;
}

const labels: Record<string, string> = { job: 'Job 名称', group: 'Group 名称', task: 'Task 名称', variable: '变量名称', volume: 'Volume 名称', port: '端口标签', device: '设备名称', action: 'Action 名称', region: 'Region 名称' };
const enumValues: Record<string, string[]> = {
  'Job.type': ['service', 'batch', 'system', 'sysbatch'],
  'Service.provider': ['nomad', 'consul'],
  'ServiceCheck.type': ['http', 'tcp', 'script', 'grpc'],
  'NetworkResource.mode': ['host', 'bridge'],
  'TaskLifecycle.hook': ['prestart', 'poststart', 'poststop'],
  'RestartPolicy.mode': ['fail', 'delay'],
  'ReschedulePolicy.delay_function': ['constant', 'exponential', 'fibonacci'],
  'VolumeRequest.type': ['host', 'csi'],
  'Vault.change_mode': ['restart', 'signal', 'noop'],
  'Template.change_mode': ['restart', 'signal', 'noop', 'script'],
};

// literalValue recognizes only editable literals; expressions always keep their original tokens.
function literalValue(expression: string, kind: string): string | number | boolean | string[] | undefined {
  try {
    const value = JSON.parse(expression);
    if (kind === 'list' && Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
    if (kind === 'string' && typeof value === 'string' || kind === 'number' && typeof value === 'number' || kind === 'bool' && typeof value === 'boolean') return value;
  } catch {
    // Heredocs, traversals and function calls are edited as native HCL expressions.
  }
  return undefined;
}

// ValueEditor keeps literal controls separate from native HCL expressions.
function ValueEditor({ node, field, choices, disabled, onChange }: {
  node: HCLNode; field: AttributeRule; choices: string[]; disabled: boolean; onChange: (value: string) => void;
}) {
  const expression = node.expression || '';
  const literal = literalValue(expression, field.kind);
  const [native, setNative] = useState(field.kind === 'expression' || literal === undefined);
  const raw = native || literal === undefined;
  const listId = `hcl-values-${node.name}-${choices.join('-').replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="font-mono font-semibold" htmlFor={`value-${node.name}`}>{node.name}{field.required ? ' *' : ''}</label>
        {field.kind !== 'expression' && (
          <Button size="sm" type="button" disabled={disabled || raw && literal === undefined} onClick={() => setNative(!raw)}>
            {raw ? '切换为值输入' : '使用 HCL 表达式'}
          </Button>
        )}
      </div>
      {raw ? (
        <div className="space-y-1">
          <textarea id={`value-${node.name}`} aria-label={node.name} rows={node.name === 'data' ? 8 : 3} disabled={disabled}
            value={expression} onChange={(e) => onChange(e.target.value)} spellCheck={false}
            className="w-full rounded border border-slate-300 bg-white p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950" />
          <div className="text-[11px] text-slate-500">原生 HCL 表达式，例如 var.cpu、["http"] 或模板 heredoc。</div>
        </div>
      ) : field.kind === 'bool' ? (
        <select id={`value-${node.name}`} aria-label={node.name} disabled={disabled} value={expression} onChange={(e) => onChange(e.target.value)} className="w-full rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950">
          <option value="true">true</option><option value="false">false</option>
        </select>
      ) : field.kind === 'list' ? (
        <div className="space-y-1.5">
          {(literal as string[]).map((value, i) => (
            <div key={i} className="flex items-center gap-1">
              <input aria-label={`${node.name} 第 ${i + 1} 项`} list={choices.length ? listId : undefined} disabled={disabled} value={value}
                onChange={(e) => onChange(JSON.stringify((literal as string[]).map((item, index) => index === i ? e.target.value : item)))}
                className="min-w-0 flex-1 rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950" />
              <Button size="sm" aria-label={`上移 ${node.name} 第 ${i + 1} 项`} disabled={disabled || i === 0} onClick={() => { const next = [...literal as string[]]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; onChange(JSON.stringify(next)); }}><ArrowUp className="h-3 w-3" /></Button>
              <Button size="sm" aria-label={`删除 ${node.name} 第 ${i + 1} 项`} disabled={disabled} onClick={() => onChange(JSON.stringify((literal as string[]).filter((_, index) => index !== i)))}><Trash2 className="h-3 w-3" /></Button>
            </div>
          ))}
          <Button size="sm" disabled={disabled} onClick={() => onChange(JSON.stringify([...literal as string[], '']))}><Plus className="h-3 w-3" />添加 {node.name} 项</Button>
        </div>
      ) : node.name === 'data' ? (
        <textarea id={`value-${node.name}`} aria-label={node.name} rows={8} disabled={disabled} value={String(literal)}
          onChange={(e) => onChange(JSON.stringify(e.target.value))} spellCheck={false}
          className="w-full rounded border border-slate-300 bg-white p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950" />
      ) : (
        <input id={`value-${node.name}`} aria-label={node.name} type={field.kind === 'number' ? 'number' : 'text'}
          list={choices.length ? listId : undefined} disabled={disabled} value={String(literal)}
          onChange={(e) => onChange(field.kind === 'number' ? e.target.value : JSON.stringify(e.target.value))}
          className="w-full rounded border border-slate-300 bg-white p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950" />
      )}
      {choices.length > 0 && <datalist id={listId}>{choices.map((value) => <option key={value} value={value} />)}</datalist>}
    </div>
  );
}

// VisualJobBuilder edits a source-preserving HCL tree using Nomad block cardinalities.
export const VisualJobBuilder = forwardRef<VisualJobBuilderHandle, Props>(function VisualJobBuilder({ clusterId, source, readOnly, onSourceChange, onValidityChange }, ref) {
  const [document, setDocument] = useState<HCLDocument | null>(null);
  const [schema, setSchema] = useState<BuilderSchema | null>(null);
  const [selected, setSelected] = useState<NodePath>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [diagnostics, setDiagnostics] = useState<BuilderDiagnostic[]>([]);
  const [error, setError] = useState('');
  const [rendering, setRendering] = useState(false);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState('');
  const [customName, setCustomName] = useState('');
  const [customKind, setCustomKind] = useState<'attribute' | 'block'>('attribute');
  const [undo, setUndo] = useState<HCLDocument[]>([]);
  const [redo, setRedo] = useState<HCLDocument[]>([]);
  const [options, setOptions] = useState<BuilderOptions>({ namespaces: [], node_pools: [], datacenters: [], drivers: [], host_volumes: {} });
  const [vaultRoles, setVaultRoles] = useState<VaultRoleOption[]>([]);
  const [vaultIntegrations, setVaultIntegrations] = useState<VaultIntegrationOption[]>([]);
  const [vaultHelper, setVaultHelper] = useState({
    role: '',
    secretPath: 'secret/apps/demo',
    mode: 'env' as 'env' | 'file',
    keys: '',
    fileName: 'app.secret',
    envVarName: 'APP_SECRET_FILE',
  });
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const docRef = useRef<HCLDocument | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const callbacks = useRef({ onSourceChange, onValidityChange });
  callbacks.current = { onSourceChange, onValidityChange };

  // renderLatest prevents an older response from replacing a newer draft or its validation state.
  const renderLatest = async (doc: HCLDocument): Promise<BuilderResult> => {
    const request = ++requestRef.current;
    setRendering(true);
    callbacks.current.onValidityChange(false);
    try {
      const result = await apiPost<BuilderResult>(`/api/v1/nomad/${clusterId}/job-ops/hcl-tree-render`, doc);
      if (mountedRef.current && request === requestRef.current) {
        callbacks.current.onSourceChange(result.hcl);
        callbacks.current.onValidityChange(result.valid);
        setDiagnostics(result.diagnostics || []);
        setError('');
      }
      return result;
    } catch (ex: any) {
      if (mountedRef.current && request === requestRef.current) setError(ex.message || '生成 HCL 失败');
      throw ex;
    } finally {
      if (mountedRef.current && request === requestRef.current) setRendering(false);
    }
  };

  useImperativeHandle(ref, () => ({
    flush: async () => {
      // Edits made during the request must be rendered before a mode switch or submission.
      while (mountedRef.current && docRef.current) {
        const current = docRef.current;
        const result = await renderLatest(current);
        if (mountedRef.current && current === docRef.current) return result;
      }
      return { hcl: sourceRef.current, valid: false, diagnostics };
    },
  }));

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    docRef.current = null;
    setDocument(null);
    setSchema(null);
    setUndo([]);
    setRedo([]);
    callbacks.current.onValidityChange(false);
    void apiPost<{ document: HCLDocument; schema: BuilderSchema }>(`/api/v1/nomad/${clusterId}/job-ops/hcl-tree`, { hcl: sourceRef.current })
      .then((res) => {
        if (!active) return;
        docRef.current = res.document;
        setRendering(true);
        setDocument(res.document);
        setSchema(res.schema);
        const job = res.document.nodes.findIndex((node) => node.kind === 'block' && node.name === 'job');
        setSelected(job >= 0 ? [job] : []);
      })
      .catch((ex) => { if (active) setError(ex.message || 'HCL 无法载入，请返回原生编辑器修正语法'); });
    void apiGet<{
      options: BuilderOptions;
      vault_roles?: VaultRoleOption[];
      vault_integrations?: VaultIntegrationOption[];
    }>(`/api/v1/nomad/${clusterId}/builder-options`)
      .then((res) => {
        if (!active) return;
        setOptions(res.options);
        const roles = res.vault_roles || [];
        setVaultRoles(roles);
        setVaultIntegrations(res.vault_integrations || []);
        if (roles.length > 0) {
          const first = roles[0];
          const firstPath = (first.secret_paths || [])[0] || 'secret/apps/demo';
          setVaultHelper((prev) => (prev.role ? prev : { ...prev, role: first.role, secretPath: firstPath }));
        }
      })
      .catch(() => {});
    return () => { active = false; mountedRef.current = false; requestRef.current++; };
  }, [clusterId]);

  useEffect(() => {
    if (!document) return;
    const timer = window.setTimeout(() => { void renderLatest(document).catch(() => {}); }, 350);
    return () => window.clearTimeout(timer);
  }, [document, clusterId]);

  useEffect(() => { setAdding(''); setFilter(''); setCustomName(''); setCustomKind('attribute'); }, [JSON.stringify(selected)]);

  // commit keeps a bounded undo history and invalidates any previously reviewed Plan immediately.
  const commit = (next: HCLDocument, path = selected) => {
    if (readOnly || !docRef.current) return;
    requestRef.current++;
    callbacks.current.onValidityChange(false);
    setRendering(true);
    setUndo((history) => [...history.slice(-29), docRef.current!]);
    setRedo([]);
    docRef.current = next;
    setDocument(next);
    setSelected(path);
  };

  // navigateHistory preserves complete raw expressions and comments on undo and redo.
  const navigateHistory = (back: boolean) => {
    const history = back ? undo : redo;
    if (!history.length || !docRef.current || readOnly) return;
    const next = history[history.length - 1];
    if (back) { setUndo(history.slice(0, -1)); setRedo((items) => [...items, docRef.current!]); }
    else { setRedo(history.slice(0, -1)); setUndo((items) => [...items, docRef.current!]); }
    requestRef.current++;
    callbacks.current.onValidityChange(false);
    setRendering(true);
    docRef.current = next;
    setDocument(next);
    setSelected([]);
  };

  if (!document || !schema) return <div className="space-y-2"><ErrorAlert message={error} /><p className="text-slate-500">{error ? '原始内容保持不变，可返回 HCL 编辑器继续编辑。' : '正在读取 HCL 结构…'}</p></div>;

  const node = nodeAt(document, selected);
  const isBody = !selected.length || node?.kind === 'block';
  const parent = selected.slice(0, -1);
  const bodyPath = isBody ? selected : parent;
  const body = bodyAt(document, bodyPath);
  const rule = ruleAt(document, bodyPath, schema);
  const context = contextAt(document, bodyPath, schema);
  const siblingRule = selected.length && node ? ruleAt(document, parent, schema).blocks.find((item) => item.name === node.name) : undefined;

  // changeExpression edits one attribute without reconstructing its enclosing task.
  const changeExpression = (path: NodePath, expression: string) => commit(editDocument(document, (draft) => { nodeAt(draft, path)!.expression = expression; }));

  // removeNode deletes only the explicitly selected element and selects its parent.
  const removeNode = (path: NodePath) => commit(editDocument(document, (draft) => { bodyAt(draft, path.slice(0, -1)).nodes.splice(path[path.length - 1], 1); }), path.slice(0, -1));

  // reorder moves a sibling with its associated comments and selects its new path.
  const reorder = (offset: number) => {
    const index = selected[selected.length - 1];
    commit(editDocument(document, (draft) => {
      const siblings = bodyAt(draft, parent).nodes;
      [siblings[index], siblings[index + offset]] = [siblings[index + offset], siblings[index]];
    }), [...parent, index + offset]);
  };

  // fieldChoices combines grammar values with live cluster names and group-local references.
  const fieldChoices = (name: string): string[] => {
    if (context === 'Vault' && name === 'role') return vaultRoles.map((r) => r.role);
    if (name === 'driver') return Array.from(new Set([...options.drivers, 'docker', 'exec', 'raw_exec', 'java', 'qemu']));
    if (name === 'namespace') return options.namespaces;
    if (name === 'node_pool') return options.node_pools;
    if (name === 'datacenters') return options.datacenters;
    if (context === 'VolumeRequest' && name === 'source') return Object.keys(options.host_volumes);
    if (['port', 'ports', 'volume'].includes(name)) {
      for (let length = bodyPath.length; length > 0; length--) {
        const path = bodyPath.slice(0, length);
        if (contextAt(document, path, schema) !== 'TaskGroup') continue;
        const group = bodyAt(document, path);
        if (name === 'volume') return group.nodes.filter((item) => item.kind === 'block' && item.name === 'volume').map((item) => item.labels?.[0] || '');
        return group.nodes.filter((item) => item.kind === 'block' && item.name === 'network').flatMap((item) => item.body?.nodes.filter((port) => port.kind === 'block' && port.name === 'port').map((port) => port.labels?.[0] || '') || []);
      }
    }
    return enumValues[`${context}.${name}`] || [];
  };

  // addElement uses schema multiplicity to prevent duplicate singleton blocks and attributes.
  const addElement = () => {
    const [kind, name] = adding.split(':');
    let next: HCLNode;
    if (kind === 'block') {
      const block = rule.blocks.find((item) => item.name === name);
      if (!block) return;
      next = createBlock(document, bodyPath, block, schema);
    } else {
      const field = rule.attributes.find((item) => item.name === name);
      if (!field) return;
      const expression = context === 'Variable' && name === 'type' ? 'string' : context === 'Job' && name === 'type' ? '"service"' : defaultExpression(field);
      next = { kind: 'attribute', name, expression, leading: '\n' };
    }
    if (!canInsert(document, bodyPath, next, schema)) return;
    commit(editDocument(document, (draft) => { bodyAt(draft, bodyPath).nodes.push(next); }), next.kind === 'attribute' ? bodyPath : [...bodyPath, body.nodes.length]);
  };

  // addCustom preserves forward-compatible and driver-specific HCL under explicit user control.
  const addCustom = () => {
    const name = customName.trim();
    if (!name) return;
    const kind = rule.map_kind ? 'attribute' : customKind;
    if (kind === 'attribute' && body.nodes.some((item) => item.kind === 'attribute' && item.name === name)) { setError('当前属性已经存在'); return; }
    const next: HCLNode = kind === 'attribute'
      ? { kind: 'attribute', name, expression: '""', leading: '\n' }
      : { kind: 'block', name, labels: [], body: { nodes: [], trailing: '\n' }, leading: '\n' };
    if ((rule.attributes.some((field) => field.name === name) || rule.blocks.some((block) => block.name === name)) && !canInsert(document, bodyPath, next, schema)) {
      setError('当前层级不能再添加该元素，请使用可添加元素列表');
      return;
    }
    commit(editDocument(document, (draft) => bodyAt(draft, bodyPath).nodes.push(next)), kind === 'attribute' ? bodyPath : [...bodyPath, body.nodes.length]);
    setCustomName('');
  };

  // outline exposes legal drag targets; the immutable move helper rejects invalid nesting.
  const outline = (tree: HCLDocument, path: NodePath): React.ReactNode => tree.nodes.map((item, index) => {
    const here = [...path, index];
    const key = here.join('.');
    const folded = collapsed.has(key);
    const picked = JSON.stringify(here) === JSON.stringify(selected);
    return (
      <div key={key} role="treeitem" aria-label={nodeTitle(item)} aria-selected={picked} aria-expanded={item.body ? !folded : undefined}>
        <div draggable={!readOnly} onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('application/x-nomad-hcl-node', JSON.stringify(here)); }}
          onDragOver={(e) => { if (item.body && !readOnly) e.preventDefault(); }}
          onDrop={(e) => {
            if (!item.body || readOnly) return;
            e.preventDefault(); e.stopPropagation();
            try {
              const source: unknown = JSON.parse(e.dataTransfer.getData('application/x-nomad-hcl-node'));
              if (!Array.isArray(source) || source.length > 32 || !source.every((part) => Number.isInteger(part) && part >= 0)) throw new Error('无效的拖动元素');
              const next = moveNode(document, source, here, schema);
              commit(next.document, next.path);
            } catch (ex: any) { setError(ex.message || '无法移动到此层级'); }
          }} className={`flex items-center gap-1 rounded py-1 pr-1 ${picked ? 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-100' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
          {item.body ? <button aria-label={`${folded ? '展开' : '折叠'} ${nodeTitle(item)}`} onClick={() => setCollapsed((prev) => { const next = new Set(prev); if (folded) next.delete(key); else next.add(key); return next; })} className="shrink-0 p-0.5">{folded ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}</button> : <span className="w-4 text-center text-[10px] text-slate-400">＝</span>}
          <button aria-label={`编辑 ${nodeTitle(item)}`} onClick={() => setSelected(here)} className="min-w-0 flex-1 truncate text-left font-mono text-xs">{nodeTitle(item)}</button>
          {!readOnly && <GripVertical className="h-3 w-3 shrink-0 text-slate-400" />}
        </div>
        {item.body && !folded && <div role="group" className="ml-3 border-l border-slate-200 pl-2 dark:border-slate-700">{outline(item.body, here)}</div>}
      </div>
    );
  });

  const attributes = body.nodes.map((item, index) => ({ item, path: [...bodyPath, index] })).filter(({ item }) => item.kind === 'attribute');
  const children = body.nodes.map((item, index) => ({ item, path: [...bodyPath, index] })).filter(({ item }) => item.kind === 'block');
  const visibleAttributes = node?.kind === 'attribute' ? attributes.filter(({ path }) => JSON.stringify(path) === JSON.stringify(selected)) : attributes;

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950/50">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><div className="font-semibold">HCL 积木编排</div><div className="mt-1 text-[11px] text-slate-500">Job → Group → Task；单个元素不可重复，重复块可以复制、排序或拖入合法层级。</div></div>
        <div className="flex items-center gap-1">
          <span className="mr-2 text-[11px] text-slate-500" aria-live="polite">{rendering ? '正在生成预览…' : diagnostics.some((issue) => issue.severity === 'error') ? '请完成配置' : '结构校验通过'}</span>
          <Button size="sm" disabled={readOnly || !undo.length} onClick={() => navigateHistory(true)}>撤销</Button>
          <Button size="sm" disabled={readOnly || !redo.length} onClick={() => navigateHistory(false)}>重做</Button>
        </div>
      </div>
      <ErrorAlert message={error} onClose={() => setError('')} />
      {diagnostics.length > 0 && <div role="status" className="max-h-36 space-y-1 overflow-auto rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{diagnostics.map((issue, i) => <button key={i} className="block text-left" onClick={() => { let path = issue.path || []; while (path.length && !nodeAt(document, path)) path = path.slice(0, -1); setSelected(path); }}>{issue.message}</button>)}</div>}
      <div className="grid gap-3 lg:grid-cols-[minmax(190px,0.7fr)_minmax(0,1.5fr)]">
        <div className="max-h-[650px] overflow-auto rounded border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900">
          <button onClick={() => setSelected([])} className={`mb-2 w-full rounded px-2 py-1.5 text-left font-semibold ${selected.length ? '' : 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-100'}`}>HCL 文档</button>
          <div role="tree" aria-label="Job 结构树">{outline(document, [])}</div>
        </div>
        <div className="max-h-[650px] space-y-4 overflow-auto rounded border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2 dark:border-slate-800">
            <div className="min-w-0"><div className="flex flex-wrap gap-1 text-[11px] text-slate-500"><button onClick={() => setSelected([])}>文档</button>{selected.map((_, i) => <button key={i} onClick={() => setSelected(selected.slice(0, i + 1))}>› {nodeTitle(nodeAt(document, selected.slice(0, i + 1))!)}</button>)}</div><h3 className="mt-1 break-words font-mono font-semibold">{node ? nodeTitle(node) : 'HCL 文档'}</h3></div>
            {node && <div className="flex gap-1">
              <Button size="sm" aria-label="上移当前元素" disabled={readOnly || selected[selected.length - 1] === 0} onClick={() => reorder(-1)}><ArrowUp className="h-3 w-3" /></Button>
              <Button size="sm" aria-label="下移当前元素" disabled={readOnly || selected[selected.length - 1] === bodyAt(document, parent).nodes.length - 1} onClick={() => reorder(1)}><ArrowDown className="h-3 w-3" /></Button>
              <Button size="sm" aria-label="复制当前块" disabled={readOnly || node.kind !== 'block' || !siblingRule || siblingRule.max === 1} onClick={() => { try { const next = duplicateBlock(document, selected, schema); commit(next.document, next.path); } catch (ex: any) { setError(ex.message); } }}><Copy className="h-3 w-3" /></Button>
              <Button size="sm" aria-label="删除当前元素" variant="danger" disabled={readOnly} onClick={() => removeNode(selected)}><Trash2 className="h-3 w-3" /></Button>
            </div>}
          </div>
          {node?.kind === 'block' && (node.labels || []).map((label, i) => <Input key={i} label={labels[node.name] || `名称标签 ${i + 1}`} disabled={readOnly} value={label} onChange={(e) => commit(editDocument(document, (draft) => { nodeAt(draft, selected)!.labels![i] = e.target.value; }))} />)}
          {context === 'Vault' && isBody && (
            <div className="rounded-lg border border-indigo-200/80 bg-indigo-50/50 p-2.5 text-xs space-y-2 dark:border-indigo-500/30 dark:bg-indigo-950/20">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-indigo-950 dark:text-indigo-100">当前集群可用的 Vault Roles</span>
                <Link to="/integrations" className="text-[11px] text-indigo-600 hover:underline dark:text-indigo-300">去集群联动管理</Link>
              </div>
              {vaultRoles.length === 0 ? (
                <p className="text-[11px] text-slate-600 dark:text-slate-300">
                  {vaultIntegrations.length === 0 ? '尚未为该 Nomad 集群创建 Nomad-Vault 联动。' : '当前联动尚未配置工作负载 Role。'}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {vaultRoles.map((vr) => (
                    <button
                      key={`${vr.integration}:${vr.role}`}
                      type="button"
                      disabled={readOnly}
                      onClick={() => {
                        commit(editDocument(document, (draft) => {
                          const vb = bodyAt(draft, bodyPath);
                          const existing = vb.nodes.find((item) => item.kind === 'attribute' && item.name === 'role');
                          if (existing) existing.expression = JSON.stringify(vr.role);
                          else vb.nodes.unshift({ kind: 'attribute', name: 'role', expression: JSON.stringify(vr.role), leading: '\n' });
                        }));
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] hover:border-indigo-400 dark:border-slate-700 dark:bg-slate-900"
                    >
                      <span className="font-mono font-semibold">{vr.role}</span>
                      <Badge tone={vr.status === 'applied' ? 'green' : 'amber'}>{vr.status === 'applied' ? '已应用' : '草稿'}</Badge>
                      <span className="text-slate-400">ns:{vr.namespace || 'default'}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {visibleAttributes.map(({ item, path }) => {
            const field = rule.attributes.find((entry) => entry.name === item.name) || { name: item.name, kind: rule.map_kind || 'expression' } as AttributeRule;
            return <div key={path.join('.')} className="relative space-y-2 rounded border border-slate-200 p-3 pr-12 dark:border-slate-700">
              {rule.map_kind && <Input label="键名" disabled={readOnly} value={item.name} onChange={(e) => commit(editDocument(document, (draft) => { nodeAt(draft, path)!.name = e.target.value; }))} />}
              <ValueEditor node={item} field={field} choices={fieldChoices(item.name)} disabled={readOnly} onChange={(value) => changeExpression(path, value)} />
              <button aria-label={`删除属性 ${item.name}`} disabled={readOnly} onClick={() => removeNode(path)} className="absolute right-2 top-3 rounded p-1 text-slate-400 hover:text-rose-500 disabled:opacity-30"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>;
          })}
          {isBody && <>
            {context === 'Task' && !readOnly && (
              <details className="rounded-xl border border-indigo-200/80 bg-indigo-50/40 p-3 text-xs dark:border-indigo-500/30 dark:bg-indigo-950/20">
                <summary className="cursor-pointer font-semibold text-indigo-950 dark:text-indigo-100 inline-flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-300" />
                  <span>快捷接入 Vault 密钥（自动生成 vault + template 积木）</span>
                </summary>
                <div className="mt-3 space-y-2.5">
                  {vaultRoles.length === 0 && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">
                      未检测到可用联动 Role，可先前往 <Link to="/integrations" className="underline">集群联动</Link> 配置并应用，或手动填写 Role 名称。
                    </p>
                  )}
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Input
                        label="Vault Role 名称"
                        list="vb-vault-roles"
                        value={vaultHelper.role}
                        onChange={(e) => {
                          const val = e.target.value;
                          const matched = vaultRoles.find((r) => r.role === val);
                          setVaultHelper((prev) => ({
                            ...prev,
                            role: val,
                            secretPath: matched?.secret_paths?.[0] || prev.secretPath,
                          }));
                        }}
                        placeholder="例如 postgres"
                      />
                      <datalist id="vb-vault-roles">
                        {vaultRoles.map((r) => <option key={r.role} value={r.role} />)}
                      </datalist>
                    </div>
                    <Input
                      label="Secret 路径（支持自动补全 data/）"
                      value={vaultHelper.secretPath}
                      onChange={(e) => setVaultHelper((prev) => ({ ...prev, secretPath: e.target.value }))}
                      placeholder="例如 secret/apps/postgres"
                    />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Select
                      label="注入方式"
                      value={vaultHelper.mode}
                      onChange={(e) => setVaultHelper((prev) => ({ ...prev, mode: e.target.value as 'env' | 'file' }))}
                    >
                      <option value="env">注入环境变量（env = true）</option>
                      <option value="file">挂载密码文件（/secrets/...）</option>
                    </Select>
                    <Input
                      label={vaultHelper.mode === 'file' ? '提取的字段名（留空则输出 JSON）' : '提取的字段名（逗号分隔，留空则全部注入）'}
                      value={vaultHelper.keys}
                      onChange={(e) => setVaultHelper((prev) => ({ ...prev, keys: e.target.value }))}
                      placeholder={vaultHelper.mode === 'file' ? '例如 password' : '例如 username, password'}
                    />
                  </div>
                  {vaultHelper.mode === 'file' && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input
                        label="容器内文件名（位于 /secrets/ 下）"
                        value={vaultHelper.fileName}
                        onChange={(e) => setVaultHelper((prev) => ({ ...prev, fileName: e.target.value }))}
                      />
                      <Input
                        label="同时写入的环境变量名"
                        value={vaultHelper.envVarName}
                        onChange={(e) => setVaultHelper((prev) => ({ ...prev, envVarName: e.target.value }))}
                      />
                    </div>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <span className="text-[11px] text-slate-500">
                      模板将读取：<code className="font-mono">{parseKVPath(vaultHelper.secretPath).templatePath || 'secret/data/apps/demo'}</code>
                    </span>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        const parsed = parseKVPath(vaultHelper.secretPath);
                        const keys = vaultHelper.keys.split(',').map((s) => s.trim()).filter(Boolean);
                        const templateData = buildTemplateData(parsed.templatePath, keys, vaultHelper.mode);
                        commit(applyVaultToTask(document, bodyPath, {
                          role: vaultHelper.role.trim() || 'default',
                          templateData,
                          mode: vaultHelper.mode,
                          fileName: vaultHelper.fileName,
                          envVarName: vaultHelper.envVarName,
                        }));
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>插入 vault + template 积木</span>
                    </Button>
                  </div>
                </div>
              </details>
            )}
            {children.length > 0 && <div className="space-y-1.5"><div className="font-semibold">子块</div>{children.map(({ item, path }) => <button key={path.join('.')} onClick={() => setSelected(path)} className="flex w-full items-center justify-between rounded border border-slate-200 p-2 text-left font-mono hover:border-indigo-400 dark:border-slate-700"><span>{nodeTitle(item)}</span><ChevronRight className="h-3.5 w-3.5" /></button>)}</div>}
            {!readOnly && <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
              <div className="font-semibold">添加子元素</div>
              {(rule.attributes.length > 0 || rule.blocks.length > 0) && <><Input aria-label="搜索可添加元素" placeholder="搜索属性或块，例如 resources" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1"><Select label="可添加元素" value={adding} onChange={(e) => setAdding(e.target.value)}>
                  <option value="">选择元素</option>
                  <optgroup label="属性（每个名称仅一份）">{rule.attributes.filter((item) => item.name.includes(filter)).map((field) => { const exists = body.nodes.some((item) => item.kind === 'attribute' && item.name === field.name); return <option key={field.name} value={`attribute:${field.name}`} disabled={exists}>{field.name}{field.required ? ' *' : ''}{exists ? ' · 已添加' : ` · ${field.kind}`}</option>; })}</optgroup>
                  <optgroup label="子块">{rule.blocks.filter((item) => item.name.includes(filter)).map((block) => { const count = body.nodes.filter((item) => item.kind === 'block' && item.name === block.name).length; const full = body.nodes.some((item) => item.kind === 'attribute' && item.name === block.name) || block.max > 0 && count >= block.max; return <option key={block.name} value={`block:${block.name}`} disabled={full}>{block.name} · {block.max === 1 ? '单个' : '可重复'}{full ? ' · 已添加' : ''}</option>; })}</optgroup>
                </Select></div>
                <Button size="sm" variant="primary" disabled={!adding || Boolean(adding.startsWith('attribute:') && body.nodes.some((item) => item.kind === 'attribute' && `attribute:${item.name}` === adding))} onClick={addElement}><Plus className="h-3.5 w-3.5" />添加元素</Button>
              </div></>}
              {rule.map_kind ? <div className="space-y-2 rounded bg-slate-50 p-2 dark:bg-slate-950">
                <Input label={rule.map_kind === 'string' ? '新键名' : '新字段名称'} value={customName} onChange={(e) => setCustomName(e.target.value)} />
                <Button size="sm" disabled={!customName.trim()} onClick={addCustom}><Plus className="h-3 w-3" />{rule.map_kind === 'string' ? '添加键值' : '添加字段'}</Button>
              </div> : <details className="rounded bg-slate-50 p-2 dark:bg-slate-950">
                <summary className="cursor-pointer text-slate-500">原生扩展</summary>
                <div className="mt-2 space-y-2"><p className="text-[11px] text-slate-500">用于键值集合、插件字段或新版本配置；最终仍需通过 Nomad Validate 和 Plan。</p>
                  <Input label="元素名称" value={customName} onChange={(e) => setCustomName(e.target.value)} />
                  {!rule.map_kind && <Select label="原生元素类型" value={customKind} onChange={(e) => setCustomKind(e.target.value as 'attribute' | 'block')}><option value="attribute">属性</option><option value="block">子块</option></Select>}
                  <Button size="sm" disabled={!customName.trim()} onClick={addCustom}>添加原生元素</Button>
                </div>
              </details>}
            </div>}
          </>}
        </div>
      </div>
    </div>
  );
});
