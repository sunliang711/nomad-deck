import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Boxes, Copy, Download, FilePlus2, KeyRound, Play, RefreshCw, RotateCcw, Search, Square, Trash2 } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
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
  LoadingState,
  Input,
  Modal,
  PageHeader,
  SectionTabs,
  Select,
  StatusBadge,
} from '../components/UI';
import { CodeEditor } from '../components/CodeEditor';
import { ItemSwitcher } from '../components/ItemSwitcher';
import { VisualJobBuilder, type VisualJobBuilderHandle } from '../components/VisualJobBuilder';

const STARTER_SAMPLES: Array<{ id: string; label: string; desc: string; hcl: string }> = [
  {
    id: 'docker',
    label: 'Nginx 容器 (docker)',
    desc: '标准 Docker 容器服务示例，默认开箱即可在 Nomad Client 运行',
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
    label: 'PostgreSQL + Vault',
    desc: '先配置 postgres Role 与 secret/apps/postgres（username、password、database）。示例数据保存在当前 Allocation。',
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
    label: 'Redis + Vault',
    desc: '先配置 redis Role 与 secret/apps/redis（含 password 字段），通过 0600 内存密码文件安全注入 requirepass。',
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
    label: 'Shell 入门 (需开启 raw_exec)',
    desc: '无需 Docker，直接在节点运行轻量脚本（需在节点插件配置中开启 raw_exec 驱动）',
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
    label: '一次性批处理 (batch · 需开启 raw_exec)',
    desc: '执行完即退出的短任务示例（需在节点插件配置中开启 raw_exec 驱动）',
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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClusterId = searchParams.get('cluster_id') || '';
  const queryNamespace = searchParams.get('namespace') || '';
  const queryJobId = searchParams.get('job') || '';
  const queryFrom = searchParams.get('from') || '';
  const toast = useToast();
  const askConfirm = useConfirm();
  const [clusters, setClusters] = useState<any[]>([]);
  const [clusterId, setClusterId] = useState(() => queryClusterId || readStoredSelection(JOB_CENTER_CLUSTER_KEY));
  const [namespace, setNamespace] = useState(queryNamespace || 'default');
  const [jobs, setJobs] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [editMode, setEditMode] = useState<'hcl' | 'visual' | 'json'>('hcl');
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
  const [revisions, setRevisions] = useState<any[]>([]);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [pageTab, setPageTab] = useState<'list' | 'builder'>(() =>
    queryJobId || queryFrom === 'integration' ? 'builder' : 'list',
  );
  const [sidebarQuery, setSidebarQuery] = useState('');
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
          setHcl(draft.hcl);
          setEditMode('hcl');
          setJobVariables({});
          setPlan(null);
          setValidationWarnings([]);
          setPageTab('builder');
        }
        window.sessionStorage.removeItem(INTEGRATION_DRAFT_JOB_STORAGE_KEY);
        toast.info(`已载入联动示例（Role: ${draft?.roleName || 'default'}），请依次点击「1. 校验配置 → 2. 预览计划 → 3. 确认运行」`);
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
        setVaultWizard((prev) => (prev.role ? prev : {
          ...prev,
          role: roles[0].role,
          secretPath: roles[0].secret_paths?.[0] || 'secret/apps/demo',
        }));
      }
    } catch {
      // Non-blocking: Job Center remains usable even if builder options fail.
    }
  }, [clusterId, needsDeployment]);

  const loadJobs = useCallback(async () => {
    if (!clusterId || needsDeployment) { setJobs([]); return; }
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
      onEvent: (ev) => { if (ev === 'change') void loadJobs(); },
    });
  }, [clusterId, loadJobs, needsDeployment]);

  // clearPlan also invalidates an in-flight preview when its draft or target changes.
  const clearPlan = () => {
    planRequestRef.current++;
    setPlan(null);
    setValidationWarnings([]);
  };

  // changeMode flushes the current tree and refuses conversions that would drop JSON fields.
  const changeMode = async (next: 'hcl' | 'visual' | 'json') => {
    if (next === editMode) return;
    if (!isAdmin) { setEditMode(next); return; }
    const request = ++modeRequestRef.current;
    setModeBusy(true);
    clearPlan();
    setErr('');
    try {
      let current = hcl;
      if (editMode === 'visual' && visualRef.current) current = (await visualRef.current.flush()).hcl;
      if (next === 'json') {
        const parsed = await apiPost(`/api/v1/nomad/${clusterId}/job-ops/validate`, { input_type: 'hcl', hcl: current, variables: jobVariables, namespace });
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
          if (!parsed.lossless || !parsed.hcl) throw new Error('该 JSON 含有无法完整转换的字段，请继续使用 JSON 编辑，避免丢失配置');
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

  // Preserve the authoritative JSON definition and variables when no HCL source exists.
  const jobInput = async () => {
    let current = hcl;
    if (editMode === 'visual' && visualRef.current) {
      const result = await visualRef.current.flush();
      if (!result.valid) throw new Error(result.diagnostics.map((issue) => issue.message).join('；') || '请先完成积木配置');
      current = result.hcl;
    }
    return editMode === 'json'
      ? { input_type: 'json', job_json: JSON.parse(current), namespace, edit_mode: 'json' }
      : { input_type: 'hcl', hcl: current, variables: jobVariables, namespace, edit_mode: 'hcl' };
  };

  const validateJob = async () => {
    setErr('');
    setValidationWarnings([]);
    try {
      const res = await apiPost(`/api/v1/nomad/${clusterId}/job-ops/validate`, await jobInput());
      const warns = String(res.warnings || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      setValidationWarnings(warns);
      if (warns.length > 0) {
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
        throw new Error('JSON 模式下请先切换回原生 HCL 编辑器或可视化编排后再插入');
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
      const keys = vaultWizard.keys.split(',').map((s) => s.trim()).filter(Boolean);
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
      if (editMode === 'visual') setEditMode('hcl');
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
    try {
      const input = await jobInput();
      const request = ++planRequestRef.current;
      const res = await apiPost(`/api/v1/nomad/${clusterId}/job-ops/plan`, input);
      if (request === planRequestRef.current) setPlan(res.plan);
    } catch (ex: any) {
      setErr(ex?.message || 'Plan 失败');
    }
  };

  const runApply = async () => {
    if (!clusterId || !plan?.plan_id) return;
    setErr('');
    const targetJobId = plan.job_id || selectedJobId;
    const targetNs = plan.namespace || namespace;
    try {
      await apiPost(`/api/v1/nomad/${clusterId}/job-ops/apply`, { plan_id: plan.plan_id });
      clearPlan();
      const targetUrl = targetJobId
        ? `/nomad?id=${encodeURIComponent(clusterId)}&tab=workbench&ns=${encodeURIComponent(targetNs)}&job=${encodeURIComponent(targetJobId)}`
        : `/nomad?id=${encodeURIComponent(clusterId)}&tab=workbench&ns=${encodeURIComponent(targetNs)}`;
      toast.success('Job 已提交运行', {
        label: '查看运行态',
        onClick: () => navigate(targetUrl),
      });
      await loadJobs();
    } catch (ex: any) {
      setErr(ex?.message || 'Apply 失败');
    }
  };

  const loadJobForEdit = async (j: any) => {
    const request = ++editRequestRef.current;
    modeRequestRef.current++;
    setModeBusy(false);
    formatCacheRef.current = null;
    const ns = j.namespace || namespace;
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
        setEditMode('hcl');
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
  };

  useEffect(() => {
    if (!queryJobId || queryFrom === 'integration' || !selectedCluster || needsDeployment) return;
    void loadJobForEdit({ id: queryJobId, namespace: queryNamespace || namespace });
    const next = new URLSearchParams(searchParams);
    next.delete('job');
    setSearchParams(next, { replace: true });
  }, [queryJobId, queryFrom, selectedCluster, needsDeployment]);

  const namespaceOptions = useMemo(() => {
    const set = new Set<string>(clusterNamespaces.length > 0 ? clusterNamespaces : ['default']);
    if (namespace) set.add(namespace);
    return Array.from(set);
  }, [clusterNamespaces, namespace]);

  const activeSample = useMemo(
    () => STARTER_SAMPLES.find((sample) => sample.hcl === hcl) || null,
    [hcl],
  );

  const filteredJobs = useMemo(() => {
    const q = sidebarQuery.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter(
      (j) =>
        String(j.id || '').toLowerCase().includes(q) ||
        String(j.namespace || '').toLowerCase().includes(q) ||
        String(j.type || '').toLowerCase().includes(q),
    );
  }, [jobs, sidebarQuery]);

  const filteredTemplates = useMemo(() => {
    const q = sidebarQuery.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) => String(t.name || '').toLowerCase().includes(q));
  }, [templates, sidebarQuery]);

  if (loadingClusters) return <LoadingState label="正在加载 Job 工作区…" />;

  if (!clusters.length) return (
    <div className="space-y-5">
      <PageHeader title="Nomad Job 中心" subtitle="编写任务、预览调度计划并运行工作负载" />
      <ErrorAlert message={err} onClose={() => setErr('')} />
      <Card><EmptyState icon={<Boxes className="h-6 w-6" />} title="先搭建一个 Nomad 集群" description="Job 需要在 Nomad Client 上运行。集群部署完成后，即可在这里编写第一个任务。" action={<Link to="/nomad" className="primary-button">前往 Nomad 集群</Link>} /></Card>
    </div>
  );

  const startFreshDraft = () => {
    setSelectedJobId('');
    setRevisions([]);
    setHcl(sampleHCL);
    setEditMode('hcl');
    setJobVariables({});
    clearPlan();
    setPageTab('builder');
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Nomad Job 中心"
        subtitle="编写任务 → 校验配置 → 预览计划 → 确认运行，支持 HCL、可视化与 JSON"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => { void loadClusters(); void loadJobs(); }}>
              <RefreshCw className="h-4 w-4" />
              <span>刷新</span>
            </Button>
            {isAdmin && clusterId && (
              <>
                <Button
                  onClick={() =>
                    void apiDownload(`/api/v1/nomad/${clusterId}/job-ops/export`, { namespace }, 'nomad-jobs.zip')
                      .catch((ex) => toast.error(ex.message))
                  }
                >
                  <Download className="h-4 w-4" />
                  <span>批量导出 HCL</span>
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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <ItemSwitcher
            label="Nomad 集群"
            selectedId={clusterId}
            disabled={modeBusy || (editMode === 'visual' && !visualReady)}
            onSelect={(id) => {
              setClusterId(id);
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
            <div className="w-36">
              <Select
                aria-label="任务命名空间"
                size="sm"
                value={namespace}
                disabled={modeBusy || (editMode === 'visual' && !visualReady)}
                onChange={(e) => { setNamespace(e.target.value); clearPlan(); }}
              >
                {namespaceOptions.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
              </Select>
            </div>
          </div>
        </div>

        <SectionTabs
          tabs={[
            { id: 'list', label: '任务与模板', badge: jobs.length + templates.length },
            {
              id: 'builder',
              label: selectedJobId ? `Job 编排工作台 · 编辑 ${selectedJobId}` : 'Job 编排工作台',
            },
          ]}
          active={pageTab}
          onChange={(next) => setPageTab(next as 'list' | 'builder')}
        />
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {needsDeployment && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200">
          <p>「{selectedCluster.name}」尚未部署。可以先编写配置，部署完成后再校验和运行。</p>
          <Link to={`/nomad?id=${clusterId}`} className="primary-button">前往部署集群</Link>
        </div>
      )}

      {pageTab === 'list' && (
        <div className="space-y-5">
          {(jobs.length > 0 || templates.length > 0) && (
            <div className="relative max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={sidebarQuery}
                onChange={(e) => setSidebarQuery(e.target.value)}
                placeholder="筛选任务名称、命名空间或模板名称…"
                className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-xs text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
          )}

          <Card title={`运行中的 Job (${jobs.length})`}>
            {jobs.length === 0 ? (
              <EmptyState
                title="暂无运行中的 Job"
                description="工作台已内置 Nginx、PostgreSQL + Vault、Redis + Vault 等示例模板，前往编排工作台即可一键校验并提交运行。"
                action={
                  isAdmin ? (
                    <Button size="sm" onClick={startFreshDraft}>
                      <FilePlus2 className="h-3.5 w-3.5" />
                      <span>前往编排工作台</span>
                    </Button>
                  ) : undefined
                }
              />
            ) : filteredJobs.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400 dark:text-slate-500">没有匹配的任务</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      <th className="py-2.5 pr-4 font-medium">Job 名称</th>
                      <th className="py-2.5 pr-4 font-medium">状态</th>
                      <th className="py-2.5 pr-4 font-medium">类型</th>
                      <th className="py-2.5 pr-4 font-medium">命名空间</th>
                      <th className="py-2.5 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                    {filteredJobs.map((j) => {
                      const jobNs = j.namespace || namespace;
                      const workbenchHref = `/nomad?id=${encodeURIComponent(clusterId)}&tab=workbench&ns=${encodeURIComponent(jobNs)}&job=${encodeURIComponent(j.id)}`;
                      const isEditing = selectedJobId === j.id;
                      return (
                        <tr key={`${jobNs}:${j.id}`} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30">
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-2">
                              <Link
                                to={workbenchHref}
                                title="前往运行态工作台查看详情"
                                className="font-mono text-[13px] font-semibold text-slate-900 hover:text-indigo-600 hover:underline dark:text-slate-100 dark:hover:text-indigo-400"
                              >
                                {j.id}
                              </Link>
                              {isEditing && <Badge tone="blue">工作台编辑中</Badge>}
                            </div>
                          </td>
                          <td className="py-3 pr-4">
                            <StatusBadge value={j.stop ? 'stopped' : j.status} />
                          </td>
                          <td className="py-3 pr-4 text-slate-600 dark:text-slate-300">{j.type || 'service'}</td>
                          <td className="py-3 pr-4 font-mono text-slate-600 dark:text-slate-300">{jobNs}</td>
                          <td className="py-3 text-right">
                            <div className="flex flex-wrap items-center justify-end gap-1.5">
                              {isAdmin && (
                                <Button
                                  size="sm"
                                  variant={isEditing ? 'primary' : 'secondary'}
                                  onClick={() => void loadJobForEdit(j)}
                                >
                                  {isEditing ? '继续编辑' : '载入编辑'}
                                </Button>
                              )}
                              <Link
                                to={workbenchHref}
                                title="在运行态工作台查看 Allocations、日志与终端"
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-200/80 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-300 dark:hover:border-indigo-500/40 dark:hover:text-indigo-300"
                              >
                                <span>运行态</span>
                                <ArrowUpRight className="h-3 w-3" />
                              </Link>
                              {isAdmin && (
                                <>
                                  <button
                                    type="button"
                                    title="启动 Job"
                                    aria-label="启动 Job"
                                    disabled={!j.stop}
                                    onClick={() =>
                                      void apiPost(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(jobNs)}/jobs/${encodeURIComponent(j.id)}/start`, {})
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
                                    aria-label="停止 Job"
                                    disabled={j.stop}
                                    onClick={async () => {
                                      if (!(await askConfirm(`确认停止运行中的 Job「${j.id}」（Namespace: ${jobNs}）吗？`, { title: '停止 Job', confirmText: '确认停止', danger: true }))) return;
                                      void apiPost(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(jobNs)}/jobs/${encodeURIComponent(j.id)}/stop`, {})
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
                                    aria-label="清理 Job"
                                    onClick={async () => {
                                      if (!(await askConfirm(`确认清理并彻底删除 Job「${j.id}」（Namespace: ${jobNs}）吗？`, { title: '清理删除 Job', confirmText: '确认 Purge', danger: true }))) return;
                                      void apiPost(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(jobNs)}/jobs/${encodeURIComponent(j.id)}/purge`, { confirm_job_id: j.id })
                                        .then(() => {
                                          toast.success(`已清理 Job ${j.id}`);
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

          <Card title={`模板库 (${templates.length})`}>
            {templates.length === 0 ? (
              <EmptyState title="暂无保存的模板" description="在「Job 编排工作台」编辑器下方输入模板名称并点击「存为模板」，方便下次一键复用。" />
            ) : filteredTemplates.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400 dark:text-slate-500">没有匹配的模板</div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs">
                {filteredTemplates.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/90 bg-slate-50/50 p-3.5 dark:border-slate-800 dark:bg-slate-900/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold text-slate-800 dark:text-slate-100">{t.name}</div>
                      <div className="mt-0.5 text-[11px] text-slate-400">HCL 模板</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        onClick={() => {
                          setSelectedJobId('');
                          setRevisions([]);
                          setHcl(t.hcl || '');
                          setEditMode('hcl');
                          setJobVariables({});
                          clearPlan();
                          setPageTab('builder');
                        }}
                      >
                        载入工作台
                      </Button>
                      {isAdmin && (
                        <button
                          type="button"
                          title="删除模板"
                          aria-label="删除模板"
                          onClick={async () => {
                            if (!(await askConfirm(`确认删除 Job 模板「${t.name}」吗？`, { title: '删除模板', confirmText: '确认删除', danger: true }))) return;
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

      {pageTab === 'builder' && (
        <Card
          className="min-w-0"
          title={
            <div className="flex flex-wrap items-center gap-2">
              <span>Job 编排工作台</span>
              <Badge tone={selectedJobId ? 'blue' : 'neutral'}>
                {selectedJobId ? `编辑：${selectedJobId}` : '新建任务'}
              </Badge>
            </div>
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {selectedCluster && !needsDeployment && (
                <Link
                  to={
                    selectedJobId
                      ? `/nomad?id=${encodeURIComponent(clusterId)}&tab=workbench&ns=${encodeURIComponent(namespace)}&job=${encodeURIComponent(selectedJobId)}`
                      : `/nomad?id=${encodeURIComponent(clusterId)}&tab=workbench&ns=${encodeURIComponent(namespace)}`
                  }
                  className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400 mr-1"
                >
                  <span>{selectedJobId ? `运行态 (${selectedJobId})` : '运行态工作台'}</span>
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              )}
              {isAdmin && (
                <>
                  {selectedJobId && (
                    <Button size="sm" variant="ghost" onClick={startFreshDraft} title="清空当前编辑并新建空白示例任务">
                      <FilePlus2 className="h-3.5 w-3.5" />
                      <span>新建空白</span>
                    </Button>
                  )}
                  <Button size="sm" disabled={needsDeployment} onClick={() => setShowVaultWizard(true)}>
                    <KeyRound className="h-3.5 w-3.5" />
                    <span>插入 Vault 密钥</span>
                  </Button>
                  <Button size="sm" onClick={() => setShowCompose(true)}>Compose 导入</Button>
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
                  { id: 'hcl', label: '原生 HCL', title: 'Nomad 原生 HashiCorp Configuration Language 声明式任务定义' },
                  ...(isAdmin ? [{ id: 'visual', label: '可视化编排' }] : []),
                  { id: 'json', label: 'JSON 定义' },
                ]}
                active={editMode}
                onChange={(m) => { void changeMode(m as 'hcl' | 'visual' | 'json'); }}
              />
              {isAdmin && (
                <div className="flex items-center gap-2">
                  <span className="text-slate-400 dark:text-slate-500 shrink-0">入门示例</span>
                  <div className="w-48">
                    <Select
                      aria-label="选择入门示例"
                      size="sm"
                      value={activeSample?.id || ''}
                      onChange={(e) => {
                        const found = STARTER_SAMPLES.find((s) => s.id === e.target.value);
                        if (!found) return;
                        setSelectedJobId('');
                        setRevisions([]);
                        setHcl(found.hcl);
                        setEditMode('hcl');
                        setJobVariables({});
                        clearPlan();
                      }}
                    >
                      <option value="">选择示例模板…</option>
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
              <p className="px-1 text-[11px] text-slate-500 dark:text-slate-400">
                当前示例：{activeSample.desc}
              </p>
            )}

            {editMode === 'visual' ? (
              <div className="space-y-3">
                <VisualJobBuilder
                  ref={visualRef}
                  clusterId={clusterId}
                  source={hcl}
                  readOnly={!isAdmin}
                  onSourceChange={(value) => { setHcl(value); clearPlan(); }}
                  onValidityChange={(valid) => { setVisualReady(valid); if (!valid) clearPlan(); }}
                />
                <details className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                  <summary className="cursor-pointer px-4 py-2.5 font-semibold text-slate-700 dark:text-slate-200">
                    实时 HCL 预览 <span className="ml-1.5 font-normal text-slate-400">· 展开查看同步生成的 Nomad 配置源码</span>
                  </summary>
                  <div className="border-t border-slate-100 p-3 dark:border-slate-800">
                    <CodeEditor value={hcl} onChange={(value) => { setHcl(value); clearPlan(); }} readOnly height="280px" />
                  </div>
                </details>
              </div>
            ) : (
              <CodeEditor value={hcl} onChange={(value) => { setHcl(value); clearPlan(); }} readOnly={!isAdmin} height="440px" />
            )}

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
                        .then(() => { setTplName(''); toast.success('模板已保存'); return loadClusters(); })
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
                    variant={plan?.plan_id ? 'primary' : 'secondary'}
                    disabled={!plan?.plan_id || needsDeployment || modeBusy}
                    title={!plan?.plan_id ? '请先点击「2. 预览计划」生成执行计划' : '确认将任务提交至 Nomad 集群运行'}
                    onClick={() => void runApply()}
                  >
                    <Play className="h-3.5 w-3.5" />
                    <span>3. 确认运行</span>
                  </Button>
                </div>
              </div>
            )}

            {validationWarnings.length > 0 && (
              <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50/90 p-3 text-xs text-amber-950 space-y-1 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
                <div className="font-semibold">校验提醒（含 Nomad-Vault 联动核对）：</div>
                {validationWarnings.map((w, idx) => (
                  <p key={idx} className="leading-5">• {w}</p>
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
                    <Badge tone="blue">{({ Added: '创建任务', Edited: '更新任务', None: '配置无变化', Deleted: '删除任务' } as Record<string, string>)[plan.diff?.Type] || '配置变更'}</Badge>
                  </div>
                  <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400" title={plan.plan_id}>
                    Plan #{String(plan.plan_id || '').slice(0, 8)}
                  </span>
                </div>
                <p className="leading-5 text-slate-700 dark:text-slate-200">
                  任务 <code className="font-mono font-semibold">{plan.job_id}</code> · 命名空间 <code className="font-mono">{plan.namespace}</code>
                </p>
                {(plan.warnings || plan.validation_warnings) && <p role="alert" className="whitespace-pre-wrap text-amber-700 dark:text-amber-300">{[plan.validation_warnings, plan.warnings].filter(Boolean).join('\n')}</p>}
                {plan.failed_tg_allocs && Object.keys(plan.failed_tg_allocs).length > 0 && <p role="alert" className="text-red-700 dark:text-red-300">部分任务无法调度，请展开详情检查资源或约束条件。</p>}
                <details>
                  <summary className="cursor-pointer py-1 font-medium text-indigo-700 dark:text-indigo-300">查看调度变更详情</summary>
                  <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-slate-950 p-2.5 font-mono text-[11px] text-slate-100">
                    {JSON.stringify({ plan_id: plan.plan_id, diff: plan.diff, failed_tg_allocs: plan.failed_tg_allocs }, null, 2)}
                  </pre>
                </details>
              </div>
            )}

            {revisions.length > 0 && (
              <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
                <div className="mb-1.5 font-semibold">修订历史：{selectedJobId}</div>
                <div className="space-y-1">
                  {revisions.slice(0, 8).map((rv) => (
                    <div key={rv.id} className="flex items-center justify-between rounded border border-slate-200 p-1.5 dark:border-slate-800">
                      <span>v{rv.revision_no} · {rv.source} · {rv.submit_status} · {fmtTime(rv.created_at)}</span>
                      {isAdmin && rv.remote_job_version != null && (
                        <Button
                          size="sm"
                          onClick={() =>
                            void apiPost(
                              `/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(namespace)}/jobs/${encodeURIComponent(selectedJobId)}/revert`,
                              { version: rv.remote_job_version },
                            ).then(() => toast.success('已回滚 Job 版本')).catch((ex) => setErr(ex.message))
                          }
                        >
                          <RotateCcw className="h-3 w-3" /> 回滚
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

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
                    if (r.hcl) setHcl(r.hcl);
                    setEditMode('hcl');
                    setJobVariables({});
                    clearPlan();
                    setShowCompose(false);
                    toast.success('已转换为 Nomad HCL');
                  })
                  .catch((ex) => setErr(ex.message))
              }
            >
              转换并填入编辑器
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={showVaultWizard} title="插入 Vault 密钥读取模板" onClose={() => setShowVaultWizard(false)} wide>
        {(() => {
          const parsed = parseKVPath(vaultWizard.secretPath);
          const keys = vaultWizard.keys.split(',').map((s) => s.trim()).filter(Boolean);
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
                  当前 Nomad 集群尚未创建 Nomad-Vault 联动。可先前往 <Link to="/integrations" className="font-semibold underline">集群联动</Link> 创建并应用。
                </div>
              ) : vaultIntegrations.some((ig) => ig.status !== 'applied') ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
                  检测到联动尚未应用生效，请记得在 <Link to="/integrations" className="font-semibold underline">集群联动</Link> 点击「应用联动」后再运行 Job。
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
                    {vaultRoles.map((r) => <option key={r.role} value={r.role} />)}
                  </datalist>
                  {pickedRole && (
                    <p className="text-[11px] text-slate-500">
                      状态：{pickedRole.status === 'applied' ? '已应用' : '草稿（待应用）'} · 允许 Namespace：<code className="font-mono">{pickedRole.namespace || 'default'}</code>
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
                  label={vaultWizard.mode === 'file' ? '提取字段名（留空则写入完整 JSON）' : '提取字段名（逗号分隔，留空则注入全部字段）'}
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
                  onClick={() => void copyText(snippet).then(() => toast.success('已复制代码片段')).catch((ex) => toast.error(ex.message))}
                >
                  <Copy className="h-3.5 w-3.5" />
                  <span>仅复制片段</span>
                </Button>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setShowVaultWizard(false)}>取消</Button>
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
