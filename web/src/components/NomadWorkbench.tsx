import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Search, Terminal } from 'lucide-react';
import { apiDelete, apiDownload, apiGet, apiPost, apiPut, fmtBytes, openSSE } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, EmptyState, ErrorAlert, Input, Modal, SectionTabs, Sparkline, TermLabel, statusTone } from './UI';
import { TerminalModal } from './TerminalModal';
import { CodeEditor } from './CodeEditor';

export function NomadWorkbench({ clusterId }: { clusterId: string }) {
  const { isAdmin } = useAuth();
  const [subTab, setSubTab] = useState('jobs');
  const [namespace, setNamespace] = useState('default');
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
  const [notice, setNotice] = useState('');
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

  const inspectJob = async (job: any) => {
    const request = ++jobRequestRef.current;
    ++allocRequestRef.current;
    setSelectedJob(job);
    setSelectedAlloc(null);
    // Hide the previous job's actions while the new detail request is in flight.
    setJobSummary(null);
    setJobAllocs([]);
    setJobDeps([]);
    setJobEvals([]);
    const ns = job.namespace || namespace;
    const jid = encodeURIComponent(job.id);
    try {
      const [sum, allocs, deps, evals] = await Promise.all([
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(ns)}/jobs/${jid}/summary`),
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(ns)}/jobs/${jid}/allocations`),
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(ns)}/jobs/${jid}/deployments`),
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(ns)}/jobs/${jid}/evaluations`),
      ]);
      if (request !== jobRequestRef.current) return;
      const s = sum.data || sum.summary || sum;
      setJobSummary(s);
      setJobAllocs(allocs.data || allocs.allocations || []);
      setJobDeps(deps.data || deps.deployments || []);
      setJobEvals(evals.data || evals.evaluations || []);
      const firstGrp = (job.groups && job.groups[0]) || Object.keys(s?.Summary || {})[0] || '';
      if (firstGrp) {
        setScaleGroup(firstGrp);
        setScaleCount(1);
      }
    } catch (ex: any) {
      if (request === jobRequestRef.current) setErr(ex?.message || '加载 Job 详情失败');
    }
  };

  const inspectAlloc = async (alloc: any) => {
    const request = ++allocRequestRef.current;
    setSelectedAlloc(alloc);
    setAllocStats(null);
    setFsFiles([]);
    setCpuHist([]);
    setMemHist([]);
    setAllocLogs('');
    setFsPath('');
    setFilePreview(null);
    const firstTask = Object.keys(alloc.TaskStates || {})[0] || '';
    setLogTask(firstTask);
    try {
      const [det, st, ls] = await Promise.all([
        apiGet(`/api/v1/nomad/${clusterId}/allocs/${alloc.ID}`),
        apiGet(`/api/v1/nomad/${clusterId}/allocs/${alloc.ID}/stats`),
        apiGet(`/api/v1/nomad/${clusterId}/allocs/${alloc.ID}/fs/ls?path=`),
      ]);
      if (request !== allocRequestRef.current) return;
      setSelectedAlloc(det.allocation || alloc);
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
      `/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/logs/stream?task=${encodeURIComponent(logTask)}&type=stdout&follow=true`,
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
  }, [clusterId, selectedAlloc?.ID, logTask]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTabs
          tabs={[
            { id: 'jobs', label: 'Jobs', tip: 'Nomad 调度编排的工作负载单元（包含 service/batch/system 等类型）。' },
            { id: 'clients', label: 'Clients', tip: '运行任务容器/Allocations 的计算工作节点，可执行调度启用/禁用与 Drain 排空。' },
            { id: 'servers', label: 'Servers', tip: '通过 Raft 共识维护集群状态和执行调度决策的控制面节点。' },
            { id: 'topology', label: '拓扑容量', tip: '按数据中心与节点汇总的 CPU/内存分配率与剩余调度容量视图。' },
            { id: 'storage', label: '存储 / CSI', tip: 'Container Storage Interface 持久化卷及对应存储插件（如 Ceph/NFS/EBS）。' },
            { id: 'variables', label: 'Variables', tip: 'Nomad 内置键值密钥/配置存储，支持带 CAS（乐观锁版本号）的原子更新。' },
            { id: 'evaluations', label: 'Evaluations', tip: '每次 Job 变更、节点故障或周期触发产生的调度计算请求，用于决定 Allocation 迁移。' },
          ]}
          active={subTab}
          onChange={setSubTab}
        />
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="*">全部 Namespace (*)</option>
            {(namespaces.length ? namespaces : [{ name: 'default' }]).map((ns: any) => {
              const nsName = ns.name || ns.Name;
              return <option key={nsName} value={nsName}>{nsName}</option>;
            })}
          </select>
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
      {notice && <div className="rounded bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">{notice}</div>}

      {searchRes && (
        <Card title="搜索结果" actions={<Button size="sm" onClick={() => setSearchRes(null)}>关闭</Button>}>
          <pre className="max-h-48 overflow-auto rounded bg-slate-950 p-2 font-mono text-xs text-slate-100">
            {JSON.stringify(searchRes, null, 2)}
          </pre>
        </Card>
      )}

      {subTab === 'jobs' && (
        <div className="space-y-4">
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
                        <td className="py-2 pr-3 font-mono font-medium">{j.id}</td>
                        <td className="py-2 pr-3">{j.namespace} · {j.type}</td>
                        <td className="py-2 pr-3"><Badge tone={statusTone(j.stop ? 'stopped' : j.status)}>{j.stop ? 'stopped' : j.status}</Badge></td>
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

          {selectedJob && jobSummary && (
            <Card title={`Job 运行态：${selectedJob.id} (${selectedJob.namespace})`}>
              <div className="space-y-4 text-xs">
                {isAdmin && (
                  <div className="flex flex-wrap items-center gap-2 rounded bg-slate-50 p-2.5 dark:bg-slate-950">
                    <span>Task Group：</span>
                    {selectedJob.groups?.length > 1 ? (
                      <select
                        value={scaleGroup}
                        onChange={(e) => setScaleGroup(e.target.value)}
                        className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                      >
                        {selectedJob.groups.map((g: string) => <option key={g} value={g}>{g}</option>)}
                      </select>
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
                        ).then(() => { setNotice('扩缩副本请求已提交'); return inspectJob(selectedJob); }).catch((ex) => setErr(ex.message))
                      }
                    >
                      扩缩副本
                    </Button>
                    {selectedJob.periodic && (
                      <Button
                        size="sm"
                        onClick={() =>
                          void apiPost(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(selectedJob.namespace)}/jobs/${encodeURIComponent(selectedJob.id)}/periodic/force`, {})
                            .then(() => setNotice('已触发 Periodic 运行'))
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
                            .then(() => setNotice('已派发 Parameterized 子任务'))
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
                        <span>{d.ID.slice(0, 8)} · <Badge tone={statusTone(d.Status)}>{d.Status}</Badge> {d.StatusDescription}</span>
                        {isAdmin && d.Status === 'running' && (
                          <div className="flex gap-1">
                            <Button size="sm" variant="primary" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/promote`, {}).then(() => inspectJob(selectedJob)).catch((ex) => setErr(ex.message))}>Promote</Button>
                            <Button size="sm" variant="danger" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/fail`, {}).then(() => inspectJob(selectedJob)).catch((ex) => setErr(ex.message))}>Fail</Button>
                            <Button size="sm" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/pause`, {}).then(() => inspectJob(selectedJob)).catch((ex) => setErr(ex.message))}>Pause</Button>
                            <Button size="sm" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/resume`, {}).then(() => inspectJob(selectedJob)).catch((ex) => setErr(ex.message))}>Resume</Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div>
                  <div className="mb-1 font-semibold"><TermLabel term={`Allocations (${jobAllocs.length})`} tip="Task Group 在具体 Client 节点上的实例化副本，可查看实时 CPU/内存、日志与进入 Web 终端。" /></div>
                  <div className="space-y-1.5">
                    {jobAllocs.map((a) => (
                      <div key={a.ID} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2 dark:border-slate-800">
                        <div>
                          <span className="font-mono font-medium">{a.ID.slice(0, 8)}</span>
                          <span className="ml-2 text-slate-500">{a.TaskGroup} · 节点 {a.NodeName}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Badge tone={statusTone(a.ClientStatus)}>{a.ClientStatus}</Badge>
                          <Button size="sm" onClick={() => void inspectAlloc(a)}>详情 / 日志 / 终端</Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {jobEvals.length > 0 && (
                  <div>
                    <div className="mb-1 font-semibold">最近 Evaluations</div>
                    {jobEvals.slice(0, 5).map((ev) => (
                      <div key={ev.ID} className="text-[11px] text-slate-600 dark:text-slate-300">
                        {ev.ID.slice(0, 8)} · {ev.Status} {ev.BlockedEval ? '(blocked)' : ''}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          )}

          {selectedAlloc && (
            <Card title={`Allocation 详情：${selectedAlloc.ID}`} actions={<Button size="sm" onClick={() => void inspectAlloc(selectedAlloc)}>刷新 Allocation</Button>}>
              <div className="space-y-4 text-xs">
                <div className="space-y-2">
                  <div className="font-semibold">Task 事件</div>
                  {Object.entries<any>(selectedAlloc.TaskStates || {}).map(([task, state]) => (
                    <div key={task} className="rounded border border-slate-200 p-2 dark:border-slate-800">
                      <div className="font-mono font-semibold">{task} · {state.State}</div>
                      {(state.Events || []).slice(-10).reverse().map((event: any, i: number) => (
                        <div key={i} className="mt-1 whitespace-pre-wrap break-words">
                          <b>{event.Type}</b>：{event.DisplayMessage || event.Message || '-'}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-4">
                    <Sparkline values={cpuHist} color="#10b981" label={`CPU ${(cpuHist[cpuHist.length - 1] || 0).toFixed(1)}%`} />
                    <Sparkline values={memHist} max={512} color="#0ea5e9" label={`Mem ${(memHist[memHist.length - 1] || 0).toFixed(1)} MiB`} />
                  </div>
                  {isAdmin && logTask && (
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="sm" variant="primary" disabled={selectedAlloc.TaskStates?.[logTask]?.State !== 'running'} onClick={() => setTerminal({ allocId: selectedAlloc.ID, task: logTask })}>
                        <Terminal className="h-3 w-3" /> 打开交互式终端
                      </Button>
                      <Button size="sm" disabled={selectedAlloc.TaskStates?.[logTask]?.State !== 'running'} onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/restart`, { task: logTask }).then(() => setNotice('已请求重启 Task')).catch((ex) => setErr(ex.message))}>重启 Task</Button>
                      <Button size="sm" variant="danger" disabled={['complete', 'failed', 'lost'].includes(selectedAlloc.ClientStatus)} onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/stop`, {}).then(() => setNotice('已请求停止 Alloc')).catch((ex) => setErr(ex.message))}>停止 Alloc</Button>
                    </div>
                  )}
                </div>

                {allocStats && (
                  <div className="text-slate-500">
                    Task 选择：
                    <select value={logTask} onChange={(e) => setLogTask(e.target.value)} className="ml-1 rounded border border-slate-300 px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-950">
                      {Object.keys(selectedAlloc.TaskStates || {}).map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <div>
                    <div className="mb-1 font-semibold">实时日志 (stdout)</div>
                    <pre className="h-56 overflow-auto rounded bg-slate-950 p-2.5 font-mono text-[11px] text-slate-100 whitespace-pre-wrap">
                      {allocLogs || '等待日志...'}
                    </pre>
                  </div>

                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="font-semibold">文件浏览器 ({fsPath || '/'})</span>
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
                    <div className="h-56 overflow-auto rounded border border-slate-200 p-2 dark:border-slate-800">
                      {(fsFiles || []).map((f: any) => (
                        <div key={f.name} className="flex items-center justify-between py-1">
                          <span className="font-mono">{f.is_dir ? `${f.name}/` : f.name}</span>
                          <div className="flex gap-1">
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
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          )}
        </div>
      )}

      {subTab === 'clients' && (
        <Card title={<TermLabel term="Nomad Client 节点" tip="工作负载执行节点；Drain 操作会平滑驱逐节点上的运行实例并阻止新调度。" />}>
          <div className="space-y-2 text-xs">
            {clients.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2.5 dark:border-slate-800">
                <div>
                  <span className="font-semibold">{c.name}</span> <span className="font-mono text-slate-500">({(c.id || '').slice(0, 8)})</span>
                  <div className="text-slate-500">调度：{c.scheduling_eligibility} · Drain：{c.drain ? '是' : '否'}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                  {isAdmin && (
                    <>
                      <Button
                        size="sm"
                        onClick={() =>
                          void apiPost(`/api/v1/nomad/${clusterId}/clients/${c.id}/eligibility`, {
                            eligible: c.scheduling_eligibility !== 'eligible',
                          }).then(() => loadInfraViews('clients')).catch((ex) => setErr(ex.message))
                        }
                      >
                        {c.scheduling_eligibility === 'eligible' ? '设为不可调度' : '恢复可调度'}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() =>
                          void apiPost(`/api/v1/nomad/${clusterId}/clients/${c.id}/drain`, { cancel: Boolean(c.drain) })
                            .then(() => loadInfraViews('clients'))
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
        </Card>
      )}

      {subTab === 'servers' && (
        <Card title="Nomad Server 成员">
          <pre className="max-h-96 overflow-auto rounded bg-slate-950 p-3 font-mono text-xs text-slate-100">
            {JSON.stringify(servers, null, 2)}
          </pre>
        </Card>
      )}

      {subTab === 'topology' && (
        <Card title="拓扑容量视图">
          <pre className="max-h-96 overflow-auto rounded bg-slate-950 p-3 font-mono text-xs text-slate-100">
            {JSON.stringify(topology, null, 2)}
          </pre>
        </Card>
      )}

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
                      variant="danger"
                      onClick={() =>
                        void apiDelete(`/api/v1/nomad/${clusterId}/volumes/${encodeURIComponent(vid)}?namespace=${encodeURIComponent(vns)}`)
                          .then(() => loadInfraViews('storage'))
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
                      variant="danger"
                      onClick={() =>
                        void apiDelete(`/api/v1/nomad/${clusterId}/variables/item?path=${encodeURIComponent(v.path)}&namespace=${encodeURIComponent(v.namespace)}&cas=${v.modify_index}`)
                          .then(() => loadInfraViews('variables'))
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
        <Card title="全局 Evaluations">
          <pre className="max-h-96 overflow-auto rounded bg-slate-950 p-3 font-mono text-xs text-slate-100">
            {JSON.stringify(evaluations, null, 2)}
          </pre>
        </Card>
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
                  }).then(() => { setVarEdit(null); return loadInfraViews('variables'); }).catch((ex) => setErr(ex.message));
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
