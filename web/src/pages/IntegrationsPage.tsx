import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Link2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { INTEGRATION_DRAFT_JOB_STORAGE_KEY, parseKVPath } from '../lib/vaultHelpers';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useOpsDrawer } from '../lib/opsDrawer';
import { isTaskActiveStatus } from '../lib/actionLabels';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Input,
  Modal,
  PageHeader,
  Select,
  StatusBadge,
  TermLabel,
} from '../components/UI';
import { CodeEditor } from '../components/CodeEditor';
import { ItemSwitcher } from '../components/ItemSwitcher';

type ExampleKind = 'probe' | 'docker_env' | 'docker_file';

const EXAMPLE_KINDS: Array<{ id: ExampleKind; label: string; labelEn: string; desc: string; descEn: string }> = [
  {
    id: 'probe',
    label: '连通性探针',
    labelEn: 'Connectivity Probe',
    desc: '最轻量的批处理脚本，验证 Nomad 能换取 Vault Token 并读取指定 Secret 的键名（不输出密码明文）。',
    descEn: 'Minimal batch probe verifying Nomad exchanges OIDC JWT for a Vault token and reads key names (never prints secret values).',
  },
  {
    id: 'docker_env',
    label: '容器环境变量注入',
    labelEn: 'Docker Env Injection',
    desc: '适合一般容器应用：通过 env = true 把 Vault Secret 中的字段自动注入为容器环境变量。',
    descEn: 'For standard container apps: injects Vault Secret fields as container environment variables via env = true.',
  },
  {
    id: 'docker_file',
    label: '容器密码文件挂载',
    labelEn: 'Docker Secret File Mount',
    desc: '适合数据库或支持 *_FILE 的应用：把密码写入权限 0600 的内存文件 /secrets/app.secret，不暴露在环境变量中。',
    descEn: 'For databases or *_FILE apps: renders secrets into /secrets/app.secret (0600 tmpfs) instead of environment variables.',
  },
];

const STAGE_LABELS: Record<string, { zh: string; en: string }> = {
  '1-nomad-jwks': { zh: '1. Nomad JWKS 公钥', en: '1. Nomad JWKS Public Keys' },
  '2-nomad-config': { zh: '2. Nomad 节点配置', en: '2. Nomad Node Config' },
  '3-vault-auth': { zh: '3. Vault JWT 挂载', en: '3. Vault JWT Auth Mount' },
  '4-vault-role': { zh: '4. Role 与 Policy', en: '4. Roles & Policies' },
  '5-login': { zh: '5. 真实任务登录验证', en: '5. Live Job Login Test' },
};

