import React, { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Terminal } from 'lucide-react';
import { apiDelete, apiDownload, apiGet, apiPost, apiPut, apiUpload, fmtBytes, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOpsDrawer } from '../lib/opsDrawer';
import {
  Badge, Button, Card, EmptyState, ErrorAlert, Input, Modal, PasswordConfirmModal, SectionTabs, Select, statusTone,
} from '../components/UI';
import { NomadWorkbench } from '../components/NomadWorkbench';
import { CodeEditor } from '../components/CodeEditor';

export function NomadPage() {
  const { isAdmin } = useAuth();
  const { openTask, openNodeLogs } = useOpsDrawer();
  const [clusters, setClusters] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [tab, setTab] = useState('workbench');
  const [status, setStatus] = useState<any>(null);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [namespaces, setNamespaces] = useState<any[]>([]);
  const [pools, setPools] = useState<any[]>([]);
  const [policies, setPolicies] = useState<any[]>([]);
  const [tokens, setTokens] = useState<any[]>([]);
  const [policyEdit, setPolicyEdit] = useState({ name: '', rules: '' });
  const [newToken, setNewToken] = useState('');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [cForm, setCForm] = useState({ name: '', mode: 'cluster', region: 'global', datacenter: 'dc1', public_api_url: '', members: [] as Array<{ node_id: string; role: string; advertise_addr: string }> });
  const [deployVer, setDeployVer] = useState('1.11.1');
  const [upVer, setUpVer] = useState('');
  const [useProxy, setUseProxy] = useState(false);
  const [snapPass, setSnapPass] = useState('');
  const [snapFile, setSnapFile] = useState<File | null>(null);
  const [pwAction, setPwAction] = useState<{ title: string; run: (pw: string) => Promise<void> } | null>(null);

  const loadList = useCallback(async () => {
    const [cRes, nRes] = await Promise.all([apiGet('/api/v1/clusters?type=nomad'), apiGet('/api/v1/nodes')]);
    const list = cRes.clusters || [];
    setClusters(list);
    setNodes(nRes.nodes || []);
    if (!selectedId && list.length > 0) setSelectedId(list[0].id);
  }, [selectedId]);

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
      const [nsRes, plRes, polRes, tokRes] = await Promise.all([
        apiGet(`/api/v1/nomad/${selectedId}/namespaces`),
        apiGet(`/api/v1/nomad/${selectedId}/node-pools`),
        apiGet(`/api/v1/nomad/${selectedId}/acl/policies`),
        apiGet(`/api/v1/nomad/${selectedId}/acl/tokens`),
      ]);
      setNamespaces(nsRes.namespaces || []);
      setPools(plRes.node_pools || []);
      setPolicies(polRes.policies || []);
      setTokens(tokRes.tokens || []);
    } catch (ex: any) {
      setErr(ex?.message || '加载治理信息失败');
    }
  };

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId && (tab === 'nodes' || tab === 'snapshots')) void loadOpsTab();
    if (selectedId && tab === 'governance') void loadGovernance();
  }, [selectedId, tab, loadOpsTab]);

  const cluster = clusters.find((c) => c.id === selectedId);
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {clusters.map((c) => (
            <Button key={c.id} size="sm" variant={selectedId === c.id ? 'primary' : 'secondary'} onClick={() => setSelectedId(c.id)}>
              {c.name} <Badge tone={statusTone(c.health_status)}>{c.health_status}</Badge>
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void loadList()}><RefreshCw className="h-3.5 w-3.5" /> 刷新</Button>
          {isAdmin && (
            <Button size="sm" variant="primary" onClick={() => setShowCreate(true)}>
              <Plus className="h-3.5 w-3.5" /> 新建 Nomad 集群
            </Button>
          )}
        </div>
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />
      {notice && <div className="rounded bg-emerald-50 px-3.5 py-2 text-xs text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">{notice}</div>}
      {newToken && (
        <div className="rounded border border-emerald-300 bg-emerald-50 p-3 text-xs dark:border-emerald-800 dark:bg-emerald-950/60">
          新签发 ACL Token Secret（仅展示一次）：<code className="font-mono font-bold">{newToken}</code>
        </div>
      )}

      {!cluster ? (
        <Card><EmptyState text="暂无 Nomad 集群" /></Card>
      ) : (
        <div className="space-y-4">
          <SectionTabs
            tabs={[
              { id: 'workbench', label: '运行态工作台' },
              { id: 'nodes', label: '节点与集群运维' },
              { id: 'snapshots', label: `Raft 快照 (${snapshots.length})` },
              { id: 'governance', label: '治理 (Namespace / Pool / ACL)' },
            ]}
            active={tab}
            onChange={setTab}
          />

          {tab === 'workbench' && <NomadWorkbench clusterId={selectedId} />}

          {tab === 'nodes' && (
            <div className="space-y-4">
              {isAdmin && (
                <Card title="集群部署、升级与证书维护">
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <div className="flex items-center gap-1.5">
                      <Input placeholder="版本" value={deployVer} onChange={(e) => setDeployVer(e.target.value)} />
                      <Button variant="primary" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/deploy`, { version: deployVer, use_proxy: useProxy }).then((r) => openTask(r.task.id))}>一键部署</Button>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Input placeholder="升级版本" value={upVer} onChange={(e) => setUpVer(e.target.value)} />
                      <Button onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/upgrade`, { version: upVer, use_proxy: useProxy, confirm: true }).then((r) => openTask(r.task.id))}>滚动升级</Button>
                    </div>
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} /> 使用系统代理
                    </label>
                    <Button size="sm" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/certs/renew`, {}).then((r) => openTask(r.task.id))}>续期证书</Button>
                    <Button size="sm" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/ca/rotate`, {}).then((r) => openTask(r.task.id))}>轮换 CA</Button>
                    <Button size="sm" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/gossip/rotate`, {}).then((r) => openTask(r.task.id))}>轮换 Gossip</Button>
                    <Button size="sm" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/doctor`).then((r) => setNotice(r.report?.summary || 'Doctor 完成'))}>Doctor 体检</Button>
                    <Button size="sm" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/reconcile`).then((r) => setNotice(r.report?.message || '已核对'))}>核对解锁</Button>
                  </div>
                </Card>
              )}

              <Card title="集群成员节点">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                        <th className="py-2 pr-3">节点 / 角色</th>
                        <th className="py-2 pr-3">地址 / 版本</th>
                        <th className="py-2 pr-3">服务 / Raft</th>
                        <th className="py-2 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {clusterNodes.map((n: any) => (
                        <tr key={n.node_id}>
                          <td className="py-2 pr-3">
                            <div className="font-medium">{n.node_name}</div>
                            <Badge>{n.role}</Badge>
                          </td>
                          <td className="py-2 pr-3 font-mono">{n.advertise_addr} · {n.installed_version || '-'}</td>
                          <td className="py-2 pr-3">{n.service_status} · {n.raft_role}</td>
                          <td className="py-2 text-right">
                            <div className="flex flex-wrap justify-end gap-1">
                              <Button size="sm" onClick={() => openNodeLogs(selectedId, n.node_id, `Nomad 日志: ${n.node_name}`)}>
                                <Terminal className="h-3 w-3" /> 日志
                              </Button>
                              {isAdmin && (
                                <>
                                  <Button size="sm" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/nodes/${n.node_id}/service/restart`, {}).then((r) => openTask(r.task.id))}>重启</Button>
                                  <Button size="sm" variant="danger" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/nodes/${n.node_id}/remove`, {}).then((r) => openTask(r.task.id))}>缩容</Button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          )}

          {tab === 'snapshots' && (
            <Card
              title="Nomad Raft 快照"
              actions={isAdmin && <Button size="sm" variant="primary" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/snapshots`).then((r) => openTask(r.task.id))}>创建快照</Button>}
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
                  <Input label="归档口令" type="password" value={snapPass} onChange={(e) => setSnapPass(e.target.value)} />
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
                          onClick={() =>
                            setPwAction({
                              title: `下载快照 ${sn.id}`,
                              run: async (pw) => {
                                await apiDownload(`/api/v1/clusters/${selectedId}/snapshots/${sn.id}/download`, {
                                  current_password: pw,
                                  passphrase: pw.length >= 12 ? pw : pw + '-backup-archive',
                                }, `${cluster.name}-${sn.id}.ndsnap`);
                              },
                            })
                          }
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
                        <Button size="sm" onClick={() => void apiDelete(`/api/v1/clusters/${selectedId}/snapshots/${sn.id}`).then(() => loadOpsTab())}>删除</Button>
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
                    {namespaces.map((ns) => <Badge key={ns.Name}>{ns.Name}</Badge>)}
                  </div>
                  <div className="font-semibold pt-2">Node Pools ({pools.length})</div>
                  <div className="flex flex-wrap gap-1.5">
                    {pools.map((p) => <Badge key={p.Name}>{p.Name}</Badge>)}
                  </div>
                </div>
              </Card>

              <Card title="ACL Policies & Tokens">
                <div className="space-y-3 text-xs">
                  <div className="flex flex-wrap gap-1.5">
                    {policies.map((p) => (
                      <Button key={p.Name} size="sm" onClick={() => void apiGet(`/api/v1/nomad/${selectedId}/acl/policies/${encodeURIComponent(p.Name)}`).then((r) => setPolicyEdit({ name: p.Name, rules: r.policy?.Rules || '' }))}>
                        {p.Name}
                      </Button>
                    ))}
                  </div>
                  <Input label="Policy 名称" value={policyEdit.name} onChange={(e) => setPolicyEdit({ ...policyEdit, name: e.target.value })} />
                  <CodeEditor value={policyEdit.rules} onChange={(v) => setPolicyEdit({ ...policyEdit, rules: v })} readOnly={!isAdmin} height="160px" />
                  {isAdmin && (
                    <div className="flex gap-2">
                      <Button variant="primary" onClick={() => policyEdit.name && void apiPost(`/api/v1/nomad/${selectedId}/acl/policies/${encodeURIComponent(policyEdit.name)}`, { rules: policyEdit.rules }).catch(() => void apiPut(`/api/v1/nomad/${selectedId}/acl/policies/${encodeURIComponent(policyEdit.name)}`, { rules: policyEdit.rules })).then(() => loadGovernance())}>保存 Policy</Button>
                      <Button onClick={() => void apiPost(`/api/v1/nomad/${selectedId}/acl/tokens`, { name: 'ops-token', type: 'client', policies: policyEdit.name ? [policyEdit.name] : [] }).then((r) => { setNewToken(r.token?.SecretID || ''); return loadGovernance(); })}>签发 Client Token</Button>
                    </div>
                  )}
                  <div className="border-t border-slate-200 pt-2 dark:border-slate-800">
                    <div className="mb-1 font-semibold">ACL Tokens ({tokens.length})</div>
                    {tokens.slice(0, 10).map((tk) => (
                      <div key={tk.AccessorID} className="flex items-center justify-between py-1">
                        <span className="font-mono">{tk.Name} ({tk.AccessorID.slice(0, 8)})</span>
                        {isAdmin && (
                          <Button size="sm" variant="danger" onClick={() => void apiDelete(`/api/v1/nomad/${selectedId}/acl/tokens/${tk.AccessorID}`).then(() => loadGovernance())}>吊销</Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </Card>
            </div>
          )}
        </div>
      )}

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
    </div>
  );
}
