import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, ChevronRight, Copy, ExternalLink, Folder, KeyRound, Link2, Lock, Plus, RefreshCw, Shield, Sparkles, Trash2, Unlock } from 'lucide-react';
import { apiDelete, apiDownload, apiGet, apiPost, apiPut, apiUpload, fmtBytes, fmtTime } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { buildTemplateData, parseKVPath } from '../lib/vaultHelpers';
import { useAuth } from '../lib/auth';
import {
  readStoredSelection,
  resolveClusterSelection,
  VAULT_CLUSTER_KEY,
  writeStoredSelection,
} from '../lib/selectionMemory';
import { useOpsDrawer } from '../lib/opsDrawer';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Input,
  MaskedSecret,
  Modal,
  LoadingState,
  PageHeader,
  PasswordConfirmModal,
  SecretInput,
  SectionTabs,
  Select,
  StatusBadge,
  Switch,
  TermLabel,
  statusTone,
} from '../components/UI';
import { ClusterOpsSection } from '../components/ClusterOpsSection';
import { CodeEditor } from '../components/CodeEditor';
import { ItemSwitcher } from '../components/ItemSwitcher';
import { UninstallClusterModal, type UninstallPlan } from '../components/UninstallClusterModal';
import { ClusterCreateModal } from '../components/ClusterCreateModal';
import { isLoopbackAddress } from '../lib/net';

