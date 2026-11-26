import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, ChevronRight, RefreshCw, Search, Terminal } from 'lucide-react';
import { apiDelete, apiDownload, apiGet, apiPost, apiPut, fmtBytes, openSSE } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, EmptyState, ErrorAlert, Input, LoadingState, Modal, SectionTabs, Select, Sparkline, StatusBadge, TermLabel } from './UI';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog';
import { Drawer } from './Drawer';
import { TerminalModal } from './TerminalModal';
import { CodeEditor } from './CodeEditor';

const VALID_SUB_TABS = new Set(['jobs', 'clients', 'servers', 'topology', 'storage', 'variables', 'evaluations']);

export function NomadWorkbench({
  clusterId,
  initialNamespace,
  initialJobId,
  initialSubTab,
  onClearDeepLink,
}: {
  clusterId: string;
  initialNamespace?: string;
  initialJobId?: string;
  initialSubTab?: string;
  onClearDeepLink?: () => void;
}) {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [subTab, setSubTab] = useState(() =>
    initialJobId ? 'jobs' : initialSubTab && VALID_SUB_TABS.has(initialSubTab) ? initialSubTab : 'jobs',
  );
  const [namespace, setNamespace] = useState(initialNamespace || 'default');
  const [namespaces, setNamespaces] = useState<any[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [searchRes, setSearchRes] = useState<any>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [selectedJob, setSelectedJob] = useState<any>(null);
  const [jobSummary, setJobSummary] = useState<any>(null);
  const [jobAllocs, setJobAllocs] = useState<any[]>([]);
  const [jobDeps, setJobDeps] = useState<any[]>([]);
  const [jobEvals, setJobEvals] = useState<any[]>([]);
  const [selectedAlloc, setSelectedAlloc] = useState<any>(null);
  const [allocStats, setAllocStats] = useState<any>(null);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);
  const [fsPath, setFsPath] = useState('');
  const [fsFiles, setFsFiles] = useState<any[]>([]);
  const [filePreview, setFilePreview] = useState<{ path: string; text: string } | null>(null);
  const [allocLogs, setAllocLogs] = useState('');
  const [logTask, setLogTask] = useState('');
  const [logType, setLogType] = useState('stdout');
  const [logRevision, setLogRevision] = useState(0);
  const [allocTab, setAllocTab] = useState<'logs' | 'events' | 'files'>('logs');
  const [terminal, setTerminal] = useState<{ allocId: string; task: string; action?: string } | null>(null);

  const [clients, setClients] = useState<any[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [topology, setTopology] = useState<any>(null);
  const [volumes, setVolumes] = useState<any[]>([]);
  const [plugins, setPlugins] = useState<any[]>([]);
  const [variables, setVariables] = useState<any[]>([]);
  const [varEdit, setVarEdit] = useState<{ namespace: string; path: string; items: string; modifyIndex?: number } | null>(null);
  const [evaluations, setEvaluations] = useState<any[]>([]);
  const [scaleCount, setScaleCount] = useState(1);
  const [scaleGroup, setScaleGroup] = useState('');
  const [err, setErr] = useState('');
  const subTabRef = useRef(subTab);
  subTabRef.current = subTab;
  const jobRequestRef = useRef(0);
  const allocRequestRef = useRef(0);

  const loadNamespaces = useCallback(async () => {
    try {
      const res = await apiGet(`/api/v1/nomad/${clusterId}/namespaces`);
      setNamespaces(res.namespaces || []);
    } catch {
      // Cluster might not be initialized yet.
    }
  }, [clusterId]);

  const loadJobs = useCallback(async () => {
    setErr('');
    try {
      const res = await apiGet(`/api/v1/nomad/${clusterId}/jobs?namespace=${encodeURIComponent(namespace)}`);
      setJobs(res.jobs || []);
    } catch (ex: any) {
      setErr(ex?.message || '加载 Jobs 失败');
    }
  }, [clusterId, namespace]);

  const loadInfraViews = useCallback(async (view: string) => {
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
  }, [clusterId]);

  const loadJobsRef = useRef(loadJobs);
  loadJobsRef.current = loadJobs;

  useEffect(() => {
    void loadNamespaces();
  }, [loadNamespaces]);

  useEffect(() => {
    if (subTab === 'jobs') void loadJobs();
    else void loadInfraViews(subTab);
  }, [subTab, loadJobs, loadInfraViews]);

  // Shared blocking-query SSE watch for live refresh.
  useEffect(() => {
    const stop = openSSE(`/api/v1/nomad/${clusterId}/watch?topics=jobs,evaluations,nodes`, {
      onEvent: (ev) => {
        if (ev === 'change' || ev === 'watch' || ev === 'update') {
          if (subTabRef.current === 'jobs') void loadJobsRef.current();
        }
      },
    });
    return stop;
  }, [clusterId]);

  const inspectJob = useCallback(async (job: any) => {
    const request = ++jobRequestRef.current;
    ++allocRequestRef.current;
    const ns = job.namespace || (namespace === '*' ? 'default' : namespace);
    setSelectedJob({ ...job, namespace: ns });
    setSelectedAlloc(null);
    // Hide the previous job's actions while the new detail request is in flight.
    setJobSummary(null);
    setJobAllocs([]);
    setJobDeps([]);
    setJobEvals([]);
    const jid = encodeURIComponent(job.id);
    const nsEnc = encodeURIComponent(ns);
    const needsMeta = !job.status || !Array.isArray(job.groups);
    try {
      const [sum, allocs, deps, evals, detail] = await Promise.all([
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${nsEnc}/jobs/${jid}/summary`),
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${nsEnc}/jobs/${jid}/allocations`),
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${nsEnc}/jobs/${jid}/deployments`),
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${nsEnc}/jobs/${jid}/evaluations`),
        needsMeta ? apiGet(`/api/v1/nomad/${clusterId}/namespaces/${nsEnc}/jobs/${jid}`).catch(() => null) : Promise.resolve(null),
      ]);
      if (request !== jobRequestRef.current) return;
      const meta = detail?.job?.summary || detail?.job;
      const rawGroups = Array.isArray(meta?.groups) ? meta.groups : Array.isArray(job.groups) ? job.groups : [];
      const groupNames: string[] = rawGroups
        .map((g: any) => (typeof g === 'string' ? g : g?.name || g?.Name || ''))
        .filter(Boolean);
      const enriched = meta
        ? {
            ...job,
            ...meta,
            id: meta.id || job.id,
            namespace: meta.namespace || ns,
            groups: groupNames,
            periodic: Boolean(
              typeof meta.periodic === 'boolean'
                ? meta.periodic
                : (meta.periodic?.Enabled ?? meta.periodic?.enabled ?? job.periodic),
            ),
            parameterized: Boolean(
              typeof meta.parameterized === 'boolean'
                ? meta.parameterized
                : (meta.parameterized && Object.keys(meta.parameterized).length > 0) || job.parameterized,
            ),
            status: detail?.job?.status || meta.status || job.status,
            stop: detail?.job?.stop ?? meta.stop ?? job.stop,
          }
        : { ...job, namespace: ns, groups: groupNames };
      setSelectedJob(enriched);
      const s = sum.data || sum.summary || sum;
      setJobSummary(s);
      setJobAllocs(allocs.data || allocs.allocations || []);
      setJobDeps(deps.data || deps.deployments || []);
      setJobEvals(evals.data || evals.evaluations || []);
      const firstGrp = groupNames[0] || Object.keys(s?.Summary || {})[0] || '';
      if (firstGrp) {
        setScaleGroup(firstGrp);
        setScaleCount(1);
      }
    } catch (ex: any) {
      if (request === jobRequestRef.current) setErr(ex?.message || '加载 Job 详情失败');
    }
  }, [clusterId, namespace]);

  useEffect(() => {
    if (initialSubTab && VALID_SUB_TABS.has(initialSubTab) && !initialJobId) {
      setSubTab(initialSubTab);
    }
  }, [initialSubTab, initialJobId]);

  useEffect(() => {
    if (!initialJobId) return;
    const targetNs = initialNamespace || 'default';
    setSubTab('jobs');
    setNamespace(targetNs);
    void inspectJob({ id: initialJobId, namespace: targetNs });
  }, [clusterId, initialJobId, initialNamespace, inspectJob]);

  const closeAllocDrawer = () => {
    ++allocRequestRef.current;
    setSelectedAlloc(null);
    setAllocStats(null);
    setAllocLogs('');
    setFsFiles([]);
    setFsPath('');
    setFilePreview(null);
  };

  const backToJobs = () => {
    ++jobRequestRef.current;
    closeAllocDrawer();
    setSelectedJob(null);
    setJobSummary(null);
    setJobAllocs([]);
    setJobDeps([]);
    setJobEvals([]);
    onClearDeepLink?.();
  };

  // inspectAlloc refreshes details and restarts logs, including allocations listed before tasks appear.
  const inspectAlloc = async (alloc: any) => {
    const request = ++allocRequestRef.current;
    const sameAlloc = selectedAlloc?.ID === alloc.ID;
    if (!sameAlloc) {
      setAllocTab('logs');
    }
    setSelectedAlloc(alloc);
    setAllocStats(null);
    setFsFiles([]);
    setCpuHist([]);
    setMemHist([]);
    setAllocLogs('');
    setLogRevision((revision) => revision + 1);
    setFsPath('');
    setFilePreview(null);
    const firstTask = Object.keys(alloc.TaskStates || {})[0] || '';
    setLogTask((current) => sameAlloc && alloc.TaskStates?.[current] ? current : firstTask);
    try {
      const [det, st, ls] = await Promise.all([
        apiGet(`/api/v1/nomad/${clusterId}/allocs/${alloc.ID}`),
        apiGet(`/api/v1/nomad/${clusterId}/allocs/${alloc.ID}/stats`),
        apiGet(`/api/v1/nomad/${clusterId}/allocs/${alloc.ID}/fs/ls?path=`),
      ]);
      if (request !== allocRequestRef.current) return;
      const detail = det.allocation || alloc;
      setSelectedAlloc(detail);
      setLogTask((current) => current && detail.TaskStates?.[current] ? current : Object.keys(detail.TaskStates || {})[0] || '');
      const stats = st.stats || st;
      setAllocStats(stats);
      setCpuHist([stats?.ResourceUsage?.CpuStats?.Percent || 0]);
      setMemHist([(stats?.ResourceUsage?.MemoryStats?.RSS || 0) / (1024 * 1024)]);
      setFsFiles(ls.files || ls || []);
    } catch (ex: any) {
      if (request === allocRequestRef.current) setErr(ex?.message || '加载 Allocation 详情失败');
    }
  };

  useEffect(() => {
    if (!selectedAlloc?.ID) return;
    let active = true;
    const t = window.setInterval(async () => {
      try {
        const st = await apiGet(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/stats`);
        if (!active) return;
        const stats = st.stats || st;
        setAllocStats(stats);
        setCpuHist((p) => [...p.slice(-19), stats?.ResourceUsage?.CpuStats?.Percent || 0]);
        setMemHist((p) => [...p.slice(-19), (stats?.ResourceUsage?.MemoryStats?.RSS || 0) / (1024 * 1024)]);
      } catch {
        // ignore transient polling error
      }
    }, 3000);
    return () => { active = false; window.clearInterval(t); };
  }, [clusterId, selectedAlloc?.ID]);

  useEffect(() => {
    if (!selectedAlloc?.ID || !logTask) return;
    setAllocLogs('');
    const stop = openSSE(
      `/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/logs/stream?task=${encodeURIComponent(logTask)}&type=${logType}&follow=true`,
      {
        onEvent: (ev, d) => {
          if (ev === 'log' && d?.data) {
            setAllocLogs((p) => p + d.data);
          } else if (ev === 'end') {
            stop();
          } else if (typeof d === 'string') {
            setAllocLogs((p) => p + d);
          }
        },
      },
    );
    return stop;
  }, [clusterId, selectedAlloc?.ID, logTask, logType, logRevision]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTabs
          variant="underline"
          tabs={[
            { id: 'jobs', label: 'Jobs', title: 'Nomad 调度编排的工作负载单元（包含 service/batch/system 等类型）' },
            { id: 'clients', label: 'Clients', title: '运行任务容器/Allocations 的计算工作节点，可执行调度启用/禁用与 Drain 排空' },
            { id: 'servers', label: 'Servers', title: '通过 Raft 共识维护集群状态和执行调度决策的控制面节点' },
            { id: 'topology', label: '拓扑容量', title: '按数据中心与节点汇总的 CPU/内存分配率与剩余调度容量视图' },
            { id: 'storage', label: '存储 / CSI', title: 'Container Storage Interface 持久化卷及对应存储插件（如 Ceph/NFS/EBS）' },
            { id: 'variables', label: 'Variables', title: 'Nomad 内置键值密钥/配置存储，支持带 CAS（乐观锁版本号）的原子更新' },
            { id: 'evaluations', label: 'Evaluations', title: '每次 Job 变更、节点故障或周期触发产生的调度计算请求，用于决定 Allocation 迁移' },
          ]}
          active={subTab}
          onChange={(next) => {
            setSubTab(next);
            if (next !== 'jobs') {
              closeAllocDrawer();
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-40">
            <Select
              aria-label="工作台 Namespace"
              size="sm"
              value={namespace}
              onChange={(e) => {
                setNamespace(e.target.value);
                backToJobs();
              }}
            >
              <option value="*">全部 Namespace (*)</option>
              {(namespaces.length ? namespaces : [{ name: 'default' }]).map((ns: any) => {
                const nsName = ns.name || ns.Name;
                return <option key={nsName} value={nsName}>{nsName}</option>;
              })}
            </Select>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void apiGet(`/api/v1/nomad/${clusterId}/search?q=${encodeURIComponent(searchQ)}`)
                .then((r) => setSearchRes(r))
                .catch((ex) => setErr(ex.message));
            }}
            className="flex gap-1"
          >
            <input
              placeholder="全局模糊搜索..."
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              className="w-36 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
            />
            <Button size="sm" type="submit"><Search className="h-3.5 w-3.5" /></Button>
          </form>
        </div>
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {subTab === 'jobs' && (
        <div className="space-y-4">
          {!selectedJob ? (
            <Card title="运行态 Jobs" actions={<Button size="sm" onClick={() => void loadJobs()}><RefreshCw className="h-3.5 w-3.5" /></Button>}>
              {jobs.length === 0 ? (
                <EmptyState text="当前 Namespace 无 Job" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                        <th className="py-2 pr-3">Job ID</th>
                        <th className="py-2 pr-3">Namespace / Type</th>
                        <th className="py-2 pr-3">状态</th>
                        <th className="py-2 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {jobs.map((j) => (
                        <tr key={`${j.namespace}:${j.id}`}>
                          <td className="py-2 pr-3 font-mono font-medium">
                            <button
                              type="button"
                              onClick={() => void inspectJob(j)}
                              className="text-left text-slate-900 hover:text-indigo-600 hover:underline underline-offset-2 dark:text-slate-100 dark:hover:text-indigo-400"
                            >
                              {j.id}
                            </button>
                          </td>
                          <td className="py-2 pr-3">{j.namespace} · {j.type}</td>
                          <td className="py-2 pr-3"><StatusBadge value={j.stop ? 'stopped' : j.status} /></td>
                          <td className="py-2 text-right">
                            <Button size="sm" onClick={() => void inspectJob(j)}>运行态详情</Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-white px-3.5 py-2.5 text-xs dark:border-slate-800 dark:bg-slate-900">
                <nav aria-label="Job 运行态路径" className="flex flex-wrap items-center gap-1.5 min-w-0">
                  <button
                    type="button"
                    onClick={backToJobs}
                    className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    <span>Jobs 列表</span>
                  </button>
                  <ChevronRight className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                  <span className="font-mono font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {selectedJob.id} ({selectedJob.namespace})
                  </span>
                  <StatusBadge value={selectedJob.stop ? 'stopped' : selectedJob.status} />
                </nav>
                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                  <Link
                    to={`/jobs?cluster_id=${encodeURIComponent(clusterId)}&namespace=${encodeURIComponent(selectedJob.namespace || 'default')}&job=${encodeURIComponent(selectedJob.id)}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-indigo-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-indigo-400 dark:hover:bg-slate-700"
                  >
                    <span>在 Job 中心编辑</span>
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                  <Button size="sm" onClick={() => void inspectJob(selectedJob)}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>刷新</span>
                  </Button>
                  <Button size="sm" onClick={backToJobs}>返回列表</Button>
                </div>
              </div>

              {!jobSummary ? (
                <Card>
                  <LoadingState label={`正在加载 Job ${selectedJob.id} 运行态…`} />
                </Card>
              ) : (
                <Card title={`Job 运行态：${selectedJob.id} (${selectedJob.namespace})`}>
                  <div className="space-y-4 text-xs">
                    {isAdmin && (
                      <div className="flex flex-wrap items-center gap-2 rounded bg-slate-50 p-2.5 dark:bg-slate-950">
                        <span>Task Group：</span>
                        {selectedJob.groups?.length > 1 ? (
                          <div className="w-40">
                            <Select
                              aria-label="扩缩容 Task Group"
                              size="sm"
                              value={scaleGroup}
                              onChange={(e) => setScaleGroup(e.target.value)}
                            >
                              {selectedJob.groups.map((g: string) => <option key={g} value={g}>{g}</option>)}
                            </Select>
                          </div>
                        ) : (
                          <b>{scaleGroup || '-'}</b>
                        )}
                        <input
                          type="number"
                          min={0}
                          value={scaleCount}
                          onChange={(e) => setScaleCount(Number(e.target.value))}
                          className="w-20 rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                        />
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() =>
                            void apiPost(
                              `/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(selectedJob.namespace)}/jobs/${encodeURIComponent(selectedJob.id)}/scale`,
                              { group: scaleGroup, count: scaleCount },
                            ).then(() => { toast.success('扩缩副本请求已提交'); return inspectJob(selectedJob); }).catch((ex) => setErr(ex.message))
                          }
                        >
                          扩缩副本
                        </Button>
                        {selectedJob.periodic && (
                          <Button
                            size="sm"
                            onClick={() =>
                              void apiPost(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(selectedJob.namespace)}/jobs/${encodeURIComponent(selectedJob.id)}/periodic/force`, {})
                                .then(() => toast.success('已触发 Periodic 运行'))
                                .catch((ex) => setErr(ex.message))
                            }
                          >
                            立即触发 Periodic
                          </Button>
                        )}
                        {selectedJob.parameterized && (
                          <Button
                            size="sm"
                            onClick={() =>
                              void apiPost(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(selectedJob.namespace)}/jobs/${encodeURIComponent(selectedJob.id)}/dispatch`, { meta: {} })
                                .then(() => toast.success('已派发 Parameterized 子任务'))
                                .catch((ex) => setErr(ex.message))
                            }
                          >
                            Dispatch 派发
                          </Button>
                        )}
                      </div>
                    )}

                    {jobDeps.length > 0 && (
                      <div>
                        <div className="mb-1 font-semibold"><TermLabel term="Deployments" tip="滚动发布与金丝雀升级控制器，支持 Promote（放行全量）、Pause、Resume 与 Fail 回滚。" /></div>
                        {jobDeps.map((d) => (
                          <div key={d.ID} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2 dark:border-slate-800">
                            <span>{d.ID.slice(0, 8)} · <StatusBadge value={d.Status} /> {d.StatusDescription}</span>
                            {isAdmin && d.Status === 'running' && (
                              <div className="flex gap-1">
                                <Button size="sm" variant="primary" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/promote`, {}).then(() => { toast.success('已放行 Deployment (Promote)'); return inspectJob(selectedJob); }).catch((ex) => setErr(ex.message))}>Promote</Button>
                                <Button size="sm" variant="danger-outline" onClick={() => void askConfirm(`确定要将 Deployment ${d.ID.slice(0, 8)} 标记为失败并触发回滚吗？`, { title: '回滚 Deployment', confirmText: '确认 Fail', danger: true }).then((ok) => ok ? apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/fail`, {}).then(() => { toast.success('已触发 Deployment Fail'); return inspectJob(selectedJob); }) : undefined).catch((ex) => setErr(ex.message))}>Fail</Button>
                                <Button size="sm" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/pause`, {}).then(() => { toast.success('已暂停 Deployment'); return inspectJob(selectedJob); }).catch((ex) => setErr(ex.message))}>Pause</Button>
                                <Button size="sm" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/resume`, {}).then(() => { toast.success('已恢复 Deployment'); return inspectJob(selectedJob); }).catch((ex) => setErr(ex.message))}>Resume</Button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <div>
                      <div className="mb-2 font-semibold"><TermLabel term={`Allocations (${jobAllocs.length})`} tip="Task Group 在具体 Client 节点上的实例化副本，可查看实时 CPU/内存、日志与进入 Web 终端。" /></div>
                      {jobAllocs.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-slate-200 py-5 text-center text-slate-400 dark:border-slate-800">暂无 Allocation 实例</div>
                      ) : (
                        <div className="overflow-x-auto rounded-xl border border-slate-200/80 dark:border-slate-800">
                          <table className="w-full text-left text-xs">
                            <thead className="bg-slate-50/70 text-slate-500 dark:bg-slate-950/40 dark:text-slate-400">
                              <tr className="border-b border-slate-200/80 dark:border-slate-800">
                                <th className="px-3 py-2 font-medium">Allocation ID</th>
                                <th className="px-3 py-2 font-medium">Task Group</th>
                                <th className="px-3 py-2 font-medium">运行节点</th>
                                <th className="px-3 py-2 font-medium">状态</th>
                                <th className="px-3 py-2 text-right font-medium">操作</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                              {jobAllocs.map((a) => (
                                <tr key={a.ID} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                                  <td className="px-3 py-2.5 font-mono font-semibold text-slate-900 dark:text-slate-100">{a.ID.slice(0, 8)}</td>
                                  <td className="px-3 py-2.5 text-slate-700 dark:text-slate-300">{a.TaskGroup || '-'}</td>
                                  <td className="px-3 py-2.5 font-mono text-slate-600 dark:text-slate-300">{a.NodeName || '-'}</td>
                                  <td className="px-3 py-2.5"><StatusBadge value={a.ClientStatus} /></td>
                                  <td className="px-3 py-2.5 text-right">
                                    <Button
                                      size="sm"
                                      variant={selectedAlloc?.ID === a.ID ? 'primary' : 'secondary'}
                                      onClick={() => void inspectAlloc(a)}
                                    >
                                      详情 / 日志 / 终端
                                    </Button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    {jobEvals.length > 0 && (
                      <div>
                        <div className="mb-2 font-semibold">最近 Evaluations</div>
                        <div className="flex flex-wrap gap-2">
                          {jobEvals.slice(0, 5).map((ev) => (
                            <div key={ev.ID} className="inline-flex items-center gap-2 rounded-lg border border-slate-200/80 bg-slate-50/60 px-2.5 py-1.5 text-[11px] dark:border-slate-800 dark:bg-slate-950/40">
                              <span className="font-mono font-medium text-slate-700 dark:text-slate-200">{ev.ID.slice(0, 8)}</span>
                              <StatusBadge value={ev.Status} />
                              {ev.BlockedEval && <Badge tone="amber">blocked</Badge>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </Card>
              )}
            </div>
          )}
        </div>
      )}

      {subTab === 'clients' && (
        <Card title={<TermLabel term="Nomad Client 节点" tip="工作负载执行节点；Drain 操作会平滑驱逐节点上的运行实例并阻止新调度。" />}>
          {clients.length === 0 ? (
            <EmptyState title="暂无 Client 节点" description="当节点以 Client 或 Server + Client 模式加入集群后将在此显示。" />
          ) : (
            <div className="space-y-2.5 text-xs">
              {clients.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3.5 dark:border-slate-800">
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
                            }).then(() => { toast.success(c.scheduling_eligibility === 'eligible' ? '已设为不可调度' : '已恢复可调度'); return loadInfraViews('clients'); }).catch((ex) => setErr(ex.message))
                          }
                        >
                          {c.scheduling_eligibility === 'eligible' ? '设为不可调度' : '恢复可调度'}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger-outline"
                          onClick={() =>
                            void askConfirm(
                              c.drain ? `确定要取消节点 ${c.name} 的 Drain 状态吗？` : `确定要对节点 ${c.name} 执行 Drain 吗？将驱逐其上运行实例。`,
                              {
                                title: c.drain ? '取消节点 Drain' : '启用节点 Drain',
                                confirmText: c.drain ? '确认取消' : '确认 Drain',
                                danger: !c.drain,
                              },
                            )
                              .then((ok) => ok ? apiPost(`/api/v1/nomad/${clusterId}/clients/${c.id}/drain`, { cancel: Boolean(c.drain) }).then(() => { toast.success(c.drain ? '已取消 Drain' : '已开启 Drain'); return loadInfraViews('clients'); }) : undefined)
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
          <Card title="Nomad Server 成员" actions={<Button size="sm" onClick={() => void loadInfraViews('servers')}><RefreshCw className="h-3.5 w-3.5" /></Button>}>
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
          <Card title="拓扑容量视图" actions={<Button size="sm" onClick={() => void loadInfraViews('topology')}><RefreshCw className="h-3.5 w-3.5" /></Button>}>
            <div className="space-y-5 text-xs">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-2">
                  <div className="flex justify-between">
                    <span className="font-semibold text-slate-800 dark:text-slate-100">集群总 CPU 分配</span>
                    <span className="font-mono">{cpuUsed} / {cpuTotal} MHz ({cpuPct}%)</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                    <div className="h-full bg-indigo-500 transition-all" style={{ width: `${cpuPct}%` }} />
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-2">
                  <div className="flex justify-between">
                    <span className="font-semibold text-slate-800 dark:text-slate-100">集群总内存分配</span>
                    <span className="font-mono">{memUsed} / {memTotal} MB ({memPct}%)</span>
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
                          <span>总 CPU：<strong className="font-mono text-slate-700 dark:text-slate-200">{n.cpu_total_mhz ?? 0} MHz</strong></span>
                          <span>总内存：<strong className="font-mono text-slate-700 dark:text-slate-200">{n.memory_total_mb ?? 0} MB</strong></span>
                          <span>运行 Allocation：<strong className="font-mono text-slate-700 dark:text-slate-200">{(n.allocations || []).length}</strong></span>
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
        <Card title={<TermLabel term="CSI 卷与存储插件" tip="通过 Container Storage Interface (CSI) 对接外部持久化块/文件存储。" />}>
          <div className="space-y-3 text-xs">
            <div>CSI 卷数量：{volumes.length} · 插件数量：{plugins.length}</div>
            {volumes.map((v) => {
              const vid = v.ID || v.id;
              const vns = v.Namespace || v.namespace || 'default';
              return (
                <div key={`${vns}:${vid}`} className="flex items-center justify-between rounded border border-slate-200 p-2 dark:border-slate-800">
                  <span className="font-mono">{vid} ({v.Name || v.name || vns})</span>
                  {isAdmin && (
                    <Button
                      size="sm"
                      variant="danger-outline"
                      onClick={() =>
                        void askConfirm(`确定要注销 CSI 卷「${vid}」吗？`, { title: '注销 CSI 卷', confirmText: '确认注销', danger: true })
                          .then((ok) => ok ? apiDelete(`/api/v1/nomad/${clusterId}/volumes/${encodeURIComponent(vid)}?namespace=${encodeURIComponent(vns)}`).then(() => { toast.success('CSI 卷已注销'); return loadInfraViews('storage'); }) : undefined)
                          .catch((ex) => setErr(ex.message))
                      }
                    >
                      注销
                    </Button>
                  )}
                </div>
              );
            })}
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
          <div className="space-y-2 text-xs">
            {variables.map((v) => (
              <div key={`${v.namespace}:${v.path}`} className="flex items-center justify-between rounded border border-slate-200 p-2 dark:border-slate-800">
                <span className="font-mono">{v.namespace} / {v.path}</span>
                {isAdmin && (
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      onClick={() =>
                        void apiPost(`/api/v1/nomad/${clusterId}/variables/item/reveal?path=${encodeURIComponent(v.path)}&namespace=${encodeURIComponent(v.namespace)}`, {})
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
                        void askConfirm(`确定要删除变量「${v.namespace} / ${v.path}」吗？`, { title: '删除 Variable', confirmText: '确认删除', danger: true })
                          .then((ok) => ok ? apiDelete(`/api/v1/nomad/${clusterId}/variables/item?path=${encodeURIComponent(v.path)}&namespace=${encodeURIComponent(v.namespace)}&cas=${v.modify_index}`).then(() => { toast.success('Variable 已删除'); return loadInfraViews('variables'); }) : undefined)
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
        </Card>
      )}

      {subTab === 'evaluations' && (
        <Card title="全局 Evaluations" actions={<Button size="sm" onClick={() => void loadInfraViews('evaluations')}><RefreshCw className="h-3.5 w-3.5" /></Button>}>
          {evaluations.length === 0 ? (
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
                    {evaluations.slice(0, 30).map((ev: any) => (
                      <tr key={ev.ID}>
                        <td className="py-2 pr-3 font-mono">{(ev.ID || '').slice(0, 8)}</td>
                        <td className="py-2 pr-3 font-mono font-medium">
                          {ev.JobID ? (
                            <button
                              type="button"
                              onClick={() => {
                                const targetNs = ev.Namespace || (namespace === '*' ? 'default' : namespace);
                                setSubTab('jobs');
                                void inspectJob({ id: ev.JobID, namespace: targetNs });
                              }}
                              className="text-left text-indigo-600 hover:underline dark:text-indigo-400"
                            >
                              {ev.JobID}
                            </button>
                          ) : (
                            '-'
                          )}
                        </td>
                        <td className="py-2 pr-3">{ev.TriggeredBy || '-'}</td>
                        <td className="py-2 pr-3"><StatusBadge value={ev.Status} /></td>
                        <td className="py-2 text-slate-500">{ev.StatusDescription || (ev.BlockedEval ? '等待资源或约束' : '-')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details className="rounded-lg border border-slate-200/80 dark:border-slate-800 p-2.5">
                <summary className="cursor-pointer text-slate-500 hover:text-indigo-600">查看原始 JSON 数据</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-950 p-3 font-mono text-xs text-slate-100">
                  {JSON.stringify(evaluations, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </Card>
      )}

      <Modal open={Boolean(searchRes)} title={`全局搜索结果${searchQ.trim() ? `：${searchQ.trim()}` : ''}`} onClose={() => setSearchRes(null)} wide>
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
                                setSubTab('jobs');
                                setNamespace(jobNs);
                                void inspectJob({ id: jobId, namespace: jobNs });
                              }}
                              className="text-left text-indigo-600 hover:underline dark:text-indigo-400"
                            >
                              {label}
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

      {selectedAlloc && (
        <Drawer
          title={
            <>
              <span className="font-mono">Allocation {selectedAlloc.ID.slice(0, 8)}</span>
              <StatusBadge value={selectedAlloc.ClientStatus} />
            </>
          }
          subtitle={`${selectedJob?.id ? `Job ${selectedJob.id} · ` : ''}${selectedAlloc.TaskGroup || ''} · 节点 ${selectedAlloc.NodeName || '-'} · ID: ${selectedAlloc.ID}`}
          width="2xl"
          onClose={closeAllocDrawer}
          headerExtra={
            <Button size="sm" onClick={() => void inspectAlloc(selectedAlloc)}>
              <RefreshCw className="h-3.5 w-3.5" />
              <span>刷新</span>
            </Button>
          }
          footer={
            <div className="flex flex-wrap items-center justify-between gap-2 w-full">
              <div className="flex flex-wrap items-center gap-1.5">
                {isAdmin && logTask && (
                  <>
                    <Button size="sm" variant="primary" disabled={selectedAlloc.TaskStates?.[logTask]?.State !== 'running'} onClick={() => setTerminal({ allocId: selectedAlloc.ID, task: logTask })}>
                      <Terminal className="h-3 w-3" /> 打开交互式终端
                    </Button>
                    <Button size="sm" disabled={selectedAlloc.TaskStates?.[logTask]?.State !== 'running'} onClick={() => void askConfirm(`确定要重启 Allocation ${selectedAlloc.ID.slice(0, 8)} 中的任务 ${logTask} 吗？`, { title: '重启 Task', confirmText: '确认重启' }).then((ok) => ok ? apiPost(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/restart`, { task: logTask }).then(() => { toast.success('已请求重启 Task'); }) : undefined).catch((ex) => setErr(ex.message))}>
                      重启 Task
                    </Button>
                    <Button size="sm" variant="danger-outline" disabled={['complete', 'failed', 'lost'].includes(selectedAlloc.ClientStatus)} onClick={() => void askConfirm(`确定要停止 Allocation ${selectedAlloc.ID.slice(0, 8)} 吗？调度器可能会重新拉起新副本。`, { title: '停止 Allocation', confirmText: '确认停止', danger: true }).then((ok) => ok ? apiPost(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/stop`, {}).then(() => { toast.success('已请求停止 Alloc'); }) : undefined).catch((ex) => setErr(ex.message))}>
                      停止 Alloc
                    </Button>
                  </>
                )}
              </div>
              <Button size="sm" variant="secondary" onClick={closeAllocDrawer}>关闭</Button>
            </div>
          }
        >
          <div className="space-y-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTabs
                variant="underline"
                tabs={[
                  { id: 'logs', label: '实时日志' },
                  { id: 'events', label: '事件与资源' },
                  { id: 'files', label: '文件浏览' },
                ]}
                active={allocTab}
                onChange={(t) => setAllocTab(t as 'logs' | 'events' | 'files')}
              />
              {Object.keys(selectedAlloc.TaskStates || {}).length > 0 && (
                <div className="flex items-center gap-1.5 text-slate-500">
                  <span className="shrink-0">Task：</span>
                  <div className="w-36">
                    <Select
                      aria-label="选择 Task"
                      size="sm"
                      value={logTask}
                      onChange={(e) => setLogTask(e.target.value)}
                    >
                      {Object.keys(selectedAlloc.TaskStates || {}).map((t) => <option key={t} value={t}>{t}</option>)}
                    </Select>
                  </div>
                </div>
              )}
            </div>

            {allocTab === 'logs' && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-slate-800 dark:text-slate-100">实时日志输出（{logTask || '-'}）</span>
                  <div className="w-48">
                    <Select aria-label="日志输出流" size="sm" value={logType} onChange={(e) => setLogType(e.target.value)}>
                      <option value="stdout">标准输出 · stdout</option>
                      <option value="stderr">错误与服务日志 · stderr</option>
                    </Select>
                  </div>
                </div>
                <pre className="h-[420px] overflow-auto rounded-xl bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100 whitespace-pre-wrap">
                  {allocLogs || '等待日志… 若没有输出，请尝试切换 stdout / stderr。'}
                </pre>
              </div>
            )}

            {allocTab === 'events' && (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-4 rounded-xl border border-slate-200 p-3.5 dark:border-slate-800">
                  <Sparkline values={cpuHist} color="#4f46e5" label={`CPU ${(cpuHist[cpuHist.length - 1] || 0).toFixed(1)}%`} />
                  <Sparkline values={memHist} max={512} color="#0ea5e9" label={`Mem ${(memHist[memHist.length - 1] || 0).toFixed(1)} MiB`} />
                  {allocStats && (
                    <span className="self-center text-slate-500">每 3 秒自动采集一次资源占用</span>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="font-semibold text-slate-800 dark:text-slate-100">Task 生命周期事件</div>
                  {Object.entries<any>(selectedAlloc.TaskStates || {}).map(([task, state]) => (
                    <div key={task} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                      <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">{task} · {state.State}</div>
                      {(state.Events || []).slice(-10).reverse().map((event: any, i: number) => (
                        <div key={i} className="mt-1.5 whitespace-pre-wrap break-words text-slate-600 dark:text-slate-300">
                          <b>{event.Type}</b>：{event.DisplayMessage || event.Message || '-'}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {allocTab === 'files' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-800 dark:text-slate-100">文件浏览器 ({fsPath || '/'})</span>
                  {fsPath && (
                    <Button
                      size="sm"
                      onClick={() => {
                        const parent = fsPath.split('/').slice(0, -1).join('/');
                        setFsPath(parent);
                        void apiGet(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/fs/ls?path=${encodeURIComponent(parent)}`)
                          .then((r) => setFsFiles(r.files || r || []))
                          .catch((ex) => setErr(ex.message));
                      }}
                    >
                      上级
                    </Button>
                  )}
                </div>
                <div className="h-[420px] overflow-auto rounded-xl border border-slate-200 p-2.5 dark:border-slate-800">
                  {(fsFiles || []).length === 0 ? (
                    <div className="py-10 text-center text-slate-400">当前目录为空</div>
                  ) : (
                    (fsFiles || []).map((f: any) => (
                      <div key={f.name} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                        <span className="font-mono truncate">{f.is_dir ? `${f.name}/` : f.name}</span>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <span className="text-slate-500">{fmtBytes(f.size)}</span>
                          {f.is_dir ? (
                            <Button
                              size="sm"
                              onClick={() => {
                                const np = fsPath ? `${fsPath}/${f.name}` : f.name;
                                setFsPath(np);
                                void apiGet(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/fs/ls?path=${encodeURIComponent(np)}`)
                                  .then((r) => setFsFiles(r.files || r || []))
                                  .catch((ex) => setErr(ex.message));
                              }}
                            >
                              进入
                            </Button>
                          ) : (
                            isAdmin && f.readable !== false && (
                              <>
                                <Button
                                  size="sm"
                                  onClick={() => {
                                    const fp = fsPath ? `${fsPath}/${f.name}` : f.name;
                                    void apiGet(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/fs/content/readat?path=${encodeURIComponent(fp)}&offset=0&limit=32768`)
                                      .then((r) => setFilePreview({ path: fp, text: typeof r === 'string' ? r : r.data || JSON.stringify(r) }))
                                      .catch((ex) => setErr(ex.message));
                                  }}
                                >
                                  预览
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => {
                                    const fp = fsPath ? `${fsPath}/${f.name}` : f.name;
                                    void apiDownload(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/fs/content/download?path=${encodeURIComponent(fp)}`, undefined, f.name)
                                      .catch((ex) => setErr(ex.message));
                                  }}
                                >
                                  下载
                                </Button>
                              </>
                            )
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </Drawer>
      )}

      <Modal open={Boolean(filePreview)} title={`文件预览：${filePreview?.path}`} onClose={() => setFilePreview(null)} wide>
        <pre className="max-h-96 overflow-auto rounded bg-slate-950 p-3 font-mono text-xs text-slate-100 whitespace-pre-wrap">
          {filePreview?.text}
        </pre>
      </Modal>

      <Modal open={Boolean(varEdit)} title="编辑 Nomad Variable" onClose={() => setVarEdit(null)} wide>
        {varEdit && (
          <div className="space-y-3 text-xs">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input label="Namespace" value={varEdit.namespace} onChange={(e) => setVarEdit({ ...varEdit, namespace: e.target.value })} />
              <Input label="Path" value={varEdit.path} onChange={(e) => setVarEdit({ ...varEdit, path: e.target.value })} />
            </div>
            <CodeEditor value={varEdit.items} onChange={(v) => setVarEdit({ ...varEdit, items: v })} height="220px" />
            <Button
              variant="primary"
              onClick={() => {
                try {
                  const items = JSON.parse(varEdit.items);
                  void apiPut(`/api/v1/nomad/${clusterId}/variables/item?path=${encodeURIComponent(varEdit.path)}&namespace=${encodeURIComponent(varEdit.namespace || 'default')}`, {
                    items,
                    cas: varEdit.modifyIndex,
                  }).then(() => { setVarEdit(null); toast.success('Variable 已保存'); return loadInfraViews('variables'); }).catch((ex) => setErr(ex.message));
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

      <TerminalModal
        open={Boolean(terminal)}
        onClose={() => setTerminal(null)}
        clusterId={clusterId}
        allocId={terminal?.allocId || ''}
        task={terminal?.task || ''}
        action={terminal?.action}
      />
    </div>
  );
}
