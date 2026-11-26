import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
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
import {
  JOB_CENTER_CLUSTER_KEY,
  readStoredSelection,
  resolveClusterSelection,
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

const STARTER_SAMPLES: Array<{ id: string; label: string; tags: string[]; desc: string; hcl: string }> = [
  {
    id: 'docker',
    label: 'Nginx 容器服务',
    tags: ['Docker', '入门'],
    desc: '标准 Docker Web 容器示例，无需额外前置配置即可在 Nomad Client 运行',
    hcl: `job "hello" {
  datacenters = ["dc1"]
  type        = "service"

  group "app" {
    count = 1
    task "server" {
      driver = "docker"
      config {
        image = "nginx:alpine"
      }
      resources {
        cpu    = 100
        memory = 128
      }
    }
  }
}
`,
  },
  {
    id: 'postgres',
    label: 'PostgreSQL + Vault 密钥',
    tags: ['Docker', 'Vault', '数据库'],
    desc: '需先配置 postgres Role 与 secret/apps/postgres（username、password、database），自动挂载 0600 密码文件与环境变量',
    hcl: `job "postgres" {
  datacenters = ["dc1"]
  type        = "service"

  group "database" {
    count = 1
    network {
      port "db" {
        static = 5432
        to     = 5432
      }
    }

    # 数据保留在当前 Allocation，重新调度前需配置持久卷与备份。
    ephemeral_disk {
      size   = 1024
      sticky = true
    }

    task "postgres" {
      driver = "docker"
      config {
        image   = "postgres:17-bookworm"
        ports   = ["db"]
        volumes = ["local/pgdata:/var/lib/postgresql/data"]
      }

      vault {
        role = "postgres"
        env  = false
      }

      env {
        POSTGRES_PASSWORD_FILE = "/secrets/postgres-password"
      }

      template {
        destination = "secrets/postgres-password"
        perms       = "0600"
        change_mode = "noop"
        data        = <<EOT
{{ with secret "secret/data/apps/postgres" }}{{ .Data.data.password }}{{ end }}
EOT
      }

      template {
        destination = "secrets/postgres.env"
        env         = true
        data        = <<EOT
{{ with secret "secret/data/apps/postgres" }}
POSTGRES_USER={{ .Data.data.username | toJSON }}
POSTGRES_DB={{ .Data.data.database | toJSON }}
{{ end }}
EOT
      }

      resources {
        cpu    = 200
        memory = 256
      }
    }
  }
}
`,
  },
  {
    id: 'redis',
    label: 'Redis + Vault 密钥',
    tags: ['Docker', 'Vault', '缓存'],
    desc: '需先配置 redis Role 与 secret/apps/redis（含 password 字段），通过 0600 内存密码文件安全注入 requirepass',
    hcl: `job "redis" {
  datacenters = ["dc1"]
  type        = "service"

  group "cache" {
    count = 1
    network {
      port "redis" {
        static = 6379
        to     = 6379
      }
    }

    ephemeral_disk {
      size   = 512
      sticky = true
    }

    task "redis" {
      driver = "docker"
      config {
        image      = "redis:7-alpine"
        ports      = ["redis"]
        entrypoint = ["/bin/sh", "-c"]
        args       = ["exec docker-entrypoint.sh redis-server --bind 0.0.0.0 --port 6379 --appendonly yes --requirepass \\"$(cat /secrets/redis-password)\\""]
      }

      vault {
        role = "redis"
        env  = false
      }

      template {
        destination = "secrets/redis-password"
        perms       = "0600"
        change_mode = "restart"
        data        = <<EOT
{{ with secret "secret/data/apps/redis" }}{{ .Data.data.password }}{{ end }}
EOT
      }

      resources {
        cpu    = 150
        memory = 128
      }
    }
  }
}
`,
  },
  {
    id: 'raw_exec',
    label: 'Shell 守护脚本',
    tags: ['raw_exec', '轻量'],
    desc: '无需 Docker，直接在节点运行轻量脚本（需先在节点插件配置中开启 raw_exec 驱动）',
    hcl: `job "hello-shell" {
  datacenters = ["dc1"]
  type        = "service"

  group "app" {
    count = 1
    task "echo" {
      driver = "raw_exec"
      config {
        command = "/bin/sh"
        args    = ["-c", "while true; do echo 'NomadDeck hello at '$(date); sleep 15; done"]
      }
      resources {
        cpu    = 50
        memory = 64
      }
    }
  }
}
`,
  },
  {
    id: 'batch',
    label: '一次性批处理任务',
    tags: ['batch', 'raw_exec'],
    desc: '执行完即退出的短任务示例，可搭配定时周期调度（需开启 raw_exec 驱动）',
    hcl: `job "hello-batch" {
  datacenters = ["dc1"]
  type        = "batch"

  group "job" {
    count = 1
    task "run" {
      driver = "raw_exec"
      config {
        command = "/bin/sh"
        args    = ["-c", "echo 'Batch task finished on '$(hostname); uname -a"]
      }
      resources {
        cpu    = 50
        memory = 32
      }
    }
  }
}
`,
  },
];

const sampleHCL = STARTER_SAMPLES[0].hcl;

export function JobCenterPage() {
  const { isAdmin } = useAuth();
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
  const [pageTab, setPageTab] = useState<'list' | 'builder' | 'templates'>(() => {
    if (queryFrom === 'integration') return 'builder';
    if (queryTab === 'templates') return 'templates';
    if (queryTab === 'builder') return 'builder';
    if (queryTab === 'runtime') return 'list';
    return queryJobId ? 'builder' : 'list';
  });

  // Currently inspected Job in Runtime Detail view (inside 'list' tab)
  const [inspectingJob, setInspectingJob] = useState<JobRuntimeRef | null>(() =>
    queryJobId && queryTab === 'runtime'
      ? { id: queryJobId, namespace: queryNamespace || 'default' }
      : null,
  );
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'pending' | 'stopped'>('all');
  const [searchQuery, setSearchQuery] = useState('');

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
  const [ignorePreflight, setIgnorePreflight] = useState(false);
  const [revisions, setRevisions] = useState<any[]>([]);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [tplName, setTplName] = useState('');
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
          setPageTab('builder');
        }
        window.sessionStorage.removeItem(INTEGRATION_DRAFT_JOB_STORAGE_KEY);
        toast.info(
          `已载入联动示例（Role: ${draft?.roleName || 'default'}），核对后请依次点击「1. 校验配置 → 2. 预览计划 → 3. 确认运行」`,
        );
      }
    } catch {
      // Ignore malformed sessionStorage drafts.
    }
    const next = new URLSearchParams(searchParams);
    next.delete('from');
    setSearchParams(next, { replace: true });
  }, [queryFrom]);

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
      setErr(ex?.message || '加载集群或模板列表失败');
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
      setErr(ex?.message || '加载 Job 列表失败');
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
            throw new Error('该 JSON 含有无法完整转换的字段，请继续使用 JSON 编辑，避免丢失配置');
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
      if (request === modeRequestRef.current) setErr(ex?.message || '无法切换编辑模式');
    } finally {
      if (request === modeRequestRef.current) setModeBusy(false);
    }
  };

  const jobInput = async () => {
    let current = hcl;
    if (editMode === 'visual' && visualRef.current) {
      const result = await visualRef.current.flush();
      if (!result.valid) {
        throw new Error(result.diagnostics.map((issue) => issue.message).join('；') || '请先完成积木配置');
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
      setValidationWarnings(warns);
      setPreflightErrors(preErrs);
      if (preErrs.length > 0) {
        toast.error(`环境前置检查未通过：发现 ${preErrs.length} 项阻塞问题`);
      } else if (warns.length > 0) {
        toast.info(`Job 语法校验通过，但有 ${warns.length} 条提醒请查看`);
      } else {
        toast.success('Job 校验通过');
      }
    } catch (ex: any) {
      setErr(ex?.message || '校验失败');
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
        throw new Error('JSON 模式下请先切换回可视化编排或原生 HCL 后再插入');
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
        throw new Error('当前 HCL 中未找到 task 块，请先添加 task 块或复制下方片段手动粘贴');
      }
      const parsed = parseKVPath(vaultWizard.secretPath);
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
      toast.success('已将 vault 与 template 配置插入第一个 Task，可点击「1. 校验配置」核对');
    } catch (ex: any) {
      toast.error(ex?.message || '插入 Vault 密钥配置失败');
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
        const pre = Array.isArray(res.plan?.preflight_errors) ? res.plan.preflight_errors : [];
        const sched = Array.isArray(res.plan?.scheduling_errors) ? res.plan.scheduling_errors : [];
        if (pre.length > 0 || sched.length > 0) {
          toast.error('当前集群环境或调度条件不满足，请查看预览中的阻塞原因');
        }
      }
    } catch (ex: any) {
      setErr(ex?.message || 'Plan 失败');
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
      toast.success(`Job「${targetJobId || '任务'}」已提交运行`);
      await loadJobs();
      if (targetJobId) {
        setInspectingJob({ id: targetJobId, namespace: targetNs });
        setPageTab('list');
      }
    } catch (ex: any) {
      setErr(ex?.message || 'Apply 失败');
    }
  };

  const loadJobForEdit = useCallback(
    async (j: { id: string; namespace?: string }, preferredMode?: 'visual' | 'hcl') => {
      const request = ++editRequestRef.current;
      modeRequestRef.current++;
      setModeBusy(false);
      formatCacheRef.current = null;
      const ns = j.namespace || effectiveBuilderNamespace;
      setSelectedJobId(j.id);
      setPageTab('builder');
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
          setErr('该 Job 没有可用的编辑定义');
        }
        setJobVariables(source?.variables || {});
        setNamespace(ns);
        if (source?.drifted && source?.reason) toast.info(source.reason);
        setRevisions(rev.revisions || []);
      } catch (ex: any) {
        if (request === editRequestRef.current) setErr(ex?.message || '读取 Job 编辑源码失败');
      }
    },
    [clusterId, effectiveBuilderNamespace, isAdmin],
  );

  // Handle URL deep links (?job=...&tab=runtime|builder)
  useEffect(() => {
    if (!queryJobId || queryFrom === 'integration' || !selectedCluster || needsDeployment) return;
    const targetNs = queryNamespace || (namespace === '*' ? 'default' : namespace) || 'default';
    if (queryTab === 'runtime') {
      setInspectingJob({ id: queryJobId, namespace: targetNs });
      setPageTab('list');
    } else {
      void loadJobForEdit({ id: queryJobId, namespace: targetNs });
    }
    const next = new URLSearchParams(searchParams);
    next.delete('job');
    next.delete('tab');
    setSearchParams(next, { replace: true });
  }, [queryJobId, queryTab, queryFrom, selectedCluster, needsDeployment, loadJobForEdit]);

  const namespaceOptions = useMemo(() => {
    const set = new Set<string>(clusterNamespaces.length > 0 ? clusterNamespaces : ['default']);
    if (namespace && namespace !== '*') set.add(namespace);
    return Array.from(set);
  }, [clusterNamespaces, namespace]);

  // Only show starter match when creating a fresh draft (never falsely match a live job being edited)
  const activeSample = useMemo(
    () => (selectedJobId ? null : STARTER_SAMPLES.find((sample) => sample.hcl === hcl) || null),
    [hcl, selectedJobId],
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

  if (loadingClusters) return <LoadingState label="正在加载 Job 工作区…" />;

  if (!clusters.length) {
    return (
      <div className="space-y-5">
        <PageHeader title="Nomad Job 中心" subtitle="统一管理工作负载运行态、可视化编排、日志终端与模板复用" />
        <ErrorAlert message={err} onClose={() => setErr('')} />
        <Card>
          <EmptyState
            icon={<Boxes className="h-6 w-6" />}
            title="先搭建一个 Nomad 集群"
            description="Job 需要在 Nomad Client 上运行。集群部署完成后，即可在这里可视化编排并运行第一个任务。"
            action={
              <Link to="/nomad" className="primary-button">
                前往 Nomad 集群
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  const loadDraftIntoComposer = (nextHcl: string, mode?: 'visual' | 'hcl') => {
    setSelectedJobId('');
    setRevisions([]);
    setHcl(nextHcl);
    setJobVariables({});
    clearPlan();
    if (mode) {
      setEditMode(mode);
    } else if (editMode === 'json') {
      setEditMode(isAdmin ? 'visual' : 'hcl');
    }
    setPageTab('builder');
  };

  const startFreshDraft = () => {
    loadDraftIntoComposer(sampleHCL, isAdmin ? 'visual' : 'hcl');
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Nomad Job 中心"
        subtitle="一站式完成工作负载运行监控、日志终端排障、可视化编排与模板复用"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => {
                void loadClusters();
                void loadJobs();
              }}
            >
              <RefreshCw className="h-4 w-4" />
              <span>刷新</span>
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
                  <span>导出 HCL</span>
                </Button>
                <Button variant="primary" onClick={startFreshDraft}>
                  <FilePlus2 className="h-4 w-4" />
                  <span>新建任务</span>
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
            label="Nomad 集群"
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
            <span className="shrink-0">命名空间</span>
            <div className="w-40">
              <Select
                aria-label="任务命名空间"
                size="sm"
                value={pageTab === 'builder' ? effectiveBuilderNamespace : namespace}
                disabled={modeBusy || (pageTab === 'builder' && editMode === 'visual' && !visualReady)}
                onChange={(e) => {
                  setNamespace(e.target.value);
                  setInspectingJob(null);
                  clearPlan();
                }}
              >
                {pageTab === 'list' && <option value="*">全部 Namespace (*)</option>}
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
            { id: 'list', label: '运行态 Jobs', badge: jobs.length },
            {
              id: 'builder',
              label: selectedJobId ? `编排工作台 · ${selectedJobId}` : '编排工作台',
            },
            { id: 'templates', label: '模板库', badge: STARTER_SAMPLES.length + templates.length },
          ]}
          active={pageTab}
          onChange={(next) => {
            setPageTab(next as 'list' | 'builder' | 'templates');
            if (next === 'list') void loadJobs();
          }}
        />
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {needsDeployment && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200"
        >
          <p>「{selectedCluster.name}」尚未部署。可以先编写配置，部署完成后再校验和运行。</p>
          <Link to={`/nomad?id=${clusterId}`} className="primary-button">
            前往部署集群
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
                  { id: 'all', label: '全部', count: jobStats.total },
                  { id: 'running', label: '运行中', count: jobStats.running },
                  { id: 'pending', label: '等待中', count: jobStats.pending },
                  { id: 'stopped', label: '已停止', count: jobStats.stopped },
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
                  placeholder="搜索 Job 名称、类型或命名空间…"
                  className="w-full rounded-xl border border-slate-200 bg-white py-1.5 pl-9 pr-3 text-xs text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <Card
              title={`运行态 Jobs (${filteredJobs.length})`}
              description="点击任意 Job 名称或「运行态」可直接查看副本状态、实时日志、资源监控、文件浏览器与 Web 终端"
            >
              {jobs.length === 0 ? (
                <EmptyState
                  title="当前命名空间暂无运行中的 Job"
                  description="内置 Nginx、PostgreSQL + Vault、Redis + Vault 等开箱蓝图，一键即可可视化编排并提交运行。"
                  action={
                    isAdmin ? (
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button size="sm" variant="primary" onClick={startFreshDraft}>
                          <FilePlus2 className="h-3.5 w-3.5" />
                          <span>可视化新建任务</span>
                        </Button>
                        <Button size="sm" onClick={() => setPageTab('templates')}>
                          <Sparkles className="h-3.5 w-3.5" />
                          <span>浏览场景蓝图</span>
                        </Button>
                      </div>
                    ) : undefined
                  }
                />
              ) : filteredJobs.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-400 dark:text-slate-500">没有符合筛选条件的任务</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[620px] text-left text-xs whitespace-nowrap">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                        <th className="py-2.5 pr-4 font-medium">Job 名称</th>
                        <th className="py-2.5 pr-4 font-medium">运行状态</th>
                        <th className="py-2.5 pr-4 font-medium">类型</th>
                        <th className="py-2.5 pr-4 font-medium">命名空间</th>
                        <th className="py-2.5 text-right font-medium">操作</th>
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
                                  title="查看 Allocations、实时日志与终端"
                                  className="font-mono text-[13px] font-semibold text-slate-900 hover:text-indigo-600 hover:underline dark:text-slate-100 dark:hover:text-indigo-400 text-left"
                                >
                                  {j.id}
                                </button>
                                {isEditing && <Badge tone="blue">编排中</Badge>}
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
                                  <span>运行态</span>
                                </Button>
                                {isAdmin && (
                                  <Button size="sm" onClick={() => void loadJobForEdit({ id: j.id, namespace: jobNs })}>
                                    <Pencil className="h-3.5 w-3.5" />
                                    <span>编排编辑</span>
                                  </Button>
                                )}
                                {isAdmin && (
                                  <>
                                    <button
                                      type="button"
                                      title="启动 Job"
                                      aria-label={`启动 ${j.id}`}
                                      disabled={!j.stop}
                                      onClick={() =>
                                        void apiPost(
                                          `/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(jobNs)}/jobs/${encodeURIComponent(j.id)}/start`,
                                          {},
                                        )
                                          .then(() => {
                                            toast.success(`已启动 Job ${j.id}`);
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
                                      title="停止 Job"
                                      aria-label={`停止 ${j.id}`}
                                      disabled={j.stop}
                                      onClick={async () => {
                                        if (
                                          !(await askConfirm(`确认停止运行中的 Job「${j.id}」（Namespace: ${jobNs}）吗？`, {
                                            title: '停止 Job',
                                            confirmText: '确认停止',
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
                                            toast.success(`已停止 Job ${j.id}`);
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
                                      title="清理并彻底删除 Job"
                                      aria-label={`清理 ${j.id}`}
                                      onClick={async () => {
                                        if (
                                          !(await askConfirm(`确认清理并彻底删除 Job「${j.id}」（Namespace: ${jobNs}）吗？`, {
                                            title: '清理删除 Job',
                                            confirmText: '确认 Purge',
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
                                            toast.success(`已清理 Job ${j.id}`);
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
              <span>编排工作台</span>
              <Badge tone={selectedJobId ? 'blue' : 'neutral'}>
                {selectedJobId ? `编辑运行中任务：${selectedJobId}` : '新建任务草稿'}
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
                    setPageTab('list');
                  }}
                >
                  <Activity className="h-3.5 w-3.5" />
                  <span>查看 {selectedJobId} 运行态</span>
                </Button>
              )}
              {isAdmin && (
                <>
                  <Button size="sm" disabled={needsDeployment} onClick={() => setShowVaultWizard(true)}>
                    <KeyRound className="h-3.5 w-3.5" />
                    <span>插入 Vault 密钥</span>
                  </Button>
                  <Button size="sm" onClick={() => setShowCompose(true)}>
                    Compose 导入
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
                  ...(isAdmin ? [{ id: 'visual', label: '可视化编排', title: '所见即所得的卡片式表单 + 高级结构树 + 实时 HCL 分栏预览' }] : []),
                  { id: 'hcl', label: '原生 HCL', title: 'Nomad 原生 HashiCorp Configuration Language 声明式任务定义' },
                  { id: 'json', label: 'JSON 定义' },
                ]}
                active={editMode}
                onChange={(m) => {
                  void changeMode(m as 'hcl' | 'visual' | 'json');
                }}
              />
              {isAdmin && (
                <div className="flex items-center gap-2">
                  <span className="text-slate-400 dark:text-slate-500 shrink-0">快速载入蓝图</span>
                  <div className="w-48">
                    <Select
                      aria-label="选择入门示例"
                      size="sm"
                      value={activeSample?.id || ''}
                      onChange={(e) => {
                        const found = STARTER_SAMPLES.find((s) => s.id === e.target.value);
                        if (!found) return;
                        loadDraftIntoComposer(found.hcl);
                      }}
                    >
                      <option value="">选择场景示例…</option>
                      {STARTER_SAMPLES.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              )}
            </div>

            {activeSample && (
              <p className="rounded-lg bg-slate-50 px-3 py-1.5 text-[11px] text-slate-600 dark:bg-slate-950/50 dark:text-slate-400">
                当前蓝图：{activeSample.desc}
              </p>
            )}

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
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-slate-50/70 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-950/50">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    placeholder="输入名称保存为模板…"
                    value={tplName}
                    onChange={(e) => setTplName(e.target.value)}
                    className="w-44 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                  <Button
                    size="sm"
                    disabled={!tplName.trim() || modeBusy || editMode === 'json' || (editMode === 'visual' && !visualReady)}
                    onClick={() =>
                      tplName.trim() &&
                      void apiPost('/api/v1/job-templates', { name: tplName.trim(), edit_mode: 'hcl', hcl })
                        .then(() => {
                          setTplName('');
                          toast.success('模板已保存至模板库');
                          return loadClusters();
                        })
                        .catch((ex) => setErr(ex.message))
                    }
                  >
                    存为模板
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    disabled={needsDeployment || modeBusy || (editMode === 'visual' && !visualReady)}
                    onClick={() => void validateJob()}
                  >
                    1. 校验配置
                  </Button>
                  <Button
                    size="sm"
                    variant={plan ? 'secondary' : 'primary'}
                    disabled={needsDeployment || modeBusy || (editMode === 'visual' && !visualReady)}
                    onClick={() => void runPlan()}
                  >
                    2. 预览计划
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
                        ? '请先点击「2. 预览计划」生成执行计划'
                        : planBlockingReasons.length > 0 && !ignorePreflight
                          ? '当前集群环境或调度条件未满足，请先处理问题或勾选忽略检查'
                          : '确认将任务提交至 Nomad 集群运行并跳转查看运行态'
                    }
                    onClick={() => void runApply()}
                  >
                    <Play className="h-3.5 w-3.5" />
                    <span>3. 确认运行</span>
                  </Button>
                </div>
              </div>
            )}

            {preflightErrors.length > 0 && (
              <div
                role="alert"
                className="rounded-xl border border-rose-300 bg-rose-50/90 p-3 text-xs text-rose-950 space-y-1 dark:border-rose-500/40 dark:bg-rose-950/35 dark:text-rose-100"
              >
                <div className="font-semibold">环境前置检查未通过（当前无法在该集群调度运行）：</div>
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
                <div className="font-semibold">校验提醒（含 Nomad-Vault 联动核对）：</div>
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
                      调度变更预览 · 请核对后点击上方「3. 确认运行」
                    </span>
                    <Badge tone="blue">
                      {({ Added: '创建任务', Edited: '更新任务', None: '配置无变化', Deleted: '删除任务' } as Record<string, string>)[
                        plan.diff?.Type
                      ] || '配置变更'}
                    </Badge>
                  </div>
                  <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400" title={plan.plan_id}>
                    Plan #{String(plan.plan_id || '').slice(0, 8)}
                  </span>
                </div>
                <p className="leading-5 text-slate-700 dark:text-slate-200">
                  任务 <code className="font-mono font-semibold">{plan.job_id}</code> · 命名空间{' '}
                  <code className="font-mono">{plan.namespace}</code>
                </p>
                {(plan.warnings || plan.validation_warnings) && (
                  <p role="alert" className="whitespace-pre-wrap text-amber-700 dark:text-amber-300">
                    {[plan.validation_warnings, plan.warnings].filter(Boolean).join('\n')}
                  </p>
                )}
                {planBlockingReasons.length > 0 && (
                  <div
                    role="alert"
                    className="rounded-xl border border-rose-300 bg-rose-50/90 p-3 text-xs text-rose-950 space-y-2 dark:border-rose-500/40 dark:bg-rose-950/35 dark:text-rose-100"
                  >
                    <div className="font-semibold">环境或调度检查未通过（已阻止直接提交）：</div>
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
                      <span>忽略环境与调度检查，仍强行提交为待调度状态（pending）</span>
                    </label>
                  </div>
                )}
                <details>
                  <summary className="cursor-pointer py-1 font-medium text-indigo-700 dark:text-indigo-300">
                    查看调度变更详情
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
                  历史修订记录：{selectedJobId}（{revisions.length} 条）
                </summary>
                <div className="mt-2.5 space-y-1.5">
                  {revisions.slice(0, 8).map((rv) => (
                    <div
                      key={rv.id}
                      className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-900"
                    >
                      <span>
                        v{rv.revision_no} · {rv.source} · {rv.submit_status} · {fmtTime(rv.created_at)}
                      </span>
                      {isAdmin && rv.remote_job_version != null && (
                        <Button
                          size="sm"
                          onClick={() =>
                            void apiPost(
                              `/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(effectiveBuilderNamespace)}/jobs/${encodeURIComponent(selectedJobId)}/revert`,
                              { version: rv.remote_job_version },
                            )
                              .then(() => toast.success('已回滚 Job 版本'))
                              .catch((ex) => setErr(ex.message))
                          }
                        >
                          <RotateCcw className="h-3 w-3" /> 回滚
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
            title={`内置场景蓝图 (${STARTER_SAMPLES.length})`}
            description="点击即可载入可视化编排工作台，快速修改镜像、端口、资源与 Vault 密钥并运行"
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 text-xs">
              {STARTER_SAMPLES.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-col justify-between gap-3 rounded-xl border border-slate-200/90 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-950/40"
                >
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-sm text-slate-900 dark:text-slate-100">{s.label}</span>
                      <div className="flex flex-wrap gap-1">
                        {s.tags.map((tag) => (
                          <Badge key={tag} tone={tag === 'Vault' ? 'green' : tag === 'Docker' ? 'blue' : 'neutral'}>
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <p className="leading-5 text-slate-500 dark:text-slate-400">{s.desc}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 border-t border-slate-200/70 pt-3 dark:border-slate-800">
                    <Button size="sm" variant="primary" onClick={() => loadDraftIntoComposer(s.hcl, isAdmin ? 'visual' : 'hcl')}>
                      <LayoutGrid className="h-3.5 w-3.5" />
                      <span>可视化编排</span>
                    </Button>
                    <Button size="sm" onClick={() => loadDraftIntoComposer(s.hcl, 'hcl')}>
                      HCL 源码编辑
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card
            title={`自定义模板库 (${templates.length})`}
            actions={
              templates.length > 0 && (
                <div className="relative w-52">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="筛选模板名称…"
                    className="w-full rounded-lg border border-slate-200 bg-white py-1 pl-8 pr-2.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                  />
                </div>
              )
            }
          >
            {templates.length === 0 ? (
              <EmptyState
                title="暂无自定义模板"
                description="在「编排工作台」底部输入模板名称并点击「存为模板」，方便团队一键复用。"
              />
            ) : filteredTemplates.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">没有匹配的模板</div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs">
                {filteredTemplates.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/90 bg-slate-50/50 p-3.5 dark:border-slate-800 dark:bg-slate-900/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold text-slate-800 dark:text-slate-100">{t.name}</div>
                      <div className="mt-0.5 text-[11px] text-slate-400">自定义 HCL 模板</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button size="sm" onClick={() => loadDraftIntoComposer(t.hcl || '', isAdmin ? 'visual' : 'hcl')}>
                        载入编排
                      </Button>
                      {isAdmin && (
                        <button
                          type="button"
                          title="删除模板"
                          aria-label={`删除模板 ${t.name}`}
                          onClick={async () => {
                            if (
                              !(await askConfirm(`确认删除 Job 模板「${t.name}」吗？`, {
                                title: '删除模板',
                                confirmText: '确认删除',
                                danger: true,
                              }))
                            ) {
                              return;
                            }
                            void apiDelete(`/api/v1/job-templates/${t.id}`)
                              .then(() => {
                                toast.success(`已删除模板 ${t.name}`);
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
      <Modal open={showCompose} title="导入 Docker Compose 转 HCL" onClose={() => setShowCompose(false)} wide>
        <div className="space-y-3 text-xs">
          <CodeEditor value={composeText} onChange={setComposeText} height="260px" />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setShowCompose(false)}>取消</Button>
            <Button
              variant="primary"
              onClick={() =>
                void apiPost(`/api/v1/nomad/${clusterId}/job-ops/compose-convert`, { compose: composeText })
                  .then((r) => {
                    if (r.hcl) loadDraftIntoComposer(r.hcl, isAdmin ? 'visual' : 'hcl');
                    setShowCompose(false);
                    toast.success('已转换为 Nomad HCL 并载入编排工作台');
                  })
                  .catch((ex) => setErr(ex.message))
              }
            >
              转换并载入工作台
            </Button>
          </div>
        </div>
      </Modal>

      {/* Vault Secret Wizard Modal */}
      <Modal open={showVaultWizard} title="插入 Vault 密钥读取模板" onClose={() => setShowVaultWizard(false)} wide>
        {(() => {
          const parsed = parseKVPath(vaultWizard.secretPath);
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
                  当前 Nomad 集群尚未创建 Nomad-Vault 联动。可先前往{' '}
                  <Link to="/integrations" className="font-semibold underline">
                    集群联动
                  </Link>{' '}
                  创建并应用。
                </div>
              ) : vaultIntegrations.some((ig) => ig.status !== 'applied') ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
                  检测到联动尚未应用生效，请记得在{' '}
                  <Link to="/integrations" className="font-semibold underline">
                    集群联动
                  </Link>{' '}
                  点击「应用联动」后再运行 Job。
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Input
                    label="Vault Role 名称"
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
                    placeholder="例如 postgres"
                  />
                  <datalist id="jc-vault-role-list">
                    {vaultRoles.map((r) => (
                      <option key={r.role} value={r.role} />
                    ))}
                  </datalist>
                  {pickedRole && (
                    <p className="text-[11px] text-slate-500">
                      状态：{pickedRole.status === 'applied' ? '已应用' : '草稿（待应用）'} · 允许 Namespace：
                      <code className="font-mono">{pickedRole.namespace || 'default'}</code>
                    </p>
                  )}
                </div>
                <Input
                  label="Secret 路径（自动补全 /data/）"
                  value={vaultWizard.secretPath}
                  onChange={(e) => setVaultWizard((prev) => ({ ...prev, secretPath: e.target.value }))}
                  placeholder="例如 secret/apps/postgres"
                  hint={`模板读取路径：${parsed.templatePath || 'secret/data/apps/demo'}`}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  label="密钥注入方式"
                  value={vaultWizard.mode}
                  onChange={(e) => setVaultWizard((prev) => ({ ...prev, mode: e.target.value as 'env' | 'file' }))}
                >
                  <option value="env">注入为容器环境变量（env = true）</option>
                  <option value="file">挂载为 0600 密码文件（/secrets/xxx）</option>
                </Select>
                <Input
                  label={
                    vaultWizard.mode === 'file'
                      ? '提取字段名（留空则写入完整 JSON）'
                      : '提取字段名（逗号分隔，留空则注入全部字段）'
                  }
                  value={vaultWizard.keys}
                  onChange={(e) => setVaultWizard((prev) => ({ ...prev, keys: e.target.value }))}
                  placeholder={vaultWizard.mode === 'file' ? '例如 password' : '例如 username, password'}
                />
              </div>

              {vaultWizard.mode === 'file' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    label="容器内密码文件名（/secrets/ 下）"
                    value={vaultWizard.fileName}
                    onChange={(e) => setVaultWizard((prev) => ({ ...prev, fileName: e.target.value }))}
                  />
                  <Input
                    label="指向该文件的环境变量名"
                    value={vaultWizard.envVarName}
                    onChange={(e) => setVaultWizard((prev) => ({ ...prev, envVarName: e.target.value }))}
                  />
                </div>
              )}

              <div>
                <div className="mb-1 font-semibold text-slate-700 dark:text-slate-200">生成代码预览（放入 task 块内）</div>
                <CodeEditor value={snippet} readOnly height="200px" />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    void copyText(snippet)
                      .then(() => toast.success('已复制代码片段'))
                      .catch((ex) => toast.error(ex.message))
                  }
                >
                  <Copy className="h-3.5 w-3.5" />
                  <span>仅复制片段</span>
                </Button>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setShowVaultWizard(false)}>
                    取消
                  </Button>
                  <Button size="sm" variant="primary" loading={vaultWizardBusy} onClick={() => void insertVaultIntoJob()}>
                    插入当前 Job 第一个 Task
                  </Button>
                </div>
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
