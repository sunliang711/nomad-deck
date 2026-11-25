import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lock, Plus, RefreshCw, Unlock } from 'lucide-react';
import { apiDelete, apiDownload, apiGet, apiPost, apiPut, apiUpload, fmtBytes, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOpsDrawer } from '../lib/opsDrawer';
import {
  Badge, Button, Card, EmptyState, ErrorAlert, Input, MaskedSecret, Modal, PasswordConfirmModal, SecretInput, SectionTabs, Select, TermLabel, statusTone,
} from '../components/UI';
import { ClusterOpsSection } from '../components/ClusterOpsSection';
import { CodeEditor } from '../components/CodeEditor';

export function VaultPage() {
  const { isAdmin } = useAuth();
  const { openTask, openNodeLogs } = useOpsDrawer();
  const [searchParams] = useSearchParams();
  const queryId = searchParams.get('id') || '';
  const [clusters, setClusters] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState('');
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
  const [notice, setNotice] = useState('');
  const [rootToken, setRootToken] = useState('');

  // Create wizard
  const [showCreate, setShowCreate] = useState(false);
  const [cForm, setCForm] = useState({ name: '', mode: 'cluster', public_api_url: '', node_ids: [] as string[] });
  const [deployVer, setDeployVer] = useState('latest');
  const [useProxy, setUseProxy] = useState(false);
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
      setUseProxy(Boolean(r.settings?.['proxy.use_for_releases']));
    }).catch((ex) => setErr(ex.message));
  }, []);

  useEffect(() => {
    setRootToken('');
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
    if (selectedId && tab === 'manage') void loadManage();
  }, [selectedId, tab, loadManage]);

  const cluster = clusters.find((c) => c.id === selectedId);
  const clusterNodes = status?.nodes || [];
  const custody = custodyData || {};

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
              { id: 'custody', label: '初始化与密钥托管', tip: '控制面托管 Vault Unseal Key（Shamir 门限分片）与短时效运维 Token，支持自动解封、Rekey 轮换及签发临时 Root Token。' },
              { id: 'snapshots', label: `Raft 快照 (${snapshots.length})`, tip: '对 Vault Integrated Storage (Raft) 后端状态执行一致性快照备份与在线恢复。' },
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
                setUseProxy={setUseProxy}
                confirmSwap={deployConfirmSwap}
                setConfirmSwap={setDeployConfirmSwap}
                onDeploy={() =>
                  void apiPost(`/api/v1/clusters/${selectedId}/deploy`, { version: deployVer.trim() || 'latest', use_proxy: useProxy, confirm_swap: deployConfirmSwap })
                    .then((r) => r.task?.id && openTask(r.task.id, '部署 Vault'))
                    .catch((ex) => setErr(ex.message))
                }
                onUpgrade={() =>
                  void apiPost(`/api/v1/clusters/${selectedId}/upgrade`, { version: upVer.trim() || 'latest', use_proxy: useProxy, confirm: true })
                    .then((r) => r.task?.id && openTask(r.task.id, '滚动升级 Vault'))
                    .catch((ex) => setErr(ex.message))
                }
                onRenewCerts={() =>
                  void apiPost(`/api/v1/clusters/${selectedId}/certs/renew`, {})
                    .then((r) => r.task?.id && openTask(r.task.id))
                    .catch((ex) => setErr(ex.message))
                }
                onRotateCA={() =>
                  setPwAction({
                    title: '确认轮换 Vault 集群 CA',
                    run: async (pw) => {
                      const r = await apiPost(`/api/v1/clusters/${selectedId}/ca/rotate`, { current_password: pw });
                      if (r.task?.id) openTask(r.task.id, '轮换 Vault CA');
                    },
                  })
                }
                onDoctor={() =>
                  void apiPost(`/api/v1/clusters/${selectedId}/doctor`, {})
                    .then((r) => setNotice(r.report?.summary || 'Doctor 完成'))
                    .catch((ex) => setErr(ex.message))
                }
                onReconcile={() =>
                  void apiPost(`/api/v1/clusters/${selectedId}/reconcile`, {})
                    .then((r) => setNotice(r.report?.message || '已核对'))
                    .catch((ex) => setErr(ex.message))
                }
                onOpenJoin={() => { setJoinNodeId(''); setConfirmSwap(false); setShowJoin(true); }}
                onOpenLogs={(n) => openNodeLogs(selectedId, n.node_id, `Vault 日志: ${n.name}`)}
                onCheckGate={(n) =>
                  void apiGet(`/api/v1/clusters/${selectedId}/gate?node_id=${n.node_id}`)
                    .then((r) => setGateView(r.gate))
                    .catch((ex) => setErr(ex.message))
                }
                onRestartNode={(n) =>
                  void apiPost(`/api/v1/clusters/${selectedId}/nodes/${n.node_id}/service/restart`, {})
                    .then((r) => r.task?.id && openTask(r.task.id))
                    .catch((ex) => setErr(ex.message))
                }
                onRemoveNode={(n) =>
                  void apiPost(`/api/v1/clusters/${selectedId}/nodes/${n.node_id}/remove`, {})
                    .then((r) => r.task?.id && openTask(r.task.id))
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

          {tab === 'custody' && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <Card title="托管状态与控制">
                <div className="space-y-3 text-xs">
                  <div><TermLabel term="当前代际" tip="每次执行 Rekey 会生成新的密钥代际（Generation），旧代际历史仅保留审计轨迹。" />：{custody.seal_generation ?? '-'}</div>
                  <div>
                    <TermLabel term="自动解封" tip="开启后控制面在巡检发现 Vault 节点被密封时自动下发托管分片完成 Unseal。" />：
                    <Badge tone={custody.auto_unseal_by_deck ? 'green' : 'amber'}>{custody.auto_unseal_by_deck ? '开启' : '关闭'}</Badge>
                  </div>
                  {isAdmin && <Button size="sm" onClick={() => void apiPut(`/api/v1/vault/${selectedId}/custody`, { auto_unseal_by_deck: !custody.auto_unseal_by_deck }).then(() => loadDetail()).catch((ex) => setErr(ex.message))}>{custody.auto_unseal_by_deck ? '关闭自动解封' : '开启自动解封'}</Button>}
                  {custody.unseal_suppressed_reason && (
                    <div className="rounded bg-amber-50 p-2 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
                      抑制原因：{custody.unseal_suppressed_reason}
                      {isAdmin && <Button size="sm" onClick={() => setPwAction({ title: '解除自动解封抑制', run: async (pw) => { await apiPut(`/api/v1/vault/${selectedId}/custody`, { clear_suppression: true, current_password: pw }); await loadDetail(); } })}>解除抑制</Button>}
                    </div>
                  )}
                  <div><TermLabel term="运维 Token 到期" tip="控制面持有的定期续期管理员 Token（非永久 Root Token），用于日常策略/KV 管理。" />：{fmtTime(custody.admin_token_expires_at)}</div>
                  {isAdmin && (
                    <div className="flex flex-wrap gap-2 pt-2">
                      <Button variant="primary" onClick={() => void apiPost(`/api/v1/vault/${selectedId}/init`, { key_shares: 5, key_threshold: 3 }).then((r) => r.task?.id && openTask(r.task.id)).catch((ex) => setErr(ex.message))}>
                        初始化托管
                      </Button>
                      <Button onClick={() => void apiPost(`/api/v1/vault/${selectedId}/unseal`, {}).then((r) => r.task?.id && openTask(r.task.id)).catch((ex) => setErr(ex.message))}>
                        <Unlock className="h-3.5 w-3.5" /> 全集群解封
                      </Button>
                      <Button variant="danger" onClick={() => void apiPost(`/api/v1/vault/${selectedId}/seal`, {}).then((r) => r.task?.id && openTask(r.task.id)).catch((ex) => setErr(ex.message))}>
                        <Lock className="h-3.5 w-3.5" /> 安全封存
                      </Button>
                      <Button
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
                        onClick={() =>
                          setPwAction({
                            title: '签发临时 Root Token（使用托管解封密钥重建）',
                            run: async (pw) => {
                              const r = await apiPost(`/api/v1/vault/${selectedId}/root-token`, { current_password: pw });
                              setRootToken(r.root_token || '');
                              setNotice('已签发临时 Root Token，使用完毕后请及时点击“吊销 Root Token”。');
                            },
                          })
                        }
                      >
                        签发临时 Root Token
                      </Button>
                      <Button
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
                  )}

                  {rootToken && (
                    <div className="space-y-2 pt-2">
                      <MaskedSecret
                        value={rootToken}
                        label={<TermLabel term="临时 Root Token（控制面不落盘保存，请用后及时吊销）" tip="通过 Vault sys/generate-root 与托管 Unseal Key 动态重建的 Root Token，可用于登录 Vault 原生 Web UI 或执行高危恢复操作。" />}
                      />
                      {isAdmin && (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() =>
                              void apiPost(`/api/v1/vault/${selectedId}/root-token/revoke`, { token: rootToken })
                                .then(() => {
                                  setRootToken('');
                                  setNotice('临时 Root Token 已向 Vault 吊销');
                                })
                                .catch((ex) => setErr(ex.message))
                            }
                          >
                            吊销 Root Token
                          </Button>
                          <Button size="sm" onClick={() => setRootToken('')}>隐藏卡片</Button>
                        </div>
                      )}
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
                        <Button size="sm" onClick={() => void apiDelete(`/api/v1/clusters/${selectedId}/snapshots/${sn.id}`).then(() => loadDetail()).catch((ex) => setErr(ex.message))}>删除</Button>
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
                        {isAdmin && a.type !== 'token' && <Button size="sm" variant="danger" onClick={() => void apiDelete(`/api/v1/vault/${selectedId}/auth?path=${encodeURIComponent(a.path)}`).then(() => loadManage()).catch((ex) => setErr(ex.message))}>停用 {a.path}</Button>}
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
                          .then(() => { setNotice('Policy 已保存'); return loadManage(); })
                          .catch((ex) => setErr(ex.message))
                      }
                    >
                      保存 Policy
                    </Button>
                  )}
                  {isAdmin && policyEdit.name && !['root', 'default', 'nomad-deck-admin'].includes(policyEdit.name) && <Button variant="danger" onClick={() => void apiDelete(`/api/v1/vault/${selectedId}/policies/${encodeURIComponent(policyEdit.name)}`).then(() => { setPolicyEdit({ name: '', rules: '' }); return loadManage(); }).catch((ex) => setErr(ex.message))}>删除 Policy</Button>}
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
                                setNotice(kvItem.cas === 0 ? 'Secret 已创建' : 'KV 已更新');
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
                setNotice('KV v2 挂载已启用');
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
          onSubmit={(e) => {
            e.preventDefault();
            void apiPost(`/api/v1/clusters/${selectedId}/nodes/${joinNodeId}/join`, { use_proxy: useProxy, confirm_swap: confirmSwap })
              .then((r) => { setShowJoin(false); if (r.task?.id) openTask(r.task.id, '扩容 Vault 节点'); })
              .catch((ex) => setErr(ex.message));
          }}
        >
          <ErrorAlert message={err} onClose={() => setErr('')} />
          <Select label="待加入主机" required value={joinNodeId} onChange={(e) => setJoinNodeId(e.target.value)}>
            <option value="">选择主机</option>
            {nodes.filter((n) => !clusterNodes.some((m: any) => m.node_id === n.id)).map((n) => <option key={n.id} value={n.id}>{n.name} ({n.host})</option>)}
          </Select>
          <label className="flex items-center gap-2"><input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} />使用系统代理</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={confirmSwap} onChange={(e) => setConfirmSwap(e.target.checked)} />确认未加密 Swap 风险</label>
          <p className="text-slate-500">加入主机使用集群当前版本，完成 Raft 加入与解封后核对投票成员状态。</p>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setShowJoin(false)}>取消</Button>
            <Button type="submit" variant="primary">确认扩容</Button>
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
    </div>
  );
}
