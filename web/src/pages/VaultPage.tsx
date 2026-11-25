import React, { useCallback, useEffect, useState } from 'react';
import { Lock, Plus, RefreshCw, Terminal, Unlock } from 'lucide-react';
import { apiDelete, apiDownload, apiGet, apiPost, apiPut, apiUpload, fmtBytes, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOpsDrawer } from '../lib/opsDrawer';
import {
  Badge, Button, Card, EmptyState, ErrorAlert, Input, Modal, PasswordConfirmModal, SectionTabs, Select, statusTone,
} from '../components/UI';
import { CodeEditor } from '../components/CodeEditor';

export function VaultPage() {
  const { isAdmin } = useAuth();
  const { openTask, openNodeLogs } = useOpsDrawer();
  const [clusters, setClusters] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [tab, setTab] = useState('status');
  const [status, setStatus] = useState<any>(null);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [gens, setGens] = useState<any[]>([]);
  const [auths, setAuths] = useState<any[]>([]);
  const [policies, setPolicies] = useState<any[]>([]);
  const [policyEdit, setPolicyEdit] = useState({ name: '', rules: '' });
  const [mounts, setMounts] = useState<any[]>([]);
  const [kvMount, setKvMount] = useState('');
  const [kvPath, setKvPath] = useState('');
  const [kvKeys, setKvKeys] = useState<string[]>([]);
  const [kvItem, setKvItem] = useState<{ path: string; data: string } | null>(null);
  const [gateView, setGateView] = useState<any>(null);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  // Create wizard
  const [showCreate, setShowCreate] = useState(false);
  const [cForm, setCForm] = useState({ name: '', mode: 'cluster', public_api_url: '', node_ids: [] as string[] });
  const [deployVer, setDeployVer] = useState('1.18.3');
  const [useProxy, setUseProxy] = useState(false);
  const [upVer, setUpVer] = useState('');
  const [snapPass, setSnapPass] = useState('');
  const [snapFile, setSnapFile] = useState<File | null>(null);
  const [pwAction, setPwAction] = useState<{ title: string; run: (pw: string) => Promise<void> } | null>(null);

  const loadList = useCallback(async () => {
    const [cRes, nRes] = await Promise.all([apiGet('/api/v1/clusters?type=vault'), apiGet('/api/v1/nodes')]);
    const list = cRes.clusters || [];
    setClusters(list);
    setNodes(nRes.nodes || []);
    if (!selectedId && list.length > 0) setSelectedId(list[0].id);
  }, [selectedId]);

  const loadDetail = useCallback(async () => {
    if (!selectedId) return;
    setErr('');
    try {
      const [stRes, snRes, gRes] = await Promise.all([
        apiGet(`/api/v1/clusters/${selectedId}/status`),
        apiGet(`/api/v1/clusters/${selectedId}/snapshots`),
        apiGet(`/api/v1/vault/${selectedId}/key-generations`),
      ]);
      setStatus(stRes.status);
      setSnapshots(snRes.snapshots || []);
      setGens(gRes.generations || []);
    } catch (ex: any) {
      setErr(ex?.message || '加载 Vault 集群详情失败');
    }
  }, [selectedId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    void loadDetail();
    if (!selectedId) return;
    const t = window.setInterval(() => void loadDetail(), 30000);
    return () => window.clearInterval(t);
  }, [selectedId, loadDetail]);

  const loadManage = async () => {
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
      if (ms.length > 0 && !kvMount) setKvMount(ms[0].path || ms[0]);
    } catch (ex: any) {
      setErr(ex?.message || '加载 Vault 管理数据失败');
    }
  };

  const cluster = clusters.find((c) => c.id === selectedId);
  const clusterNodes = status?.nodes || [];
  const quorum = status?.quorum || status?.raft || {};
  const custody = status?.custody || {};

  const createCluster = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const members = cForm.node_ids.map((nid) => {
        const n = nodes.find((x) => x.id === nid);
        return { node_id: nid, advertise_addr: n?.host || '' };
      });
      const res = await apiPost('/api/v1/clusters', {
        type: 'vault',
        name: cForm.name,
        mode: cForm.mode,
        public_api_url: cForm.public_api_url,
        nodes: members,
      });
      setShowCreate(false);
      await loadList();
      if (res.cluster?.id) setSelectedId(res.cluster.id);
    } catch (ex: any) {
      setErr(ex?.message || '创建 Vault 集群失败');
    }
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
          <Button size="sm" onClick={() => void loadDetail()}><RefreshCw className="h-3.5 w-3.5" /> 刷新 (30s)</Button>
          {isAdmin && (
            <Button size="sm" variant="primary" onClick={() => setShowCreate(true)}>
              <Plus className="h-3.5 w-3.5" /> 新建 Vault 集群
            </Button>
          )}
        </div>
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />
      {notice && <div className="rounded bg-emerald-50 px-3.5 py-2 text-xs text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">{notice}</div>}

      {!cluster ? (
        <Card><EmptyState text="暂无 Vault 集群" /></Card>
      ) : (
        <div className="space-y-4">
          <SectionTabs
            tabs={[
              { id: 'status', label: '集群状态详情' },
              { id: 'custody', label: '初始化与密钥托管' },
              { id: 'snapshots', label: `Raft 快照 (${snapshots.length})` },
              { id: 'manage', label: 'Auth / Policy / KV' },
            ]}
            active={tab}
            onChange={(t) => {
              setTab(t);
              if (t === 'manage') void loadManage();
            }}
          />

          {tab === 'status' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <Card title="集群概要">
                  <div className="space-y-1.5 text-xs">
                    <div>健康状态：<Badge tone={statusTone(cluster.health_status)}>{cluster.health_status}</Badge></div>
                    <div>初始化状态：<span className="font-mono">{cluster.init_state}</span></div>
                    <div>维护模式：{cluster.maintenance_mode ? `是 (${cluster.maintenance_reason})` : '否'}</div>
                    <div>Active 节点：<span className="font-mono">{status?.active_node || '-'}</span></div>
                    <div>CA 到期：{fmtTime(cluster.ca_expires_at)}</div>
                    <div>统一入口：<span className="font-mono">{cluster.public_api_url || '-'}</span></div>
                  </div>
                </Card>

                <Card title="Raft 仲裁概览">
                  <div className="space-y-1.5 text-xs">
                    <div>投票成员：{quorum.voters ?? '-'}（健康 {quorum.healthy_voters ?? '-'}）</div>
                    <div>可容忍故障数：<b>{quorum.failure_tolerance ?? '-'}</b></div>
                    {quorum.failure_tolerance === 0 && (
                      <div className="rounded bg-rose-50 p-2 text-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
                        注意：可容忍故障数为 0，再有一台节点下线将失去多数派！
                      </div>
                    )}
                  </div>
                </Card>

                {isAdmin && (
                  <Card title="部署与集群运维">
                    <div className="space-y-2 text-xs">
                      <div className="flex gap-2">
                        <Input placeholder="Vault 版本" value={deployVer} onChange={(e) => setDeployVer(e.target.value)} />
                        <Button
                          variant="primary"
                          onClick={() =>
                            void apiPost(`/api/v1/clusters/${selectedId}/deploy`, { version: deployVer, use_proxy: useProxy, confirm_swap: true })
                              .then((r) => r.task?.id && openTask(r.task.id, '部署 Vault'))
                              .catch((ex) => setErr(ex.message))
                          }
                        >
                          部署
                        </Button>
                      </div>
                      <div className="flex gap-2">
                        <Input placeholder="升级目标版本" value={upVer} onChange={(e) => setUpVer(e.target.value)} />
                        <Button
                          onClick={() =>
                            void apiPost(`/api/v1/clusters/${selectedId}/upgrade`, { version: upVer, use_proxy: useProxy, confirm: true })
                              .then((r) => r.task?.id && openTask(r.task.id, '滚动升级 Vault'))
                              .catch((ex) => setErr(ex.message))
                          }
                        >
                          升级
                        </Button>
                      </div>
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} /> 使用系统代理
                      </label>
                      <div className="flex flex-wrap gap-1.5">
                        <Button size="sm" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/certs/renew`, {}).then((r) => openTask(r.task.id))}>续期证书</Button>
                        <Button size="sm" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/ca/rotate`, {}).then((r) => openTask(r.task.id))}>轮换 CA</Button>
                        <Button size="sm" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/doctor`).then((r) => setNotice(r.report?.summary || 'Doctor 完成'))}>Doctor 体检</Button>
                        <Button size="sm" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/reconcile`).then((r) => setNotice(r.report?.message || '已核对'))}>核对解锁</Button>
                      </div>
                    </div>
                  </Card>
                )}
              </div>

              <Card title="节点成员状态">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                        <th className="py-2 pr-3">节点 / API 地址</th>
                        <th className="py-2 pr-3">密封 / 初始化</th>
                        <th className="py-2 pr-3">Raft 角色</th>
                        <th className="py-2 pr-3">版本 / 证书</th>
                        <th className="py-2 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {clusterNodes.map((n: any) => (
                        <tr key={n.node_id}>
                          <td className="py-2 pr-3">
                            <div className="font-medium">{n.node_name}</div>
                            <div className="font-mono text-slate-500">{n.api_addr || n.advertise_addr}</div>
                          </td>
                          <td className="py-2 pr-3">
                            <Badge tone={n.is_sealed ? 'red' : 'green'}>{n.is_sealed ? 'Sealed' : 'Unsealed'}</Badge>
                            <span className="ml-1.5 text-slate-500">{n.service_status}</span>
                          </td>
                          <td className="py-2 pr-3">{n.raft_role} {n.is_voter ? '(voter)' : ''}</td>
                          <td className="py-2 pr-3 font-mono">{n.installed_version || '-'}</td>
                          <td className="py-2 text-right">
                            <div className="flex flex-wrap justify-end gap-1">
                              <Button size="sm" onClick={() => openNodeLogs(selectedId, n.node_id, `Vault 日志: ${n.node_name}`)}>
                                <Terminal className="h-3 w-3" /> 日志
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => void apiGet(`/api/v1/clusters/${selectedId}/gate?node_id=${n.node_id}`).then((r) => setGateView(r.gate))}
                              >
                                门禁
                              </Button>
                              {isAdmin && (
                                <>
                                  <Button size="sm" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/nodes/${n.node_id}/service/restart`, {}).then((r) => openTask(r.task.id))}>
                                    重启
                                  </Button>
                                  <Button size="sm" variant="danger" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/nodes/${n.node_id}/remove`, {}).then((r) => openTask(r.task.id))}>
                                    缩容
                                  </Button>
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

          {tab === 'custody' && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <Card title="托管状态与控制">
                <div className="space-y-3 text-xs">
                  <div>当前代际：{custody.seal_generation ?? '-'}</div>
                  <div>自动解封：<Badge tone={custody.auto_unseal_by_deck ? 'green' : 'amber'}>{custody.auto_unseal_by_deck ? '开启' : '关闭'}</Badge></div>
                  {custody.unseal_suppressed_reason && (
                    <div className="rounded bg-amber-50 p-2 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
                      抑制原因：{custody.unseal_suppressed_reason}
                    </div>
                  )}
                  <div>运维 Token 到期：{fmtTime(custody.admin_token_expires_at)}</div>
                  {isAdmin && (
                    <div className="flex flex-wrap gap-2 pt-2">
                      <Button variant="primary" onClick={() => void apiPost(`/api/v1/vault/${selectedId}/init`, { key_shares: 5, key_threshold: 3 }).then((r) => openTask(r.task.id))}>
                        初始化托管
                      </Button>
                      <Button onClick={() => void apiPost(`/api/v1/vault/${selectedId}/unseal`, {}).then((r) => openTask(r.task.id))}>
                        <Unlock className="h-3.5 w-3.5" /> 全集群解封
                      </Button>
                      <Button variant="danger" onClick={() => void apiPost(`/api/v1/vault/${selectedId}/seal`, {}).then((r) => openTask(r.task.id))}>
                        <Lock className="h-3.5 w-3.5" /> 安全封存
                      </Button>
                      <Button onClick={() => void apiPost(`/api/v1/vault/${selectedId}/rekey`, {}).then((r) => openTask(r.task.id))}>
                        Rekey 轮换
                      </Button>
                      <Button onClick={() => void apiPost(`/api/v1/vault/${selectedId}/custody/recover-token`, {}).then((r) => openTask(r.task.id))}>
                        应急重签运维 Token
                      </Button>
                      <Button
                        onClick={() =>
                          setPwAction({
                            title: '导出 Vault 离线紧急备份 (.ndvkb)',
                            run: async (pw) => {
                              await apiDownload(`/api/v1/vault/${selectedId}/custody/backup`, { current_password: pw, passphrase: pw }, `${cluster.name}.ndvkb`);
                            },
                          })
                        }
                      >
                        导出离线备份
                      </Button>
                    </div>
                  )}
                </div>
              </Card>

              <Card title="Unseal Key 代际历史">
                {gens.length === 0 ? (
                  <EmptyState text="暂无密钥代际" />
                ) : (
                  <div className="space-y-2 text-xs">
                    {gens.map((g) => (
                      <div key={g.generation} className="flex items-center justify-between rounded border border-slate-200 p-2 dark:border-slate-800">
                        <span>代际 #{g.generation}（{g.key_threshold}/{g.key_shares}）</span>
                        <Badge tone={statusTone(g.state)}>{g.state}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          )}

          {tab === 'snapshots' && (
            <Card
              title="Raft 快照管理"
              actions={
                isAdmin && (
                  <Button size="sm" variant="primary" onClick={() => void apiPost(`/api/v1/clusters/${selectedId}/snapshots`).then((r) => openTask(r.task.id))}>
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
                  <Input label="归档口令" type="password" value={snapPass} onChange={(e) => setSnapPass(e.target.value)} />
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
                        <Button size="sm" onClick={() => void apiDelete(`/api/v1/clusters/${selectedId}/snapshots/${sn.id}`).then(() => loadDetail())}>删除</Button>
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
                    {auths.map((a, i) => <Badge key={i}>{a.path || a.type}</Badge>)}
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
                        void apiPut(`/api/v1/vault/${selectedId}/policies/${encodeURIComponent(policyEdit.name)}`, { rules: policyEdit.rules })
                          .then(() => { setNotice('Policy 已保存'); return loadManage(); })
                          .catch((ex) => setErr(ex.message))
                      }
                    >
                      保存 Policy
                    </Button>
                  )}
                </div>
              </Card>

              <Card title="KV v2 Secret 浏览">
                <div className="space-y-3 text-xs">
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
                            .then((r) => setKvItem({ path: full, data: JSON.stringify(r.secret?.data || r.secret, null, 2) }))
                            .catch((ex) => setErr(ex.message));
                        }}
                      >
                        {k}
                      </Button>
                    ))}
                  </div>
                  {isAdmin && kvItem && (
                    <div className="space-y-2 border-t border-slate-200 pt-2 dark:border-slate-800">
                      <div className="font-mono font-semibold">{kvItem.path}</div>
                      <CodeEditor value={kvItem.data} onChange={(v) => setKvItem({ ...kvItem, data: v })} height="180px" />
                      <Button
                        variant="primary"
                        onClick={() => {
                          try {
                            const parsed = JSON.parse(kvItem.data);
                            void apiPut(`/api/v1/vault/${selectedId}/kv/item?mount=${encodeURIComponent(kvMount)}&path=${encodeURIComponent(kvItem.path)}`, { data: parsed })
                              .then(() => setNotice('KV 已更新'))
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

      <Modal open={showCreate} title="新建 Vault 集群" onClose={() => setShowCreate(false)}>
        <form onSubmit={createCluster} className="space-y-3 text-xs">
          <Input label="集群名称" required value={cForm.name} onChange={(e) => setCForm({ ...cForm, name: e.target.value })} />
          <Select label="部署模式" value={cForm.mode} onChange={(e) => setCForm({ ...cForm, mode: e.target.value })}>
            <option value="cluster">Raft HA 集群</option>
            <option value="single">单机模式</option>
          </Select>
          <Input label="统一业务入口 URL（可选）" value={cForm.public_api_url} onChange={(e) => setCForm({ ...cForm, public_api_url: e.target.value })} />
          <div>
            <div className="mb-1 font-medium">选择节点</div>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded border border-slate-200 p-2 dark:border-slate-800">
              {nodes.map((n) => (
                <label key={n.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={cForm.node_ids.includes(n.id)}
                    onChange={(e) =>
                      setCForm({
                        ...cForm,
                        node_ids: e.target.checked
                          ? [...cForm.node_ids, n.id]
                          : cForm.node_ids.filter((x) => x !== n.id),
                      })
                    }
                  />
                  <span>{n.name} ({n.host})</span>
                </label>
              ))}
            </div>
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
