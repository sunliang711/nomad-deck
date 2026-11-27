import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, ChevronRight, Copy, ExternalLink, Folder, KeyRound, Link2, Lock, Plus, RefreshCw, Shield, Sparkles, Trash2, Unlock } from 'lucide-react';
import { apiDelete, apiDownload, apiGet, apiPost, apiPut, apiUpload, fmtBytes, fmtTime } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { buildTemplateData, parseKVPath } from '../lib/vaultHelpers';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
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
  const { locale, isEn, tr } = useI18n();
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
      setErr(ex?.message || tr('加载 Vault 集群列表失败', 'Failed to load Vault clusters'));
    } finally {
      setLoadingList(false);
    }
  }, [queryId, tr]);

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
      setErr(ex?.message || tr('加载 Vault 集群详情失败', 'Failed to load Vault cluster details'));
    }
  }, [selectedId, tr]);

  const selectPolicy = useCallback(async (name: string) => {
    if (!selectedId || !name) return;
    setPolicyIsNew(false);
    setSelectedPolicy(name);
    setPolicyLoading(true);
    try {
      const r = await apiGet(`/api/v1/vault/${selectedId}/policies/${encodeURIComponent(name)}`);
      setPolicyEdit({ name, rules: r.policy?.rules || r.policy || '' });
    } catch (ex: any) {
      setErr(ex?.message || tr('读取 Policy 内容失败', 'Failed to load policy rules'));
    } finally {
      setPolicyLoading(false);
    }
  }, [selectedId, tr]);

  const startNewPolicy = () => {
    setPolicyIsNew(true);
    setSelectedPolicy('');
    setPolicyEdit({
      name: '',
      rules: isEn
        ? `# Example: grant read-only access to a KV v2 secret (adjust path as needed)\npath "secret/data/apps/demo" {\n  capabilities = ["read"]\n}\n`
        : `# 示例：允许只读指定 KV v2 密钥（请按需修改路径）\npath "secret/data/apps/demo" {\n  capabilities = ["read"]\n}\n`,
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
        setErr(ex?.message || tr('读取密钥目录失败', 'Failed to list secret directory'));
      }
    } finally {
      setKvListing(false);
    }
  }, [selectedId, tr]);

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
        tr(
          `确认彻底删除 Secret「${kvMount.replace(/\/+$/, '')}/${cleanTarget}」及其所有历史版本吗？删除后不可恢复。`,
          `Permanently delete secret "${kvMount.replace(/\/+$/, '')}/${cleanTarget}" and all its history? This cannot be undone.`,
        ),
        { title: tr('删除 KV Secret', 'Delete KV Secret'), confirmText: tr('确认删除', 'Delete'), danger: true },
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
      toast.success(tr(`Secret「${cleanTarget}」已删除`, `Secret "${cleanTarget}" deleted`));
      if (kvItem && kvItem.path.trim().replace(/^\/+|\/+$/g, '') === cleanTarget) {
        setKvItem(null);
      }
      const parentDir = cleanTarget.includes('/') ? `${cleanTarget.slice(0, cleanTarget.lastIndexOf('/') + 1)}` : '';
      setKvPath(parentDir);
      await listKVKeys(kvMount, parentDir);
    } catch (ex: any) {
      const msg = ex?.message || tr('删除 Secret 失败', 'Failed to delete secret');
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
      setErr(ex?.message || tr('加载 Vault 管理数据失败', 'Failed to load Vault management data'));
    }
  }, [selectedId, kvMount, kvPath, listKVKeys, policyIsNew, selectedPolicy, selectPolicy, tr]);

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
      title: tr('签发临时 Root Token（使用托管解封密钥重建）', 'Issue Temporary Root Token (reconstructed from custodied unseal keys)'),
      run: async (pw) => {
        const r = await apiPost(`/api/v1/vault/${selectedId}/root-token`, { current_password: pw });
        setRootToken(r.root_token || '');
      },
    });
  };

  const handleOpenWebUI = (targetUrl: string, label?: string) => {
    setPwAction({
      title: tr(`免密登录 Vault Web UI${label ? ` · ${label}` : ''}`, `SSO Login to Vault Web UI${label ? ` · ${label}` : ''}`),
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
        !(await askConfirm(tr(`确认删除未部署集群「${cluster.name}」吗？仅清除控制面记录，不会改动主机。`, `Delete undeployed cluster "${cluster.name}"? Only the control-plane record is removed; hosts are untouched.`), {
          title: tr('删除未部署集群', 'Delete Undeployed Cluster'),
          confirmText: tr('确认删除', 'Delete'),
          danger: true,
        }))
      ) {
        return;
      }
      try {
        await apiDelete(`/api/v1/clusters/${selectedId}`);
        toast.success(tr('集群记录已删除', 'Cluster record deleted'));
        await loadList();
        return;
      } catch (ex: any) {
        if (!String(ex?.message || '').includes('已部署')) {
          setErr(ex?.message || tr('删除集群失败', 'Failed to delete cluster'));
          return;
        }
      }
    }
    try {
      const r = await apiPost(`/api/v1/clusters/${selectedId}/uninstall/plan`, {});
      setUninstallPlan(r.plan || { warnings: [] });
    } catch (ex: any) {
      setErr(ex?.message || tr('获取卸载计划失败', 'Failed to load uninstall plan'));
    }
  };

  if (loadingList) return <LoadingState label={tr('正在加载 Vault 集群…', 'Loading Vault clusters...')} />;

  return (
    <div className="space-y-5">
      <PageHeader
        title={tr('Vault 集群', 'Vault Clusters')}
        subtitle={tr('管理 Raft HA Vault 集群、Shamir 密钥托管解封、Raft 快照与 Auth/Policy/KV', 'Manage Raft HA Vault clusters, Shamir key custody & auto-unseal, Raft snapshots, and Auth/Policy/KV')}
        actions={
          <>
            <Button title={tr('每 30 秒自动刷新', 'Auto-refreshes every 30s')} onClick={() => void loadDetail()}>
              <RefreshCw className="h-4 w-4" />
              <span>{tr('刷新', 'Refresh')}</span>
            </Button>
            {isAdmin && (
              <Button variant="primary" onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4" />
                <span>{tr('新建 Vault 集群', 'New Vault Cluster')}</span>
              </Button>
            )}
          </>
        }
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {!cluster ? (
        <Card>
          <EmptyState icon={<Shield className="w-6 h-6" />} title={tr('暂无 Vault 集群', 'No Vault Clusters')} description={tr('Vault 负责安全存储密钥与凭据。先接入主机，再选择节点、创建配置并部署服务。', 'Vault securely stores secrets and credentials. Enroll hosts first, then select nodes, create a config, and deploy.')} action={isAdmin && <Button variant="primary" onClick={() => setShowCreate(true)}>{tr('创建第一个 Vault 集群', 'Create First Vault Cluster')}</Button>} />
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ItemSwitcher
              label={tr('Vault 集群', 'Vault Cluster')}
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
                  statusLabel: awaitInit ? tr('已安装 · 待初始化', 'Installed · Awaiting Init') : undefined,
                };
              })}
            />
            <SectionTabs
              tabs={[
                { id: 'status', label: tr('集群状态详情', 'Cluster Status') },
                { id: 'custody', label: tr('初始化与密钥托管', 'Init & Key Custody'), title: tr('控制面托管 Vault Unseal Key（Shamir 门限分片）与短时效运维 Token，支持自动解封、Rekey 轮换及签发临时 Root Token', 'Control plane custodies Shamir unseal shares and short-lived admin tokens for auto-unseal, rekeying, and emergency root tokens') },
                { id: 'snapshots', label: tr('Raft 快照', 'Raft Snapshots'), badge: snapshots.length, title: tr('对 Vault Integrated Storage (Raft) 后端状态执行一致性快照备份与在线恢复', 'Take consistent Raft storage snapshots and perform online restores') },
                { id: 'manage', label: 'Auth / Policy / KV', title: tr('管理 Vault 认证挂载（Userpass/JWT/AppRole）、HCL 权限策略（Policy）以及 KV v2 密钥引擎', 'Manage Vault Auth methods, HCL policies, and KV v2 secret engines') },
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
                    .then((r) => { if (r.task?.id) openTask(r.task.id, tr('部署 Vault', 'Deploy Vault')); })
                    .catch((ex) => setErr(ex.message))
                }
                onInitVault={() =>
                  apiPost(`/api/v1/vault/${selectedId}/init`, { key_shares: 5, key_threshold: 3 })
                    .then((r) => { if (r.task?.id) openTask(r.task.id, tr('初始化 Vault 托管', 'Initialize Vault Custody')); })
                    .catch((ex) => setErr(ex.message))
                }
                quickActions={
                  <Link to="/integrations" className="primary-button">
                    <Link2 className="h-3.5 w-3.5" />
                    <span>{tr('配置集群联动', 'Configure Integrations')}</span>
                  </Link>
                }
                onUpgrade={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/upgrade`, { version: upVer.trim() || 'latest', confirm: true })
                    .then((r) => { if (r.task?.id) openTask(r.task.id, tr('滚动升级 Vault', 'Rolling Upgrade Vault')); })
                    .catch((ex) => setErr(ex.message))
                }
                onRenewCerts={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/certs/renew`, {})
                    .then((r) => { if (r.task?.id) openTask(r.task.id, tr('续期 Vault 证书', 'Renew Vault Certificates')); })
                    .catch((ex) => setErr(ex.message))
                }
                onRotateCA={() => {
                  setPwAction({
                    title: tr('确认轮换 Vault 集群 CA', 'Rotate Vault Cluster CA'),
                    run: async (pw) => {
                      const r = await apiPost(`/api/v1/clusters/${selectedId}/ca/rotate`, { current_password: pw });
                      if (r.task?.id) openTask(r.task.id, tr('轮换 Vault CA', 'Rotate Vault CA'));
                    },
                  });
                }}
                onDoctor={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/doctor`, {})
                    .then((r) => toast.info(r.report?.summary || tr('Doctor 完成', 'Doctor finished')))
                    .catch((ex) => setErr(ex.message))
                }
                onReconcile={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/reconcile`, {})
                    .then((r) => { toast.success(r.report?.message || tr('已核对', 'Reconciled')); return loadDetail(); })
                    .catch((ex) => setErr(ex.message))
                }
                onOpenWebUI={handleOpenWebUI}
                onUninstall={handleUninstall}
                onOpenJoin={() => { setJoinNodeId(''); setJoinAdvertiseAddr(''); setConfirmSwap(false); setShowJoin(true); }}
                onOpenLogs={(n) => openNodeLogs(selectedId, n.node_id, tr(`Vault 日志: ${n.name}`, `Vault Logs: ${n.name}`))}
                onCheckGate={(n) =>
                  apiGet(`/api/v1/clusters/${selectedId}/gate?node_id=${n.node_id}`)
                    .then((r) => setGateView(r.gate))
                    .catch((ex) => setErr(ex.message))
                }
                onRestartNode={(n) =>
                  apiPost(`/api/v1/clusters/${selectedId}/nodes/${n.node_id}/service/restart`, {})
                    .then((r) => { if (r.task?.id) openTask(r.task.id, tr(`重启节点: ${n.name}`, `Restart Node: ${n.name}`)); })
                    .catch((ex) => setErr(ex.message))
                }
                onRemoveNode={(n, force) =>
                  apiPost(`/api/v1/clusters/${selectedId}/nodes/${n.node_id}/remove`, { force })
                    .then((r) => { if (r.task?.id) openTask(r.task.id, tr(`${force ? '强制移出' : '缩容'}节点: ${n.name}`, `${force ? 'Force Remove' : 'Remove'} Node: ${n.name}`)); })
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
                <Card title={tr('托管状态与日常解封', 'Custody Status & Unsealing')}>
                  <div className="space-y-5 text-xs">
                    <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-3 rounded-xl border border-slate-200/80 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-950/40">
                      <dt className="text-slate-500">
                        <TermLabel term={tr('当前代际', 'Generation')} tip={tr('每次执行 Rekey 会生成新的密钥代际（Generation），旧代际历史仅保留审计轨迹。', 'Each Rekey produces a new key generation; prior generations remain for audit trail only.')} />
                      </dt>
                      <dd className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                        {custody.seal_generation ? `#${custody.seal_generation}` : tr('尚未初始化', 'Not initialized')}
                      </dd>
                      <dt className="text-slate-500">
                        <TermLabel term={tr('自动解封', 'Auto-Unseal')} tip={tr('开启后控制面在巡检发现 Vault 节点被密封时自动下发托管分片完成 Unseal。', 'When enabled, the control plane automatically submits custodied unseal shares when a Vault node seals.')} />
                      </dt>
                      <dd className="flex items-center gap-2.5">
                        {isAdmin ? (
                          <Switch
                            checked={Boolean(custody.auto_unseal_by_deck)}
                            label={tr('自动解封开关', 'Auto-Unseal Toggle')}
                            onChange={(next) =>
                              void apiPut(`/api/v1/vault/${selectedId}/custody`, { auto_unseal_by_deck: next })
                                .then(() => {
                                  toast.success(next ? tr('已开启自动解封', 'Auto-unseal enabled') : tr('已关闭自动解封', 'Auto-unseal disabled'));
                                  return loadDetail();
                                })
                                .catch((ex) => setErr(ex.message))
                            }
                          />
                        ) : null}
                        <Badge tone={custody.auto_unseal_by_deck ? 'green' : 'amber'}>
                          {custody.auto_unseal_by_deck ? tr('已开启', 'Enabled') : tr('已关闭', 'Disabled')}
                        </Badge>
                      </dd>
                      <dt className="text-slate-500">
                        <TermLabel term={tr('运维 Token 到期', 'Admin Token Expiry')} tip={tr('控制面持有的定期续期管理员 Token（非永久 Root Token），用于日常策略/KV 管理。', 'Renewable operational admin token held by the control plane for day-to-day policy/KV operations.')} />
                      </dt>
                      <dd className="text-slate-700 dark:text-slate-200">{fmtTime(custody.admin_token_expires_at, locale)}</dd>
                    </dl>

                    {custody.unseal_suppressed_reason && (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/50 dark:text-amber-200">
                        <span>{tr('抑制原因：', 'Suppressed: ')}{custody.unseal_suppressed_reason}</span>
                        {isAdmin && (
                          <Button
                            size="sm"
                            onClick={() =>
                              setPwAction({
                                title: tr('解除自动解封抑制', 'Clear Auto-Unseal Suppression'),
                                run: async (pw) => {
                                  await apiPut(`/api/v1/vault/${selectedId}/custody`, { clear_suppression: true, current_password: pw });
                                  await loadDetail();
                                },
                              })
                            }
                          >
                            {tr('解除抑制', 'Clear Suppression')}
                          </Button>
                        )}
                      </div>
                    )}

                    {isAdmin && (
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <div className="font-semibold text-slate-800 dark:text-slate-100">{tr('初始化与密封控制', 'Initialization & Seal Controls')}</div>
                          <div className="flex flex-wrap gap-2">
                            {!isInitialized && (
                              <Button
                                variant="primary"
                                onClick={() =>
                                  void apiPost(`/api/v1/vault/${selectedId}/init`, { key_shares: 5, key_threshold: 3 })
                                    .then((r) => r.task?.id && openTask(r.task.id, tr('初始化 Vault 托管', 'Initialize Vault Custody')))
                                    .catch((ex) => setErr(ex.message))
                                }
                              >
                                {tr('一键初始化托管', 'Initialize & Custody')}
                              </Button>
                            )}
                            <Button
                              disabled={!isInitialized}
                              onClick={() =>
                                void apiPost(`/api/v1/vault/${selectedId}/unseal`, {})
                                  .then((r) => r.task?.id && openTask(r.task.id, tr('解封 Vault 集群', 'Unseal Vault Cluster')))
                                  .catch((ex) => setErr(ex.message))
                              }
                            >
                              <Unlock className="h-3.5 w-3.5" /> {tr('全集群解封', 'Unseal Cluster')}
                            </Button>
                            <Button
                              variant="danger-outline"
                              disabled={!isInitialized}
                              onClick={async () => {
                                if (!(await askConfirm(tr('确定要安全封存整个 Vault 集群吗？封存后将暂停对外提供密钥读写服务。', 'Seal the entire Vault cluster? Secret reads/writes will stop until unsealed.'), { title: tr('封存 Vault 集群', 'Seal Vault Cluster'), confirmText: tr('确认封存', 'Seal'), danger: true }))) return;
                                void apiPost(`/api/v1/vault/${selectedId}/seal`, {})
                                  .then((r) => r.task?.id && openTask(r.task.id, tr('封存 Vault 集群', 'Seal Vault Cluster')))
                                  .catch((ex) => setErr(ex.message));
                              }}
                            >
                              <Lock className="h-3.5 w-3.5" /> {tr('安全封存', 'Seal Cluster')}
                            </Button>
                          </div>
                        </div>

                        <div className="border-t border-slate-200 pt-3.5 space-y-2 dark:border-slate-800">
                          <div className="font-semibold text-slate-800 dark:text-slate-100">{tr('密钥轮换与应急凭据', 'Key Rotation & Emergency Credentials')}</div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              disabled={!isInitialized}
                              onClick={() =>
                                setPwAction({
                                  title: tr('确认执行 Vault Rekey 密钥轮换', 'Confirm Vault Rekey'),
                                  run: async (pw) => {
                                    const r = await apiPost(`/api/v1/vault/${selectedId}/rekey`, { current_password: pw });
                                    if (r.task?.id) openTask(r.task.id, 'Vault Rekey');
                                  },
                                })
                              }
                            >
                              {tr('Rekey 轮换', 'Rekey Cluster')}
                            </Button>
                            <Button
                              disabled={!isInitialized}
                              onClick={() =>
                                setPwAction({
                                  title: tr('确认应急重签 Vault 运维 Token', 'Recover Vault Admin Token'),
                                  run: async (pw) => {
                                    const r = await apiPost(`/api/v1/vault/${selectedId}/custody/recover-token`, { current_password: pw });
                                    if (r.task?.id) openTask(r.task.id, tr('重签 Vault 运维 Token', 'Recover Vault Admin Token'));
                                  },
                                })
                              }
                            >
                              {tr('应急重签运维 Token', 'Recover Admin Token')}
                            </Button>
                            <Button
                              disabled={!isInitialized}
                              onClick={handleIssueRootToken}
                            >
                              {tr('签发临时 Root Token', 'Issue Root Token')}
                            </Button>
                            <Button
                              disabled={!isInitialized}
                              onClick={() => {
                                setDlPw('');
                                setDlPass('');
                                setDlErr('');
                                setDlModal({
                                  title: tr('导出 Vault 离线紧急备份 (.ndvkb)', 'Export Vault Offline Recovery Backup (.ndvkb)'),
                                  run: async (pw, passphrase) => {
                                    await apiDownload(`/api/v1/vault/${selectedId}/custody/backup`, { current_password: pw, passphrase }, `${cluster.name}.ndvkb`);
                                  },
                                });
                              }}
                            >
                              {tr('导出离线备份', 'Export Offline Backup')}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </Card>

                <Card title={tr('Unseal Key 代际历史', 'Unseal Key Generations')}>
                  {gens.length === 0 ? (
                    <EmptyState title={tr('暂无密钥代际', 'No Key Generations')} description={tr('完成首次初始化后，这里会记录每次生成或 Rekey 的密钥代际与门限。', 'Key generations and Shamir thresholds from initialization and rekeys appear here.')} />
                  ) : (
                    <div className="space-y-2 text-xs">
                      {gens.map((g) => (
                        <div key={g.generation} className="flex items-center justify-between rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                          <span className="font-medium text-slate-800 dark:text-slate-100">
                            {tr(`代际 #${g.generation}（门限 ${g.key_threshold} / 共 ${g.key_shares} 份）`, `Generation #${g.generation} (Threshold ${g.key_threshold} / ${g.key_shares} shares)`)}
                          </span>
                          <Badge tone={statusTone(g.state)}>{g.state === 'active' ? tr('当前生效', 'Active') : g.state}</Badge>
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
              title={tr('Raft 快照管理', 'Raft Snapshots')}
              actions={
                isAdmin && (
                  <Button size="sm" variant="primary" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/snapshots`, {}).then((r) => r.task?.id && openTask(r.task.id)).catch((ex) => setErr(ex.message))}>
                    {tr('创建快照', 'Create Snapshot')}
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
                  <SecretInput label={tr('归档口令（未加密可留空）', 'Archive Passphrase (leave blank if unencrypted)')} value={snapPass} onChangeValue={setSnapPass} />
                  <input type="file" onChange={(e) => setSnapFile(e.target.files?.[0] || null)} />
                  <Button type="submit">{tr('上传登记归档', 'Upload & Register')}</Button>
                </form>
              )}
              <div className="space-y-2 text-xs">
                {snapshots.map((sn) => (
                  <div key={sn.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2.5 dark:border-slate-800">
                    <div>
                      <span className="font-mono font-semibold">{sn.id}</span>
                      <span className="ml-2 text-slate-500">
                        {sn.product_version} · {tr('代际', 'Gen')} {sn.seal_generation ?? '-'} · {fmtBytes(sn.size_bytes)} · {fmtTime(sn.created_at, locale)}
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
                              title: tr(`下载快照 ${sn.id}`, `Download Snapshot ${sn.id}`),
                              run: async (pw, passphrase) => {
                                await apiDownload(`/api/v1/clusters/${selectedId}/snapshots/${sn.id}/download`, {
                                  current_password: pw,
                                  passphrase,
                                }, `${cluster.name}-${sn.id}.ndsnap`);
                              },
                            });
                          }}
                        >
                          {tr('下载', 'Download')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger-outline"
                          onClick={() =>
                            setPwAction({
                              title: tr(`恢复 Raft 快照 ${sn.id}`, `Restore Raft Snapshot ${sn.id}`),
                              run: async (pw) => {
                                const res = await apiPost(`/api/v1/clusters/${selectedId}/snapshots/${sn.id}/restore`, { current_password: pw });
                                if (res.task?.id) openTask(res.task.id, tr('恢复 Vault 快照', 'Restore Vault Snapshot'));
                              },
                            })
                          }
                        >
                          {tr('恢复', 'Restore')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger-outline"
                          onClick={async () => {
                            if (!(await askConfirm(tr(`确定要删除快照 ${sn.id} 吗？`, `Delete snapshot ${sn.id}?`), { title: tr('删除 Raft 快照', 'Delete Raft Snapshot'), confirmText: tr('确认删除', 'Delete'), danger: true }))) return;
                            void apiDelete(`/api/v1/clusters/${selectedId}/snapshots/${sn.id}`)
                              .then(() => {
                                toast.success(tr('快照已删除', 'Snapshot deleted'));
                                return loadDetail();
                              })
                              .catch((ex) => setErr(ex.message));
                          }}
                        >
                          {tr('删除', 'Delete')}
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
                    { id: 'kv', label: tr('应用密钥 · KV v2', 'Secrets · KV v2'), badge: mounts.length },
                    { id: 'policies', label: 'ACL Policies', badge: policies.length },
                    { id: 'auth', label: tr('Auth 认证方法', 'Auth Methods'), badge: auths.length },
                  ]}
                  active={manageTab}
                  onChange={(next) => setManageTab(next as 'kv' | 'policies' | 'auth')}
                />
                <Button size="sm" onClick={() => void loadManage()}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>{tr('刷新数据', 'Refresh')}</span>
                </Button>
              </div>

              {manageTab === 'kv' && (
                <Card
                  title={tr('应用密钥 · KV v2', 'Secrets · KV v2')}
                  description={tr('选择密钥存储空间（Mount）并浏览目录或新建应用 Secret，自动生成 Nomad Job 引用路径。', 'Choose a KV v2 mount to browse paths or create application secrets with auto-generated Nomad template paths.')}
                  actions={
                    isAdmin && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" onClick={() => setShowKVMount(true)}>
                          <Plus className="h-3.5 w-3.5" />
                          <span>{tr('启用 KV v2 挂载', 'Enable KV v2 Mount')}</span>
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
                          <span>{tr('新建 Secret', 'New Secret')}</span>
                        </Button>
                      </div>
                    )
                  }
                >
                  <div className="space-y-4 text-xs">
                    {mounts.length === 0 ? (
                      <EmptyState
                        icon={<KeyRound className="h-6 w-6" />}
                        title={tr('尚未启用 KV v2 密钥引擎', 'No KV v2 Engine Enabled')}
                        description={tr('先启用一个 KV v2 存储空间（例如 secret），即可在其中分类存放数据库密码、API Key 等应用密钥。', 'Enable a KV v2 mount (e.g. secret) first to store database passwords, API keys, and application credentials.')}
                        action={
                          isAdmin && (
                            <Button variant="primary" onClick={() => setShowKVMount(true)}>
                              {tr('启用第一个 KV v2 挂载', 'Enable First KV v2 Mount')}
                            </Button>
                          )
                        }
                      />
                    ) : (
                      <>
                        <div className="grid gap-3 sm:grid-cols-[200px_minmax(0,1fr)_auto] sm:items-end">
                          <Select
                            label={tr('密钥存储空间（Mount）', 'Secrets Mount')}
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
                            label={tr('密钥路径（目录或 Secret 名称）', 'Secret Path (directory or key name)')}
                            placeholder={tr('例如 apps/postgres；留空浏览根目录', 'e.g. apps/postgres; blank for root')}
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
                            {tr('浏览 / 刷新', 'Browse / Refresh')}
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
                            {kvListing ? tr('正在读取目录…', 'Listing directory...') : tr('当前路径下暂无密钥或子目录，可点击右上角「新建 Secret」创建。', 'No keys or subdirectories at this path yet. Click "New Secret" to create one.')}
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
                                    <span className="text-[11px] text-slate-400 shrink-0">{isDir ? tr('进入目录', 'Open') : tr('查看/编辑', 'View / Edit')}</span>
                                  </button>
                                  {!isDir && isAdmin && (
                                    <button
                                      type="button"
                                      aria-label={tr(`删除 ${k}`, `Delete ${k}`)}
                                      title={tr('删除 Secret', 'Delete Secret')}
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
                          const parsed = parseKVPath(`${cleanMount}/${cleanPath}`, cleanMount, locale);
                          const envSnippet = buildTemplateData(parsed.templatePath, [], 'env');
                          return (
                            <div className="rounded-xl border border-indigo-200/80 bg-indigo-50/50 p-3.5 space-y-2.5 dark:border-indigo-500/30 dark:bg-indigo-950/25">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-semibold text-indigo-950 dark:text-indigo-100">{tr('用于 Nomad 联动（路径对照）', 'Nomad Integration Path Reference')}</span>
                                <Link to="/integrations" className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-300">
                                  <span>{tr('去集群联动配置 Role', 'Configure Role in Integrations')}</span>
                                  <ArrowRight className="h-3 w-3" />
                                </Link>
                              </div>
                              <p className="text-[11px] leading-4 text-slate-600 dark:text-slate-300">
                                {tr(
                                  <>在联动 Role 里授权填<strong>不带 data/</strong> 的路径；在 Nomad Job 的 <code className="font-mono">template</code> 里读 KV v2 必须多加一层 <code className="font-mono">/data/</code>。</>,
                                  <>Use the path <strong>without data/</strong> when granting access in a Role; include <code className="font-mono">/data/</code> inside Nomad Job <code className="font-mono">template</code> blocks for KV v2.</>,
                                )}
                              </p>
                              <div className="grid gap-2 md:grid-cols-2">
                                <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
                                  <span className="truncate text-[11px] text-slate-500">{tr('Role 权限路径：', 'Role Policy Path: ')}<code className="font-mono text-slate-900 dark:text-slate-100">{parsed.rolePath}</code></span>
                                  <Button
                                    size="sm"
                                    onClick={() => void copyText(parsed.rolePath).then(() => toast.success(tr('已复制 Role 权限路径', 'Copied Role path'))).catch((ex) => toast.error(ex.message))}
                                  >
                                    <Copy className="h-3 w-3" />
                                    <span>{tr('复制', 'Copy')}</span>
                                  </Button>
                                </div>
                                <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
                                  <span className="truncate text-[11px] text-slate-500">{tr('Job 模板读取路径：', 'Job Template Path: ')}<code className="font-mono text-slate-900 dark:text-slate-100">{parsed.templatePath}</code></span>
                                  <Button
                                    size="sm"
                                    onClick={() => void copyText(envSnippet).then(() => toast.success(tr('已复制 template 读取片段', 'Copied template snippet'))).catch((ex) => toast.error(ex.message))}
                                  >
                                    <Copy className="h-3 w-3" />
                                    <span>{tr('复制模板', 'Copy Template')}</span>
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
                  title={tr('ACL Policies（权限规则）', 'ACL Policies')}
                  description={tr('选择左侧策略查看或编辑 HCL 规则；由「集群联动」自动维护的策略建议在联动页面修改。', 'Select a policy to inspect or edit HCL rules. Policies managed by Integrations should be edited there.')}
                  actions={
                    isAdmin && (
                      <Button size="sm" variant={policyIsNew ? 'primary' : 'secondary'} onClick={startNewPolicy}>
                        <Plus className="h-3.5 w-3.5" />
                        <span>{tr('新建 Policy', 'New Policy')}</span>
                      </Button>
                    )
                  }
                >
                  <div className="grid grid-cols-1 gap-5 lg:grid-cols-[260px_minmax(0,1fr)] text-xs">
                    <div className="space-y-1.5 rounded-xl border border-slate-200/80 bg-slate-50/50 p-2.5 dark:border-slate-800 dark:bg-slate-950/40 max-h-[440px] overflow-y-auto">
                      {policies.length === 0 ? (
                        <p className="px-2 py-4 text-center text-[11px] text-slate-500">{tr('暂无 Policy，可点击右上角新建。', 'No policies yet. Click "New Policy" above.')}</p>
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
                                  {tr('内置', 'Built-in')}
                                </span>
                              )}
                              {isManaged && (
                                <span className="shrink-0 rounded bg-indigo-100/90 px-1.5 py-0.5 text-[10px] text-indigo-700 dark:bg-indigo-500/25 dark:text-indigo-200">
                                  {tr('联动', 'Managed')}
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
                          {tr(
                            <>该策略由「集群联动」自动生成并维护，建议前往 <Link to="/integrations" className="font-semibold underline">集群联动</Link> 修改对应的 Role；在此手动改动会在下次「应用联动」时被覆盖。</>,
                            <>This policy is managed by <Link to="/integrations" className="font-semibold underline">Integrations</Link>. Edit the corresponding Role there; manual changes here will be overwritten on the next Apply.</>,
                          )}
                        </div>
                      )}
                      {!policyIsNew && selectedPolicy === 'root' && (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[11px] text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                          {tr(
                            <><code className="font-mono">root</code> 为 Vault 内置最高权限策略，不可修改或删除。</>,
                            <><code className="font-mono">root</code> is Vault&apos;s built-in superuser policy and cannot be modified or deleted.</>,
                          )}
                        </div>
                      )}

                      <Input
                        label={policyIsNew ? tr('新建 Policy 名称', 'New Policy Name') : tr('Policy 名称', 'Policy Name')}
                        placeholder={tr('例如 app-readonly', 'e.g. app-readonly')}
                        disabled={!policyIsNew && Boolean(selectedPolicy)}
                        hint={
                          policyIsNew
                            ? tr('填写英文名称后，在下方编写 HCL 权限规则并点击「保存 Policy」。', 'Enter a policy name, write HCL rules below, and click "Save Policy".')
                            : selectedPolicy
                              ? tr('当前正在编辑左侧选中的 Policy；如需新增，请点右上角「新建 Policy」。', 'Editing selected policy; click "New Policy" above to create one.')
                              : tr('请在左侧选择任意 Policy，或点右上角「新建 Policy」。', 'Select a policy on the left or click "New Policy".')
                        }
                        value={policyEdit.name}
                        onChange={(e) => setPolicyEdit({ ...policyEdit, name: e.target.value })}
                      />
                      <CodeEditor
                        label={policyLoading ? tr('正在加载规则内容…', 'Loading policy rules...') : tr('Policy 规则（HCL）', 'Policy Rules (HCL)')}
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
                            title={!policyEdit.name.trim() ? tr('请先选择已有 Policy 或点击「新建 Policy」输入名称', 'Select a policy or click "New Policy" first') : undefined}
                            onClick={() => {
                              const targetName = policyEdit.name.trim();
                              if (!targetName) return;
                              void apiPut(`/api/v1/vault/${selectedId}/policies/${encodeURIComponent(targetName)}`, { policy: policyEdit.rules })
                                .then(async () => {
                                  toast.success(tr(`Policy「${targetName}」已保存`, `Policy "${targetName}" saved`));
                                  setPolicyIsNew(false);
                                  setSelectedPolicy(targetName);
                                  await loadManage();
                                })
                                .catch((ex) => setErr(ex.message));
                            }}
                          >
                            {tr('保存 Policy', 'Save Policy')}
                          </Button>
                          {!policyIsNew && selectedPolicy && !['root', 'default', 'nomad-deck-admin'].includes(selectedPolicy) && (
                            <Button
                              variant="danger-outline"
                              onClick={async () => {
                                if (!(await askConfirm(tr(`确认删除 Policy「${selectedPolicy}」吗？`, `Delete policy "${selectedPolicy}"?`), { title: tr('删除 Policy', 'Delete Policy'), confirmText: tr('确认删除', 'Delete'), danger: true }))) return;
                                void apiDelete(`/api/v1/vault/${selectedId}/policies/${encodeURIComponent(selectedPolicy)}`)
                                  .then(() => {
                                    setPolicyEdit({ name: '', rules: '' });
                                    setSelectedPolicy('');
                                    toast.success(tr('Policy 已删除', 'Policy deleted'));
                                    return loadManage();
                                  })
                                  .catch((ex) => setErr(ex.message));
                              }}
                            >
                              {tr('删除 Policy', 'Delete Policy')}
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
                  title={tr('已启用的 Auth 认证方法', 'Enabled Auth Methods')}
                  description={tr('管理 Vault 登录认证挂载（例如 Token、JWT、Userpass、AppRole）。与 Nomad 联动相关的 JWT 挂载由集群联动自动维护。', 'Manage Vault auth mounts (Token, JWT, Userpass, AppRole). JWT mounts for Nomad are managed by Integrations.')}
                  actions={
                    isAdmin && (
                      <Button size="sm" variant="primary" onClick={() => setShowAuth(true)}>
                        <Plus className="h-3.5 w-3.5" />
                        <span>{tr('启用 Auth 方法', 'Enable Auth Method')}</span>
                      </Button>
                    )
                  }
                >
                  {auths.length === 0 ? (
                    <EmptyState title={tr('暂无 Auth 方法', 'No Auth Methods')} description={tr('Vault 初始化完成后将自动加载已启用的认证挂载。', 'Enabled auth mounts load once Vault is initialized.')} />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                            <th className="py-2.5 pr-4">{tr('挂载路径', 'Mount Path')}</th>
                            <th className="py-2.5 pr-4">{tr('类型', 'Type')}</th>
                            <th className="py-2.5 pr-4">{tr('说明', 'Description')}</th>
                            <th className="py-2.5 text-right">{tr('操作', 'Actions')}</th>
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
                                      if (!(await askConfirm(tr(`确认停用 Auth 方法「${a.path}」吗？`, `Disable auth method "${a.path}"?`), { title: tr('停用 Auth 方法', 'Disable Auth Method'), confirmText: tr('确认停用', 'Disable'), danger: true }))) return;
                                      void apiDelete(`/api/v1/vault/${selectedId}/auth?path=${encodeURIComponent(a.path)}`)
                                        .then(() => {
                                          toast.success(tr(`已停用 ${a.path}`, `Disabled ${a.path}`));
                                          return loadManage();
                                        })
                                        .catch((ex) => setErr(ex.message));
                                    }}
                                  >
                                    {tr('停用', 'Disable')}
                                  </Button>
                                ) : (
                                  <span className="text-slate-400">{tr('内置', 'Built-in')}</span>
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

      <Modal open={Boolean(gateView)} title={tr('仲裁门禁预览', 'Quorum Safety Gate Preview')} onClose={() => setGateView(null)}>
        {gateView && (
          <div className="space-y-4 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-500">{tr('结果：', 'Result: ')}</span>
              <Badge tone={gateView.allowed ? 'green' : 'red'}>{gateView.allowed ? tr('允许', 'Allowed') : tr('拦截', 'Blocked')}</Badge>
            </div>
            <p className="leading-5 text-slate-700 dark:text-slate-200">{gateView.reason}</p>
            <div className="flex justify-end">
              <Button size="sm" variant="primary" onClick={() => setGateView(null)}>{tr('关闭', 'Close')}</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(isAdmin && kvItem)}
        title={kvItem?.cas === 0 ? tr('新建 KV Secret', 'New KV Secret') : tr(`编辑 KV Secret：${kvItem?.path || ''}`, `Edit KV Secret: ${kvItem?.path || ''}`)}
        busy={kvSaving}
        onClose={() => { setKvItem(null); setKvErr(''); }}
        wide
      >
        {kvItem && (
          <div className="space-y-3.5 text-xs">
            <ErrorAlert message={kvErr} onClose={() => setKvErr('')} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-slate-500">
              <span className="font-mono">{tr('挂载：', 'Mount: ')}{kvMount}</span>
              <span className="font-mono">{kvItem.cas === 0 ? tr('新 Secret（v1）', 'New Secret (v1)') : tr(`当前版本 v${kvItem.cas}`, `Version v${kvItem.cas}`)}</span>
            </div>

            {kvItem.cas === 0 ? (
              <Input
                label={tr('Secret 路径（不含挂载名与 data/）', 'Secret Path (without mount or data/)')}
                required
                placeholder={tr('例如 apps/postgres 或 apps/redis', 'e.g. apps/postgres or apps/redis')}
                value={kvItem.path}
                onChange={(e) => setKvItem({ ...kvItem, path: e.target.value })}
              />
            ) : (
              <div className="rounded-lg border border-slate-200/80 bg-slate-50/70 px-3 py-2 font-mono text-slate-700 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-200">
                {tr('路径：', 'Path: ')}{kvItem.path}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTabs
                variant="underline"
                tabs={[
                  { id: 'form', label: tr('键值对表单', 'Key-Value Form') },
                  { id: 'json', label: tr('JSON 源码', 'Raw JSON') },
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
                        setKvErr(tr('JSON 顶层必须是键值对对象才能切换到表单模式', 'Top-level JSON must be a key-value object to switch to Form mode'));
                        return;
                      }
                      const entries = Object.entries(parsed);
                      const allFlat = entries.every(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
                      if (!allFlat) {
                        setKvErr(tr('包含嵌套对象或数组，请继续在 JSON 源码模式下编辑', 'Contains nested objects or arrays; edit in Raw JSON mode'));
                        return;
                      }
                      setKvRows(entries.length ? entries.map(([k, v]) => ({ key: k, value: v == null ? '' : String(v) })) : [{ key: '', value: '' }]);
                      setKvEditMode('form');
                    } catch {
                      setKvErr(tr('当前 JSON 语法不合法，请修正后再切换到表单模式', 'Invalid JSON syntax; fix errors before switching to Form mode'));
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
                  <span>{tr('添加字段', 'Add Field')}</span>
                </Button>
              )}
            </div>

            {kvEditMode === 'form' ? (
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {kvRows.map((row, idx) => (
                  <div key={idx} className="grid grid-cols-[minmax(120px,0.9fr)_minmax(0,1.5fr)_auto] items-center gap-2">
                    <input
                      aria-label={tr(`字段名 ${idx + 1}`, `Key ${idx + 1}`)}
                      placeholder={tr('键名，如 password', 'Key name, e.g. password')}
                      value={row.key}
                      onChange={(e) => setKvRows((prev) => prev.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r)))}
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                    />
                    <input
                      aria-label={tr(`字段值 ${idx + 1}`, `Value ${idx + 1}`)}
                      placeholder={tr('字段值', 'Value')}
                      value={row.value}
                      onChange={(e) => setKvRows((prev) => prev.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)))}
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                    />
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        title={tr('生成 24 位随机强密码', 'Generate 24-char random password')}
                        aria-label={tr('生成随机强密码', 'Generate random password')}
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
                        title={tr('删除字段', 'Remove field')}
                        aria-label={tr('删除字段', 'Remove field')}
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
              <CodeEditor label={tr('Secret 数据（JSON）', 'Secret Data (JSON)')} value={kvItem.data} onChange={(v) => setKvItem({ ...kvItem, data: v })} height="240px" />
            )}

            {(() => {
              const cleanMount = kvMount.replace(/^\/+|\/+$/g, '') || 'secret';
              const cleanSecretPath = kvItem.path.trim().replace(/^\/+|\/+$/g, '');
              if (!cleanSecretPath) return null;
              const parsed = parseKVPath(`${cleanMount}/${cleanSecretPath}`, cleanMount, locale);
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
                  <div className="font-semibold text-indigo-950 dark:text-indigo-100">{tr('在 Nomad Job 中引用此 Secret', 'Reference in Nomad Jobs')}</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 dark:border-slate-700 dark:bg-slate-900">
                      <span className="truncate text-[11px]">{tr('Role 授权路径：', 'Role Policy Path: ')}<code className="font-mono">{parsed.rolePath}</code></span>
                      <Button size="sm" onClick={() => void copyText(parsed.rolePath).then(() => toast.success(tr('已复制 Role 路径', 'Copied Role path'))).catch((ex) => toast.error(ex.message))}>
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 dark:border-slate-700 dark:bg-slate-900">
                      <span className="truncate text-[11px]">{tr('模板路径：', 'Template Path: ')}<code className="font-mono">{parsed.templatePath}</code></span>
                      <Button size="sm" onClick={() => void copyText(parsed.templatePath).then(() => toast.success(tr('已复制模板路径', 'Copied template path'))).catch((ex) => toast.error(ex.message))}>
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void copyText(envSnippet).then(() => toast.success(tr('已复制环境变量模板代码', 'Copied env template snippet'))).catch((ex) => toast.error(ex.message))}>
                      <Copy className="h-3 w-3" />
                      <span>{tr('复制环境变量模板 (env)', 'Copy Env Template (env)')}</span>
                    </Button>
                    <Button size="sm" onClick={() => void copyText(fileSnippet).then(() => toast.success(tr('已复制密码文件模板代码', 'Copied file template snippet'))).catch((ex) => toast.error(ex.message))}>
                      <Copy className="h-3 w-3" />
                      <span>{tr('复制密码文件模板 (file)', 'Copy File Template (file)')}</span>
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
                    <span>{tr('删除 Secret', 'Delete Secret')}</span>
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" disabled={kvSaving} onClick={() => { setKvItem(null); setKvErr(''); }}>{tr('关闭', 'Close')}</Button>
                <Button
                  variant="primary"
                  loading={kvSaving}
                  onClick={async () => {
                  const targetPath = kvItem.path.trim().replace(/^\/+|\/+$/g, '');
                  if (!targetPath) {
                    setKvErr(tr('请填写 Secret 路径，例如 apps/postgres', 'Please enter a secret path, e.g. apps/postgres'));
                    return;
                  }
                  let payloadData: Record<string, unknown>;
                  if (kvEditMode === 'form') {
                    payloadData = serializeKVRows(kvRows);
                    if (Object.keys(payloadData).length === 0) {
                      setKvErr(tr('请至少填写一个字段名', 'Please add at least one field name'));
                      return;
                    }
                  } else {
                    try {
                      payloadData = JSON.parse(kvItem.data);
                    } catch {
                      setKvErr(tr('KV 数据必须是合法 JSON', 'KV data must be valid JSON'));
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
                    toast.success(kvItem.cas === 0 ? tr('Secret 已创建', 'Secret created') : tr('KV 已更新', 'KV updated'));
                    const nextVer = Number(r.result?.version ?? kvItem.cas + 1);
                    setKvItem({ path: targetPath, data: JSON.stringify(payloadData, null, 2), cas: nextVer });
                    const parentDir = targetPath.includes('/') ? `${targetPath.slice(0, targetPath.lastIndexOf('/') + 1)}` : '';
                    setKvPath(parentDir);
                    await listKVKeys(kvMount, parentDir);
                  } catch (ex: any) {
                    setKvErr(ex?.message || tr('保存 Secret 失败', 'Failed to save secret'));
                  } finally {
                    setKvSaving(false);
                  }
                }}
              >
                {tr('保存 Secret', 'Save Secret')}
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
          toast.success(tr('集群配置已创建，请继续部署服务', 'Cluster config created. Continue to deploy.'));
        }}
      />

      <Modal open={showKVMount} title={tr('启用 KV v2 挂载', 'Enable KV v2 Mount')} onClose={() => setShowKVMount(false)}>
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
                toast.success(tr('KV v2 挂载已启用', 'KV v2 mount enabled'));
              })
              .catch((ex) => setErr(ex.message));
          }}
        >
          <Input label={tr('挂载路径', 'Mount Path')} required value={kvMountForm.path} onChange={(e) => setKvMountForm({ ...kvMountForm, path: e.target.value })} />
          <Input label={tr('挂载描述', 'Description')} value={kvMountForm.description} onChange={(e) => setKvMountForm({ ...kvMountForm, description: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setShowKVMount(false)}>{tr('取消', 'Cancel')}</Button>
            <Button type="submit" variant="primary">{tr('启用挂载', 'Enable Mount')}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={showAuth} title={tr('启用 Vault Auth 方法', 'Enable Vault Auth Method')} onClose={() => setShowAuth(false)}>
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          void apiPost(`/api/v1/vault/${selectedId}/auth`, authForm).then(() => { setShowAuth(false); return loadManage(); }).catch((ex) => setErr(ex.message));
        }}>
          <ErrorAlert message={err} onClose={() => setErr('')} />
          <Input label={tr('Auth 挂载路径', 'Auth Mount Path')} required value={authForm.path} onChange={(e) => setAuthForm({ ...authForm, path: e.target.value })} />
          <Input label={tr('Auth 类型', 'Auth Type')} required value={authForm.type} onChange={(e) => setAuthForm({ ...authForm, type: e.target.value })} />
          <Input label={tr('描述', 'Description')} value={authForm.description} onChange={(e) => setAuthForm({ ...authForm, description: e.target.value })} />
          <Button type="submit" variant="primary">{tr('启用 Auth', 'Enable Auth')}</Button>
        </form>
      </Modal>

      <Modal open={showJoin} title={tr('扩容 Vault 节点', 'Add Vault Node')} onClose={() => setShowJoin(false)}>
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
              if (r.task?.id) openTask(r.task.id, tr('扩容 Vault 节点', 'Add Vault Node'));
            } catch (ex: any) {
              setErr(ex?.message || tr('扩容失败', 'Failed to join node'));
            } finally {
              setJoinBusy(false);
            }
          }}
        >
          <ErrorAlert message={err} onClose={() => setErr('')} />
          <Select
            label={tr('待加入主机', 'Host to Join')}
            required
            value={joinNodeId}
            onChange={(e) => {
              const id = e.target.value;
              setJoinNodeId(id);
              const matched = nodes.find((n) => n.id === id);
              setJoinAdvertiseAddr(matched?.host || '');
            }}
          >
            <option value="">{tr('选择主机', 'Select host')}</option>
            {nodes.filter((n) => !clusterNodes.some((m: any) => m.node_id === n.id)).map((n) => <option key={n.id} value={n.id}>{n.name} ({n.host})</option>)}
          </Select>
          <div>
            <Input
              label={tr('集群通信地址 (advertise_addr)', 'Advertise Address (advertise_addr)')}
              required
              placeholder={tr('例如 10.0.0.12', 'e.g. 10.0.0.12')}
              value={joinAdvertiseAddr}
              onChange={(e) => setJoinAdvertiseAddr(e.target.value)}
              hint={tr('默认填入主机 SSH 地址；加入多节点集群请填写真实内网 IP（勿填 127.0.0.1）。', 'Prefilled with SSH host address; use a reachable private IP for multi-node clusters (not 127.0.0.1).')}
            />
            {isLoopbackAddress(joinAdvertiseAddr) && (
              <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
                {tr('跨机加入集群不能使用回环地址（127.0.0.1 / localhost），请改为真实内网 IP。', 'Loopback addresses (127.0.0.1 / localhost) cannot be used when joining a multi-node cluster.')}
              </p>
            )}
          </div>
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
            <span>{tr('下载网络：', 'Download Network: ')}{proxyEnabled ? tr('通过系统代理', 'Via system proxy') : tr('直连', 'Direct')}</span>
            <Link to="/settings?tab=proxy" className="text-indigo-600 dark:text-indigo-400 hover:underline">{tr('前往下载代理设置', 'Configure download proxy')}</Link>
          </div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={confirmSwap} onChange={(e) => setConfirmSwap(e.target.checked)} />{tr('确认未加密 Swap 风险', 'Confirm unencrypted swap risk')}</label>
          <p className="text-slate-500">{tr('加入主机使用集群当前版本，完成 Raft 加入与解封后核对投票成员状态。', 'Joined node uses current cluster version and verifies Raft voter membership after unseal.')}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setShowJoin(false)}>{tr('取消', 'Cancel')}</Button>
            <Button type="submit" variant="primary" loading={joinBusy}>{tr('确认扩容', 'Join Node')}</Button>
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
        title={tr(`免密登录 Vault Web UI${uiLoginModal?.targetLabel ? ` · ${uiLoginModal.targetLabel}` : ''}`, `SSO Login to Vault Web UI${uiLoginModal?.targetLabel ? ` · ${uiLoginModal.targetLabel}` : ''}`)}
        onClose={() => setUiLoginModal(null)}
        footer={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" onClick={() => setUiLoginModal(null)}>{tr('关闭', 'Close')}</Button>
            {uiLoginModal && (
              <a
                href={uiLoginModal.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setUiLoginModal(null)}
                className="primary-button"
              >
                <span>{tr('立即免密打开 Vault UI', 'Open Vault UI (SSO)')}</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        }
      >
        {uiLoginModal && (
          <div className="space-y-3 text-xs leading-5 text-slate-600 dark:text-slate-300">
            <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 px-3.5 py-2.5 text-indigo-950 dark:border-indigo-500/30 dark:bg-indigo-950/30 dark:text-indigo-100">
              <p>
                {tr(
                  <>已生成<strong>单次自毁信封链接</strong>（{uiLoginModal.wrapTTL} 秒内有效，拆封一次即作废）。</>,
                  <>A <strong>response-wrapped single-use link</strong> has been created (valid for {uiLoginModal.wrapTTL}s).</>,
                )}
              </p>
              <p className="mt-1">
                {tr(
                  <>打开后会自动登录 Vault 原生后台，会话有效期为 <strong>{uiLoginModal.tokenTTL}</strong>，到期自动失效，无需手动吊销。</>,
                  <>Opening the link signs you into Vault UI automatically with a session TTL of <strong>{uiLoginModal.tokenTTL}</strong>.</>,
                )}
              </p>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {tr('提示：如果节点使用自签名 TLS 证书，浏览器首次打开提示“证书风险”时点击“继续访问”后，页面仍会自动完成登录。', 'Tip: If the node uses a self-signed TLS cert, click Proceed in your browser and SSO login will still complete.')}
            </p>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(rootToken)}
        title={tr('Vault 临时 Root Token', 'Vault Temporary Root Token')}
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
                    toast.success(tr('临时 Root Token 已向 Vault 吊销', 'Temporary Root Token revoked in Vault'));
                  } catch (ex: any) {
                    toast.error(ex?.message || tr('吊销 Root Token 失败', 'Failed to revoke Root Token'));
                  } finally {
                    setRevokingRootToken(false);
                  }
                }}
              >
                {tr('吊销 Root Token', 'Revoke Root Token')}
              </Button>
            )}
            <Button type="button" variant="primary" disabled={revokingRootToken} onClick={() => setRootToken('')}>
              {tr('关闭', 'Close')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-xs leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            {tr('此 Token 通过托管 Unseal Key 动态重建，控制面不落盘保存。可用于登录 Vault 原生 Web UI 或执行高危恢复操作；使用完毕后请及时点击「吊销 Root Token」作废。', 'Dynamically reconstructed from custodied Unseal Keys (never stored on disk). Click "Revoke Root Token" as soon as you finish.')}
          </div>
          <MaskedSecret value={rootToken} label={tr('临时 Root Token：', 'Temporary Root Token:')} />
        </div>
      </Modal>

      <Modal open={Boolean(dlModal)} title={dlModal?.title || ''} onClose={() => setDlModal(null)}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!dlModal) return;
            if (dlPass && dlPass.length < 6) {
              setDlErr(tr('归档加密口令至少 6 位（或留空不加密）', 'Archive passphrase must be at least 6 characters (or blank for unencrypted)'));
              return;
            }
            setDlBusy(true);
            setDlErr('');
            try {
              await dlModal.run(dlPw, dlPass);
              setDlModal(null);
            } catch (ex: any) {
              setDlErr(ex?.message || tr('导出失败', 'Export failed'));
            } finally {
              setDlBusy(false);
            }
          }}
          className="space-y-3 text-xs"
        >
          <ErrorAlert message={dlErr} />
          <SecretInput label={tr('当前管理员登录密码', 'Current Admin Password')} required value={dlPw} onChangeValue={setDlPw} />
          <SecretInput label={tr('归档加密口令（可选，填写则至少 6 位）', 'Archive Encryption Passphrase (optional, min 6 chars)')} value={dlPass} onChangeValue={setDlPass} />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setDlModal(null)}>{tr('取消', 'Cancel')}</Button>
            <Button type="submit" variant="primary" disabled={dlBusy}>{dlBusy ? tr('导出中...', 'Exporting...') : tr('确认导出', 'Export')}</Button>
          </div>
        </form>
      </Modal>

      <UninstallClusterModal
        open={Boolean(uninstallPlan)}
        cluster={cluster || null}
        plan={uninstallPlan}
        onClose={() => setUninstallPlan(null)}
        onSubmitted={(taskId) => {
          if (taskId) openTask(taskId, tr(`卸载 Vault: ${cluster?.name || ''}`, `Uninstall Vault: ${cluster?.name || ''}`));
          void loadList();
        }}
      />
    </div>
  );
}
