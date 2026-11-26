import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lock, Plus, RefreshCw, Shield, Unlock } from 'lucide-react';
import { apiDelete, apiDownload, apiGet, apiPost, apiPut, apiUpload, fmtBytes, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
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
import { UninstallClusterModal, type UninstallPlan } from '../components/UninstallClusterModal';
import { ClusterCreateModal } from '../components/ClusterCreateModal';

export function VaultPage() {
  const { isAdmin } = useAuth();
  const { openTask, openNodeLogs, tasks } = useOpsDrawer();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [searchParams] = useSearchParams();
  const queryId = searchParams.get('id') || '';
  const [clusters, setClusters] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loadingList, setLoadingList] = useState(true);
  const selectionRef = useRef(selectedId);
  selectionRef.current = selectedId;
  const [tab, setTab] = useState('status');
  const [status, setStatus] = useState<any>(null);
  const [custodyData, setCustodyData] = useState<any>(null);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [gens, setGens] = useState<any[]>([]);
  const [auths, setAuths] = useState<any[]>([]);
  const [showAuth, setShowAuth] = useState(false);
  const [authForm, setAuthForm] = useState({ path: '', type: 'userpass', description: '' });
  const [policies, setPolicies] = useState<any[]>([]);
  const [policyEdit, setPolicyEdit] = useState({ name: '', rules: '' });
  const [mounts, setMounts] = useState<any[]>([]);
  const [kvMount, setKvMount] = useState('');
  const [kvPath, setKvPath] = useState('');
  const [kvKeys, setKvKeys] = useState<string[]>([]);
  const [kvItem, setKvItem] = useState<{ path: string; data: string; cas: number } | null>(null);
  const [showKVMount, setShowKVMount] = useState(false);
  const [kvMountForm, setKvMountForm] = useState({ path: '', description: '' });
  const [gateView, setGateView] = useState<any>(null);
  const [err, setErr] = useState('');
  const [rootToken, setRootToken] = useState('');
  const [revokingRootToken, setRevokingRootToken] = useState(false);
  const [uninstallPlan, setUninstallPlan] = useState<UninstallPlan | null>(null);

  // Create wizard
  const [showCreate, setShowCreate] = useState(false);
  const [deployVer, setDeployVer] = useState('latest');
  const [useProxy, setUseProxy] = useState(false);
  const [defaultUseProxy, setDefaultUseProxy] = useState(false);
  const [joinBusy, setJoinBusy] = useState(false);
  const [deployConfirmSwap, setDeployConfirmSwap] = useState(false);
  const [upVer, setUpVer] = useState('');
  const [showJoin, setShowJoin] = useState(false);
  const [joinNodeId, setJoinNodeId] = useState('');
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
      setSelectedId((prev) => {
        if (prev && list.some((c: any) => c.id === prev)) return prev;
        if (queryId && list.some((c: any) => c.id === queryId)) return queryId;
        return list[0]?.id || '';
      });
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

  const loadManage = useCallback(async () => {
    if (!selectedId) return;
    try {
      const [aRes, pRes, mRes] = await Promise.all([
        apiGet(`/api/v1/vault/${selectedId}/auth`),
        apiGet(`/api/v1/vault/${selectedId}/policies`),
        apiGet(`/api/v1/vault/${selectedId}/kv/mounts`),
      ]);
      setAuths(aRes.auth || []);
      setPolicies(pRes.policies || []);
      const ms = mRes.mounts || [];
      setMounts(ms);
      setKvMount((prev) => prev || ms[0]?.path || ms[0] || '');
    } catch (ex: any) {
      setErr(ex?.message || '加载 Vault 管理数据失败');
    }
  }, [selectedId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    void apiGet('/api/v1/settings').then((r) => {
      setDeployVer(r.settings?.['defaults.vault_version'] || 'latest');
      setDefaultUseProxy(Boolean(r.settings?.['proxy.use_for_releases']));
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
  const clusterProxyPref = cluster?.settings?.use_proxy;

  useEffect(() => {
    setUseProxy(clusterProxyPref !== undefined ? Boolean(clusterProxyPref) : defaultUseProxy);
  }, [selectedId, clusterProxyPref, defaultUseProxy]);

  const handleToggleProxy = async (next: boolean) => {
    setUseProxy(next);
    if (!isAdmin) return;
    try {
      if (selectedId) {
        const res = await apiPut(`/api/v1/clusters/${selectedId}/proxy`, { use_proxy: next });
        if (res.cluster) {
          setClusters((prev) => prev.map((c) => (c.id === selectedId ? { ...c, ...res.cluster } : c)));
        }
      }
      await apiPut('/api/v1/settings', { 'proxy.use_for_releases': next });
      setDefaultUseProxy(next);
      toast.success(next ? '已开启并保存代理设置' : '已关闭并保存代理设置');
    } catch (ex: any) {
      toast.error(ex?.message || '保存代理勾选状态失败');
    }
  };

  useEffect(() => {
    setRootToken('');
    setUninstallPlan(null);
    setPolicyEdit({ name: '', rules: '' });
    setKvItem(null);
    setKvKeys([]);
    setKvMount('');
    setKvPath('');
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
            <Button onClick={() => void loadDetail()}>
              <RefreshCw className="h-4 w-4" />
              <span>刷新 (30s)</span>
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

      {clusters.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {clusters.map((c) => (
            <Button key={c.id} size="sm" variant={selectedId === c.id ? 'primary' : 'secondary'} onClick={() => setSelectedId(c.id)}>
              <span>{c.name}</span>
              <StatusBadge value={c.init_state === 'uninitialized' ? 'uninitialized' : c.health_status} />
            </Button>
          ))}
        </div>
      )}

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {!cluster ? (
        <Card>
          <EmptyState icon={<Shield className="w-6 h-6" />} title="暂无 Vault 集群" description="Vault 负责安全存储密钥与凭据。先接入主机，再选择节点、创建配置并部署服务。" action={isAdmin && <Button variant="primary" onClick={() => setShowCreate(true)}>创建第一个 Vault 集群</Button>} />
        </Card>
      ) : (
        <div className="space-y-4">
          <SectionTabs
            tabs={[
              { id: 'status', label: '集群状态详情' },
              { id: 'custody', label: '初始化与密钥托管', tip: '控制面托管 Vault Unseal Key（Shamir 门限分片）与短时效运维 Token，支持自动解封、Rekey 轮换及签发临时 Root Token。' },
              { id: 'snapshots', label: 'Raft 快照', badge: snapshots.length, tip: '对 Vault Integrated Storage (Raft) 后端状态执行一致性快照备份与在线恢复。' },
              { id: 'manage', label: 'Auth / Policy / KV', tip: '管理 Vault 认证挂载（Userpass/JWT/AppRole）、HCL 权限策略（Policy）以及 KV v2 密钥引擎。' },
            ]}
            active={tab}
            onChange={(t) => {
              setTab(t);
              if (t === 'manage') void loadManage();
            }}
          />

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
                useProxy={useProxy}
                setUseProxy={(v) => void handleToggleProxy(v)}
                confirmSwap={deployConfirmSwap}
                setConfirmSwap={setDeployConfirmSwap}
                onDeploy={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/deploy`, { version: deployVer.trim() || 'latest', use_proxy: useProxy, confirm_swap: deployConfirmSwap })
                    .then((r) => { if (r.task?.id) openTask(r.task.id, '部署 Vault'); })
                    .catch((ex) => setErr(ex.message))
                }
                onInitVault={() =>
                  apiPost(`/api/v1/vault/${selectedId}/init`, { key_shares: 5, key_threshold: 3 })
                    .then((r) => { if (r.task?.id) openTask(r.task.id, '初始化 Vault 托管'); })
                    .catch((ex) => setErr(ex.message))
                }
                quickActions={
                  <>
                    <Button size="sm" onClick={() => setTab('custody')}>
                      密钥托管
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => { setTab('manage'); void loadManage(); }}>
                      Auth / Policy / KV
                    </Button>
                  </>
                }
                onUpgrade={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/upgrade`, { version: upVer.trim() || 'latest', use_proxy: useProxy, confirm: true })
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
                onUninstall={handleUninstall}
                onOpenJoin={() => { setJoinNodeId(''); setConfirmSwap(false); setShowJoin(true); }}
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
                onRemoveNode={(n) =>
                  apiPost(`/api/v1/clusters/${selectedId}/nodes/${n.node_id}/remove`, {})
                    .then((r) => { if (r.task?.id) openTask(r.task.id, `缩容节点: ${n.name}`); })
                    .catch((ex) => setErr(ex.message))
                }
                onError={setErr}
              />

              {gateView && (
                <Card title="仲裁门禁预览" actions={<Button size="sm" onClick={() => setGateView(null)}>关闭</Button>}>
                  <div className="text-xs">
                    结果：<Badge tone={gateView.allowed ? 'green' : 'red'}>{gateView.allowed ? '允许' : '拦截'}</Badge>{' '}
                    <span className="ml-2">{gateView.reason}</span>
                  </div>
                </Card>
              )}
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
                              variant="danger"
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
                              onClick={() =>
                                setPwAction({
                                  title: '签发临时 Root Token（使用托管解封密钥重建）',
                                  run: async (pw) => {
                                    const r = await apiPost(`/api/v1/vault/${selectedId}/root-token`, { current_password: pw });
                                    setRootToken(r.root_token || '');
                                  },
                                })
                              }
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
                  <SecretInput label="归档口令" value={snapPass} onChangeValue={setSnapPass} />
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
                          variant="danger"
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
                          variant="danger"
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
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <Card title="Auth 方法 & Policies">
                <div className="space-y-3 text-xs">
                  <div className="font-semibold">已启用 Auth 方法</div>
                  <div className="flex flex-wrap gap-1.5">
                    {auths.map((a, i) => (
                      <div key={i} className="flex items-center gap-1">
                        <Badge>{a.path || a.type}</Badge>
                        {isAdmin && a.type !== 'token' && (
                          <Button
                            size="sm"
                            variant="danger"
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
                            停用 {a.path}
                          </Button>
                        )}
                      </div>
                    ))}
                    {isAdmin && <Button size="sm" onClick={() => setShowAuth(true)}>启用 Auth 方法</Button>}
                  </div>
                  <div className="border-t border-slate-200 pt-2 font-semibold dark:border-slate-800">ACL Policies</div>
                  <div className="flex flex-wrap gap-1.5">
                    {policies.map((p) => (
                      <Button
                        key={p}
                        size="sm"
                        onClick={() =>
                          void apiGet(`/api/v1/vault/${selectedId}/policies/${encodeURIComponent(p)}`)
                            .then((r) => setPolicyEdit({ name: p, rules: r.policy?.rules || r.policy || '' }))
                            .catch((ex) => setErr(ex.message))
                        }
                      >
                        {p}
                      </Button>
                    ))}
                  </div>
                  <Input label="Policy 名称" value={policyEdit.name} onChange={(e) => setPolicyEdit({ ...policyEdit, name: e.target.value })} />
                  <CodeEditor value={policyEdit.rules} onChange={(v) => setPolicyEdit({ ...policyEdit, rules: v })} readOnly={!isAdmin} height="180px" />
                  {isAdmin && policyEdit.name && (
                    <Button
                      variant="primary"
                      onClick={() =>
                        void apiPut(`/api/v1/vault/${selectedId}/policies/${encodeURIComponent(policyEdit.name)}`, { policy: policyEdit.rules })
                          .then(() => { toast.success('Policy 已保存'); return loadManage(); })
                          .catch((ex) => setErr(ex.message))
                      }
                    >
                      保存 Policy
                    </Button>
                  )}
                  {isAdmin && policyEdit.name && !['root', 'default', 'nomad-deck-admin'].includes(policyEdit.name) && (
                    <Button
                      variant="danger"
                      onClick={async () => {
                        if (!(await askConfirm(`确认删除 Policy「${policyEdit.name}」吗？`, { title: '删除 Policy', confirmText: '确认删除', danger: true }))) return;
                        void apiDelete(`/api/v1/vault/${selectedId}/policies/${encodeURIComponent(policyEdit.name)}`)
                          .then(() => {
                            setPolicyEdit({ name: '', rules: '' });
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
              </Card>

              <Card title="KV v2 Secret 浏览">
                <div className="space-y-3 text-xs">
                  {isAdmin && (
                    <Button size="sm" onClick={() => setShowKVMount(true)}>启用 KV v2 挂载</Button>
                  )}
                  <div className="flex gap-2">
                    <Select value={kvMount} onChange={(e) => setKvMount(e.target.value)}>
                      {mounts.map((m: any) => (
                        <option key={m.path || m} value={m.path || m}>{m.path || m}</option>
                      ))}
                    </Select>
                    <Input placeholder="路径（可空）" value={kvPath} onChange={(e) => setKvPath(e.target.value)} />
                    <Button
                      onClick={() =>
                        void apiGet(`/api/v1/vault/${selectedId}/kv/list?mount=${encodeURIComponent(kvMount)}&path=${encodeURIComponent(kvPath)}`)
                          .then((r) => setKvKeys(r.keys || []))
                          .catch((ex) => setErr(ex.message))
                      }
                    >
                      列出
                    </Button>
                  </div>
                  {isAdmin && (
                    <Button
                      size="sm"
                      disabled={!kvMount || !kvPath.trim()}
                      onClick={() => setKvItem({ path: kvPath.trim().replace(/^\/+|\/+$/g, ''), data: '{}', cas: 0 })}
                    >
                      新建 Secret
                    </Button>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {kvKeys.map((k) => (
                      <Button
                        key={k}
                        size="sm"
                        onClick={() => {
                          const full = kvPath ? `${kvPath.replace(/\/$/, '')}/${k}` : k;
                          if (k.endsWith('/')) {
                            setKvPath(full);
                            return;
                          }
                          if (!isAdmin) return;
                          void apiGet(`/api/v1/vault/${selectedId}/kv/item?mount=${encodeURIComponent(kvMount)}&path=${encodeURIComponent(full)}`)
                            .then((r) =>
                              setKvItem({
                                path: full,
                                data: JSON.stringify(r.secret?.data || r.secret, null, 2),
                                cas: Number(r.secret?.metadata?.version ?? 0),
                              }),
                            )
                            .catch((ex) => setErr(ex.message));
                        }}
                      >
                        {k}
                      </Button>
                    ))}
                  </div>
                  {isAdmin && kvItem && (
                    <div className="space-y-2 border-t border-slate-200 pt-2 dark:border-slate-800">
                      <div className="font-mono font-semibold">{kvItem.path} (v{kvItem.cas})</div>
                      <CodeEditor value={kvItem.data} onChange={(v) => setKvItem({ ...kvItem, data: v })} height="180px" />
                      <Button
                        variant="primary"
                        onClick={() => {
                          try {
                            const parsed = JSON.parse(kvItem.data);
                            void apiPut(`/api/v1/vault/${selectedId}/kv/item?mount=${encodeURIComponent(kvMount)}&path=${encodeURIComponent(kvItem.path)}`, {
                              data: parsed,
                              cas: kvItem.cas,
                            })
                              .then((r) => {
                                toast.success(kvItem.cas === 0 ? 'Secret 已创建' : 'KV 已更新');
                                // Vault returns the authoritative version, including after deleted versions.
                                setKvItem((cur) => (cur ? { ...cur, cas: Number(r.result?.version ?? cur.cas + 1) } : null));
                              })
                              .catch((ex) => setErr(ex.message));
                          } catch {
                            setErr('KV 数据必须是合法 JSON');
                          }
                        }}
                      >
                        保存 Secret
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            </div>
          )}
        </div>
      )}

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
              const r = await apiPost(`/api/v1/clusters/${selectedId}/nodes/${joinNodeId}/join`, { use_proxy: useProxy, confirm_swap: confirmSwap });
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
          <Select label="待加入主机" required value={joinNodeId} onChange={(e) => setJoinNodeId(e.target.value)}>
            <option value="">选择主机</option>
            {nodes.filter((n) => !clusterNodes.some((m: any) => m.node_id === n.id)).map((n) => <option key={n.id} value={n.id}>{n.name} ({n.host})</option>)}
          </Select>
          <label className="flex items-center gap-2"><input type="checkbox" checked={useProxy} onChange={(e) => void handleToggleProxy(e.target.checked)} />使用系统代理</label>
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
          <SecretInput label="归档加密口令（至少 12 位）" required minLength={12} value={dlPass} onChangeValue={setDlPass} />
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
