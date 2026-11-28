import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BookOpen,
  Boxes,
  Copy,
  Download,
  FilePlus2,
  KeyRound,
  LayoutGrid,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiDelete, apiDownload, apiGet, apiPost, fmtTime, openSSE } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { applyVaultToTask, type HCLDocument, type NodePath } from '../lib/hclBuilder';
import {
  buildTaskVaultSnippet,
  buildTemplateData,
  INTEGRATION_DRAFT_JOB_STORAGE_KEY,
  parseKVPath,
  type VaultIntegrationOption,
  type VaultRoleOption,
} from '../lib/vaultHelpers';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import {
  buildTabSearchParams,
  JOB_CENTER_CLUSTER_KEY,
  type JobCenterTab,
  readStoredSelection,
  resolveClusterSelection,
  resolveJobCenterTab,
  writeStoredSelection,
} from '../lib/selectionMemory';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Input,
  LoadingState,
  Modal,
  PageHeader,
  SectionTabs,
  Select,
  StatusBadge,
} from '../components/UI';
import { CodeEditor } from '../components/CodeEditor';
import { ItemSwitcher } from '../components/ItemSwitcher';
import { VisualJobBuilder, type VisualJobBuilderHandle } from '../components/VisualJobBuilder';
import { JobRuntimePanel, type JobRuntimeRef } from '../components/JobRuntimePanel';
import { JobPreflightPanel } from '../components/JobPreflightPanel';
import { JobUsagePanel } from '../components/JobUsagePanel';
import {
  VaultKVQuickFixModal,
  VaultRoleQuickFixModal,
  type PreflightCheck,
  type PreflightFixAction,
} from '../components/PreflightQuickFixModals';
import {
  getBlueprintDesc,
  getBlueprintLabel,
  getBlueprintRequires,
  getBlueprintTags,
  STARTER_SAMPLES,
  type JobBlueprint,
} from '../lib/jobBlueprints';

const sampleHCL = STARTER_SAMPLES[0].hcl;

