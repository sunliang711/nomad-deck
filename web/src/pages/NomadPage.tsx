import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Boxes, Plus, RefreshCw } from 'lucide-react';
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

export function NomadPage() {
  const { isAdmin } = useAuth();
  const { openTask, openNodeLogs } = useOpsDrawer();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [searchParams] = useSearchParams();
  const queryId = searchParams.get('id') || '';
  const [clusters, setClusters] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [tab, setTab] = useState('status');
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
  const [err, setErr] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [cForm, setCForm] = useState({ name: '', mode: 'cluster', region: 'global', datacenter: 'dc1', public_api_url: '', members: [] as Array<{ node_id: string; role: string; advertise_addr: string }> });
  const [deployVer, setDeployVer] = useState('latest');
  const [upVer, setUpVer] = useState('');
  const [showJoin, setShowJoin] = useState(false);
  const [joinNodeId, setJoinNodeId] = useState('');
  const [joinRole, setJoinRole] = useState('server_client');
  const [useProxy, setUseProxy] = useState(false);
  const [defaultUseProxy, setDefaultUseProxy] = useState(false);
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
      setSelectedId((prev) => {
        if (prev && list.some((c: any) => c.id === prev)) return prev;
        if (queryId && list.some((c: any) => c.id === queryId)) return queryId;
        return list[0]?.id || '';
      });
    } catch (ex: any) {
      setErr(ex?.message || '加载 Nomad 集群列表失败');
    }
  }, [queryId]);

  const loadOpsTab = useCallback(async () => {
    if (!selectedId) return;
    try {
      const [stRes, snRes] = await Promise.all([
        apiGet(`/api/v1/clusters/${selectedId}/status`),
        apiGet(`/api/v1/clusters/${selectedId}/snapshots`),
      ]);
      setStatus(stRes.status);
      setSnapshots(snRes.snapshots || []);
    } catch (ex: any) {
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
      setDefaultUseProxy(Boolean(r.settings?.['proxy.use_for_releases']));
    }).catch((ex) => setErr(ex.message));
  }, []);

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
    setGateView(null);
    if (selectedId && (tab === 'status' || tab === 'snapshots')) void loadOpsTab();
    if (selectedId && tab === 'governance') void loadGovernance();
    if (!selectedId || tab !== 'status') return;
    const t = setInterval(() => void loadOpsTab(), 30000);
    return () => clearInterval(t);
  }, [selectedId, tab, loadOpsTab]);

  const clusterNodes = status?.nodes || [];

  const toggleMember = (n: any, checked: boolean) => {
    setCForm((prev) => ({
      ...prev,
      members: checked
        ? [...prev.members, { node_id: n.id, role: 'server_client', advertise_addr: n.host }]
        : prev.members.filter((m) => m.node_id !== n.id),
    }));
  };

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

      {clusters.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {clusters.map((c) => (
            <Button key={c.id} size="sm" variant={selectedId === c.id ? 'primary' : 'secondary'} onClick={() => setSelectedId(c.id)}>
              <span>{c.name}</span>
              <StatusBadge value={c.health_status} />
            </Button>
          ))}
        </div>
      )}

      <ErrorAlert message={err} onClose={() => setErr('')} />
      {newToken && <MaskedSecret value={newToken} label="新签发 ACL Token Secret（仅展示一次）：" />}

      {!cluster ? (
        <Card>
          <EmptyState icon={<Boxes className="w-6 h-6" />} title="暂无 Nomad 集群" description="先在基础设施页纳管 Linux 主机，再创建并部署 Nomad 集群。" />
        </Card>
      ) : (
        <div className="space-y-4">
          <SectionTabs
            tabs={[
              { id: 'status', label: '集群状态详情' },
              { id: 'workbench', label: '运行态工作台', tip: '实时查看与管理 Nomad Clients、Servers、Allocations、Deployments、CSI 存储与 Variables。' },
              { id: 'snapshots', label: 'Raft 快照', badge: snapshots.length, tip: '保存与恢复 Nomad Server Raft 状态机中的任务、变量与 ACL 快照。' },
              { id: 'governance', label: '治理 (Namespace / Pool / ACL)', tip: '配置多租户命名空间（Namespace）、节点资源池（Node Pool）与访问控制（ACL Policy / Role / Token）。' },
            ]}
            active={tab}
            onChange={setTab}
          />

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
                useProxy={useProxy}
                setUseProxy={(v) => void handleToggleProxy(v)}
                drainClients={drainClients}
                setDrainClients={setDrainClients}
                onDeploy={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/deploy`, { version: deployVer.trim() || 'latest', use_proxy: useProxy })
                    .then((r) => { if (r.task?.id) openTask(r.task.id, '部署 Nomad'); })
                    .catch((ex) => setErr(ex.message))
                }
                onUpgrade={() =>
                  apiPost(`/api/v1/clusters/${selectedId}/upgrade`, { version: upVer.trim() || 'latest', use_proxy: useProxy, drain_clients: drainClients, confirm: true })
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

          {tab === 'workbench' && <NomadWorkbench key={selectedId} clusterId={selectedId} />}

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
                  <SecretInput label="归档口令" value={snapPass} onChangeValue={setSnapPass} />
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
                          variant="danger"
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
                          variant="danger"
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
                        variant="danger"
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
                            variant="danger"
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
              const r = await apiPost(`/api/v1/clusters/${selectedId}/nodes/${joinNodeId}/join`, { role: joinRole, use_proxy: useProxy });
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
          <label className="flex items-center gap-2"><input type="checkbox" checked={useProxy} onChange={(e) => void handleToggleProxy(e.target.checked)} />使用系统代理</label>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setShowJoin(false)}>取消</Button>
            <Button type="submit" variant="primary" loading={joinBusy}>确认扩容</Button>
          </div>
        </form>
      </Modal>

      <Modal open={showCreate} title="新建 Nomad 集群" onClose={() => setShowCreate(false)}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void apiPost('/api/v1/clusters', {
              type: 'nomad',
              name: cForm.name,
              mode: cForm.mode,
              region: cForm.region,
              datacenter: cForm.datacenter,
              public_api_url: cForm.public_api_url,
              nodes: cForm.members,
            })
              .then((r) => { setShowCreate(false); return loadList().then(() => r.cluster?.id && setSelectedId(r.cluster.id)); })
              .catch((ex) => setErr(ex.message));
          }}
          className="space-y-3 text-xs"
        >
          <Input label="集群名称" required value={cForm.name} onChange={(e) => setCForm({ ...cForm, name: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            <Select label="模式" value={cForm.mode} onChange={(e) => setCForm({ ...cForm, mode: e.target.value })}>
              <option value="cluster">多节点集群</option>
              <option value="single">单机模式</option>
            </Select>
            <Input label="Datacenter" value={cForm.datacenter} onChange={(e) => setCForm({ ...cForm, datacenter: e.target.value })} />
          </div>
          <Input label="统一业务入口 URL（可选）" value={cForm.public_api_url} onChange={(e) => setCForm({ ...cForm, public_api_url: e.target.value })} />
          <div className="max-h-40 space-y-1 overflow-y-auto rounded border border-slate-200 p-2 dark:border-slate-800">
            {nodes.map((n) => {
              const picked = cForm.members.find((m) => m.node_id === n.id);
              return (
                <div key={n.id} className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={Boolean(picked)} onChange={(e) => toggleMember(n, e.target.checked)} />
                    <span>{n.name} ({n.host})</span>
                  </label>
                  {picked && (
                    <select
                      value={picked.role}
                      onChange={(e) => setCForm({ ...cForm, members: cForm.members.map((m) => m.node_id === n.id ? { ...m, role: e.target.value } : m) })}
                      className="rounded border border-slate-300 px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-950"
                    >
                      <option value="server_client">server_client</option>
                      <option value="server">server</option>
                      <option value="client">client</option>
                    </select>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setShowCreate(false)}>取消</Button>
            <Button type="submit" variant="primary">创建</Button>
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
              setDlErr(ex?.message || '操作失败');
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
    </div>
  );
}