function generateRandomSecret(length = 24): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_';
  const bytes = new Uint8Array(length);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function VaultPage() {
  const { isAdmin } = useAuth();
  const { openTask, openNodeLogs, tasks } = useOpsDrawer();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [searchParams] = useSearchParams();
  const queryId = searchParams.get('id') || '';
  const queryTab = searchParams.get('tab') || '';
  const validTabs = ['status', 'custody', 'snapshots', 'manage'];
  const [clusters, setClusters] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState(() => queryId || readStoredSelection(VAULT_CLUSTER_KEY));
  const [loadingList, setLoadingList] = useState(true);
  const selectionRef = useRef(selectedId);
  selectionRef.current = selectedId;
  const [tab, setTab] = useState(validTabs.includes(queryTab) ? queryTab : 'status');

  useEffect(() => {
    if (queryTab && validTabs.includes(queryTab)) {
      setTab(queryTab);
    }
  }, [queryTab]);

  useEffect(() => {
    if (queryId && clusters.some((c: any) => c.id === queryId)) {
      setSelectedId(queryId);
    }
  }, [queryId, clusters]);

  useEffect(() => {
    if (selectedId && clusters.some((c: any) => c.id === selectedId)) {
      writeStoredSelection(VAULT_CLUSTER_KEY, selectedId);
    }
  }, [selectedId, clusters]);
  const [status, setStatus] = useState<any>(null);
  const [custodyData, setCustodyData] = useState<any>(null);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [gens, setGens] = useState<any[]>([]);
  const [auths, setAuths] = useState<any[]>([]);
  const [showAuth, setShowAuth] = useState(false);
  const [authForm, setAuthForm] = useState({ path: '', type: 'userpass', description: '' });
  const [policies, setPolicies] = useState<any[]>([]);
  const [selectedPolicy, setSelectedPolicy] = useState('');
  const [policyIsNew, setPolicyIsNew] = useState(false);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policyEdit, setPolicyEdit] = useState({ name: '', rules: '' });
  const [mounts, setMounts] = useState<any[]>([]);
  const [manageTab, setManageTab] = useState<'kv' | 'policies' | 'auth'>('kv');
  const [kvMount, setKvMount] = useState('');
  const [kvPath, setKvPath] = useState('');
  const [kvListedDir, setKvListedDir] = useState('');
  const [kvKeys, setKvKeys] = useState<string[]>([]);
  const [kvListing, setKvListing] = useState(false);
  const [kvItem, setKvItem] = useState<{ path: string; data: string; cas: number } | null>(null);
  const [kvEditMode, setKvEditMode] = useState<'form' | 'json'>('form');
  const [kvRows, setKvRows] = useState<Array<{ key: string; value: string }>>([]);
  const [kvErr, setKvErr] = useState('');
  const [kvSaving, setKvSaving] = useState(false);
  const [showKVMount, setShowKVMount] = useState(false);
  const [kvMountForm, setKvMountForm] = useState({ path: '', description: '' });
  const [gateView, setGateView] = useState<any>(null);
  const [err, setErr] = useState('');
  const [rootToken, setRootToken] = useState('');
  const [revokingRootToken, setRevokingRootToken] = useState(false);
  const [uiLoginModal, setUiLoginModal] = useState<{ url: string; targetLabel: string; wrapTTL: number; tokenTTL: string } | null>(null);
  const [uninstallPlan, setUninstallPlan] = useState<UninstallPlan | null>(null);

  // Create wizard
  const [showCreate, setShowCreate] = useState(false);
  const [deployVer, setDeployVer] = useState('latest');
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [joinBusy, setJoinBusy] = useState(false);
  const [deployConfirmSwap, setDeployConfirmSwap] = useState(false);
  const [upVer, setUpVer] = useState('');
  const [showJoin, setShowJoin] = useState(false);
  const [joinNodeId, setJoinNodeId] = useState('');
  const [joinAdvertiseAddr, setJoinAdvertiseAddr] = useState('');
  const [confirmSwap, setConfirmSwap] = useState(false);
  const [snapPass, setSnapPass] = useState('');
  const [snapFile, setSnapFile] = useState<File | null>(null);
  const [pwAction, setPwAction] = useState<{ title: string; run: (pw: string) => Promise<void> } | null>(null);
  const [dlModal, setDlModal] = useState<{ title: string; run: (pw: string, passphrase: string) => Promise<void> } | null>(null);
  const [dlPw, setDlPw] = useState('');
  const [dlPass, setDlPass] = useState('');
  const [dlBusy, setDlBusy] = useState(false);
  const [dlErr, setDlErr] = useState('');

  const loadList = useCallback(async () => {
    try {
      const [cRes, nRes] = await Promise.all([apiGet('/api/v1/clusters?type=vault'), apiGet('/api/v1/nodes')]);
      const list = cRes.clusters || [];
      setClusters(list);
      setNodes(nRes.nodes || []);
      setSelectedId((prev) =>
        resolveClusterSelection(list, queryId, prev, readStoredSelection(VAULT_CLUSTER_KEY)),
      );
    } catch (ex: any) {
      setErr(ex?.message || '加载 Vault 集群列表失败');
    } finally {
      setLoadingList(false);
    }
  }, [queryId]);

  const loadDetail = useCallback(async () => {
    if (!selectedId) return;
    setErr('');
    try {
      const [clRes, stRes, snRes, gRes] = await Promise.all([
        apiGet(`/api/v1/clusters/${selectedId}`),
        apiGet(`/api/v1/clusters/${selectedId}/status`),
        apiGet(`/api/v1/clusters/${selectedId}/snapshots`),
        apiGet(`/api/v1/vault/${selectedId}/key-generations`),
      ]);
      if (selectionRef.current !== selectedId) return;
      setCustodyData(clRes.custody || null);
      setStatus(stRes.status);
      // Keep the summary in sync with live status after initialization and maintenance.
      setClusters((prev) => prev.map((c) => c.id === selectedId ? {
        ...c, ...clRes.cluster,
        health_status: stRes.status.health_status,
        init_state: stRes.status.init_state,
      } : c));
      setSnapshots(snRes.snapshots || []);
      setGens(gRes.generations || []);
    } catch (ex: any) {
      if (selectionRef.current !== selectedId) return;
      setErr(ex?.message || '加载 Vault 集群详情失败');
    }
  }, [selectedId]);

  const selectPolicy = useCallback(async (name: string) => {
    if (!selectedId || !name) return;
    setPolicyIsNew(false);
    setSelectedPolicy(name);
    setPolicyLoading(true);
    try {
      const r = await apiGet(`/api/v1/vault/${selectedId}/policies/${encodeURIComponent(name)}`);
      setPolicyEdit({ name, rules: r.policy?.rules || r.policy || '' });
    } catch (ex: any) {
      setErr(ex?.message || '读取 Policy 内容失败');
    } finally {
      setPolicyLoading(false);
    }
  }, [selectedId]);

  const startNewPolicy = () => {
    setPolicyIsNew(true);
    setSelectedPolicy('');
    setPolicyEdit({
      name: '',
      rules: `# 示例：允许只读指定 KV v2 密钥（请按需修改路径）\npath "secret/data/apps/demo" {\n  capabilities = ["read"]\n}\n`,
    });
  };

  const listKVKeys = useCallback(async (mountName: string, pathStr: string) => {
    if (!selectedId || !mountName) {
      setKvKeys([]);
      return;
    }
    setKvListing(true);
    const normalizedDir = pathStr.trim().replace(/^\/+|\/+$/g, '');
    try {
      const r = await apiGet(`/api/v1/vault/${selectedId}/kv/list?mount=${encodeURIComponent(mountName)}&path=${encodeURIComponent(pathStr)}`);
      setKvListedDir(normalizedDir);
      setKvKeys(r.keys || []);
    } catch (ex: any) {
      // Empty path in Vault KV v2 may return 404 when no keys exist yet.
      if (String(ex?.message || '').includes('404')) {
        setKvListedDir(normalizedDir);
        setKvKeys([]);
      } else {
        setErr(ex?.message || '读取密钥目录失败');
      }
    } finally {
      setKvListing(false);
    }
  }, [selectedId]);

  const openKVEditor = (item: { path: string; data: string; cas: number }) => {
    setKvErr('');
    setKvItem(item);
    try {
      const parsed = JSON.parse(item.data);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed);
        const allFlat = entries.every(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
        if (allFlat) {
          setKvRows(
            entries.length > 0
              ? entries.map(([k, v]) => ({ key: k, value: v == null ? '' : String(v) }))
              : [{ key: 'password', value: '' }],
          );
          setKvEditMode('form');
          return;
        }
      }
    } catch {
      // Fall back to JSON editor if content isn't a flat object.
    }
    setKvEditMode('json');
  };

  const serializeKVRows = (rows: Array<{ key: string; value: string }>) => {
    const out: Record<string, string> = {};
    for (const row of rows) {
      const k = row.key.trim();
      if (k) out[k] = row.value;
    }
    return out;
  };

  const handleDeleteKVSecret = async (targetPath: string) => {
    const cleanTarget = targetPath.trim().replace(/^\/+|\/+$/g, '');
    if (!selectedId || !kvMount || !cleanTarget || kvSaving) return;
    if (
      !(await askConfirm(
        `确认彻底删除 Secret「${kvMount.replace(/\/+$/, '')}/${cleanTarget}」及其所有历史版本吗？删除后不可恢复。`,
        { title: '删除 KV Secret', confirmText: '确认删除', danger: true },
      ))
    ) {
      return;
    }
    setKvErr('');
    setKvSaving(true);
    try {
      await apiDelete(
        `/api/v1/vault/${selectedId}/kv/item?mount=${encodeURIComponent(kvMount)}&path=${encodeURIComponent(cleanTarget)}&mode=delete-metadata`,
      );
      toast.success(`Secret「${cleanTarget}」已删除`);
      if (kvItem && kvItem.path.trim().replace(/^\/+|\/+$/g, '') === cleanTarget) {
        setKvItem(null);
      }
      const parentDir = cleanTarget.includes('/') ? `${cleanTarget.slice(0, cleanTarget.lastIndexOf('/') + 1)}` : '';
      setKvPath(parentDir);
      await listKVKeys(kvMount, parentDir);
    } catch (ex: any) {
      const msg = ex?.message || '删除 Secret 失败';
      if (kvItem) {
        setKvErr(msg);
      } else {
        setErr(msg);
      }
      toast.error(msg);
    } finally {
      setKvSaving(false);
    }
  };

  const loadManage = useCallback(async () => {
    if (!selectedId) return;
    try {
      const [aRes, pRes, mRes] = await Promise.all([
        apiGet(`/api/v1/vault/${selectedId}/auth`),
        apiGet(`/api/v1/vault/${selectedId}/policies`),
        apiGet(`/api/v1/vault/${selectedId}/kv/mounts`),
      ]);
      setAuths(aRes.auth || []);
      const pList: string[] = pRes.policies || [];
      setPolicies(pList);
      const ms = mRes.mounts || [];
      setMounts(ms);
      const nextMount = kvMount || ms[0]?.path || ms[0] || '';
      if (!kvMount && nextMount) setKvMount(nextMount);
      if (nextMount) void listKVKeys(nextMount, kvPath);
      if (!policyIsNew && pList.length > 0 && (!selectedPolicy || !pList.includes(selectedPolicy))) {
        const first = pList.find((p) => p !== 'root') || pList[0];
        void selectPolicy(first);
      }
    } catch (ex: any) {
      setErr(ex?.message || '加载 Vault 管理数据失败');
    }
  }, [selectedId, kvMount, kvPath, listKVKeys, policyIsNew, selectedPolicy, selectPolicy]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    void apiGet('/api/v1/settings').then((r) => {
      setDeployVer(r.settings?.['defaults.vault_version'] || 'latest');
      setProxyEnabled(Boolean(r.settings?.['proxy.use_for_vault'] ?? r.settings?.['proxy.use_for_releases']));
    }).catch((ex) => setErr(ex.message));
  }, []);

  const clusterTaskState = tasks.filter((task) => task.target_id === selectedId)
    .map((task) => `${task.id}:${task.status}`).join(',');

  useEffect(() => {
    if (!clusterTaskState) return;
    void loadList();
    const uninstallDone = tasks.some((task) => task.target_id === selectedId && task.action === 'cluster.uninstall' && task.status === 'success');
    if (!uninstallDone) void loadDetail();
  }, [clusterTaskState, loadList, loadDetail]);

  useEffect(() => {
    setStatus(null);
  }, [selectedId]);

  const cluster = clusters.find((c) => c.id === selectedId);

  useEffect(() => {
    setRootToken('');
    setUiLoginModal(null);
    setUninstallPlan(null);
    setPolicyEdit({ name: '', rules: '' });
    setSelectedPolicy('');
    setPolicyIsNew(false);
    setKvItem(null);
    setKvKeys([]);
    setKvMount('');
    setKvPath('');
    setKvListedDir('');
    setGateView(null);
    setAuths([]);
    setPolicies([]);
    setMounts([]);
    setCustodyData(null);
  }, [selectedId]);

  useEffect(() => {
    void loadDetail();
    if (!selectedId) return;
    const t = window.setInterval(() => void loadDetail(), 30000);
    return () => window.clearInterval(t);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (selectedId && tab === 'status') void loadDetail();
    if (selectedId && tab === 'manage') void loadManage();
  }, [selectedId, tab, loadDetail, loadManage]);

  const clusterNodes = status?.nodes || [];
  const custody = custodyData || {};

  const handleIssueRootToken = () => {
    setPwAction({
      title: '签发临时 Root Token（使用托管解封密钥重建）',
      run: async (pw) => {
        const r = await apiPost(`/api/v1/vault/${selectedId}/root-token`, { current_password: pw });
        setRootToken(r.root_token || '');
      },
    });
  };

  const handleOpenWebUI = (targetUrl: string, label?: string) => {
    setPwAction({
      title: `免密登录 Vault Web UI${label ? ` · ${label}` : ''}`,
      run: async (pw) => {
        const r = await apiPost(`/api/v1/vault/${selectedId}/ui-login`, {
          current_password: pw,
          target_url: targetUrl,
        });
        setUiLoginModal({
          url: r.login_url,
          targetLabel: label || targetUrl,
          wrapTTL: Number(r.wrap_ttl_seconds || 120),
          tokenTTL: r.token_ttl || '1h',
        });
      },
    });
  };

  const handleUninstall = async () => {
    if (!cluster) return;
    const canDeleteUndeployed =
      cluster.init_state === 'uninitialized' && clusterNodes.every((n: any) => n.install_state === 'pending');
    if (canDeleteUndeployed) {
      if (
        !(await askConfirm(`确认删除未部署集群「${cluster.name}」吗？仅清除控制面记录，不会改动主机。`, {
          title: '删除未部署集群',
          confirmText: '确认删除',
          danger: true,
        }))
      ) {
        return;
      }
      try {
        await apiDelete(`/api/v1/clusters/${selectedId}`);
        toast.success('集群记录已删除');
        await loadList();
        return;
      } catch (ex: any) {
        if (!String(ex?.message || '').includes('已部署')) {
          setErr(ex?.message || '删除集群失败');
          return;
        }
      }
    }
    try {
      const r = await apiPost(`/api/v1/clusters/${selectedId}/uninstall/plan`, {});
      setUninstallPlan(r.plan || { warnings: [] });
    } catch (ex: any) {
      setErr(ex?.message || '获取卸载计划失败');
    }
  };

  if (loadingList) return <LoadingState label="正在加载 Vault 集群…" />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Vault 集群"
        subtitle="管理 Raft HA Vault 集群、Shamir 密钥托管解封、Raft 快照与 Auth/Policy/KV"
        actions={
          <>
            <Button title="每 30 秒自动刷新" onClick={() => void loadDetail()}>
              <RefreshCw className="h-4 w-4" />
              <span>刷新</span>
            </Button>
            {isAdmin && (
              <Button variant="primary" onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4" />
                <span>新建 Vault 集群</span>
              </Button>
            )}
          </>
        }
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {!cluster ? (
        <Card>
          <EmptyState icon={<Shield className="w-6 h-6" />} title="暂无 Vault 集群" description="Vault 负责安全存储密钥与凭据。先接入主机，再选择节点、创建配置并部署服务。" action={isAdmin && <Button variant="primary" onClick={() => setShowCreate(true)}>创建第一个 Vault 集群</Button>} />
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ItemSwitcher
              label="Vault 集群"
              selectedId={selectedId}
              onSelect={setSelectedId}
              items={clusters.map((c) => {
                const isSelected = c.id === selectedId;
                const anyInstalled =
                  isSelected &&
                  clusterNodes.some(
                    (n: any) => Boolean(n.installed_version) || (n.install_state && n.install_state !== 'pending') || n.service_status === 'active',
                  );
                const awaitInit = c.init_state === 'uninitialized' && anyInstalled;
                return {
                  id: c.id,
                  name: c.name,
                  status: awaitInit ? 'sealed' : c.init_state === 'uninitialized' ? 'uninitialized' : c.health_status,
                  statusLabel: awaitInit ? '已安装 · 待初始化' : undefined,
                };
              })}
            />
            <SectionTabs
              tabs={[
                { id: 'status', label: '集群状态详情' },
                { id: 'custody', label: '初始化与密钥托管', title: '控制面托管 Vault Unseal Key（Shamir 门限分片）与短时效运维 Token，支持自动解封、Rekey 轮换及签发临时 Root Token' },
                { id: 'snapshots', label: 'Raft 快照', badge: snapshots.length, title: '对 Vault Integrated Storage (Raft) 后端状态执行一致性快照备份与在线恢复' },
                { id: 'manage', label: 'Auth / Policy / KV', title: '管理 Vault 认证挂载（Userpass/JWT/AppRole）、HCL 权限策略（Policy）以及 KV v2 密钥引擎' },
              ]}
              active={tab}
              onChange={(t) => {
                setTab(t);
                if (t === 'manage') void loadManage();
              }}
            />
          </div>

          {tab === 'status' && (
            <div className="space-y-4">
              <ClusterOpsSection
                product="vault"
                cluster={cluster}
                status={status}
                clusterNodes={clusterNodes}
                isAdmin={isAdmin}
                deployVer={deployVer}
                setDeployVer={setDeployVer}
                upVer={upVer}
                setUpVer={setUpVer}
                proxyEnabled={proxyEnabled}
                confirmSwap={deployConfirmSwap}
                setConfirmSwap={setDeployConfirmSwap}
                onDeploy={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/deploy`, { version: deployVer.trim() || 'latest', confirm_swap: deployConfirmSwap })
                    .then((r) => { if (r.task?.id) openTask(r.task.id, '部署 Vault'); })
                    .catch((ex) => setErr(ex.message))
                }
                onInitVault={() =>
                  apiPost(`/api/v1/vault/${selectedId}/init`, { key_shares: 5, key_threshold: 3 })
                    .then((r) => { if (r.task?.id) openTask(r.task.id, '初始化 Vault 托管'); })
                    .catch((ex) => setErr(ex.message))
                }
                quickActions={
                  <Link to="/integrations" className="primary-button">
                    <Link2 className="h-3.5 w-3.5" />
                    <span>配置集群联动</span>
                  </Link>
                }
                onUpgrade={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/upgrade`, { version: upVer.trim() || 'latest', confirm: true })
                    .then((r) => { if (r.task?.id) openTask(r.task.id, '滚动升级 Vault'); })
                    .catch((ex) => setErr(ex.message))
                }
                onRenewCerts={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/certs/renew`, {})
                    .then((r) => { if (r.task?.id) openTask(r.task.id, '续期 Vault 证书'); })
                    .catch((ex) => setErr(ex.message))
                }
                onRotateCA={() => {
                  setPwAction({
                    title: '确认轮换 Vault 集群 CA',
                    run: async (pw) => {
                      const r = await apiPost(`/api/v1/clusters/${selectedId}/ca/rotate`, { current_password: pw });
                      if (r.task?.id) openTask(r.task.id, '轮换 Vault CA');
                    },
                  });
                }}
                onDoctor={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/doctor`, {})
                    .then((r) => toast.info(r.report?.summary || 'Doctor 完成'))
                    .catch((ex) => setErr(ex.message))
                }
                onReconcile={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/reconcile`, {})
                    .then((r) => { toast.success(r.report?.message || '已核对'); return loadDetail(); })
                    .catch((ex) => setErr(ex.message))
                }
                onOpenWebUI={handleOpenWebUI}
                onUninstall={handleUninstall}
                onOpenJoin={() => { setJoinNodeId(''); setJoinAdvertiseAddr(''); setConfirmSwap(false); setShowJoin(true); }}
                onOpenLogs={(n) => openNodeLogs(selectedId, n.node_id, `Vault 日志: ${n.name}`)}
                onCheckGate={(n) =>
                  apiGet(`/api/v1/clusters/${selectedId}/gate?node_id=${n.node_id}`)
                    .then((r) => setGateView(r.gate))
                    .catch((ex) => setErr(ex.message))
                }
                onRestartNode={(n) =>
                  apiPost(`/api/v1/clusters/${selectedId}/nodes/${n.node_id}/service/restart`, {})
                    .then((r) => { if (r.task?.id) openTask(r.task.id, `重启节点: ${n.name}`); })
                    .catch((ex) => setErr(ex.message))
                }
                onRemoveNode={(n, force) =>
                  apiPost(`/api/v1/clusters/${selectedId}/nodes/${n.node_id}/remove`, { force })
                    .then((r) => { if (r.task?.id) openTask(r.task.id, `${force ? '强制移出' : '缩容'}节点: ${n.name}`); })
                    .catch((ex) => setErr(ex.message))
                }
                onError={setErr}
              />
            </div>
          )}

          {tab === 'custody' && (() => {
            const isInitialized = (status?.init_state || cluster.init_state) === 'initialized';
            return (
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                <Card title="托管状态与日常解封">
                  <div className="space-y-5 text-xs">
                    <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-3 rounded-xl border border-slate-200/80 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-950/40">
                      <dt className="text-slate-500">
                        <TermLabel term="当前代际" tip="每次执行 Rekey 会生成新的密钥代际（Generation），旧代际历史仅保留审计轨迹。" />
                      </dt>
                      <dd className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                        {custody.seal_generation ? `#${custody.seal_generation}` : '尚未初始化'}
                      </dd>
                      <dt className="text-slate-500">
                        <TermLabel term="自动解封" tip="开启后控制面在巡检发现 Vault 节点被密封时自动下发托管分片完成 Unseal。" />
                      </dt>
                      <dd className="flex items-center gap-2.5">
                        {isAdmin ? (
                          <Switch
                            checked={Boolean(custody.auto_unseal_by_deck)}
                            label="自动解封开关"
                            onChange={(next) =>
                              void apiPut(`/api/v1/vault/${selectedId}/custody`, { auto_unseal_by_deck: next })
                                .then(() => {
                                  toast.success(next ? '已开启自动解封' : '已关闭自动解封');
                                  return loadDetail();
                                })
                                .catch((ex) => setErr(ex.message))
                            }
                          />
                        ) : null}
                        <Badge tone={custody.auto_unseal_by_deck ? 'green' : 'amber'}>
                          {custody.auto_unseal_by_deck ? '已开启' : '已关闭'}
                        </Badge>
                      </dd>
                      <dt className="text-slate-500">
                        <TermLabel term="运维 Token 到期" tip="控制面持有的定期续期管理员 Token（非永久 Root Token），用于日常策略/KV 管理。" />
                      </dt>
                      <dd className="text-slate-700 dark:text-slate-200">{fmtTime(custody.admin_token_expires_at)}</dd>
                    </dl>

                    {custody.unseal_suppressed_reason && (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/50 dark:text-amber-200">
                        <span>抑制原因：{custody.unseal_suppressed_reason}</span>
                        {isAdmin && (
                          <Button
                            size="sm"
                            onClick={() =>
                              setPwAction({
                                title: '解除自动解封抑制',
                                run: async (pw) => {
                                  await apiPut(`/api/v1/vault/${selectedId}/custody`, { clear_suppression: true, current_password: pw });
                                  await loadDetail();
                                },
                              })
                            }
                          >
                            解除抑制
                          </Button>
                        )}
                      </div>
                    )}

                    {isAdmin && (
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <div className="font-semibold text-slate-800 dark:text-slate-100">初始化与密封控制</div>
                          <div className="flex flex-wrap gap-2">
                            {!isInitialized && (
                              <Button
                                variant="primary"
                                onClick={() =>
                                  void apiPost(`/api/v1/vault/${selectedId}/init`, { key_shares: 5, key_threshold: 3 })
                                    .then((r) => r.task?.id && openTask(r.task.id, '初始化 Vault 托管'))
                                    .catch((ex) => setErr(ex.message))
                                }
                              >
                                一键初始化托管
                              </Button>
                            )}
                            <Button
                              disabled={!isInitialized}
                              onClick={() =>
                                void apiPost(`/api/v1/vault/${selectedId}/unseal`, {})
                                  .then((r) => r.task?.id && openTask(r.task.id, '解封 Vault 集群'))
                                  .catch((ex) => setErr(ex.message))
                              }
                            >
                              <Unlock className="h-3.5 w-3.5" /> 全集群解封
                            </Button>
                            <Button
                              variant="danger-outline"
                              disabled={!isInitialized}
                              onClick={async () => {
                                if (!(await askConfirm('确定要安全封存整个 Vault 集群吗？封存后将暂停对外提供密钥读写服务。', { title: '封存 Vault 集群', confirmText: '确认封存', danger: true }))) return;
                                void apiPost(`/api/v1/vault/${selectedId}/seal`, {})
                                  .then((r) => r.task?.id && openTask(r.task.id, '封存 Vault 集群'))
                                  .catch((ex) => setErr(ex.message));
                              }}
                            >
                              <Lock className="h-3.5 w-3.5" /> 安全封存
                            </Button>
                          </div>
                        </div>

                        <div className="border-t border-slate-200 pt-3.5 space-y-2 dark:border-slate-800">
                          <div className="font-semibold text-slate-800 dark:text-slate-100">密钥轮换与应急凭据</div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              disabled={!isInitialized}
                              onClick={() =>
                                setPwAction({
                                  title: '确认执行 Vault Rekey 密钥轮换',
                                  run: async (pw) => {
                                    const r = await apiPost(`/api/v1/vault/${selectedId}/rekey`, { current_password: pw });
                                    if (r.task?.id) openTask(r.task.id, 'Vault Rekey');
                                  },
                                })
                              }
                            >
                              Rekey 轮换
                            </Button>
                            <Button
                              disabled={!isInitialized}
                              onClick={() =>
                                setPwAction({
                                  title: '确认应急重签 Vault 运维 Token',
                                  run: async (pw) => {
                                    const r = await apiPost(`/api/v1/vault/${selectedId}/custody/recover-token`, { current_password: pw });
                                    if (r.task?.id) openTask(r.task.id, '重签 Vault 运维 Token');
                                  },
                                })
                              }
                            >
                              应急重签运维 Token
                            </Button>
                            <Button
                              disabled={!isInitialized}
                              onClick={handleIssueRootToken}
                            >
                              签发临时 Root Token
                            </Button>
                            <Button
                              disabled={!isInitialized}
                              onClick={() => {
                                setDlPw('');
                                setDlPass('');
                                setDlErr('');
                                setDlModal({
                                  title: '导出 Vault 离线紧急备份 (.ndvkb)',
                                  run: async (pw, passphrase) => {
                                    await apiDownload(`/api/v1/vault/${selectedId}/custody/backup`, { current_password: pw, passphrase }, `${cluster.name}.ndvkb`);
                                  },
                                });
                              }}
                            >
                              导出离线备份
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </Card>

                <Card title="Unseal Key 代际历史">
                  {gens.length === 0 ? (
                    <EmptyState title="暂无密钥代际" description="完成首次初始化后，这里会记录每次生成或 Rekey 的密钥代际与门限。" />
                  ) : (
                    <div className="space-y-2 text-xs">
                      {gens.map((g) => (
                        <div key={g.generation} className="flex items-center justify-between rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                          <span className="font-medium text-slate-800 dark:text-slate-100">代际 #{g.generation}（门限 {g.key_threshold} / 共 {g.key_shares} 份）</span>
                          <Badge tone={statusTone(g.state)}>{g.state === 'active' ? '当前生效' : g.state}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            );
          })()}

          {tab === 'snapshots' && (
            <Card
              title="Raft 快照管理"
              actions={
                isAdmin && (
                  <Button size="sm" variant="primary" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/snapshots`, {}).then((r) => r.task?.id && openTask(r.task.id)).catch((ex) => setErr(ex.message))}>
                    创建快照
                  </Button>
                )
              }
            >
              {isAdmin && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!snapFile) return;
                    void apiUpload(`/api/v1/clusters/${selectedId}/snapshots/upload`, [['passphrase', snapPass]], snapFile)
                      .then(() => { setSnapPass(''); setSnapFile(null); return loadDetail(); })
                      .catch((ex) => setErr(ex.message));
                  }}
                  className="mb-4 flex flex-wrap items-end gap-2 border-b border-slate-200 pb-3 text-xs dark:border-slate-800"
                >
                  <SecretInput label="归档口令（未加密可留空）" value={snapPass} onChangeValue={setSnapPass} />
                  <input type="file" onChange={(e) => setSnapFile(e.target.files?.[0] || null)} />
                  <Button type="submit">上传登记归档</Button>
                </form>
              )}
              <div className="space-y-2 text-xs">
                {snapshots.map((sn) => (
                  <div key={sn.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2.5 dark:border-slate-800">
                    <div>
                      <span className="font-mono font-semibold">{sn.id}</span>
                      <span className="ml-2 text-slate-500">
                        {sn.product_version} · 代际 {sn.seal_generation ?? '-'} · {fmtBytes(sn.size_bytes)} · {fmtTime(sn.created_at)}
                      </span>
                    </div>
                    {isAdmin && (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          onClick={() => {
                            setDlPw('');
                            setDlPass('');
                            setDlErr('');
                            setDlModal({
                              title: `下载快照 ${sn.id}`,
                              run: async (pw, passphrase) => {
                                await apiDownload(`/api/v1/clusters/${selectedId}/snapshots/${sn.id}/download`, {
                                  current_password: pw,
                                  passphrase,
                                }, `${cluster.name}-${sn.id}.ndsnap`);
                              },
                            });
                          }}
                        >
                          下载
                        </Button>
                        <Button
                          size="sm"
                          variant="danger-outline"
                          onClick={() =>
                            setPwAction({
                              title: `恢复 Raft 快照 ${sn.id}`,
                              run: async (pw) => {
                                const res = await apiPost(`/api/v1/clusters/${selectedId}/snapshots/${sn.id}/restore`, { current_password: pw });
                                if (res.task?.id) openTask(res.task.id, '恢复 Vault 快照');
                              },
                            })
                          }
                        >
                          恢复
                        </Button>
                        <Button
                          size="sm"
                          variant="danger-outline"
                          onClick={async () => {
                            if (!(await askConfirm(`确定要删除快照 ${sn.id} 吗？`, { title: '删除 Raft 快照', confirmText: '确认删除', danger: true }))) return;
                            void apiDelete(`/api/v1/clusters/${selectedId}/snapshots/${sn.id}`)
                              .then(() => {
                                toast.success('快照已删除');
                                return loadDetail();
                              })
                              .catch((ex) => setErr(ex.message));
                          }}
                        >
                          删除
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {tab === 'manage' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SectionTabs
                  variant="underline"
                  tabs={[
                    { id: 'kv', label: '应用密钥 · KV v2', badge: mounts.length },
                    { id: 'policies', label: 'ACL Policies', badge: policies.length },
                    { id: 'auth', label: 'Auth 认证方法', badge: auths.length },
                  ]}
                  active={manageTab}
                  onChange={(next) => setManageTab(next as 'kv' | 'policies' | 'auth')}
                />
                <Button size="sm" onClick={() => void loadManage()}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>刷新数据</span>
                </Button>
              </div>

              {manageTab === 'kv' && (
                <Card
                  title="应用密钥 · KV v2"
                  description="选择密钥存储空间（Mount）并浏览目录或新建应用 Secret，自动生成 Nomad Job 引用路径。"
                  actions={
                    isAdmin && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" onClick={() => setShowKVMount(true)}>
                          <Plus className="h-3.5 w-3.5" />
                          <span>启用 KV v2 挂载</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={!kvMount}
                          onClick={() => {
                            const suggestedPath = kvPath.trim().replace(/^\/+/, '');
                            openKVEditor({ path: suggestedPath, data: '{}', cas: 0 });
                          }}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span>新建 Secret</span>
                        </Button>
                      </div>
                    )
                  }
                >
                  <div className="space-y-4 text-xs">
                    {mounts.length === 0 ? (
                      <EmptyState
                        icon={<KeyRound className="h-6 w-6" />}
                        title="尚未启用 KV v2 密钥引擎"
                        description="先启用一个 KV v2 存储空间（例如 secret），即可在其中分类存放数据库密码、API Key 等应用密钥。"
                        action={
                          isAdmin && (
                            <Button variant="primary" onClick={() => setShowKVMount(true)}>
                              启用第一个 KV v2 挂载
                            </Button>
                          )
                        }
                      />
                    ) : (
                      <>
                        <div className="grid gap-3 sm:grid-cols-[200px_minmax(0,1fr)_auto] sm:items-end">
                          <Select
                            label="密钥存储空间（Mount）"
                            value={kvMount}
                            onChange={(e) => {
                              const nextM = e.target.value;
                              setKvMount(nextM);
                              setKvPath('');
    setKvListedDir('');
                              void listKVKeys(nextM, '');
                            }}
                          >
                            {mounts.map((m: any) => (
                              <option key={m.path || m} value={m.path || m}>{m.path || m}</option>
                            ))}
                          </Select>
                          <Input
                            label="密钥路径（目录或 Secret 名称）"
                            placeholder="例如 apps/postgres；留空浏览根目录"
                            value={kvPath}
                            onChange={(e) => setKvPath(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void listKVKeys(kvMount, kvPath);
                              }
                            }}
                          />
                          <Button
                            disabled={!kvMount}
                            loading={kvListing}
                            onClick={() => void listKVKeys(kvMount, kvPath)}
                          >
                            浏览 / 刷新
                          </Button>
                        </div>

                        {/* 目录面包屑导航 */}
                        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200/80 bg-slate-50/70 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-950/40">
                          <button
                            type="button"
                            onClick={() => {
                              setKvPath('');
    setKvListedDir('');
                              void listKVKeys(kvMount, '');
                            }}
                            className="font-mono font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                          >
                            {kvMount.replace(/\/+$/, '')}/
                          </button>
                          {kvPath
                            .split('/')
                            .filter(Boolean)
                            .map((seg, idx, arr) => {
                              const target = arr.slice(0, idx + 1).join('/') + (idx < arr.length - 1 || kvPath.endsWith('/') ? '/' : '');
                              return (
                                <React.Fragment key={`${target}-${idx}`}>
                                  <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setKvPath(target);
                                      if (target.endsWith('/')) void listKVKeys(kvMount, target);
                                    }}
                                    className="font-mono text-slate-700 hover:text-indigo-600 hover:underline dark:text-slate-200 dark:hover:text-indigo-300"
                                  >
                                    {seg}
                                  </button>
                                </React.Fragment>
                              );
                            })}
                        </div>

                        {kvKeys.length === 0 ? (
                          <div className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-slate-500 dark:border-slate-800 dark:text-slate-400">
                            {kvListing ? '正在读取目录…' : '当前路径下暂无密钥或子目录，可点击右上角「新建 Secret」创建。'}
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                            {kvKeys.map((k) => {
                              const isDir = k.endsWith('/');
                              const full = kvListedDir ? `${kvListedDir}/${k}` : k;
                              return (
                                <div
                                  key={k}
                                  className="flex items-center justify-between gap-1.5 rounded-xl border border-slate-200/90 bg-white pr-2 transition hover:border-indigo-400 hover:bg-indigo-50/40 dark:border-slate-800 dark:bg-slate-900/70 dark:hover:border-indigo-500/50 dark:hover:bg-indigo-950/25"
                                >
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (isDir) {
                                        setKvPath(full);
                                        void listKVKeys(kvMount, full);
                                        return;
                                      }
                                      setKvPath(full);
                                      if (!isAdmin) return;
                                      void apiGet(`/api/v1/vault/${selectedId}/kv/item?mount=${encodeURIComponent(kvMount)}&path=${encodeURIComponent(full)}`)
                                        .then((r) => {
                                          const rawData = r.secret && 'data' in r.secret ? r.secret.data : r.secret;
                                          openKVEditor({
                                            path: full,
                                            data: JSON.stringify(rawData ?? {}, null, 2),
                                            cas: Number(r.secret?.metadata?.version ?? 0),
                                          });
                                        })
                                        .catch((ex) => setErr(ex.message));
                                    }}
                                    className="flex min-w-0 flex-1 items-center justify-between gap-2 px-3.5 py-2.5 text-left"
                                  >
                                    <div className="flex items-center gap-2.5 min-w-0">
                                      {isDir ? (
                                        <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                                      ) : (
                                        <KeyRound className="h-4 w-4 shrink-0 text-indigo-500" />
                                      )}
                                      <span className="font-mono font-medium text-slate-800 dark:text-slate-100 truncate">{k}</span>
                                    </div>
                                    <span className="text-[11px] text-slate-400 shrink-0">{isDir ? '进入目录' : '查看/编辑'}</span>
                                  </button>
                                  {!isDir && isAdmin && (
                                    <button
                                      type="button"
                                      aria-label={`删除 ${k}`}
                                      title="删除 Secret"
                                      disabled={kvSaving}
                                      onClick={() => void handleDeleteKVSecret(full)}
                                      className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 dark:hover:bg-rose-950/50 dark:hover:text-rose-400"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {kvMount && kvPath.trim() && !kvPath.trim().endsWith('/') && (() => {
                          const cleanMount = kvMount.replace(/^\/+|\/+$/g, '');
                          const cleanPath = kvPath.trim().replace(/^\/+|\/+$/g, '');
                          const parsed = parseKVPath(`${cleanMount}/${cleanPath}`, cleanMount);
                          const envSnippet = buildTemplateData(parsed.templatePath, [], 'env');
                          return (
                            <div className="rounded-xl border border-indigo-200/80 bg-indigo-50/50 p-3.5 space-y-2.5 dark:border-indigo-500/30 dark:bg-indigo-950/25">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-semibold text-indigo-950 dark:text-indigo-100">用于 Nomad 联动（路径对照）</span>
                                <Link to="/integrations" className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-300">
                                  <span>去集群联动配置 Role</span>
                                  <ArrowRight className="h-3 w-3" />
                                </Link>
                              </div>
                              <p className="text-[11px] leading-4 text-slate-600 dark:text-slate-300">
                                在联动 Role 里授权填<strong>不带 data/</strong> 的路径；在 Nomad Job 的 <code className="font-mono">template</code> 里读 KV v2 必须多加一层 <code className="font-mono">/data/</code>。
                              </p>
                              <div className="grid gap-2 md:grid-cols-2">
                                <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
                                  <span className="truncate text-[11px] text-slate-500">Role 权限路径：<code className="font-mono text-slate-900 dark:text-slate-100">{parsed.rolePath}</code></span>
                                  <Button
                                    size="sm"
                                    onClick={() => void copyText(parsed.rolePath).then(() => toast.success('已复制 Role 权限路径')).catch((ex) => toast.error(ex.message))}
                                  >
                                    <Copy className="h-3 w-3" />
                                    <span>复制</span>
                                  </Button>
                                </div>
                                <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
                                  <span className="truncate text-[11px] text-slate-500">Job 模板读取路径：<code className="font-mono text-slate-900 dark:text-slate-100">{parsed.templatePath}</code></span>
                                  <Button
                                    size="sm"
                                    onClick={() => void copyText(envSnippet).then(() => toast.success('已复制 template 读取片段')).catch((ex) => toast.error(ex.message))}
                                  >
                                    <Copy className="h-3 w-3" />
                                    <span>复制模板</span>
                                  </Button>
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                      </>
                    )}
                  </div>
                </Card>
              )}

              {manageTab === 'policies' && (
                <Card
                  title="ACL Policies（权限规则）"
                  description="选择左侧策略查看或编辑 HCL 规则；由「集群联动」自动维护的策略建议在联动页面修改。"
                  actions={
                    isAdmin && (
                      <Button size="sm" variant={policyIsNew ? 'primary' : 'secondary'} onClick={startNewPolicy}>
                        <Plus className="h-3.5 w-3.5" />
                        <span>新建 Policy</span>
                      </Button>
                    )
                  }
                >
                  <div className="grid grid-cols-1 gap-5 lg:grid-cols-[260px_minmax(0,1fr)] text-xs">
                    <div className="space-y-1.5 rounded-xl border border-slate-200/80 bg-slate-50/50 p-2.5 dark:border-slate-800 dark:bg-slate-950/40 max-h-[440px] overflow-y-auto">
                      {policies.length === 0 ? (
                        <p className="px-2 py-4 text-center text-[11px] text-slate-500">暂无 Policy，可点击右上角新建。</p>
                      ) : (
                        policies.map((p) => {
                          const active = !policyIsNew && selectedPolicy === p;
                          const isBuiltin = ['root', 'default', 'nomad-deck-admin'].includes(p);
                          const isManaged = p.startsWith('nomad-') && !isBuiltin;
                          return (
                            <button
                              key={p}
                              type="button"
                              onClick={() => void selectPolicy(p)}
                              className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium transition ${
                                active
                                  ? 'bg-indigo-50 text-indigo-800 ring-1 ring-indigo-300 dark:bg-indigo-500/20 dark:text-indigo-100 dark:ring-indigo-500/40'
                                  : 'text-slate-700 hover:bg-white dark:text-slate-300 dark:hover:bg-slate-800/80'
                              }`}
                            >
                              <span className="font-mono truncate">{p}</span>
                              {isBuiltin && (
                                <span className="shrink-0 rounded bg-slate-200/80 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                                  内置
                                </span>
                              )}
                              {isManaged && (
                                <span className="shrink-0 rounded bg-indigo-100/90 px-1.5 py-0.5 text-[10px] text-indigo-700 dark:bg-indigo-500/25 dark:text-indigo-200">
                                  联动
                                </span>
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>

                    <div className="space-y-3 min-w-0">
                      {!policyIsNew && selectedPolicy.startsWith('nomad-') && selectedPolicy !== 'nomad-deck-admin' && (
                        <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 px-3.5 py-2.5 text-[11px] text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-950/30 dark:text-indigo-200">
                          该策略由「集群联动」自动生成并维护，建议前往 <Link to="/integrations" className="font-semibold underline">集群联动</Link> 修改对应的 Role；在此手动改动会在下次「应用联动」时被覆盖。
                        </div>
                      )}
                      {!policyIsNew && selectedPolicy === 'root' && (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[11px] text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                          <code className="font-mono">root</code> 为 Vault 内置最高权限策略，不可修改或删除。
                        </div>
                      )}

                      <Input
                        label={policyIsNew ? '新建 Policy 名称' : 'Policy 名称'}
                        placeholder="例如 app-readonly"
                        disabled={!policyIsNew && Boolean(selectedPolicy)}
                        hint={
                          policyIsNew
                            ? '填写英文名称后，在下方编写 HCL 权限规则并点击「保存 Policy」。'
                            : selectedPolicy
                              ? '当前正在编辑左侧选中的 Policy；如需新增，请点右上角「新建 Policy」。'
                              : '请在左侧选择任意 Policy，或点右上角「新建 Policy」。'
                        }
                        value={policyEdit.name}
                        onChange={(e) => setPolicyEdit({ ...policyEdit, name: e.target.value })}
                      />
                      <CodeEditor
                        label={policyLoading ? '正在加载规则内容…' : 'Policy 规则（HCL）'}
                        value={policyEdit.rules}
                        onChange={(v) => setPolicyEdit({ ...policyEdit, rules: v })}
                        readOnly={!isAdmin || (!policyIsNew && selectedPolicy === 'root')}
                        height="260px"
                      />
                      {isAdmin && (
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="primary"
                            disabled={!policyEdit.name.trim() || (!policyIsNew && selectedPolicy === 'root') || policyLoading}
                            title={!policyEdit.name.trim() ? '请先选择已有 Policy 或点击「新建 Policy」输入名称' : undefined}
                            onClick={() => {
                              const targetName = policyEdit.name.trim();
                              if (!targetName) return;
                              void apiPut(`/api/v1/vault/${selectedId}/policies/${encodeURIComponent(targetName)}`, { policy: policyEdit.rules })
                                .then(async () => {
                                  toast.success(`Policy「${targetName}」已保存`);
                                  setPolicyIsNew(false);
                                  setSelectedPolicy(targetName);
                                  await loadManage();
                                })
                                .catch((ex) => setErr(ex.message));
                            }}
                          >
                            保存 Policy
                          </Button>
                          {!policyIsNew && selectedPolicy && !['root', 'default', 'nomad-deck-admin'].includes(selectedPolicy) && (
                            <Button
                              variant="danger-outline"
                              onClick={async () => {
                                if (!(await askConfirm(`确认删除 Policy「${selectedPolicy}」吗？`, { title: '删除 Policy', confirmText: '确认删除', danger: true }))) return;
                                void apiDelete(`/api/v1/vault/${selectedId}/policies/${encodeURIComponent(selectedPolicy)}`)
                                  .then(() => {
                                    setPolicyEdit({ name: '', rules: '' });
                                    setSelectedPolicy('');
                                    toast.success('Policy 已删除');
                                    return loadManage();
                                  })
                                  .catch((ex) => setErr(ex.message));
                              }}
                            >
                              删除 Policy
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              )}

              {manageTab === 'auth' && (
                <Card
                  title="已启用的 Auth 认证方法"
                  description="管理 Vault 登录认证挂载（例如 Token、JWT、Userpass、AppRole）。与 Nomad 联动相关的 JWT 挂载由集群联动自动维护。"
                  actions={
                    isAdmin && (
                      <Button size="sm" variant="primary" onClick={() => setShowAuth(true)}>
                        <Plus className="h-3.5 w-3.5" />
                        <span>启用 Auth 方法</span>
                      </Button>
                    )
                  }
                >
                  {auths.length === 0 ? (
                    <EmptyState title="暂无 Auth 方法" description="Vault 初始化完成后将自动加载已启用的认证挂载。" />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                            <th className="py-2.5 pr-4">挂载路径</th>
                            <th className="py-2.5 pr-4">类型</th>
                            <th className="py-2.5 pr-4">说明</th>
                            <th className="py-2.5 text-right">操作</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {auths.map((a, i) => (
                            <tr key={a.path || i}>
                              <td className="py-3 pr-4 font-mono font-semibold text-slate-900 dark:text-slate-100">{a.path || '-'}</td>
                              <td className="py-3 pr-4">
                                <Badge tone={a.type === 'jwt' ? 'blue' : 'neutral'}>{a.type || '-'}</Badge>
                              </td>
                              <td className="py-3 pr-4 text-slate-500 dark:text-slate-400">{a.description || '—'}</td>
                              <td className="py-3 text-right">
                                {isAdmin && a.type !== 'token' ? (
                                  <Button
                                    size="sm"
                                    variant="danger-outline"
                                    onClick={async () => {
                                      if (!(await askConfirm(`确认停用 Auth 方法「${a.path}」吗？`, { title: '停用 Auth 方法', confirmText: '确认停用', danger: true }))) return;
                                      void apiDelete(`/api/v1/vault/${selectedId}/auth?path=${encodeURIComponent(a.path)}`)
                                        .then(() => {
                                          toast.success(`已停用 ${a.path}`);
                                          return loadManage();
                                        })
                                        .catch((ex) => setErr(ex.message));
                                    }}
                                  >
                                    停用
                                  </Button>
                                ) : (
                                  <span className="text-slate-400">内置</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              )}
            </div>
          )}
        </div>
      )}

      <Modal open={Boolean(gateView)} title="仲裁门禁预览" onClose={() => setGateView(null)}>
        {gateView && (
          <div className="space-y-4 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-500">结果：</span>
              <Badge tone={gateView.allowed ? 'green' : 'red'}>{gateView.allowed ? '允许' : '拦截'}</Badge>
            </div>
            <p className="leading-5 text-slate-700 dark:text-slate-200">{gateView.reason}</p>
            <div className="flex justify-end">
              <Button size="sm" variant="primary" onClick={() => setGateView(null)}>关闭</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(isAdmin && kvItem)}
        title={kvItem?.cas === 0 ? '新建 KV Secret' : `编辑 KV Secret：${kvItem?.path || ''}`}
        busy={kvSaving}
        onClose={() => { setKvItem(null); setKvErr(''); }}
        wide
      >
        {kvItem && (
          <div className="space-y-3.5 text-xs">
            <ErrorAlert message={kvErr} onClose={() => setKvErr('')} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-slate-500">
              <span className="font-mono">挂载：{kvMount}</span>
              <span className="font-mono">{kvItem.cas === 0 ? '新 Secret（v1）' : `当前版本 v${kvItem.cas}`}</span>
            </div>

            {kvItem.cas === 0 ? (
              <Input
                label="Secret 路径（不含挂载名与 data/）"
                required
                placeholder="例如 apps/postgres 或 apps/redis"
                value={kvItem.path}
                onChange={(e) => setKvItem({ ...kvItem, path: e.target.value })}
              />
            ) : (
              <div className="rounded-lg border border-slate-200/80 bg-slate-50/70 px-3 py-2 font-mono text-slate-700 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-200">
                路径：{kvItem.path}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTabs
                variant="underline"
                tabs={[
                  { id: 'form', label: '键值对表单' },
                  { id: 'json', label: 'JSON 源码' },
                ]}
                active={kvEditMode}
                onChange={(next) => {
                  setKvErr('');
                  if (next === 'json' && kvEditMode === 'form') {
                    const obj = serializeKVRows(kvRows);
                    setKvItem((cur) => (cur ? { ...cur, data: JSON.stringify(obj, null, 2) } : null));
                    setKvEditMode('json');
                  } else if (next === 'form' && kvEditMode === 'json') {
                    try {
                      const parsed = JSON.parse(kvItem.data || '{}');
                      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                        setKvErr('JSON 顶层必须是键值对对象才能切换到表单模式');
                        return;
                      }
                      const entries = Object.entries(parsed);
                      const allFlat = entries.every(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
                      if (!allFlat) {
                        setKvErr('包含嵌套对象或数组，请继续在 JSON 源码模式下编辑');
                        return;
                      }
                      setKvRows(entries.length ? entries.map(([k, v]) => ({ key: k, value: v == null ? '' : String(v) })) : [{ key: '', value: '' }]);
                      setKvEditMode('form');
                    } catch {
                      setKvErr('当前 JSON 语法不合法，请修正后再切换到表单模式');
                    }
                  }
                }}
              />
              {kvEditMode === 'form' && (
                <Button
                  size="sm"
                  onClick={() => setKvRows((prev) => [...prev, { key: '', value: '' }])}
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>添加字段</span>
                </Button>
              )}
            </div>

            {kvEditMode === 'form' ? (
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {kvRows.map((row, idx) => (
                  <div key={idx} className="grid grid-cols-[minmax(120px,0.9fr)_minmax(0,1.5fr)_auto] items-center gap-2">
                    <input
                      aria-label={`字段名 ${idx + 1}`}
                      placeholder="键名，如 password"
                      value={row.key}
                      onChange={(e) => setKvRows((prev) => prev.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r)))}
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                    />
                    <input
                      aria-label={`字段值 ${idx + 1}`}
                      placeholder="字段值"
                      value={row.value}
                      onChange={(e) => setKvRows((prev) => prev.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)))}
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                    />
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        title="生成 24 位随机强密码"
                        aria-label="生成随机强密码"
                        onClick={() => {
                          const pwd = generateRandomSecret(24);
                          setKvRows((prev) => prev.map((r, i) => (i === idx ? { ...r, value: pwd } : r)));
                        }}
                        className="rounded-lg border border-slate-200 bg-white p-1.5 text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 dark:border-slate-700 dark:bg-slate-900 dark:text-indigo-400 dark:hover:bg-indigo-950/50"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="删除字段"
                        aria-label="删除字段"
                        disabled={kvRows.length <= 1}
                        onClick={() => setKvRows((prev) => prev.filter((_, i) => i !== idx))}
                        className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-400 hover:border-rose-300 hover:text-rose-600 disabled:opacity-35 dark:border-slate-700 dark:bg-slate-900"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <CodeEditor label="Secret 数据（JSON）" value={kvItem.data} onChange={(v) => setKvItem({ ...kvItem, data: v })} height="240px" />
            )}

            {(() => {
              const cleanMount = kvMount.replace(/^\/+|\/+$/g, '') || 'secret';
              const cleanSecretPath = kvItem.path.trim().replace(/^\/+|\/+$/g, '');
              if (!cleanSecretPath) return null;
              const parsed = parseKVPath(`${cleanMount}/${cleanSecretPath}`, cleanMount);
              let keys: string[] = [];
              if (kvEditMode === 'form') {
                keys = kvRows.map((r) => r.key.trim()).filter(Boolean);
              } else {
                try {
                  const obj = JSON.parse(kvItem.data);
                  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    keys = Object.keys(obj);
                  }
                } catch {
                  // Ignore incomplete JSON while user is typing.
                }
              }
              const envSnippet = buildTemplateData(parsed.templatePath, keys, 'env');
              const fileSnippet = buildTemplateData(parsed.templatePath, keys, 'file');
              return (
                <div className="rounded-xl border border-indigo-200/80 bg-indigo-50/50 p-3 space-y-2 dark:border-indigo-500/30 dark:bg-indigo-950/25">
                  <div className="font-semibold text-indigo-950 dark:text-indigo-100">在 Nomad Job 中引用此 Secret</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 dark:border-slate-700 dark:bg-slate-900">
                      <span className="truncate text-[11px]">Role 授权路径：<code className="font-mono">{parsed.rolePath}</code></span>
                      <Button size="sm" onClick={() => void copyText(parsed.rolePath).then(() => toast.success('已复制 Role 路径')).catch((ex) => toast.error(ex.message))}>
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 dark:border-slate-700 dark:bg-slate-900">
                      <span className="truncate text-[11px]">模板路径：<code className="font-mono">{parsed.templatePath}</code></span>
                      <Button size="sm" onClick={() => void copyText(parsed.templatePath).then(() => toast.success('已复制模板路径')).catch((ex) => toast.error(ex.message))}>
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void copyText(envSnippet).then(() => toast.success('已复制环境变量模板代码')).catch((ex) => toast.error(ex.message))}>
                      <Copy className="h-3 w-3" />
                      <span>复制环境变量模板 (env)</span>
                    </Button>
                    <Button size="sm" onClick={() => void copyText(fileSnippet).then(() => toast.success('已复制密码文件模板代码')).catch((ex) => toast.error(ex.message))}>
                      <Copy className="h-3 w-3" />
                      <span>复制密码文件模板 (file)</span>
                    </Button>
                  </div>
                </div>
              );
            })()}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div>
                {kvItem.cas > 0 && (
                  <Button
                    type="button"
                    variant="danger-outline"
                    disabled={kvSaving}
                    onClick={() => void handleDeleteKVSecret(kvItem.path)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>删除 Secret</span>
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" disabled={kvSaving} onClick={() => { setKvItem(null); setKvErr(''); }}>关闭</Button>
                <Button
                  variant="primary"
                  loading={kvSaving}
                  onClick={async () => {
                  const targetPath = kvItem.path.trim().replace(/^\/+|\/+$/g, '');
                  if (!targetPath) {
                    setKvErr('请填写 Secret 路径，例如 apps/postgres');
                    return;
                  }
                  let payloadData: Record<string, unknown>;
                  if (kvEditMode === 'form') {
                    payloadData = serializeKVRows(kvRows);
                    if (Object.keys(payloadData).length === 0) {
                      setKvErr('请至少填写一个字段名');
                      return;
                    }
                  } else {
                    try {
                      payloadData = JSON.parse(kvItem.data);
                    } catch {
                      setKvErr('KV 数据必须是合法 JSON');
                      return;
                    }
                  }
                  setKvErr('');
                  setKvSaving(true);
                  try {
                    const r = await apiPut(
                      `/api/v1/vault/${selectedId}/kv/item?mount=${encodeURIComponent(kvMount)}&path=${encodeURIComponent(targetPath)}`,
                      { data: payloadData, cas: kvItem.cas },
                    );
                    toast.success(kvItem.cas === 0 ? 'Secret 已创建' : 'KV 已更新');
                    const nextVer = Number(r.result?.version ?? kvItem.cas + 1);
                    setKvItem({ path: targetPath, data: JSON.stringify(payloadData, null, 2), cas: nextVer });
                    const parentDir = targetPath.includes('/') ? `${targetPath.slice(0, targetPath.lastIndexOf('/') + 1)}` : '';
                    setKvPath(parentDir);
                    await listKVKeys(kvMount, parentDir);
                  } catch (ex: any) {
                    setKvErr(ex?.message || '保存 Secret 失败');
                  } finally {
                    setKvSaving(false);
                  }
                }}
              >
                保存 Secret
              </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      <ClusterCreateModal
        open={showCreate}
        product="vault"
        nodes={nodes}
        onClose={() => setShowCreate(false)}
        onCreated={async (id) => {
          await loadList();
          setSelectedId(id);
          setTab('status');
          toast.success('集群配置已创建，请继续部署服务');
        }}
      />

      <Modal open={showKVMount} title="启用 KV v2 挂载" onClose={() => setShowKVMount(false)}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void apiPost(`/api/v1/vault/${selectedId}/kv/mounts`, kvMountForm)
              .then(async () => {
                await loadManage();
                setKvMount(kvMountForm.path.trim().replace(/^\/+|\/+$/g, ''));
                setKvItem(null);
                setKvKeys([]);
                setKvPath('');
    setKvListedDir('');
                setShowKVMount(false);
                toast.success('KV v2 挂载已启用');
              })
              .catch((ex) => setErr(ex.message));
          }}
        >
          <Input label="挂载路径" required value={kvMountForm.path} onChange={(e) => setKvMountForm({ ...kvMountForm, path: e.target.value })} />
          <Input label="挂载描述" value={kvMountForm.description} onChange={(e) => setKvMountForm({ ...kvMountForm, description: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setShowKVMount(false)}>取消</Button>
            <Button type="submit" variant="primary">启用挂载</Button>
          </div>
        </form>
      </Modal>

      <Modal open={showAuth} title="启用 Vault Auth 方法" onClose={() => setShowAuth(false)}>
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          void apiPost(`/api/v1/vault/${selectedId}/auth`, authForm).then(() => { setShowAuth(false); return loadManage(); }).catch((ex) => setErr(ex.message));
        }}>
          <ErrorAlert message={err} onClose={() => setErr('')} />
          <Input label="Auth 挂载路径" required value={authForm.path} onChange={(e) => setAuthForm({ ...authForm, path: e.target.value })} />
          <Input label="Auth 类型" required value={authForm.type} onChange={(e) => setAuthForm({ ...authForm, type: e.target.value })} />
          <Input label="描述" value={authForm.description} onChange={(e) => setAuthForm({ ...authForm, description: e.target.value })} />
          <Button type="submit" variant="primary">启用 Auth</Button>
        </form>
      </Modal>

      <Modal open={showJoin} title="扩容 Vault 节点" onClose={() => setShowJoin(false)}>
        <form
          className="space-y-3 text-xs"
          onSubmit={async (e) => {
            e.preventDefault();
            setJoinBusy(true);
            try {
              const r = await apiPost(`/api/v1/clusters/${selectedId}/nodes/${joinNodeId}/join`, {
                confirm_swap: confirmSwap,
                advertise_addr: joinAdvertiseAddr.trim() || undefined,
              });
              setShowJoin(false);
              if (r.task?.id) openTask(r.task.id, '扩容 Vault 节点');
            } catch (ex: any) {
              setErr(ex?.message || '扩容失败');
            } finally {
              setJoinBusy(false);
            }
          }}
        >
          <ErrorAlert message={err} onClose={() => setErr('')} />
          <Select
            label="待加入主机"
            required
            value={joinNodeId}
            onChange={(e) => {
              const id = e.target.value;
              setJoinNodeId(id);
              const matched = nodes.find((n) => n.id === id);
              setJoinAdvertiseAddr(matched?.host || '');
            }}
          >
            <option value="">选择主机</option>
            {nodes.filter((n) => !clusterNodes.some((m: any) => m.node_id === n.id)).map((n) => <option key={n.id} value={n.id}>{n.name} ({n.host})</option>)}
          </Select>
          <div>
            <Input
              label="集群通信地址 (advertise_addr)"
              required
              placeholder="例如 10.0.0.12"
              value={joinAdvertiseAddr}
              onChange={(e) => setJoinAdvertiseAddr(e.target.value)}
              hint="默认填入主机 SSH 地址；加入多节点集群请填写真实内网 IP（勿填 127.0.0.1）。"
            />
            {isLoopbackAddress(joinAdvertiseAddr) && (
              <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
                跨机加入集群不能使用回环地址（127.0.0.1 / localhost），请改为真实内网 IP。
              </p>
            )}
          </div>
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
            <span>下载网络：{proxyEnabled ? '通过系统代理' : '直连'}</span>
            <Link to="/settings?tab=proxy" className="text-indigo-600 dark:text-indigo-400 hover:underline">前往下载代理设置</Link>
          </div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={confirmSwap} onChange={(e) => setConfirmSwap(e.target.checked)} />确认未加密 Swap 风险</label>
          <p className="text-slate-500">加入主机使用集群当前版本，完成 Raft 加入与解封后核对投票成员状态。</p>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setShowJoin(false)}>取消</Button>
            <Button type="submit" variant="primary" loading={joinBusy}>确认扩容</Button>
          </div>
        </form>
      </Modal>

      <PasswordConfirmModal
        open={Boolean(pwAction)}
        title={pwAction?.title || ''}
        onClose={() => setPwAction(null)}
        onConfirm={async (pw) => {
          if (pwAction) await pwAction.run(pw);
        }}
      />

      <Modal
        open={Boolean(uiLoginModal)}
        title={`免密登录 Vault Web UI${uiLoginModal?.targetLabel ? ` · ${uiLoginModal.targetLabel}` : ''}`}
        onClose={() => setUiLoginModal(null)}
        footer={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" onClick={() => setUiLoginModal(null)}>关闭</Button>
            {uiLoginModal && (
              <a
                href={uiLoginModal.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setUiLoginModal(null)}
                className="primary-button"
              >
                <span>立即免密打开 Vault UI</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        }
      >
        {uiLoginModal && (
          <div className="space-y-3 text-xs leading-5 text-slate-600 dark:text-slate-300">
            <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 px-3.5 py-2.5 text-indigo-950 dark:border-indigo-500/30 dark:bg-indigo-950/30 dark:text-indigo-100">
              <p>已生成<strong>单次自毁信封链接</strong>（{uiLoginModal.wrapTTL} 秒内有效，拆封一次即作废）。</p>
              <p className="mt-1">打开后会自动登录 Vault 原生后台，会话有效期为 <strong>{uiLoginModal.tokenTTL}</strong>，到期自动失效，无需手动吊销。</p>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              提示：如果节点使用自签名 TLS 证书，浏览器首次打开提示“证书风险”时点击“继续访问”后，页面仍会自动完成登录。
            </p>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(rootToken)}
        title="Vault 临时 Root Token"
        busy={revokingRootToken}
        onClose={() => setRootToken('')}
        footer={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {isAdmin && (
              <Button
                type="button"
                variant="danger"
                loading={revokingRootToken}
                onClick={async () => {
                  setRevokingRootToken(true);
                  try {
                    await apiPost(`/api/v1/vault/${selectedId}/root-token/revoke`, { token: rootToken });
                    setRootToken('');
                    toast.success('临时 Root Token 已向 Vault 吊销');
                  } catch (ex: any) {
                    toast.error(ex?.message || '吊销 Root Token 失败');
                  } finally {
                    setRevokingRootToken(false);
                  }
                }}
              >
                吊销 Root Token
              </Button>
            )}
            <Button type="button" variant="primary" disabled={revokingRootToken} onClick={() => setRootToken('')}>
              关闭
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-xs leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            此 Token 通过托管 Unseal Key 动态重建，控制面不落盘保存。可用于登录 Vault 原生 Web UI 或执行高危恢复操作；使用完毕后请及时点击「吊销 Root Token」作废。
          </div>
          <MaskedSecret value={rootToken} label="临时 Root Token：" />
        </div>
      </Modal>

      <Modal open={Boolean(dlModal)} title={dlModal?.title || ''} onClose={() => setDlModal(null)}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!dlModal) return;
            if (dlPass && dlPass.length < 6) {
              setDlErr('归档加密口令至少 6 位（或留空不加密）');
              return;
            }
            setDlBusy(true);
            setDlErr('');
            try {
              await dlModal.run(dlPw, dlPass);
              setDlModal(null);
            } catch (ex: any) {
              setDlErr(ex?.message || '导出失败');
            } finally {
              setDlBusy(false);
            }
          }}
          className="space-y-3 text-xs"
        >
          <ErrorAlert message={dlErr} />
          <SecretInput label="当前管理员登录密码" required value={dlPw} onChangeValue={setDlPw} />
          <SecretInput label="归档加密口令（可选，填写则至少 6 位）" value={dlPass} onChangeValue={setDlPass} />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setDlModal(null)}>取消</Button>
            <Button type="submit" variant="primary" disabled={dlBusy}>{dlBusy ? '导出中...' : '确认导出'}</Button>
          </div>
        </form>
      </Modal>

      <UninstallClusterModal
        open={Boolean(uninstallPlan)}
        cluster={cluster || null}
        plan={uninstallPlan}
        onClose={() => setUninstallPlan(null)}
        onSubmitted={(taskId) => {
          if (taskId) openTask(taskId, `卸载 Vault: ${cluster?.name || ''}`);
          void loadList();
        }}
      />
    </div>
  );
}