export function IntegrationsPage() {
  const { isAdmin } = useAuth();
  const { locale, isEn, tr } = useI18n();
  const navigate = useNavigate();
  const { tasks, openTask } = useOpsDrawer();
  const [deleting, setDeleting] = useState(false);
  const deleteRef = useRef(false);
  const [deleteTaskId, setDeleteTaskId] = useState('');
  const [applyTaskId, setApplyTaskId] = useState('');
  const [applying, setApplying] = useState(false);
  const applyRef = useRef(false);
  const toast = useToast();
  const askConfirm = useConfirm();

  const [items, setItems] = useState<any[]>([]);
  const [clusters, setClusters] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [plan, setPlan] = useState<any>(null);
  const [doctor, setDoctor] = useState<any>(null);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [doctorWithLogin, setDoctorWithLogin] = useState(false);
  const [doctorLoginRole, setDoctorLoginRole] = useState('');
  const [doctorSecretPath, setDoctorSecretPath] = useState('');
  const [doctorDriver, setDoctorDriver] = useState<'raw_exec' | 'docker'>('docker');
  const [guideExpanded, setGuideExpanded] = useState(false);

  const [exampleModal, setExampleModal] = useState<{
    role: any;
    kind: ExampleKind;
    secretPath: string;
    hcl: string;
    loading: boolean;
  } | null>(null);
  const [err, setErr] = useState('');

  // Context candidates from source Nomad and target Vault clusters
  const [nomadNamespaces, setNomadNamespaces] = useState<string[]>(['default']);
  const [vaultMounts, setVaultMounts] = useState<string[]>([]);

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', source_cluster_id: '', target_cluster_id: '', auth_path: 'jwt-nomad' });
  const [createTouched, setCreateTouched] = useState({ name: false, auth_path: false });
  const [createErr, setCreateErr] = useState('');
  const [showEditIntegration, setShowEditIntegration] = useState(false);
  const [savingIntegration, setSavingIntegration] = useState(false);
  const [editIntegrationForm, setEditIntegrationForm] = useState({
    name: '',
    aud: 'vault.io',
    jwks_mode: 'url',
    jwks_url: '',
    vault_address: '',
    default_role: '',
    identity_ttl: '1h',
  });
  const [showRole, setShowRole] = useState(false);
  const [editingRole, setEditingRole] = useState<any>(null);
  const [savingRole, setSavingRole] = useState(false);
  const [roleForm, setRoleForm] = useState({
    role_name: '',
    policy_mode: 'explicit',
    secret_paths: '',
    custom_policy_hcl: '',
    bound_namespace: 'default',
    token_period: '1h',
  });

  const loadClusterHints = useCallback(async (nomadId?: string, vaultId?: string) => {
    if (nomadId) {
      apiGet(`/api/v1/nomad/${nomadId}/namespaces`)
        .then((res) => {
          const list = (res.namespaces || []).map((n: any) => n.Name || n.name || n).filter(Boolean);
          setNomadNamespaces(list.length > 0 ? list : ['default']);
        })
        .catch(() => setNomadNamespaces(['default']));
    } else {
      setNomadNamespaces(['default']);
    }
    if (vaultId) {
      apiGet(`/api/v1/vault/${vaultId}/kv/mounts`)
        .then((res) => {
          const list = (res.mounts || []).map((m: any) => String(m.path || m).replace(/^\/+|\/+$/g, '')).filter(Boolean);
          setVaultMounts(list);
        })
        .catch(() => setVaultMounts([]));
    } else {
      setVaultMounts([]);
    }
  }, []);

  const load = useCallback(async (focusId?: string) => {
    setErr('');
    try {
      const [iRes, cRes] = await Promise.all([apiGet('/api/v1/integrations'), apiGet('/api/v1/clusters')]);
      const list = iRes.integrations || [];
      const clusterList = cRes.clusters || [];
      setItems(list);
      setClusters(clusterList);
      const targetId = focusId || list[0]?.id;
      if (targetId) {
        const fresh = await apiGet(`/api/v1/integrations/${targetId}`);
        setSelected(fresh.integration);
        void loadClusterHints(fresh.integration?.source_cluster_id, fresh.integration?.target_cluster_id);
      } else {
        setSelected(null);
        const readyNomad = clusterList.find((c: any) => c.type === 'nomad' && c.init_state === 'initialized')?.id;
        const readyVault = clusterList.find((c: any) => c.type === 'vault' && c.init_state === 'initialized')?.id;
        void loadClusterHints(readyNomad, readyVault);
      }
    } catch (ex: any) {
      setErr(ex?.message || tr('加载联动配置失败', 'Failed to load integrations'));
    }
  }, [loadClusterHints, tr]);

  useEffect(() => {
    void load();
  }, [load]);

  const deleteTask = tasks.find((task) => task.id === deleteTaskId);
  const deletePending = Boolean(deleteTaskId && (!deleteTask || isTaskActiveStatus(deleteTask.status)));

  useEffect(() => {
    if (!deleteTask || isTaskActiveStatus(deleteTask.status)) return;
    setDeleteTaskId('');
    setPlan(null);
    setDoctor(null);
    setDoctorOpen(false);
    setExampleModal(null);
    void load();
  }, [deleteTask?.id, deleteTask?.status, load]);

  const applyTask = tasks.find((task) => task.id === applyTaskId);
  const applyPending = Boolean(applyTaskId && (!applyTask || isTaskActiveStatus(applyTask.status)));

  useEffect(() => {
    if (!applyTask || isTaskActiveStatus(applyTask.status)) return;
    setApplyTaskId('');
    setPlan(null);
    void load(applyTask.target_id);
  }, [applyTask?.id, applyTask?.status, load]);

  const applyIntegration = async () => {
    if (!selected || applyRef.current || applyPending) return;
    applyRef.current = true;
    setApplying(true);
    setErr('');
    try {
      const preview = await apiPost(`/api/v1/integrations/${selected.id}/plan`, {});
      if (preview.plan?.errors?.length) throw new Error(preview.plan.errors.join('\n'));
      const source = clusters.find((cluster) => cluster.id === selected.source_cluster_id);
      const confirmSingle = source?.mode === 'single' && preview.plan?.scope === 'vault_and_nomad';
      // 单节点配置下发需要重启服务，确认后才向后端传递维护授权。
      if (confirmSingle && !(await askConfirm(tr('启用联动需要重启这台 Nomad Server，期间调度与 API 会短暂中断。确认现在应用配置吗？', 'Applying this integration restarts the single-node Nomad Server, briefly interrupting scheduling and the API. Apply now?'), {
        title: tr('确认单节点维护', 'Confirm Single-Node Maintenance'), confirmText: tr('确认并应用', 'Apply Now'),
      }))) return;
      const result = await apiPost(`/api/v1/integrations/${selected.id}/apply`, { confirm_single_node: confirmSingle });
      if (result.task?.id) {
        setApplyTaskId(result.task.id);
        openTask(result.task.id, tr(`应用联动：${selected.name}`, `Apply Integration: ${selected.name}`));
      }
    } catch (ex: any) {
      setErr(ex?.message || tr('应用联动失败', 'Failed to apply integration'));
    } finally {
      applyRef.current = false;
      setApplying(false);
    }
  };

  const selectItem = async (id: string) => {
    setErr('');
    setPlan(null);
    setDoctor(null);
    setExampleModal(null);
    try {
      const res = await apiGet(`/api/v1/integrations/${id}`);
      setSelected(res.integration);
      void loadClusterHints(res.integration?.source_cluster_id, res.integration?.target_cluster_id);
    } catch (ex: any) {
      setErr(ex?.message || tr('加载联动详情失败', 'Failed to load integration details'));
    }
  };

  const slugify = (raw: string) =>
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '') || 'cluster';

  const suggestCreateDefaults = (nomadId: string, vaultId: string) => {
    const nomad = clusters.find((c) => c.id === nomadId);
    const nomadSlug = slugify(nomad?.name || 'nomad');
    const usedNames = new Set(items.map((it) => it.name));
    const usedAuths = new Set(items.filter((it) => it.target_cluster_id === vaultId).map((it) => it.auth_path));

    let name = usedNames.has('nomad-vault') ? `${nomadSlug}-vault` : 'nomad-vault';
    if (usedNames.has(name)) {
      let n = 2;
      while (usedNames.has(`${nomadSlug}-vault-${n}`)) n++;
      name = `${nomadSlug}-vault-${n}`;
    }

    let authPath = usedAuths.has('jwt-nomad') ? `jwt-nomad-${nomadSlug}` : 'jwt-nomad';
    if (authPath.length > 63) authPath = authPath.slice(0, 63).replace(/[-_]+$/, '');
    if (usedAuths.has(authPath)) {
      let n = 2;
      while (usedAuths.has(`jwt-nomad-${nomadSlug}-${n}`)) n++;
      authPath = `jwt-nomad-${nomadSlug}-${n}`.slice(0, 63).replace(/[-_]+$/, '');
    }

    return { name, authPath };
  };

  const openCreateModal = () => {
    const nomadClusters = clusters.filter((c) => c.type === 'nomad');
    const vaultClusters = clusters.filter((c) => c.type === 'vault');
    const boundNomadIds = new Set(items.map((it) => it.source_cluster_id));
    const n = nomadClusters.find((c) => !boundNomadIds.has(c.id))?.id || nomadClusters[0]?.id || '';
    const v = vaultClusters[0]?.id || '';
    const { name, authPath } = suggestCreateDefaults(n, v);
    setCreateForm({ name, source_cluster_id: n, target_cluster_id: v, auth_path: authPath });
    setCreateTouched({ name: false, auth_path: false });
    setCreateErr('');
    setShowCreate(true);
  };

  const createIntegration = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setCreateErr('');
    try {
      const nomadDefault = clusters.find((c) => c.type === 'nomad')?.id || '';
      const vaultDefault = clusters.find((c) => c.type === 'vault')?.id || '';
      const res = await apiPost('/api/v1/integrations', {
        ...createForm,
        source_cluster_id: createForm.source_cluster_id || nomadDefault,
        target_cluster_id: createForm.target_cluster_id || vaultDefault,
      });
      setShowCreate(false);
      toast.success(tr(`已创建联动 ${createForm.name}，接下来请添加 Role 并点击「应用联动」`, `Integration ${createForm.name} created. Next add a Role and click "Apply Integration".`));
      await load(res.integration?.id);
    } catch (ex: any) {
      const msg = ex?.message || tr('创建联动失败', 'Failed to create integration');
      setCreateErr(msg);
      toast.error(msg);
    }
  };

  const openEditIntegration = () => {
    if (!selected) return;
    setEditIntegrationForm({
      name: selected.name || '',
      aud: (selected.config?.aud || ['vault.io']).join(', '),
      jwks_mode: selected.config?.jwks_mode || 'url',
      jwks_url: selected.config?.jwks_url || '',
      vault_address: selected.config?.vault_address || '',
      default_role: selected.config?.default_role || '',
      identity_ttl: selected.config?.identity_ttl || '1h',
    });
    setShowEditIntegration(true);
  };

  const updateIntegration = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || savingIntegration) return;
    setSavingIntegration(true);
    setErr('');
    try {
      const aud = editIntegrationForm.aud
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await apiPut(`/api/v1/integrations/${selected.id}`, {
        name: editIntegrationForm.name.trim(),
        aud: aud.length > 0 ? aud : ['vault.io'],
        jwks_mode: editIntegrationForm.jwks_mode,
        jwks_url: editIntegrationForm.jwks_url.trim(),
        vault_address: editIntegrationForm.vault_address.trim(),
        default_role: editIntegrationForm.default_role.trim(),
        identity_ttl: editIntegrationForm.identity_ttl.trim(),
      });
      setShowEditIntegration(false);
      setPlan(null);
      toast.success(tr('联动配置已更新，如需同步到集群请点击「应用联动」', 'Integration updated. Click "Apply Integration" to sync to clusters.'));
      await load(selected.id);
    } catch (ex: any) {
      toast.error(ex?.message || tr('更新联动配置失败', 'Failed to update integration'));
    } finally {
      setSavingIntegration(false);
    }
  };

  const openAddRole = () => {
    setEditingRole(null);
    const defaultMount = vaultMounts[0] || 'secret';
    setRoleForm({
      role_name: '',
      policy_mode: 'explicit',
      secret_paths: `${defaultMount}/apps/app`,
      custom_policy_hcl: '',
      bound_namespace: nomadNamespaces[0] || 'default',
      token_period: '1h',
    });
    setShowRole(true);
  };

  const openEditRole = (r: any) => {
    setEditingRole(r);
    setRoleForm({
      role_name: r.role_name || '',
      policy_mode: r.policy_mode || 'explicit',
      secret_paths: (r.secret_paths || []).join(', '),
      custom_policy_hcl: r.custom_policy_hcl || '',
      bound_namespace: r.bound_claims?.nomad_namespace || 'default',
      token_period: r.token_period || '1h',
    });
    setShowRole(true);
  };

  const saveRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || savingRole) return;
    setSavingRole(true);
    setErr('');
    try {
      const rawPaths = roleForm.secret_paths
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const normalizedPaths = roleForm.policy_mode === 'explicit'
        ? rawPaths.map((p) => parseKVPath(p, 'secret', locale).rolePath || p)
        : rawPaths.map((p) => p.replace(/^\/+|\/+$/g, ''));
      const payload: Record<string, any> = {
        role_name: editingRole ? editingRole.role_name : roleForm.role_name.trim(),
        policy_mode: roleForm.policy_mode,
        secret_paths: normalizedPaths,
        bound_claims: {
          ...(editingRole?.bound_claims || {}),
          nomad_namespace: roleForm.bound_namespace.trim(),
        },
        token_period: roleForm.token_period.trim(),
      };
      if (editingRole?.policy_name) payload.policy_name = editingRole.policy_name;
      if (roleForm.custom_policy_hcl.trim()) {
        payload.custom_policy_hcl = roleForm.custom_policy_hcl.trim();
      } else {
        payload.custom_policy_hcl = '';
      }

      if (editingRole) {
        await apiPut(`/api/v1/integrations/${selected.id}/roles/${editingRole.id}`, payload);
        toast.success(tr(`已更新工作负载 Role ${payload.role_name}，请点击「应用联动」使其生效`, `Updated role ${payload.role_name}. Click "Apply Integration" to take effect.`));
      } else {
        await apiPost(`/api/v1/integrations/${selected.id}/roles`, payload);
        toast.success(tr(`已保存工作负载 Role ${payload.role_name}，请点击「应用联动」使其生效`, `Saved role ${payload.role_name}. Click "Apply Integration" to take effect.`));
      }
      setShowRole(false);
      setEditingRole(null);
      setPlan(null);
      await selectItem(selected.id);
    } catch (ex: any) {
      toast.error(ex?.message || tr('保存 Role 失败', 'Failed to save role'));
    } finally {
      setSavingRole(false);
    }
  };

  const deleteIntegration = async () => {
    if (!selected || deleteRef.current || deletePending) return;
    if (
      !(await askConfirm(tr(`确定要删除联动配置「${selected.name}」吗？`, `Delete integration "${selected.name}"?`), {
        title: tr('删除集群联动', 'Delete Integration'),
        confirmText: tr('确认删除', 'Delete'),
        danger: true,
      }))
    ) {
      return;
    }
    if (deleteRef.current) return;
    deleteRef.current = true;
    setDeleting(true);
    try {
      const res = await apiDelete(`/api/v1/integrations/${selected.id}`);
      if (res?.task?.id) {
        setDeleteTaskId(res.task.id);
        openTask(res.task.id, tr(`删除联动：${selected.name}`, `Delete Integration: ${selected.name}`));
      } else {
        setSelected(null);
        toast.success(tr('联动配置已删除', 'Integration deleted'));
        await load();
      }
    } catch (ex: any) {
      toast.error(ex?.message || tr('删除联动失败', 'Failed to delete integration'));
    } finally {
      deleteRef.current = false;
      setDeleting(false);
    }
  };

  const deleteRole = async (r: any) => {
    if (!selected) return;
    if (
      !(await askConfirm(tr(`确认删除工作负载 Role「${r.role_name}」吗？`, `Delete workload role "${r.role_name}"?`), {
        title: tr('删除 Role', 'Delete Role'),
        confirmText: tr('确认删除', 'Delete'),
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await apiDelete(`/api/v1/integrations/${selected.id}/roles/${r.id}`);
      toast.success(tr(`已删除 Role ${r.role_name}`, `Deleted role ${r.role_name}`));
      await selectItem(selected.id);
    } catch (ex: any) {
      toast.error(ex?.message || tr('删除 Role 失败', 'Failed to delete role'));
    }
  };

  const runDoctor = async (overrideLogin?: boolean) => {
    if (!selected || doctorRunning) return;
    setDoctorRunning(true);
    const useLogin = overrideLogin ?? doctorWithLogin;
    try {
      const payload: Record<string, string> = {};
      if (useLogin && doctorLoginRole) {
        payload.login_role = doctorLoginRole;
        payload.driver = doctorDriver;
        if (doctorSecretPath.trim()) {
          payload.secret_path = parseKVPath(doctorSecretPath, 'secret', locale).rolePath;
        }
      }
      const r = await apiPost(`/api/v1/integrations/${selected.id}/doctor`, payload);
      setDoctor(r.report);
      setDoctorOpen(true);
      await load(selected.id);
    } catch (ex: any) {
      toast.error(ex?.message || tr('联动体检失败', 'Integration doctor check failed'));
    } finally {
      setDoctorRunning(false);
    }
  };

  const openDoctorModal = () => {
    const firstRole = selected?.roles?.[0];
    if (firstRole && !doctorLoginRole) {
      setDoctorLoginRole(firstRole.role_name);
      const firstPath = (firstRole.secret_paths || [])[0] || '';
      if (firstPath && !firstPath.includes('*')) setDoctorSecretPath(firstPath);
    }
    setDoctorOpen(true);
    if (!doctor) {
      void runDoctor(false);
    }
  };

  const fetchExample = async (roleObj: any, kind: ExampleKind, secretPath: string) => {
    if (!selected) return;
    setExampleModal({
      role: roleObj,
      kind,
      secretPath,
      hcl: exampleModal?.hcl || '',
      loading: true,
    });
    try {
      const res = await apiPost(`/api/v1/integrations/${selected.id}/job-example`, {
        role: roleObj.role_name,
        secret_path: secretPath,
        template_kind: kind,
      });
      setExampleModal({
        role: roleObj,
        kind,
        secretPath,
        hcl: res.hcl || '',
        loading: false,
      });
    } catch (ex: any) {
      setExampleModal((prev) => (prev ? { ...prev, loading: false } : null));
      toast.error(ex?.message || tr('生成示例 Job 失败', 'Failed to generate example job'));
    }
  };

  const openExampleForRole = (r: any) => {
    const rawFirst = (r.secret_paths || [])[0] || 'secret/apps/demo';
    const concreteExplicit = rawFirst.includes('*') ? rawFirst.replace(/\*/g, 'demo') : rawFirst;
    const defaultPath = r.policy_mode === 'explicit'
      ? concreteExplicit
      : `${(r.secret_paths || [])[0] || 'secret'}/${r.bound_claims?.nomad_namespace || 'default'}/vault-app`;
    void fetchExample(r, 'docker_env', defaultPath);
  };

  const sendExampleToJobCenter = () => {
    if (!selected || !exampleModal?.hcl) return;
    const ns = exampleModal.role?.bound_claims?.nomad_namespace || 'default';
    try {
      window.sessionStorage.setItem(
        INTEGRATION_DRAFT_JOB_STORAGE_KEY,
        JSON.stringify({
          clusterId: selected.source_cluster_id,
          namespace: ns,
          hcl: exampleModal.hcl,
          roleName: exampleModal.role?.role_name,
          integrationName: selected.name,
        }),
      );
    } catch {
      // Ignore storage quota errors and fall back to URL parameters.
    }
    navigate(`/jobs?cluster_id=${encodeURIComponent(selected.source_cluster_id)}&namespace=${encodeURIComponent(ns)}&from=integration`);
  };

  // Compute progress steps for the onboarding pipeline
  const readyNomad = clusters.find((c) => c.type === 'nomad' && c.init_state === 'initialized');
  const readyVault = clusters.find((c) => c.type === 'vault' && c.init_state === 'initialized' && c.health_status === 'healthy');
  const anyVault = clusters.find((c) => c.type === 'vault');
  const targetVaultId = selected?.target_cluster_id || readyVault?.id || anyVault?.id || '';

  const hasBothClusters = Boolean(readyNomad && readyVault);
  const hasKVMounts = vaultMounts.length > 0;
  const hasIntegrationAndRole = Boolean(selected && (selected.roles || []).length > 0);
  const needsApply = Boolean(
    selected && (selected.status !== 'applied' || (selected.roles || []).some((r: any) => r.status !== 'applied')),
  );
  const isApplied = Boolean(selected && !needsApply);
  const lastDoc = doctor || selected?.last_doctor;
  const doctorPassed = Boolean(
    lastDoc && Array.isArray(lastDoc.checks) && lastDoc.checks.length > 0 && !lastDoc.checks.some((c: any) => c.status === 'FAIL'),
  );

  const pipelineSteps = [
    {
      num: '1',
      title: tr('准备 Nomad 与 Vault', 'Prepare Nomad & Vault'),
      desc: hasBothClusters
        ? tr(`${readyNomad.name} 与 ${readyVault.name} 已就绪`, `${readyNomad.name} and ${readyVault.name} are ready`)
        : tr('需要至少 1 个已部署 Nomad 和 1 个已解封 Vault', 'Requires at least 1 initialized Nomad and 1 unsealed Vault cluster'),
      done: hasBothClusters,
      cta: !readyNomad ? { label: tr('去建 Nomad', 'Setup Nomad'), to: '/nomad' } : !readyVault ? { label: tr('去建/解封 Vault', 'Setup / Unseal Vault'), to: '/vault' } : null,
    },
    {
      num: '2',
      title: tr('在 Vault 存入密钥', 'Store Secrets in Vault'),
      desc: hasKVMounts
        ? tr(`已启用 KV 存储：${vaultMounts.join(', ')}`, `KV mounts enabled: ${vaultMounts.join(', ')}`)
        : tr('在 Vault 启用 KV v2 并建一条应用密钥', 'Enable KV v2 in Vault and create an app secret'),
      done: hasKVMounts,
      cta: targetVaultId ? { label: tr('去 Vault 管理密钥', 'Manage Secrets'), to: `/vault?id=${targetVaultId}&tab=manage` } : { label: tr('前往 Vault', 'Go to Vault'), to: '/vault' },
    },
    {
      num: '3',
      title: tr('建联动并添加 Role', 'Create Integration & Role'),
      desc: hasIntegrationAndRole
        ? tr(`已配置 ${(selected.roles || []).length} 个工作负载 Role`, `${(selected.roles || []).length} workload role(s) configured`)
        : tr('Role 用来指定“哪个命名空间能读哪条路径”', 'A Role defines which Nomad namespace can read which secret paths'),
      done: hasIntegrationAndRole,
      cta: null,
    },
    {
      num: '4',
      title: tr('点击「应用联动」', 'Apply Integration'),
      desc: isApplied
        ? tr('配置已下发到 Nomad 与 Vault', 'Configuration synced to Nomad and Vault')
        : tr('草稿修改必须点「应用联动」后才真正生效', 'Draft edits take effect only after clicking "Apply Integration"'),
      done: isApplied,
      cta: null,
    },
    {
      num: '5',
      title: tr('体检与真实登录测试', 'Doctor & Live Login Test'),
      desc: doctorPassed
        ? tr(`最近体检：${lastDoc.summary}`, `Latest check: ${lastDoc.summary}`)
        : tr('一键检验双向信任并可实测 Job 获取密钥', 'Verify OIDC/JWT trust and test reading secrets from a live job'),
      done: doctorPassed,
      cta: null,
    },
    {
      num: '6',
      title: tr('在 Job 中使用', 'Use in Nomad Jobs'),
      desc: tr('点 Role 旁的「示例 Job」一键带入 Job 中心运行', 'Click "Sample Job" next to a Role to launch it in Job Center'),
      done: isApplied && doctorPassed,
      cta: readyNomad ? { label: tr('打开 Job 中心', 'Open Job Center'), to: `/jobs?cluster_id=${readyNomad.id}` } : { label: tr('打开 Job 中心', 'Open Job Center'), to: '/jobs' },
    },
  ];

  // Role form live path preview
  const roleParsedPreviews = roleForm.secret_paths
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => parseKVPath(raw, vaultMounts[0] || 'secret', locale));
  const validRolePreviews = roleParsedPreviews.filter((p) => p.path);
  const hasAccidentalDataPrefix = roleForm.policy_mode === 'explicit' && roleParsedPreviews.some((p) => p.hadDataPrefix);
  const hasTrailingSlashWarning = roleForm.policy_mode === 'explicit' && validRolePreviews.some((p) => p.hasTrailingSlash && !p.isWildcard);

  return (
    <div className="space-y-5">
      <PageHeader
        title={tr('集群联动', 'Integrations')}
        subtitle={tr('让 Nomad 任务自动拿“动态门禁卡”去 Vault 安全读取密码，无需在 Job 中写死任何凭据', 'Let Nomad jobs exchange OIDC workload identities for dynamic Vault tokens without hardcoding secrets')}
        actions={
          <>
            <Button onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" />
              <span>{tr('刷新', 'Refresh')}</span>
            </Button>
            {isAdmin && (
              <Button variant="primary" onClick={openCreateModal}>
                <Plus className="h-4 w-4" />
                <span>{tr('新建联动', 'New Integration')}</span>
              </Button>
            )}
          </>
        }
      />

      {/* 6 步通关向导：未应用时展开；已应用时默认收起为一行状态条，按需展开 */}
      {(() => {
        const showFullGuide = !isApplied || guideExpanded;
        const doneCount = pipelineSteps.filter((s) => s.done).length;
        if (!showFullGuide) {
          return (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200/80 bg-emerald-50/40 px-4 py-3 text-xs dark:border-emerald-500/25 dark:bg-emerald-950/20">
              <div className="flex flex-wrap items-center gap-2.5 min-w-0">
                <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700 dark:text-emerald-300 shrink-0">
                  <CheckCircle2 className="h-4 w-4" />
                  {tr('联动配置已下发生效', 'Integration Applied & Active')}
                </span>
                <span className="text-slate-500 dark:text-slate-400">
                  {tr(
                    <>已完成 {doneCount}/{pipelineSteps.length} 步 · Role 填路径不写 <code className="font-mono">data/</code>，Job 模板读 KV v2 需加 <code className="font-mono">/data/</code></>,
                    <>Completed {doneCount}/{pipelineSteps.length} steps · Omit <code className="font-mono">data/</code> in Role paths; add <code className="font-mono">/data/</code> in KV v2 job templates</>,
                  )}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3 shrink-0">
                <Link
                  to={targetVaultId ? `/vault?id=${targetVaultId}&tab=manage` : '/vault'}
                  className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  <span>{tr('Vault 密钥', 'Vault Secrets')}</span>
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
                <Link
                  to={readyNomad ? `/jobs?cluster_id=${readyNomad.id}` : '/jobs'}
                  className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  <span>{tr('Job 中心', 'Job Center')}</span>
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
                <button
                  type="button"
                  onClick={() => setGuideExpanded(true)}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200/80 bg-white px-2.5 py-1 font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                >
                  <span>{tr('展开 6 步指南', 'Show 6-Step Guide')}</span>
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        }
        return (
          <div className="rounded-2xl border border-indigo-200/80 bg-gradient-to-br from-indigo-50/70 via-white to-white p-5 text-sm dark:border-indigo-500/30 dark:from-indigo-950/35 dark:via-slate-900 dark:to-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-slate-900 dark:text-slate-100">{tr('联动上手 6 步通关路线', '6-Step Integration Setup Guide')}</h2>
                  <Badge tone={isApplied ? 'green' : 'blue'}>{doneCount} / {pipelineSteps.length}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {tr(
                    <>照着顺序完成每一步。小提醒：<strong>Role 里填路径不写 data/，Job 模板里读 KV v2 必须多写一层 /data/</strong>。</>,
                    <>Follow each step in order. Tip: <strong>omit data/ in Role paths, and include /data/ inside KV v2 Job templates</strong>.</>,
                  )}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selected && isAdmin && !selected.roles?.length && (
                  <Button size="sm" variant="primary" onClick={openAddRole}>
                    <Plus className="h-3.5 w-3.5" />
                    <span>{tr('添加第一个 Role', 'Add First Role')}</span>
                  </Button>
                )}
                {selected && isAdmin && needsApply && (
                  <Button size="sm" variant="primary" loading={applying} disabled={applyPending || deletePending} onClick={() => void applyIntegration()}>
                    {applyPending ? tr('正在应用…', 'Applying...') : tr('立即应用联动', 'Apply Integration')}
                  </Button>
                )}
                {isApplied && (
                  <button
                    type="button"
                    onClick={() => setGuideExpanded(false)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200/80 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                  >
                    <span>{tr('收起指南', 'Collapse Guide')}</span>
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {pipelineSteps.map((st) => (
                <div
                  key={st.num}
                  className={`flex flex-col justify-between rounded-xl border p-3.5 text-xs transition ${
                    st.done
                      ? 'border-emerald-200 bg-emerald-50/40 dark:border-emerald-500/30 dark:bg-emerald-950/20'
                      : 'border-slate-200/90 bg-white/80 dark:border-slate-800 dark:bg-slate-950/40'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-800 dark:text-slate-100">
                        {st.num}. {st.title}
                      </span>
                      {st.done && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />}
                    </div>
                    <p className="mt-1.5 leading-5 text-slate-500 dark:text-slate-400">{st.desc}</p>
                  </div>
                  {st.cta && (
                    <Link
                      to={st.cta.to}
                      className="mt-2.5 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      <span>{st.cta.label}</span>
                      <ArrowRight className="h-3 w-3" />
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* 草稿/未应用醒目提醒 */}
      {selected && needsApply && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50/90 px-4 py-3 text-xs text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
            <span>
              {tr(
                <>当前联动或部分 Role 处于<strong>待应用（草稿/异常）</strong>状态，尚未下发到 Nomad 和 Vault 集群。请先点击「应用联动」，否则 Job 运行时无法获取密钥。</>,
                <>This integration or some roles are <strong>pending apply</strong> and not yet synced to Nomad & Vault. Click &quot;Apply Integration&quot; before submitting jobs.</>,
              )}
            </span>
          </div>
          {isAdmin && (
            <Button size="sm" variant="primary" loading={applying} disabled={applyPending || deletePending} onClick={() => void applyIntegration()}>
              {applyPending ? tr('正在应用…', 'Applying...') : tr('立即应用联动', 'Apply Integration')}
            </Button>
          )}
        </div>
      )}

      <ItemSwitcher
        label={tr('联动配置', 'Integration')}
        selectedId={selected?.id || ''}
        onSelect={(id) => void selectItem(id)}
        items={items.map((it) => ({
          id: it.id,
          name: it.name,
          status: it.status,
          subtitle: `${it.source_cluster || it.source_cluster_id} ↔ ${it.target_cluster || it.target_cluster_id}`,
        }))}
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {!selected ? (
        <Card>
          <EmptyState
            icon={<Link2 className="w-6 h-6" />}
            title={tr('暂无 Nomad-Vault 联动配置', 'No Nomad-Vault Integrations')}
            description={tr('点击右上角「新建联动」，选好 Nomad 与 Vault 集群，即可打通自动认证并生成可直接使用的工作负载示例。', 'Click "New Integration" above to link a Nomad cluster with a Vault cluster and generate ready-to-run workload examples.')}
          />
        </Card>
      ) : (
        <div className="space-y-4">
          <Card
            title={`${selected.name} (${selected.source_cluster || selected.source_cluster_id} ↔ ${selected.target_cluster || selected.target_cluster_id})`}
            actions={
              isAdmin && (
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" onClick={openEditIntegration}>
                    <Pencil className="h-3.5 w-3.5" />
                    <span>{tr('编辑', 'Edit')}</span>
                  </Button>
                  <Button
                    size="sm"
                    title={tr('对比 Nomad 联动配置、Vault JWT Auth 挂载、Role 与 Policy 期望状态与当前线上状态的差异', 'Preview changes across Nomad config, Vault JWT Auth mount, Roles, and Policies')}
                    onClick={() =>
                      void apiPost(`/api/v1/integrations/${selected.id}/plan`, {})
                        .then((r) => setPlan(r.plan))
                        .catch((ex) => toast.error(ex.message))
                    }
                  >
                    {tr('Plan 预览', 'Plan Preview')}
                  </Button>
                  <Button
                    size="sm"
                    variant={needsApply ? 'primary' : 'secondary'}
                    loading={applying}
                    disabled={applyPending || deletePending}
                    onClick={() => void applyIntegration()}
                  >
                    {applyPending ? tr('正在应用…', 'Applying...') : needsApply ? tr('应用联动', 'Apply Integration') : tr('重新应用', 'Re-apply')}
                  </Button>
                  <Button
                    size="sm"
                    title={tr('依次检验 Nomad JWKS 公钥、节点配置、Vault JWT 挂载与 Role，并支持直接跑一次真实任务验证登录读密钥', 'Verify Nomad JWKS, node config, Vault JWT mount, and Roles, with optional live job test')}
                    onClick={openDoctorModal}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    <span>{tr('链路体检', 'Doctor Check')}</span>
                  </Button>
                  <Button size="sm" variant="danger-outline" loading={deleting} disabled={deletePending} onClick={() => void deleteIntegration()}>
                    {deletePending ? tr('正在删除…', 'Deleting...') : tr('删除', 'Delete')}
                  </Button>
                </div>
              )
            }
          >
            <div className="mb-5 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 rounded-xl border border-slate-200/80 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-950/40">
                <div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    <TermLabel term="Auth Mount" tip={tr('Vault 中启用 JWT 认证引擎的挂载路径，用于校验 Nomad 签发给工作负载的身份 JWT（OIDC / JWKS）。', 'Vault JWT Auth mount path used to verify workload identity JWTs issued by Nomad.')} />
                  </div>
                  <div className="mt-1 font-mono font-semibold text-slate-900 dark:text-slate-100 truncate">{selected.auth_path}</div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{tr('JWKS 模式', 'JWKS Mode')}</div>
                  <div className="mt-1 font-mono font-semibold text-slate-900 dark:text-slate-100">{selected.config?.jwks_mode || 'url'}</div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">Audience</div>
                  <div className="mt-1 font-mono font-semibold text-slate-900 dark:text-slate-100 truncate">{(selected.config?.aud || ['vault.io']).join(', ')}</div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{tr('身份 TTL', 'Identity TTL')}</div>
                  <div className="mt-1 font-mono font-semibold text-slate-900 dark:text-slate-100">{selected.config?.identity_ttl || '1h'}</div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{tr('当前状态', 'Status')}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <StatusBadge value={selected.status} />
                    {selected.config?.default_role && (
                      <Badge>{tr('默认', 'Default')} {selected.config.default_role}</Badge>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-4 text-[11px]">
                <Link
                  to={`/nomad?id=${encodeURIComponent(selected.source_cluster_id)}`}
                  className="inline-flex items-center gap-0.5 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  <span>{tr('查看 Nomad 集群', 'Open Nomad Cluster')}</span>
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
                <Link
                  to={`/vault?id=${encodeURIComponent(selected.target_cluster_id)}`}
                  className="inline-flex items-center gap-0.5 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  <span>{tr('查看 Vault 集群', 'Open Vault Cluster')}</span>
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
                <Link
                  to={`/jobs?cluster_id=${encodeURIComponent(selected.source_cluster_id)}`}
                  className="inline-flex items-center gap-0.5 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  <span>{tr('前往 Job 中心', 'Go to Job Center')}</span>
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            </div>

            <div className="mb-2.5 flex items-center justify-between gap-2">
              <div>
                <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">{tr('工作负载 Roles', 'Workload Roles')}</span>
                <span className="ml-2 text-[11px] text-slate-500">{tr('每个 Role 决定 Job 的 vault.role 能读 Vault 里哪几条路径', 'Each Role controls which Vault secret paths a Job referencing vault.role may access')}</span>
              </div>
              {isAdmin && (
                <Button size="sm" onClick={openAddRole}>
                  <Plus className="h-3.5 w-3.5" />
                  <span>{tr('添加 Role', 'Add Role')}</span>
                </Button>
              )}
            </div>
            {(selected.roles || []).length === 0 ? (
              <EmptyState title={tr('暂无 Role', 'No Roles')} description={tr('添加至少一个工作负载 Role（例如 postgres），授权它读取 Vault 里的某个密钥路径。', 'Add at least one workload Role (e.g. postgres) authorizing it to read a Vault secret path.')} />
            ) : (
              <div className="space-y-2 text-xs">
                {selected.roles.map((r: any) => (
                  <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">{r.role_name}</span>
                      <StatusBadge value={r.status} />
                      {r.custom_policy_hcl && <Badge tone="blue">{tr('自定义 Policy', 'Custom Policy')}</Badge>}
                      <span className="text-slate-500 break-all">
                        {r.custom_policy_hcl
                          ? tr('自定义 Vault Policy HCL', 'Custom Vault Policy HCL')
                          : `${r.policy_mode === 'explicit' ? tr('指定固定路径', 'Explicit Paths') : tr('按任务自动隔离', 'Templated Per-Job')} · ${(r.secret_paths || []).join(', ') || tr('默认挂载', 'Default Mount')}`} · Namespace: {r.bound_claims?.nomad_namespace || 'default'} · {tr('周期', 'Period')}: {r.token_period || '1h'}
                      </span>
                    </div>
                    {isAdmin && (
                      <div className="flex flex-wrap gap-1.5 shrink-0">
                        <Button size="sm" aria-label={tr(`编辑 Role ${r.role_name}`, `Edit Role ${r.role_name}`)} onClick={() => openEditRole(r)}>
                          <Pencil className="h-3.5 w-3.5" />
                          <span>{tr('编辑', 'Edit')}</span>
                        </Button>
                        <Button size="sm" onClick={() => openExampleForRole(r)}>
                          <Play className="h-3.5 w-3.5 text-indigo-500" />
                          <span>{tr('示例 Job', 'Sample Job')}</span>
                        </Button>
                        <Button size="sm" variant="danger-outline" aria-label={tr(`删除 Role ${r.role_name}`, `Delete Role ${r.role_name}`)} onClick={() => void deleteRole(r)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Plan 预览弹窗：顶部人话摘要 + 下方原始 JSON */}
      <Modal open={Boolean(plan)} title={tr('联动 Plan 预览', 'Integration Plan Preview')} onClose={() => setPlan(null)} wide>
        {plan && (
          <div className="space-y-3 text-xs">
            {plan.errors?.length > 0 && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-900 dark:border-rose-500/30 dark:bg-rose-950/30 dark:text-rose-200">
                <div className="font-semibold mb-1">{tr('预检未通过（应用前需先处理）：', 'Preflight errors (resolve before applying):')}</div>
                <ul className="list-disc pl-4 space-y-1">
                  {plan.errors.map((e: string, idx: number) => <li key={idx}>{e}</li>)}
                </ul>
              </div>
            )}
            {plan.warnings?.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
                <div className="font-semibold mb-1">{tr('注意事项：', 'Warnings:')}</div>
                <ul className="list-disc pl-4 space-y-1">
                  {plan.warnings.map((w: string, idx: number) => <li key={idx}>{w}</li>)}
                </ul>
              </div>
            )}
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 space-y-2 dark:border-slate-800 dark:bg-slate-950/50">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-800 dark:text-slate-100">{tr('本次应用将会做什么', 'What Apply Will Do')}</span>
                <Badge tone={plan.scope === 'vault_and_nomad' ? 'amber' : 'green'}>
                  {plan.scope === 'vault_and_nomad' ? tr('会更新 Vault 并滚动重启 Nomad 节点', 'Updates Vault & restarts Nomad nodes') : tr('仅更新 Vault，不重启 Nomad', 'Vault-only update, no Nomad restart')}
                </Badge>
              </div>
              <ul className="space-y-1 text-slate-600 dark:text-slate-300">
                <li>
                  • <strong>{tr('Vault 侧', 'Vault')}</strong>
                  {tr(
                    <>：配置 JWT 认证路径 <code className="font-mono">{plan.auth_path}</code>（公钥来源：<code className="font-mono">{plan.jwks_url}</code>），同步 {Object.keys(plan.roles || {}).length} 个 Role 与对应 Policy。</>,
                    <>: Configure JWT auth mount <code className="font-mono">{plan.auth_path}</code> (JWKS: <code className="font-mono">{plan.jwks_url}</code>) and sync {Object.keys(plan.roles || {}).length} role(s) and policies.</>,
                  )}
                </li>
                <li>
                  • <strong>{tr('Nomad 侧', 'Nomad')}</strong>
                  {plan.scope === 'vault_and_nomad'
                    ? tr(`：下发 Vault 联动地址（${plan.vault_address}）与 CA 证书到 Nomad 节点，并触发节点配置生效。`, `: Push Vault address (${plan.vault_address}) and CA cert to Nomad nodes and apply config.`)
                    : tr('：Nomad 节点侧配置无变化，无需重启任何节点。', ': No Nomad node config changes required; zero restarts.')}
                </li>
              </ul>
            </div>
            <details>
              <summary className="cursor-pointer py-1 font-medium text-slate-600 dark:text-slate-300">{tr('查看完整 Plan JSON 详情', 'View Full Plan JSON')}</summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded-xl bg-slate-950 p-4 font-mono text-[11px] text-slate-100">
                {JSON.stringify(plan, null, 2)}
              </pre>
            </details>
            <div className="flex justify-end">
              <Button size="sm" variant="primary" onClick={() => setPlan(null)}>{tr('关闭', 'Close')}</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* 链路体检 + 真实登录验证弹窗 */}
      <Modal open={doctorOpen} title={tr('联动链路体检', 'Integration Doctor Check')} onClose={() => setDoctorOpen(false)} wide>
        <div className="space-y-4 text-xs">
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 space-y-3 dark:border-slate-800 dark:bg-slate-950/40">
            <label className="flex items-center gap-2 font-medium text-slate-800 dark:text-slate-100">
              <input
                type="checkbox"
                checked={doctorWithLogin}
                onChange={(e) => setDoctorWithLogin(e.target.checked)}
              />
              <span>{tr('同时在 Nomad 真实提交一个短探针任务，实测换取 Vault Token 与读取密钥', 'Also submit a short probe job in Nomad to verify live Vault token exchange & secret read')}</span>
            </label>
            {doctorWithLogin && (
              <div className="grid gap-2.5 sm:grid-cols-3">
                <Select
                  label={tr('测试 Role', 'Test Role')}
                  value={doctorLoginRole}
                  onChange={(e) => {
                    const next = e.target.value;
                    setDoctorLoginRole(next);
                    const found = (selected?.roles || []).find((r: any) => r.role_name === next);
                    const p = (found?.secret_paths || [])[0] || '';
                    if (p && !p.includes('*')) setDoctorSecretPath(p);
                  }}
                >
                  <option value="">{tr('请选择 Role', 'Select Role')}</option>
                  {(selected?.roles || []).map((r: any) => (
                    <option key={r.id} value={r.role_name}>{r.role_name}</option>
                  ))}
                </Select>
                <Input
                  label={tr('顺带测试读取的密钥路径（可选）', 'Secret Path to Read (optional)')}
                  placeholder={tr('例如 secret/apps/postgres', 'e.g. secret/apps/postgres')}
                  value={doctorSecretPath}
                  onChange={(e) => setDoctorSecretPath(e.target.value)}
                />
                <Select
                  label={tr('探针 Driver', 'Probe Driver')}
                  value={doctorDriver}
                  onChange={(e) => setDoctorDriver(e.target.value as 'raw_exec' | 'docker')}
                >
                  <option value="docker">{tr('docker（推荐，默认开箱可用）', 'docker (recommended, out-of-the-box)')}</option>
                  <option value="raw_exec">{tr('raw_exec（需在节点启用 raw_exec）', 'raw_exec (requires raw_exec enabled)')}</option>
                </Select>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-500">
                {doctor?.summary ? tr(`最近结果：${doctor.summary}`, `Latest result: ${doctor.summary}`) : tr('点击右侧按钮执行体检', 'Click the button on the right to run checks')}
              </span>
              <Button size="sm" variant="primary" loading={doctorRunning} onClick={() => void runDoctor()}>
                {doctorWithLogin ? tr('运行全链路实测体检', 'Run Full Live Check') : tr('重新运行基础体检', 'Re-run Basic Check')}
              </Button>
            </div>
          </div>

          {doctor && (
            <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
              {(doctor.checks || []).map((c: any, i: number) => (
                <div key={i} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-800 dark:text-slate-100">
                      <span className="text-slate-400 mr-1.5">{(isEn ? STAGE_LABELS[c.node]?.en : STAGE_LABELS[c.node]?.zh) || c.node}</span>
                      <b>{c.name}</b>
                    </span>
                    <StatusBadge value={c.status} />
                  </div>
                  <p className="text-slate-600 dark:text-slate-300 break-all">{c.message}</p>
                  {c.hint && <p className="text-[11px] text-amber-700 dark:text-amber-300">{tr('建议：', 'Hint: ')}{c.hint}</p>}
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end">
            <Button size="sm" onClick={() => setDoctorOpen(false)}>{tr('关闭', 'Close')}</Button>
          </div>
        </div>
      </Modal>

      {/* 多场景示例 Job 弹窗 + 一键带入 Job 中心 */}
      <Modal
        open={Boolean(exampleModal)}
        title={tr(`示例 Nomad Job · Role: ${exampleModal?.role?.role_name || ''}`, `Sample Nomad Job · Role: ${exampleModal?.role?.role_name || ''}`)}
        onClose={() => setExampleModal(null)}
        wide
      >
        {exampleModal && (
          <div className="space-y-3 text-xs">
            {(selected?.status !== 'applied' || exampleModal.role?.status !== 'applied') && (
              <div className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{tr('提示：当前联动或该 Role 尚未点击「应用联动」下发，直接提交此 Job 会鉴权失败。', 'Note: Integration or Role has not been applied yet; submitting this Job will fail Vault auth until applied.')}</span>
              </div>
            )}

            <div className="flex flex-wrap gap-1.5">
              {EXAMPLE_KINDS.map((k) => (
                <Button
                  key={k.id}
                  size="sm"
                  variant={exampleModal.kind === k.id ? 'primary' : 'secondary'}
                  onClick={() => void fetchExample(exampleModal.role, k.id, exampleModal.secretPath)}
                >
                  {isEn ? k.labelEn : k.label}
                </Button>
              ))}
            </div>

            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-300">
              {(() => {
                const found = EXAMPLE_KINDS.find((k) => k.id === exampleModal.kind);
                return found ? (isEn ? found.descEn : found.desc) : '';
              })()}
            </p>

            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  label={tr('示例要读取的 Secret 路径（格式 <KV挂载>/<路径>，无需写 data/）', 'Secret Path to Read (<mount>/<path>, without data/)')}
                  value={exampleModal.secretPath}
                  onChange={(e) => setExampleModal({ ...exampleModal, secretPath: e.target.value })}
                  placeholder={tr('例如 secret/apps/postgres', 'e.g. secret/apps/postgres')}
                />
              </div>
              <Button
                size="sm"
                loading={exampleModal.loading}
                onClick={() => void fetchExample(exampleModal.role, exampleModal.kind, exampleModal.secretPath)}
              >
                {tr('重新生成 HCL', 'Regenerate HCL')}
              </Button>
            </div>

            <CodeEditor value={exampleModal.hcl} readOnly height="300px" />

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <Button
                size="sm"
                onClick={() =>
                  void copyText(exampleModal.hcl)
                    .then(() => toast.success(tr('已复制示例 HCL', 'Copied sample HCL')))
                    .catch((ex) => toast.error(ex.message))
                }
              >
                <Copy className="h-3.5 w-3.5" />
                <span>{tr('复制 HCL', 'Copy HCL')}</span>
              </Button>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setExampleModal(null)}>{tr('关闭', 'Close')}</Button>
                <Button size="sm" variant="primary" onClick={sendExampleToJobCenter}>
                  <span>{tr('一键带入 Job 中心', 'Open in Job Center')}</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* 新建联动：智能推荐未绑定集群与不冲突名称/Auth Mount */}
      <Modal open={showCreate} title={tr('新建 Nomad-Vault 联动', 'New Nomad-Vault Integration')} onClose={() => setShowCreate(false)}>
        {(() => {
          const nomadClusters = clusters.filter((c) => c.type === 'nomad');
          const vaultClusters = clusters.filter((c) => c.type === 'vault');
          const selectedNomadId = createForm.source_cluster_id || nomadClusters[0]?.id || '';
          const selectedVaultId = createForm.target_cluster_id || vaultClusters[0]?.id || '';
          const existingForNomad = items.find((it) => it.source_cluster_id === selectedNomadId);
          return (
            <form onSubmit={createIntegration} className="space-y-3 text-xs">
              <ErrorAlert message={createErr} onClose={() => setCreateErr('')} />
              <Input
                label={tr('联动名称', 'Integration Name')}
                required
                placeholder={tr('例如 nomad-vault', 'e.g. nomad-vault')}
                value={createForm.name}
                onChange={(e) => {
                  setCreateTouched((prev) => ({ ...prev, name: true }));
                  setCreateForm({ ...createForm, name: e.target.value });
                }}
              />
              <Select
                label={tr('Nomad 集群（使用密码的任务跑在这里）', 'Nomad Cluster (where workloads run)')}
                value={selectedNomadId}
                onChange={(e) => {
                  const nextNomad = e.target.value;
                  const sug = suggestCreateDefaults(nextNomad, selectedVaultId);
                  setCreateForm((prev) => ({
                    ...prev,
                    source_cluster_id: nextNomad,
                    name: createTouched.name ? prev.name : sug.name,
                    auth_path: createTouched.auth_path ? prev.auth_path : sug.authPath,
                  }));
                }}
              >
                {nomadClusters.map((c) => {
                  const bound = items.find((it) => it.source_cluster_id === c.id);
                  return (
                    <option key={c.id} value={c.id}>
                      {c.name}{bound ? tr(`（已绑定联动：${bound.name}）`, ` (bound: ${bound.name})`) : ''}
                    </option>
                  );
                })}
              </Select>
              {existingForNomad && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                  {tr(
                    `该 Nomad 集群已绑定联动「${existingForNomad.name}」（指向 ${existingForNomad.target_cluster || existingForNomad.target_cluster_id}）。一个 Nomad 集群只能绑定一个 Vault；一个 Vault 可对接多个 Nomad 集群。`,
                    `This Nomad cluster is already bound to "${existingForNomad.name}" (${existingForNomad.target_cluster || existingForNomad.target_cluster_id}). A Nomad cluster can bind only one Vault, while one Vault can serve multiple Nomad clusters.`,
                  )}
                </p>
              )}
              <Select
                label={tr('Vault 集群（密码存在这里）', 'Vault Cluster (where secrets live)')}
                value={selectedVaultId}
                onChange={(e) => {
                  const nextVault = e.target.value;
                  const sug = suggestCreateDefaults(selectedNomadId, nextVault);
                  setCreateForm((prev) => ({
                    ...prev,
                    target_cluster_id: nextVault,
                    auth_path: createTouched.auth_path ? prev.auth_path : sug.authPath,
                  }));
                }}
              >
                {vaultClusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
              <details className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950/40">
                <summary className="cursor-pointer font-medium text-slate-700 dark:text-slate-200">
                  {tr('高级参数（Auth Mount：', 'Advanced Options (Auth Mount: ')}<code className="font-mono">{createForm.auth_path || tr('自动生成', 'auto')}</code>）
                </summary>
                <div className="mt-3 space-y-2">
                  <Input
                    label="Vault JWT Auth Mount"
                    hint={tr('同一个 Vault 对接多个 Nomad 集群时需使用不同的 Auth 路径（已自动避开冲突，留空则按集群名自动生成）。', 'Each Nomad cluster sharing the same Vault needs a distinct auth mount path (auto-generated if blank).')}
                    value={createForm.auth_path}
                    onChange={(e) => {
                      setCreateTouched((prev) => ({ ...prev, auth_path: true }));
                      setCreateForm({ ...createForm, auth_path: e.target.value });
                    }}
                  />
                </div>
              </details>
              <div className="flex justify-end gap-2">
                <Button type="button" onClick={() => setShowCreate(false)}>{tr('取消', 'Cancel')}</Button>
                <Button type="submit" variant="primary" disabled={Boolean(existingForNomad)}>{tr('创建联动', 'Create Integration')}</Button>
              </div>
            </form>
          );
        })()}
      </Modal>

      {/* 编辑联动：折叠高级参数并补充大白话说明 */}
      <Modal open={showEditIntegration} title={tr(`编辑联动：${selected?.name || ''}`, `Edit Integration: ${selected?.name || ''}`)} onClose={() => setShowEditIntegration(false)}>
        <form onSubmit={updateIntegration} className="space-y-3 text-xs">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-300">
            {tr(
              <>源集群（<span className="font-mono">{selected?.source_cluster || selected?.source_cluster_id}</span>）、目标集群（<span className="font-mono">{selected?.target_cluster || selected?.target_cluster_id}</span>）与 Auth Mount（<span className="font-mono">{selected?.auth_path}</span>）创建后不可修改；保存变更后请点击「应用联动」下发。</>,
              <>Source (<span className="font-mono">{selected?.source_cluster || selected?.source_cluster_id}</span>), Target (<span className="font-mono">{selected?.target_cluster || selected?.target_cluster_id}</span>), and Auth Mount (<span className="font-mono">{selected?.auth_path}</span>) are immutable after creation. Click &quot;Apply Integration&quot; after saving.</>,
            )}
          </div>
          <Input
            label={tr('联动名称', 'Integration Name')}
            required
            value={editIntegrationForm.name}
            onChange={(e) => setEditIntegrationForm({ ...editIntegrationForm, name: e.target.value })}
          />
          <details className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950/40">
            <summary className="cursor-pointer font-medium text-slate-700 dark:text-slate-200">
              {tr('高级参数（JWKS、Audience 与地址覆盖，通常保持默认）', 'Advanced Options (JWKS, Audience & Address Overrides)')}
            </summary>
            <div className="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Select
                    label={tr('JWKS 模式', 'JWKS Mode')}
                    value={editIntegrationForm.jwks_mode}
                    onChange={(e) => setEditIntegrationForm({ ...editIntegrationForm, jwks_mode: e.target.value })}
                  >
                    <option value="url">{tr('url（Vault 实时拉取 Nomad JWKS）', 'url (Vault fetches Nomad JWKS live)')}</option>
                    <option value="static">{tr('static（控制面静态下发公钥）', 'static (Control plane pushes static JWKS)')}</option>
                  </Select>
                  <p className="text-[11px] text-slate-500">{tr('url 表示 Vault 自动连 Nomad 拉公钥；仅当 Nomad 开启严格客户端证书校验时再换 static。', 'url lets Vault pull keys directly from Nomad; switch to static only if strict Nomad client certs block it.')}</p>
                </div>
                <Input
                  label={tr('身份令牌 TTL', 'Identity Token TTL')}
                  required
                  hint={tr('Nomad 签发给任务的身份 JWT 有效期，例如 1h。', 'Lifetime of workload identity JWT issued by Nomad, e.g. 1h.')}
                  placeholder={tr('例如 1h', 'e.g. 1h')}
                  value={editIntegrationForm.identity_ttl}
                  onChange={(e) => setEditIntegrationForm({ ...editIntegrationForm, identity_ttl: e.target.value })}
                />
              </div>
              <Input
                label="Audience (aud)"
                hint={tr('门禁卡上的适用标识，两边对上才认，默认 vault.io。', 'Audience claim expected by Vault; must match on both sides (default: vault.io).')}
                placeholder={tr('例如 vault.io，多个用逗号分隔', 'e.g. vault.io (comma-separated)')}
                value={editIntegrationForm.aud}
                onChange={(e) => setEditIntegrationForm({ ...editIntegrationForm, aud: e.target.value })}
              />
              <Input
                label={tr('自定义 JWKS URL（可选）', 'Custom JWKS URL (optional)')}
                hint={tr('留空则自动使用 Nomad 统一入口或 Server 地址。', 'Leave blank to derive automatically from Nomad public URL or servers.')}
                placeholder={tr('留空自动推导', 'Auto-detected if blank')}
                value={editIntegrationForm.jwks_url}
                onChange={(e) => setEditIntegrationForm({ ...editIntegrationForm, jwks_url: e.target.value })}
              />
              <Input
                label={tr('自定义 Vault 地址（可选）', 'Custom Vault Address (optional)')}
                hint={tr('留空则自动使用 Vault 统一入口或节点地址。', 'Leave blank to derive automatically from Vault public URL or nodes.')}
                placeholder={tr('留空自动推导', 'Auto-detected if blank')}
                value={editIntegrationForm.vault_address}
                onChange={(e) => setEditIntegrationForm({ ...editIntegrationForm, vault_address: e.target.value })}
              />
              <Input
                label={tr('默认 Role（可选）', 'Default Role (optional)')}
                hint={tr('Job 里如果只写了 vault {} 没写 role 名时兜底使用，一般留空更安全。', 'Fallback when a job defines vault {} without a role; safer left blank.')}
                placeholder={tr('留空则要求 Job 显式指定 role', 'Require explicit role in jobs if blank')}
                value={editIntegrationForm.default_role}
                onChange={(e) => setEditIntegrationForm({ ...editIntegrationForm, default_role: e.target.value })}
              />
            </div>
          </details>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setShowEditIntegration(false)}>{tr('取消', 'Cancel')}</Button>
            <Button type="submit" variant="primary" loading={savingIntegration}>{tr('保存', 'Save')}</Button>
          </div>
        </form>
      </Modal>

      {/* 添加/编辑 Role：Namespace 候选 + KV 路径纠错 + 实时预览 */}
      <Modal
        open={showRole}
        title={editingRole ? tr(`编辑工作负载 Role：${editingRole.role_name}`, `Edit Workload Role: ${editingRole.role_name}`) : tr('添加工作负载 Role', 'Add Workload Role')}
        onClose={() => {
          setShowRole(false);
          setEditingRole(null);
        }}
      >
        <form onSubmit={saveRole} className="space-y-3 text-xs">
          <Input
            label={tr('Role 名称', 'Role Name')}
            placeholder={tr('例如 postgres，在 Job 的 vault.role 中填写这个名字', 'e.g. postgres (referenced in Job vault.role)')}
            hint={editingRole ? tr('Role 名称创建后不可修改。', 'Role name cannot be changed after creation.') : undefined}
            disabled={Boolean(editingRole)}
            required
            value={roleForm.role_name}
            onChange={(e) => setRoleForm({ ...roleForm, role_name: e.target.value })}
          />
          <Select
            label={tr('授权方式（Policy 模式）', 'Policy Mode')}
            value={roleForm.policy_mode}
            onChange={(e) => setRoleForm({ ...roleForm, policy_mode: e.target.value })}
          >
            <option value="explicit">{tr('指定固定密钥路径（推荐新手，按路径精确授权）', 'Explicit secret paths (recommended, grant exact paths)')}</option>
            <option value="templated">{tr('按任务名自动隔离（读取 挂载/Namespace/Job名 下的密钥）', 'Templated per-job isolation (<mount>/<namespace>/<job>)')}</option>
          </Select>

          <div className="space-y-1.5">
            <Input
              label={roleForm.policy_mode === 'templated' ? tr('KV 存储空间名称', 'KV Mount Name') : tr('允许读取的 Secret 路径', 'Allowed Secret Paths')}
              placeholder={
                roleForm.policy_mode === 'templated'
                  ? tr('例如 secret', 'e.g. secret')
                  : tr('例如 secret/apps/postgres（多路径用逗号分隔，目录通配写 secret/apps/*）', 'e.g. secret/apps/postgres (comma-separated, or secret/apps/*)')
              }
              hint={
                roleForm.policy_mode === 'templated'
                  ? tr('填写 Vault KV v2 挂载名（如 secret），多个用逗号分隔。', 'Vault KV v2 mount name (e.g. secret), comma-separated.')
                  : tr('格式「挂载名/密钥路径」，多个用逗号分隔（不要写 data/）。注意：路径按精确匹配生效，不会自动包含子路径（如填 secret/apps 只能读 apps 本身，读不到 secret/apps/app）；需读子路径请写全路径，或末尾加 /* 放行整目录（如 secret/apps/*）。', 'Format: "<mount>/<path>", comma-separated (omit data/). Exact paths do not cover nested keys; use /* at the end (e.g. secret/apps/*) to allow a directory.')
              }
              required={roleForm.policy_mode === 'explicit' && !roleForm.custom_policy_hcl.trim()}
              value={roleForm.secret_paths}
              onChange={(e) => setRoleForm({ ...roleForm, secret_paths: e.target.value })}
            />
            {vaultMounts.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
                <span>{tr('Vault 已有挂载：', 'Available KV Mounts: ')}</span>
                {vaultMounts.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono hover:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
                    onClick={() => {
                      const appHint = roleForm.role_name.trim() || 'app';
                      const next = roleForm.policy_mode === 'templated' ? m : `${m}/apps/${appHint}`;
                      setRoleForm({ ...roleForm, secret_paths: next });
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
            {hasAccidentalDataPrefix && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
                <span>{tr(<>检测到路径里多写了 <code className="font-mono">/data/</code>，保存时会自动帮您简化为 Role 授权路径。</>, <>Detected <code className="font-mono">/data/</code> in path; it will be stripped for the Role policy on save.</>)}</span>
                <button
                  type="button"
                  className="font-semibold underline"
                  onClick={() =>
                    setRoleForm({
                      ...roleForm,
                      secret_paths: roleParsedPreviews.map((p) => p.rolePath).filter(Boolean).join(', '),
                    })
                  }
                >
                  {tr('立即修正', 'Fix Now')}
                </button>
              </div>
            )}
            {hasTrailingSlashWarning && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
                <span>
                  {tr(
                    <>末尾的 <code className="font-mono">/</code> 保存时会被去掉，仅授权该精确路径本身，<strong>不会</strong>包含子路径。如需放行整个目录请改为 <code className="font-mono">/*</code>，或补全具体密钥名（如 <code className="font-mono">secret/apps/app</code>）。</>,
                    <>Trailing <code className="font-mono">/</code> is stripped on save, granting access to that exact path only (not children). Use <code className="font-mono">/*</code> to match a directory.</>,
                  )}
                </span>
                <button
                  type="button"
                  className="shrink-0 font-semibold underline"
                  onClick={() =>
                    setRoleForm({
                      ...roleForm,
                      secret_paths: roleParsedPreviews
                        .map((p) => (p.hasTrailingSlash && p.path && !p.isWildcard ? `${p.rolePath}/*` : p.rolePath))
                        .filter(Boolean)
                        .join(', '),
                    })
                  }
                >
                  {tr('改为 /* 通配', 'Switch to /*')}
                </button>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Input
              label={tr('允许使用的 Nomad Namespace', 'Allowed Nomad Namespace')}
              list="integration-ns-list"
              required
              hint={tr('只有在这个 Nomad Namespace 下运行的 Job 才能使用这个 Role。', 'Only Nomad Jobs in this Namespace may assume this Role.')}
              value={roleForm.bound_namespace}
              onChange={(e) => setRoleForm({ ...roleForm, bound_namespace: e.target.value })}
            />
            <datalist id="integration-ns-list">
              {nomadNamespaces.map((ns) => <option key={ns} value={ns} />)}
            </datalist>
            {nomadNamespaces.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
                <span>{tr('快速选择：', 'Quick select: ')}</span>
                {nomadNamespaces.map((ns) => (
                  <button
                    key={ns}
                    type="button"
                    className={`rounded border px-1.5 py-0.5 font-mono ${
                      roleForm.bound_namespace === ns
                        ? 'border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-950/50 dark:text-indigo-200'
                        : 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800'
                    }`}
                    onClick={() => setRoleForm({ ...roleForm, bound_namespace: ns })}
                  >
                    {ns}
                  </button>
                ))}
              </div>
            )}
          </div>

          {roleForm.policy_mode === 'explicit' && validRolePreviews.length > 0 && (
            <div className="rounded-xl border border-indigo-200/80 bg-indigo-50/50 p-2.5 text-[11px] leading-relaxed space-y-2 dark:border-indigo-500/30 dark:bg-indigo-950/20">
              <div className="font-semibold text-indigo-950 dark:text-indigo-100">{tr('效果预览', 'Policy Preview')}</div>
              {validRolePreviews.map((p, idx) => (
                <div key={`${p.rolePath}-${idx}`} className={idx > 0 ? 'border-t border-indigo-200/60 pt-1.5 space-y-0.5 dark:border-indigo-500/20' : 'space-y-0.5'}>
                  {p.isWildcard ? (
                    <>
                      <div>
                        • {tr('Vault 通配授权：', 'Vault Wildcard Access: ')}<code className="font-mono">{p.rolePath}</code>
                        <span className="text-slate-600 dark:text-slate-300">{tr('（允许读取该前缀下所有子路径，请确认符合最小权限原则）', ' (reads all child paths under this prefix; ensure least privilege)')}</span>
                      </div>
                      <div>
                        • {tr('Job ', 'Job ')}<code className="font-mono">template</code> {tr('写法：需填具体密钥路径，如 ', 'usage: specify a concrete path like ')}
                        <code className="font-mono">{`{{ with secret "${p.templateExamplePath}" }}`}</code>
                        <span className="text-slate-600 dark:text-slate-300">{tr('（模板中不可写 *）', ' (wildcards not allowed in templates)')}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        • {tr('Vault 精确授权：', 'Vault Exact Access: ')}<code className="font-mono">{p.rolePath}</code>
                        <span className="text-slate-600 dark:text-slate-300">
                          {tr(
                            <>（仅此一条，<strong>不含</strong>其下的子路径如 <code className="font-mono">{`${p.rolePath}/xxx`}</code>）</>,
                            <> (this exact key only; <strong>excludes</strong> child paths such as <code className="font-mono">{`${p.rolePath}/xxx`}</code>)</>,
                          )}
                        </span>
                      </div>
                      <div>
                        • {tr('Job ', 'Job ')}<code className="font-mono">template</code> {tr('写法：', 'usage: ')}
                        <code className="font-mono">{`{{ with secret "${p.templatePath}" }}`}</code>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          <details open={Boolean(roleForm.custom_policy_hcl.trim())} className="rounded-xl border border-slate-200 bg-slate-50/70 p-2.5 dark:border-slate-800 dark:bg-slate-950/40">
            <summary className="cursor-pointer font-medium text-slate-700 dark:text-slate-200">{tr('高级选项（Token 续期周期 / 自定义 Policy HCL）', 'Advanced Options (Token Period / Custom Policy HCL)')}</summary>
            <div className="mt-2.5 space-y-3">
              <Input
                label={tr('Token 续期周期', 'Token Period')}
                hint={tr('Nomad 客户端自动向 Vault 续期令牌的时间间隔，默认 1h。', 'Renewal interval for Vault tokens managed by Nomad Client, default 1h.')}
                value={roleForm.token_period}
                onChange={(e) => setRoleForm({ ...roleForm, token_period: e.target.value })}
              />
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="font-medium text-slate-700 dark:text-slate-200">
                    {tr('自定义 Policy HCL（可选，填写后将覆盖上方自动生成的只读规则）', 'Custom Policy HCL (optional; overrides generated read-only rules)')}
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const mount = vaultMounts[0] || 'secret';
                      setRoleForm({
                        ...roleForm,
                        policy_mode: 'explicit',
                        secret_paths: `${mount}/certs/dns`,
                        custom_policy_hcl: [
                          `path "${mount}/data/certs/dns" {`,
                          '  capabilities = ["read"]',
                          '}',
                          '',
                          `path "${mount}/data/certs/tls" {`,
                          '  capabilities = ["create", "update", "read"]',
                          '}',
                          '',
                          `path "${mount}/metadata/certs/*" {`,
                          '  capabilities = ["read", "list"]',
                          '}',
                        ].join('\n'),
                      });
                    }}
                    className="text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    {tr('填入 acme-cert-sync 读写证书策略', 'Fill acme-cert-sync cert R/W policy')}
                  </button>
                </div>
                <textarea
                  rows={6}
                  spellCheck={false}
                  placeholder={tr('留空按上方密钥路径自动生成只读 Policy；如需写权限（如 acme-cert-sync 推送证书），可在此填写 Vault Policy HCL。', 'Leave blank to generate read-only Policy from paths above; provide custom Vault Policy HCL when write access is needed.')}
                  value={roleForm.custom_policy_hcl}
                  onChange={(e) => setRoleForm({ ...roleForm, custom_policy_hcl: e.target.value })}
                  className="w-full rounded-lg border border-[#dce3ee] bg-white p-2 font-mono text-[11px] leading-relaxed text-slate-900 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </div>
            </div>
          </details>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              onClick={() => {
                setShowRole(false);
                setEditingRole(null);
              }}
            >
              {tr('取消', 'Cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={savingRole}>{tr('保存', 'Save')}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
