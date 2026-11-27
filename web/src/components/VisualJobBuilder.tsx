import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Container,
  Copy,
  Cpu,
  Database,
  Eye,
  EyeOff,
  FileCode2,
  GripVertical,
  HardDrive,
  KeyRound,
  Layers,
  LayoutGrid,
  Minus,
  Network,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  Shield,
  SlidersHorizontal,
  SquareTerminal,
  Trash2,
  TreePine,
  Undo2,
  Redo2,
} from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { useI18n } from '../lib/i18n';
import {
  applyVaultToTask,
  bodyAt,
  canInsert,
  contextAt,
  createBlock,
  defaultExpression,
  duplicateBlock,
  editDocument,
  moveNode,
  nodeAt,
  nodeTitle,
  ruleAt,
  type AttributeRule,
  type BuilderDiagnostic,
  type BuilderResult,
  type BuilderSchema,
  type HCLDocument,
  type HCLNode,
  type NodePath,
} from '../lib/hclBuilder';
import {
  addGroupPort,
  addGroupService,
  addGroupVolume,
  addJobConstraint,
  addReadyGroup,
  addReadyTask,
  addServiceCheck,
  addTaskEnvRow,
  addTaskTemplateBlock,
  addTaskVolumeMount,
  declareAndBindTaskPort,
  declareAndMountTaskVolume,
  findChildBlock,
  findJobPath,
  getAttrExpr,
  getAttrNode,
  listChildBlocks,
  listGroupPorts,
  listTaskEnvRows,
  listUnhandledBlocks,
  parseLiteralBool,
  parseLiteralNumber,
  parseLiteralString,
  parseLiteralStringList,
  removeNodeAtPath,
  setAttrExpr,
  setBlockLabel,
  setGroupEphemeralDisk,
  setGroupRestart,
  setJobPeriodic,
  setJobUpdateStrategy,
  setTaskConfigAttr,
  setTaskDriver,
  setTaskResources,
  setTaskVault,
  toggleTaskDockerPort,
  unwrapHeredocOrString,
  updateGroupPort,
  updateTaskEnvRow,
  updateTaskTemplateBlock,
} from '../lib/hclVisualModel';
import {
  buildTemplateData,
  parseKVPath,
  type VaultIntegrationOption,
  type VaultRoleOption,
} from '../lib/vaultHelpers';
import { useToast } from './Toast';
import { Badge, Button, ErrorAlert, Input, Modal, SectionTabs, Select, Switch } from './UI';
import { CodeEditor } from './CodeEditor';
import { HostVolumeCreateModal } from './HostVolumeCreateModal';
import { BuilderQuickAddDialog, type QuickAddForm, type QuickAddValue } from './BuilderQuickAddDialog';

