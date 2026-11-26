import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, RefreshCw, Search } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut, openSSE } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, EmptyState, ErrorAlert, Input, Modal, SectionTabs, Select, StatusBadge, TermLabel } from './UI';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog';
import { CodeEditor } from './CodeEditor';

const VALID_SUB_TABS = new Set(['clients', 'servers', 'topology', 'storage', 'variables', 'evaluations']);
const NAMESPACE_SCOPED_TABS = new Set(['storage', 'variables', 'evaluations']);

export function NomadWorkbench({
  clusterId,
  initialNamespace,
  initialSubTab,
}: {
  clusterId: string;
  initialNamespace?: string;
  initialSubTab?: string;
}) {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const askConfirm = useConfirm();

  const [subTab, setSubTab] = useState(() =>
    initialSubTab && VALID_SUB_TABS.has(initialSubTab) ? initialSubTab : 'clients',
  );
  const [namespace, setNamespace] = useState(initialNamespace || 'default');
  const [namespaces, setNamespaces] = useState<any[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [searchRes, setSearchRes] = useState<any>(null);

  const [clients, setClients] = useState<any[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [topology, setTopology] = useState<any>(null);
  const [volumes, setVolumes] = useState<any[]>([]);
  const [plugins, setPlugins] = useState<any[]>([]);
  const [variables, setVariables] = useState<any[]>([]);
  const [varEdit, setVarEdit] = useState<{ namespace: string; path: string; items: string; modifyIndex?: number } | null>(null);
  const [evaluations, setEvaluations] = useState<any[]>([]);
  const [err, setErr] = useState('');

  const loadNamespaces = useCallback(async () => {
    try {
      const res = await apiGet(`/api/v1/nomad/${clusterId}/namespaces`);
      setNamespaces(res.namespaces || []);
    } catch {
      // Cluster might not be initialized yet.
    }
  }, [clusterId]);

  const loadInfraViews = useCallback(
    async (view: string) => {
      setErr('');
      try {
        if (view === 'clients') {
          const res = await apiGet(`/api/v1/nomad/${clusterId}/clients`);
          setClients(res.clients || []);
        } else if (view === 'servers') {
          const res = await apiGet(`/api/v1/nomad/${clusterId}/servers`);
          setServers(res.servers || res || []);
        } else if (view === 'topology') {
          const res = await apiGet(`/api/v1/nomad/${clusterId}/topology`);
          setTopology(res.topology || res);
        } else if (view === 'storage') {
          const [vRes, pRes] = await Promise.all([
            apiGet(`/api/v1/nomad/${clusterId}/volumes`),
            apiGet(`/api/v1/nomad/${clusterId}/plugins`),
          ]);
          setVolumes(vRes.csi || []);
          setPlugins(pRes.plugins || []);
        } else if (view === 'variables') {
          const res = await apiGet(`/api/v1/nomad/${clusterId}/variables`);
          setVariables(res.variables || []);
        } else if (view === 'evaluations') {
          const res = await apiGet(`/api/v1/nomad/${clusterId}/evaluations`);
          setEvaluations(res.evaluations || []);
        }
      } catch (ex: any) {
        setErr(ex?.message || '加载视图失败');
      }
    },
    [clusterId],
  );

  useEffect(() => {
    void loadNamespaces();
  }, [loadNamespaces]);

  useEffect(() => {
    if (initialSubTab && VALID_SUB_TABS.has(initialSubTab)) {
      setSubTab(initialSubTab);
    }
  }, [initialSubTab]);

  useEffect(() => {
    void loadInfraViews(subTab);
  }, [subTab, loadInfraViews]);

  useEffect(() => {
    const stop = openSSE(`/api/v1/nomad/${clusterId}/watch?topics=evaluations,nodes`, {
      onEvent: (ev) => {
        if (ev === 'change' || ev === 'watch' || ev === 'update') {
          if (subTab === 'clients' || subTab === 'evaluations' || subTab === 'topology') {
            void loadInfraViews(subTab);
          }
        }
      },
    });
    return stop;
  }, [clusterId, subTab, loadInfraViews]);

  const openJobRuntime = (jobId: string, jobNs?: string) => {
    const ns = jobNs || (namespace === '*' ? 'default' : namespace) || 'default';
    navigate(`/jobs?cluster_id=${encodeURIComponent(clusterId)}&namespace=${encodeURIComponent(ns)}&job=${encodeURIComponent(jobId)}&tab=runtime`);
  };

  const filteredVolumes = namespace === '*'
    ? volumes
    : volumes.filter((v) => (v.Namespace || v.namespace || 'default') === namespace);
  const filteredVariables = namespace === '*'
    ? variables
    : variables.filter((v) => (v.namespace || 'default') === namespace);
  const filteredEvaluations = namespace === '*'
    ? evaluations
    : evaluations.filter((ev) => (ev.Namespace || 'default') === namespace);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <SectionTabs
          variant="underline"
          tabs={[
            { id: 'clients', label: 'Clients', title: '运行任务容器/Allocations 的计算工作节点，可执行调度启用/禁用与 Drain 排空' },
            { id: 'servers', label: 'Servers', title: '通过 Raft 共识维护集群状态和执行调度决策的控制面节点' },
            { id: 'topology', label: '拓扑容量', title: '按数据中心与节点汇总的 CPU/内存分配率与剩余调度容量视图' },
            { id: 'storage', label: '存储 / CSI', title: 'Container Storage Interface 持久化卷及对应存储插件（如 Ceph/NFS/EBS）' },
            { id: 'variables', label: 'Variables', title: 'Nomad 内置键值密钥/配置存储，支持带 CAS（乐观锁版本号）的原子更新' },
            { id: 'evaluations', label: 'Evaluations', title: '每次 Job 变更、节点故障或周期触发产生的调度计算请求，用于决定 Allocation 迁移' },
          ]}
          active={subTab}
          onChange={setSubTab}
        />

        <div className="flex flex-wrap items-center gap-2">
          {NAMESPACE_SCOPED_TABS.has(subTab) && (
            <div className="w-40">
              <Select
                aria-label="工作台 Namespace"
                size="sm"
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
              >
                <option value="*">全部 Namespace (*)</option>
                {(namespaces.length ? namespaces : [{ name: 'default' }]).map((ns: any) => {
                  const nsName = ns.name || ns.Name;
                  return (
                    <option key={nsName} value={nsName}>
                      {nsName}
                    </option>
                  );
                })}
              </Select>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!searchQ.trim()) return;
              void apiGet(`/api/v1/nomad/${clusterId}/search?q=${encodeURIComponent(searchQ.trim())}`)
                .then((r) => setSearchRes(r))
                .catch((ex) => setErr(ex.message));
            }}
            className="flex items-center gap-1.5"
          >
            <input
              placeholder="集群全局搜索…"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              className="h-8 w-40 rounded-lg border border-[#dce3ee] bg-white px-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
            <Button size="sm" type="submit" aria-label="执行全局搜索">
              <Search className="h-3.5 w-3.5" />
            </Button>
          </form>
          <Link
            to={`/jobs?cluster_id=${encodeURIComponent(clusterId)}`}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50/70 px-2.5 text-xs font-medium text-indigo-700 transition hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-300 dark:hover:bg-indigo-500/25"
          >
            <span>管理 Jobs</span>
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {subTab === 'clients' && (
        <Card
          title={<TermLabel term="Nomad Client 节点" tip="工作负载执行节点；Drain 操作会平滑驱逐节点上的运行实例并阻止新调度。" />}
          actions={
            <Button size="sm" onClick={() => void loadInfraViews('clients')}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          }
        >
          {clients.length === 0 ? (
            <EmptyState title="暂无 Client 节点" description="当节点以 Client 或 Server + Client 模式加入集群后将在此显示。" />
          ) : (
            <div className="space-y-2.5 text-xs">
              {clients.map((c) => (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3.5 dark:border-slate-800"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-slate-900 dark:text-slate-100">{c.name}</span>
                      <span className="font-mono text-slate-500">({(c.id || '').slice(0, 8)})</span>
                    </div>
                    <div className="text-slate-500 dark:text-slate-400 mt-1 flex flex-wrap gap-2">
                      <span>调度：{c.scheduling_eligibility === 'eligible' ? '允许调度' : '不可调度'}</span>
                      <span>·</span>
                      <span>Drain：{c.drain ? '排空中' : '否'}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <StatusBadge value={c.status} />
                    {isAdmin && (
                      <>
                        <Button
                          size="sm"
                          onClick={() =>
                            void apiPost(`/api/v1/nomad/${clusterId}/clients/${c.id}/eligibility`, {
                              eligible: c.scheduling_eligibility !== 'eligible',
                            })
                              .then(() => {
                                toast.success(c.scheduling_eligibility === 'eligible' ? '已设为不可调度' : '已恢复可调度');
                                return loadInfraViews('clients');
                              })
                              .catch((ex) => setErr(ex.message))
                          }
                        >
                          {c.scheduling_eligibility === 'eligible' ? '设为不可调度' : '恢复可调度'}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger-outline"
                          onClick={() =>
                            void askConfirm(
                              c.drain
                                ? `确定要取消节点 ${c.name} 的 Drain 状态吗？`
                                : `确定要对节点 ${c.name} 执行 Drain 吗？将驱逐其上运行实例。`,
                              {
                                title: c.drain ? '取消节点 Drain' : '启用节点 Drain',
                                confirmText: c.drain ? '确认取消' : '确认 Drain',
                                danger: !c.drain,
                              },
                            )
                              .then((ok) =>
                                ok
                                  ? apiPost(`/api/v1/nomad/${clusterId}/clients/${c.id}/drain`, {
                                      cancel: Boolean(c.drain),
                                    }).then(() => {
                                      toast.success(c.drain ? '已取消 Drain' : '已开启 Drain');
                                      return loadInfraViews('clients');
                                    })
                                  : undefined,
                              )
                              .catch((ex) => setErr(ex.message))
                          }
                        >
                          {c.drain ? '取消 Drain' : 'Drain'}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {subTab === 'servers' && (() => {
        const ap = (servers as any)?.autopilot || {};
        const apServers: any[] = Array.isArray(ap.Servers) ? ap.Servers : Array.isArray(servers) ? servers : [];
        const serfMembers: any[] = Array.isArray((servers as any)?.members?.Members) ? (servers as any).members.Members : [];
        return (
          <Card
            title="Nomad Server 成员"
            actions={
              <Button size="sm" onClick={() => void loadInfraViews('servers')}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            }
          >
            <div className="space-y-4 text-xs">
              {ap.Healthy !== undefined && (
                <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200/80 bg-slate-50/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/40">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="text-slate-500">Autopilot 状态：</span>
                    <StatusBadge value={ap.Healthy ? 'healthy' : 'degraded'} />
                  </span>
                  <span>
                    <span className="text-slate-500">可容忍节点故障：</span>
                    <strong className="font-mono">{ap.FailureTolerance ?? 0}</strong> 台
                  </span>
                  <span>
                    <span className="text-slate-500">Server 总数：</span>
                    <strong className="font-mono">{apServers.length || serfMembers.length}</strong> 台
                  </span>
                </div>
              )}

              {apServers.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                        <th className="py-2 pr-3">节点名称</th>
                        <th className="py-2 pr-3">RPC 地址</th>
                        <th className="py-2 pr-3">角色</th>
                        <th className="py-2 pr-3">Serf / 健康</th>
                        <th className="py-2 pr-3">版本</th>
                        <th className="py-2 text-right">Raft Index</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {apServers.map((s: any, idx: number) => (
                        <tr key={s.ID || s.Name || idx}>
                          <td className="py-2.5 pr-3 font-medium text-slate-900 dark:text-slate-100">{s.Name || s.ID}</td>
                          <td className="py-2.5 pr-3 font-mono text-slate-600 dark:text-slate-300">{s.Address || '-'}</td>
                          <td className="py-2.5 pr-3">
                            <div className="flex flex-wrap gap-1">
                              {s.Leader && <Badge tone="blue">Leader</Badge>}
                              {!s.Leader && <Badge>Follower</Badge>}
                              {s.Voter && <Badge tone="green">Voter</Badge>}
                            </div>
                          </td>
                          <td className="py-2.5 pr-3">
                            <div className="flex items-center gap-1.5">
                              <StatusBadge value={s.SerfStatus || 'unknown'} />
                              {s.Healthy !== undefined && <StatusBadge value={s.Healthy ? 'healthy' : 'degraded'} />}
                            </div>
                          </td>
                          <td className="py-2.5 pr-3 font-mono">{s.Version || '-'}</td>
                          <td className="py-2.5 text-right font-mono tabular-nums">{s.LastIndex ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState title="暂无 Server 信息" description="集群部署完成后将展示 Autopilot 与 Raft 成员状态。" />
              )}

              <details className="rounded-lg border border-slate-200/80 dark:border-slate-800 p-2.5">
                <summary className="cursor-pointer text-slate-500 hover:text-indigo-600">查看原始 JSON 数据</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-950 p-3 font-mono text-xs text-slate-100">
                  {JSON.stringify(servers, null, 2)}
                </pre>
              </details>
            </div>
          </Card>
        );
      })()}

      {subTab === 'topology' && (() => {
        const totals = topology?.totals || {};
        const dcs: Record<string, any[]> = topology?.datacenters || {};
        const cpuTotal = Number(totals.cpu_total_mhz || 0);
        const cpuUsed = Number(totals.cpu_allocated_mhz || 0);
        const memTotal = Number(totals.memory_total_mb || 0);
        const memUsed = Number(totals.memory_allocated_mb || 0);
        const cpuPct = cpuTotal > 0 ? Math.min(100, Math.round((cpuUsed / cpuTotal) * 100)) : 0;
        const memPct = memTotal > 0 ? Math.min(100, Math.round((memUsed / memTotal) * 100)) : 0;
        return (
          <Card
            title="拓扑容量视图"
            actions={
              <Button size="sm" onClick={() => void loadInfraViews('topology')}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            }
          >
            <div className="space-y-5 text-xs">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-2">
                  <div className="flex justify-between">
                    <span className="font-semibold text-slate-800 dark:text-slate-100">集群总 CPU 分配</span>
                    <span className="font-mono">
                      {cpuUsed} / {cpuTotal} MHz ({cpuPct}%)
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                    <div className="h-full bg-indigo-500 transition-all" style={{ width: `${cpuPct}%` }} />
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-2">
                  <div className="flex justify-between">
                    <span className="font-semibold text-slate-800 dark:text-slate-100">集群总内存分配</span>
                    <span className="font-mono">
                      {memUsed} / {memTotal} MB ({memPct}%)
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                    <div className="h-full bg-sky-500 transition-all" style={{ width: `${memPct}%` }} />
                  </div>
                </div>
              </div>

              {Object.entries(dcs).map(([dc, dcNodes]) => (
                <div key={dc} className="space-y-2.5">
                  <div className="font-semibold text-sm text-slate-800 dark:text-slate-100">
                    数据中心：{dc} <span className="text-xs font-normal text-slate-500">({dcNodes.length} 个 Client)</span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {dcNodes.map((n: any) => (
                      <div key={n.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <span className="font-semibold text-slate-900 dark:text-slate-100">{n.name}</span>
                            <span className="ml-2 font-mono text-[11px] text-slate-500">{(n.id || '').slice(0, 8)}</span>
                          </div>
                          <StatusBadge value={n.status} />
                        </div>
                        <div className="flex flex-wrap gap-4 text-slate-500 dark:text-slate-400">
                          <span>
                            总 CPU：<strong className="font-mono text-slate-700 dark:text-slate-200">{n.cpu_total_mhz ?? 0} MHz</strong>
                          </span>
                          <span>
                            总内存：<strong className="font-mono text-slate-700 dark:text-slate-200">{n.memory_total_mb ?? 0} MB</strong>
                          </span>
                          <span>
                            运行 Allocation：<strong className="font-mono text-slate-700 dark:text-slate-200">{(n.allocations || []).length}</strong>
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <details className="rounded-lg border border-slate-200/80 dark:border-slate-800 p-2.5">
                <summary className="cursor-pointer text-slate-500 hover:text-indigo-600">查看原始 JSON 数据</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-950 p-3 font-mono text-xs text-slate-100">
                  {JSON.stringify(topology, null, 2)}
                </pre>
              </details>
            </div>
          </Card>
        );
      })()}

      {subTab === 'storage' && (
        <Card
          title={<TermLabel term="CSI 卷与存储插件" tip="通过 Container Storage Interface (CSI) 对接外部持久化块/文件存储。" />}
          actions={
            <Button size="sm" onClick={() => void loadInfraViews('storage')}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          }
        >
          <div className="space-y-3 text-xs">
            <div className="text-slate-500">
              CSI 卷数量：<strong className="font-mono text-slate-800 dark:text-slate-200">{filteredVolumes.length}</strong> · 插件数量：
              <strong className="font-mono text-slate-800 dark:text-slate-200">{plugins.length}</strong>
            </div>
            {filteredVolumes.length === 0 ? (
              <EmptyState title="暂无已注册 CSI 卷" description="如需持久化块存储或分布式文件系统，部署 CSI 插件并注册卷后会在此展示。" />
            ) : (
              filteredVolumes.map((v) => {
                const vid = v.ID || v.id;
                const vns = v.Namespace || v.namespace || 'default';
                return (
                  <div
                    key={`${vns}:${vid}`}
                    className="flex items-center justify-between rounded-xl border border-slate-200 p-3 dark:border-slate-800"
                  >
                    <span className="font-mono">
                      {vid} ({v.Name || v.name || vns})
                    </span>
                    {isAdmin && (
                      <Button
                        size="sm"
                        variant="danger-outline"
                        onClick={() =>
                          void askConfirm(`确定要注销 CSI 卷「${vid}」吗？`, {
                            title: '注销 CSI 卷',
                            confirmText: '确认注销',
                            danger: true,
                          })
                            .then((ok) =>
                              ok
                                ? apiDelete(`/api/v1/nomad/${clusterId}/volumes/${encodeURIComponent(vid)}?namespace=${encodeURIComponent(vns)}`).then(() => {
                                    toast.success('CSI 卷已注销');
                                    return loadInfraViews('storage');
                                  })
                                : undefined,
                            )
                            .catch((ex) => setErr(ex.message))
                        }
                      >
                        注销
                      </Button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </Card>
      )}

      {subTab === 'variables' && (
        <Card
          title={<TermLabel term="Nomad Variables" tip="路径隔离的机密变量（按 CAS ModifyIndex 控制并发写冲突），可在 Job template 中注入。" />}
          actions={
            isAdmin && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setVarEdit({ namespace: namespace === '*' ? 'default' : namespace, path: '', items: '{}' })}
              >
                新建 Variable
              </Button>
            )
          }
        >
          {filteredVariables.length === 0 ? (
            <EmptyState title="暂无 Nomad Variables" description="适用于轻量化配置存储；跨集群或高敏密钥推荐使用 Vault 联动。" />
          ) : (
            <div className="space-y-2 text-xs">
              {filteredVariables.map((v) => (
                <div
                  key={`${v.namespace}:${v.path}`}
                  className="flex items-center justify-between rounded-xl border border-slate-200 p-3 dark:border-slate-800"
                >
                  <span className="font-mono">
                    {v.namespace} / {v.path}
                  </span>
                  {isAdmin && (
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        onClick={() =>
                          void apiPost(
                            `/api/v1/nomad/${clusterId}/variables/item/reveal?path=${encodeURIComponent(v.path)}&namespace=${encodeURIComponent(v.namespace)}`,
                            {},
                          )
                            .then((r) =>
                              setVarEdit({
                                namespace: r.variable?.namespace || v.namespace,
                                path: r.variable?.path || v.path,
                                items: JSON.stringify(r.variable?.items || {}, null, 2),
                                modifyIndex: r.variable?.modify_index,
                              }),
                            )
                            .catch((ex) => setErr(ex.message))
                        }
                      >
                        查看原文 / 编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="danger-outline"
                        onClick={() =>
                          void askConfirm(`确定要删除变量「${v.namespace} / ${v.path}」吗？`, {
                            title: '删除 Variable',
                            confirmText: '确认删除',
                            danger: true,
                          })
                            .then((ok) =>
                              ok
                                ? apiDelete(
                                    `/api/v1/nomad/${clusterId}/variables/item?path=${encodeURIComponent(v.path)}&namespace=${encodeURIComponent(v.namespace)}&cas=${v.modify_index}`,
                                  ).then(() => {
                                    toast.success('Variable 已删除');
                                    return loadInfraViews('variables');
                                  })
                                : undefined,
                            )
                            .catch((ex) => setErr(ex.message))
                        }
                      >
                        删除
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {subTab === 'evaluations' && (
        <Card
          title="全局 Evaluations"
          description="点击 Job 名称将跳转至「Nomad Job 中心」查看对应任务的完整运行态与日志"
          actions={
            <Button size="sm" onClick={() => void loadInfraViews('evaluations')}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          }
        >
          {filteredEvaluations.length === 0 ? (
            <EmptyState title="暂无调度评估记录" description="提交或变更 Job 时，Nomad 产生的调度计算记录会展示在这里。" />
          ) : (
            <div className="space-y-3 text-xs">
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                      <th className="py-2 pr-3">Eval ID</th>
                      <th className="py-2 pr-3">Job</th>
                      <th className="py-2 pr-3">触发原因</th>
                      <th className="py-2 pr-3">状态</th>
                      <th className="py-2">说明</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {filteredEvaluations.slice(0, 30).map((ev: any) => (
                      <tr key={ev.ID}>
                        <td className="py-2 pr-3 font-mono">{(ev.ID || '').slice(0, 8)}</td>
                        <td className="py-2 pr-3 font-mono font-medium">
                          {ev.JobID ? (
                            <button
                              type="button"
                              onClick={() => openJobRuntime(ev.JobID, ev.Namespace)}
                              className="inline-flex items-center gap-1 text-left text-indigo-600 hover:underline dark:text-indigo-400"
                            >
                              <span>{ev.JobID}</span>
                              <ArrowUpRight className="h-3 w-3" />
                            </button>
                          ) : (
                            '-'
                          )}
                        </td>
                        <td className="py-2 pr-3">{ev.TriggeredBy || '-'}</td>
                        <td className="py-2 pr-3">
                          <StatusBadge value={ev.Status} />
                        </td>
                        <td className="py-2 text-slate-500">{ev.StatusDescription || (ev.BlockedEval ? '等待资源或约束' : '-')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details className="rounded-lg border border-slate-200/80 dark:border-slate-800 p-2.5">
                <summary className="cursor-pointer text-slate-500 hover:text-indigo-600">查看原始 JSON 数据</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-950 p-3 font-mono text-xs text-slate-100">
                  {JSON.stringify(filteredEvaluations, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </Card>
      )}

      {/* Global Search Result Modal */}
      <Modal
        open={Boolean(searchRes)}
        title={`全局搜索结果${searchQ.trim() ? `：${searchQ.trim()}` : ''}`}
        onClose={() => setSearchRes(null)}
        wide
      >
        {searchRes && (() => {
          const matches = searchRes?.Matches || searchRes?.matches || {};
          const entries = Object.entries<any>(matches).filter(([, list]) => Array.isArray(list) && list.length > 0);
          if (entries.length === 0) {
            return (
              <div className="space-y-2 text-xs text-slate-500">
                <div>未找到匹配项。</div>
                <details>
                  <summary className="cursor-pointer hover:text-indigo-600">查看原始响应</summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-950 p-2 font-mono text-xs text-slate-100">
                    {JSON.stringify(searchRes, null, 2)}
                  </pre>
                </details>
              </div>
            );
          }
          return (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs">
              {entries.map(([kind, list]) => (
                <div key={kind} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-1.5">
                  <div className="font-semibold text-slate-800 dark:text-slate-100">
                    {kind} ({list.length})
                  </div>
                  <ul className="space-y-1 font-mono text-[11px] text-slate-600 dark:text-slate-300">
                    {list.slice(0, 8).map((item: any, idx: number) => {
                      const label = typeof item === 'string' ? item : item.ID || item.Name || JSON.stringify(item);
                      const isJobMatch = kind.toLowerCase() === 'jobs';
                      const jobId = typeof item === 'string' ? item : item.ID || item.Name;
                      const jobNs = (typeof item === 'object' && item?.Namespace) || (namespace === '*' ? 'default' : namespace);
                      return (
                        <li key={idx} className="truncate">
                          {isJobMatch && jobId ? (
                            <button
                              type="button"
                              onClick={() => {
                                setSearchRes(null);
                                openJobRuntime(jobId, jobNs);
                              }}
                              className="inline-flex items-center gap-1 text-left text-indigo-600 hover:underline dark:text-indigo-400"
                            >
                              <span>{label}</span>
                              <ArrowUpRight className="h-3 w-3" />
                            </button>
                          ) : (
                            label
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          );
        })()}
      </Modal>

      <Modal open={Boolean(varEdit)} title="编辑 Nomad Variable" onClose={() => setVarEdit(null)} wide>
        {varEdit && (
          <div className="space-y-3 text-xs">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                label="Namespace"
                value={varEdit.namespace}
                onChange={(e) => setVarEdit({ ...varEdit, namespace: e.target.value })}
              />
              <Input label="Path" value={varEdit.path} onChange={(e) => setVarEdit({ ...varEdit, path: e.target.value })} />
            </div>
            <CodeEditor value={varEdit.items} onChange={(v) => setVarEdit({ ...varEdit, items: v })} height="220px" />
            <Button
              variant="primary"
              onClick={() => {
                try {
                  const items = JSON.parse(varEdit.items);
                  void apiPut(
                    `/api/v1/nomad/${clusterId}/variables/item?path=${encodeURIComponent(varEdit.path)}&namespace=${encodeURIComponent(varEdit.namespace || 'default')}`,
                    {
                      items,
                      cas: varEdit.modifyIndex,
                    },
                  )
                    .then(() => {
                      setVarEdit(null);
                      toast.success('Variable 已保存');
                      return loadInfraViews('variables');
                    })
                    .catch((ex) => setErr(ex.message));
                } catch {
                  setErr('Items 必须是合法 JSON');
                }
              }}
            >
              保存 (CAS)
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
