import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Search, Terminal } from 'lucide-react';
import { apiDelete, apiDownload, apiGet, apiPost, apiPut, fmtBytes, openSSE } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, EmptyState, ErrorAlert, Input, Modal, SectionTabs, Sparkline, statusTone } from './UI';
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
  const [varEdit, setVarEdit] = useState<{ path: string; items: string; modifyIndex?: number } | null>(null);
  const [evaluations, setEvaluations] = useState<any[]>([]);
  const [scaleCount, setScaleCount] = useState(1);
  const [scaleGroup, setScaleGroup] = useState('');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

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
        setVolumes(vRes.volumes || []);
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

  useEffect(() => {
    void loadNamespaces();
  }, [loadNamespaces]);

  useEffect(() => {
    if (subTab === 'jobs') void loadJobs();
    else void loadInfraViews(subTab);
  }, [subTab, loadJobs, loadInfraViews]);

  // Shared blocking-query SSE watch for live refresh.
  useEffect(() => {
    const stop = openSSE(`/api/v1/nomad/${clusterId}/watch?topics=jobs,allocations,evaluations,nodes`, {
      onEvent: (ev) => {
        if (ev === 'watch' || ev === 'update') {
          if (subTab === 'jobs') void loadJobs();
        }
      },
    });
    return stop;
  }, [clusterId, subTab, loadJobs]);

  const inspectJob = async (job: any) => {
    setSelectedJob(job);
    setSelectedAlloc(null);
    const ns = job.Namespace || namespace;
    const jid = encodeURIComponent(job.ID);
    try {
      const [sum, allocs, deps, evals] = await Promise.all([
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(ns)}/jobs/${jid}/summary`),
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(ns)}/jobs/${jid}/allocations`),
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(ns)}/jobs/${jid}/deployments`),
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(ns)}/jobs/${jid}/evaluations`),
      ]);
      const s = sum.summary || sum;
      setJobSummary(s);
      setJobAllocs(allocs.allocations || []);
      setJobDeps(deps.deployments || []);
      setJobEvals(evals.evaluations || []);
      const firstGrp = s?.TaskGroups?.[0];
      if (firstGrp) {
        setScaleGroup(firstGrp.Name);
        setScaleCount(firstGrp.Count ?? 1);
      }
    } catch (ex: any) {
      setErr(ex?.message || '加载 Job 详情失败');
    }
  };

  const inspectAlloc = async (alloc: any) => {
    setSelectedAlloc(alloc);
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
      setSelectedAlloc(det.allocation || alloc);
      const stats = st.stats || st;
      setAllocStats(stats);
      setCpuHist([stats?.ResourceUsage?.CpuStats?.Percent || 0]);
      setMemHist([(stats?.ResourceUsage?.MemoryStats?.RSS || 0) / (1024 * 1024)]);
      setFsFiles(ls.files || ls || []);
    } catch (ex: any) {
      setErr(ex?.message || '加载 Allocation 详情失败');
    }
  };

  useEffect(() => {
    if (!selectedAlloc?.ID) return;
    const t = window.setInterval(async () => {
      try {
        const st = await apiGet(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/stats`);
        const stats = st.stats || st;
        setAllocStats(stats);
        setCpuHist((p) => [...p.slice(-19), stats?.ResourceUsage?.CpuStats?.Percent || 0]);
        setMemHist((p) => [...p.slice(-19), (stats?.ResourceUsage?.MemoryStats?.RSS || 0) / (1024 * 1024)]);
      } catch {
        // ignore transient polling error
      }
    }, 3000);
    return () => window.clearInterval(t);
  }, [clusterId, selectedAlloc?.ID]);

  useEffect(() => {
    if (!selectedAlloc?.ID || !logTask) return;
    setAllocLogs('');
    return openSSE(
      `/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/logs/stream?task=${encodeURIComponent(logTask)}&type=stdout&follow=true`,
      {
        onEvent: (ev, d) => {
          if (ev === 'log' && d?.data) {
            setAllocLogs((p) => p + d.data);
          } else if (typeof d === 'string') {
            setAllocLogs((p) => p + d);
          }
        },
      },
    );
  }, [clusterId, selectedAlloc?.ID, logTask]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTabs
          tabs={[
            { id: 'jobs', label: 'Jobs' },
            { id: 'clients', label: 'Clients' },
            { id: 'servers', label: 'Servers' },
            { id: 'topology', label: '拓扑容量' },
            { id: 'storage', label: '存储 / CSI' },
            { id: 'variables', label: 'Variables' },
            { id: 'evaluations', label: 'Evaluations' },
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
            {(namespaces.length ? namespaces : [{ Name: 'default' }]).map((ns: any) => (
              <option key={ns.Name} value={ns.Name}>{ns.Name}</option>
            ))}
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
                      <tr key={`${j.Namespace}:${j.ID}`}>
                        <td className="py-2 pr-3 font-mono font-medium">{j.ID}</td>
                        <td className="py-2 pr-3">{j.Namespace} · {j.Type}</td>
                        <td className="py-2 pr-3"><Badge tone={statusTone(j.Status)}>{j.Status}</Badge></td>
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
            <Card title={`Job 运行态：${selectedJob.ID} (${selectedJob.Namespace})`}>
              <div className="space-y-4 text-xs">
                {isAdmin && (
                  <div className="flex flex-wrap items-center gap-2 rounded bg-slate-50 p-2.5 dark:bg-slate-950">
                    <span>Task Group：<b>{scaleGroup}</b></span>
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
                          `/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(selectedJob.Namespace)}/jobs/${encodeURIComponent(selectedJob.ID)}/scale`,
                          { group: scaleGroup, count: scaleCount },
                        ).then(() => { setNotice('扩缩副本请求已提交'); return inspectJob(selectedJob); }).catch((ex) => setErr(ex.message))
                      }
                    >
                      扩缩副本
                    </Button>
                    {selectedJob.Type === 'batch' && (
                      <>
                        <Button
                          size="sm"
                          onClick={() =>
                            void apiPost(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(selectedJob.Namespace)}/jobs/${encodeURIComponent(selectedJob.ID)}/periodic/force`, {})
                              .then(() => setNotice('已触发 Periodic 运行'))
                              .catch((ex) => setErr(ex.message))
                          }
                        >
                          立即触发 Periodic
                        </Button>
                        <Button
                          size="sm"
                          onClick={() =>
                            void apiPost(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(selectedJob.Namespace)}/jobs/${encodeURIComponent(selectedJob.ID)}/dispatch`, { meta: {} })
                              .then(() => setNotice('已派发 Parameterized 子任务'))
                              .catch((ex) => setErr(ex.message))
                          }
                        >
                          Dispatch 派发
                        </Button>
                      </>
                    )}
                  </div>
                )}

                {jobDeps.length > 0 && (
                  <div>
                    <div className="mb-1 font-semibold">Deployments</div>
                    {jobDeps.map((d) => (
                      <div key={d.ID} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2 dark:border-slate-800">
                        <span>{d.ID.slice(0, 8)} · <Badge tone={statusTone(d.Status)}>{d.Status}</Badge> {d.StatusDescription}</span>
                        {isAdmin && d.Status === 'running' && (
                          <div className="flex gap-1">
                            <Button size="sm" variant="primary" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/promote`, {}).then(() => inspectJob(selectedJob))}>Promote</Button>
                            <Button size="sm" variant="danger" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/fail`, {}).then(() => inspectJob(selectedJob))}>Fail</Button>
                            <Button size="sm" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/pause`, {}).then(() => inspectJob(selectedJob))}>Pause</Button>
                            <Button size="sm" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/resume`, {}).then(() => inspectJob(selectedJob))}>Resume</Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div>
                  <div className="mb-1 font-semibold">Allocations ({jobAllocs.length})</div>
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
            <Card title={`Allocation 详情：${selectedAlloc.ID}`}>
              <div className="space-y-4 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-4">
                    <Sparkline values={cpuHist} color="#10b981" label={`CPU ${(cpuHist[cpuHist.length - 1] || 0).toFixed(1)}%`} />
                    <Sparkline values={memHist} max={512} color="#0ea5e9" label={`Mem ${(memHist[memHist.length - 1] || 0).toFixed(1)} MiB`} />
                  </div>
                  {isAdmin && logTask && (
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="sm" variant="primary" onClick={() => setTerminal({ allocId: selectedAlloc.ID, task: logTask })}>
                        <Terminal className="h-3 w-3" /> 打开交互式终端
                      </Button>
                      <Button size="sm" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/restart`, { task: logTask }).then(() => setNotice('已请求重启 Task'))}>重启 Task</Button>
                      <Button size="sm" variant="danger" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/stop`, {}).then(() => setNotice('已请求停止 Alloc'))}>停止 Alloc</Button>
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
                            void apiGet(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/fs/ls?path=${encodeURIComponent(parent)}`).then((r) => setFsFiles(r.files || r || []));
                          }}
                        >
                          上级
                        </Button>
                      )}
                    </div>
                    <div className="h-56 overflow-auto rounded border border-slate-200 p-2 dark:border-slate-800">
                      {(fsFiles || []).map((f: any) => (
                        <div key={f.Name} className="flex items-center justify-between py-1">
                          <span className="font-mono">{f.IsDir ? `${f.Name}/` : f.Name}</span>
                          <div className="flex gap-1">
                            <span className="text-slate-500">{fmtBytes(f.Size)}</span>
                            {f.IsDir ? (
                              <Button
                                size="sm"
                                onClick={() => {
                                  const np = fsPath ? `${fsPath}/${f.Name}` : f.Name;
                                  setFsPath(np);
                                  void apiGet(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/fs/ls?path=${encodeURIComponent(np)}`).then((r) => setFsFiles(r.files || r || []));
                                }}
                              >
                                进入
                              </Button>
                            ) : (
                              isAdmin && (
                                <>
                                  <Button
                                    size="sm"
                                    onClick={() => {
                                      const fp = fsPath ? `${fsPath}/${f.Name}` : f.Name;
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
                                      const fp = fsPath ? `${fsPath}/${f.Name}` : f.Name;
                                      void apiDownload(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/fs/content/download?path=${encodeURIComponent(fp)}`, undefined, f.Name);
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
        <Card title="Nomad Client 节点">
          <div className="space-y-2 text-xs">
            {clients.map((c) => (
              <div key={c.ID} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2.5 dark:border-slate-800">
                <div>
                  <span className="font-semibold">{c.Name}</span> <span className="font-mono text-slate-500">({c.ID.slice(0, 8)})</span>
                  <div className="text-slate-500">调度：{c.SchedulingEligibility} · Drain：{c.Drain ? '是' : '否'}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge tone={statusTone(c.Status)}>{c.Status}</Badge>
                  {isAdmin && (
                    <>
                      <Button
                        size="sm"
                        onClick={() =>
                          void apiPost(`/api/v1/nomad/${clusterId}/clients/${c.ID}/eligibility`, {
                            eligible: c.SchedulingEligibility !== 'eligible',
                          }).then(() => loadInfraViews('clients'))
                        }
                      >
                        {c.SchedulingEligibility === 'eligible' ? '设为不可调度' : '恢复可调度'}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() =>
                          void apiPost(`/api/v1/nomad/${clusterId}/clients/${c.ID}/drain`, { enable: !c.Drain })
                            .then(() => loadInfraViews('clients'))
                        }
                      >
                        {c.Drain ? '取消 Drain' : 'Drain'}
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
        <Card title="CSI 卷与存储插件">
          <div className="space-y-3 text-xs">
            <div>CSI 卷数量：{volumes.length} · 插件数量：{plugins.length}</div>
            {volumes.map((v) => (
              <div key={v.ID} className="flex items-center justify-between rounded border border-slate-200 p-2 dark:border-slate-800">
                <span className="font-mono">{v.ID} ({v.Name})</span>
                {isAdmin && (
                  <Button size="sm" variant="danger" onClick={() => void apiDelete(`/api/v1/nomad/${clusterId}/volumes/${v.ID}`).then(() => loadInfraViews('storage'))}>
                    注销
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {subTab === 'variables' && (
        <Card
          title="Nomad Variables"
          actions={isAdmin && <Button size="sm" variant="primary" onClick={() => setVarEdit({ path: '', items: '{}' })}>新建 Variable</Button>}
        >
          <div className="space-y-2 text-xs">
            {variables.map((v) => (
              <div key={`${v.Namespace}:${v.Path}`} className="flex items-center justify-between rounded border border-slate-200 p-2 dark:border-slate-800">
                <span className="font-mono">{v.Namespace} / {v.Path}</span>
                {isAdmin && (
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      onClick={() =>
                        void apiPost(`/api/v1/nomad/${clusterId}/variables/item/reveal?path=${encodeURIComponent(v.Path)}&namespace=${encodeURIComponent(v.Namespace)}`, {})
                          .then((r) => setVarEdit({ path: v.Path, items: JSON.stringify(r.variable?.Items || {}, null, 2), modifyIndex: r.variable?.ModifyIndex }))
                          .catch((ex) => setErr(ex.message))
                      }
                    >
                      查看原文 / 编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void apiDelete(`/api/v1/nomad/${clusterId}/variables/item?path=${encodeURIComponent(v.Path)}&namespace=${encodeURIComponent(v.Namespace)}`).then(() => loadInfraViews('variables'))}
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
            <Input label="Path" value={varEdit.path} onChange={(e) => setVarEdit({ ...varEdit, path: e.target.value })} />
            <CodeEditor value={varEdit.items} onChange={(v) => setVarEdit({ ...varEdit, items: v })} height="220px" />
            <Button
              variant="primary"
              onClick={() => {
                try {
                  const items = JSON.parse(varEdit.items);
                  void apiPut(`/api/v1/nomad/${clusterId}/variables/item?path=${encodeURIComponent(varEdit.path)}&namespace=${encodeURIComponent(namespace === '*' ? 'default' : namespace)}`, {
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
