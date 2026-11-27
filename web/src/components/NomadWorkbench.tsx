import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, RefreshCw, Search } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut, openSSE } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
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
  const { tr } = useI18n();
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
        setErr(ex?.message || tr('加载视图失败', 'Failed to load view'));
      }
    },
    [clusterId, tr],
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
            { id: 'clients', label: 'Clients', title: tr('运行任务容器/Allocations 的计算工作节点，可执行调度启用/禁用与 Drain 排空', 'Worker nodes running allocations; supports scheduling eligibility toggle and Drain') },
            { id: 'servers', label: 'Servers', title: tr('通过 Raft 共识维护集群状态和执行调度决策的控制面节点', 'Control-plane nodes maintaining cluster state via Raft consensus and scheduling') },
            { id: 'topology', label: tr('拓扑容量', 'Topology'), title: tr('按数据中心与节点汇总的 CPU/内存分配率与剩余调度容量视图', 'CPU and memory allocation summary grouped by datacenter and client node') },
            { id: 'storage', label: tr('存储 / CSI', 'Storage / CSI'), title: tr('Container Storage Interface 持久化卷及对应存储插件（如 Ceph/NFS/EBS）', 'Container Storage Interface persistent volumes and storage plugins') },
            { id: 'variables', label: 'Variables', title: tr('Nomad 内置键值密钥/配置存储，支持带 CAS（乐观锁版本号）的原子更新', 'Nomad built-in key-value secret/config store supporting CAS optimistic concurrency') },
            { id: 'evaluations', label: 'Evaluations', title: tr('每次 Job 变更、节点故障或周期触发产生的调度计算请求，用于决定 Allocation 迁移', 'Scheduler evaluation requests triggered by job updates, node failures, or periodic schedules') },
          ]}
          active={subTab}
          onChange={setSubTab}
        />

        <div className="flex flex-wrap items-center gap-2">
          {NAMESPACE_SCOPED_TABS.has(subTab) && (
            <div className="w-40">
              <Select
                aria-label={tr('工作台 Namespace', 'Workbench Namespace')}
                size="sm"
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
              >
                <option value="*">{tr('全部 Namespace (*)', 'All Namespaces (*)')}</option>
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
              placeholder={tr('集群全局搜索…', 'Cluster global search...')}
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              className="h-8 w-40 rounded-lg border border-[#dce3ee] bg-white px-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
            <Button size="sm" type="submit" aria-label={tr('执行全局搜索', 'Run global search')}>
              <Search className="h-3.5 w-3.5" />
            </Button>
          </form>
          <Link
            to={`/jobs?cluster_id=${encodeURIComponent(clusterId)}`}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50/70 px-2.5 text-xs font-medium text-indigo-700 transition hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-300 dark:hover:bg-indigo-500/25"
          >
            <span>{tr('管理 Jobs', 'Manage Jobs')}</span>
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {subTab === 'clients' && (
        <Card
          title={<TermLabel term={tr('Nomad Client 节点', 'Nomad Client Nodes')} tip={tr('工作负载执行节点；Drain 操作会平滑驱逐节点上的运行实例并阻止新调度。', 'Workload execution nodes; Drain gracefully migrates running allocations off the node and prevents new placements.')} />}
          actions={
            <Button size="sm" onClick={() => void loadInfraViews('clients')}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          }
        >
          {clients.length === 0 ? (
            <EmptyState title={tr('暂无 Client 节点', 'No Client Nodes')} description={tr('当节点以 Client 或 Server + Client 模式加入集群后将在此显示。', 'Nodes joined in client or server_client mode will appear here.')} />
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
                      <span>{tr('调度：', 'Eligibility: ')}{c.scheduling_eligibility === 'eligible' ? tr('允许调度', 'Eligible') : tr('不可调度', 'Ineligible')}</span>
                      <span>·</span>
                      <span>Drain: {c.drain ? tr('排空中', 'Draining') : tr('否', 'No')}</span>
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
                                toast.success(c.scheduling_eligibility === 'eligible' ? tr('已设为不可调度', 'Set to Ineligible') : tr('已恢复可调度', 'Set to Eligible'));
                                return loadInfraViews('clients');
                              })
                              .catch((ex) => setErr(ex.message))
                          }
                        >
                          {c.scheduling_eligibility === 'eligible' ? tr('设为不可调度', 'Mark Ineligible') : tr('恢复可调度', 'Mark Eligible')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger-outline"
                          onClick={() =>
                            void askConfirm(
                              c.drain
                                ? tr(`确定要取消节点 ${c.name} 的 Drain 状态吗？`, `Cancel Drain on node ${c.name}?`)
                                : tr(`确定要对节点 ${c.name} 执行 Drain 吗？将驱逐其上运行实例。`, `Drain node ${c.name}? Running allocations will be evicted.`),
                              {
                                title: c.drain ? tr('取消节点 Drain', 'Cancel Node Drain') : tr('启用节点 Drain', 'Enable Node Drain'),
                                confirmText: c.drain ? tr('确认取消', 'Cancel Drain') : tr('确认 Drain', 'Drain'),
                                danger: !c.drain,
                              },
                            )
                              .then((ok) =>
                                ok
                                  ? apiPost(`/api/v1/nomad/${clusterId}/clients/${c.id}/drain`, {
                                      cancel: Boolean(c.drain),
                                    }).then(() => {
                                      toast.success(c.drain ? tr('已取消 Drain', 'Drain cancelled') : tr('已开启 Drain', 'Drain enabled'));
                                      return loadInfraViews('clients');
                                    })
                                  : undefined,
                              )
                              .catch((ex) => setErr(ex.message))
                          }
                        >
                          {c.drain ? tr('取消 Drain', 'Cancel Drain') : 'Drain'}
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
            title={tr('Nomad Server 成员', 'Nomad Server Members')}
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
                    <span className="text-slate-500">{tr('Autopilot 状态：', 'Autopilot Status: ')}</span>
                    <StatusBadge value={ap.Healthy ? 'healthy' : 'degraded'} />
                  </span>
                  <span>
                    <span className="text-slate-500">{tr('可容忍节点故障：', 'Failure Tolerance: ')}</span>
                    <strong className="font-mono">{ap.FailureTolerance ?? 0}</strong> {tr('台', 'nodes')}
                  </span>
                  <span>
                    <span className="text-slate-500">{tr('Server 总数：', 'Total Servers: ')}</span>
                    <strong className="font-mono">{apServers.length || serfMembers.length}</strong> {tr('台', 'nodes')}
                  </span>
                </div>
              )}

              {apServers.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                        <th className="py-2 pr-3">{tr('节点名称', 'Node Name')}</th>
                        <th className="py-2 pr-3">{tr('RPC 地址', 'RPC Address')}</th>
                        <th className="py-2 pr-3">{tr('角色', 'Role')}</th>
                        <th className="py-2 pr-3">{tr('Serf / 健康', 'Serf / Health')}</th>
                        <th className="py-2 pr-3">{tr('版本', 'Version')}</th>
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
                <EmptyState title={tr('暂无 Server 信息', 'No Server Data')} description={tr('集群部署完成后将展示 Autopilot 与 Raft 成员状态。', 'Autopilot and Raft member details will appear after cluster deployment.')} />
              )}

              <details className="rounded-lg border border-slate-200/80 dark:border-slate-800 p-2.5">
                <summary className="cursor-pointer text-slate-500 hover:text-indigo-600">{tr('查看原始 JSON 数据', 'View Raw JSON')}</summary>
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
            title={tr('拓扑容量视图', 'Topology & Capacity')}
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
                    <span className="font-semibold text-slate-800 dark:text-slate-100">{tr('集群总 CPU 分配', 'Cluster CPU Allocated')}</span>
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
                    <span className="font-semibold text-slate-800 dark:text-slate-100">{tr('集群总内存分配', 'Cluster Memory Allocated')}</span>
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
                    {tr('数据中心：', 'Datacenter: ')}{dc} <span className="text-xs font-normal text-slate-500">({dcNodes.length} {tr('个 Client', 'clients')})</span>
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
                            {tr('总 CPU：', 'Total CPU: ')}<strong className="font-mono text-slate-700 dark:text-slate-200">{n.cpu_total_mhz ?? 0} MHz</strong>
                          </span>
                          <span>
                            {tr('总内存：', 'Total Mem: ')}<strong className="font-mono text-slate-700 dark:text-slate-200">{n.memory_total_mb ?? 0} MB</strong>
                          </span>
                          <span>
                            {tr('运行 Allocation：', 'Allocations: ')}<strong className="font-mono text-slate-700 dark:text-slate-200">{(n.allocations || []).length}</strong>
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <details className="rounded-lg border border-slate-200/80 dark:border-slate-800 p-2.5">
                <summary className="cursor-pointer text-slate-500 hover:text-indigo-600">{tr('查看原始 JSON 数据', 'View Raw JSON')}</summary>
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
          title={<TermLabel term={tr('CSI 卷与存储插件', 'CSI Volumes & Plugins')} tip={tr('通过 Container Storage Interface (CSI) 对接外部持久化块/文件存储。', 'Integrate external persistent block or file storage via Container Storage Interface (CSI).')} />}
          actions={
            <Button size="sm" onClick={() => void loadInfraViews('storage')}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          }
        >
          <div className="space-y-3 text-xs">
            <div className="text-slate-500">
              {tr('CSI 卷数量：', 'CSI Volumes: ')}<strong className="font-mono text-slate-800 dark:text-slate-200">{filteredVolumes.length}</strong> · {tr('插件数量：', 'Plugins: ')}
              <strong className="font-mono text-slate-800 dark:text-slate-200">{plugins.length}</strong>
            </div>
            {filteredVolumes.length === 0 ? (
              <EmptyState title={tr('暂无已注册 CSI 卷', 'No Registered CSI Volumes')} description={tr('如需持久化块存储或分布式文件系统，部署 CSI 插件并注册卷后会在此展示。', 'Deploy a CSI plugin and register volumes to see them here.')} />
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
                          void askConfirm(tr(`确定要注销 CSI 卷「${vid}」吗？`, `Deregister CSI volume "${vid}"?`), {
                            title: tr('注销 CSI 卷', 'Deregister CSI Volume'),
                            confirmText: tr('确认注销', 'Deregister'),
                            danger: true,
                          })
                            .then((ok) =>
                              ok
                                ? apiDelete(`/api/v1/nomad/${clusterId}/volumes/${encodeURIComponent(vid)}?namespace=${encodeURIComponent(vns)}`).then(() => {
                                    toast.success(tr('CSI 卷已注销', 'CSI volume deregistered'));
                                    return loadInfraViews('storage');
                                  })
                                : undefined,
                            )
                            .catch((ex) => setErr(ex.message))
                        }
                      >
                        {tr('注销', 'Deregister')}
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
          title={<TermLabel term="Nomad Variables" tip={tr('路径隔离的机密变量（按 CAS ModifyIndex 控制并发写冲突），可在 Job template 中注入。', 'Path-scoped secret variables with CAS optimistic locking, injectable into Job templates.')} />}
          actions={
            isAdmin && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setVarEdit({ namespace: namespace === '*' ? 'default' : namespace, path: '', items: '{}' })}
              >
                {tr('新建 Variable', 'New Variable')}
              </Button>
            )
          }
        >
          {filteredVariables.length === 0 ? (
            <EmptyState title={tr('暂无 Nomad Variables', 'No Nomad Variables')} description={tr('适用于轻量化配置存储；跨集群或高敏密钥推荐使用 Vault 联动。', 'Lightweight config storage; use Vault integration for cross-cluster or high-sensitivity secrets.')} />
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
                        {tr('查看原文 / 编辑', 'Reveal / Edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger-outline"
                        onClick={() =>
                          void askConfirm(tr(`确定要删除变量「${v.namespace} / ${v.path}」吗？`, `Delete variable "${v.namespace} / ${v.path}"?`), {
                            title: tr('删除 Variable', 'Delete Variable'),
                            confirmText: tr('确认删除', 'Delete'),
                            danger: true,
                          })
                            .then((ok) =>
                              ok
                                ? apiDelete(
                                    `/api/v1/nomad/${clusterId}/variables/item?path=${encodeURIComponent(v.path)}&namespace=${encodeURIComponent(v.namespace)}&cas=${v.modify_index}`,
                                  ).then(() => {
                                    toast.success(tr('Variable 已删除', 'Variable deleted'));
                                    return loadInfraViews('variables');
                                  })
                                : undefined,
                            )
                            .catch((ex) => setErr(ex.message))
                        }
                      >
                        {tr('删除', 'Delete')}
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
          title={tr('全局 Evaluations', 'Global Evaluations')}
          description={tr('点击 Job 名称将跳转至「Nomad Job 中心」查看对应任务的完整运行态与日志', 'Click a Job name to open its full runtime status and logs in Job Center')}
          actions={
            <Button size="sm" onClick={() => void loadInfraViews('evaluations')}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          }
        >
          {filteredEvaluations.length === 0 ? (
            <EmptyState title={tr('暂无调度评估记录', 'No Evaluations')} description={tr('提交或变更 Job 时，Nomad 产生的调度计算记录会展示在这里。', 'Scheduler evaluation records appear here when jobs are submitted or updated.')} />
          ) : (
            <div className="space-y-3 text-xs">
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                      <th className="py-2 pr-3">Eval ID</th>
                      <th className="py-2 pr-3">Job</th>
                      <th className="py-2 pr-3">{tr('触发原因', 'Triggered By')}</th>
                      <th className="py-2 pr-3">{tr('状态', 'Status')}</th>
                      <th className="py-2">{tr('说明', 'Description')}</th>
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
                        <td className="py-2 text-slate-500">{ev.StatusDescription || (ev.BlockedEval ? tr('等待资源或约束', 'Waiting on resources or constraints') : '-')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details className="rounded-lg border border-slate-200/80 dark:border-slate-800 p-2.5">
                <summary className="cursor-pointer text-slate-500 hover:text-indigo-600">{tr('查看原始 JSON 数据', 'View Raw JSON')}</summary>
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
        title={tr(`全局搜索结果${searchQ.trim() ? `：${searchQ.trim()}` : ''}`, `Global Search Results${searchQ.trim() ? `: ${searchQ.trim()}` : ''}`)}
        onClose={() => setSearchRes(null)}
        wide
      >
        {searchRes && (() => {
          const matches = searchRes?.Matches || searchRes?.matches || {};
          const entries = Object.entries<any>(matches).filter(([, list]) => Array.isArray(list) && list.length > 0);
          if (entries.length === 0) {
            return (
              <div className="space-y-2 text-xs text-slate-500">
                <div>{tr('未找到匹配项。', 'No matching items found.')}</div>
                <details>
                  <summary className="cursor-pointer hover:text-indigo-600">{tr('查看原始响应', 'View Raw Response')}</summary>
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

      <Modal open={Boolean(varEdit)} title={tr('编辑 Nomad Variable', 'Edit Nomad Variable')} onClose={() => setVarEdit(null)} wide>
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
                      toast.success(tr('Variable 已保存', 'Variable saved'));
                      return loadInfraViews('variables');
                    })
                    .catch((ex) => setErr(ex.message));
                } catch {
                  setErr(tr('Items 必须是合法 JSON', 'Items must be valid JSON'));
                }
              }}
            >
              {tr('保存 (CAS)', 'Save (CAS)')}
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
