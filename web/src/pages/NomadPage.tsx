import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Boxes, ExternalLink, FileCode2, KeyRound, Plus, RefreshCw } from 'lucide-react';
import { apiDelete, apiDownload, apiGet, apiPost, apiPut, apiUpload, fmtBytes, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import {
  buildTabSearchParams,
  NOMAD_CLUSTER_KEY,
  readStoredSelection,
  resolveClusterSelection,
  resolveTabParam,
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
  statusTone,
} from '../components/UI';
import { NomadWorkbench } from '../components/NomadWorkbench';
import { CodeEditor } from '../components/CodeEditor';
import { ClusterOpsSection } from '../components/ClusterOpsSection';
import { ItemSwitcher } from '../components/ItemSwitcher';
import { UninstallClusterModal, type UninstallPlan } from '../components/UninstallClusterModal';
import { ClusterCreateModal } from '../components/ClusterCreateModal';
import { NomadClusterSettingsPanel, NomadNodeConfigModal } from '../components/NomadConfigModals';
import { isLoopbackAddress } from '../lib/net';

export function NomadPage() {
  const { isAdmin } = useAuth();
  const { locale, tr } = useI18n();
  const navigate = useNavigate();
  const { openTask, openNodeLogs, tasks } = useOpsDrawer();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryId = searchParams.get('id') || '';
  const queryNs = searchParams.get('ns') || '';
  const queryJob = searchParams.get('job') || '';
  const querySub = searchParams.get('sub') || '';
  const [clusters, setClusters] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState(() => queryId || readStoredSelection(NOMAD_CLUSTER_KEY));
  const [loadingList, setLoadingList] = useState(true);
  const selectionRef = useRef(selectedId);
  selectionRef.current = selectedId;
  const tab = resolveTabParam(
    searchParams,
    isAdmin
      ? (['status', 'ops', 'workbench', 'snapshots', 'governance'] as const)
      : (['status', 'workbench', 'snapshots', 'governance'] as const),
    'status',
  );
  const setTab = useCallback(
    (nextTab: string) => {
      const next = buildTabSearchParams(searchParams, nextTab, 'status', {
        deleteKeys: nextTab === 'ops' ? undefined : ['sub'],
      });
      if (next.toString() !== searchParams.toString()) {
        setSearchParams(next);
      }
    },
    [searchParams, setSearchParams],
  );
  const opsSubTab: 'actions' | 'config' = searchParams.get('sub') === 'config' ? 'config' : 'actions';
  const setOpsSubTab = useCallback(
    (nextSub: 'actions' | 'config') => {
      const next = buildTabSearchParams(
        searchParams,
        'ops',
        'status',
        nextSub === 'config' ? { extra: { sub: 'config' } } : { deleteKeys: ['sub'] },
      );
      if (next.toString() !== searchParams.toString()) {
        setSearchParams(next);
      }
    },
    [searchParams, setSearchParams],
  );
  const [govSubTab, setGovSubTab] = useState<'tenants' | 'policies' | 'tokens'>('tenants');
  const [tokenModal, setTokenModal] = useState<{ name: string; policies: string[] } | null>(null);

  // Redirect legacy /nomad?id=X&tab=workbench&job=Y links directly to Job Center runtime view
  useEffect(() => {
    if (!queryJob) return;
    const cid = queryId || selectedId;
    if (!cid) return;
    const ns = queryNs || 'default';
    navigate(
      `/jobs?cluster_id=${encodeURIComponent(cid)}&namespace=${encodeURIComponent(ns)}&job=${encodeURIComponent(queryJob)}&tab=runtime`,
      { replace: true },
    );
  }, [queryJob, queryId, queryNs, selectedId, navigate]);

  useEffect(() => {
    if (queryId && clusters.some((c: any) => c.id === queryId)) {
      setSelectedId(queryId);
    }
  }, [queryId, clusters]);

  useEffect(() => {
    if (selectedId && clusters.some((c: any) => c.id === selectedId)) {
      writeStoredSelection(NOMAD_CLUSTER_KEY, selectedId);
    }
  }, [selectedId, clusters]);
  const [status, setStatus] = useState<any>(null);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [namespaces, setNamespaces] = useState<any[]>([]);
  const [pools, setPools] = useState<any[]>([]);
  const [policies, setPolicies] = useState<any[]>([]);
  const [tokens, setTokens] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [governanceEdit, setGovernanceEdit] = useState<{ kind: 'namespaces' | 'node-pools'; name: string; description: string; meta: Record<string, string>; creating: boolean } | null>(null);
  const [roleEdit, setRoleEdit] = useState<{ id: string; name: string; description: string; policies: string[] } | null>(null);
  const [policyEdit, setPolicyEdit] = useState({ name: '', rules: '' });
  const [revealedToken, setRevealedToken] = useState<{
    accessor_id: string;
    name: string;
    type?: string;
    policies?: string[];
    roles?: string[];
    expiration_time?: string;
    secret_id: string;
    newlyIssued?: boolean;
  } | null>(null);
  const [mgmtToken, setMgmtToken] = useState('');
  const [uiLoginModal, setUiLoginModal] = useState<{ url: string; targetLabel: string; ottTTL: number; tokenTTL: string } | null>(null);
  const [uninstallPlan, setUninstallPlan] = useState<UninstallPlan | null>(null);
  const [err, setErr] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [memberRecords, setMemberRecords] = useState<any[]>([]);
  const [configMember, setConfigMember] = useState<any>(null);
  const [deployVer, setDeployVer] = useState('latest');
  const [upVer, setUpVer] = useState('');
  const [showJoin, setShowJoin] = useState(false);
  const [joinNodeId, setJoinNodeId] = useState('');
  const [joinAdvertiseAddr, setJoinAdvertiseAddr] = useState('');
  const [joinRole, setJoinRole] = useState('server_client');
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [joinBusy, setJoinBusy] = useState(false);
  const [drainClients, setDrainClients] = useState(true);
  const [gateView, setGateView] = useState<any>(null);
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
      const [cRes, nRes] = await Promise.all([apiGet('/api/v1/clusters?type=nomad'), apiGet('/api/v1/nodes')]);
      const list = cRes.clusters || [];
      setClusters(list);
      setNodes(nRes.nodes || []);
      setSelectedId((prev) =>
        resolveClusterSelection(list, queryId, prev, readStoredSelection(NOMAD_CLUSTER_KEY)),
      );
    } catch (ex: any) {
      setErr(ex?.message || tr('加载 Nomad 集群列表失败', 'Failed to load Nomad clusters'));
    } finally {
      setLoadingList(false);
    }
  }, [queryId, tr]);

  const loadOpsTab = useCallback(async () => {
    if (!selectedId) return;
    try {
      const [cRes, stRes, snRes] = await Promise.all([
        apiGet(`/api/v1/clusters/${selectedId}`),
        apiGet(`/api/v1/clusters/${selectedId}/status`),
        apiGet(`/api/v1/clusters/${selectedId}/snapshots`),
      ]);
      if (selectionRef.current !== selectedId) return;
      setStatus(stRes.status);
      setMemberRecords(cRes.nodes || []);
      setClusters((prev) => prev.map((c) => c.id === selectedId ? {
        ...c,
        ...(cRes.cluster || {}),
        health_status: stRes.status.health_status,
        init_state: stRes.status.init_state,
        maintenance_mode: stRes.status.maintenance_mode,
        maintenance_reason: stRes.status.maintenance_reason,
      } : c));
      setSnapshots(snRes.snapshots || []);
    } catch (ex: any) {
      if (selectionRef.current !== selectedId) return;
      setErr(ex?.message || tr('加载 Nomad 状态失败', 'Failed to load Nomad status'));
    }
  }, [selectedId, tr]);

  const loadGovernance = async () => {
    if (!selectedId) return;
    try {
      const [nsRes, plRes, polRes, tokRes, roleRes] = await Promise.all([
        apiGet(`/api/v1/nomad/${selectedId}/namespaces`),
        apiGet(`/api/v1/nomad/${selectedId}/node-pools`),
        apiGet(`/api/v1/nomad/${selectedId}/acl/policies`),
        apiGet(`/api/v1/nomad/${selectedId}/acl/tokens`),
        apiGet(`/api/v1/nomad/${selectedId}/acl/roles`),
      ]);
      setNamespaces(nsRes.namespaces || []);
      setPools(plRes.node_pools || []);
      setPolicies(polRes.policies || []);
      setTokens(tokRes.tokens || []);
      setRoles(roleRes.roles || []);
    } catch (ex: any) {
      setErr(ex?.message || tr('加载治理信息失败', 'Failed to load governance info'));
    }
  };

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    void apiGet('/api/v1/settings').then((r) => {
      setDeployVer(r.settings?.['defaults.nomad_version'] || 'latest');
      setProxyEnabled(Boolean(r.settings?.['proxy.use_for_nomad'] ?? r.settings?.['proxy.use_for_releases']));
    }).catch((ex) => setErr(ex.message));
  }, []);

  const clusterTaskState = tasks.filter((task) => task.target_id === selectedId)
    .map((task) => `${task.id}:${task.status}`).join(',');

  useEffect(() => {
    if (!clusterTaskState) return;
    void loadList();
    const uninstallDone = tasks.some((task) => task.target_id === selectedId && task.action === 'cluster.uninstall' && task.status === 'success');
    if (!uninstallDone) void loadOpsTab();
  }, [clusterTaskState, loadList, loadOpsTab]);

  useEffect(() => {
    setStatus(null);
    setMemberRecords([]);
    setConfigMember(null);
    setUiLoginModal(null);
  }, [selectedId]);

  const cluster = clusters.find((c) => c.id === selectedId);

  useEffect(() => {
    setGateView(null);
    setMgmtToken('');
    setRevealedToken(null);
    setUninstallPlan(null);
    if (selectedId && (tab === 'status' || tab === 'ops' || tab === 'snapshots')) void loadOpsTab();
    if (selectedId && tab === 'governance') void loadGovernance();
    if (!selectedId || (tab !== 'status' && tab !== 'ops')) return;
    const t = setInterval(() => void loadOpsTab(), 30000);
    return () => clearInterval(t);
  }, [selectedId, tab, loadOpsTab]);

  const handleRevealMgmtToken = () => {
    setPwAction({
      title: tr('查看 Nomad Management (Root) Token', 'Reveal Nomad Management (Root) Token'),
      run: async (pw) => {
        const res = await apiPost(`/api/v1/nomad/${selectedId}/management-token/reveal`, { current_password: pw });
        setMgmtToken(res.management_token || '');
      },
    });
  };

  const handleRevealAclToken = (tk: any) => {
    const label = tk.name || (tk.accessor_id || '').slice(0, 12);
    setPwAction({
      title: tr(`查看 ACL Token Secret · ${label}`, `Reveal ACL Token Secret · ${label}`),
      run: async (pw) => {
        const res = await apiPost(
          `/api/v1/nomad/${selectedId}/acl/tokens/${encodeURIComponent(tk.accessor_id)}/reveal`,
          { current_password: pw },
        );
        const revealed = res.token || {};
        setRevealedToken({
          accessor_id: revealed.accessor_id || tk.accessor_id,
          name: revealed.name || tk.name || 'unnamed',
          type: revealed.type || tk.type,
          policies: revealed.policies || tk.policies || [],
          roles: revealed.roles || tk.roles || [],
          expiration_time: revealed.expiration_time || tk.expiration_time,
          secret_id: revealed.secret_id || '',
          newlyIssued: false,
        });
      },
    });
  };

  const handleOpenWebUI = (targetUrl: string, label?: string) => {
    setPwAction({
      title: tr(`快捷登录UI · Nomad${label ? ` · ${label}` : ''}`, `Quick UI Login · Nomad${label ? ` · ${label}` : ''}`),
      run: async (pw) => {
        const r = await apiPost(`/api/v1/nomad/${selectedId}/ui-login`, {
          current_password: pw,
          target_url: targetUrl,
        });
        setUiLoginModal({
          url: r.login_url,
          targetLabel: label || targetUrl,
          ottTTL: Number(r.ott_ttl_seconds || 600),
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

  const clusterNodes = status?.nodes || [];
  const nodeConfigs = Object.fromEntries(memberRecords.map((m) => [m.node_id, m.config]));


  if (loadingList) return <LoadingState label={tr('正在加载 Nomad 集群…', 'Loading Nomad clusters...')} />;

  return (
    <div className="space-y-5">
      <PageHeader
        title={tr('Nomad 集群', 'Nomad Clusters')}
        subtitle={tr('管理 Nomad Server/Client 编排、运行态工作台、Raft 快照与 ACL 多租户治理', 'Manage Nomad Server/Client orchestration, runtime workbench, Raft snapshots, and ACL multi-tenant governance')}
        actions={
          <>
            <Button onClick={() => { void loadList(); if (tab === 'status' || tab === 'ops' || tab === 'snapshots') void loadOpsTab(); if (tab === 'governance') void loadGovernance(); }}>
              <RefreshCw className="h-4 w-4" />
              <span>{tr('刷新', 'Refresh')}</span>
            </Button>
            {isAdmin && (
              <Button variant="primary" onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4" />
                <span>{tr('新建 Nomad 集群', 'New Nomad Cluster')}</span>
              </Button>
            )}
          </>
        }
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {!cluster ? (
        <Card>
          <EmptyState icon={<Boxes className="w-6 h-6" />} title={tr('暂无 Nomad 集群', 'No Nomad Clusters')} description={tr('Nomad 负责调度与运行工作负载。先接入主机，再选择节点、创建配置并部署服务。', 'Nomad schedules and runs your workloads. Enroll hosts first, then select nodes, create a config, and deploy.')} action={isAdmin && <Button variant="primary" onClick={() => setShowCreate(true)}>{tr('创建第一个 Nomad 集群', 'Create First Nomad Cluster')}</Button>} />
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ItemSwitcher
              label={tr('Nomad 集群', 'Nomad Cluster')}
              selectedId={selectedId}
              onSelect={setSelectedId}
              items={clusters.map((c) => ({
                id: c.id,
                name: c.name,
                status: c.init_state === 'uninitialized' ? 'uninitialized' : c.health_status,
              }))}
            />
            <SectionTabs
              tabs={[
                { id: 'status', label: tr('集群状态详情', 'Cluster Status') },
                ...(isAdmin
                  ? [{ id: 'ops', label: tr('集群运维', 'Cluster Ops'), title: tr('集群配置、版本升级、证书与 Gossip 密钥轮换、集群体检与卸载等运维操作', 'Cluster configuration, rolling upgrade, certificate & gossip rotation, cluster doctor, and uninstall operations') }]
                  : []),
                { id: 'workbench', label: tr('运行态工作台', 'Workbench'), title: tr('实时查看与管理 Nomad Clients、Servers、拓扑容量、CSI 存储、Variables 与 Evaluations', 'Inspect and manage Nomad Clients, Servers, Topology, CSI Storage, Variables, and Evaluations') },
                { id: 'snapshots', label: tr('Raft 快照', 'Raft Snapshots'), badge: snapshots.length, title: tr('保存与恢复 Nomad Server Raft 状态机中的任务、变量与 ACL 快照', 'Save and restore Nomad Server Raft state snapshots') },
                { id: 'governance', label: tr('治理 (Namespace / Pool / ACL)', 'Governance (Namespace / Pool / ACL)'), title: tr('配置多租户命名空间（Namespace）、节点资源池（Node Pool）与访问控制（ACL Policy / Role / Token）', 'Configure Namespaces, Node Pools, and ACL Policies / Roles / Tokens') },
              ]}
              active={tab}
              onChange={setTab}
            />
          </div>

          {(tab === 'status' || (tab === 'ops' && isAdmin)) && (() => {
            const opsProps = {
              product: 'nomad' as const,
              cluster,
              status,
              clusterNodes,
              isAdmin,
              deployVer,
              setDeployVer,
              upVer,
              setUpVer,
              proxyEnabled,
              drainClients,
              setDrainClients,
              onDeploy: () =>
                apiPost(`/api/v1/clusters/${selectedId}/deploy`, { version: deployVer.trim() || 'latest' })
                  .then((r) => { if (r.task?.id) openTask(r.task.id, tr('部署 Nomad', 'Deploy Nomad')); })
                  .catch((ex) => setErr(ex.message)),
              onUpgrade: () =>
                apiPost(`/api/v1/clusters/${selectedId}/upgrade`, { version: upVer.trim() || 'latest', drain_clients: drainClients, confirm: true })
                  .then((r) => { if (r.task?.id) openTask(r.task.id, tr('滚动升级 Nomad', 'Rolling Upgrade Nomad')); })
                  .catch((ex) => setErr(ex.message)),
              onRenewCerts: () =>
                apiPost(`/api/v1/clusters/${selectedId}/certs/renew`, {})
                  .then((r) => { if (r.task?.id) openTask(r.task.id, tr('续期 Nomad 证书', 'Renew Nomad Certificates')); })
                  .catch((ex) => setErr(ex.message)),
              onRotateCA: () => {
                setPwAction({
                  title: tr('确认轮换 Nomad 集群 CA', 'Rotate Nomad Cluster CA'),
                  run: async (pw) => {
                    const r = await apiPost(`/api/v1/clusters/${selectedId}/ca/rotate`, { current_password: pw });
                    if (r.task?.id) openTask(r.task.id, tr('轮换 Nomad CA', 'Rotate Nomad CA'));
                  },
                });
              },
              onRotateGossip: () => {
                setPwAction({
                  title: tr('确认轮换 Nomad Gossip 密钥', 'Rotate Nomad Gossip Key'),
                  run: async (pw) => {
                    const r = await apiPost(`/api/v1/clusters/${selectedId}/gossip/rotate`, { current_password: pw });
                    if (r.task?.id) openTask(r.task.id, tr('轮换 Gossip 密钥', 'Rotate Gossip Key'));
                  },
                });
              },
              onDoctor: () =>
                apiPost(`/api/v1/clusters/${selectedId}/doctor`, {})
                  .then((r) => toast.info(r.report?.summary || tr('Doctor 完成', 'Doctor finished')))
                  .catch((ex) => setErr(ex.message)),
              onReconcile: () =>
                apiPost(`/api/v1/clusters/${selectedId}/reconcile`, {})
                  .then((r) => { toast.success(r.report?.message || tr('已核对', 'Reconciled')); return loadOpsTab(); })
                  .catch((ex) => setErr(ex.message)),
              onRevealRootToken: handleRevealMgmtToken,
              onOpenWebUI: handleOpenWebUI,
              onUninstall: handleUninstall,
              onOpenJoin: () => { setJoinNodeId(''); setJoinAdvertiseAddr(''); setShowJoin(true); },
              onOpenLogs: (n: any) => openNodeLogs(selectedId, n.node_id, tr(`Nomad 日志: ${n.name}`, `Nomad Logs: ${n.name}`)),
              onCheckGate: (n: any) =>
                apiGet(`/api/v1/clusters/${selectedId}/gate?node_id=${n.node_id}`)
                  .then((r) => setGateView(r.gate))
                  .catch((ex) => setErr(ex.message)),
              onRestartNode: (n: any) =>
                apiPost(`/api/v1/clusters/${selectedId}/nodes/${n.node_id}/service/restart`, {})
                  .then((r) => { if (r.task?.id) openTask(r.task.id, tr(`重启节点: ${n.name}`, `Restart Node: ${n.name}`)); })
                  .catch((ex) => setErr(ex.message)),
              onRemoveNode: (n: any, force: boolean) =>
                apiPost(`/api/v1/clusters/${selectedId}/nodes/${n.node_id}/remove`, { force })
                  .then((r) => { if (r.task?.id) openTask(r.task.id, tr(`${force ? '强制移出' : '缩容'}节点: ${n.name}`, `${force ? 'Force Remove' : 'Remove'} Node: ${n.name}`)); })
                  .catch((ex) => setErr(ex.message)),
              nodeConfigs,
              onConfigureNode: (n: any) => {
                const full = memberRecords.find((m) => m.node_id === n.node_id) || {
                  ...n,
                  install_state: n.installed_version ? 'installed' : 'pending',
                  config: {},
                };
                setConfigMember(full);
                if (cluster?.init_state === 'initialized' && pools.length === 0) {
                  void apiGet(`/api/v1/nomad/${selectedId}/node-pools`)
                    .then((r) => setPools(r.node_pools || []))
                    .catch(() => {});
                }
              },
              quickActions: (
                <Link to={`/jobs?cluster_id=${encodeURIComponent(selectedId)}`} className="primary-button">
                  <FileCode2 className="h-3.5 w-3.5" />
                  <span>{tr('前往 Job 中心', 'Go to Job Center')}</span>
                </Link>
              ),
              onError: setErr,
            };
            const isNotDeployed =
              !clusterNodes.some(
                (n: any) =>
                  Boolean(n.installed_version) ||
                  (n.install_state && n.install_state !== 'pending') ||
                  n.service_status === 'active',
              ) && cluster.init_state === 'uninitialized';
            return (
              <div className="space-y-4">
                <ClusterOpsSection
                  {...opsProps}
                  section={tab === 'ops' ? 'ops' : 'status'}
                  opsSubTab={opsSubTab}
                  onOpsSubTabChange={setOpsSubTab}
                  onOpenStatusTab={() => setTab('status')}
                  onOpenConfigTab={() => setOpsSubTab('config')}
                  clusterSettingsPanel={
                    <NomadClusterSettingsPanel
                      cluster={cluster}
                      isNotDeployed={isNotDeployed}
                      onSaved={async (taskId) => {
                        if (taskId) openTask(taskId, tr(`更新集群配置: ${cluster?.name || ''}`, `Update Cluster Config: ${cluster?.name || ''}`));
                        else toast.success(tr('集群配置已保存', 'Cluster config saved'));
                        await loadOpsTab();
                      }}
                    />
                  }
                />
              </div>
            );
          })()}

          {tab === 'workbench' && (
            <NomadWorkbench
              key={selectedId}
              clusterId={selectedId}
              initialNamespace={queryNs}
              initialSubTab={querySub}
            />
          )}

          {tab === 'snapshots' && (
            <Card
              title={tr('Nomad Raft 快照', 'Nomad Raft Snapshots')}
              actions={isAdmin && <Button size="sm" variant="primary" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/snapshots`, {}).then((r) => r.task?.id && openTask(r.task.id)).catch((ex) => setErr(ex.message))}>{tr('创建快照', 'Create Snapshot')}</Button>}
            >
              {isAdmin && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!snapFile) return;
                    void apiUpload(`/api/v1/clusters/${selectedId}/snapshots/upload`, [['passphrase', snapPass]], snapFile)
                      .then(() => { setSnapPass(''); setSnapFile(null); return loadOpsTab(); })
                      .catch((ex) => setErr(ex.message));
                  }}
                  className="mb-4 flex flex-wrap items-end gap-2 border-b border-slate-200 pb-3 text-xs dark:border-slate-800"
                >
                  <SecretInput label={tr('归档口令（未加密可留空）', 'Archive Passphrase (leave blank if unencrypted)')} value={snapPass} onChangeValue={setSnapPass} />
                  <input type="file" onChange={(e) => setSnapFile(e.target.files?.[0] || null)} />
                  <Button type="submit">{tr('上传登记', 'Upload & Register')}</Button>
                </form>
              )}
              <div className="space-y-2 text-xs">
                {snapshots.map((sn) => (
                  <div key={sn.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2.5 dark:border-slate-800">
                    <div>
                      <span className="font-mono font-semibold">{sn.id}</span>
                      <span className="ml-2 text-slate-500">{sn.product_version} · {fmtBytes(sn.size_bytes)} · {fmtTime(sn.created_at, locale)}</span>
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
                              title: tr(`恢复 Nomad 快照 ${sn.id}`, `Restore Nomad Snapshot ${sn.id}`),
                              run: async (pw) => {
                                const res = await apiPost(`/api/v1/clusters/${selectedId}/snapshots/${sn.id}/restore`, { current_password: pw });
                                if (res.task?.id) openTask(res.task.id, tr('恢复 Nomad 快照', 'Restore Nomad Snapshot'));
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
                                return loadOpsTab();
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

          {tab === 'governance' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SectionTabs
                  variant="underline"
                  tabs={[
                    { id: 'tenants', label: 'Namespaces & Node Pools', badge: namespaces.length + pools.length },
                    { id: 'policies', label: 'ACL Policies', badge: policies.length },
                    { id: 'tokens', label: 'ACL Tokens & Roles', badge: tokens.length + roles.length },
                  ]}
                  active={govSubTab}
                  onChange={(next) => setGovSubTab(next as 'tenants' | 'policies' | 'tokens')}
                />
                {isAdmin && (
                  <Button size="sm" onClick={handleRevealMgmtToken}>
                    {tr('查看 Management (Root) Token', 'Reveal Management (Root) Token')}
                  </Button>
                )}
              </div>

              {govSubTab === 'tenants' && (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <Card
                    title={`Namespaces (${namespaces.length})`}
                    description={tr('多租户逻辑隔离空间，控制任务、变量与 ACL 权限边界', 'Logical multi-tenant isolation for jobs, variables, and ACL boundaries')}
                    actions={
                      isAdmin && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => setGovernanceEdit({ kind: 'namespaces', name: '', description: '', meta: {}, creating: true })}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span>{tr('新建 Namespace', 'New Namespace')}</span>
                        </Button>
                      )
                    }
                  >
                    <div className="space-y-2 text-xs">
                      {namespaces.map((ns) => (
                        <div
                          key={ns.name}
                          className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-slate-50/50 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-950/30"
                        >
                          <div className="min-w-0">
                            <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">{ns.name}</div>
                            {ns.description && <div className="mt-0.5 text-[11px] text-slate-500 truncate">{ns.description}</div>}
                          </div>
                          {isAdmin && (
                            <Button
                              size="sm"
                              onClick={() =>
                                setGovernanceEdit({
                                  kind: 'namespaces',
                                  name: ns.name,
                                  description: ns.description || '',
                                  meta: ns.meta || {},
                                  creating: false,
                                })
                              }
                            >
                              {tr('编辑', 'Edit')}
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </Card>

                  <Card
                    title={`Node Pools (${pools.length})`}
                    description={tr('按硬件规格或业务分组划分 Client 节点调度池', 'Group Client nodes by hardware profile or workload tier')}
                    actions={
                      isAdmin && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => setGovernanceEdit({ kind: 'node-pools', name: '', description: '', meta: {}, creating: true })}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span>{tr('新建 Node Pool', 'New Node Pool')}</span>
                        </Button>
                      )
                    }
                  >
                    <div className="space-y-2 text-xs">
                      {pools.map((p) => (
                        <div
                          key={p.name}
                          className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-slate-50/50 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-950/30"
                        >
                          <div className="min-w-0">
                            <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">{p.name}</div>
                            {p.description && <div className="mt-0.5 text-[11px] text-slate-500 truncate">{p.description}</div>}
                          </div>
                          {isAdmin && (
                            <Button
                              size="sm"
                              onClick={() =>
                                setGovernanceEdit({
                                  kind: 'node-pools',
                                  name: p.name,
                                  description: p.description || '',
                                  meta: p.meta || {},
                                  creating: false,
                                })
                              }
                            >
                              {tr('编辑', 'Edit')}
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </Card>
                </div>
              )}

              {govSubTab === 'policies' && (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)] items-start">
                  <Card
                    title={`ACL Policies (${policies.length})`}
                    bodyClassName="p-3"
                    actions={
                      isAdmin && (
                        <Button size="sm" onClick={() => setPolicyEdit({ name: '', rules: '' })}>
                          <Plus className="h-3.5 w-3.5" />
                          <span>{tr('新建', 'New')}</span>
                        </Button>
                      )
                    }
                  >
                    {policies.length === 0 ? (
                      <div className="py-6 text-center text-xs text-slate-400">{tr('暂无 ACL Policy', 'No ACL Policies')}</div>
                    ) : (
                      <div className="space-y-1 text-xs">
                        {policies.map((p) => {
                          const active = policyEdit.name === p.name;
                          return (
                            <button
                              key={p.name}
                              type="button"
                              onClick={() =>
                                void apiGet(`/api/v1/nomad/${selectedId}/acl/policies/${encodeURIComponent(p.name)}`)
                                  .then((r) => setPolicyEdit({ name: p.name, rules: r.policy?.rules || '' }))
                                  .catch((ex) => setErr(ex.message))
                              }
                              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left font-mono transition ${
                                active
                                  ? 'bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200'
                                  : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                              }`}
                            >
                              <span className="truncate">{p.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </Card>

                  <Card
                    title={policyEdit.name ? tr(`编辑 Policy：${policyEdit.name}`, `Edit Policy: ${policyEdit.name}`) : tr('新建 ACL Policy', 'New ACL Policy')}
                    description={tr('编写 Nomad HCL 权限规则（例如 namespace "default" { policy = "read" }）', 'Write Nomad HCL policy rules (e.g. namespace "default" { policy = "read" })')}
                  >
                    <div className="space-y-3 text-xs">
                      <Input
                        label={tr('Policy 名称', 'Policy Name')}
                        disabled={!isAdmin}
                        placeholder={tr('例如 app-readonly', 'e.g. app-readonly')}
                        value={policyEdit.name}
                        onChange={(e) => setPolicyEdit({ ...policyEdit, name: e.target.value })}
                      />
                      <CodeEditor value={policyEdit.rules} onChange={(v) => setPolicyEdit({ ...policyEdit, rules: v })} readOnly={!isAdmin} height="260px" />
                      {isAdmin && (
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                          <Button
                            variant="danger-outline"
                            disabled={!policyEdit.name.trim() || !policies.some((p) => p.name === policyEdit.name.trim())}
                            onClick={async () => {
                              const name = policyEdit.name.trim();
                              if (!name) return;
                              if (!(await askConfirm(tr(`确认删除 ACL Policy「${name}」吗？`, `Delete ACL Policy "${name}"?`), { title: tr('删除 Policy', 'Delete Policy'), confirmText: tr('确认删除', 'Delete'), danger: true }))) return;
                              void apiDelete(`/api/v1/nomad/${selectedId}/acl/policies/${encodeURIComponent(name)}`)
                                .then(() => {
                                  setPolicyEdit({ name: '', rules: '' });
                                  toast.success(tr('Policy 已删除', 'Policy deleted'));
                                  return loadGovernance();
                                })
                                .catch((ex) => setErr(ex.message));
                            }}
                          >
                            {tr('删除 Policy', 'Delete Policy')}
                          </Button>
                          <Button
                            variant="primary"
                            disabled={!policyEdit.name.trim()}
                            onClick={() =>
                              policyEdit.name.trim() &&
                              void apiPut(`/api/v1/nomad/${selectedId}/acl/policies/${encodeURIComponent(policyEdit.name.trim())}`, {
                                rules: policyEdit.rules,
                              })
                                .then(() => {
                                  toast.success(tr('Policy 已保存', 'Policy saved'));
                                  return loadGovernance();
                                })
                                .catch((ex) => setErr(ex.message))
                            }
                          >
                            {tr('保存 Policy', 'Save Policy')}
                          </Button>
                        </div>
                      )}
                    </div>
                  </Card>
                </div>
              )}

              {govSubTab === 'tokens' && (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <Card
                    title={`ACL Tokens (${tokens.length})`}
                    description={tr('签发、查看与吊销 Nomad API 访问令牌', 'Issue, reveal, and revoke Nomad API access tokens')}
                    actions={
                      isAdmin && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => setTokenModal({ name: '', policies: [] })}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span>{tr('签发 Client Token', 'Issue Client Token')}</span>
                        </Button>
                      )
                    }
                  >
                    {tokens.length === 0 ? (
                      <EmptyState title={tr('暂无 ACL Token', 'No ACL Tokens')} />
                    ) : (
                      <div className="space-y-2 text-xs">
                        {tokens.map((tk) => (
                          <div
                            key={tk.accessor_id}
                            className="flex items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-slate-50/50 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-950/30"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-slate-900 dark:text-slate-100 truncate">{tk.name || 'unnamed'}</span>
                                {tk.type && <Badge tone={tk.type === 'management' ? 'amber' : 'neutral'}>{tk.type}</Badge>}
                              </div>
                              <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                                Accessor: {(tk.accessor_id || '').slice(0, 12)}
                                {Array.isArray(tk.policies) && tk.policies.length > 0 ? ` · ${tk.policies.join(', ')}` : ''}
                                {Array.isArray(tk.roles) && tk.roles.length > 0 ? ` · Roles: ${tk.roles.join(', ')}` : ''}
                              </div>
                            </div>
                            {isAdmin && (
                              <div className="flex shrink-0 items-center gap-1.5">
                                <Button
                                  size="sm"
                                  onClick={() => handleRevealAclToken(tk)}
                                >
                                  <KeyRound className="h-3.5 w-3.5" />
                                  <span>{tr('查看 Secret', 'Reveal Secret')}</span>
                                </Button>
                                <Button
                                  size="sm"
                                  variant="danger-outline"
                                  onClick={async () => {
                                    if (!(await askConfirm(tr(`确认吊销 ACL Token「${tk.name}」吗？`, `Revoke ACL Token "${tk.name}"?`), { title: tr('吊销 Token', 'Revoke Token'), confirmText: tr('确认吊销', 'Revoke'), danger: true }))) return;
                                    void apiDelete(`/api/v1/nomad/${selectedId}/acl/tokens/${tk.accessor_id}`)
                                      .then(() => {
                                        setRevealedToken((prev) => (prev?.accessor_id === tk.accessor_id ? null : prev));
                                        toast.success(tr('Token 已吊销', 'Token revoked'));
                                        return loadGovernance();
                                      })
                                      .catch((ex) => setErr(ex.message));
                                  }}
                                >
                                  {tr('吊销', 'Revoke')}
                                </Button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>

                  <Card
                    title={`ACL Roles (${roles.length})`}
                    description={tr('将多个 ACL Policy 聚合为可复用角色', 'Bundle multiple ACL Policies into reusable roles')}
                    actions={
                      isAdmin && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => setRoleEdit({ id: '', name: '', description: '', policies: [] })}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span>{tr('新建 ACL Role', 'New ACL Role')}</span>
                        </Button>
                      )
                    }
                  >
                    {roles.length === 0 ? (
                      <EmptyState title={tr('暂无 ACL Role', 'No ACL Roles')} description={tr('可创建 Role 绑定一组 Policy，便于向团队或自动化工具统一授权。', 'Create roles that bind a set of policies for streamlined team or automation access.')} />
                    ) : (
                      <div className="space-y-2 text-xs">
                        {roles.map((role) => (
                          <div
                            key={role.id}
                            className="flex items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-slate-50/50 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-950/30"
                          >
                            <div className="min-w-0">
                              <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">{role.name}</div>
                              <div className="mt-1 flex flex-wrap gap-1">
                                {(role.policies || []).length > 0 ? (
                                  role.policies.map((p: string) => <Badge key={p} tone="blue">{p}</Badge>)
                                ) : (
                                  <span className="text-[11px] text-slate-400">{tr('未关联 Policy', 'No linked policies')}</span>
                                )}
                              </div>
                            </div>
                            {isAdmin && (
                              <Button
                                size="sm"
                                onClick={() =>
                                  setRoleEdit({
                                    id: role.id,
                                    name: role.name,
                                    description: role.description || '',
                                    policies: role.policies || [],
                                  })
                                }
                              >
                                {tr('编辑', 'Edit')}
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <Modal open={Boolean(governanceEdit)} title={governanceEdit?.kind === 'namespaces' ? tr('管理 Namespace', 'Manage Namespace') : tr('管理 Node Pool', 'Manage Node Pool')} onClose={() => setGovernanceEdit(null)}>
        {governanceEdit && (
          <form className="space-y-3" onSubmit={(e) => {
            e.preventDefault();
            const base = `/api/v1/nomad/${selectedId}/${governanceEdit.kind}`;
            const body = { name: governanceEdit.name, description: governanceEdit.description, meta: governanceEdit.meta };
            const request = governanceEdit.creating ? apiPost(base, body) : apiPut(`${base}/${encodeURIComponent(governanceEdit.name)}`, body);
            void request.then(() => { setGovernanceEdit(null); return loadGovernance(); }).catch((ex) => setErr(ex.message));
          }}>
            <ErrorAlert message={err} onClose={() => setErr('')} />
            <Input label={tr('名称', 'Name')} required disabled={!governanceEdit.creating} value={governanceEdit.name} onChange={(e) => setGovernanceEdit({ ...governanceEdit, name: e.target.value })} />
            <Input label={tr('描述', 'Description')} value={governanceEdit.description} onChange={(e) => setGovernanceEdit({ ...governanceEdit, description: e.target.value })} />
            <div className="flex justify-end gap-2">
              {!governanceEdit.creating && <Button type="button" variant="danger" disabled={governanceEdit.name === 'default' || (governanceEdit.kind === 'node-pools' && governanceEdit.name === 'all')} onClick={() => void apiDelete(`/api/v1/nomad/${selectedId}/${governanceEdit.kind}/${encodeURIComponent(governanceEdit.name)}`).then(() => { setGovernanceEdit(null); return loadGovernance(); }).catch((ex) => setErr(ex.message))}>{tr('删除对象', 'Delete')}</Button>}
              <Button type="submit" variant="primary">{tr('保存对象', 'Save')}</Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={Boolean(tokenModal)} title={tr('签发 Nomad Client Token', 'Issue Nomad Client Token')} onClose={() => setTokenModal(null)}>
        {tokenModal && (
          <form
            className="space-y-3 text-xs"
            onSubmit={(e) => {
              e.preventDefault();
              if (!tokenModal.name.trim()) return;
              void apiPost(`/api/v1/nomad/${selectedId}/acl/tokens`, {
                name: tokenModal.name.trim(),
                policies: tokenModal.policies,
              })
                .then((r) => {
                  setTokenModal(null);
                  const issued = r.token;
                  if (issued?.secret_id) {
                    setRevealedToken({
                      accessor_id: issued.accessor_id || '',
                      name: issued.name || tokenModal.name.trim(),
                      type: issued.type || 'client',
                      policies: issued.policies || tokenModal.policies,
                      roles: issued.roles || [],
                      expiration_time: issued.expiration_time,
                      secret_id: issued.secret_id,
                      newlyIssued: true,
                    });
                  }
                  toast.success(tr('已签发 Client Token', 'Client Token issued'));
                  return loadGovernance();
                })
                .catch((ex) => setErr(ex.message));
            }}
          >
            <Input
              label={tr('Token 名称', 'Token Name')}
              required
              placeholder={tr('例如 ci-deployer', 'e.g. ci-deployer')}
              value={tokenModal.name}
              onChange={(e) => setTokenModal({ ...tokenModal, name: e.target.value })}
            />
            <div className="space-y-1.5">
              <div className="font-medium text-slate-700 dark:text-slate-300">{tr('关联 Policies', 'Linked Policies')}</div>
              {policies.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 p-2.5 text-slate-400 dark:border-slate-700">
                  {tr('暂无可选 Policy，可先在「ACL Policies」页签创建后再关联。', 'No policies available yet. Create one under the "ACL Policies" tab first.')}
                </div>
              ) : (
                <div className="space-y-1 max-h-40 overflow-auto rounded-lg border border-slate-200 p-2.5 dark:border-slate-700">
                  {policies.map((p) => (
                    <label key={p.name} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={tokenModal.policies.includes(p.name)}
                        onChange={(e) =>
                          setTokenModal({
                            ...tokenModal,
                            policies: e.target.checked
                              ? [...tokenModal.policies, p.name]
                              : tokenModal.policies.filter((name) => name !== p.name),
                          })
                        }
                      />
                      <span className="font-mono">{p.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" onClick={() => setTokenModal(null)}>
                {tr('取消', 'Cancel')}
              </Button>
              <Button type="submit" variant="primary" disabled={!tokenModal.name.trim()}>
                {tr('确认签发', 'Issue')}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={Boolean(roleEdit)} title={tr('管理 ACL Role', 'Manage ACL Role')} onClose={() => setRoleEdit(null)}>
        {roleEdit && (
          <form className="space-y-3" onSubmit={(e) => {
            e.preventDefault();
            const base = `/api/v1/nomad/${selectedId}/acl/roles`;
            const body = { name: roleEdit.name, description: roleEdit.description, policies: roleEdit.policies };
            const request = roleEdit.id ? apiPut(`${base}/${encodeURIComponent(roleEdit.id)}`, body) : apiPost(base, body);
            void request.then(() => { setRoleEdit(null); return loadGovernance(); }).catch((ex) => setErr(ex.message));
          }}>
            <ErrorAlert message={err} onClose={() => setErr('')} />
            <Input label={tr('Role 名称', 'Role Name')} required value={roleEdit.name} onChange={(e) => setRoleEdit({ ...roleEdit, name: e.target.value })} />
            <Input label={tr('描述', 'Description')} value={roleEdit.description} onChange={(e) => setRoleEdit({ ...roleEdit, description: e.target.value })} />
            <div className="space-y-1 text-xs">
              <div>{tr('关联 Policies', 'Linked Policies')}</div>
              {policies.map((p) => <label key={p.name} className="flex items-center gap-2"><input type="checkbox" checked={roleEdit.policies.includes(p.name)} onChange={(e) => setRoleEdit({ ...roleEdit, policies: e.target.checked ? [...roleEdit.policies, p.name] : roleEdit.policies.filter((name) => name !== p.name) })} />{p.name}</label>)}
            </div>
            <div className="flex justify-end gap-2">
              {roleEdit.id && <Button type="button" variant="danger" onClick={() => void apiDelete(`/api/v1/nomad/${selectedId}/acl/roles/${encodeURIComponent(roleEdit.id)}`).then(() => { setRoleEdit(null); return loadGovernance(); }).catch((ex) => setErr(ex.message))}>{tr('删除 Role', 'Delete Role')}</Button>}
              <Button type="submit" variant="primary">{tr('保存 Role', 'Save Role')}</Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={showJoin} title={tr('扩容 Nomad 节点', 'Add Nomad Node')} onClose={() => setShowJoin(false)}>
        <form
          className="space-y-3 text-xs"
          onSubmit={async (e) => {
            e.preventDefault();
            setJoinBusy(true);
            try {
              const r = await apiPost(`/api/v1/clusters/${selectedId}/nodes/${joinNodeId}/join`, {
                role: joinRole,
                advertise_addr: joinAdvertiseAddr.trim() || undefined,
              });
              setShowJoin(false);
              if (r.task?.id) openTask(r.task.id, tr('扩容 Nomad 节点', 'Add Nomad Node'));
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
          <Select label={tr('节点角色', 'Node Role')} value={joinRole} onChange={(e) => setJoinRole(e.target.value)}>
            <option value="server_client">server_client</option>
            <option value="server">server</option>
            <option value="client">client</option>
          </Select>
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
            <span>{tr('下载网络：', 'Download Network: ')}{proxyEnabled ? tr('通过系统代理', 'Via system proxy') : tr('直连', 'Direct')}</span>
            <Link to="/settings?tab=proxy" className="text-indigo-600 dark:text-indigo-400 hover:underline">{tr('前往下载代理设置', 'Configure download proxy')}</Link>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setShowJoin(false)}>{tr('取消', 'Cancel')}</Button>
            <Button type="submit" variant="primary" loading={joinBusy}>{tr('确认扩容', 'Join Node')}</Button>
          </div>
        </form>
      </Modal>

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

      <ClusterCreateModal
        open={showCreate}
        product="nomad"
        nodes={nodes}
        onClose={() => setShowCreate(false)}
        onCreated={async (id) => {
          await loadList();
          setSelectedId(id);
          setTab('status');
          toast.success(tr('集群配置已创建，请继续部署服务', 'Cluster config created. Continue to deploy.'));
        }}
      />

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
        title={tr(`快捷登录UI · Nomad${uiLoginModal?.targetLabel ? ` · ${uiLoginModal.targetLabel}` : ''}`, `Quick UI Login · Nomad${uiLoginModal?.targetLabel ? ` · ${uiLoginModal.targetLabel}` : ''}`)}
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
                <span>{tr('快捷登录UI', 'Quick UI Login')}</span>
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
                  <>已生成<strong>单次一次性票据链接（OTT）</strong>（约 {Math.max(1, Math.round(uiLoginModal.ottTTL / 60))} 分钟内有效，兑换一次即作废）。</>,
                  <>A <strong>One-Time Ticket (OTT)</strong> link has been generated (valid for ~{Math.max(1, Math.round(uiLoginModal.ottTTL / 60))} min, single use).</>,
                )}
              </p>
              <p className="mt-1">
                {tr(
                  <>打开后 Nomad UI 会自动兑换临时会话并清掉地址栏里的票据，会话有效期为 <strong>{uiLoginModal.tokenTTL}</strong>，到期自动失效。</>,
                  <>Nomad UI automatically exchanges it for a temporary session (TTL: <strong>{uiLoginModal.tokenTTL}</strong>) and clears the ticket from the URL bar.</>,
                )}
              </p>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {tr('提示：如果节点使用自签名 TLS 证书，浏览器首次打开提示“证书风险”时点击“继续访问”后，页面仍会自动完成登录。', 'Tip: If the node uses a self-signed TLS certificate, click Proceed on the browser warning page and SSO login will complete automatically.')}
            </p>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(mgmtToken)}
        title="Nomad Management (Root) Token"
        onClose={() => setMgmtToken('')}
        footer={
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setMgmtToken('')}>{tr('关闭', 'Close')}</Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-xs leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            {tr('这是 Nomad 集群的最高权限管理密钥（Root Token），可用于登录 Nomad 原生 Web UI 或通过 CLI 管理集群。关闭弹窗后将清除页面内存中的明文，下次查看需重新验证密码。', 'This is the highest-privilege Root Token for this Nomad cluster. Closing this modal clears the plaintext from memory; next reveal requires password verification again.')}
          </div>
          <MaskedSecret value={mgmtToken} label="Management (Root) Token:" />
        </div>
      </Modal>

      <Modal
        open={Boolean(revealedToken)}
        title={
          revealedToken?.newlyIssued
            ? tr('新签发 ACL Token Secret', 'Newly Issued ACL Token Secret')
            : tr('ACL Token Secret', 'ACL Token Secret')
        }
        onClose={() => setRevealedToken(null)}
        footer={
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setRevealedToken(null)}>{tr('关闭', 'Close')}</Button>
          </div>
        }
      >
        {revealedToken && (
          <div className="space-y-4">
            <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 px-4 py-3 text-xs leading-relaxed text-indigo-950 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-100">
              {revealedToken.newlyIssued
                ? tr(
                    '关闭弹窗后将清除页面内存中的明文；后续可随时在 ACL Tokens 列表中点击「查看 Secret」，验证管理员密码后再次查看。',
                    'Closing this modal clears the plaintext from memory. You can reveal it again anytime from the ACL Tokens list after verifying your password.',
                  )
                : tr(
                    '关闭弹窗后将清除页面内存中的明文，下次查看需重新验证管理员密码。',
                    'Closing this modal clears the plaintext from memory; next reveal requires password verification again.',
                  )}
            </div>
            <div className="grid grid-cols-1 gap-2 rounded-xl border border-slate-200/80 bg-slate-50/70 px-3.5 py-2.5 text-xs dark:border-slate-800 dark:bg-slate-950/40 sm:grid-cols-2">
              <div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">{tr('名称', 'Name')}</div>
                <div className="mt-0.5 flex items-center gap-1.5 font-semibold text-slate-900 dark:text-slate-100">
                  <span className="truncate">{revealedToken.name || 'unnamed'}</span>
                  {revealedToken.type && <Badge tone={revealedToken.type === 'management' ? 'amber' : 'neutral'}>{revealedToken.type}</Badge>}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">Accessor ID</div>
                <div className="mt-0.5 font-mono text-[11px] text-slate-700 dark:text-slate-300 break-all">{revealedToken.accessor_id}</div>
              </div>
              {Array.isArray(revealedToken.policies) && revealedToken.policies.length > 0 && (
                <div className="sm:col-span-2">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">Policies</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {revealedToken.policies.map((p) => <Badge key={p} tone="blue">{p}</Badge>)}
                  </div>
                </div>
              )}
              {Array.isArray(revealedToken.roles) && revealedToken.roles.length > 0 && (
                <div className="sm:col-span-2">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">Roles</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {revealedToken.roles.map((r) => <Badge key={r} tone="neutral">{r}</Badge>)}
                  </div>
                </div>
              )}
              {revealedToken.expiration_time && (
                <div className="sm:col-span-2">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{tr('过期时间', 'Expires At')}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-700 dark:text-slate-300">{fmtTime(revealedToken.expiration_time)}</div>
                </div>
              )}
            </div>
            <MaskedSecret value={revealedToken.secret_id} label={tr('ACL Token Secret：', 'ACL Token Secret:')} />
          </div>
        )}
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
              setDlErr(ex?.message || tr('操作失败', 'Operation failed'));
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
          if (taskId) openTask(taskId, tr(`卸载 Nomad: ${cluster?.name || ''}`, `Uninstall Nomad: ${cluster?.name || ''}`));
          void loadList();
        }}
      />

      <NomadNodeConfigModal
        open={Boolean(configMember)}
        cluster={cluster || null}
        member={configMember}
        nodePools={pools.map((p) => p.name)}
        onClose={() => setConfigMember(null)}
        onSubmitted={async (taskId, title) => {
          if (taskId) openTask(taskId, title || tr('更新节点配置', 'Update Node Config'));
          else toast.success(tr('节点配置已保存（将在部署时生效）', 'Node config saved (takes effect on deploy)'));
          await loadOpsTab();
        }}
      />
    </div>
  );
}