export function JobCenterPage() {
  const { isAdmin } = useAuth();
  const { locale, tr } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClusterId = searchParams.get('cluster_id') || '';
  const queryNamespace = searchParams.get('namespace') || '';
  const queryJobId = searchParams.get('job') || '';
  const queryTab = searchParams.get('tab') || '';
  const queryFrom = searchParams.get('from') || '';
  const toast = useToast();
  const askConfirm = useConfirm();

  const [clusters, setClusters] = useState<any[]>([]);
  const [clusterId, setClusterId] = useState(() => queryClusterId || readStoredSelection(JOB_CENTER_CLUSTER_KEY));
  const [namespace, setNamespace] = useState(queryNamespace || 'default');
  const [jobs, setJobs] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);

  // Active top-level tab: 'list' (Runtime Jobs & inline detail), 'builder' (Composer), 'templates' (Library)
  const pageTab = resolveJobCenterTab(searchParams);
  const updatePageTab = useCallback(
    (nextTab: JobCenterTab, opts?: { replace?: boolean }) => {
      const next = buildTabSearchParams(searchParams, nextTab, 'list', { deleteKeys: ['from', 'job'] });
      if (next.toString() !== searchParams.toString()) {
        setSearchParams(next, opts?.replace ? { replace: true } : undefined);
      }
    },
    [searchParams, setSearchParams],
  );

  // Currently inspected Job in Runtime Detail view (inside 'list' tab)
  const [inspectingJob, setInspectingJob] = useState<JobRuntimeRef | null>(() =>
    queryJobId && queryTab === 'runtime'
      ? { id: queryJobId, namespace: queryNamespace || 'default' }
      : null,
  );
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'pending' | 'stopped'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [blueprintQuery, setBlueprintQuery] = useState('');

  // Composer state
  const [editMode, setEditMode] = useState<'visual' | 'hcl' | 'json'>(() => (isAdmin ? 'visual' : 'hcl'));
  const [hcl, setHcl] = useState(sampleHCL);
  const [jobVariables, setJobVariables] = useState<Record<string, string>>({});
  const visualRef = useRef<VisualJobBuilderHandle>(null);
  const [visualReady, setVisualReady] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const modeRequestRef = useRef(0);
  const formatCacheRef = useRef<{ hcl: string; variables: Record<string, string>; json: string } | null>(null);
  const [composeText, setComposeText] = useState('');
  const [showCompose, setShowCompose] = useState(false);
  const [plan, setPlan] = useState<any>(null);
  const planRequestRef = useRef(0);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);
  const [preflightErrors, setPreflightErrors] = useState<string[]>([]);
  const [preflightChecks, setPreflightChecks] = useState<PreflightCheck[]>([]);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightCheckErr, setPreflightCheckErr] = useState('');
  const preflightReqRef = useRef(0);
  const [ignorePreflight, setIgnorePreflight] = useState(false);
  const [revisions, setRevisions] = useState<any[]>([]);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [activeBlueprintId, setActiveBlueprintId] = useState<string>(STARTER_SAMPLES[0].id);
  const [activeCustomTemplateDesc, setActiveCustomTemplateDesc] = useState('');
  const [tplName, setTplName] = useState('');
  const [tplDesc, setTplDesc] = useState('');
  const [previewTarget, setPreviewTarget] = useState<{
    title: string;
    hcl: string;
    blueprint?: JobBlueprint | null;
    customDescription?: string;
    connectionGuide?: boolean;
  } | null>(null);
  const [previewChecks, setPreviewChecks] = useState<PreflightCheck[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewErr, setPreviewErr] = useState('');
  const previewReqRef = useRef(0);
  const [roleFixAction, setRoleFixAction] = useState<PreflightFixAction | null>(null);
  const [kvFixAction, setKvFixAction] = useState<PreflightFixAction | null>(null);
  const [err, setErr] = useState('');
  const [loadingClusters, setLoadingClusters] = useState(true);
  const editRequestRef = useRef(0);
  const [clusterNamespaces, setClusterNamespaces] = useState<string[]>(['default']);
  const [vaultRoles, setVaultRoles] = useState<VaultRoleOption[]>([]);
  const [vaultIntegrations, setVaultIntegrations] = useState<VaultIntegrationOption[]>([]);
  const [showVaultWizard, setShowVaultWizard] = useState(false);
  const [vaultWizardBusy, setVaultWizardBusy] = useState(false);
  const [vaultWizard, setVaultWizard] = useState({
    role: '',
    secretPath: 'secret/apps/demo',
    mode: 'env' as 'env' | 'file',
    keys: '',
    fileName: 'app.secret',
    envVarName: 'APP_SECRET_FILE',
  });

  const selectedCluster = clusters.find((c) => c.id === clusterId);
  const needsDeployment = selectedCluster?.init_state === 'uninitialized';
  const effectiveBuilderNamespace = namespace === '*' ? 'default' : namespace || 'default';

  // Consume one-time draft HCL handed over from the Integrations page
  useEffect(() => {
    if (queryFrom !== 'integration') return;
    try {
      const raw = window.sessionStorage.getItem(INTEGRATION_DRAFT_JOB_STORAGE_KEY);
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft?.clusterId) setClusterId(draft.clusterId);
        if (draft?.namespace) setNamespace(draft.namespace);
        if (draft?.hcl) {
          setSelectedJobId('');
          setRevisions([]);
          setHcl(draft.hcl);
          setEditMode(isAdmin ? 'visual' : 'hcl');
          setJobVariables({});
          setPlan(null);
          setValidationWarnings([]);
        }
        window.sessionStorage.removeItem(INTEGRATION_DRAFT_JOB_STORAGE_KEY);
        toast.info(
          tr(
            `已载入联动示例（Role: ${draft?.roleName || 'default'}），核对后请依次点击「1. 校验配置 → 2. 预览计划 → 3. 确认运行」`,
            `Loaded integration sample (Role: ${draft?.roleName || 'default'}). Review it, then click "1. Validate -> 2. Plan -> 3. Apply".`,
          ),
        );
      }
    } catch {
      // Ignore malformed sessionStorage drafts.
    }
    updatePageTab('builder', { replace: true });
  }, [queryFrom, updatePageTab]);

  const loadClusters = useCallback(async () => {
    setErr('');
    try {
      const [cRes, tRes] = await Promise.all([
        apiGet('/api/v1/clusters?type=nomad'),
        isAdmin ? apiGet('/api/v1/job-templates') : Promise.resolve({ templates: [] }),
      ]);
      const list = cRes.clusters || [];
      setClusters(list);
      setTemplates(tRes.templates || []);
      if (list.length > 0) {
        setClusterId((prev) =>
          resolveClusterSelection(list, queryClusterId, prev, readStoredSelection(JOB_CENTER_CLUSTER_KEY)),
        );
      }
    } catch (ex: any) {
      setErr(ex?.message || tr('加载集群或模板列表失败', 'Failed to load clusters or templates'));
    } finally {
      setLoadingClusters(false);
    }
  }, [isAdmin, queryClusterId]);

  const loadBuilderContext = useCallback(async () => {
    if (!clusterId || needsDeployment) {
      setClusterNamespaces(['default']);
      setVaultRoles([]);
      setVaultIntegrations([]);
      return;
    }
    try {
      const res = await apiGet(`/api/v1/nomad/${clusterId}/builder-options`);
      const nss = res.options?.namespaces || [];
      setClusterNamespaces(nss.length > 0 ? nss : ['default']);
      const roles: VaultRoleOption[] = res.vault_roles || [];
      setVaultRoles(roles);
      setVaultIntegrations(res.vault_integrations || []);
      if (roles.length > 0) {
        setVaultWizard((prev) =>
          prev.role
            ? prev
            : {
                ...prev,
                role: roles[0].role,
                secretPath: roles[0].secret_paths?.[0] || 'secret/apps/demo',
              },
        );
      }
    } catch {
      // Non-blocking
    }
  }, [clusterId, needsDeployment]);

  const loadJobs = useCallback(async () => {
    if (!clusterId || needsDeployment) {
      setJobs([]);
      return;
    }
    setErr('');
    try {
      const res = await apiGet(`/api/v1/nomad/${clusterId}/jobs?namespace=${encodeURIComponent(namespace)}`);
      setJobs(res.jobs || []);
    } catch (ex: any) {
      setErr(ex?.message || tr('加载 Job 列表失败', 'Failed to load jobs'));
    }
  }, [clusterId, namespace, needsDeployment]);

  useEffect(() => {
    if (queryClusterId && clusters.some((c: any) => c.id === queryClusterId)) {
      setClusterId(queryClusterId);
    }
  }, [queryClusterId, clusters]);

  useEffect(() => {
    if (clusterId && clusters.some((c: any) => c.id === clusterId)) {
      writeStoredSelection(JOB_CENTER_CLUSTER_KEY, clusterId);
    }
  }, [clusterId, clusters]);

  useEffect(() => {
    if (queryNamespace) {
      setNamespace(queryNamespace);
    }
  }, [queryNamespace]);

  useEffect(() => {
    void loadClusters();
  }, [loadClusters]);

  useEffect(() => {
    void loadJobs();
    void loadBuilderContext();
  }, [loadJobs, loadBuilderContext]);

  useEffect(() => {
    if (!clusterId || needsDeployment) return;
    return openSSE(`/api/v1/nomad/${clusterId}/watch?topics=jobs`, {
      onEvent: (ev) => {
        if (ev === 'change') void loadJobs();
      },
    });
  }, [clusterId, loadJobs, needsDeployment]);

  const clearPlan = () => {
    planRequestRef.current++;
    setPlan(null);
    setValidationWarnings([]);
    setPreflightErrors([]);
    setIgnorePreflight(false);
  };

  const changeMode = async (next: 'hcl' | 'visual' | 'json') => {
    if (next === editMode) return;
    if (!isAdmin) {
      setEditMode(next);
      return;
    }
    const request = ++modeRequestRef.current;
    setModeBusy(true);
    clearPlan();
    setErr('');
    try {
      let current = hcl;
      if (editMode === 'visual' && visualRef.current) current = (await visualRef.current.flush()).hcl;
      if (next === 'json') {
        const parsed = await apiPost(`/api/v1/nomad/${clusterId}/job-ops/validate`, {
          input_type: 'hcl',
          hcl: current,
          variables: jobVariables,
          namespace: effectiveBuilderNamespace,
        });
        if (request !== modeRequestRef.current) return;
        formatCacheRef.current = { hcl: current, variables: jobVariables, json: JSON.stringify(parsed.job) };
        setHcl(JSON.stringify(parsed.job, null, 2));
      } else if (editMode === 'json') {
        const job = JSON.parse(hcl);
        const cached = formatCacheRef.current;
        if (cached && cached.json === JSON.stringify(job)) {
          setHcl(cached.hcl);
          setJobVariables(cached.variables);
        } else {
          const parsed = await apiPost(`/api/v1/nomad/${clusterId}/job-ops/json-to-visual`, { job_json: job });
          if (request !== modeRequestRef.current) return;
          if (!parsed.lossless || !parsed.hcl) {
            throw new Error(tr('该 JSON 含有无法完整转换的字段，请继续使用 JSON 编辑，避免丢失配置', 'This JSON contains fields that cannot convert cleanly; keep using JSON mode to avoid losing config'));
          }
          setHcl(parsed.hcl);
          setJobVariables({});
        }
      } else {
        if (request !== modeRequestRef.current) return;
        setHcl(current);
      }
      if (request !== modeRequestRef.current) return;
      if (next === 'visual') setVisualReady(false);
      setEditMode(next);
    } catch (ex: any) {
      if (request === modeRequestRef.current) setErr(ex?.message || tr('无法切换编辑模式', 'Failed to switch editor mode'));
    } finally {
      if (request === modeRequestRef.current) setModeBusy(false);
    }
  };

  const jobInput = async () => {
    let current = hcl;
    if (editMode === 'visual' && visualRef.current) {
      const result = await visualRef.current.flush();
      if (!result.valid) {
        throw new Error(result.diagnostics.map((issue) => issue.message).join(tr('；', '; ')) || tr('请先完成积木配置', 'Please complete visual builder fields first'));
      }
      current = result.hcl;
    }
    return editMode === 'json'
      ? { input_type: 'json', job_json: JSON.parse(current), namespace: effectiveBuilderNamespace, edit_mode: 'json' }
      : { input_type: 'hcl', hcl: current, variables: jobVariables, namespace: effectiveBuilderNamespace, edit_mode: 'hcl' };
  };

  const validateJob = async () => {
    setErr('');
    setValidationWarnings([]);
    setPreflightErrors([]);
    try {
      const res = await apiPost(`/api/v1/nomad/${clusterId}/job-ops/validate`, await jobInput());
      const warns = String(res.warnings || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const preErrs = Array.isArray(res.preflight_errors) ? (res.preflight_errors as string[]).filter(Boolean) : [];
      const preChecks = Array.isArray(res.preflight_checks) ? (res.preflight_checks as PreflightCheck[]) : [];
      setValidationWarnings(warns);
      setPreflightErrors(preErrs);
      setPreflightChecks(preChecks);
      setPreflightCheckErr('');
      if (preErrs.length > 0) {
        toast.error(tr(`环境前置检查未通过：发现 ${preErrs.length} 项阻塞问题`, `Preflight checks failed: ${preErrs.length} blocker(s) found`));
      } else if (warns.length > 0) {
        toast.info(tr(`Job 语法校验通过，但有 ${warns.length} 条提醒请查看`, `Job syntax valid, with ${warns.length} warning(s)`));
      } else {
        toast.success(tr('Job 校验通过', 'Job validation passed'));
      }
    } catch (ex: any) {
      setErr(ex?.message || tr('校验失败', 'Validation failed'));
    }
  };

  const runLivePreflight = useCallback(async () => {
    if (!clusterId || needsDeployment || !hcl.trim()) {
      setPreflightChecks([]);
      setPreflightCheckErr('');
      return;
    }
    const req = ++preflightReqRef.current;
    setPreflightLoading(true);
    setPreflightCheckErr('');
    try {
      let payload: Record<string, any>;
      if (editMode === 'json') {
        payload = { input_type: 'json', job_json: JSON.parse(hcl), namespace: effectiveBuilderNamespace, edit_mode: 'json' };
      } else {
        payload = { input_type: 'hcl', hcl, variables: jobVariables, namespace: effectiveBuilderNamespace, edit_mode: 'hcl' };
      }
      const res = await apiPost(`/api/v1/nomad/${clusterId}/job-ops/validate`, payload);
      if (req !== preflightReqRef.current) return;
      setPreflightChecks(Array.isArray(res.preflight_checks) ? (res.preflight_checks as PreflightCheck[]) : []);
    } catch (ex: any) {
      if (req !== preflightReqRef.current) return;
      setPreflightChecks([]);
      setPreflightCheckErr(ex?.message || tr('前置体检暂不可用', 'Preflight check unavailable'));
    } finally {
      if (req === preflightReqRef.current) setPreflightLoading(false);
    }
  }, [clusterId, needsDeployment, hcl, editMode, jobVariables, effectiveBuilderNamespace, tr]);

  const runPreviewPreflight = useCallback(
    async (target: { hcl: string } | null) => {
      if (!target || !clusterId || needsDeployment || !target.hcl.trim()) {
        setPreviewChecks([]);
        setPreviewErr('');
        return;
      }
      const req = ++previewReqRef.current;
      setPreviewLoading(true);
      setPreviewErr('');
      try {
        const res = await apiPost(`/api/v1/nomad/${clusterId}/job-ops/validate`, {
          input_type: 'hcl',
          hcl: target.hcl,
          namespace: effectiveBuilderNamespace,
          edit_mode: 'hcl',
        });
        if (req !== previewReqRef.current) return;
        setPreviewChecks(Array.isArray(res.preflight_checks) ? (res.preflight_checks as PreflightCheck[]) : []);
      } catch (ex: any) {
        if (req !== previewReqRef.current) return;
        setPreviewChecks([]);
        setPreviewErr(ex?.message || tr('前置体检暂不可用', 'Preflight check unavailable'));
      } finally {
        if (req === previewReqRef.current) setPreviewLoading(false);
      }
    },
    [clusterId, needsDeployment, effectiveBuilderNamespace, tr],
  );

  useEffect(() => {
    if (pageTab !== 'builder' || !clusterId || needsDeployment || !hcl.trim()) {
      return;
    }
    const timer = window.setTimeout(() => {
      void runLivePreflight();
    }, 450);
    return () => window.clearTimeout(timer);
  }, [pageTab, clusterId, needsDeployment, hcl, editMode, effectiveBuilderNamespace, runLivePreflight]);

  useEffect(() => {
    if (!previewTarget) return;
    void runPreviewPreflight(previewTarget);
  }, [previewTarget, runPreviewPreflight]);

  const handleFixAction = (action: PreflightFixAction) => {
    if (action.type === 'vault_role') {
      setRoleFixAction(action);
    } else if (action.type === 'vault_kv') {
      setKvFixAction(action);
    }
  };

  const handleFixCompleted = async () => {
    await loadBuilderContext();
    if (previewTarget) {
      await runPreviewPreflight(previewTarget);
    }
    if (pageTab === 'builder') {
      await runLivePreflight();
    }
  };

  const insertVaultIntoJob = async () => {
    if (!clusterId || vaultWizardBusy) return;
    setVaultWizardBusy(true);
    setErr('');
    try {
      let current = hcl;
      if (editMode === 'visual' && visualRef.current) {
        current = (await visualRef.current.flush()).hcl;
      }
      if (editMode === 'json') {
        throw new Error(tr('JSON 模式下请先切换回可视化编排或原生 HCL 后再插入', 'Switch from JSON mode to Visual or HCL mode before inserting'));
      }
      const treeRes = await apiPost<{ document: HCLDocument }>(`/api/v1/nomad/${clusterId}/job-ops/hcl-tree`, { hcl: current });
      const doc = treeRes.document;
      let firstTaskPath: NodePath | null = null;
      const walk = (nodes: HCLDocument['nodes'], path: NodePath) => {
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          const here = [...path, i];
          if (n.kind === 'block' && n.name === 'task') {
            firstTaskPath = here;
            return;
          }
          if (n.body) {
            walk(n.body.nodes, here);
            if (firstTaskPath) return;
          }
        }
      };
      walk(doc.nodes, []);
      if (!firstTaskPath) {
        throw new Error(tr('当前 HCL 中未找到 task 块，请先添加 task 块或复制下方片段手动粘贴', 'No task block found in current HCL; add a task block first or copy the snippet below'));
      }
      const parsed = parseKVPath(vaultWizard.secretPath, 'secret', locale);
      const keys = vaultWizard.keys
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const templateData = buildTemplateData(parsed.templatePath, keys, vaultWizard.mode);
      const updated = applyVaultToTask(doc, firstTaskPath, {
        role: vaultWizard.role.trim() || 'default',
        templateData,
        mode: vaultWizard.mode,
        fileName: vaultWizard.fileName,
        envVarName: vaultWizard.envVarName,
      });
      const rendered = await apiPost<{ hcl: string }>(`/api/v1/nomad/${clusterId}/job-ops/hcl-tree-render`, updated);
      setHcl(rendered.hcl);
      clearPlan();
      setShowVaultWizard(false);
      toast.success(tr('已将 vault 与 template 配置插入第一个 Task，可点击「1. 校验配置」核对', 'Inserted vault and template config into first Task; click "1. Validate" to verify'));
    } catch (ex: any) {
      toast.error(ex?.message || tr('插入 Vault 密钥配置失败', 'Failed to insert Vault secret config'));
    } finally {
      setVaultWizardBusy(false);
    }
  };

  const runPlan = async () => {
    if (!clusterId) return;
    setErr('');
    setPreflightErrors([]);
    setIgnorePreflight(false);
    try {
      const input = await jobInput();
      const request = ++planRequestRef.current;
      const res = await apiPost(`/api/v1/nomad/${clusterId}/job-ops/plan`, input);
      if (request === planRequestRef.current) {
        setPlan(res.plan);
        if (Array.isArray(res.plan?.preflight_checks)) {
          setPreflightChecks(res.plan.preflight_checks as PreflightCheck[]);
          setPreflightCheckErr('');
        }
        const pre = Array.isArray(res.plan?.preflight_errors) ? res.plan.preflight_errors : [];
        const sched = Array.isArray(res.plan?.scheduling_errors) ? res.plan.scheduling_errors : [];
        if (pre.length > 0 || sched.length > 0) {
          toast.error(tr('当前集群环境或调度条件不满足，请查看预览中的阻塞原因', 'Cluster environment or scheduling constraints not met; check blockers in plan'));
        }
      }
    } catch (ex: any) {
      setErr(ex?.message || tr('Plan 失败', 'Plan failed'));
    }
  };

  const runApply = async () => {
    if (!clusterId || !plan?.plan_id) return;
    setErr('');
    const targetJobId = plan.job_id || selectedJobId;
    const targetNs = plan.namespace || effectiveBuilderNamespace;
    try {
      await apiPost(`/api/v1/nomad/${clusterId}/job-ops/apply`, {
        plan_id: plan.plan_id,
        ignore_preflight: ignorePreflight,
      });
      clearPlan();
      toast.success(tr(`Job「${targetJobId || '任务'}」已提交运行`, `Job "${targetJobId || 'job'}" submitted`));
      await loadJobs();
      if (targetJobId) {
        setInspectingJob({ id: targetJobId, namespace: targetNs });
        updatePageTab('list');
      }
    } catch (ex: any) {
      setErr(ex?.message || tr('Apply 失败', 'Apply failed'));
    }
  };

  const loadJobForEdit = useCallback(
    async (j: { id: string; namespace?: string }, preferredMode?: 'visual' | 'hcl', opts?: { replaceHistory?: boolean }) => {
      const request = ++editRequestRef.current;
      modeRequestRef.current++;
      setModeBusy(false);
      formatCacheRef.current = null;
      const ns = j.namespace || effectiveBuilderNamespace;
      setSelectedJobId(j.id);
      setActiveBlueprintId('');
      setActiveCustomTemplateDesc('');
      updatePageTab('builder', { replace: opts?.replaceHistory });
      clearPlan();
      setHcl('');
      setJobVariables({});
      setErr('');
      try {
        const [src, rev] = await Promise.all([
          apiGet(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(ns)}/jobs/${encodeURIComponent(j.id)}/edit-source`),
          apiGet(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(ns)}/jobs/${encodeURIComponent(j.id)}/revisions`),
        ]);
        if (request !== editRequestRef.current) return;
        const source = src.source;
        if (source?.hcl) {
          setHcl(source.hcl);
          setEditMode(preferredMode || (isAdmin ? 'visual' : 'hcl'));
        } else if (source?.job) {
          setHcl(JSON.stringify(source.job, null, 2));
          setEditMode('json');
        } else {
          setHcl('');
          setErr(tr('该 Job 没有可用的编辑定义', 'No editable definition available for this Job'));
        }
        setJobVariables(source?.variables || {});
        setNamespace(ns);
        if (source?.drifted && source?.reason) toast.info(source.reason);
        setRevisions(rev.revisions || []);
      } catch (ex: any) {
        if (request === editRequestRef.current) setErr(ex?.message || tr('读取 Job 编辑源码失败', 'Failed to load Job edit source'));
      }
    },
    [clusterId, effectiveBuilderNamespace, isAdmin, updatePageTab],
  );

  // Handle URL deep links (?job=...&tab=runtime|builder)
  useEffect(() => {
    if (!queryJobId || queryFrom === 'integration' || !selectedCluster || needsDeployment) return;
    const targetNs = queryNamespace || (namespace === '*' ? 'default' : namespace) || 'default';
    if (queryTab === 'runtime') {
      setInspectingJob({ id: queryJobId, namespace: targetNs });
      updatePageTab('list', { replace: true });
    } else {
      void loadJobForEdit({ id: queryJobId, namespace: targetNs }, undefined, { replaceHistory: true });
    }
  }, [queryJobId, queryTab, queryFrom, selectedCluster, needsDeployment, loadJobForEdit, namespace, updatePageTab]);

  const namespaceOptions = useMemo(() => {
    const set = new Set<string>(clusterNamespaces.length > 0 ? clusterNamespaces : ['default']);
    if (namespace && namespace !== '*') set.add(namespace);
    return Array.from(set);
  }, [clusterNamespaces, namespace]);

  // Track active starter blueprint (either exact match or the blueprint currently being customized)
  const activeSample = useMemo(
    () =>
      selectedJobId
        ? null
        : STARTER_SAMPLES.find((sample) => sample.hcl === hcl) ||
          (activeBlueprintId ? STARTER_SAMPLES.find((sample) => sample.id === activeBlueprintId) || null : null),
    [hcl, selectedJobId, activeBlueprintId],
  );

  const planBlockingReasons = useMemo(() => {
    if (!plan) return [] as string[];
    const list = [
      ...(Array.isArray(plan.preflight_errors) ? (plan.preflight_errors as string[]) : []),
      ...(Array.isArray(plan.scheduling_errors) ? (plan.scheduling_errors as string[]) : []),
    ].filter(Boolean);
    return Array.from(new Set(list));
  }, [plan]);

  const jobStats = useMemo(() => {
    let running = 0;
    let pending = 0;
    let stopped = 0;
    for (const j of jobs) {
      if (j.stop || j.status === 'dead') stopped++;
      else if (j.status === 'running') running++;
      else pending++;
    }
    return { total: jobs.length, running, pending, stopped };
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return jobs.filter((j) => {
      const effectiveStatus = j.stop || j.status === 'dead' ? 'stopped' : j.status === 'running' ? 'running' : 'pending';
      if (statusFilter !== 'all' && effectiveStatus !== statusFilter) return false;
      if (!q) return true;
      return (
        String(j.id || '').toLowerCase().includes(q) ||
        String(j.namespace || '').toLowerCase().includes(q) ||
        String(j.type || '').toLowerCase().includes(q)
      );
    });
  }, [jobs, searchQuery, statusFilter]);

  const filteredTemplates = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) => String(t.name || '').toLowerCase().includes(q));
  }, [templates, searchQuery]);

  const filteredBlueprints = useMemo(() => {
    const query = blueprintQuery.trim().toLowerCase();
    if (!query) return STARTER_SAMPLES;
    return STARTER_SAMPLES.filter((sample) =>
      [getBlueprintLabel(sample, locale), getBlueprintDesc(sample, locale), ...getBlueprintTags(sample, locale)]
        .join(' ').toLowerCase().includes(query),
    );
  }, [blueprintQuery, locale]);

  if (loadingClusters) return <LoadingState label={tr('正在加载 Job 工作区…', 'Loading Job workspace...')} />;

  if (!clusters.length) {
    return (
      <div className="space-y-5">
        <PageHeader title={tr('Nomad Job 中心', 'Nomad Job Center')} subtitle={tr('统一管理工作负载运行态、可视化编排、日志终端与模板复用', 'Manage workload runtime, visual composer, logs/exec, and reusable blueprints')} />
        <ErrorAlert message={err} onClose={() => setErr('')} />
        <Card>
          <EmptyState
            icon={<Boxes className="h-6 w-6" />}
            title={tr('先搭建一个 Nomad 集群', 'Set up a Nomad cluster first')}
            description={tr('Job 需要在 Nomad Client 上运行。集群部署完成后，即可在这里可视化编排并运行第一个任务。', 'Jobs run on Nomad Clients. Once a cluster is deployed, you can visually compose and run your first job here.')}
            action={
              <Link to="/nomad" className="primary-button">
                {tr('前往 Nomad 集群', 'Go to Nomad Clusters')}
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  const loadDraftIntoComposer = (
    nextHcl: string,
    mode?: 'visual' | 'hcl',
    meta?: { blueprintId?: string; customDescription?: string },
  ) => {
    setSelectedJobId('');
    setRevisions([]);
    setHcl(nextHcl);
    setJobVariables({});
    setActiveBlueprintId(meta?.blueprintId || STARTER_SAMPLES.find((s) => s.hcl === nextHcl)?.id || '');
    setActiveCustomTemplateDesc(meta?.customDescription || '');
    clearPlan();
    if (mode) {
      setEditMode(mode);
    } else if (editMode === 'json') {
      setEditMode(isAdmin ? 'visual' : 'hcl');
    }
    updatePageTab('builder');
  };

  const startFreshDraft = () => {
    loadDraftIntoComposer(sampleHCL, isAdmin ? 'visual' : 'hcl', { blueprintId: STARTER_SAMPLES[0].id });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={tr('Nomad Job 中心', 'Nomad Job Center')}
        subtitle={tr('一站式完成工作负载运行监控、日志终端排障、可视化编排与模板复用', 'Unified workload runtime monitoring, live logs & shell exec, visual composer, and templates')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => {
                void loadClusters();
                void loadJobs();
              }}
            >
              <RefreshCw className="h-4 w-4" />
              <span>{tr('刷新', 'Refresh')}</span>
            </Button>
            {isAdmin && clusterId && (
              <>
                <Button
                  onClick={() =>
                    void apiDownload(
                      `/api/v1/nomad/${clusterId}/job-ops/export`,
                      { namespace: effectiveBuilderNamespace },
                      'nomad-jobs.zip',
                    ).catch((ex) => toast.error(ex.message))
                  }
                >
                  <Download className="h-4 w-4" />
                  <span>{tr('导出 HCL', 'Export HCL')}</span>
                </Button>
                <Button variant="primary" onClick={startFreshDraft}>
                  <FilePlus2 className="h-4 w-4" />
                  <span>{tr('新建任务', 'New Job')}</span>
                </Button>
              </>
            )}
          </div>
        }
      />

      {/* Cluster + Namespace + 3-Tab Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <ItemSwitcher
            label={tr('Nomad 集群', 'Nomad Cluster')}
            selectedId={clusterId}
            disabled={modeBusy || (pageTab === 'builder' && editMode === 'visual' && !visualReady)}
            onSelect={(id) => {
              setClusterId(id);
              setInspectingJob(null);
              clearPlan();
            }}
            items={clusters.map((c) => ({
              id: c.id,
              name: c.name,
              status: c.init_state === 'uninitialized' ? 'uninitialized' : c.health_status,
            }))}
          />
          <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <span className="shrink-0">{tr('命名空间', 'Namespace')}</span>
            <div className="w-40">
              <Select
                aria-label={tr('任务命名空间', 'Job Namespace')}
                size="sm"
                value={pageTab === 'builder' ? effectiveBuilderNamespace : namespace}
                disabled={modeBusy || (pageTab === 'builder' && editMode === 'visual' && !visualReady)}
                onChange={(e) => {
                  setNamespace(e.target.value);
                  setInspectingJob(null);
                  clearPlan();
                }}
              >
                {pageTab === 'list' && <option value="*">{tr('全部 Namespace (*)', 'All Namespaces (*)')}</option>}
                {namespaceOptions.map((ns) => (
                  <option key={ns} value={ns}>
                    {ns}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </div>

        <SectionTabs
          tabs={[
            { id: 'list', label: tr('运行态 Jobs', 'Runtime Jobs'), badge: jobs.length },
            {
              id: 'builder',
              label: selectedJobId ? tr(`编排工作台 · ${selectedJobId}`, `Composer · ${selectedJobId}`) : tr('编排工作台', 'Composer'),
            },
            { id: 'templates', label: tr('模板库', 'Templates'), badge: STARTER_SAMPLES.length + templates.length },
          ]}
          active={pageTab}
          onChange={(next) => {
            const nextTab = next as JobCenterTab;
            updatePageTab(nextTab);
            if (nextTab === 'list') void loadJobs();
          }}
        />
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {needsDeployment && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200"
        >
          <p>{tr(`「${selectedCluster.name}」尚未部署。可以先编写配置，部署完成后再校验和运行。`, `"${selectedCluster.name}" is not deployed yet. You can draft configs now and validate or apply once deployed.`)}</p>
          <Link to={`/nomad?id=${clusterId}`} className="primary-button">
            {tr('前往部署集群', 'Deploy Cluster')}
          </Link>
        </div>
      )}

      {/* TAB 1: RUNTIME JOBS LIST OR INLINE RUNTIME PANEL */}
      {pageTab === 'list' &&
        (inspectingJob ? (
          <JobRuntimePanel
            clusterId={clusterId}
            job={inspectingJob}
            onBack={() => {
              setInspectingJob(null);
              void loadJobs();
            }}
            onEdit={(j) => void loadJobForEdit(j)}
            onChanged={() => void loadJobs()}
            onDeleted={() => {
              setInspectingJob(null);
              void loadJobs();
            }}
          />
        ) : (
          <div className="space-y-4">
            {/* Compact Status Filter + Search Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  { id: 'all', label: tr('全部', 'All'), count: jobStats.total },
                  { id: 'running', label: tr('运行中', 'Running'), count: jobStats.running },
                  { id: 'pending', label: tr('等待中', 'Pending'), count: jobStats.pending },
                  { id: 'stopped', label: tr('已停止', 'Stopped'), count: jobStats.stopped },
                ].map((f) => {
                  const active = statusFilter === f.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setStatusFilter(f.id as typeof statusFilter)}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
                        active
                          ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-500/20 dark:text-indigo-200'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
                      }`}
                    >
                      <span>{f.label}</span>
                      <span className="font-mono text-[11px] opacity-75">{f.count}</span>
                    </button>
                  );
                })}
              </div>

              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={tr('搜索 Job 名称、类型或命名空间…', 'Search job name, type, or namespace...')}
                  className="w-full rounded-xl border border-slate-200 bg-white py-1.5 pl-9 pr-3 text-xs text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <Card
              title={tr(`运行态 Jobs (${filteredJobs.length})`, `Runtime Jobs (${filteredJobs.length})`)}
              description={tr('点击任意 Job 名称或「运行态」可直接查看副本状态、实时日志、资源监控、文件浏览器与 Web 终端', 'Click any job name or "Runtime" to inspect allocations, live logs, metrics, files, and Web Exec')}
            >
              {jobs.length === 0 ? (
                <EmptyState
                  title={tr('当前命名空间暂无运行中的 Job', 'No jobs in this namespace')}
                  description={tr('内置 Nginx、PostgreSQL + Vault、Redis + Vault 等开箱蓝图，一键即可可视化编排并提交运行。', 'Built-in blueprints like Nginx, PostgreSQL + Vault, and Redis + Vault are ready for one-click visual composition.')}
                  action={
                    isAdmin ? (
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button size="sm" variant="primary" onClick={startFreshDraft}>
                          <FilePlus2 className="h-3.5 w-3.5" />
                          <span>{tr('可视化新建任务', 'New Visual Job')}</span>
                        </Button>
                        <Button size="sm" onClick={() => updatePageTab('templates')}>
                          <Sparkles className="h-3.5 w-3.5" />
                          <span>{tr('浏览场景蓝图', 'Browse Blueprints')}</span>
                        </Button>
                      </div>
                    ) : undefined
                  }
                />
              ) : filteredJobs.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-400 dark:text-slate-500">{tr('没有符合筛选条件的任务', 'No jobs match the current filter')}</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[620px] text-left text-xs whitespace-nowrap">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                        <th className="py-2.5 pr-4 font-medium">{tr('Job 名称', 'Job Name')}</th>
                        <th className="py-2.5 pr-4 font-medium">{tr('运行状态', 'Status')}</th>
                        <th className="py-2.5 pr-4 font-medium">{tr('类型', 'Type')}</th>
                        <th className="py-2.5 pr-4 font-medium">{tr('命名空间', 'Namespace')}</th>
                        <th className="py-2.5 text-right font-medium">{tr('操作', 'Actions')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                      {filteredJobs.map((j) => {
                        const jobNs = j.namespace || effectiveBuilderNamespace;
                        const isEditing = selectedJobId === j.id;
                        return (
                          <tr key={`${jobNs}:${j.id}`} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30">
                            <td className="py-3 pr-4">
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => setInspectingJob({ ...j, namespace: jobNs })}
                                  title={tr('查看 Allocations、实时日志与终端', 'Inspect Allocations, live logs, and terminal')}
                                  className="font-mono text-[13px] font-semibold text-slate-900 hover:text-indigo-600 hover:underline dark:text-slate-100 dark:hover:text-indigo-400 text-left"
                                >
                                  {j.id}
                                </button>
                                {isEditing && <Badge tone="blue">{tr('编排中', 'Editing')}</Badge>}
                              </div>
                            </td>
                            <td className="py-3 pr-4">
                              <StatusBadge value={j.stop ? 'stopped' : j.status} />
                            </td>
                            <td className="py-3 pr-4 text-slate-600 dark:text-slate-300">{j.type || 'service'}</td>
                            <td className="py-3 pr-4 font-mono text-slate-600 dark:text-slate-300">{jobNs}</td>
                            <td className="py-3 text-right">
                              <div className="flex flex-wrap items-center justify-end gap-1.5">
                                <Button
                                  size="sm"
                                  variant="primary"
                                  onClick={() => setInspectingJob({ ...j, namespace: jobNs })}
                                >
                                  <Activity className="h-3.5 w-3.5" />
                                  <span>{tr('运行态', 'Runtime')}</span>
                                </Button>
                                {isAdmin && (
                                  <Button size="sm" onClick={() => void loadJobForEdit({ id: j.id, namespace: jobNs })}>
                                    <Pencil className="h-3.5 w-3.5" />
                                    <span>{tr('编排编辑', 'Edit')}</span>
                                  </Button>
                                )}
                                {isAdmin && (
                                  <>
                                    <button
                                      type="button"
                                      title={tr('启动 Job', 'Start Job')}
                                      aria-label={tr(`启动 ${j.id}`, `Start ${j.id}`)}
                                      disabled={!j.stop}
                                      onClick={() =>
                                        void apiPost(
                                          `/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(jobNs)}/jobs/${encodeURIComponent(j.id)}/start`,
                                          {},
                                        )
                                          .then(() => {
                                            toast.success(tr(`已启动 Job ${j.id}`, `Started Job ${j.id}`));
                                            return loadJobs();
                                          })
                                          .catch((ex) => setErr(ex.message))
                                      }
                                      className="rounded-lg p-1.5 text-slate-400 transition hover:bg-emerald-50 hover:text-emerald-600 disabled:opacity-35 disabled:pointer-events-none dark:hover:bg-emerald-500/15 dark:hover:text-emerald-400"
                                    >
                                      <Play className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      title={tr('停止 Job', 'Stop Job')}
                                      aria-label={tr(`停止 ${j.id}`, `Stop ${j.id}`)}
                                      disabled={j.stop}
                                      onClick={async () => {
                                        if (
                                          !(await askConfirm(tr(`确认停止运行中的 Job「${j.id}」（Namespace: ${jobNs}）吗？`, `Stop running Job "${j.id}" (Namespace: ${jobNs})?`), {
                                            title: tr('停止 Job', 'Stop Job'),
                                            confirmText: tr('确认停止', 'Stop'),
                                            danger: true,
                                          }))
                                        ) {
                                          return;
                                        }
                                        void apiPost(
                                          `/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(jobNs)}/jobs/${encodeURIComponent(j.id)}/stop`,
                                          {},
                                        )
                                          .then(() => {
                                            toast.success(tr(`已停止 Job ${j.id}`, `Stopped Job ${j.id}`));
                                            return loadJobs();
                                          })
                                          .catch((ex) => setErr(ex.message));
                                      }}
                                      className="rounded-lg p-1.5 text-slate-400 transition hover:bg-amber-50 hover:text-amber-600 disabled:opacity-35 disabled:pointer-events-none dark:hover:bg-amber-500/15 dark:hover:text-amber-400"
                                    >
                                      <Square className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      title={tr('清理并彻底删除 Job', 'Purge and delete Job')}
                                      aria-label={tr(`清理 ${j.id}`, `Purge ${j.id}`)}
                                      onClick={async () => {
                                        if (
                                          !(await askConfirm(tr(`确认清理并彻底删除 Job「${j.id}」（Namespace: ${jobNs}）吗？`, `Purge and permanently delete Job "${j.id}" (Namespace: ${jobNs})?`), {
                                            title: tr('清理删除 Job', 'Purge Job'),
                                            confirmText: tr('确认 Purge', 'Purge'),
                                            danger: true,
                                          }))
                                        ) {
                                          return;
                                        }
                                        void apiPost(
                                          `/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(jobNs)}/jobs/${encodeURIComponent(j.id)}/purge`,
                                          { confirm_job_id: j.id },
                                        )
                                          .then(() => {
                                            toast.success(tr(`已清理 Job ${j.id}`, `Purged Job ${j.id}`));
                                            if (selectedJobId === j.id) setSelectedJobId('');
                                            return loadJobs();
                                          })
                                          .catch((ex) => setErr(ex.message));
                                      }}
                                      className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15 dark:hover:text-rose-400"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        ))}

      {/* TAB 2: VISUAL / HCL / JSON JOB COMPOSER */}
      {pageTab === 'builder' && (
        <Card
          className="min-w-0"
          title={
            <div className="flex flex-wrap items-center gap-2">
              <span>{tr('编排工作台', 'Job Composer')}</span>
              <Badge tone={selectedJobId ? 'blue' : 'neutral'}>
                {selectedJobId ? tr(`编辑运行中任务：${selectedJobId}`, `Editing job: ${selectedJobId}`) : tr('新建任务草稿', 'New job draft')}
              </Badge>
            </div>
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {selectedJobId && !needsDeployment && (
                <Button
                  size="sm"
                  onClick={() => {
                    setInspectingJob({ id: selectedJobId, namespace: effectiveBuilderNamespace });
                    updatePageTab('list');
                  }}
                >
                  <Activity className="h-3.5 w-3.5" />
                  <span>{tr(`查看 ${selectedJobId} 运行态`, `View ${selectedJobId} Runtime`)}</span>
                </Button>
              )}
              {isAdmin && (
                <>
                  <Button size="sm" disabled={needsDeployment} onClick={() => setShowVaultWizard(true)}>
                    <KeyRound className="h-3.5 w-3.5" />
                    <span>{tr('插入 Vault 密钥', 'Insert Vault Secret')}</span>
                  </Button>
                  <Button size="sm" onClick={() => setShowCompose(true)}>
                    {tr('Compose 导入', 'Import Compose')}
                  </Button>
                </>
              )}
            </div>
          }
        >
          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <SectionTabs
                variant="underline"
                tabs={[
                  ...(isAdmin ? [{ id: 'visual', label: tr('可视化编排', 'Visual Builder'), title: tr('所见即所得的卡片式表单 + 高级结构树 + 实时 HCL 分栏预览', 'WYSIWYG card forms + advanced AST tree + live HCL preview') }] : []),
                  { id: 'hcl', label: tr('原生 HCL', 'Native HCL'), title: tr('Nomad 原生 HashiCorp Configuration Language 声明式任务定义', 'Native Nomad HashiCorp Configuration Language job spec') },
                  { id: 'json', label: tr('JSON 定义', 'JSON Spec') },
                ]}
                active={editMode}
                onChange={(m) => {
                  void changeMode(m as 'hcl' | 'visual' | 'json');
                }}
              />
              {isAdmin && (
                <div className="flex items-center gap-2">
                  <span className="text-slate-400 dark:text-slate-500 shrink-0">{tr('快速载入蓝图', 'Load Blueprint')}</span>
                  <div className="w-48">
                    <Select
                      aria-label={tr('选择入门示例', 'Select starter blueprint')}
                      size="sm"
                      value={activeSample?.id || ''}
                      onChange={(e) => {
                        const found = STARTER_SAMPLES.find((s) => s.id === e.target.value);
                        if (!found) return;
                        loadDraftIntoComposer(found.hcl, undefined, { blueprintId: found.id });
                      }}
                    >
                      <option value="">{tr('选择场景示例…', 'Select a blueprint...')}</option>
                      {STARTER_SAMPLES.map((s) => (
                        <option key={s.id} value={s.id}>
                          {getBlueprintLabel(s, locale)}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              )}
            </div>

            {activeSample && (
              <p className="rounded-lg bg-slate-50 px-3 py-1.5 text-[11px] text-slate-600 dark:bg-slate-950/50 dark:text-slate-400">
                {tr('当前蓝图：', 'Current blueprint: ')}{getBlueprintDesc(activeSample, locale)}
              </p>
            )}

            <JobPreflightPanel
              checks={preflightChecks}
              loading={preflightLoading}
              error={preflightCheckErr}
              blueprint={activeSample}
              customDescription={activeCustomTemplateDesc}
              clusterName={selectedCluster?.name}
              needsDeployment={needsDeployment}
              isAdmin={isAdmin}
              onRefresh={() => void runLivePreflight()}
              onFixAction={handleFixAction}
            />

            <JobUsagePanel
              source={hcl}
              clusterId={clusterId}
              namespace={effectiveBuilderNamespace}
              inputType={editMode === 'json' ? 'json' : 'hcl'}
              isAdmin={isAdmin}
            />

            {editMode === 'visual' ? (
              <VisualJobBuilder
                ref={visualRef}
                clusterId={clusterId}
                source={hcl}
                readOnly={!isAdmin}
                onSourceChange={(value) => {
                  setHcl(value);
                  clearPlan();
                }}
                onValidityChange={(valid) => {
                  setVisualReady(valid);
                  if (!valid) clearPlan();
                }}
              />
            ) : (
              <CodeEditor
                value={hcl}
                onChange={(value) => {
                  setHcl(value);
                  clearPlan();
                }}
                readOnly={!isAdmin}
                height="480px"
              />
            )}

            {/* 3-Step Validate -> Plan -> Apply Action Bar */}
            {isAdmin && (
              <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-white px-3.5 py-2.5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    placeholder={tr('输入名称保存为模板…', 'Template name...')}
                    value={tplName}
                    onChange={(e) => setTplName(e.target.value)}
                    className="w-40 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                  <input
                    placeholder={tr('前置/用途说明（可选）', 'Prerequisites / note (optional)')}
                    value={tplDesc}
                    onChange={(e) => setTplDesc(e.target.value)}
                    className="w-48 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                  <Button
                    size="sm"
                    disabled={!tplName.trim() || modeBusy || editMode === 'json' || (editMode === 'visual' && !visualReady)}
                    onClick={() =>
                      tplName.trim() &&
                      void apiPost('/api/v1/job-templates', {
                        name: tplName.trim(),
                        description: tplDesc.trim(),
                        edit_mode: 'hcl',
                        hcl,
                      })
                        .then(() => {
                          setTplName('');
                          setTplDesc('');
                          toast.success(tr('模板已保存至模板库', 'Saved to template library'));
                          return loadClusters();
                        })
                        .catch((ex) => setErr(ex.message))
                    }
                  >
                    {tr('存为模板', 'Save Template')}
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {plan?.plan_id && <Badge tone="blue">{tr('计划已生成', 'Plan Generated')}</Badge>}
                  <Button
                    size="sm"
                    disabled={needsDeployment || modeBusy || (editMode === 'visual' && !visualReady)}
                    onClick={() => void validateJob()}
                  >
                    {tr('1. 校验配置', '1. Validate')}
                  </Button>
                  <Button
                    size="sm"
                    variant={plan ? 'secondary' : 'primary'}
                    disabled={needsDeployment || modeBusy || (editMode === 'visual' && !visualReady)}
                    onClick={() => void runPlan()}
                  >
                    {tr('2. 预览计划', '2. Plan')}
                  </Button>
                  <Button
                    size="sm"
                    variant={
                      plan?.plan_id && (planBlockingReasons.length === 0 || ignorePreflight) ? 'primary' : 'secondary'
                    }
                    disabled={
                      !plan?.plan_id ||
                      needsDeployment ||
                      modeBusy ||
                      (planBlockingReasons.length > 0 && !ignorePreflight)
                    }
                    title={
                      !plan?.plan_id
                        ? tr('请先点击「2. 预览计划」生成执行计划', 'Click "2. Plan" first to generate an execution plan')
                        : planBlockingReasons.length > 0 && !ignorePreflight
                          ? tr('当前集群环境或调度条件未满足，请先处理问题或勾选忽略检查', 'Cluster environment or scheduling checks failed; resolve blockers or check ignore')
                          : tr('确认将任务提交至 Nomad 集群运行并跳转查看运行态', 'Submit job to Nomad cluster and open runtime view')
                    }
                    onClick={() => void runApply()}
                  >
                    <Play className="h-3.5 w-3.5" />
                    <span>{tr('3. 确认运行', '3. Apply')}</span>
                  </Button>
                </div>
              </div>
            )}

            {preflightErrors.length > 0 && (
              <div
                role="alert"
                className="rounded-xl border border-rose-300 bg-rose-50/90 p-3 text-xs text-rose-950 space-y-1 dark:border-rose-500/40 dark:bg-rose-950/35 dark:text-rose-100"
              >
                <div className="font-semibold">{tr('环境前置检查未通过（当前无法在该集群调度运行）：', 'Preflight checks failed (cannot schedule on this cluster):')}</div>
                {preflightErrors.map((msg, idx) => (
                  <p key={idx} className="leading-5">
                    • {msg}
                  </p>
                ))}
              </div>
            )}

            {validationWarnings.length > 0 && (
              <div
                role="alert"
                className="rounded-xl border border-amber-300 bg-amber-50/90 p-3 text-xs text-amber-950 space-y-1 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
              >
                <div className="font-semibold">{tr('校验提醒（含 Nomad-Vault 联动核对）：', 'Validation warnings (including Nomad-Vault checks):')}</div>
                {validationWarnings.map((w, idx) => (
                  <p key={idx} className="leading-5">
                    • {w}
                  </p>
                ))}
              </div>
            )}

            {plan && (
              <div className="space-y-2.5 rounded-xl border border-indigo-200/90 bg-indigo-50/40 p-4 dark:border-indigo-500/40 dark:bg-indigo-950/30">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-indigo-950 dark:text-indigo-100">
                      {tr('调度变更预览 · 请核对后点击上方「3. 确认运行」', 'Plan Preview · Review and click "3. Apply" above')}
                    </span>
                    <Badge tone="blue">
                      {({
                        Added: tr('创建任务', 'Create Job'),
                        Edited: tr('更新任务', 'Update Job'),
                        None: tr('配置无变化', 'No Changes'),
                        Deleted: tr('删除任务', 'Delete Job'),
                      } as Record<string, string>)[plan.diff?.Type] || tr('配置变更', 'Config Diff')}
                    </Badge>
                  </div>
                  <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400" title={plan.plan_id}>
                    Plan #{String(plan.plan_id || '').slice(0, 8)}
                  </span>
                </div>
                <p className="leading-5 text-slate-700 dark:text-slate-200">
                  {tr('任务', 'Job')} <code className="font-mono font-semibold">{plan.job_id}</code> · {tr('命名空间', 'Namespace')}{' '}
                  <code className="font-mono">{plan.namespace}</code>
                </p>
                {(plan.warnings || plan.validation_warnings) && (() => {
                  const lines = Array.from(
                    new Set(
                      [plan.validation_warnings, plan.warnings]
                        .filter(Boolean)
                        .flatMap((block) => String(block).split('\n').map((s) => s.trim()))
                        .filter(Boolean),
                    ),
                  );
                  return lines.length > 0 ? (
                    <p role="alert" className="whitespace-pre-wrap text-amber-700 dark:text-amber-300">
                      {lines.join('\n')}
                    </p>
                  ) : null;
                })()}
                {planBlockingReasons.length > 0 && (
                  <div
                    role="alert"
                    className="rounded-xl border border-rose-300 bg-rose-50/90 p-3 text-xs text-rose-950 space-y-2 dark:border-rose-500/40 dark:bg-rose-950/35 dark:text-rose-100"
                  >
                    <div className="font-semibold">{tr('环境或调度检查未通过（已阻止直接提交）：', 'Environment or scheduling checks failed (submission blocked):')}</div>
                    <div className="space-y-1">
                      {planBlockingReasons.map((msg, idx) => (
                        <p key={idx} className="leading-5">
                          • {msg}
                        </p>
                      ))}
                    </div>
                    <label className="flex items-center gap-2 pt-1 border-t border-rose-200/80 dark:border-rose-500/30 cursor-pointer text-rose-900 dark:text-rose-200">
                      <input
                        type="checkbox"
                        checked={ignorePreflight}
                        onChange={(e) => setIgnorePreflight(e.target.checked)}
                      />
                      <span>{tr('忽略环境与调度检查，仍强行提交为待调度状态（pending）', 'Ignore environment & scheduling checks and force submit as pending')}</span>
                    </label>
                  </div>
                )}
                <details>
                  <summary className="cursor-pointer py-1 font-medium text-indigo-700 dark:text-indigo-300">
                    {tr('查看调度变更详情', 'View plan diff details')}
                  </summary>
                  <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-slate-950 p-2.5 font-mono text-[11px] text-slate-100">
                    {JSON.stringify(
                      { plan_id: plan.plan_id, diff: plan.diff, failed_tg_allocs: plan.failed_tg_allocs },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </div>
            )}

            {revisions.length > 0 && selectedJobId && (
              <details className="rounded-xl border border-slate-200/80 bg-slate-50/50 p-3 dark:border-slate-800 dark:bg-slate-950/40">
                <summary className="cursor-pointer font-semibold text-slate-700 dark:text-slate-200">
                  {tr(`历史修订记录：${selectedJobId}（${revisions.length} 条）`, `Revision History: ${selectedJobId} (${revisions.length})`)}
                </summary>
                <div className="mt-2.5 space-y-1.5">
                  {revisions.slice(0, 8).map((rv) => (
                    <div
                      key={rv.id}
                      className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-900"
                    >
                      <span>
                        v{rv.revision_no} · {rv.source} · {rv.submit_status} · {fmtTime(rv.created_at, locale)}
                      </span>
                      {isAdmin && rv.remote_job_version != null && (
                        <Button
                          size="sm"
                          onClick={() =>
                            void apiPost(
                              `/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(effectiveBuilderNamespace)}/jobs/${encodeURIComponent(selectedJobId)}/revert`,
                              { version: rv.remote_job_version },
                            )
                              .then(() => toast.success(tr('已回滚 Job 版本', 'Job version reverted')))
                              .catch((ex) => setErr(ex.message))
                          }
                        >
                          <RotateCcw className="h-3 w-3" /> {tr('回滚', 'Revert')}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </Card>
      )}

      {/* TAB 3: BLUEPRINTS & CUSTOM TEMPLATES */}
      {pageTab === 'templates' && (
        <div className="space-y-5">
          <Card
            title={tr(`内置场景蓝图 (${STARTER_SAMPLES.length})`, `Starter Blueprints (${STARTER_SAMPLES.length})`)}
            description={tr('点击即可载入可视化编排工作台，快速修改镜像、端口、资源与 Vault 密钥并运行', 'Click to load into Visual Composer to customize image, ports, resources, and Vault secrets')}
          >
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <div className="relative w-full sm:max-w-sm">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  aria-label={tr('搜索内置蓝图', 'Search starter blueprints')}
                  placeholder={tr('搜索名称、用途或标签，如 Vault、网关…', 'Search names, descriptions or tags...')}
                  value={blueprintQuery}
                  onChange={(e) => setBlueprintQuery(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </div>
              <span role="status" className="text-xs text-slate-500 dark:text-slate-400">
                {tr(`${filteredBlueprints.length} / ${STARTER_SAMPLES.length} 个蓝图`, `${filteredBlueprints.length} / ${STARTER_SAMPLES.length} blueprints`)}
              </span>
            </div>
            {filteredBlueprints.length === 0 && (
              <EmptyState
                title={tr('没有匹配的蓝图', 'No matching blueprints')}
                description={tr('尝试其他名称、用途或 Docker、Vault 等标签。', 'Try another name, description or a tag such as Docker or Vault.')}
                action={<Button size="sm" onClick={() => setBlueprintQuery('')}>{tr('清除筛选', 'Clear search')}</Button>}
              />
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 text-xs">
              {filteredBlueprints.map((s) => {
                const reqs = getBlueprintRequires(s, locale);
                return (
                  <div
                    key={s.id}
                    className="flex flex-col justify-between gap-3 rounded-xl border border-slate-200/90 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-950/40"
                  >
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-sm text-slate-900 dark:text-slate-100">{getBlueprintLabel(s, locale)}</span>
                        <div className="flex flex-wrap gap-1">
                          {getBlueprintTags(s, locale).map((tag) => (
                            <Badge key={tag} tone={tag === 'Vault' ? 'green' : tag === 'Docker' ? 'blue' : 'neutral'}>
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <p className="leading-5 text-slate-500 dark:text-slate-400">{getBlueprintDesc(s, locale)}</p>
                      {reqs.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          <span className="text-[11px] text-slate-400 dark:text-slate-500">{tr('前置：', 'Requires:')}</span>
                          {reqs.map((req, idx) => (
                            <span
                              key={idx}
                              className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
                                req.kind === 'vault'
                                  ? 'border-emerald-200 bg-emerald-50/80 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
                                  : req.kind === 'port'
                                    ? 'border-amber-200 bg-amber-50/80 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
                                    : req.kind === 'driver'
                                      ? 'border-indigo-200 bg-indigo-50/70 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300'
                                      : 'border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
                              }`}
                            >
                              {req.label}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 border-t border-slate-200/70 pt-3 dark:border-slate-800">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => loadDraftIntoComposer(s.hcl, isAdmin ? 'visual' : 'hcl', { blueprintId: s.id })}
                      >
                        <LayoutGrid className="h-3.5 w-3.5" />
                        <span>{tr('可视化编排', 'Visual Builder')}</span>
                      </Button>
                      <Button size="sm" onClick={() => loadDraftIntoComposer(s.hcl, 'hcl', { blueprintId: s.id })}>
                        {tr('HCL 源码', 'Edit HCL')}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() =>
                          setPreviewTarget({
                            title: getBlueprintLabel(s, locale),
                            hcl: s.hcl,
                            blueprint: s,
                          })
                        }
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        <span>{tr('前置体检', 'Preflight')}</span>
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => setPreviewTarget({ title: getBlueprintLabel(s, locale), hcl: s.hcl, blueprint: s, connectionGuide: true })}
                      >
                        <BookOpen className="h-3.5 w-3.5" />
                        <span>{tr('连接与使用', 'Connect & Use')}</span>
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card
            title={tr(`自定义模板库 (${templates.length})`, `Custom Templates (${templates.length})`)}
            actions={
              templates.length > 0 && (
                <div className="relative w-52">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={tr('筛选模板名称…', 'Filter templates...')}
                    className="w-full rounded-lg border border-slate-200 bg-white py-1 pl-8 pr-2.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                </div>
              )
            }
          >
            {templates.length === 0 ? (
              <EmptyState
                title={tr('暂无自定义模板', 'No custom templates')}
                description={tr('在「编排工作台」底部输入模板名称并点击「存为模板」，方便团队一键复用。', 'Enter a template name at the bottom of the Composer and click "Save Template" for reuse.')}
              />
            ) : filteredTemplates.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">{tr('没有匹配的模板', 'No matching templates')}</div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs">
                {filteredTemplates.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/90 bg-slate-50/50 p-3.5 dark:border-slate-800 dark:bg-slate-900/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold text-slate-800 dark:text-slate-100">{t.name}</div>
                      <div className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400" title={t.description || ''}>
                        {t.description || tr('自定义 HCL 模板', 'Custom HCL Template')}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        onClick={() =>
                          setPreviewTarget({
                            title: t.name,
                            hcl: t.hcl || '',
                            customDescription: t.description || '',
                          })
                        }
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        <span>{tr('体检', 'Check')}</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() =>
                          loadDraftIntoComposer(t.hcl || '', isAdmin ? 'visual' : 'hcl', {
                            customDescription: t.description || '',
                          })
                        }
                      >
                        {tr('载入编排', 'Load')}
                      </Button>
                      {isAdmin && (
                        <button
                          type="button"
                          title={tr('删除模板', 'Delete template')}
                          aria-label={tr(`删除模板 ${t.name}`, `Delete template ${t.name}`)}
                          onClick={async () => {
                            if (
                              !(await askConfirm(tr(`确认删除 Job 模板「${t.name}」吗？`, `Delete job template "${t.name}"?`), {
                                title: tr('删除模板', 'Delete Template'),
                                confirmText: tr('确认删除', 'Delete'),
                                danger: true,
                              }))
                            ) {
                              return;
                            }
                            void apiDelete(`/api/v1/job-templates/${t.id}`)
                              .then(() => {
                                toast.success(tr(`已删除模板 ${t.name}`, `Deleted template ${t.name}`));
                                return loadClusters();
                              })
                              .catch((ex) => setErr(ex.message));
                          }}
                          className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15 dark:hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Docker Compose Import Modal */}
      <Modal open={showCompose} title={tr('导入 Docker Compose 转 HCL', 'Import Docker Compose to HCL')} onClose={() => setShowCompose(false)} wide>
        <div className="space-y-3 text-xs">
          <CodeEditor value={composeText} onChange={setComposeText} height="260px" />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setShowCompose(false)}>{tr('取消', 'Cancel')}</Button>
            <Button
              variant="primary"
              onClick={() =>
                void apiPost(`/api/v1/nomad/${clusterId}/job-ops/compose-convert`, { compose: composeText })
                  .then((r) => {
                    if (r.hcl) loadDraftIntoComposer(r.hcl, isAdmin ? 'visual' : 'hcl');
                    setShowCompose(false);
                    toast.success(tr('已转换为 Nomad HCL 并载入编排工作台', 'Converted to Nomad HCL and loaded into composer'));
                  })
                  .catch((ex) => setErr(ex.message))
              }
            >
              {tr('转换并载入工作台', 'Convert & Load')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Vault Secret Wizard Modal */}
      <Modal open={showVaultWizard} title={tr('插入 Vault 密钥读取模板', 'Insert Vault Secret Template')} onClose={() => setShowVaultWizard(false)} wide>
        {(() => {
          const parsed = parseKVPath(vaultWizard.secretPath, 'secret', locale);
          const keys = vaultWizard.keys
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const snippet = buildTaskVaultSnippet({
            role: vaultWizard.role,
            secretPath: vaultWizard.secretPath,
            keys,
            mode: vaultWizard.mode,
            fileName: vaultWizard.fileName,
            envVarName: vaultWizard.envVarName,
          });
          const pickedRole = vaultRoles.find((r) => r.role === vaultWizard.role);
          return (
            <div className="space-y-3 text-xs">
              {vaultIntegrations.length === 0 ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
                  {tr('当前 Nomad 集群尚未创建 Nomad-Vault 联动。可先前往 ', 'No Nomad-Vault integration configured for this cluster yet. Visit ')}
                  <Link to="/integrations" className="font-semibold underline">
                    {tr('集群联动', 'Integrations')}
                  </Link>
                  {tr(' 创建并应用。', ' to create and apply one.')}
                </div>
              ) : vaultIntegrations.some((ig) => ig.status !== 'applied') ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
                  {tr('检测到联动尚未应用生效，请记得在 ', 'Integration is not applied yet. Remember to click "Apply" in ')}
                  <Link to="/integrations" className="font-semibold underline">
                    {tr('集群联动', 'Integrations')}
                  </Link>
                  {tr(' 点击「应用联动」后再运行 Job。', ' before running this Job.')}
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Input
                    label={tr('Vault Role 名称', 'Vault Role Name')}
                    list="jc-vault-role-list"
                    value={vaultWizard.role}
                    onChange={(e) => {
                      const val = e.target.value;
                      const matched = vaultRoles.find((r) => r.role === val);
                      setVaultWizard((prev) => ({
                        ...prev,
                        role: val,
                        secretPath: matched?.secret_paths?.[0] || prev.secretPath,
                      }));
                    }}
                    placeholder={tr('例如 postgres', 'e.g. postgres')}
                  />
                  <datalist id="jc-vault-role-list">
                    {vaultRoles.map((r) => (
                      <option key={r.role} value={r.role} />
                    ))}
                  </datalist>
                  {pickedRole && (
                    <p className="text-[11px] text-slate-500">
                      {tr('状态：', 'Status: ')}
                      {pickedRole.status === 'applied' ? tr('已应用', 'Applied') : tr('草稿（待应用）', 'Draft (Pending)')}
                      {tr(' · 允许 Namespace：', ' · Allowed Namespace: ')}
                      <code className="font-mono">{pickedRole.namespace || 'default'}</code>
                    </p>
                  )}
                </div>
                <Input
                  label={tr('Secret 路径（自动补全 /data/）', 'Secret Path (auto /data/)')}
                  value={vaultWizard.secretPath}
                  onChange={(e) => setVaultWizard((prev) => ({ ...prev, secretPath: e.target.value }))}
                  placeholder={tr('例如 secret/apps/postgres', 'e.g. secret/apps/postgres')}
                  hint={tr(`模板读取路径：${parsed.templatePath || 'secret/data/apps/demo'}`, `Template path: ${parsed.templatePath || 'secret/data/apps/demo'}`)}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  label={tr('密钥注入方式', 'Secret Injection Mode')}
                  value={vaultWizard.mode}
                  onChange={(e) => setVaultWizard((prev) => ({ ...prev, mode: e.target.value as 'env' | 'file' }))}
                >
                  <option value="env">{tr('注入为容器环境变量（env = true）', 'Container environment variables (env = true)')}</option>
                  <option value="file">{tr('挂载为 0600 密码文件（/secrets/xxx）', 'Mount as 0600 secret file (/secrets/xxx)')}</option>
                </Select>
                <Input
                  label={
                    vaultWizard.mode === 'file'
                      ? tr('提取字段名（留空则写入完整 JSON）', 'Secret key (leave blank for full JSON)')
                      : tr('提取字段名（逗号分隔，留空则注入全部字段）', 'Secret keys (comma-separated, blank for all)')
                  }
                  value={vaultWizard.keys}
                  onChange={(e) => setVaultWizard((prev) => ({ ...prev, keys: e.target.value }))}
                  placeholder={vaultWizard.mode === 'file' ? tr('例如 password', 'e.g. password') : tr('例如 username, password', 'e.g. username, password')}
                />
              </div>

              {vaultWizard.mode === 'file' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    label={tr('容器内密码文件名（/secrets/ 下）', 'Secret filename in container (/secrets/)')}
                    value={vaultWizard.fileName}
                    onChange={(e) => setVaultWizard((prev) => ({ ...prev, fileName: e.target.value }))}
                  />
                  <Input
                    label={tr('指向该文件的环境变量名', 'Env var pointing to file')}
                    value={vaultWizard.envVarName}
                    onChange={(e) => setVaultWizard((prev) => ({ ...prev, envVarName: e.target.value }))}
                  />
                </div>
              )}

              <div>
                <div className="mb-1 font-semibold text-slate-700 dark:text-slate-200">{tr('生成代码预览（放入 task 块内）', 'Generated HCL Preview (inside task block)')}</div>
                <CodeEditor value={snippet} readOnly height="200px" />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    void copyText(snippet)
                      .then(() => toast.success(tr('已复制代码片段', 'Snippet copied')))
                      .catch((ex) => toast.error(ex.message))
                  }
                >
                  <Copy className="h-3.5 w-3.5" />
                  <span>{tr('仅复制片段', 'Copy Snippet')}</span>
                </Button>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setShowVaultWizard(false)}>
                    {tr('取消', 'Cancel')}
                  </Button>
                  <Button size="sm" variant="primary" loading={vaultWizardBusy} onClick={() => void insertVaultIntoJob()}>
                    {tr('插入当前 Job 第一个 Task', 'Insert into First Task')}
                  </Button>
                </div>
              </div>
            </div>
          );
        })()}
      </Modal>
      {/* Template Library Live Preflight Preview Modal */}
      <Modal
        open={Boolean(previewTarget)}
        title={
          previewTarget
            ? tr(`模板指引 · ${previewTarget.title}`, `Template Guide · ${previewTarget.title}`)
            : ''
        }
        onClose={() => setPreviewTarget(null)}
        wide
      >
        {previewTarget && (
          <div className="space-y-4 text-xs">
            {previewTarget.blueprint && (
              <p className="leading-5 text-slate-600 dark:text-slate-300">
                {getBlueprintDesc(previewTarget.blueprint, locale)}
              </p>
            )}
            <JobPreflightPanel
              checks={previewChecks}
              loading={previewLoading}
              error={previewErr}
              blueprint={previewTarget.blueprint}
              customDescription={previewTarget.customDescription}
              clusterName={selectedCluster?.name}
              needsDeployment={needsDeployment}
              isAdmin={isAdmin}
              defaultExpanded={!previewTarget.connectionGuide}
              onRefresh={() => void runPreviewPreflight(previewTarget)}
              onFixAction={handleFixAction}
            />
            <JobUsagePanel
              source={previewTarget.hcl}
              clusterId={clusterId}
              namespace={effectiveBuilderNamespace}
              isAdmin={isAdmin}
              defaultExpanded={previewTarget.connectionGuide}
            />
            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200/70 pt-3 dark:border-slate-800">
              <Button size="sm" onClick={() => setPreviewTarget(null)}>
                {tr('关闭', 'Close')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const target = previewTarget;
                  setPreviewTarget(null);
                  loadDraftIntoComposer(target.hcl, 'hcl', {
                    blueprintId: target.blueprint?.id,
                    customDescription: target.customDescription,
                  });
                }}
              >
                {tr('载入 HCL 源码', 'Load HCL')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  const target = previewTarget;
                  setPreviewTarget(null);
                  loadDraftIntoComposer(target.hcl, isAdmin ? 'visual' : 'hcl', {
                    blueprintId: target.blueprint?.id,
                    customDescription: target.customDescription,
                  });
                }}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                <span>{tr('载入可视化编排', 'Load in Visual Builder')}</span>
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <VaultRoleQuickFixModal
        open={Boolean(roleFixAction)}
        action={roleFixAction}
        clusterMode={selectedCluster?.mode}
        onClose={() => setRoleFixAction(null)}
        onFixed={handleFixCompleted}
      />

      <VaultKVQuickFixModal
        open={Boolean(kvFixAction)}
        action={kvFixAction}
        secretHints={previewTarget?.blueprint?.secretHints || activeSample?.secretHints}
        onClose={() => setKvFixAction(null)}
        onFixed={handleFixCompleted}
      />
    </div>
  );
}