interface BuilderOptions {
  namespaces: string[];
  node_pools: string[];
  datacenters: string[];
  drivers: string[];
  host_volumes: Record<string, string[]>;
  host_networks: Record<string, string[]>;
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

const LABELS: Record<string, string> = {
  job: 'Job 名称',
  group: 'Group 名称',
  task: 'Task 名称',
  variable: '变量名称',
  volume: 'Volume 名称',
  port: '端口标签',
  device: '设备名称',
  action: 'Action 名称',
  region: 'Region 名称',
};

const LABELS_EN: Record<string, string> = {
  job: 'Job Name',
  group: 'Group Name',
  task: 'Task Name',
  variable: 'Variable Name',
  volume: 'Volume Name',
  port: 'Port Label',
  device: 'Device Name',
  action: 'Action Name',
  region: 'Region Name',
};

const ENUM_VALUES: Record<string, string[]> = {
  'Job.type': ['service', 'batch', 'system', 'sysbatch'],
  'Service.provider': ['nomad', 'consul'],
  'Service.address_mode': ['auto', 'host', 'driver', 'alloc', 'alloc_ipv6'],
  'ServiceCheck.type': ['http', 'tcp', 'script', 'grpc'],
  'ServiceCheck.address_mode': ['host', 'driver', 'alloc', 'alloc_ipv6'],
  'NetworkResource.mode': ['host', 'bridge'],
  'TaskLifecycle.hook': ['prestart', 'poststart', 'poststop'],
  'RestartPolicy.mode': ['fail', 'delay'],
  'ReschedulePolicy.delay_function': ['constant', 'exponential', 'fibonacci'],
  'VolumeRequest.type': ['host', 'csi'],
  'Vault.change_mode': ['restart', 'signal', 'noop'],
  'Template.change_mode': ['restart', 'signal', 'noop', 'script'],
};

const JOB_TYPES = [
  { id: 'service', title: '长期服务', titleEn: 'Service', desc: '持续在线运行，异常自动拉起（如 Web / DB）', descEn: 'Long-running service with auto-restart (e.g. Web / DB)' },
  { id: 'batch', title: '批处理任务', titleEn: 'Batch', desc: '执行完成后自动退出（如备份 / 迁移脚本）', descEn: 'Runs to completion and exits (e.g. backup / migration)' },
  { id: 'system', title: '全节点守护', titleEn: 'System', desc: '在每个满足条件的 Client 上各跑 1 份', descEn: 'Runs one allocation on every eligible client node' },
  { id: 'sysbatch', title: '全节点批处理', titleEn: 'Sysbatch', desc: '在所有节点各执行一次短任务后结束', descEn: 'Runs a short batch task once on every client node' },
];

const RESOURCE_PRESETS = [
  { label: '微型', labelEn: 'Micro', cpu: 100, memory: 128, hint: '100 MHz · 128 MiB' },
  { label: '轻量', labelEn: 'Small', cpu: 200, memory: 256, hint: '200 MHz · 256 MiB' },
  { label: '标准', labelEn: 'Standard', cpu: 500, memory: 512, hint: '500 MHz · 512 MiB' },
  { label: '高性能', labelEn: 'High', cpu: 1000, memory: 1024, hint: '1000 MHz · 1 GiB' },
];

const QUICK_DOCKER_IMAGES = [
  'nginx:alpine',
  'postgres:17-bookworm',
  'redis:7-alpine',
  'alpine:3.20',
];

const CRON_PRESETS = [
  { label: '每 5 分钟', labelEn: 'Every 5m', value: '*/5 * * * *' },
  { label: '每小时', labelEn: 'Hourly', value: '0 * * * *' },
  { label: '每天 02:00', labelEn: 'Daily 02:00', value: '0 2 * * *' },
];

const JOB_HANDLED_BLOCKS = new Set(['group', 'update', 'periodic', 'constraint']);
const GROUP_HANDLED_BLOCKS = new Set(['task', 'network', 'service', 'ephemeral_disk', 'restart', 'volume']);
const TASK_HANDLED_BLOCKS = new Set(['config', 'resources', 'env', 'vault', 'template', 'volume_mount', 'service']);

function samePath(a: NodePath, b: NodePath): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function literalValue(expression: string, kind: string): string | number | boolean | string[] | undefined {
  try {
    const value = JSON.parse(expression);
    if (kind === 'list' && Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
    if (
      (kind === 'string' && typeof value === 'string') ||
      (kind === 'number' && typeof value === 'number') ||
      (kind === 'bool' && typeof value === 'boolean')
    ) {
      return value;
    }
  } catch {
    // Heredocs, traversals and function calls remain native HCL expressions.
  }
  return undefined;
}

function ValueEditor({
  node,
  field,
  choices,
  disabled,
  onChange,
}: {
  node: HCLNode;
  field: AttributeRule;
  choices: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { tr } = useI18n();
  const expression = node.expression || '';
  const literal = literalValue(expression, field.kind);
  const [native, setNative] = useState(field.kind === 'expression' || literal === undefined);
  const raw = native || literal === undefined;
  const listId = `hcl-values-${node.name}-${choices.join('-').replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="font-mono font-semibold" htmlFor={`value-${node.name}`}>
          {node.name}
          {field.required ? ' *' : ''}
        </label>
        {field.kind !== 'expression' && (
          <Button size="sm" type="button" disabled={disabled || (raw && literal === undefined)} onClick={() => setNative(!raw)}>
            {raw ? tr('切换为值输入', 'Switch to value input') : tr('使用 HCL 表达式', 'Use HCL expression')}
          </Button>
        )}
      </div>
      {raw ? (
        <div className="space-y-1">
          <textarea
            id={`value-${node.name}`}
            aria-label={node.name}
            rows={node.name === 'data' ? 8 : 3}
            disabled={disabled}
            value={expression}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            className="w-full rounded-lg border border-slate-300 bg-white p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
          />
          <div className="text-[11px] text-slate-500">{tr('原生 HCL 表达式，例如 var.cpu、["http"] 或模板 heredoc。', 'Raw HCL expression, e.g. var.cpu, ["http"], or heredoc template.')}</div>
        </div>
      ) : field.kind === 'bool' ? (
        <Select id={`value-${node.name}`} aria-label={node.name} size="sm" disabled={disabled} value={expression} onChange={(e) => onChange(e.target.value)}>
          <option value="true">true</option>
          <option value="false">false</option>
        </Select>
      ) : field.kind === 'list' ? (
        <div className="space-y-1.5">
          {(literal as string[]).map((value, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                aria-label={tr(`${node.name} 第 ${i + 1} 项`, `${node.name} item ${i + 1}`)}
                list={choices.length ? listId : undefined}
                disabled={disabled}
                value={value}
                onChange={(e) =>
                  onChange(JSON.stringify((literal as string[]).map((item, index) => (index === i ? e.target.value : item))))
                }
                className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
              />
              <Button
                size="sm"
                aria-label={tr(`上移 ${node.name} 第 ${i + 1} 项`, `Move up ${node.name} item ${i + 1}`)}
                disabled={disabled || i === 0}
                onClick={() => {
                  const next = [...(literal as string[])];
                  [next[i - 1], next[i]] = [next[i], next[i - 1]];
                  onChange(JSON.stringify(next));
                }}
              >
                <ArrowUp className="h-3 w-3" />
              </Button>
              <Button
                size="sm"
                aria-label={tr(`删除 ${node.name} 第 ${i + 1} 项`, `Delete ${node.name} item ${i + 1}`)}
                disabled={disabled}
                onClick={() => onChange(JSON.stringify((literal as string[]).filter((_, index) => index !== i)))}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
          <Button size="sm" disabled={disabled} onClick={() => onChange(JSON.stringify([...(literal as string[]), '']))}>
            <Plus className="h-3 w-3" />
            {tr(`添加 ${node.name} 项`, `Add ${node.name} item`)}
          </Button>
        </div>
      ) : node.name === 'data' ? (
        <textarea
          id={`value-${node.name}`}
          aria-label={node.name}
          rows={8}
          disabled={disabled}
          value={String(literal)}
          onChange={(e) => onChange(JSON.stringify(e.target.value))}
          spellCheck={false}
          className="w-full rounded-lg border border-slate-300 bg-white p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
        />
      ) : (
        <input
          id={`value-${node.name}`}
          aria-label={node.name}
          type={field.kind === 'number' ? 'number' : 'text'}
          list={choices.length ? listId : undefined}
          disabled={disabled}
          value={String(literal)}
          onChange={(e) => onChange(field.kind === 'number' ? e.target.value : JSON.stringify(e.target.value))}
          className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
        />
      )}
      {choices.length > 0 && <datalist id={listId}>{choices.map((value) => <option key={value} value={value} />)}</datalist>}
    </div>
  );
}

function StringListEditor({
  label,
  hint,
  items,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  items: string[];
  placeholder?: string;
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const { tr } = useI18n();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{label}</span>
        {!disabled && (
          <button
            type="button"
            onClick={() => onChange([...items, ''])}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            <Plus className="h-3 w-3" />
            {tr('添加一项', 'Add Item')}
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-[11px] text-slate-400 dark:border-slate-700">
          {hint || tr('暂未配置', 'Not configured')}
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map((item, idx) => (
            <div key={idx} className="flex items-center gap-1.5">
              <input
                type="text"
                disabled={disabled}
                value={item}
                placeholder={placeholder}
                onChange={(e) => onChange(items.map((v, i) => (i === idx ? e.target.value : v)))}
                className="min-w-0 flex-1 rounded-lg border border-[#dce3ee] bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              {!disabled && (
                <button
                  type="button"
                  aria-label={tr(`删除第 ${idx + 1} 项`, `Delete item ${idx + 1}`)}
                  onClick={() => onChange(items.filter((_, i) => i !== idx))}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type FormSection = 'base' | 'network' | 'storage' | 'secrets' | 'advanced';

function SectionBox({
  hidden,
  icon,
  title,
  description,
  actions,
  children,
}: {
  hidden?: boolean;
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div hidden={hidden} className="rounded-xl border border-slate-200/90 bg-white dark:border-slate-800 dark:bg-slate-900/80">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 min-w-0">
          {icon && <span className="text-indigo-500 dark:text-indigo-400 shrink-0">{icon}</span>}
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">{title}</div>
            {description && <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-1.5 shrink-0">{actions}</div>}
      </div>
      {children && <div className="p-4 space-y-3">{children}</div>}
    </div>
  );
}

export const VisualJobBuilder = forwardRef<VisualJobBuilderHandle, Props>(function VisualJobBuilder(
  { clusterId, source, readOnly, onSourceChange, onValidityChange },
  ref,
) {
  const { locale, isEn, tr } = useI18n();
  const toast = useToast();
  const [document, setDocument] = useState<HCLDocument | null>(null);
  const [schema, setSchema] = useState<BuilderSchema | null>(null);
  const [viewMode, setViewMode] = useState<'form' | 'tree'>('form');
  const [showPreview, setShowPreview] = useState(false);
  const [widePreview, setWidePreview] = useState(() => window.matchMedia('(min-width: 1440px)').matches);
  const [groupSection, setGroupSection] = useState<FormSection>('base');
  const [taskSection, setTaskSection] = useState<FormSection>('base');
  const [quickAdd, setQuickAdd] = useState<{ form: QuickAddForm; path: NodePath; groupPath: NodePath; bindTaskPath?: NodePath } | null>(null);
  const [selected, setSelected] = useState<NodePath>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [diagnostics, setDiagnostics] = useState<BuilderDiagnostic[]>([]);
  const [error, setError] = useState('');
  const [rendering, setRendering] = useState(false);
  const [liveHcl, setLiveHcl] = useState(source);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState('');
  const [customName, setCustomName] = useState('');
  const [customKind, setCustomKind] = useState<'attribute' | 'block'>('attribute');
  const [customDcInput, setCustomDcInput] = useState('');
  const [showDockerAdv, setShowDockerAdv] = useState(false);
  const [showVaultWizardInline, setShowVaultWizardInline] = useState(false);
  const [undo, setUndo] = useState<HCLDocument[]>([]);
  const [redo, setRedo] = useState<HCLDocument[]>([]);
  const [options, setOptions] = useState<BuilderOptions>({
    namespaces: [],
    node_pools: [],
    datacenters: [],
    drivers: [],
    host_volumes: {},
    host_networks: {},
  });
  const [vaultRoles, setVaultRoles] = useState<VaultRoleOption[]>([]);
  const [vaultIntegrations, setVaultIntegrations] = useState<VaultIntegrationOption[]>([]);
  const [createHostVol, setCreateHostVol] = useState<{ name: string; readOnly: boolean } | null>(null);
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
  const emittedSourcesRef = useRef<Set<string>>(new Set());
  const lastClusterRef = useRef<string>(clusterId);
  const docRef = useRef<HCLDocument | null>(null);
  const formPanelRef = useRef<HTMLDivElement>(null);
  const treePanelRef = useRef<HTMLDivElement>(null);
  const vaultRoleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const query = window.matchMedia('(min-width: 1440px)');
    const update = () => setWidePreview(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const callbacks = useRef({ onSourceChange, onValidityChange });
  callbacks.current = { onSourceChange, onValidityChange };

  const pickInitialSelection = (doc: HCLDocument): NodePath => {
    const jobIdx = doc.nodes.findIndex((n) => n.kind === 'block' && n.name === 'job');
    if (jobIdx < 0) return [];
    return [jobIdx];
  };

  const renderLatest = async (doc: HCLDocument): Promise<BuilderResult> => {
    const request = ++requestRef.current;
    setRendering(true);
    callbacks.current.onValidityChange(false);
    try {
      const result = await apiPost<BuilderResult>(`/api/v1/nomad/${clusterId}/job-ops/hcl-tree-render`, doc);
      if (mountedRef.current && request === requestRef.current) {
        if (emittedSourcesRef.current.size > 16) emittedSourcesRef.current.clear();
        emittedSourcesRef.current.add(result.hcl);
        setLiveHcl(result.hcl);
        callbacks.current.onSourceChange(result.hcl);
        callbacks.current.onValidityChange(result.valid);
        setDiagnostics(result.diagnostics || []);
        setError('');
      }
      return result;
    } catch (ex: any) {
      if (mountedRef.current && request === requestRef.current) setError(ex.message || tr('生成 HCL 失败', 'Failed to render HCL'));
      throw ex;
    } finally {
      if (mountedRef.current && request === requestRef.current) setRendering(false);
    }
  };

  useImperativeHandle(ref, () => ({
    flush: async () => {
      while (mountedRef.current && docRef.current) {
        const current = docRef.current;
        const result = await renderLatest(current);
        if (mountedRef.current && current === docRef.current) return result;
      }
      return { hcl: sourceRef.current, valid: false, diagnostics };
    },
  }));

  const refreshBuilderOptions = async () => {
    try {
      const res = await apiGet<{
        options: BuilderOptions;
        vault_roles?: VaultRoleOption[];
        vault_integrations?: VaultIntegrationOption[];
      }>(`/api/v1/nomad/${clusterId}/builder-options`);
      setOptions(res.options || { namespaces: [], node_pools: [], datacenters: [], drivers: [], host_volumes: {}, host_networks: {} });
      const roles = res.vault_roles || [];
      setVaultRoles(roles);
      setVaultIntegrations(res.vault_integrations || []);
      if (roles.length > 0) {
        const first = roles[0];
        const firstPath = (first.secret_paths || [])[0] || 'secret/apps/demo';
        setVaultHelper((prev) => (prev.role ? prev : { ...prev, role: first.role, secretPath: firstPath }));
      }
    } catch {
      // Non-blocking
    }
  };

  // Load cluster builder options once per clusterId
  useEffect(() => {
    let active = true;
    void apiGet<{
      options: BuilderOptions;
      vault_roles?: VaultRoleOption[];
      vault_integrations?: VaultIntegrationOption[];
    }>(`/api/v1/nomad/${clusterId}/builder-options`)
      .then((res) => {
        if (!active) return;
        setOptions(res.options || { namespaces: [], node_pools: [], datacenters: [], drivers: [], host_volumes: {}, host_networks: {} });
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
    return () => {
      active = false;
    };
  }, [clusterId]);

  // Parse HCL into AST on mount, cluster change, or external source change (e.g. picking a starter template)
  useEffect(() => {
    const sameCluster = lastClusterRef.current === clusterId;
    if (sameCluster && docRef.current && emittedSourcesRef.current.has(source)) {
      return;
    }
    lastClusterRef.current = clusterId;
    mountedRef.current = true;
    let active = true;
    docRef.current = null;
    emittedSourcesRef.current.clear();
    emittedSourcesRef.current.add(source);
    setDocument(null);
    setLiveHcl(source);
    setUndo([]);
    setRedo([]);
    setGroupSection('base');
    setTaskSection('base');
    setQuickAdd(null);
    setError('');
    callbacks.current.onValidityChange(false);
    void apiPost<{ document: HCLDocument; schema: BuilderSchema }>(`/api/v1/nomad/${clusterId}/job-ops/hcl-tree`, {
      hcl: source,
    })
      .then((res) => {
        if (!active) return;
        docRef.current = res.document;
        setRendering(true);
        setDocument(res.document);
        setSchema(res.schema);
        setSelected(pickInitialSelection(res.document));
      })
      .catch((ex) => {
        if (active) setError(ex.message || tr('HCL 无法载入，请返回原生编辑器修正语法', 'Failed to parse HCL; fix syntax in Native HCL editor'));
      });
    return () => {
      active = false;
      requestRef.current++;
    };
  }, [clusterId, source]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!document) return;
    const timer = window.setTimeout(() => {
      void renderLatest(document).catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [document, clusterId]);

  useEffect(() => {
    setAdding('');
    setFilter('');
    setCustomName('');
    setCustomKind('attribute');
    setShowVaultWizardInline(false);
  }, [JSON.stringify(selected)]);

  const commit = (next: HCLDocument, path = selected) => {
    const previous = docRef.current;
    if (readOnly || !previous || previous === next) return;
    requestRef.current++;
    callbacks.current.onValidityChange(false);
    setRendering(true);
    setUndo((history) => [...history.slice(-29), previous]);
    setRedo([]);
    docRef.current = next;
    setDocument(next);
    setSelected(path);
  };

  const navigateHistory = (back: boolean) => {
    const history = back ? undo : redo;
    const previous = docRef.current;
    if (!history.length || !previous || readOnly) return;
    const next = history[history.length - 1];
    if (back) {
      setUndo(history.slice(0, -1));
      setRedo((items) => [...items, previous]);
    } else {
      setRedo(history.slice(0, -1));
      setUndo((items) => [...items, previous]);
    }
    requestRef.current++;
    callbacks.current.onValidityChange(false);
    setRendering(true);
    const currentNode = nodeAt(previous, selected);
    const restoredNode = nodeAt(next, selected);
    docRef.current = next;
    setDocument(next);
    const sameNode = currentNode && restoredNode && currentNode.name === restoredNode.name
      && JSON.stringify(currentNode.labels) === JSON.stringify(restoredNode.labels);
    setSelected(sameNode ? selected : pickInitialSelection(next));
  };

  // Resolve current selection context for Form mode vs Tree mode
  const jobPath = useMemo(() => (document ? findJobPath(document) : null), [document]);
  const groups = useMemo(
    () => (document && jobPath ? listChildBlocks(document, jobPath, 'group') : []),
    [document, jobPath],
  );

  if (!document || !schema) {
    return (
      <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/40">
        <ErrorAlert message={error} />
        <p className="text-xs text-slate-500">
          {error ? tr('原始内容保持不变，可切换回「原生 HCL」修正语法后再切回可视化编排。', 'Original source preserved; fix syntax in "Native HCL" and switch back.') : tr('正在解析 HCL 结构…', 'Parsing HCL AST...')}
        </p>
      </div>
    );
  }

  const jumpToTreePath = (path: NodePath) => {
    setSelected(path);
    setViewMode('tree');
  };

  const selectInForm = (path: NodePath, section?: FormSection) => {
    if (section && nodeAt(document, path)?.name === 'group') setGroupSection(section);
    if (section && nodeAt(document, path)?.name === 'task') setTaskSection(section);
    setSelected(path);
    setViewMode('form');
    window.requestAnimationFrame(() => {
      const el = formPanelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.top < 72 || rect.top > window.innerHeight - 120) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  };

  // Determine the active form entity (Job, Group, or Task). If user had a deep AST node selected,
  // resolve its nearest Task -> Group -> Job ancestor for Form mode.
  const resolveFormTarget = (): { kind: 'job' | 'group' | 'task' | 'none'; path: NodePath; groupPath?: NodePath } => {
    if (!jobPath) return { kind: 'none', path: [] };
    for (let len = selected.length; len >= 1; len--) {
      const sub = selected.slice(0, len);
      const n = nodeAt(document, sub);
      if (n?.kind === 'block') {
        if (n.name === 'task') return { kind: 'task', path: sub, groupPath: sub.slice(0, -1) };
        if (n.name === 'group') return { kind: 'group', path: sub };
        if (n.name === 'job') return { kind: 'job', path: sub };
      }
    }
    return { kind: 'job', path: jobPath };
  };

  const formTarget = resolveFormTarget();
  const renderFormSections = (kind: 'group' | 'task') => {
    const options: Array<{ id: FormSection; label: string }> = [
      { id: 'base', label: tr('基础', 'Basics') },
      { id: 'network', label: tr('网络与服务', 'Networking & Services') },
      { id: 'storage', label: tr('存储', 'Storage') },
      ...(kind === 'task' ? [{ id: 'secrets' as const, label: tr('环境与密钥', 'Environment & Secrets') }] : []),
      { id: 'advanced', label: tr('高级设置', 'Advanced') },
    ];
    return (
      <SectionTabs
        variant="underline"
        tabs={options}
        active={kind === 'group' ? groupSection : taskSection}
        onChange={(id) => {
          const section = options.find((option) => option.id === id)?.id;
          if (section) (kind === 'group' ? setGroupSection : setTaskSection)(section);
        }}
      />
    );
  };

  const copyPreviewButton = (
    <Button
      size="sm"
      variant="ghost"
      onClick={() =>
        void copyText(liveHcl)
          .then(() => toast.success(tr('已复制实时 HCL', 'Live HCL copied')))
          .catch((ex) => toast.error(ex.message))
      }
    >
      <Copy className="h-3.5 w-3.5" />
      <span>{tr('复制', 'Copy')}</span>
    </Button>
  );

  const openServiceForm = (path: NodePath, groupPath: NodePath, name: string) => {
    const tasks = listChildBlocks(document, groupPath, 'task');
    const candidate = samePath(path, groupPath) ? (tasks.length === 1 ? tasks[0].path : undefined) : path;
    const ports = listGroupPorts(document, groupPath).map((port) => port.label);
    let bindTaskPath: NodePath | undefined;
    if (candidate && parseLiteralString(getAttrExpr(document, candidate, 'driver')) === 'docker' && !ports.length) {
      const config = findChildBlock(document, candidate, 'config');
      const expression = getAttrNode(config?.node.body, 'ports')?.expression;
      if (expression === undefined || parseLiteralStringList(expression) !== undefined) bindTaskPath = candidate;
    }
    setQuickAdd({ form: { kind: 'service', name, ports, canDeclarePort: Boolean(bindTaskPath) }, path, groupPath, bindTaskPath });
  };

  const saveQuickAdd = (value: QuickAddValue) => {
    if (!quickAdd || readOnly || !docRef.current) return;
    const { path, groupPath, bindTaskPath } = quickAdd;
    const current = docRef.current;
    let next: HCLDocument;
    if (value.kind === 'port') {
      next = declareAndBindTaskPort(current, groupPath, path, value.label, value.destination);
    } else if (value.kind === 'volume') {
      next = value.source
        ? declareAndMountTaskVolume(current, groupPath, path, value, value.destination)
        : addTaskVolumeMount(current, path, { volume: value.name, destination: value.destination, readOnly: value.readOnly });
    } else {
      let draft = current;
      if (value.newPort && bindTaskPath) {
        draft = declareAndBindTaskPort(current, groupPath, bindTaskPath, value.newPort.label, value.newPort.destination);
        if (draft === current) {
          setError(tr('无法声明并绑定服务端口。请检查任务组端口配置。', 'Could not declare and bind the service port. Check the group port configuration.'));
          setQuickAdd(null);
          return;
        }
      }
      const serviceIndex = bodyAt(draft, path).nodes.length;
      next = addGroupService(draft, path, value);
      if (value.check) {
        next = addServiceCheck(next, [...path, serviceIndex], {
          type: value.check,
          path: value.path,
          addressMode: value.checkAddressMode,
        });
      }
    }
    setQuickAdd(null);
    if (next === current) {
      setError(tr('无法应用。请检查任务组中的名称冲突或 HCL 表达式。', 'Could not apply. Check for name conflicts or HCL expressions in the group.'));
      return;
    }
    commit(next, path);
  };

  const revealDiagnostic = (issue: BuilderDiagnostic) => {
    let path = issue.path || [];
    while (path.length && !nodeAt(document, path)) path = path.slice(0, -1);
    const field = nodeAt(document, path)?.name;
    for (let depth = path.length - 1; depth > 0; depth--) {
      const owner = path.slice(0, depth);
      if (nodeAt(document, owner)?.name !== 'task') continue;
      const block = nodeAt(document, path.slice(0, depth + 1))?.name;
      if (block === 'config' && (field === 'image' || issue.message.endsWith(' image'))) {
        selectInForm(owner, 'base');
        window.requestAnimationFrame(() => formPanelRef.current?.querySelector<HTMLElement>('[data-builder-field="image"]')?.focus());
        return;
      }
      break;
    }
    jumpToTreePath(path);
    window.requestAnimationFrame(() => {
      const inspector = treePanelRef.current;
      const element = inspector?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])');
      (element || inspector)?.focus();
    });
  };
  const topLevelExtras = document.nodes
    .map((n, i) => ({ n, path: [i] as NodePath }))
    .filter(({ n }) => !(n.kind === 'block' && n.name === 'job'));

  // ---------------------------------------------------------------------------
  // Renderers for FORM MODE
  // ---------------------------------------------------------------------------

  const renderJobForm = (jPath: NodePath) => {
    const jobNode = nodeAt(document, jPath)!;
    const jobName = jobNode.labels?.[0] || '';
    const jobType = parseLiteralString(getAttrExpr(document, jPath, 'type')) || 'service';
    const dcs = parseLiteralStringList(getAttrExpr(document, jPath, 'datacenters')) || [];
    const dcExprRaw = getAttrExpr(document, jPath, 'datacenters');
    const dcIsDynamic = Boolean(dcExprRaw && parseLiteralStringList(dcExprRaw) === undefined);
    const nsVal = parseLiteralString(getAttrExpr(document, jPath, 'namespace')) || '';
    const poolVal = parseLiteralString(getAttrExpr(document, jPath, 'node_pool')) || '';
    const priorityVal = parseLiteralNumber(getAttrExpr(document, jPath, 'priority'));
    const allKnownDcs = Array.from(new Set([...(options.datacenters.length ? options.datacenters : ['dc1']), ...dcs]));

    const updateBlk = findChildBlock(document, jPath, 'update');
    const periodicBlk = findChildBlock(document, jPath, 'periodic');
    const constraints = listChildBlocks(document, jPath, 'constraint');
    const unhandled = listUnhandledBlocks(document, jPath, JOB_HANDLED_BLOCKS);

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-1 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2 min-w-0">
            <span className="rounded-lg bg-indigo-50 p-1.5 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
              <Layers className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                {tr('Job：', 'Job: ')}{jobName || tr('未命名任务', 'Unnamed Job')}
              </div>
              <div className="text-[11px] text-slate-500">{tr('定义工作负载全局名称、调度类型、数据中心与发布策略', 'Define job name, workload type, datacenters, and rollout strategy')}</div>
            </div>
          </div>
          {!readOnly && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const res = addReadyGroup(document, jPath);
                commit(res.document, res.path);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{tr('添加任务组', 'Add Group')}</span>
            </Button>
          )}
        </div>

        <SectionBox icon={<Settings2 className="h-4 w-4" />} title={tr('基础身份与调度范围', 'Identity & Scheduling Scope')}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label={tr('Job 名称', 'Job Name')}
              disabled={readOnly}
              value={jobName}
              placeholder={tr('例如 web-api', 'e.g. web-api')}
              onChange={(e) => commit(setBlockLabel(document, jPath, e.target.value))}
            />
            <Input
              label={tr('调度优先级 (1 - 100，默认 50)', 'Priority (1-100, default 50)')}
              type="number"
              min={1}
              max={100}
              disabled={readOnly}
              value={priorityVal !== undefined ? String(priorityVal) : ''}
              placeholder="50"
              onChange={(e) => {
                const v = e.target.value.trim();
                const n = Number(v);
                commit(setAttrExpr(document, jPath, 'priority', v && Number.isFinite(n) ? String(Math.min(100, Math.max(1, Math.round(n)))) : null));
              }}
            />
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-slate-700 dark:text-slate-300">{tr('工作负载类型', 'Workload Type')}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {JOB_TYPES.map((t) => {
                const active = jobType === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={readOnly}
                    onClick={() => commit(setAttrExpr(document, jPath, 'type', JSON.stringify(t.id)))}
                    className={`rounded-xl border p-2.5 text-left transition ${
                      active
                        ? 'border-indigo-500 bg-indigo-50/70 ring-1 ring-indigo-500/20 dark:border-indigo-400 dark:bg-indigo-500/15'
                        : 'border-slate-200 bg-slate-50/50 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-950/30 dark:hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-semibold text-slate-900 dark:text-slate-100">{isEn ? t.titleEn : t.title}</span>
                      <span className="font-mono text-[10px] text-slate-400">{t.id}</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{isEn ? t.descEn : t.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{tr('目标数据中心 (Datacenters)', 'Target Datacenters')}</span>
              {dcIsDynamic && (
                <button
                  type="button"
                  onClick={() => jumpToTreePath(jPath)}
                  className="text-[11px] text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {tr('当前使用动态表达式，点此在结构树编辑', 'Using dynamic expression; click to edit in AST tree')}
                </button>
              )}
            </div>
            {!dcIsDynamic && (
              <div className="flex flex-wrap items-center gap-1.5">
                {allKnownDcs.map((dc) => {
                  const active = dcs.includes(dc);
                  return (
                    <button
                      key={dc}
                      type="button"
                      disabled={readOnly}
                      onClick={() => {
                        const next = active ? dcs.filter((item) => item !== dc) : [...dcs, dc];
                        commit(setAttrExpr(document, jPath, 'datacenters', JSON.stringify(next.length ? next : ['dc1'])));
                      }}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 font-mono text-xs transition ${
                        active
                          ? 'border-indigo-500 bg-indigo-600 text-white'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
                      }`}
                    >
                      {active && <Check className="h-3 w-3" />}
                      <span>{dc}</span>
                    </button>
                  );
                })}
                {!readOnly && (
                  <div className="flex items-center gap-1">
                    <input
                      value={customDcInput}
                      onChange={(e) => setCustomDcInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && customDcInput.trim()) {
                          e.preventDefault();
                          const val = customDcInput.trim();
                          const next = Array.from(new Set([...dcs, val]));
                          commit(setAttrExpr(document, jPath, 'datacenters', JSON.stringify(next)));
                          setCustomDcInput('');
                        }
                      }}
                      placeholder={tr('新增 DC 按回车', 'Add DC + Enter')}
                      className="w-28 rounded-lg border border-dashed border-slate-300 bg-white px-2 py-1 font-mono text-[11px] focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950"
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select
              label={tr('命名空间 (可选，留空跟随页面所选)', 'Namespace (optional, defaults to page selection)')}
              size="sm"
              disabled={readOnly}
              value={nsVal}
              onChange={(e) => commit(setAttrExpr(document, jPath, 'namespace', e.target.value ? JSON.stringify(e.target.value) : null))}
            >
              <option value="">{tr('跟随提交时所选 Namespace', 'Follow selected Namespace')}</option>
              {Array.from(new Set(['default', ...options.namespaces, ...(nsVal ? [nsVal] : [])])).map((ns) => (
                <option key={ns} value={ns}>
                  {ns}
                </option>
              ))}
            </Select>
            <Select
              label={tr('节点资源池 Node Pool (可选)', 'Node Pool (optional)')}
              size="sm"
              disabled={readOnly}
              value={poolVal}
              onChange={(e) => commit(setAttrExpr(document, jPath, 'node_pool', e.target.value ? JSON.stringify(e.target.value) : null))}
            >
              <option value="">{tr('默认资源池 (default)', 'Default pool (default)')}</option>
              {Array.from(new Set([...options.node_pools, ...(poolVal ? [poolVal] : [])])).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </div>
        </SectionBox>

        <SectionBox
          icon={<Boxes className="h-4 w-4" />}
          title={tr(`包含的任务组 (${groups.length})`, `Task Groups (${groups.length})`)}
          description={tr('点击任意任务组即可配置副本数、端口映射与具体运行容器', 'Click a group to configure count, ports, and tasks')}
          actions={
            !readOnly && (
              <Button
                size="sm"
                onClick={() => {
                  const res = addReadyGroup(document, jPath);
                  commit(res.document, res.path);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{tr('新增任务组', 'Add Group')}</span>
              </Button>
            )
          }
        >
          {groups.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 py-5 text-center text-slate-400 dark:border-slate-800">
              {tr('当前 Job 尚无任务组，请点击上方「新增任务组」', 'No task groups yet; click "Add Group" above')}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {groups.map((grp) => {
                const count = parseLiteralNumber(getAttrExpr(document, grp.path, 'count')) ?? 1;
                const grpTasks = listChildBlocks(document, grp.path, 'task');
                const grpPorts = listGroupPorts(document, grp.path);
                return (
                  <button
                    key={grp.path.join('.')}
                    type="button"
                    onClick={() => selectInForm(grp.path)}
                    className="flex flex-col gap-1.5 rounded-xl border border-slate-200 bg-slate-50/50 p-3 text-left transition hover:border-indigo-400 hover:bg-indigo-50/30 dark:border-slate-800 dark:bg-slate-950/40 dark:hover:border-indigo-500/50"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">{grp.label || 'unnamed'}</span>
                      <div className="flex items-center gap-1">
                        <Badge tone="blue">×{count}</Badge>
                        <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[11px] text-slate-500">
                      <span>{tr(`${grpTasks.length} 个任务`, `${grpTasks.length} task(s)`)}</span>
                      {grpPorts.length > 0 && (
                        <span>{tr('· 端口：', '· Ports: ')}{grpPorts.map((p) => p.label + (p.staticPort ? `:${p.staticPort}` : '')).join(', ')}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </SectionBox>

        <SectionBox
          icon={<RefreshCw className="h-4 w-4" />}
          title={tr('滚动更新策略 (update)', 'Rolling Update Strategy (update)')}
          description={tr('控制发版时每次替换几个实例，异常时自动回滚到上一健康版本', 'Controls parallel replacements during deploy and auto-revert on failure')}
          actions={
            <Switch
              label={tr('启用滚动更新策略', 'Enable update strategy')}
              disabled={readOnly}
              checked={Boolean(updateBlk)}
              onChange={(checked) => commit(setJobUpdateStrategy(document, jPath, checked))}
            />
          }
        >
          {updateBlk && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Input
                label={tr('最大并行替换 (max_parallel)', 'Max Parallel (max_parallel)')}
                type="number"
                min={1}
                disabled={readOnly}
                value={String(parseLiteralNumber(getAttrExpr(document, updateBlk.path, 'max_parallel')) ?? 1)}
                onChange={(e) =>
                  commit(setJobUpdateStrategy(document, jPath, true, { maxParallel: Number(e.target.value) || 1 }))
                }
              />
              <Input
                label={tr('健康观察期 (min_healthy_time)', 'Min Healthy Time (min_healthy_time)')}
                disabled={readOnly}
                value={parseLiteralString(getAttrExpr(document, updateBlk.path, 'min_healthy_time')) || '10s'}
                onChange={(e) =>
                  commit(setJobUpdateStrategy(document, jPath, true, { minHealthyTime: e.target.value }))
                }
              />
              <Input
                label={tr('健康超时 (healthy_deadline)', 'Healthy Deadline (healthy_deadline)')}
                disabled={readOnly}
                value={parseLiteralString(getAttrExpr(document, updateBlk.path, 'healthy_deadline')) || '3m'}
                onChange={(e) =>
                  commit(setJobUpdateStrategy(document, jPath, true, { healthyDeadline: e.target.value }))
                }
              />
              <label className="sm:col-span-3 flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={parseLiteralBool(getAttrExpr(document, updateBlk.path, 'auto_revert')) ?? true}
                  onChange={(e) => commit(setJobUpdateStrategy(document, jPath, true, { autoRevert: e.target.checked }))}
                />
                <span>{tr('发布失败时自动回滚至上一稳定版本 (auto_revert)', 'Auto-revert to previous stable version on failure (auto_revert)')}</span>
              </label>
            </div>
          )}
        </SectionBox>

        <SectionBox
          icon={<SlidersHorizontal className="h-4 w-4" />}
          title={tr('定时周期调度 (periodic)', 'Periodic Schedule (periodic)')}
          description={tr('适用于 batch 类型任务，按 Cron 定时自动拉起运行', 'For batch jobs; automatically triggers runs on a Cron schedule')}
          actions={
            <Switch
              label={tr('启用定时周期调度', 'Enable periodic schedule')}
              disabled={readOnly}
              checked={Boolean(periodicBlk)}
              onChange={(checked) => commit(setJobPeriodic(document, jPath, checked))}
            />
          }
        >
          {periodicBlk && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-slate-500">{tr('常用周期：', 'Presets:')}</span>
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    disabled={readOnly}
                    onClick={() => commit(setJobPeriodic(document, jPath, true, { cron: p.value }))}
                    className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600 hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  >
                    {isEn ? p.labelEn : p.label} ({p.value})
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Input
                  label={tr('Cron 表达式', 'Cron Expression')}
                  disabled={readOnly}
                  value={parseLiteralString(getAttrExpr(document, periodicBlk.path, 'cron')) || ''}
                  placeholder="0 * * * *"
                  onChange={(e) => commit(setJobPeriodic(document, jPath, true, { cron: e.target.value }))}
                />
                <Input
                  label={tr('时区 (time_zone，可选)', 'Time Zone (time_zone, optional)')}
                  disabled={readOnly}
                  value={parseLiteralString(getAttrExpr(document, periodicBlk.path, 'time_zone')) || ''}
                  placeholder="Asia/Shanghai"
                  onChange={(e) => commit(setJobPeriodic(document, jPath, true, { timeZone: e.target.value }))}
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={parseLiteralBool(getAttrExpr(document, periodicBlk.path, 'prohibit_overlap')) ?? true}
                  onChange={(e) => commit(setJobPeriodic(document, jPath, true, { prohibitOverlap: e.target.checked }))}
                />
                <span>{tr('上一次尚未结束时跳过本次触发 (prohibit_overlap)', 'Skip trigger if previous run is still active (prohibit_overlap)')}</span>
              </label>
            </div>
          )}
        </SectionBox>

        <SectionBox
          icon={<Shield className="h-4 w-4" />}
          title={tr(`节点调度约束 (${constraints.length})`, `Placement Constraints (${constraints.length})`)}
          description={tr('限定任务只调度到满足特定系统、架构或节点标签的主机', 'Restrict placement to hosts matching OS, arch, or node attributes')}
          actions={
            !readOnly && (
              <Button size="sm" onClick={() => commit(addJobConstraint(document, jPath))}>
                <Plus className="h-3.5 w-3.5" />
                <span>{tr('添加约束', 'Add Constraint')}</span>
              </Button>
            )
          }
        >
          {constraints.length === 0 ? (
            <div className="text-[11px] text-slate-400">{tr('未设置额外约束，将调度到任意可用 Client 节点。', 'No extra constraints; schedules onto any eligible Client node.')}</div>
          ) : (
            <div className="space-y-2">
              {constraints.map((c) => {
                const attr = parseLiteralString(getAttrExpr(document, c.path, 'attribute')) || '';
                const op = parseLiteralString(getAttrExpr(document, c.path, 'operator')) || '=';
                const val = parseLiteralString(getAttrExpr(document, c.path, 'value')) || '';
                return (
                  <div key={c.path.join('.')} className="grid grid-cols-1 gap-2 sm:grid-cols-[1.4fr_110px_1fr_auto] items-center rounded-lg border border-slate-200/80 bg-slate-50/50 p-2 dark:border-slate-800 dark:bg-slate-950/30">
                    <input
                      aria-label={tr('约束属性', 'Constraint attribute')}
                      disabled={readOnly}
                      value={attr}
                      placeholder="${attr.kernel.name}"
                      onChange={(e) => commit(setAttrExpr(document, c.path, 'attribute', JSON.stringify(e.target.value)))}
                      className="rounded-lg border border-[#dce3ee] bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                    />
                    <Select
                      aria-label={tr('约束运算符', 'Constraint operator')}
                      size="sm"
                      disabled={readOnly}
                      value={op}
                      onChange={(e) => commit(setAttrExpr(document, c.path, 'operator', JSON.stringify(e.target.value)))}
                    >
                      {['=', '!=', 'regexp', 'set_contains', 'distinct_hosts', 'distinct_property'].map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </Select>
                    <input
                      aria-label={tr('约束目标值', 'Constraint value')}
                      disabled={readOnly}
                      value={val}
                      placeholder="linux"
                      onChange={(e) => commit(setAttrExpr(document, c.path, 'value', JSON.stringify(e.target.value)))}
                      className="rounded-lg border border-[#dce3ee] bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                    />
                    {!readOnly && (
                      <button
                        type="button"
                        aria-label={tr('删除约束', 'Delete constraint')}
                        onClick={() => commit(removeNodeAtPath(document, c.path))}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </SectionBox>

        {unhandled.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/80 bg-slate-50/70 px-3.5 py-2.5 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
            <span>{tr('已无损保留其他 HCL 块：', 'Preserved extra HCL blocks:')}</span>
            {unhandled.map((blk) => (
              <button
                key={blk.path.join('.')}
                type="button"
                onClick={() => jumpToTreePath(blk.path)}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 font-mono text-indigo-600 hover:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-indigo-300"
              >
                <span>{blk.name}{blk.label ? ` "${blk.label}"` : ''}</span>
                <ChevronRight className="h-3 w-3" />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderGroupForm = (gPath: NodePath) => {
    const grpNode = nodeAt(document, gPath)!;
    const grpName = grpNode.labels?.[0] || '';
    const countVal = parseLiteralNumber(getAttrExpr(document, gPath, 'count')) ?? 1;
    const netBlk = findChildBlock(document, gPath, 'network');
    const netMode = netBlk ? parseLiteralString(getAttrExpr(document, netBlk.path, 'mode')) || '' : '';
    const ports = listGroupPorts(document, gPath);
    const services = listChildBlocks(document, gPath, 'service');
    const diskBlk = findChildBlock(document, gPath, 'ephemeral_disk');
    const restartBlk = findChildBlock(document, gPath, 'restart');
    const volumes = listChildBlocks(document, gPath, 'volume');
    const tasks = listChildBlocks(document, gPath, 'task');
    const unhandled = listUnhandledBlocks(document, gPath, GROUP_HANDLED_BLOCKS);
    const knownHostVolumes = Object.keys(options.host_volumes || {});
    const knownHostNetworks = Object.keys(options.host_networks || {});

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-1 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2 min-w-0">
            <span className="rounded-lg bg-sky-50 p-1.5 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300">
              <Boxes className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-[11px] text-slate-400">
                <button type="button" onClick={() => jobPath && selectInForm(jobPath)} className="hover:text-indigo-600">
                  Job
                </button>
                <ChevronRight className="h-3 w-3" />
                <span>{tr('任务组', 'Group')}</span>
              </div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                {grpName || tr('未命名任务组', 'Unnamed Group')}
              </div>
            </div>
          </div>
          {!readOnly && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  const res = addReadyTask(document, gPath);
                  commit(res.document, res.path);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{tr('添加任务', 'Add Task')}</span>
              </Button>
              <Button
                size="sm"
                title={tr('复制当前任务组', 'Duplicate group')}
                onClick={() => {
                  try {
                    const next = duplicateBlock(document, gPath, schema);
                    commit(next.document, next.path);
                  } catch (ex: any) {
                    setError(ex.message);
                  }
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                <span>{tr('复制', 'Duplicate')}</span>
              </Button>
              {groups.length > 1 && (
                <Button
                  size="sm"
                  variant="danger-outline"
                  onClick={() => commit(removeNodeAtPath(document, gPath), jobPath || [])}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{tr('删除', 'Delete')}</span>
                </Button>
              )}
            </div>
          )}
        </div>

        {renderFormSections('group')}

        <SectionBox hidden={groupSection !== 'base'} icon={<Server className="h-4 w-4" />} title={tr('任务组名称与副本数', 'Group Name & Count')}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 items-end">
            <Input
              label={tr('任务组名称 (group)', 'Group Name (group)')}
              disabled={readOnly}
              value={grpName}
              placeholder={tr('例如 app', 'e.g. app')}
              onChange={(e) => commit(setBlockLabel(document, gPath, e.target.value))}
            />
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-slate-700 dark:text-slate-300">{tr('实例副本数 (count)', 'Instance Count (count)')}</div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center rounded-lg border border-[#dce3ee] bg-white dark:border-slate-700 dark:bg-slate-950">
                  <button
                    type="button"
                    disabled={readOnly || countVal <= 0}
                    aria-label={tr('减少副本数', 'Decrease count')}
                    onClick={() => commit(setAttrExpr(document, gPath, 'count', String(Math.max(0, countVal - 1))))}
                    className="px-2.5 py-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800 rounded-l-lg"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <input
                    aria-label={tr('实例副本数', 'Instance count')}
                    type="number"
                    min={0}
                    disabled={readOnly}
                    value={countVal}
                    onChange={(e) => {
                      const n = Math.max(0, Math.round(Number(e.target.value) || 0));
                      commit(setAttrExpr(document, gPath, 'count', String(n)));
                    }}
                    className="w-16 border-x border-[#dce3ee] bg-transparent py-1.5 text-center font-mono text-xs font-semibold text-slate-900 focus:outline-none dark:border-slate-700 dark:text-slate-100"
                  />
                  <button
                    type="button"
                    disabled={readOnly}
                    aria-label={tr('增加副本数', 'Increase count')}
                    onClick={() => commit(setAttrExpr(document, gPath, 'count', String(countVal + 1)))}
                    className="px-2.5 py-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800 rounded-r-lg"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
                {[1, 2, 3].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    disabled={readOnly}
                    onClick={() => commit(setAttrExpr(document, gPath, 'count', String(preset)))}
                    className={`rounded-lg border px-2 py-1 text-[11px] font-mono ${
                      countVal === preset
                        ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300 dark:border-slate-700 dark:text-slate-400'
                    }`}
                  >
                    ×{preset}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </SectionBox>

        <SectionBox
          hidden={groupSection !== 'network'}
          icon={<Network className="h-4 w-4" />}
          title={tr(`网络与端口映射 (${ports.length})`, `Networking & Ports (${ports.length})`)}
          description={tr('在这里声明端口标签，随后在 Task 中一键勾选即可暴露给 Docker 容器', 'Declare port labels here, then select them in each Task to expose container ports')}
          actions={
            !readOnly && (
              <Button size="sm" onClick={() => commit(addGroupPort(document, gPath, { label: 'http', toPort: 80 }))}>
                <Plus className="h-3.5 w-3.5" />
                <span>{tr('添加端口', 'Add Port')}</span>
              </Button>
            )
          }
        >
          {netBlk && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-500">{tr('网络模式：', 'Network Mode:')}</span>
              {[
                { id: '', label: tr('默认 (host)', 'Default (host)') },
                { id: 'host', label: 'host' },
                { id: 'bridge', label: tr('bridge (需 CNI)', 'bridge (requires CNI)') },
              ].map((m) => (
                <button
                  key={m.id || 'default'}
                  type="button"
                  disabled={readOnly}
                  onClick={() => commit(setAttrExpr(document, netBlk.path, 'mode', m.id ? JSON.stringify(m.id) : null))}
                  className={`rounded-lg border px-2.5 py-1 text-[11px] ${
                    netMode === m.id
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700 font-medium dark:bg-indigo-500/20 dark:text-indigo-200'
                      : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}

          {ports.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 py-4 text-center text-[11px] text-slate-400 dark:border-slate-800">
              {tr('尚未声明端口。若服务需要对外监听（如 HTTP 80、Postgres 5432），请点击右上角「添加端口」。', 'No ports declared yet. Click "Add Port" to expose listeners (e.g. HTTP 80, Postgres 5432).')}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="hidden sm:grid sm:grid-cols-[1.1fr_1fr_1fr_1fr_auto] gap-2 px-2 text-[11px] text-slate-500">
                <span>{tr('端口标签 (label)', 'Port Label (label)')}</span>
                <span>{tr('宿主机端口 (static，留空动态)', 'Host Port (static, blank = dynamic)')}</span>
                <span>{tr('容器内端口 (to)', 'Container Port (to)')}</span>
                <span>{tr('宿主机网络 (host_network，可选)', 'Host Network (optional)')}</span>
                <span className="w-8" />
              </div>
              {ports.map((p) => (
                <div
                  key={p.path.join('.')}
                  className="grid grid-cols-1 gap-2 sm:grid-cols-[1.1fr_1fr_1fr_1fr_auto] items-center rounded-lg border border-slate-200/80 bg-slate-50/50 p-2 dark:border-slate-800 dark:bg-slate-950/30"
                >
                  <input
                    aria-label={tr('端口标签', 'Port label')}
                    disabled={readOnly}
                    value={p.label}
                    placeholder="http / db"
                    onChange={(e) => commit(updateGroupPort(document, p.path, { label: e.target.value }))}
                    className="rounded-lg border border-[#dce3ee] bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                  <input
                    aria-label={tr('宿主机固定端口', 'Static host port')}
                    type="number"
                    min={1}
                    max={65535}
                    disabled={readOnly}
                    value={p.staticPort}
                    placeholder={tr('动态分配', 'Dynamic')}
                    onChange={(e) => commit(updateGroupPort(document, p.path, { staticPort: e.target.value }))}
                    className="rounded-lg border border-[#dce3ee] bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                  <input
                    aria-label={tr('容器目标端口', 'Container port')}
                    type="number"
                    min={1}
                    max={65535}
                    disabled={readOnly}
                    value={p.toPort}
                    placeholder={tr('同宿主机', 'Same as host')}
                    onChange={(e) => commit(updateGroupPort(document, p.path, { toPort: e.target.value }))}
                    className="rounded-lg border border-[#dce3ee] bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                  <input
                    aria-label={tr('宿主机网络', 'Host network')}
                    list="vb-host-networks"
                    disabled={readOnly}
                    value={p.hostNetwork}
                    placeholder={tr('默认 (留空)', 'Default')}
                    onChange={(e) => commit(updateGroupPort(document, p.path, { hostNetwork: e.target.value }))}
                    className="rounded-lg border border-[#dce3ee] bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                  {!readOnly && (
                    <button
                      type="button"
                      aria-label={tr(`删除端口 ${p.label}`, `Delete port ${p.label}`)}
                      onClick={() => commit(removeNodeAtPath(document, p.path))}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {knownHostNetworks.length > 0 && (
                <datalist id="vb-host-networks">
                  {knownHostNetworks.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              )}
            </div>
          )}
        </SectionBox>

        <SectionBox
          hidden={groupSection !== 'base'}
          icon={<Container className="h-4 w-4" />}
          title={tr(`组内任务 (${tasks.length})`, `Tasks (${tasks.length})`)}
          description={tr('点击任务卡片进入容器镜像、资源配额、环境变量与 Vault 密钥配置', 'Click a task card to configure image, resources, env vars, and Vault secrets')}
          actions={
            !readOnly && (
              <Button
                size="sm"
                onClick={() => {
                  const res = addReadyTask(document, gPath);
                  commit(res.document, res.path);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{tr('添加任务', 'Add Task')}</span>
              </Button>
            )
          }
        >
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {tasks.map((tk) => {
              const drv = parseLiteralString(getAttrExpr(document, tk.path, 'driver')) || 'docker';
              const cfgBlk = findChildBlock(document, tk.path, 'config');
              const img = cfgBlk ? parseLiteralString(getAttrExpr(document, cfgBlk.path, 'image')) : undefined;
              const resBlk = findChildBlock(document, tk.path, 'resources');
              const cpu = resBlk ? parseLiteralNumber(getAttrExpr(document, resBlk.path, 'cpu')) : undefined;
              const mem = resBlk ? parseLiteralNumber(getAttrExpr(document, resBlk.path, 'memory')) : undefined;
              const hasVault = Boolean(findChildBlock(document, tk.path, 'vault'));
              return (
                <button
                  key={tk.path.join('.')}
                  type="button"
                  onClick={() => selectInForm(tk.path)}
                  className="flex flex-col gap-1.5 rounded-xl border border-slate-200 bg-slate-50/50 p-3 text-left transition hover:border-indigo-400 hover:bg-indigo-50/30 dark:border-slate-800 dark:bg-slate-950/40 dark:hover:border-indigo-500/50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">{tk.label || 'task'}</span>
                    <div className="flex items-center gap-1">
                      <Badge>{drv}</Badge>
                      {hasVault && <Badge tone="green">Vault</Badge>}
                      <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                    </div>
                  </div>
                  <div className="truncate font-mono text-[11px] text-slate-500">
                    {img || (drv === 'docker' ? tr('未指定镜像', 'No image specified') : tr('命令执行', 'Command exec'))}
                    {(cpu || mem) ? ` · ${cpu ?? '-'}MHz / ${mem ?? '-'}MiB` : ''}
                  </div>
                </button>
              );
            })}
          </div>
        </SectionBox>

        <SectionBox
          hidden={groupSection !== 'storage'}
          icon={<HardDrive className="h-4 w-4" />}
          title={tr('临时存储盘与持久化卷', 'Ephemeral Disk & Volumes')}
          description={tr('临时盘随 Allocation 保留本地数据；宿主机/CSI 卷可用于跨调度持久化', 'Ephemeral disk stays per Allocation; host/CSI volumes persist across allocations')}
          actions={
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-500">{tr('临时盘', 'Ephemeral')}</span>
              <Switch
                label={tr('启用临时存储盘', 'Enable ephemeral disk')}
                disabled={readOnly}
                checked={Boolean(diskBlk)}
                onChange={(checked) => commit(setGroupEphemeralDisk(document, gPath, checked))}
              />
            </div>
          }
        >
          {diskBlk && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 items-center rounded-lg border border-slate-200/80 bg-slate-50/50 p-3 dark:border-slate-800 dark:bg-slate-950/30">
              <Input
                label={tr('临时盘大小 (MiB)', 'Disk Size (MiB)')}
                type="number"
                min={64}
                disabled={readOnly}
                value={String(parseLiteralNumber(getAttrExpr(document, diskBlk.path, 'size')) ?? 300)}
                onChange={(e) => commit(setGroupEphemeralDisk(document, gPath, true, { size: Number(e.target.value) || 300 }))}
              />
              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer pt-4">
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={parseLiteralBool(getAttrExpr(document, diskBlk.path, 'sticky')) ?? false}
                  onChange={(e) => commit(setGroupEphemeralDisk(document, gPath, true, { sticky: e.target.checked }))}
                />
                <span>{tr('尽量保留在原节点 (sticky)', 'Prefer same node (sticky)')}</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer pt-4">
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={parseLiteralBool(getAttrExpr(document, diskBlk.path, 'migrate')) ?? false}
                  onChange={(e) => commit(setGroupEphemeralDisk(document, gPath, true, { migrate: e.target.checked }))}
                />
                <span>{tr('允许跨节点迁移数据 (migrate)', 'Allow cross-node migrate (migrate)')}</span>
              </label>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{tr(`声明持久化卷 (volume · ${volumes.length})`, `Persistent Volumes (volume · ${volumes.length})`)}</span>
              {!readOnly && (
                <Button size="sm" onClick={() => commit(addGroupVolume(document, gPath, { source: knownHostVolumes[0] || 'data' }))}>
                  <Plus className="h-3.5 w-3.5" />
                  <span>{tr('声明卷', 'Add Volume')}</span>
                </Button>
              )}
            </div>
            {volumes.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-[11px] text-slate-400 dark:border-slate-800">
                {tr('暂未声明 volume 块。若需挂载宿主机目录（host）或外部存储（csi），点击右上角「声明卷」后即可在 Task 的 ', 'No volumes declared. Click "Add Volume" for host paths or CSI storage, then mount via ')}<code className="font-mono">volume_mount</code>{tr(' 中引用。', ' in a Task.')}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="hidden sm:grid sm:grid-cols-[1fr_95px_1.2fr_auto_auto] gap-2 px-2 text-[11px] text-slate-500">
                  <span>{tr('卷本地名 (label)', 'Local Name (label)')}</span>
                  <span>{tr('类型', 'Type')}</span>
                  <span>{tr('来源 (source)', 'Source')}</span>
                  <span>{tr('权限', 'Access')}</span>
                  <span className="w-7" />
                </div>
                {volumes.map((v) => {
                  const vType = parseLiteralString(getAttrExpr(document, v.path, 'type')) || 'host';
                  const vSource = parseLiteralString(getAttrExpr(document, v.path, 'source')) || '';
                  const vRo = parseLiteralBool(getAttrExpr(document, v.path, 'read_only')) ?? false;
                  const vAttach = parseLiteralString(getAttrExpr(document, v.path, 'attachment_mode')) || 'file-system';
                  const vAccess = parseLiteralString(getAttrExpr(document, v.path, 'access_mode')) || 'single-node-writer';
                  const trimmedSource = vSource.trim();
                  const hostVolNodes = vType === 'host' && trimmedSource ? options.host_volumes?.[trimmedSource] || [] : [];
                  const validHostVolName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(trimmedSource);
                  return (
                    <div key={v.path.join('.')} className="space-y-2 rounded-lg border border-slate-200/80 bg-slate-50/50 p-2 dark:border-slate-800 dark:bg-slate-950/30">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_95px_1.2fr_auto_auto] items-center">
                        <input
                          aria-label={tr('卷本地名称', 'Volume local name')}
                          disabled={readOnly}
                          value={v.label}
                          placeholder="data"
                          onChange={(e) => commit(setBlockLabel(document, v.path, e.target.value))}
                          className="min-w-0 rounded-lg border border-[#dce3ee] bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                        />
                        <Select
                          aria-label={tr('卷类型', 'Volume type')}
                          size="sm"
                          disabled={readOnly}
                          value={vType}
                          onChange={(e) => {
                            const nextType = e.target.value;
                            let nextDoc = setAttrExpr(document, v.path, 'type', JSON.stringify(nextType));
                            if (nextType === 'csi') {
                              if (!getAttrExpr(nextDoc, v.path, 'attachment_mode')) {
                                nextDoc = setAttrExpr(nextDoc, v.path, 'attachment_mode', '"file-system"');
                              }
                              if (!getAttrExpr(nextDoc, v.path, 'access_mode')) {
                                nextDoc = setAttrExpr(nextDoc, v.path, 'access_mode', '"single-node-writer"');
                              }
                            } else {
                              nextDoc = setAttrExpr(nextDoc, v.path, 'attachment_mode', null);
                              nextDoc = setAttrExpr(nextDoc, v.path, 'access_mode', null);
                            }
                            commit(nextDoc);
                          }}
                        >
                          <option value="host">host</option>
                          <option value="csi">csi</option>
                        </Select>
                        <input
                          aria-label={tr('卷来源名称', 'Volume source')}
                          list="vb-host-volumes"
                          disabled={readOnly}
                          value={vSource}
                          placeholder={vType === 'csi' ? tr('CSI 卷 ID', 'CSI volume ID') : tr('宿主机 host_volume 名', 'Host host_volume name')}
                          onChange={(e) => commit(setAttrExpr(document, v.path, 'source', JSON.stringify(e.target.value)))}
                          className="min-w-0 rounded-lg border border-[#dce3ee] bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                        />
                        <label className="inline-flex items-center gap-1 text-[11px] text-slate-600 dark:text-slate-300 px-1 whitespace-nowrap">
                          <input
                            type="checkbox"
                            disabled={readOnly}
                            checked={vRo}
                            onChange={(e) => commit(setAttrExpr(document, v.path, 'read_only', e.target.checked ? 'true' : 'false'))}
                          />
                          {tr('只读', 'Read-only')}
                        </label>
                        {!readOnly && (
                          <button
                            type="button"
                            aria-label={tr(`删除卷 ${v.label}`, `Delete volume ${v.label}`)}
                            onClick={() => commit(removeNodeAtPath(document, v.path))}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      {vType === 'host' && trimmedSource && (
                        hostVolNodes.length > 0 ? (
                          <div className="flex items-center gap-1.5 px-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                            <Check className="h-3 w-3 shrink-0" />
                            <span>{tr(`已在节点 ${hostVolNodes.join('、')} 就绪`, `Ready on nodes: ${hostVolNodes.join(', ')}`)}</span>
                          </div>
                        ) : validHostVolName ? (
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200/80 bg-amber-50/70 px-2.5 py-1.5 text-[11px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                            <span>
                              {tr('当前集群暂无 Host Volume ', 'Host Volume not found in cluster: ')}<code className="font-mono font-semibold">{trimmedSource}</code>
                            </span>
                            {!readOnly && (
                              <Button
                                size="sm"
                                type="button"
                                onClick={() => setCreateHostVol({ name: trimmedSource, readOnly: vRo })}
                              >
                                <Plus className="h-3 w-3" />
                                <span>{tr('在节点创建', 'Create on Node')}</span>
                              </Button>
                            )}
                          </div>
                        ) : (
                          <div className="px-1 text-[11px] text-amber-700 dark:text-amber-300">
                            {tr('Host Volume 名称需以字母或数字开头，仅支持字母、数字、下划线和连字符', 'Host Volume name must start with alphanumeric and contain only letters, digits, _ or -')}
                          </div>
                        )
                      )}
                      {vType === 'csi' && (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 border-t border-slate-200/70 pt-2 dark:border-slate-800">
                          <Select
                            label={tr('CSI 挂载模式 (attachment_mode)', 'CSI Attachment Mode')}
                            size="sm"
                            disabled={readOnly}
                            value={vAttach}
                            onChange={(e) => commit(setAttrExpr(document, v.path, 'attachment_mode', JSON.stringify(e.target.value)))}
                          >
                            <option value="file-system">{tr('file-system（文件系统）', 'file-system')}</option>
                            <option value="block-device">{tr('block-device（裸块设备）', 'block-device')}</option>
                          </Select>
                          <Select
                            label={tr('CSI 访问模式 (access_mode)', 'CSI Access Mode')}
                            size="sm"
                            disabled={readOnly}
                            value={vAccess}
                            onChange={(e) => commit(setAttrExpr(document, v.path, 'access_mode', JSON.stringify(e.target.value)))}
                          >
                            <option value="single-node-writer">single-node-writer</option>
                            <option value="single-node-reader-only">single-node-reader-only</option>
                            <option value="multi-node-reader-only">multi-node-reader-only</option>
                            <option value="multi-node-single-writer">multi-node-single-writer</option>
                            <option value="multi-node-multi-writer">multi-node-multi-writer</option>
                          </Select>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {knownHostVolumes.length > 0 && (
              <datalist id="vb-host-volumes">
                {knownHostVolumes.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            )}
          </div>
        </SectionBox>

        <SectionBox
          hidden={groupSection !== 'network'}
          icon={<Shield className="h-4 w-4" />}
          title={tr(`服务发现与健康检查 (service · ${services.length})`, `Service Discovery & Health Checks (service · ${services.length})`)}
          description={tr('推荐在任务组级注册服务（Nomad 原生服务发现或 Consul），支持标签与 HTTP / TCP 探活', 'Register group-level services (Nomad or Consul) with tags and HTTP/TCP checks')}
          actions={
            !readOnly && (
              <Button
                size="sm"
                onClick={() => openServiceForm(gPath, gPath, grpName || 'my-service')}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{tr('注册服务', 'Register Service')}</span>
              </Button>
            )
          }
        >
          {renderServiceCards(services, ports, tr('未注册服务。如需服务发现或自动健康探测，点击「注册服务」。', 'No services registered. Click "Register Service" to enable discovery and health checks.'))}
        </SectionBox>

        <SectionBox
          hidden={groupSection !== 'advanced'}
          icon={<RefreshCw className="h-4 w-4" />}
          title={tr('故障重启策略 (restart)', 'Restart Policy (restart)')}
          description={tr('任务意外退出时在同一节点上的自动重启策略', 'Automatic task restart policy on the same node after unexpected exit')}
          actions={
            <Switch
              label={tr('自定义故障重启策略', 'Custom restart policy')}
              disabled={readOnly}
              checked={Boolean(restartBlk)}
              onChange={(checked) => commit(setGroupRestart(document, gPath, checked))}
            />
          }
        >
          {restartBlk && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Input
                label={tr('重试次数 (attempts)', 'Attempts')}
                type="number"
                min={0}
                disabled={readOnly}
                value={String(parseLiteralNumber(getAttrExpr(document, restartBlk.path, 'attempts')) ?? 3)}
                onChange={(e) => commit(setGroupRestart(document, gPath, true, { attempts: Number(e.target.value) || 0 }))}
              />
              <Input
                label={tr('统计窗口 (interval)', 'Interval')}
                disabled={readOnly}
                value={parseLiteralString(getAttrExpr(document, restartBlk.path, 'interval')) || '10m'}
                onChange={(e) => commit(setGroupRestart(document, gPath, true, { interval: e.target.value }))}
              />
              <Input
                label={tr('重试延迟 (delay)', 'Delay')}
                disabled={readOnly}
                value={parseLiteralString(getAttrExpr(document, restartBlk.path, 'delay')) || '15s'}
                onChange={(e) => commit(setGroupRestart(document, gPath, true, { delay: e.target.value }))}
              />
              <Select
                label={tr('超限行为 (mode)', 'Mode')}
                size="sm"
                disabled={readOnly}
                value={parseLiteralString(getAttrExpr(document, restartBlk.path, 'mode')) || 'delay'}
                onChange={(e) => commit(setGroupRestart(document, gPath, true, { mode: e.target.value }))}
              >
                <option value="delay">{tr('delay（延迟重试）', 'delay (retry after delay)')}</option>
                <option value="fail">{tr('fail（停止重试）', 'fail (stop retrying)')}</option>
              </Select>
            </div>
          )}
        </SectionBox>

        {groupSection === 'advanced' && unhandled.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/80 bg-slate-50/70 px-3.5 py-2.5 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
            <span>{tr('已无损保留其他任务组块：', 'Preserved extra group blocks:')}</span>
            {unhandled.map((blk) => (
              <button
                key={blk.path.join('.')}
                type="button"
                onClick={() => jumpToTreePath(blk.path)}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 font-mono text-indigo-600 hover:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-indigo-300"
              >
                <span>{blk.name}{blk.label ? ` "${blk.label}"` : ''}</span>
                <ChevronRight className="h-3 w-3" />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderServiceCards = (
    services: ReturnType<typeof listChildBlocks>,
    ports: ReturnType<typeof listGroupPorts>,
    emptyText: string,
  ) => {
    if (services.length === 0) {
      return <div className="text-[11px] text-slate-400">{emptyText}</div>;
    }
    const serviceAddressModes = ENUM_VALUES['Service.address_mode'];
    const checkAddressModes = ENUM_VALUES['ServiceCheck.address_mode'];
    return (
      <div className="space-y-3">
        {services.map((svc) => {
          const svcName = parseLiteralString(getAttrExpr(document, svc.path, 'name')) || '';
          const provider = parseLiteralString(getAttrExpr(document, svc.path, 'provider')) || 'nomad';
          const addrExpr = getAttrExpr(document, svc.path, 'address_mode');
          const addrLiteral = parseLiteralString(addrExpr);
          const addrDynamic = addrExpr !== undefined && addrLiteral === undefined;
          const addressMode = addrLiteral || '';
          const portRef = parseLiteralString(getAttrExpr(document, svc.path, 'port')) || '';
          const tags = parseLiteralStringList(getAttrExpr(document, svc.path, 'tags')) || [];
          const checks = listChildBlocks(document, svc.path, 'check');
          return (
            <div
              key={svc.path.join('.')}
              className="space-y-2.5 rounded-xl border border-slate-200/80 bg-slate-50/40 p-3 dark:border-slate-800 dark:bg-slate-950/30"
            >
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1.1fr)_100px_130px_minmax(0,1fr)_auto] items-end">
                <Input
                  label={tr('服务名 (name)', 'Service Name (name)')}
                  disabled={readOnly}
                  value={svcName}
                  onChange={(e) => commit(setAttrExpr(document, svc.path, 'name', JSON.stringify(e.target.value)))}
                />
                <Select
                  label={tr('注册中心', 'Provider')}
                  size="sm"
                  disabled={readOnly}
                  value={provider}
                  onChange={(e) => commit(setAttrExpr(document, svc.path, 'provider', JSON.stringify(e.target.value)))}
                >
                  <option value="nomad">nomad</option>
                  <option value="consul">consul</option>
                </Select>
                <Select
                  label={tr('地址模式', 'Address Mode')}
                  size="sm"
                  disabled={readOnly || addrDynamic}
                  value={addrDynamic ? '__dynamic__' : addressMode}
                  onChange={(e) => commit(setAttrExpr(document, svc.path, 'address_mode', e.target.value ? JSON.stringify(e.target.value) : null))}
                >
                  {addrDynamic ? (
                    <option value="__dynamic__">{tr('动态表达式', 'Expression')}</option>
                  ) : (
                    <>
                      <option value="">{tr('默认 (auto)', 'Default (auto)')}</option>
                      {Array.from(new Set([...serviceAddressModes, ...(addressMode ? [addressMode] : [])])).map((mode) => (
                        <option key={mode} value={mode}>
                          {mode}
                        </option>
                      ))}
                    </>
                  )}
                </Select>
                <Select
                  label={tr('绑定端口', 'Port')}
                  size="sm"
                  disabled={readOnly}
                  value={portRef}
                  onChange={(e) => commit(setAttrExpr(document, svc.path, 'port', e.target.value ? JSON.stringify(e.target.value) : null))}
                >
                  <option value="">{tr('不指定端口', 'No port')}</option>
                  {Array.from(new Set([...ports.map((p) => p.label), ...(portRef ? [portRef] : [])])).map((pl) => (
                    <option key={pl} value={pl}>
                      {pl}
                    </option>
                  ))}
                </Select>
                {!readOnly && (
                  <Button size="sm" variant="danger-outline" onClick={() => commit(removeNodeAtPath(document, svc.path))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>

              <Input
                label={tr('服务标签 (tags，逗号分隔，可选)', 'Tags (comma-separated, optional)')}
                disabled={readOnly}
                value={tags.join(', ')}
                placeholder={tr('例如 prod, traefik.enable=true', 'e.g. prod, traefik.enable=true')}
                onChange={(e) => {
                  const next = e.target.value
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean);
                  commit(setAttrExpr(document, svc.path, 'tags', next.length > 0 ? JSON.stringify(next) : null));
                }}
              />

              <div className="space-y-1.5 border-t border-slate-200/70 pt-2 dark:border-slate-800">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300">{tr(`健康检查 (check · ${checks.length})`, `Health Checks (check · ${checks.length})`)}</span>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => commit(addServiceCheck(document, svc.path))}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      <Plus className="h-3 w-3" />
                      {tr('添加探活', 'Add Check')}
                    </button>
                  )}
                </div>
                {checks.map((chk) => {
                  const cType = parseLiteralString(getAttrExpr(document, chk.path, 'type')) || 'http';
                  const cPath = parseLiteralString(getAttrExpr(document, chk.path, 'path')) || '/';
                  const cAddrExpr = getAttrExpr(document, chk.path, 'address_mode');
                  const cAddrLiteral = parseLiteralString(cAddrExpr);
                  const cAddrDynamic = cAddrExpr !== undefined && cAddrLiteral === undefined;
                  const cAddressMode = cAddrLiteral || '';
                  const cInterval = parseLiteralString(getAttrExpr(document, chk.path, 'interval')) || '10s';
                  const cTimeout = parseLiteralString(getAttrExpr(document, chk.path, 'timeout')) || '2s';
                  return (
                    <div key={chk.path.join('.')} className="grid grid-cols-2 gap-1.5 sm:grid-cols-[90px_1fr_110px_80px_80px_auto] items-center">
                      <Select
                        aria-label={tr('检查类型', 'Check type')}
                        size="sm"
                        disabled={readOnly}
                        value={cType}
                        onChange={(e) => commit(setAttrExpr(document, chk.path, 'type', JSON.stringify(e.target.value)))}
                      >
                        <option value="http">http</option>
                        <option value="tcp">tcp</option>
                        <option value="grpc">grpc</option>
                        <option value="script">script</option>
                      </Select>
                      <input
                        aria-label={tr('HTTP 路径', 'HTTP path')}
                        disabled={readOnly || cType !== 'http'}
                        value={cType === 'http' ? cPath : ''}
                        placeholder={cType === 'http' ? '/health' : tr('无需路径', 'N/A')}
                        onChange={(e) => commit(setAttrExpr(document, chk.path, 'path', JSON.stringify(e.target.value)))}
                        className="min-w-0 rounded-lg border border-[#dce3ee] bg-white px-2 py-1.5 font-mono text-xs disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900"
                      />
                      <Select
                        aria-label={tr('检查地址模式 (address_mode)', 'Check address_mode')}
                        size="sm"
                        disabled={readOnly || cAddrDynamic}
                        value={cAddrDynamic ? '__dynamic__' : cAddressMode}
                        onChange={(e) => commit(setAttrExpr(document, chk.path, 'address_mode', e.target.value ? JSON.stringify(e.target.value) : null))}
                      >
                        {cAddrDynamic ? (
                          <option value="__dynamic__">{tr('动态表达式', 'Expression')}</option>
                        ) : (
                          <>
                            <option value="">{tr('地址: 默认', 'Addr: default')}</option>
                            {Array.from(new Set([...checkAddressModes, ...(cAddressMode ? [cAddressMode] : [])])).map((mode) => (
                              <option key={mode} value={mode}>
                                {mode}
                              </option>
                            ))}
                          </>
                        )}
                      </Select>
                      <input
                        aria-label={tr('检查间隔', 'Interval')}
                        disabled={readOnly}
                        value={cInterval}
                        placeholder="10s"
                        onChange={(e) => commit(setAttrExpr(document, chk.path, 'interval', JSON.stringify(e.target.value)))}
                        className="min-w-0 rounded-lg border border-[#dce3ee] bg-white px-2 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                      />
                      <input
                        aria-label={tr('超时时间', 'Timeout')}
                        disabled={readOnly}
                        value={cTimeout}
                        placeholder="2s"
                        onChange={(e) => commit(setAttrExpr(document, chk.path, 'timeout', JSON.stringify(e.target.value)))}
                        className="min-w-0 rounded-lg border border-[#dce3ee] bg-white px-2 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                      />
                      {!readOnly && (
                        <button
                          type="button"
                          aria-label={tr('删除健康检查', 'Delete check')}
                          onClick={() => commit(removeNodeAtPath(document, chk.path))}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderTaskForm = (tPath: NodePath, gPath: NodePath) => {
    const taskNode = nodeAt(document, tPath)!;
    const taskName = taskNode.labels?.[0] || '';
    const parentGroup = nodeAt(document, gPath);
    const parentGroupName = parentGroup?.labels?.[0] || 'group';
    const siblingTasks = listChildBlocks(document, gPath, 'task');

    const driver = parseLiteralString(getAttrExpr(document, tPath, 'driver')) || 'docker';
    const availableDrivers = Array.from(new Set(['docker', 'exec', 'raw_exec', ...options.drivers, driver]));
    const healthyDrivers = new Set(options.drivers);

    const cfgBlk = findChildBlock(document, tPath, 'config');
    const cfgBody = cfgBlk?.node.body;
    const dockerImage = parseLiteralString(getAttrNode(cfgBody, 'image')?.expression) || '';
    const dockerPortExpression = getAttrNode(cfgBody, 'ports')?.expression;
    const dockerPortList = parseLiteralStringList(dockerPortExpression);
    const dockerPorts = dockerPortList || [];
    const editableDockerPorts = dockerPortExpression === undefined || dockerPortList !== undefined;
    const dockerVolumes = parseLiteralStringList(getAttrNode(cfgBody, 'volumes')?.expression) || [];
    const dockerEntrypoint = parseLiteralStringList(getAttrNode(cfgBody, 'entrypoint')?.expression) || [];
    const dockerCommand = parseLiteralString(getAttrNode(cfgBody, 'command')?.expression) || '';
    const dockerArgs = parseLiteralStringList(getAttrNode(cfgBody, 'args')?.expression) || [];
    const dockerForcePull = parseLiteralBool(getAttrNode(cfgBody, 'force_pull')?.expression) ?? false;
    const dockerPrivileged = parseLiteralBool(getAttrNode(cfgBody, 'privileged')?.expression) ?? false;

    const groupPorts = listGroupPorts(document, gPath);
    const groupVolumes = listChildBlocks(document, gPath, 'volume');

    const resBlk = findChildBlock(document, tPath, 'resources');
    const cpu = parseLiteralNumber(resBlk ? getAttrExpr(document, resBlk.path, 'cpu') : undefined);
    const mem = parseLiteralNumber(resBlk ? getAttrExpr(document, resBlk.path, 'memory') : undefined);
    const memMax = parseLiteralNumber(resBlk ? getAttrExpr(document, resBlk.path, 'memory_max') : undefined);

    const envState = listTaskEnvRows(document, tPath);
    const vaultBlk = findChildBlock(document, tPath, 'vault');
    const vaultRoleVal = vaultBlk ? parseLiteralString(getAttrExpr(document, vaultBlk.path, 'role')) || '' : '';
    const vaultEnvVal = vaultBlk ? parseLiteralBool(getAttrExpr(document, vaultBlk.path, 'env')) ?? false : false;
    const templates = listChildBlocks(document, tPath, 'template');
    const volumeMounts = listChildBlocks(document, tPath, 'volume_mount');
    const taskServices = listChildBlocks(document, tPath, 'service');
    const unhandled = listUnhandledBlocks(document, tPath, TASK_HANDLED_BLOCKS);

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-1 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2 min-w-0">
            <span className="rounded-lg bg-emerald-50 p-1.5 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
              {driver === 'exec' || driver === 'raw_exec' ? (
                <SquareTerminal className="h-4 w-4" />
              ) : (
                <Container className="h-4 w-4" />
              )}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-[11px] text-slate-400">
                <button type="button" onClick={() => jobPath && selectInForm(jobPath)} className="hover:text-indigo-600">
                  Job
                </button>
                <ChevronRight className="h-3 w-3" />
                <button type="button" onClick={() => selectInForm(gPath)} className="hover:text-indigo-600">
                  {parentGroupName}
                </button>
                <ChevronRight className="h-3 w-3" />
                <span>{tr('任务', 'Task')}</span>
              </div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                {taskName || tr('未命名任务', 'Unnamed Task')}
              </div>
            </div>
          </div>
          {!readOnly && (
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                title={tr('复制当前任务', 'Duplicate task')}
                onClick={() => {
                  try {
                    const next = duplicateBlock(document, tPath, schema);
                    commit(next.document, next.path);
                  } catch (ex: any) {
                    setError(ex.message);
                  }
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                <span>{tr('复制', 'Duplicate')}</span>
              </Button>
              {siblingTasks.length > 1 && (
                <Button
                  size="sm"
                  variant="danger-outline"
                  onClick={() => commit(removeNodeAtPath(document, tPath), gPath)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{tr('删除', 'Delete')}</span>
                </Button>
              )}
            </div>
          )}
        </div>

        {renderFormSections('task')}

        {/* 1. Identity & Driver */}
        <SectionBox hidden={taskSection !== 'base'} icon={<Container className="h-4 w-4" />} title={tr('任务标识与运行环境', 'Task Identity & Driver')}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label={tr('任务名称 (task)', 'Task Name (task)')}
              disabled={readOnly}
              value={taskName}
              placeholder={tr('例如 server', 'e.g. server')}
              onChange={(e) => commit(setBlockLabel(document, tPath, e.target.value))}
            />
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-slate-700 dark:text-slate-300">{tr('运行驱动 (driver)', 'Task Driver (driver)')}</div>
              <div className="flex flex-wrap gap-1.5">
                {availableDrivers.map((d) => {
                  const active = driver === d;
                  const ready = healthyDrivers.has(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      disabled={readOnly}
                      title={ready ? tr('当前集群已检测到此驱动就绪', 'Driver is healthy on this cluster') : undefined}
                      onClick={() => commit(setTaskDriver(document, tPath, d))}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-xs transition ${
                        active
                          ? 'border-indigo-500 bg-indigo-600 text-white'
                          : 'border-slate-200 bg-white text-slate-700 hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
                      }`}
                    >
                      {ready && (
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-emerald-300' : 'bg-emerald-500'}`}
                          aria-hidden="true"
                        />
                      )}
                      <span>{d}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Driver-specific configuration */}
          {driver === 'docker' ? (
            <div className="space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
              <div className="space-y-1.5">
                <Input
                  label={tr('Docker 镜像 (image)', 'Docker Image (image)')}
                  data-builder-field="image"
                  disabled={readOnly}
                  value={dockerImage}
                  placeholder={tr('例如 nginx:alpine 或 postgres:17-bookworm', 'e.g. nginx:alpine or postgres:17-bookworm')}
                  onChange={(e) =>
                    commit(setTaskConfigAttr(document, tPath, 'image', JSON.stringify(e.target.value)))
                  }
                />
                {!readOnly && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-slate-400">{tr('常用镜像：', 'Popular images:')}</span>
                    {QUICK_DOCKER_IMAGES.map((img) => (
                      <button
                        key={img}
                        type="button"
                        onClick={() => commit(setTaskConfigAttr(document, tPath, 'image', JSON.stringify(img)))}
                        className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[11px] text-slate-600 hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                      >
                        {img}
                      </button>
                    ))}
                  </div>
                )}
              </div>

            </div>
          ) : driver === 'exec' || driver === 'raw_exec' ? (
            <div className="space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
              <Input
                label={tr('可执行程序路径 (command)', 'Executable Path (command)')}
                disabled={readOnly}
                value={dockerCommand}
                placeholder="/bin/sh"
                onChange={(e) =>
                  commit(setTaskConfigAttr(document, tPath, 'command', JSON.stringify(e.target.value)))
                }
              />
              <StringListEditor
                label={tr('命令行参数 (args)', 'Command Arguments (args)')}
                placeholder="-c"
                items={dockerArgs}
                disabled={readOnly}
                onChange={(next) =>
                  commit(setTaskConfigAttr(document, tPath, 'args', next.length ? JSON.stringify(next) : null))
                }
              />
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
              <span>{tr('当前使用自定义驱动 ', 'Using custom driver ')}<code className="font-mono font-semibold">{driver}</code>{tr('，可在高级结构树中编辑驱动专有字段。', '; edit driver-specific fields in the AST Tree view.')}</span>
              <Button size="sm" onClick={() => cfgBlk ? jumpToTreePath(cfgBlk.path) : jumpToTreePath(tPath)}>
                {tr('编辑 config', 'Edit config')}
              </Button>
            </div>
          )}
        </SectionBox>

        {/* Task Resources */}
        <SectionBox
          hidden={taskSection !== 'base'}
          icon={<Cpu className="h-4 w-4" />}
          title={tr('计算资源配额 (resources)', 'Compute Resources (resources)')}
          description={tr('Nomad 会依据配额自动寻找剩余算力足够的 Client 节点', 'Nomad schedules tasks onto Client nodes matching these resource limits')}
        >
          {!readOnly && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {RESOURCE_PRESETS.map((p) => {
                const active = cpu === p.cpu && mem === p.memory;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => commit(setTaskResources(document, tPath, { cpu: p.cpu, memory: p.memory }))}
                    className={`rounded-xl border px-3 py-2 text-left transition ${
                      active
                        ? 'border-indigo-500 bg-indigo-50/70 ring-1 ring-indigo-500/20 dark:border-indigo-400 dark:bg-indigo-500/15'
                        : 'border-slate-200 bg-slate-50/50 hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-950/30'
                    }`}
                  >
                    <div className="font-semibold text-slate-900 dark:text-slate-100">{isEn ? p.labelEn : p.label}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-slate-500 dark:text-slate-400">{p.hint}</div>
                  </button>
                );
              })}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 items-end">
            <Input
              label={tr('CPU 配额 (MHz)', 'CPU (MHz)')}
              type="number"
              min={20}
              step={50}
              disabled={readOnly}
              value={cpu !== undefined ? String(cpu) : ''}
              placeholder="100"
              onChange={(e) => commit(setTaskResources(document, tPath, { cpu: e.target.value ? Number(e.target.value) : null }))}
            />
            <Input
              label={tr('内存配额 (MiB)', 'Memory (MiB)')}
              type="number"
              min={16}
              step={32}
              disabled={readOnly}
              value={mem !== undefined ? String(mem) : ''}
              placeholder="128"
              onChange={(e) => commit(setTaskResources(document, tPath, { memory: e.target.value ? Number(e.target.value) : null }))}
            />
            <Input
              label={tr('突发内存上限 (MiB)', 'Max Memory (MiB)')}
              type="number"
              min={16}
              step={64}
              disabled={readOnly}
              value={memMax !== undefined ? String(memMax) : ''}
              placeholder={tr('可选', 'Optional')}
              onChange={(e) =>
                commit(setTaskResources(document, tPath, { memoryMax: e.target.value ? Number(e.target.value) : null }))
              }
            />
          </div>
        </SectionBox>

        {/* 2. Environment Variables */}
        {driver === 'docker' && (
          <SectionBox
            hidden={taskSection !== 'network'}
            icon={<Network className="h-4 w-4" />}
            title={tr('容器端口', 'Container Ports')}
            actions={!readOnly && editableDockerPorts && (
              <Button size="sm" onClick={() => {
                const labels = groupPorts.map((port) => port.label);
                let label = 'http';
                let suffix = 2;
                while (labels.includes(label)) label = `http${suffix++}`;
                setQuickAdd({ form: { kind: 'port', label, labels }, path: tPath, groupPath: gPath });
              }}>
                <Plus className="h-3.5 w-3.5" />
                {tr('声明并绑定端口', 'Declare and Bind Port')}
              </Button>
            )}
          >
            {/* 1-click Group port binding */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{tr('暴露端口绑定 (config.ports)', 'Port Mapping (config.ports)')}</span>
                <button
                  type="button"
                  onClick={() => selectInForm(gPath, 'network')}
                  className="text-[11px] font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {tr('管理任务组端口', 'Manage Group Ports')}
                </button>
              </div>
              {!editableDockerPorts ? (
                <p className="text-xs text-slate-500">{tr('端口列表使用 HCL 表达式，可在高级结构树中编辑。', 'The port list uses an HCL expression. Edit it in AST Tree.')}</p>
              ) : groupPorts.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-[11px] text-slate-400 dark:border-slate-800">
                  {tr('所属任务组暂未声明端口。', 'No ports have been declared in this group.')}
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {groupPorts.map((p) => {
                    const bound = dockerPorts.includes(p.label);
                    return (
                      <button
                        key={p.path.join('.')}
                        type="button"
                        disabled={readOnly || !editableDockerPorts}
                        aria-pressed={bound}
                        onClick={() => commit(toggleTaskDockerPort(document, tPath, p.label))}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-xs transition ${
                          bound
                            ? 'border-indigo-500 bg-indigo-50 text-indigo-700 font-semibold dark:bg-indigo-500/20 dark:text-indigo-200'
                            : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
                        }`}
                      >
                        {bound && <Check className="h-3 w-3" />}
                        <span>{p.label}</span>
                        {(p.staticPort || p.toPort) && (
                          <span className="text-[10px] opacity-75">
                            ({p.staticPort || tr('动态', 'dynamic')}→{p.toPort || p.staticPort || tr('自动', 'auto')})
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </SectionBox>
        )}

        {driver === 'docker' && (
          <SectionBox hidden={taskSection !== 'storage'} icon={<HardDrive className="h-4 w-4" />} title={tr('容器目录挂载', 'Container Bind Mounts')}>
            <StringListEditor
              label={tr('容器目录挂载 (volumes)', 'Container Bind Mounts (volumes)')}
              hint={tr('如 local/pgdata:/var/lib/postgresql/data', 'e.g. local/pgdata:/var/lib/postgresql/data')}
              placeholder="local/data:/var/lib/data"
              items={dockerVolumes}
              disabled={readOnly}
              onChange={(next) =>
                commit(
                  setTaskConfigAttr(
                    document,
                    tPath,
                    'volumes',
                    next.length > 0 ? JSON.stringify(next) : null,
                  ),
                )
              }
            />
          </SectionBox>
        )}

        <SectionBox
          hidden={taskSection !== 'secrets'}
          icon={<Code2 className="h-4 w-4" />}
          title={tr(`环境变量 (env · ${envState.rows.length})`, `Environment Variables (env · ${envState.rows.length})`)}
          description={tr('注入普通明文配置；密码与密钥建议通过下方 Vault 模板动态注入', 'Inject non-sensitive config; use Vault templates below for secrets')}
          actions={
            !readOnly && envState.mode !== 'attribute' && (
              <Button size="sm" onClick={() => commit(addTaskEnvRow(document, tPath))}>
                <Plus className="h-3.5 w-3.5" />
                <span>{tr('添加变量', 'Add Variable')}</span>
              </Button>
            )
          }
        >
          {envState.mode === 'attribute' ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
              <span>{tr('当前 ', 'Current ')}<code className="font-mono">env</code>{tr(' 使用原生 HCL 表达式，已无损保留。', ' uses a raw HCL expression and is preserved.')}</span>
              <Button size="sm" onClick={() => jumpToTreePath(tPath)}>
                {tr('在结构树编辑', 'Edit in AST Tree')}
              </Button>
            </div>
          ) : envState.rows.length === 0 ? (
            <div className="text-[11px] text-slate-400">{tr('暂无环境变量。', 'No environment variables configured.')}</div>
          ) : (
            <div className="space-y-2">
              {envState.rows.map((row) => (
                <div
                  key={row.path.join('.')}
                  className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1.4fr_auto] items-center rounded-lg border border-slate-200/80 bg-slate-50/50 p-2 dark:border-slate-800 dark:bg-slate-950/30"
                >
                  <input
                    aria-label={tr('环境变量名', 'Env key')}
                    disabled={readOnly}
                    value={row.key}
                    placeholder="KEY"
                    onChange={(e) => commit(updateTaskEnvRow(document, row.path, { key: e.target.value }))}
                    className="rounded-lg border border-[#dce3ee] bg-white px-2.5 py-1.5 font-mono text-xs font-medium dark:border-slate-700 dark:bg-slate-900"
                  />
                  <input
                    aria-label={tr('环境变量值', 'Env value')}
                    disabled={readOnly}
                    value={row.value}
                    placeholder="VALUE"
                    onChange={(e) =>
                      commit(updateTaskEnvRow(document, row.path, { value: e.target.value, raw: row.isRawExpression }))
                    }
                    className="rounded-lg border border-[#dce3ee] bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                  {!readOnly && (
                    <button
                      type="button"
                      aria-label={tr(`删除环境变量 ${row.key}`, `Delete env ${row.key}`)}
                      onClick={() => commit(removeNodeAtPath(document, row.path))}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </SectionBox>

        {/* 4. Vault Secret & Templates */}
        <SectionBox
          hidden={taskSection !== 'secrets'}
          icon={<KeyRound className="h-4 w-4" />}
          title={tr(`Vault 密钥与渲染模板 (template · ${templates.length})`, `Vault Secrets & Templates (template · ${templates.length})`)}
          description={tr('绑定 Nomad-Vault 联动 Role 并渲染 0600 密码文件或动态环境变量，避免明文密码', 'Bind a Nomad-Vault role to render 0600 secret files or dynamic env vars')}
          actions={
            !readOnly && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  onClick={() => {
                    if (!vaultBlk) {
                      setShowVaultWizardInline(false);
                      toast.error(tr('请先在下方绑定 Vault 身份 (vault.role)，再接入 Vault 密钥', 'Please bind a Vault identity (vault.role) below before adding Vault secrets'));
                      vaultRoleInputRef.current?.focus();
                      return;
                    }
                    setShowVaultWizardInline((v) => {
                      const next = !v;
                      if (next) {
                        const matched = vaultRoles.find((r) => r.role === vaultRoleVal);
                        setVaultHelper((prev) => ({
                          ...prev,
                          role: vaultRoleVal || 'default',
                          secretPath: matched?.secret_paths?.[0] || prev.secretPath,
                        }));
                      }
                      return next;
                    });
                  }}
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  <span>{showVaultWizardInline && vaultBlk ? tr('收起快捷向导', 'Hide Wizard') : tr('一键接入 Vault 密钥', 'Vault Secret Wizard')}</span>
                </Button>
                <Button size="sm" onClick={() => commit(addTaskTemplateBlock(document, tPath))}>
                  <Plus className="h-3.5 w-3.5" />
                  <span>{tr('新增模板', 'Add Template')}</span>
                </Button>
              </div>
            )
          }
        >
          {/* Vault Role binding strip */}
          <div className="rounded-xl border border-slate-200/80 bg-slate-50/50 p-3 space-y-2.5 dark:border-slate-800 dark:bg-slate-950/30">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-800 dark:text-slate-100">{tr('Vault 身份绑定 (vault.role)', 'Vault Identity Binding (vault.role)')}</span>
                {vaultBlk ? <Badge tone="green">{tr('已绑定', 'Bound')} {vaultRoleVal || 'default'}</Badge> : <Badge>{tr('未绑定', 'Unbound')}</Badge>}
              </div>
              <div className="flex items-center gap-2">
                <Link to="/integrations" className="text-[11px] text-indigo-600 hover:underline dark:text-indigo-400">
                  {tr('管理联动 Role', 'Manage Roles')}
                </Link>
                {!readOnly && vaultBlk && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowVaultWizardInline(false);
                      commit(setTaskVault(document, tPath, null));
                    }}
                    className="text-[11px] text-rose-600 hover:underline dark:text-rose-400"
                  >
                    {tr('解除绑定', 'Unbind')}
                  </button>
                )}
              </div>
            </div>

            {vaultRoles.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {vaultRoles.map((vr) => {
                  const active = vaultRoleVal === vr.role && Boolean(vaultBlk);
                  return (
                    <button
                      key={`${vr.integration}:${vr.role}`}
                      type="button"
                      disabled={readOnly}
                      onClick={() => commit(setTaskVault(document, tPath, vr.role, { env: vaultEnvVal }))}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition ${
                        active
                          ? 'border-indigo-500 bg-indigo-50 text-indigo-800 font-semibold dark:bg-indigo-500/20 dark:text-indigo-200'
                          : 'border-slate-200 bg-white text-slate-700 hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
                      }`}
                    >
                      <span className="font-mono">{vr.role}</span>
                      <Badge tone={vr.status === 'applied' ? 'green' : 'amber'}>
                        {vr.status === 'applied' ? tr('已应用', 'Applied') : tr('草稿', 'Draft')}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] items-center">
              <input
                ref={vaultRoleInputRef}
                aria-label={tr('自定义 Vault Role 名称', 'Custom Vault Role name')}
                disabled={readOnly}
                value={vaultRoleVal}
                placeholder={vaultIntegrations.length === 0 ? tr('未建联动，或直接填写 Role 名', 'No integration yet, or enter role name') : tr('选择上方 Role 或手动输入', 'Pick a Role above or enter manually')}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) setShowVaultWizardInline(false);
                  commit(setTaskVault(document, tPath, v ? v : null, { env: vaultEnvVal }));
                }}
                className="rounded-lg border border-[#dce3ee] bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
              />
              {vaultBlk && (
                <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer px-1">
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={vaultEnvVal}
                    onChange={(e) => commit(setTaskVault(document, tPath, vaultRoleVal || 'default', { env: e.target.checked }))}
                  />
                  <span>{tr('向容器暴露 VAULT_TOKEN (env)', 'Expose VAULT_TOKEN env var')}</span>
                </label>
              )}
            </div>
          </div>

          {/* Inline quick Vault Secret wizard */}
          {showVaultWizardInline && !readOnly && vaultBlk && (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3.5 space-y-3 dark:border-indigo-500/30 dark:bg-indigo-950/25">
              <div className="font-semibold text-indigo-950 dark:text-indigo-100">
                {tr(`为任务「${taskName}」一键生成密钥模板（已绑定身份：${vaultRoleVal || 'default'}）`, `Generate secret template for task "${taskName}" (Bound role: ${vaultRoleVal || 'default'})`)}
              </div>
              <Input
                label={tr('Secret 路径（自动补全 /data/）', 'Secret Path (auto /data/)')}
                value={vaultHelper.secretPath}
                onChange={(e) => setVaultHelper((prev) => ({ ...prev, secretPath: e.target.value }))}
                placeholder="secret/apps/postgres"
              />
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <Select
                  label={tr('注入方式', 'Injection Mode')}
                  size="sm"
                  value={vaultHelper.mode}
                  onChange={(e) => setVaultHelper((prev) => ({ ...prev, mode: e.target.value as 'env' | 'file' }))}
                >
                  <option value="env">{tr('注入为环境变量 (env = true)', 'Environment variables (env = true)')}</option>
                  <option value="file">{tr('渲染为 0600 密码文件 (/secrets/xxx)', '0600 secret file (/secrets/xxx)')}</option>
                </Select>
                <Input
                  label={vaultHelper.mode === 'file' ? tr('提取字段名（留空输出 JSON）', 'Secret key (blank = full JSON)') : tr('提取字段名（逗号分隔，留空全量）', 'Secret keys (comma-separated, blank = all)')}
                  value={vaultHelper.keys}
                  onChange={(e) => setVaultHelper((prev) => ({ ...prev, keys: e.target.value }))}
                  placeholder={vaultHelper.mode === 'file' ? 'password' : 'username, password'}
                />
              </div>
              {vaultHelper.mode === 'file' && (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <Input
                    label={tr('容器内密码文件名（/secrets/ 下）', 'Secret filename in container (/secrets/)')}
                    value={vaultHelper.fileName}
                    onChange={(e) => setVaultHelper((prev) => ({ ...prev, fileName: e.target.value }))}
                  />
                  <Input
                    label={tr('指向该文件的环境变量名', 'Env var pointing to file')}
                    value={vaultHelper.envVarName}
                    onChange={(e) => setVaultHelper((prev) => ({ ...prev, envVarName: e.target.value }))}
                  />
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <span className="text-[11px] text-slate-600 dark:text-slate-300">
                  {tr('模板路径：', 'Template path: ')}<code className="font-mono">{parseKVPath(vaultHelper.secretPath, 'secret', locale).templatePath || 'secret/data/apps/demo'}</code>
                </span>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    const parsed = parseKVPath(vaultHelper.secretPath, 'secret', locale);
                    const keys = vaultHelper.keys
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean);
                    const templateData = buildTemplateData(parsed.templatePath, keys, vaultHelper.mode);
                    commit(
                      applyVaultToTask(document, tPath, {
                        role: vaultRoleVal || 'default',
                        templateData,
                        mode: vaultHelper.mode,
                        fileName: vaultHelper.fileName,
                        envVarName: vaultHelper.envVarName,
                        vaultEnv: vaultEnvVal,
                      }),
                    );
                    setShowVaultWizardInline(false);
                    toast.success(tr(`已为任务 ${taskName} 生成 Vault 模板`, `Generated Vault template for task ${taskName}`));
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>{tr('插入到当前任务', 'Insert into Task')}</span>
                </Button>
              </div>
            </div>
          )}

          {/* Template cards */}
          {templates.length > 0 && (
            <div className="space-y-3">
              {templates.map((tpl, idx) => {
                const dest = parseLiteralString(getAttrExpr(document, tpl.path, 'destination')) || '';
                const isEnv = parseLiteralBool(getAttrExpr(document, tpl.path, 'env')) ?? false;
                const perms = parseLiteralString(getAttrExpr(document, tpl.path, 'perms')) || '';
                const changeMode = parseLiteralString(getAttrExpr(document, tpl.path, 'change_mode')) || 'restart';
                const dataUnwrapped = unwrapHeredocOrString(getAttrExpr(document, tpl.path, 'data'));
                return (
                  <div
                    key={tpl.path.join('.')}
                    className="space-y-2.5 rounded-xl border border-slate-200/90 bg-slate-50/40 p-3 dark:border-slate-800 dark:bg-slate-950/30"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileCode2 className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
                        <span className="font-mono font-semibold text-slate-800 dark:text-slate-100 truncate">
                          {tr(`模板 #${idx + 1}`, `Template #${idx + 1}`)} · {dest || tr('未设置路径', 'No destination')}
                        </span>
                        <Badge tone={isEnv ? 'blue' : 'neutral'}>{isEnv ? tr('环境变量', 'Env') : tr(`文件 ${perms || '0644'}`, `File ${perms || '0644'}`)}</Badge>
                      </div>
                      {!readOnly && (
                        <button
                          type="button"
                          aria-label={tr(`删除模板 ${idx + 1}`, `Delete template ${idx + 1}`)}
                          onClick={() => commit(removeNodeAtPath(document, tpl.path))}
                          className="shrink-0 rounded-lg p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>

                    <Input
                      label={tr('渲染目标路径 (destination)', 'Destination (destination)')}
                      disabled={readOnly}
                      value={dest}
                      placeholder="secrets/app.env"
                      onChange={(e) => commit(updateTaskTemplateBlock(document, tpl.path, { destination: e.target.value }))}
                    />

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 items-end">
                      <Select
                        label={tr('用途模式', 'Mode')}
                        size="sm"
                        disabled={readOnly}
                        value={isEnv ? 'env' : 'file'}
                        onChange={(e) =>
                          commit(updateTaskTemplateBlock(document, tpl.path, { mode: e.target.value as 'env' | 'file' }))
                        }
                      >
                        <option value="env">{tr('注入环境变量', 'Environment variables')}</option>
                        <option value="file">{tr('渲染为文件', 'Render as file')}</option>
                      </Select>
                      <Input
                        label={tr('文件权限', 'Permissions')}
                        disabled={readOnly || isEnv}
                        value={isEnv ? '' : perms}
                        placeholder={isEnv ? tr('自动', 'Auto') : '0600'}
                        onChange={(e) => commit(updateTaskTemplateBlock(document, tpl.path, { perms: e.target.value }))}
                      />
                      <Select
                        label={tr('变更动作', 'Change Mode')}
                        size="sm"
                        disabled={readOnly}
                        value={changeMode}
                        onChange={(e) => commit(updateTaskTemplateBlock(document, tpl.path, { changeMode: e.target.value }))}
                      >
                        <option value="restart">restart</option>
                        <option value="noop">noop</option>
                        <option value="signal">signal</option>
                        <option value="script">script</option>
                      </Select>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-slate-500">
                        <span>{tr('模板正文（自动处理 HCL Heredoc 换行）', 'Template body (auto-handles HCL Heredoc newlines)')}</span>
                        {!dataUnwrapped.editable && (
                          <button
                            type="button"
                            onClick={() => jumpToTreePath(tpl.path)}
                            className="text-indigo-600 hover:underline dark:text-indigo-400"
                          >
                            {tr('在结构树编辑原生表达式', 'Edit raw expression in AST Tree')}
                          </button>
                        )}
                      </div>
                      <textarea
                        aria-label={tr(`模板 ${idx + 1} 正文`, `Template ${idx + 1} content`)}
                        rows={Math.min(10, Math.max(3, dataUnwrapped.text.split('\n').length + 1))}
                        disabled={readOnly || !dataUnwrapped.editable}
                        spellCheck={false}
                        value={dataUnwrapped.text}
                        onChange={(e) => commit(updateTaskTemplateBlock(document, tpl.path, { dataText: e.target.value }))}
                        className="w-full rounded-lg border border-[#dce3ee] bg-slate-950 p-2.5 font-mono text-[11px] leading-relaxed text-slate-100 focus:border-indigo-400 focus:outline-none dark:border-slate-700"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SectionBox>

        {/* 4. Volume Mounts (always visible so users can easily discover and attach group volumes) */}
        <SectionBox
          hidden={taskSection !== 'storage'}
          icon={<Database className="h-4 w-4" />}
          title={tr(`持久化卷挂载 (volume_mount · ${volumeMounts.length})`, `Volume Mounts (volume_mount · ${volumeMounts.length})`)}
          description={tr('将任务组中声明的 volume（host / csi）挂载到容器指定目录', 'Mount group-declared volumes (host / csi) into the task container')}
          actions={
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => selectInForm(gPath, 'storage')}>
                {tr('管理任务组卷', 'Manage Group Volumes')}
              </Button>
              {!readOnly && (
                <Button
                  size="sm"
                  onClick={() => setQuickAdd({
                    form: {
                      kind: 'volume',
                      volumes: groupVolumes.map((volume) => volume.label),
                      hostVolumes: Object.keys(options.host_volumes || {}),
                    },
                    path: tPath,
                    groupPath: gPath,
                  })}
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>{groupVolumes.length > 0 ? tr('挂载卷', 'Mount Volume') : tr('声明并挂载卷', 'Declare and Mount Volume')}</span>
                </Button>
              )}
            </div>
          }
        >
          {volumeMounts.length === 0 ? (
            <div className="text-[11px] text-slate-400">
              {groupVolumes.length > 0
                ? tr(`所属任务组已声明 ${groupVolumes.length} 个卷（${groupVolumes.map((v) => v.label).join(', ')}），点击右上角「挂载卷」即可挂载进容器。`, `Parent group declares ${groupVolumes.length} volume(s) (${groupVolumes.map((v) => v.label).join(', ')}). Click "Mount Volume" to attach.`)
                : tr('暂未挂载持久卷。可选择已有的 Host Volume 或 CSI 卷并填写容器挂载路径。', 'Select an existing Host Volume or CSI volume and enter the container mount path.')}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="hidden sm:grid sm:grid-cols-[1fr_1.4fr_auto_auto] gap-2 px-2 text-[11px] text-slate-500">
                <span>{tr('引用卷名 (volume)', 'Volume (volume)')}</span>
                <span>{tr('容器内挂载目录 (destination)', 'Mount Path (destination)')}</span>
                <span>{tr('权限', 'Access')}</span>
                <span className="w-7" />
              </div>
              {volumeMounts.map((vm) => {
                const vRef = parseLiteralString(getAttrExpr(document, vm.path, 'volume')) || '';
                const vDest = parseLiteralString(getAttrExpr(document, vm.path, 'destination')) || '';
                const vRo = parseLiteralBool(getAttrExpr(document, vm.path, 'read_only')) ?? false;
                return (
                  <div
                    key={vm.path.join('.')}
                    className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1.4fr_auto_auto] items-center rounded-lg border border-slate-200/80 bg-slate-50/50 p-2 dark:border-slate-800 dark:bg-slate-950/30"
                  >
                    {groupVolumes.length > 0 ? (
                      <Select
                        aria-label={tr('选择任务组存储卷', 'Select group volume')}
                        size="sm"
                        disabled={readOnly}
                        value={vRef}
                        onChange={(e) => commit(setAttrExpr(document, vm.path, 'volume', JSON.stringify(e.target.value)))}
                      >
                        {Array.from(new Set([...groupVolumes.map((g) => g.label), ...(vRef ? [vRef] : [])])).map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <input
                        aria-label={tr('引用卷名称', 'Volume name')}
                        disabled={readOnly}
                        value={vRef}
                        placeholder="data"
                        onChange={(e) => commit(setAttrExpr(document, vm.path, 'volume', JSON.stringify(e.target.value)))}
                        className="min-w-0 rounded-lg border border-[#dce3ee] bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                      />
                    )}
                    <input
                      aria-label={tr('容器挂载路径', 'Container mount destination')}
                      disabled={readOnly}
                      value={vDest}
                      placeholder="/var/lib/data"
                      onChange={(e) => commit(setAttrExpr(document, vm.path, 'destination', JSON.stringify(e.target.value)))}
                      className="min-w-0 rounded-lg border border-[#dce3ee] bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                    />
                    <label className="inline-flex items-center gap-1 text-[11px] text-slate-600 dark:text-slate-300 px-1 whitespace-nowrap">
                      <input
                        type="checkbox"
                        disabled={readOnly}
                        checked={vRo}
                        onChange={(e) => commit(setAttrExpr(document, vm.path, 'read_only', e.target.checked ? 'true' : 'false'))}
                      />
                      {tr('只读', 'Read-only')}
                    </label>
                    {!readOnly && (
                      <button
                        type="button"
                        aria-label={tr('删除卷挂载', 'Delete volume mount')}
                        onClick={() => commit(removeNodeAtPath(document, vm.path))}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </SectionBox>

        {/* 5. Task-level Service registration */}
        <SectionBox
          hidden={taskSection !== 'network'}
          icon={<Shield className="h-4 w-4" />}
          title={tr(`任务级服务注册 (service · ${taskServices.length})`, `Task Services (service · ${taskServices.length})`)}
          description={tr('通常推荐在任务组中注册服务；如需绑定单个 Task 生命周期，也可直接在此配置', 'Prefer registering services at Group level; configure here to tie to a single Task')}
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={() => selectInForm(gPath, 'network')}>
                {tr('管理任务组服务', 'Manage Group Services')}
              </Button>
              {!readOnly && (
                <Button
                  size="sm"
                  onClick={() => openServiceForm(tPath, gPath, taskName || 'my-service')}
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>{tr('注册任务级服务', 'Register Task Service')}</span>
                </Button>
              )}
            </>
          }
        >
          {renderServiceCards(taskServices, groupPorts, tr('未配置任务级 service 块。', 'No task-level service blocks configured.'))}
        </SectionBox>

        {driver === 'docker' && (
          <SectionBox hidden={taskSection !== 'advanced'} icon={<SlidersHorizontal className="h-4 w-4" />} title={tr('容器高级选项', 'Advanced Container Options')}>
            <div className="border-t border-slate-100 pt-2 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setShowDockerAdv((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-indigo-600 dark:text-slate-400"
              >
                {showDockerAdv ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                <span>
                  {tr('容器启动命令与高级选项（entrypoint / command / args / force_pull', 'Container Command & Advanced Options (entrypoint / command / args / force_pull')}
                  {dockerEntrypoint.length || dockerCommand || dockerArgs.length || dockerForcePull || dockerPrivileged
                    ? tr(' · 已配置', ' · Configured')
                    : ''}
                  {tr('）', ')')}
                </span>
              </button>
              {showDockerAdv && (
                <div className="mt-3 space-y-3 rounded-xl border border-slate-200/80 bg-slate-50/50 p-3 dark:border-slate-800 dark:bg-slate-950/30">
                  <StringListEditor
                    label={tr('入口点 (entrypoint)', 'Entrypoint (entrypoint)')}
                    placeholder="/bin/sh"
                    items={dockerEntrypoint}
                    disabled={readOnly}
                    onChange={(next) =>
                      commit(setTaskConfigAttr(document, tPath, 'entrypoint', next.length ? JSON.stringify(next) : null))
                    }
                  />
                  <Input
                    label={tr('覆盖命令 (command，可选)', 'Command override (command, optional)')}
                    disabled={readOnly}
                    value={dockerCommand}
                    placeholder={tr('留空则使用镜像默认', 'Leave blank for image default')}
                    onChange={(e) =>
                      commit(setTaskConfigAttr(document, tPath, 'command', e.target.value ? JSON.stringify(e.target.value) : null))
                    }
                  />
                  <StringListEditor
                    label={tr('启动参数 (args)', 'Arguments (args)')}
                    placeholder="--port 8080"
                    items={dockerArgs}
                    disabled={readOnly}
                    onChange={(next) =>
                      commit(setTaskConfigAttr(document, tPath, 'args', next.length ? JSON.stringify(next) : null))
                    }
                  />
                  <div className="flex flex-wrap gap-4 pt-1">
                    <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={readOnly}
                        checked={dockerForcePull}
                        onChange={(e) =>
                          commit(setTaskConfigAttr(document, tPath, 'force_pull', e.target.checked ? 'true' : null))
                        }
                      />
                      <span>{tr('每次强制拉取镜像 (force_pull)', 'Always pull image (force_pull)')}</span>
                    </label>
                    <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={readOnly}
                        checked={dockerPrivileged}
                        onChange={(e) =>
                          commit(setTaskConfigAttr(document, tPath, 'privileged', e.target.checked ? 'true' : null))
                        }
                      />
                      <span>{tr('特权容器模式 (privileged)', 'Privileged mode (privileged)')}</span>
                    </label>
                  </div>
                </div>
              )}
            </div>
          </SectionBox>
        )}
        {taskSection === 'advanced' && driver !== 'docker' && !unhandled.length && (
          <p className="text-xs text-slate-500">{tr('这个任务的驱动没有额外的表单设置。', 'This task driver has no additional form settings.')}</p>
        )}

        {taskSection === 'advanced' && unhandled.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200/80 bg-slate-50/70 px-3.5 py-2.5 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
            <span>{tr('已无损保留其他任务块：', 'Preserved extra task blocks:')}</span>
            {unhandled.map((blk) => (
              <button
                key={blk.path.join('.')}
                type="button"
                onClick={() => jumpToTreePath(blk.path)}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 font-mono text-indigo-600 hover:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-indigo-300"
              >
                <span>{blk.name}{blk.label ? ` "${blk.label}"` : ''}</span>
                <ChevronRight className="h-3 w-3" />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Renderers for ADVANCED AST TREE MODE (full Nomad HCL schema + drag & drop)
  // ---------------------------------------------------------------------------
  const renderTreeWorkspace = () => {
    const node = nodeAt(document, selected);
    const isBody = !selected.length || node?.kind === 'block';
    const parent = selected.slice(0, -1);
    const bodyPath = isBody ? selected : parent;
    const body = bodyAt(document, bodyPath);
    const rule = ruleAt(document, bodyPath, schema);
    const context = contextAt(document, bodyPath, schema);
    const siblingRule =
      selected.length && node ? ruleAt(document, parent, schema).blocks.find((item) => item.name === node.name) : undefined;

    const changeExpression = (path: NodePath, expression: string) =>
      commit(
        editDocument(document, (draft) => {
          nodeAt(draft, path)!.expression = expression;
        }),
      );

    const removeNode = (path: NodePath) =>
      commit(
        editDocument(document, (draft) => {
          bodyAt(draft, path.slice(0, -1)).nodes.splice(path[path.length - 1], 1);
        }),
        path.slice(0, -1),
      );

    const reorder = (offset: number) => {
      const index = selected[selected.length - 1];
      commit(
        editDocument(document, (draft) => {
          const siblings = bodyAt(draft, parent).nodes;
          [siblings[index], siblings[index + offset]] = [siblings[index + offset], siblings[index]];
        }),
        [...parent, index + offset],
      );
    };

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
          if (name === 'volume') {
            return group.nodes.filter((item) => item.kind === 'block' && item.name === 'volume').map((item) => item.labels?.[0] || '');
          }
          return group.nodes
            .filter((item) => item.kind === 'block' && item.name === 'network')
            .flatMap(
              (item) =>
                item.body?.nodes
                  .filter((port) => port.kind === 'block' && port.name === 'port')
                  .map((port) => port.labels?.[0] || '') || [],
            );
        }
      }
      return ENUM_VALUES[`${context}.${name}`] || [];
    };

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
        const expression =
          context === 'Variable' && name === 'type'
            ? 'string'
            : context === 'Job' && name === 'type'
              ? '"service"'
              : defaultExpression(field);
        next = { kind: 'attribute', name, expression, leading: '\n' };
      }
      if (!canInsert(document, bodyPath, next, schema)) return;
      commit(
        editDocument(document, (draft) => {
          bodyAt(draft, bodyPath).nodes.push(next);
        }),
        next.kind === 'attribute' ? bodyPath : [...bodyPath, body.nodes.length],
      );
    };

    const addCustom = () => {
      const name = customName.trim();
      if (!name) return;
      const kind = rule.map_kind ? 'attribute' : customKind;
      if (kind === 'attribute' && body.nodes.some((item) => item.kind === 'attribute' && item.name === name)) {
        setError(tr('当前属性已经存在', 'Attribute already exists'));
        return;
      }
      const next: HCLNode =
        kind === 'attribute'
          ? { kind: 'attribute', name, expression: '""', leading: '\n' }
          : { kind: 'block', name, labels: [], body: { nodes: [], trailing: '\n' }, leading: '\n' };
      if (
        (rule.attributes.some((field) => field.name === name) || rule.blocks.some((block) => block.name === name)) &&
        !canInsert(document, bodyPath, next, schema)
      ) {
        setError(tr('当前层级不能再添加该元素，请使用可添加元素列表', 'Cannot add this element at this level; use the available elements selector'));
        return;
      }
      commit(
        editDocument(document, (draft) => bodyAt(draft, bodyPath).nodes.push(next)),
        kind === 'attribute' ? bodyPath : [...bodyPath, body.nodes.length],
      );
      setCustomName('');
    };

    const outline = (tree: HCLDocument, path: NodePath): React.ReactNode =>
      tree.nodes.map((item, index) => {
        const here = [...path, index];
        const key = here.join('.');
        const folded = collapsed.has(key);
        const picked = samePath(here, selected);
        return (
          <div key={key} role="treeitem" aria-label={nodeTitle(item)} aria-selected={picked} aria-expanded={item.body ? !folded : undefined}>
            <div
              draggable={!readOnly}
              onDragStart={(e) => {
                e.stopPropagation();
                e.dataTransfer.setData('application/x-nomad-hcl-node', JSON.stringify(here));
              }}
              onDragOver={(e) => {
                if (item.body && !readOnly) e.preventDefault();
              }}
              onDrop={(e) => {
                if (!item.body || readOnly) return;
                e.preventDefault();
                e.stopPropagation();
                try {
                  const src: unknown = JSON.parse(e.dataTransfer.getData('application/x-nomad-hcl-node'));
                  if (!Array.isArray(src) || src.length > 32 || !src.every((part) => Number.isInteger(part) && part >= 0)) {
                    throw new Error(tr('无效的拖动元素', 'Invalid dragged node'));
                  }
                  const next = moveNode(document, src, here, schema);
                  commit(next.document, next.path);
                } catch (ex: any) {
                  setError(ex.message || tr('无法移动到此层级', 'Cannot move node into this level'));
                }
              }}
              className={`flex items-center gap-1 rounded py-1 pr-1 ${
                picked
                  ? 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-100'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {item.body ? (
                <button
                  aria-label={`${folded ? tr('展开', 'Expand') : tr('折叠', 'Collapse')} ${nodeTitle(item)}`}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (folded) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  className="shrink-0 p-0.5"
                >
                  {folded ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
              ) : (
                <span className="w-4 text-center text-[10px] text-slate-400">＝</span>
              )}
              <button
                aria-label={tr(`编辑 ${nodeTitle(item)}`, `Edit ${nodeTitle(item)}`)}
                onClick={() => setSelected(here)}
                className="min-w-0 flex-1 truncate text-left font-mono text-xs"
              >
                {nodeTitle(item)}
              </button>
              {!readOnly && <GripVertical className="h-3 w-3 shrink-0 text-slate-400" />}
            </div>
            {item.body && !folded && (
              <div role="group" className="ml-3 border-l border-slate-200 pl-2 dark:border-slate-700">
                {outline(item.body, here)}
              </div>
            )}
          </div>
        );
      });

    const attributes = body.nodes.map((item, index) => ({ item, path: [...bodyPath, index] })).filter(({ item }) => item.kind === 'attribute');
    const children = body.nodes.map((item, index) => ({ item, path: [...bodyPath, index] })).filter(({ item }) => item.kind === 'block');
    const visibleAttributes = node?.kind === 'attribute' ? attributes.filter(({ path }) => samePath(path, selected)) : attributes;

    return (
      <div className="grid gap-3 lg:grid-cols-[230px_minmax(0,1fr)]">
        <div className="max-h-[640px] overflow-auto rounded-xl border border-slate-200 bg-white p-2.5 dark:border-slate-800 dark:bg-slate-900">
          <button
            onClick={() => setSelected([])}
            className={`mb-2 w-full rounded-lg px-2 py-1.5 text-left font-semibold ${
              selected.length ? 'hover:bg-slate-100 dark:hover:bg-slate-800' : 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-100'
            }`}
          >
            {tr('HCL 文档根节点', 'HCL Document Root')}
          </button>
          <div role="tree" aria-label={tr('Job 结构树', 'Job AST Tree')}>
            {outline(document, [])}
          </div>
        </div>
        <div ref={treePanelRef} tabIndex={-1} className="max-h-[640px] space-y-4 overflow-auto rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2 dark:border-slate-800">
            <div className="min-w-0">
              <div className="flex flex-wrap gap-1 text-[11px] text-slate-500">
                <button onClick={() => setSelected([])}>{tr('文档', 'Document')}</button>
                {selected.map((_, i) => (
                  <button key={i} onClick={() => setSelected(selected.slice(0, i + 1))}>
                    › {nodeTitle(nodeAt(document, selected.slice(0, i + 1))!)}
                  </button>
                ))}
              </div>
              <h3 className="mt-1 break-words font-mono font-semibold">{node ? nodeTitle(node) : tr('HCL 文档', 'HCL Document')}</h3>
            </div>
            {node && (
              <div className="flex gap-1">
                <Button size="sm" aria-label={tr('上移当前元素', 'Move up')} disabled={readOnly || selected[selected.length - 1] === 0} onClick={() => reorder(-1)}>
                  <ArrowUp className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  aria-label={tr('下移当前元素', 'Move down')}
                  disabled={readOnly || selected[selected.length - 1] === bodyAt(document, parent).nodes.length - 1}
                  onClick={() => reorder(1)}
                >
                  <ArrowDown className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  aria-label={tr('复制当前块', 'Duplicate block')}
                  disabled={readOnly || node.kind !== 'block' || !siblingRule || siblingRule.max === 1}
                  onClick={() => {
                    try {
                      const next = duplicateBlock(document, selected, schema);
                      commit(next.document, next.path);
                    } catch (ex: any) {
                      setError(ex.message);
                    }
                  }}
                >
                  <Copy className="h-3 w-3" />
                </Button>
                <Button size="sm" aria-label={tr('删除当前元素', 'Delete element')} variant="danger-outline" disabled={readOnly} onClick={() => removeNode(selected)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>

          {node?.kind === 'block' &&
            (node.labels || []).map((label, i) => (
              <Input
                key={i}
                label={(isEn ? LABELS_EN[node.name] : LABELS[node.name]) || tr(`名称标签 ${i + 1}`, `Label ${i + 1}`)}
                disabled={readOnly}
                value={label}
                onChange={(e) =>
                  commit(
                    editDocument(document, (draft) => {
                      nodeAt(draft, selected)!.labels![i] = e.target.value;
                    }),
                  )
                }
              />
            ))}

          {visibleAttributes.map(({ item, path }) => {
            const field =
              rule.attributes.find((entry) => entry.name === item.name) ||
              ({ name: item.name, kind: rule.map_kind || 'expression' } as AttributeRule);
            return (
              <div key={path.join('.')} className="relative space-y-2 rounded-lg border border-slate-200 p-3 pr-12 dark:border-slate-700">
                {rule.map_kind && (
                  <Input
                    label={tr('键名', 'Key')}
                    disabled={readOnly}
                    value={item.name}
                    onChange={(e) =>
                      commit(
                        editDocument(document, (draft) => {
                          nodeAt(draft, path)!.name = e.target.value;
                        }),
                      )
                    }
                  />
                )}
                <ValueEditor
                  node={item}
                  field={field}
                  choices={fieldChoices(item.name)}
                  disabled={readOnly}
                  onChange={(value) => changeExpression(path, value)}
                />
                <button
                  aria-label={tr(`删除属性 ${item.name}`, `Delete attribute ${item.name}`)}
                  disabled={readOnly}
                  onClick={() => removeNode(path)}
                  className="absolute right-2 top-3 rounded p-1 text-slate-400 hover:text-rose-500 disabled:opacity-30"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}

          {isBody && (
            <>
              {children.length > 0 && (
                <div className="space-y-1.5">
                  <div className="font-semibold">{tr('子块', 'Child Blocks')}</div>
                  {children.map(({ item, path }) => (
                    <button
                      key={path.join('.')}
                      onClick={() => setSelected(path)}
                      className="flex w-full items-center justify-between rounded-lg border border-slate-200 p-2 text-left font-mono hover:border-indigo-400 dark:border-slate-700"
                    >
                      <span>{nodeTitle(item)}</span>
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  ))}
                </div>
              )}
              {!readOnly && (
                <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
                  <div className="font-semibold">{tr('添加 Nomad Schema 元素', 'Add Nomad Schema Element')}</div>
                  {(rule.attributes.length > 0 || rule.blocks.length > 0) && (
                    <>
                      <Input aria-label={tr('搜索可添加元素', 'Search elements')} placeholder={tr('搜索属性或块，例如 resources / lifecycle', 'Search attribute or block, e.g. resources / lifecycle')} value={filter} onChange={(e) => setFilter(e.target.value)} />
                      <div className="flex items-end gap-2">
                        <div className="min-w-0 flex-1">
                          <Select label={tr('可添加元素', 'Available Elements')} size="sm" value={adding} onChange={(e) => setAdding(e.target.value)}>
                            <option value="">{tr('选择元素', 'Select element')}</option>
                            <optgroup label={tr('属性（每个名称仅一份）', 'Attributes (unique)')}>
                              {rule.attributes
                                .filter((item) => item.name.includes(filter))
                                .map((field) => {
                                  const exists = body.nodes.some((item) => item.kind === 'attribute' && item.name === field.name);
                                  return (
                                    <option key={field.name} value={`attribute:${field.name}`} disabled={exists}>
                                      {field.name}
                                      {field.required ? ' *' : ''}
                                      {exists ? tr(' · 已添加', ' · Added') : ` · ${field.kind}`}
                                    </option>
                                  );
                                })}
                            </optgroup>
                            <optgroup label={tr('子块', 'Child Blocks')}>
                              {rule.blocks
                                .filter((item) => item.name.includes(filter))
                                .map((block) => {
                                  const count = body.nodes.filter((item) => item.kind === 'block' && item.name === block.name).length;
                                  const full =
                                    body.nodes.some((item) => item.kind === 'attribute' && item.name === block.name) ||
                                    (block.max > 0 && count >= block.max);
                                  return (
                                    <option key={block.name} value={`block:${block.name}`} disabled={full}>
                                      {block.name} · {block.max === 1 ? tr('单个', 'single') : tr('可重复', 'repeatable')}
                                      {full ? tr(' · 已添加', ' · Added') : ''}
                                    </option>
                                  );
                                })}
                            </optgroup>
                          </Select>
                        </div>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={
                            !adding ||
                            Boolean(
                              adding.startsWith('attribute:') &&
                                body.nodes.some((item) => item.kind === 'attribute' && `attribute:${item.name}` === adding),
                            )
                          }
                          onClick={addElement}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          {tr('添加元素', 'Add Element')}
                        </Button>
                      </div>
                    </>
                  )}
                  {rule.map_kind ? (
                    <div className="space-y-2 rounded-lg bg-slate-50 p-2.5 dark:bg-slate-950">
                      <Input label={rule.map_kind === 'string' ? tr('新键名', 'New Key') : tr('新字段名称', 'New Field Name')} value={customName} onChange={(e) => setCustomName(e.target.value)} />
                      <Button size="sm" disabled={!customName.trim()} onClick={addCustom}>
                        <Plus className="h-3 w-3" />
                        {rule.map_kind === 'string' ? tr('添加键值', 'Add Entry') : tr('添加字段', 'Add Field')}
                      </Button>
                    </div>
                  ) : (
                    <details className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-950">
                      <summary className="cursor-pointer text-slate-500">{tr('原生扩展（自定义插件或新版本字段）', 'Custom Extension (plugin or newer schema field)')}</summary>
                      <div className="mt-2 space-y-2">
                        <Input label={tr('元素名称', 'Element Name')} value={customName} onChange={(e) => setCustomName(e.target.value)} />
                        <Select label={tr('原生元素类型', 'Element Type')} size="sm" value={customKind} onChange={(e) => setCustomKind(e.target.value as 'attribute' | 'block')}>
                          <option value="attribute">{tr('属性', 'Attribute')}</option>
                          <option value="block">{tr('子块', 'Block')}</option>
                        </Select>
                        <Button size="sm" disabled={!customName.trim()} onClick={addCustom}>
                          {tr('添加原生元素', 'Add Raw Element')}
                        </Button>
                      </div>
                    </details>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  const hasErrors = diagnostics.some((issue) => issue.severity === 'error');

  return (
    <div className="space-y-3">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200/90 bg-slate-50/70 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-950/50">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900">
            <button
              type="button"
              onClick={() => setViewMode('form')}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
                viewMode === 'form'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              <span>{tr('积木表单', 'Visual Forms')}</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('tree')}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
                viewMode === 'tree'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
              }`}
            >
              <TreePine className="h-3.5 w-3.5" />
              <span>{tr('高级结构树', 'AST Tree')}</span>
            </button>
          </div>
          <span
            aria-live="polite"
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
              rendering
                ? 'bg-slate-200/70 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                : hasErrors
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200'
                  : 'bg-emerald-100/80 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full bg-current ${rendering ? 'animate-pulse' : ''}`} />
            {rendering ? tr('同步 HCL 中…', 'Syncing HCL...') : hasErrors ? tr(`待完善 (${diagnostics.length})`, `Incomplete (${diagnostics.length})`) : tr('HCL 结构通过', 'HCL Structure Valid')}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" disabled={readOnly || !undo.length} onClick={() => navigateHistory(true)} title={tr('撤销上一步修改', 'Undo last edit')}>
            <Undo2 className="h-3.5 w-3.5" />
            <span>{tr('撤销', 'Undo')}</span>
          </Button>
          <Button size="sm" disabled={readOnly || !redo.length} onClick={() => navigateHistory(false)} title={tr('重做修改', 'Redo edit')}>
            <Redo2 className="h-3.5 w-3.5" />
            <span>{tr('重做', 'Redo')}</span>
          </Button>
          <Button
            size="sm"
            variant={showPreview ? 'primary' : 'secondary'}
            onClick={() => setShowPreview((v) => !v)}
          >
            {showPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            <span>{showPreview ? tr('隐藏 HCL 预览', 'Hide HCL Preview') : tr('实时 HCL 预览', 'Live HCL Preview')}</span>
          </Button>
        </div>
      </div>

      <ErrorAlert message={error} onClose={() => setError('')} />

      {diagnostics.length > 0 && (
        <div
          role="status"
          className="max-h-32 space-y-1 overflow-auto rounded-xl border border-amber-200 bg-amber-50/90 px-3.5 py-2.5 text-xs text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {diagnostics.map((issue, i) => (
            <button
              key={i}
              type="button"
              className="block w-full text-left hover:underline"
              onClick={() => revealDiagnostic(issue)}
            >
              • {issue.message}
            </button>
          ))}
        </div>
      )}

      {/* Main Canvas + Optional Sticky Live HCL Split Pane */}
      <div className={`grid gap-4 items-start ${showPreview && widePreview ? 'grid-cols-[minmax(0,1fr)_minmax(300px,30%)]' : 'grid-cols-1'}`}>
        <div className="min-w-0">
          {viewMode === 'tree' ? (
            renderTreeWorkspace()
          ) : !jobPath ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center space-y-2 dark:border-slate-700 dark:bg-slate-900">
              <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{tr('当前文档中未检测到 job 块', 'No job block found in current document')}</p>
              <p className="text-xs text-slate-500">{tr('可切换至「高级结构树」或「原生 HCL」查看完整文档内容。', 'Switch to "AST Tree" or "Native HCL" to view the full document.')}</p>
              <Button size="sm" onClick={() => setViewMode('tree')}>
                {tr('打开高级结构树', 'Open AST Tree')}
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[172px_minmax(0,1fr)] items-start">
              {/* Left: Visual Blueprint Navigator */}
              <div className="rounded-xl border border-slate-200/90 bg-slate-50/60 p-3 space-y-2.5 dark:border-slate-800 dark:bg-slate-950/50 lg:sticky lg:top-20">
                <div className="flex items-center justify-between px-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    {tr('任务结构蓝图', 'Job Structure')}
                  </span>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => {
                        const res = addReadyGroup(document, jobPath);
                        commit(res.document, res.path);
                      }}
                      className="inline-flex items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      <Plus className="h-3 w-3" />
                      <span>{tr('任务组', 'Group')}</span>
                    </button>
                  )}
                </div>

                {/* Job Node */}
                {(() => {
                  const jNode = nodeAt(document, jobPath)!;
                  const jName = jNode.labels?.[0] || 'unnamed';
                  const jType = parseLiteralString(getAttrExpr(document, jobPath, 'type')) || 'service';
                  const active = formTarget.kind === 'job';
                  return (
                    <button
                      type="button"
                      onClick={() => selectInForm(jobPath)}
                      className={`w-full rounded-xl border p-2.5 text-left transition ${
                        active
                          ? 'border-indigo-500 bg-indigo-600 text-white shadow-sm'
                          : 'border-slate-200 bg-white text-slate-800 hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold truncate">
                          <Layers className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{jName}</span>
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
                            active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                          }`}
                        >
                          {jType}
                        </span>
                      </div>
                    </button>
                  );
                })()}

                {/* Groups & Nested Tasks */}
                <div className="space-y-2 pl-2 border-l-2 border-slate-200 dark:border-slate-800">
                  {groups.map((grp) => {
                    const grpSelected = formTarget.kind === 'group' && samePath(formTarget.path, grp.path);
                    const count = parseLiteralNumber(getAttrExpr(document, grp.path, 'count')) ?? 1;
                    const grpPorts = listGroupPorts(document, grp.path);
                    const grpTasks = listChildBlocks(document, grp.path, 'task');
                    return (
                      <div key={grp.path.join('.')} className="space-y-1.5">
                        <div
                          role="button"
                          tabIndex={0}
                          aria-pressed={grpSelected}
                          onClick={() => selectInForm(grp.path)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              selectInForm(grp.path);
                            }
                          }}
                          className={`group cursor-pointer select-none rounded-xl border p-2.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 ${
                            grpSelected
                              ? 'border-indigo-500 bg-indigo-50 text-indigo-950 shadow-sm dark:border-indigo-400 dark:bg-indigo-500/20 dark:text-indigo-100'
                              : 'border-slate-200/90 bg-white text-slate-700 hover:border-indigo-300 hover:bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800/60'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                              <Boxes className="h-4 w-4 shrink-0 text-sky-500" />
                              <span className="truncate font-mono text-xs font-semibold">{grp.label || 'group'}</span>
                            </span>
                            <div className="flex items-center gap-1 shrink-0">
                              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                                ×{count}
                              </span>
                              {!readOnly && (
                                <button
                                  type="button"
                                  title={tr('向此任务组添加新任务', 'Add task to this group')}
                                  aria-label={tr(`向 ${grp.label} 添加任务`, `Add task to ${grp.label}`)}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const res = addReadyTask(document, grp.path);
                                    commit(res.document, res.path);
                                  }}
                                  className="rounded p-0.5 text-slate-400 hover:bg-indigo-100 hover:text-indigo-600 dark:hover:bg-indigo-500/20"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                          {grpPorts.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {grpPorts.slice(0, 3).map((p) => (
                                <span
                                  key={p.path.join('.')}
                                  className="rounded bg-sky-50 px-1.5 py-0.5 font-mono text-[10px] text-sky-700 dark:bg-sky-500/15 dark:text-sky-300"
                                >
                                  {p.label}
                                  {p.staticPort ? `:${p.staticPort}` : ''}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Nested tasks */}
                        <div className="space-y-1 pl-2.5 border-l border-slate-200 dark:border-slate-800">
                          {grpTasks.map((tk) => {
                            const tkSelected = formTarget.kind === 'task' && samePath(formTarget.path, tk.path);
                            const drv = parseLiteralString(getAttrExpr(document, tk.path, 'driver')) || 'docker';
                            const resBlk = findChildBlock(document, tk.path, 'resources');
                            const cpu = resBlk ? parseLiteralNumber(getAttrExpr(document, resBlk.path, 'cpu')) : undefined;
                            const mem = resBlk ? parseLiteralNumber(getAttrExpr(document, resBlk.path, 'memory')) : undefined;
                            const hasVault = Boolean(findChildBlock(document, tk.path, 'vault'));
                            const isShellDriver = drv === 'exec' || drv === 'raw_exec';
                            return (
                              <button
                                key={tk.path.join('.')}
                                type="button"
                                onClick={() => selectInForm(tk.path)}
                                className={`w-full rounded-lg border px-2.5 py-2 text-left transition ${
                                  tkSelected
                                    ? 'border-indigo-500 bg-indigo-50 text-indigo-950 shadow-sm dark:border-indigo-400 dark:bg-indigo-500/20 dark:text-indigo-100'
                                    : 'border-slate-200/80 bg-white/90 text-slate-700 hover:border-indigo-300 hover:bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/80 dark:text-slate-200 dark:hover:bg-slate-800/60'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-1">
                                  <span className="inline-flex items-center gap-1.5 min-w-0">
                                    {isShellDriver ? (
                                      <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                                    ) : (
                                      <Container className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                                    )}
                                    <span className="truncate font-mono text-xs font-medium">{tk.label || 'task'}</span>
                                  </span>
                                  <span className="font-mono text-[10px] text-slate-400 shrink-0">{drv}</span>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
                                  {(cpu || mem) && (
                                    <span className="font-mono">
                                      {cpu ?? '-'}MHz/{mem ?? '-'}M
                                    </span>
                                  )}
                                  {hasVault && (
                                    <span className="rounded bg-emerald-50 px-1 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                                      Vault
                                    </span>
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {topLevelExtras.length > 0 && (
                  <button
                    type="button"
                    onClick={() => jumpToTreePath(topLevelExtras[0].path)}
                    className="w-full rounded-lg border border-dashed border-slate-300 px-2.5 py-1.5 text-left text-[11px] text-slate-500 hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-400"
                  >
                    {tr(`另含 ${topLevelExtras.length} 个文档级元素（如 variable）→ 结构树查看`, `${topLevelExtras.length} top-level item(s) (e.g. variable) -> AST Tree`)}
                  </button>
                )}
              </div>

              {/* Right: Focused Property Workspace */}
              <div
                ref={formPanelRef}
                className="min-w-0 scroll-mt-20 rounded-xl border border-slate-200/90 bg-slate-50/40 p-4 dark:border-slate-800 dark:bg-slate-950/30"
              >
                {formTarget.kind === 'job' && renderJobForm(formTarget.path)}
                {formTarget.kind === 'group' && renderGroupForm(formTarget.path)}
                {formTarget.kind === 'task' && formTarget.groupPath && renderTaskForm(formTarget.path, formTarget.groupPath)}
              </div>
            </div>
          )}
        </div>

        {/* Sticky Live HCL Preview Pane */}
        {showPreview && widePreview && (
          <div className="sticky top-20 min-w-0 overflow-hidden rounded-xl border border-slate-200/90 bg-white dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3.5 py-2.5 dark:border-slate-800">
              <div className="flex items-center gap-1.5 min-w-0">
                <Code2 className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
                <span className="font-semibold text-xs text-slate-800 dark:text-slate-100 truncate">{tr('实时 HCL 源码', 'Live HCL Source')}</span>
                <span className="font-mono text-[10px] text-slate-400">
                  {tr(`${liveHcl.split('\n').length} 行`, `${liveHcl.split('\n').length} lines`)}
                </span>
              </div>
              {copyPreviewButton}
            </div>
            <div className="p-2.5">
              <CodeEditor value={liveHcl} onChange={() => {}} readOnly height="580px" />
            </div>
            <div className="border-t border-slate-100 px-3.5 py-2 text-[11px] text-slate-400 dark:border-slate-800">
              {tr('修改左侧表单将自动无损同步至此源码，原注释与未展开 HCL 块均保持原样。', 'Form edits sync losslessly here; existing comments and unedited HCL blocks stay intact.')}
            </div>
          </div>
        )}
      </div>

      <Modal
        open={showPreview && !widePreview}
        title={tr('实时 HCL 源码', 'Live HCL Source')}
        onClose={() => setShowPreview(false)}
        size="lg"
        placement="right"
        footer={copyPreviewButton}
      >
        <CodeEditor value={liveHcl} onChange={() => {}} readOnly height="calc(100dvh - 184px)" />
      </Modal>

      {quickAdd && <BuilderQuickAddDialog form={quickAdd.form} onClose={() => setQuickAdd(null)} onSave={saveQuickAdd} />}

      <HostVolumeCreateModal
        open={Boolean(createHostVol)}
        clusterId={clusterId}
        volumeName={createHostVol?.name || ''}
        defaultReadOnly={Boolean(createHostVol?.readOnly)}
        onClose={() => setCreateHostVol(null)}
        onCreated={refreshBuilderOptions}
      />
    </div>
  );
});
