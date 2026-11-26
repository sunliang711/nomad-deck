import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Boxes, ExternalLink, FileCode2, Plus, RefreshCw } from 'lucide-react';
import { apiDelete, apiDownload, apiGet, apiPost, apiPut, apiUpload, fmtBytes, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  NOMAD_CLUSTER_KEY,
  readStoredSelection,
  resolveClusterSelection,
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
import { NomadClusterSettingsModal, NomadNodeConfigModal } from '../components/NomadConfigModals';

export function NomadPage() {
  const { isAdmin } = useAuth();
  const { openTask, openNodeLogs, tasks } = useOpsDrawer();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryId = searchParams.get('id') || '';
  const queryTab = searchParams.get('tab') || '';
  const queryNs = searchParams.get('ns') || '';
  const queryJob = searchParams.get('job') || '';
  const querySub = searchParams.get('sub') || '';
  const [clusters, setClusters] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState(() => queryId || readStoredSelection(NOMAD_CLUSTER_KEY));
  const [loadingList, setLoadingList] = useState(true);
  const selectionRef = useRef(selectedId);
  selectionRef.current = selectedId;
  const [tab, setTab] = useState(queryTab === 'workbench' ? 'workbench' : 'status');

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

  useEffect(() => {
    if (queryTab === 'workbench' || queryTab === 'status' || queryTab === 'snapshots' || queryTab === 'governance') {
      setTab(queryTab);
    }
  }, [queryTab]);
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
  const [newToken, setNewToken] = useState('');
  const [mgmtToken, setMgmtToken] = useState('');
  const [uiLoginModal, setUiLoginModal] = useState<{ url: string; targetLabel: string; ottTTL: number; tokenTTL: string } | null>(null);
  const [uninstallPlan, setUninstallPlan] = useState<UninstallPlan | null>(null);
  const [err, setErr] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [memberRecords, setMemberRecords] = useState<any[]>([]);
  const [showClusterSettings, setShowClusterSettings] = useState(false);
  const [configMember, setConfigMember] = useState<any>(null);
  const [deployVer, setDeployVer] = useState('latest');
  const [upVer, setUpVer] = useState('');
  const [showJoin, setShowJoin] = useState(false);
  const [joinNodeId, setJoinNodeId] = useState('');
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
      setErr(ex?.message || '加载 Nomad 集群列表失败');
    } finally {
      setLoadingList(false);
    }
  }, [queryId]);

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
      setErr(ex?.message || '加载 Nomad 状态失败');
    }
  }, [selectedId]);

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
      setErr(ex?.message || '加载治理信息失败');
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
    setShowClusterSettings(false);
    setConfigMember(null);
    setUiLoginModal(null);
  }, [selectedId]);

  const cluster = clusters.find((c) => c.id === selectedId);

  useEffect(() => {
    setGateView(null);
    setMgmtToken('');
    setUninstallPlan(null);
    if (selectedId && (tab === 'status' || tab === 'snapshots')) void loadOpsTab();
    if (selectedId && tab === 'governance') void loadGovernance();
    if (!selectedId || tab !== 'status') return;
    const t = setInterval(() => void loadOpsTab(), 30000);
    return () => clearInterval(t);
  }, [selectedId, tab, loadOpsTab]);

  const handleRevealMgmtToken = () => {
    setPwAction({
      title: '查看 Nomad Management (Root) Token',
      run: async (pw) => {
        const res = await apiPost(`/api/v1/nomad/${selectedId}/management-token/reveal`, { current_password: pw });
        setMgmtToken(res.management_token || '');
      },
    });
  };

  const handleOpenWebUI = (targetUrl: string, label?: string) => {
    setPwAction({
      title: `免密登录 Nomad Web UI${label ? ` · ${label}` : ''}`,
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

  const clusterNodes = status?.nodes || [];
  const nodeConfigs = Object.fromEntries(memberRecords.map((m) => [m.node_id, m.config]));


  if (loadingList) return <LoadingState label="正在加载 Nomad 集群…" />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Nomad 集群"
        subtitle="管理 Nomad Server/Client 编排、运行态工作台、Raft 快照与 ACL 多租户治理"
        actions={
          <>
            <Button onClick={() => { void loadList(); if (tab === 'status' || tab === 'snapshots') void loadOpsTab(); if (tab === 'governance') void loadGovernance(); }}>
              <RefreshCw className="h-4 w-4" />
              <span>刷新</span>
            </Button>
            {isAdmin && (
              <Button variant="primary" onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4" />
                <span>新建 Nomad 集群</span>
              </Button>
            )}
          </>
        }
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />
      {newToken && <MaskedSecret value={newToken} label="新签发 ACL Token Secret（仅展示一次）：" />}

      {!cluster ? (
        <Card>
          <EmptyState icon={<Boxes className="w-6 h-6" />} title="暂无 Nomad 集群" description="Nomad 负责调度与运行工作负载。先接入主机，再选择节点、创建配置并部署服务。" action={isAdmin && <Button variant="primary" onClick={() => setShowCreate(true)}>创建第一个 Nomad 集群</Button>} />
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ItemSwitcher
              label="Nomad 集群"
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
                { id: 'status', label: '集群状态详情' },
                { id: 'workbench', label: '运行态工作台', title: '实时查看与管理 Nomad Clients、Servers、Allocations、Deployments、CSI 存储与 Variables' },
                { id: 'snapshots', label: 'Raft 快照', badge: snapshots.length, title: '保存与恢复 Nomad Server Raft 状态机中的任务、变量与 ACL 快照' },
                { id: 'governance', label: '治理 (Namespace / Pool / ACL)', title: '配置多租户命名空间（Namespace）、节点资源池（Node Pool）与访问控制（ACL Policy / Role / Token）' },
              ]}
              active={tab}
              onChange={setTab}
            />
          </div>

          {tab === 'status' && (
            <div className="space-y-4">
              <ClusterOpsSection
                product="nomad"
                cluster={cluster}
                status={status}
                clusterNodes={clusterNodes}
                isAdmin={isAdmin}
                deployVer={deployVer}
                setDeployVer={setDeployVer}
                upVer={upVer}
                setUpVer={setUpVer}
                proxyEnabled={proxyEnabled}
                drainClients={drainClients}
                setDrainClients={setDrainClients}
                onDeploy={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/deploy`, { version: deployVer.trim() || 'latest' })
                    .then((r) => { if (r.task?.id) openTask(r.task.id, '部署 Nomad'); })
                    .catch((ex) => setErr(ex.message))
                }
                onUpgrade={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/upgrade`, { version: upVer.trim() || 'latest', drain_clients: drainClients, confirm: true })
                    .then((r) => { if (r.task?.id) openTask(r.task.id, '滚动升级 Nomad'); })
                    .catch((ex) => setErr(ex.message))
                }
                onRenewCerts={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/certs/renew`, {})
                    .then((r) => { if (r.task?.id) openTask(r.task.id, '续期 Nomad 证书'); })
                    .catch((ex) => setErr(ex.message))
                }
                onRotateCA={() => {
                  setPwAction({
                    title: '确认轮换 Nomad 集群 CA',
                    run: async (pw) => {
                      const r = await apiPost(`/api/v1/clusters/${selectedId}/ca/rotate`, { current_password: pw });
                      if (r.task?.id) openTask(r.task.id, '轮换 Nomad CA');
                    },
                  });
                }}
                onRotateGossip={() => {
                  setPwAction({
                    title: '确认轮换 Nomad Gossip 密钥',
                    run: async (pw) => {
                      const r = await apiPost(`/api/v1/clusters/${selectedId}/gossip/rotate`, { current_password: pw });
                      if (r.task?.id) openTask(r.task.id, '轮换 Gossip 密钥');
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
                    .then((r) => { toast.success(r.report?.message || '已核对'); return loadOpsTab(); })
                    .catch((ex) => setErr(ex.message))
                }
                onRevealRootToken={handleRevealMgmtToken}
                onOpenWebUI={handleOpenWebUI}
                onUninstall={handleUninstall}
                onOpenJoin={() => { setJoinNodeId(''); setShowJoin(true); }}
                onOpenLogs={(n) => openNodeLogs(selectedId, n.node_id, `Nomad 日志: ${n.name}`)}
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
                nodeConfigs={nodeConfigs}
                onOpenClusterSettings={() => setShowClusterSettings(true)}
                onConfigureNode={(n) => {
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
                }}
                quickActions={
                  <Link to={`/jobs?cluster_id=${encodeURIComponent(selectedId)}`} className="primary-button">
                    <FileCode2 className="h-3.5 w-3.5" />
                    <span>前往 Job 中心</span>
                  </Link>
                }
                onError={setErr}
              />
            </div>
          )}

          {tab === 'workbench' && (
            <NomadWorkbench
              key={selectedId}
              clusterId={selectedId}
              initialNamespace={queryNs}
              initialJobId={queryJob}
              initialSubTab={querySub}
              onClearDeepLink={() => {
                if (!queryNs && !queryJob && !querySub) return;
                const next = new URLSearchParams(searchParams);
                next.delete('ns');
                next.delete('job');
                next.delete('sub');
                setSearchParams(next, { replace: true });
              }}
            />
          )}

          {tab === 'snapshots' && (
            <Card
              title="Nomad Raft 快照"
              actions={isAdmin && <Button size="sm" variant="primary" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/snapshots`, {}).then((r) => r.task?.id && openTask(r.task.id)).catch((ex) => setErr(ex.message))}>创建快照</Button>}
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
                  <SecretInput label="归档口令（未加密可留空）" value={snapPass} onChangeValue={setSnapPass} />
                  <input type="file" onChange={(e) => setSnapFile(e.target.files?.[0] || null)} />
                  <Button type="submit">上传登记</Button>
                </form>
              )}
              <div className="space-y-2 text-xs">
                {snapshots.map((sn) => (
                  <div key={sn.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2.5 dark:border-slate-800">
                    <div>
                      <span className="font-mono font-semibold">{sn.id}</span>
                      <span className="ml-2 text-slate-500">{sn.product_version} · {fmtBytes(sn.size_bytes)} · {fmtTime(sn.created_at)}</span>
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
                              title: `恢复 Nomad 快照 ${sn.id}`,
                              run: async (pw) => {
                                const res = await apiPost(`/api/v1/clusters/${selectedId}/snapshots/${sn.id}/restore`, { current_password: pw });
                                if (res.task?.id) openTask(res.task.id, '恢复 Nomad 快照');
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
                                return loadOpsTab();
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

          {tab === 'governance' && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <Card title="Namespaces & Node Pools">
                <div className="space-y-3 text-xs">
                  <div className="font-semibold">Namespaces ({namespaces.length})</div>
                  <div className="flex flex-wrap gap-1.5">
                    {namespaces.map((ns) => isAdmin ? <Button key={ns.name} size="sm" onClick={() => setGovernanceEdit({ kind: 'namespaces', name: ns.name, description: ns.description || '', meta: ns.meta || {}, creating: false })}>{ns.name}</Button> : <Badge key={ns.name}>{ns.name}</Badge>)}
                    {isAdmin && <Button size="sm" onClick={() => setGovernanceEdit({ kind: 'namespaces', name: '', description: '', meta: {}, creating: true })}>新建 Namespace</Button>}
                  </div>
                  <div className="font-semibold pt-2">Node Pools ({pools.length})</div>
                  <div className="flex flex-wrap gap-1.5">
                    {pools.map((p) => isAdmin ? <Button key={p.name} size="sm" onClick={() => setGovernanceEdit({ kind: 'node-pools', name: p.name, description: p.description || '', meta: p.meta || {}, creating: false })}>{p.name}</Button> : <Badge key={p.name}>{p.name}</Badge>)}
                    {isAdmin && <Button size="sm" onClick={() => setGovernanceEdit({ kind: 'node-pools', name: '', description: '', meta: {}, creating: true })}>新建 Node Pool</Button>}
                  </div>
                </div>
              </Card>

              <Card title="ACL Policies & Tokens">
                <div className="space-y-3 text-xs">
                  <div className="flex flex-wrap gap-1.5">
                    {policies.map((p) => (
                      <Button key={p.name} size="sm" onClick={() => void apiGet(`/api/v1/nomad/${selectedId}/acl/policies/${encodeURIComponent(p.name)}`).then((r) => setPolicyEdit({ name: p.name, rules: r.policy?.rules || '' })).catch((ex) => setErr(ex.message))}>
                        {p.name}
                      </Button>
                    ))}
                  </div>
                  <Input label="Policy 名称" value={policyEdit.name} onChange={(e) => setPolicyEdit({ ...policyEdit, name: e.target.value })} />
                  <CodeEditor value={policyEdit.rules} onChange={(v) => setPolicyEdit({ ...policyEdit, rules: v })} readOnly={!isAdmin} height="160px" />
                  {isAdmin && (
                    <div className="flex flex-wrap gap-2">
                      <Button variant="primary" onClick={() => policyEdit.name && void apiPut(`/api/v1/nomad/${selectedId}/acl/policies/${encodeURIComponent(policyEdit.name)}`, { rules: policyEdit.rules }).then(() => { toast.success('Policy 已保存'); return loadGovernance(); }).catch((ex) => setErr(ex.message))}>保存 Policy</Button>
                      <Button
                        variant="danger-outline"
                        disabled={!policyEdit.name}
                        onClick={async () => {
                          if (!policyEdit.name) return;
                          if (!(await askConfirm(`确认删除 ACL Policy「${policyEdit.name}」吗？`, { title: '删除 Policy', confirmText: '确认删除', danger: true }))) return;
                          void apiDelete(`/api/v1/nomad/${selectedId}/acl/policies/${encodeURIComponent(policyEdit.name)}`)
                            .then(() => {
                              setPolicyEdit({ name: '', rules: '' });
                              toast.success('Policy 已删除');
                              return loadGovernance();
                            })
                            .catch((ex) => setErr(ex.message));
                        }}
                      >
                        删除 Policy
                      </Button>
                      <Button onClick={() => void apiPost(`/api/v1/nomad/${selectedId}/acl/tokens`, { name: 'ops-token', policies: policyEdit.name ? [policyEdit.name] : [] }).then((r) => { setNewToken(r.token?.secret_id || ''); toast.success('已签发 Client Token'); return loadGovernance(); }).catch((ex) => setErr(ex.message))}>签发 Client Token</Button>
                      <Button onClick={handleRevealMgmtToken}>查看 Management (Root) Token</Button>
                    </div>
                  )}
                  <div className="border-t border-slate-200 pt-2 dark:border-slate-800">
                    <div className="mb-1 font-semibold">ACL Tokens ({tokens.length})</div>
                    {tokens.slice(0, 10).map((tk) => (
                      <div key={tk.accessor_id} className="flex items-center justify-between py-1">
                        <span className="font-mono">{tk.name} ({(tk.accessor_id || '').slice(0, 8)})</span>
                        {isAdmin && (
                          <Button
                            size="sm"
                            variant="danger-outline"
                            onClick={async () => {
                              if (!(await askConfirm(`确认吊销 ACL Token「${tk.name}」吗？`, { title: '吊销 Token', confirmText: '确认吊销', danger: true }))) return;
                              void apiDelete(`/api/v1/nomad/${selectedId}/acl/tokens/${tk.accessor_id}`)
                                .then(() => {
                                  toast.success('Token 已吊销');
                                  return loadGovernance();
                                })
                                .catch((ex) => setErr(ex.message));
                            }}
                          >
                            吊销
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-slate-200 pt-2 dark:border-slate-800">
                    <div className="mb-1 font-semibold">ACL Roles ({roles.length})</div>
                    <div className="flex flex-wrap gap-1.5">
                      {roles.map((role) => isAdmin ? <Button key={role.id} size="sm" onClick={() => setRoleEdit({ id: role.id, name: role.name, description: role.description || '', policies: role.policies || [] })}>{role.name}</Button> : <Badge key={role.id}>{role.name}</Badge>)}
                      {isAdmin && <Button size="sm" onClick={() => setRoleEdit({ id: '', name: '', description: '', policies: [] })}>新建 ACL Role</Button>}
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </div>
      )}

      <Modal open={Boolean(governanceEdit)} title={governanceEdit?.kind === 'namespaces' ? '管理 Namespace' : '管理 Node Pool'} onClose={() => setGovernanceEdit(null)}>
        {governanceEdit && (
          <form className="space-y-3" onSubmit={(e) => {
            e.preventDefault();
            const base = `/api/v1/nomad/${selectedId}/${governanceEdit.kind}`;
            const body = { name: governanceEdit.name, description: governanceEdit.description, meta: governanceEdit.meta };
            const request = governanceEdit.creating ? apiPost(base, body) : apiPut(`${base}/${encodeURIComponent(governanceEdit.name)}`, body);
            void request.then(() => { setGovernanceEdit(null); return loadGovernance(); }).catch((ex) => setErr(ex.message));
          }}>
            <ErrorAlert message={err} onClose={() => setErr('')} />
            <Input label="名称" required disabled={!governanceEdit.creating} value={governanceEdit.name} onChange={(e) => setGovernanceEdit({ ...governanceEdit, name: e.target.value })} />
            <Input label="描述" value={governanceEdit.description} onChange={(e) => setGovernanceEdit({ ...governanceEdit, description: e.target.value })} />
            <div className="flex justify-end gap-2">
              {!governanceEdit.creating && <Button type="button" variant="danger" disabled={governanceEdit.name === 'default' || (governanceEdit.kind === 'node-pools' && governanceEdit.name === 'all')} onClick={() => void apiDelete(`/api/v1/nomad/${selectedId}/${governanceEdit.kind}/${encodeURIComponent(governanceEdit.name)}`).then(() => { setGovernanceEdit(null); return loadGovernance(); }).catch((ex) => setErr(ex.message))}>删除对象</Button>}
              <Button type="submit" variant="primary">保存对象</Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={Boolean(roleEdit)} title="管理 ACL Role" onClose={() => setRoleEdit(null)}>
        {roleEdit && (
          <form className="space-y-3" onSubmit={(e) => {
            e.preventDefault();
            const base = `/api/v1/nomad/${selectedId}/acl/roles`;
            const body = { name: roleEdit.name, description: roleEdit.description, policies: roleEdit.policies };
            const request = roleEdit.id ? apiPut(`${base}/${encodeURIComponent(roleEdit.id)}`, body) : apiPost(base, body);
            void request.then(() => { setRoleEdit(null); return loadGovernance(); }).catch((ex) => setErr(ex.message));
          }}>
            <ErrorAlert message={err} onClose={() => setErr('')} />
            <Input label="Role 名称" required value={roleEdit.name} onChange={(e) => setRoleEdit({ ...roleEdit, name: e.target.value })} />
            <Input label="描述" value={roleEdit.description} onChange={(e) => setRoleEdit({ ...roleEdit, description: e.target.value })} />
            <div className="space-y-1 text-xs">
              <div>关联 Policies</div>
              {policies.map((p) => <label key={p.name} className="flex items-center gap-2"><input type="checkbox" checked={roleEdit.policies.includes(p.name)} onChange={(e) => setRoleEdit({ ...roleEdit, policies: e.target.checked ? [...roleEdit.policies, p.name] : roleEdit.policies.filter((name) => name !== p.name) })} />{p.name}</label>)}
            </div>
            <div className="flex justify-end gap-2">
              {roleEdit.id && <Button type="button" variant="danger" onClick={() => void apiDelete(`/api/v1/nomad/${selectedId}/acl/roles/${encodeURIComponent(roleEdit.id)}`).then(() => { setRoleEdit(null); return loadGovernance(); }).catch((ex) => setErr(ex.message))}>删除 Role</Button>}
              <Button type="submit" variant="primary">保存 Role</Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={showJoin} title="扩容 Nomad 节点" onClose={() => setShowJoin(false)}>
        <form
          className="space-y-3 text-xs"
          onSubmit={async (e) => {
            e.preventDefault();
            setJoinBusy(true);
            try {
              const r = await apiPost(`/api/v1/clusters/${selectedId}/nodes/${joinNodeId}/join`, { role: joinRole });
              setShowJoin(false);
              if (r.task?.id) openTask(r.task.id, '扩容 Nomad 节点');
            } catch (ex: any) {
              setErr(ex?.message || '扩容失败');
            } finally {
              setJoinBusy(false);
            }
          }}
        >
          <ErrorAlert message={err} onClose={() => setErr('')} />
          <Select label="待加入主机" required value={joinNodeId} onChange={(e) => setJoinNodeId(e.target.value)}>
            <option value="">选择主机</option>
            {nodes.filter((n) => !clusterNodes.some((m: any) => m.node_id === n.id)).map((n) => <option key={n.id} value={n.id}>{n.name} ({n.host})</option>)}
          </Select>
          <Select label="节点角色" value={joinRole} onChange={(e) => setJoinRole(e.target.value)}>
            <option value="server_client">server_client</option>
            <option value="server">server</option>
            <option value="client">client</option>
          </Select>
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
            <span>下载网络：{proxyEnabled ? '通过系统代理' : '直连'}</span>
            <Link to="/settings?tab=proxy" className="text-indigo-600 dark:text-indigo-400 hover:underline">前往下载代理设置</Link>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setShowJoin(false)}>取消</Button>
            <Button type="submit" variant="primary" loading={joinBusy}>确认扩容</Button>
          </div>
        </form>
      </Modal>

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

      <ClusterCreateModal
        open={showCreate}
        product="nomad"
        nodes={nodes}
        onClose={() => setShowCreate(false)}
        onCreated={async (id) => {
          await loadList();
          setSelectedId(id);
          setTab('status');
          toast.success('集群配置已创建，请继续部署服务');
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
        title={`免密登录 Nomad Web UI${uiLoginModal?.targetLabel ? ` · ${uiLoginModal.targetLabel}` : ''}`}
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
                <span>立即免密打开 Nomad UI</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        }
      >
        {uiLoginModal && (
          <div className="space-y-3 text-xs leading-5 text-slate-600 dark:text-slate-300">
            <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 px-3.5 py-2.5 text-indigo-950 dark:border-indigo-500/30 dark:bg-indigo-950/30 dark:text-indigo-100">
              <p>已生成<strong>单次一次性票据链接（OTT）</strong>（约 {Math.max(1, Math.round(uiLoginModal.ottTTL / 60))} 分钟内有效，兑换一次即作废）。</p>
              <p className="mt-1">打开后 Nomad UI 会自动兑换临时会话并清掉地址栏里的票据，会话有效期为 <strong>{uiLoginModal.tokenTTL}</strong>，到期自动失效。</p>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              提示：如果节点使用自签名 TLS 证书，浏览器首次打开提示“证书风险”时点击“继续访问”后，页面仍会自动完成登录。
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
            <Button variant="primary" onClick={() => setMgmtToken('')}>关闭</Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-xs leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            这是 Nomad 集群的最高权限管理密钥（Root Token），可用于登录 Nomad 原生 Web UI 或通过 CLI 管理集群。关闭弹窗后将清除页面内存中的明文，下次查看需重新验证密码。
          </div>
          <MaskedSecret value={mgmtToken} label="Management (Root) Token：" />
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
              setDlErr(ex?.message || '操作失败');
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
          if (taskId) openTask(taskId, `卸载 Nomad: ${cluster?.name || ''}`);
          void loadList();
        }}
      />

      <NomadClusterSettingsModal
        open={showClusterSettings}
        cluster={cluster || null}
        onClose={() => setShowClusterSettings(false)}
        onSaved={async (taskId) => {
          if (taskId) openTask(taskId, `更新集群配置: ${cluster?.name || ''}`);
          else toast.success('集群配置已保存');
          await loadOpsTab();
        }}
      />

      <NomadNodeConfigModal
        open={Boolean(configMember)}
        cluster={cluster || null}
        member={configMember}
        nodePools={pools.map((p) => p.name)}
        onClose={() => setConfigMember(null)}
        onSubmitted={async (taskId, title) => {
          if (taskId) openTask(taskId, title || '更新节点配置');
          else toast.success('节点配置已保存（将在部署时生效）');
          await loadOpsTab();
        }}
      />
    </div>
  );
}
