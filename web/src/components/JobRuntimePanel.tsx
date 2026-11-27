import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  Minus,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Terminal,
  Trash2,
} from 'lucide-react';
import { apiDownload, apiGet, apiPost, fmtBytes, fmtTime, openSSE } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog';
import {
  Badge,
  Button,
  Card,
  ErrorAlert,
  LoadingState,
  Modal,
  SectionTabs,
  Select,
  StatusBadge,
  TermLabel,
} from './UI';
import { Drawer } from './Drawer';
import { TerminalModal } from './TerminalModal';
import { ResourceUtilizationPanel } from './ResourceUtilizationPanel';
import {
  AllocCapacity,
  appendResourceSample,
  extractAllocCapacity,
  extractResourceSamples,
  ResourceSample,
} from '../lib/allocResourceChart';

export interface JobRuntimeRef {
  id: string;
  namespace: string;
  status?: string;
  type?: string;
  stop?: boolean;
  groups?: string[];
  periodic?: boolean;
  parameterized?: boolean;
}

interface JobRuntimePanelProps {
  clusterId: string;
  job: JobRuntimeRef;
  onBack: () => void;
  onEdit: (job: JobRuntimeRef) => void;
  onChanged?: () => void;
  onDeleted?: () => void;
}

export function JobRuntimePanel({
  clusterId,
  job,
  onBack,
  onEdit,
  onChanged,
  onDeleted,
}: JobRuntimePanelProps) {
  const { isAdmin } = useAuth();
  const { locale, tr } = useI18n();
  const toast = useToast();
  const askConfirm = useConfirm();

  const [selectedJob, setSelectedJob] = useState<JobRuntimeRef>(job);
  const [jobSummary, setJobSummary] = useState<any>(null);
  const [jobAllocs, setJobAllocs] = useState<any[]>([]);
  const [jobDeps, setJobDeps] = useState<any[]>([]);
  const [jobEvals, setJobEvals] = useState<any[]>([]);
  const [revisions, setRevisions] = useState<any[]>([]);
  const [groupCounts, setGroupCounts] = useState<Record<string, number>>({});
  const [scalingGroup, setScalingGroup] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [err, setErr] = useState('');

  // Allocation inspection drawer state
  const [selectedAlloc, setSelectedAlloc] = useState<any>(null);
  const [allocStats, setAllocStats] = useState<any>(null);
  const [allocCapacity, setAllocCapacity] = useState<AllocCapacity>({ cpuMHz: 0, memMB: 0 });
  const [cpuHist, setCpuHist] = useState<ResourceSample[]>([]);
  const [memHist, setMemHist] = useState<ResourceSample[]>([]);
  const [statsNowTs, setStatsNowTs] = useState<number>(() => Date.now());
  const [fsPath, setFsPath] = useState('');
  const [fsFiles, setFsFiles] = useState<any[]>([]);
  const [fsLoading, setFsLoading] = useState(false);
  const [filePreview, setFilePreview] = useState<{ path: string; text: string } | null>(null);
  const [allocLogs, setAllocLogs] = useState('');
  const [logTask, setLogTask] = useState('');
  const [logType, setLogType] = useState<'stdout' | 'stderr'>('stdout');
  const [logRevision, setLogRevision] = useState(0);
  const [allocTab, setAllocTab] = useState<'logs' | 'events' | 'files'>('logs');
  const [terminal, setTerminal] = useState<{ allocId: string; task: string; action?: string } | null>(null);

  const jobRequestRef = useRef(0);
  const allocRequestRef = useRef(0);
  const fsRequestRef = useRef(0);
  const allocCapacityRef = useRef<AllocCapacity>({ cpuMHz: 0, memMB: 0 });
  const jobId = job.id;
  const jobNs = job.namespace || 'default';

  const closeAllocDrawer = useCallback(() => {
    ++allocRequestRef.current;
    ++fsRequestRef.current;
    allocCapacityRef.current = { cpuMHz: 0, memMB: 0 };
    setSelectedAlloc(null);
    setAllocStats(null);
    setAllocCapacity({ cpuMHz: 0, memMB: 0 });
    setCpuHist([]);
    setMemHist([]);
    setAllocLogs('');
    setFsFiles([]);
    setFsPath('');
    setFsLoading(false);
    setFilePreview(null);
  }, []);

  const loadJobRuntime = useCallback(
    async (silent = false) => {
      const request = ++jobRequestRef.current;
      if (!silent) {
        setJobSummary(null);
        setErr('');
      }
      const jid = encodeURIComponent(jobId);
      const nsEnc = encodeURIComponent(jobNs);
      try {
        const [sum, allocs, deps, evals, detail, rev] = await Promise.all([
          apiGet(`/api/v1/nomad/${clusterId}/namespaces/${nsEnc}/jobs/${jid}/summary`),
          apiGet(`/api/v1/nomad/${clusterId}/namespaces/${nsEnc}/jobs/${jid}/allocations`),
          apiGet(`/api/v1/nomad/${clusterId}/namespaces/${nsEnc}/jobs/${jid}/deployments`),
          apiGet(`/api/v1/nomad/${clusterId}/namespaces/${nsEnc}/jobs/${jid}/evaluations`),
          apiGet(`/api/v1/nomad/${clusterId}/namespaces/${nsEnc}/jobs/${jid}`).catch(() => null),
          apiGet(`/api/v1/nomad/${clusterId}/namespaces/${nsEnc}/jobs/${jid}/revisions`).catch(() => ({ revisions: [] })),
        ]);
        if (request !== jobRequestRef.current) return;

        const meta = detail?.job?.summary || detail?.job;
        const rawGroups = Array.isArray(meta?.groups)
          ? meta.groups
          : Array.isArray(detail?.job?.TaskGroups)
            ? detail.job.TaskGroups
            : Array.isArray(job.groups)
              ? job.groups
              : [];
        const groupNames: string[] = rawGroups
          .map((g: any) => (typeof g === 'string' ? g : g?.name || g?.Name || ''))
          .filter(Boolean);
        const s = sum.data || sum.summary || sum;
        const summaryMap: Record<string, any> = s?.Summary || {};
        const finalGroupNames = groupNames.length > 0 ? groupNames : Object.keys(summaryMap);

        const enriched: JobRuntimeRef = {
          id: meta?.id || jobId,
          namespace: meta?.namespace || jobNs,
          type: detail?.job?.type || meta?.type || job.type || 'service',
          status: detail?.job?.status || meta?.status || job.status,
          stop: detail?.job?.stop ?? meta?.stop ?? job.stop,
          groups: finalGroupNames,
          periodic: Boolean(
            typeof meta?.periodic === 'boolean'
              ? meta.periodic
              : (meta?.periodic?.Enabled ?? meta?.periodic?.enabled ?? job.periodic),
          ),
          parameterized: Boolean(
            typeof meta?.parameterized === 'boolean'
              ? meta.parameterized
              : (meta?.parameterized && Object.keys(meta.parameterized).length > 0) || job.parameterized,
          ),
        };
        setSelectedJob(enriched);
        setJobSummary(s);
        setJobAllocs(allocs.data || allocs.allocations || []);
        setJobDeps(deps.data || deps.deployments || []);
        setJobEvals(evals.data || evals.evaluations || []);
        setRevisions(rev?.revisions || []);

        // Seed per-group desired count from spec or live summary (Running + Starting + Queued)
        const nextCounts: Record<string, number> = {};
        const specTaskGroups: any[] = Array.isArray(detail?.job?.TaskGroups) ? detail.job.TaskGroups : [];
        for (const gName of finalGroupNames) {
          const specGrp = specTaskGroups.find((tg: any) => (tg?.Name || tg?.name) === gName);
          if (specGrp && typeof (specGrp.Count ?? specGrp.count) === 'number') {
            nextCounts[gName] = specGrp.Count ?? specGrp.count;
          } else {
            const st = summaryMap[gName];
            const active = (st?.Running || 0) + (st?.Starting || 0) + (st?.Queued || 0);
            nextCounts[gName] = active > 0 ? active : 1;
          }
        }
        setGroupCounts((prev) => (silent && Object.keys(prev).length > 0 ? prev : nextCounts));
      } catch (ex: any) {
        if (request === jobRequestRef.current) setErr(ex?.message || tr('加载 Job 运行态失败', 'Failed to load Job runtime'));
      }
    },
    [clusterId, jobId, jobNs, tr],
  );

  useEffect(() => {
    closeAllocDrawer();
    setSelectedJob(job);
    void loadJobRuntime(false);
  }, [clusterId, jobId, jobNs, loadJobRuntime, closeAllocDrawer]);

  // Live SSE auto-refresh for job runtime
  useEffect(() => {
    const stop = openSSE(`/api/v1/nomad/${clusterId}/watch?topics=jobs,evaluations`, {
      onEvent: (ev) => {
        if (ev === 'change' || ev === 'watch' || ev === 'update') {
          void loadJobRuntime(true);
        }
      },
    });
    return stop;
  }, [clusterId, loadJobRuntime]);

  const inspectAlloc = async (alloc: any, initialTab: 'logs' | 'events' | 'files' = 'logs') => {
    const request = ++allocRequestRef.current;
    ++fsRequestRef.current;
    const sameAlloc = selectedAlloc?.ID === alloc.ID;
    const initialCap = extractAllocCapacity(alloc);
    allocCapacityRef.current = initialCap;
    setAllocTab(initialTab);
    setSelectedAlloc(alloc);
    setAllocCapacity(initialCap);
    setAllocStats(null);
    setFsFiles([]);
    if (!sameAlloc) {
      setCpuHist([]);
      setMemHist([]);
    }
    setAllocLogs('');
    setLogRevision((r) => r + 1);
    setFsPath('');
    setFsLoading(false);
    setFilePreview(null);
    const firstTask = Object.keys(alloc.TaskStates || {})[0] || '';
    setLogTask((current) => (sameAlloc && alloc.TaskStates?.[current] ? current : firstTask));
    try {
      const [det, st, ls] = await Promise.all([
        apiGet(`/api/v1/nomad/${clusterId}/allocs/${alloc.ID}`),
        apiGet(`/api/v1/nomad/${clusterId}/allocs/${alloc.ID}/stats`),
        apiGet(`/api/v1/nomad/${clusterId}/allocs/${alloc.ID}/fs/ls?path=`),
      ]);
      if (request !== allocRequestRef.current) return;
      const detail = det.allocation || alloc;
      const cap = extractAllocCapacity(detail);
      allocCapacityRef.current = cap;
      setSelectedAlloc(detail);
      setAllocCapacity(cap);
      setLogTask((current) =>
        current && detail.TaskStates?.[current] ? current : Object.keys(detail.TaskStates || {})[0] || '',
      );
      const stats = st.stats || st;
      const ts = Date.now();
      const samples = extractResourceSamples(stats, cap, ts);
      setAllocStats(stats);
      setStatsNowTs(ts);
      setCpuHist((p) => (sameAlloc ? appendResourceSample(p, samples.cpu) : [samples.cpu]));
      setMemHist((p) => (sameAlloc ? appendResourceSample(p, samples.mem) : [samples.mem]));
      setFsFiles(ls.files || ls || []);
    } catch (ex: any) {
      if (request === allocRequestRef.current) setErr(ex?.message || tr('加载 Allocation 详情失败', 'Failed to load Allocation details'));
    }
  };

  const browseAllocDir = useCallback(
    async (targetPath: string) => {
      if (!selectedAlloc?.ID) return;
      const allocId = selectedAlloc.ID;
      const allocReq = allocRequestRef.current;
      const fsReq = ++fsRequestRef.current;
      setFsLoading(true);
      setErr('');
      try {
        const r = await apiGet(
          `/api/v1/nomad/${clusterId}/allocs/${allocId}/fs/ls?path=${encodeURIComponent(targetPath)}`,
        );
        if (allocReq !== allocRequestRef.current || fsReq !== fsRequestRef.current) return;
        setFsPath(targetPath);
        setFsFiles(r.files || r || []);
      } catch (ex: any) {
        if (allocReq === allocRequestRef.current && fsReq === fsRequestRef.current) {
          setErr(ex?.message || tr('读取目录失败', 'Failed to list directory'));
        }
      } finally {
        if (allocReq === allocRequestRef.current && fsReq === fsRequestRef.current) {
          setFsLoading(false);
        }
      }
    },
    [clusterId, selectedAlloc?.ID, tr],
  );

  const previewAllocFile = useCallback(
    async (filePath: string) => {
      if (!selectedAlloc?.ID) return;
      try {
        const r = await apiGet(
          `/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/fs/content/readat?path=${encodeURIComponent(filePath)}&offset=0&limit=32768`,
        );
        setFilePreview({
          path: filePath,
          text: typeof r === 'string' ? r : r.data || JSON.stringify(r),
        });
      } catch (ex: any) {
        setErr(ex?.message || tr('预览文件失败', 'Failed to preview file'));
      }
    },
    [clusterId, selectedAlloc?.ID, tr],
  );

  useEffect(() => {
    if (!selectedAlloc?.ID) return;
    let active = true;
    const t = window.setInterval(async () => {
      try {
        const st = await apiGet(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/stats`);
        if (!active) return;
        const stats = st.stats || st;
        const ts = Date.now();
        const samples = extractResourceSamples(stats, allocCapacityRef.current, ts);
        setAllocStats(stats);
        setStatsNowTs(ts);
        setCpuHist((p) => appendResourceSample(p, samples.cpu));
        setMemHist((p) => appendResourceSample(p, samples.mem));
      } catch {
        // Ignore transient polling errors
      }
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(t);
    };
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

  const handleLifecycle = async (action: 'start' | 'stop' | 'purge') => {
    const nsEnc = encodeURIComponent(selectedJob.namespace || 'default');
    const jidEnc = encodeURIComponent(selectedJob.id);
    if (action === 'stop') {
      const ok = await askConfirm(tr(`确认停止运行中的 Job「${selectedJob.id}」（Namespace: ${selectedJob.namespace}）吗？`, `Stop running Job "${selectedJob.id}" (Namespace: ${selectedJob.namespace})?`), {
        title: tr('停止 Job', 'Stop Job'),
        confirmText: tr('确认停止', 'Stop'),
        danger: true,
      });
      if (!ok) return;
    } else if (action === 'purge') {
      const ok = await askConfirm(tr(`确认清理并彻底删除 Job「${selectedJob.id}」（Namespace: ${selectedJob.namespace}）吗？此操作不可恢复。`, `Purge and permanently delete Job "${selectedJob.id}" (Namespace: ${selectedJob.namespace})? This cannot be undone.`), {
        title: tr('清理删除 Job', 'Purge Job'),
        confirmText: tr('确认 Purge', 'Purge'),
        danger: true,
      });
      if (!ok) return;
    }
    setBusyAction(action);
    setErr('');
    try {
      await apiPost(
        `/api/v1/nomad/${clusterId}/namespaces/${nsEnc}/jobs/${jidEnc}/${action}`,
        action === 'purge' ? { confirm_job_id: selectedJob.id } : {},
      );
      if (action === 'purge') {
        toast.success(tr(`已清理 Job ${selectedJob.id}`, `Purged Job ${selectedJob.id}`));
        onDeleted?.();
        return;
      }
      toast.success(action === 'start' ? tr(`已启动 Job ${selectedJob.id}`, `Started Job ${selectedJob.id}`) : tr(`已停止 Job ${selectedJob.id}`, `Stopped Job ${selectedJob.id}`));
      onChanged?.();
      await loadJobRuntime(true);
    } catch (ex: any) {
      setErr(ex?.message || tr(`执行 ${action} 失败`, `Failed to ${action} job`));
    } finally {
      setBusyAction('');
    }
  };

  const handleScaleGroup = async (groupName: string, count: number) => {
    setScalingGroup(groupName);
    setErr('');
    try {
      await apiPost(
        `/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(selectedJob.namespace)}/jobs/${encodeURIComponent(selectedJob.id)}/scale`,
        { group: groupName, count },
      );
      toast.success(tr(`已提交任务组「${groupName}」扩缩容至 ${count}`, `Scaled task group "${groupName}" to ${count}`));
      onChanged?.();
      await loadJobRuntime(true);
    } catch (ex: any) {
      setErr(ex?.message || tr('扩缩容失败', 'Failed to scale group'));
    } finally {
      setScalingGroup('');
    }
  };

  const summaryEntries = Object.entries<any>(jobSummary?.Summary || {});

  return (
    <div className="space-y-4">
      {/* Top Breadcrumb & Quick Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#e3e8f1] bg-white px-4 py-3 text-xs shadow-[0_2px_10px_rgba(15,23,42,0.03)] dark:border-slate-800 dark:bg-[#0f172a]/95">
        <nav aria-label={tr('Job 运行态路径', 'Job runtime breadcrumb')} className="flex flex-wrap items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>{tr('返回 Jobs 列表', 'Back to Jobs')}</span>
          </button>
          <ChevronRight className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          <span className="font-mono text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
            {selectedJob.id}
          </span>
          <Badge>{selectedJob.namespace}</Badge>
          {selectedJob.type && <Badge tone="blue">{selectedJob.type}</Badge>}
          <StatusBadge value={selectedJob.stop ? 'stopped' : selectedJob.status} />
        </nav>

        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          {isAdmin && (
            <>
              <Button size="sm" variant="primary" onClick={() => onEdit(selectedJob)}>
                <Pencil className="h-3.5 w-3.5" />
                <span>{tr('编排编辑', 'Edit Spec')}</span>
              </Button>
              {selectedJob.periodic && (
                <Button
                  size="sm"
                  onClick={() =>
                    void apiPost(
                      `/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(selectedJob.namespace)}/jobs/${encodeURIComponent(selectedJob.id)}/periodic/force`,
                      {},
                    )
                      .then(() => {
                        toast.success(tr('已立即触发 Periodic 运行', 'Forced periodic run'));
                        return loadJobRuntime(true);
                      })
                      .catch((ex) => setErr(ex.message))
                  }
                >
                  {tr('立即触发', 'Force Run')}
                </Button>
              )}
              {selectedJob.parameterized && (
                <Button
                  size="sm"
                  onClick={() =>
                    void apiPost(
                      `/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(selectedJob.namespace)}/jobs/${encodeURIComponent(selectedJob.id)}/dispatch`,
                      { meta: {} },
                    )
                      .then(() => {
                        toast.success(tr('已派发 Parameterized 子任务', 'Dispatched parameterized job'));
                        return loadJobRuntime(true);
                      })
                      .catch((ex) => setErr(ex.message))
                  }
                >
                  {tr('Dispatch 派发', 'Dispatch')}
                </Button>
              )}
              {selectedJob.stop ? (
                <Button size="sm" loading={busyAction === 'start'} onClick={() => void handleLifecycle('start')}>
                  <Play className="h-3.5 w-3.5" />
                  <span>{tr('启动', 'Start')}</span>
                </Button>
              ) : (
                <Button size="sm" loading={busyAction === 'stop'} onClick={() => void handleLifecycle('stop')}>
                  <Square className="h-3.5 w-3.5" />
                  <span>{tr('停止', 'Stop')}</span>
                </Button>
              )}
              <Button
                size="sm"
                variant="danger-outline"
                loading={busyAction === 'purge'}
                onClick={() => void handleLifecycle('purge')}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>{tr('清理', 'Purge')}</span>
              </Button>
            </>
          )}
          <Button size="sm" onClick={() => void loadJobRuntime(true)}>
            <RefreshCw className="h-3.5 w-3.5" />
            <span>{tr('刷新', 'Refresh')}</span>
          </Button>
        </div>
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {!jobSummary ? (
        <Card>
          <LoadingState label={tr(`正在加载 Job ${selectedJob.id} 运行态…`, `Loading runtime for Job ${selectedJob.id}...`)} />
        </Card>
      ) : (
        <div className="space-y-4">
          {/* Task Group Summary & Inline Scale Cards */}
          {summaryEntries.length > 0 && (
            <div className={`grid grid-cols-1 gap-3 ${summaryEntries.length > 1 ? 'md:grid-cols-2' : ''}`}>
              {summaryEntries.map(([groupName, stats]) => {
                const desired = groupCounts[groupName] ?? ((stats.Running || 0) + (stats.Starting || 0) + (stats.Queued || 0));
                return (
                  <Card
                    key={groupName}
                    bodyClassName="p-4"
                    title={
                      <div className="flex items-center gap-2">
                        <span className="font-mono">{groupName}</span>
                        <span className="text-[11px] font-normal text-slate-400">Task Group</span>
                      </div>
                    }
                    actions={
                      isAdmin && (
                        <div className="flex items-center gap-1.5">
                          <div className="inline-flex items-center rounded-lg border border-[#dce3ee] bg-white dark:border-slate-700 dark:bg-slate-950">
                            <button
                              type="button"
                              aria-label={tr(`减少 ${groupName} 副本数`, `Decrease ${groupName} count`)}
                              disabled={desired <= 0 || scalingGroup === groupName}
                              onClick={() =>
                                setGroupCounts((prev) => ({ ...prev, [groupName]: Math.max(0, desired - 1) }))
                              }
                              className="px-2 py-1 text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800 rounded-l-lg"
                            >
                              <Minus className="h-3 w-3" />
                            </button>
                            <input
                              aria-label={tr(`${groupName} 目标副本数`, `${groupName} target count`)}
                              type="number"
                              min={0}
                              value={desired}
                              onChange={(e) =>
                                setGroupCounts((prev) => ({
                                  ...prev,
                                  [groupName]: Math.max(0, Math.round(Number(e.target.value) || 0)),
                                }))
                              }
                              className="w-12 border-x border-[#dce3ee] bg-transparent py-1 text-center font-mono text-xs font-semibold text-slate-900 focus:outline-none dark:border-slate-700 dark:text-slate-100"
                            />
                            <button
                              type="button"
                              aria-label={tr(`增加 ${groupName} 副本数`, `Increase ${groupName} count`)}
                              disabled={scalingGroup === groupName}
                              onClick={() =>
                                setGroupCounts((prev) => ({ ...prev, [groupName]: desired + 1 }))
                              }
                              className="px-2 py-1 text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800 rounded-r-lg"
                            >
                              <Plus className="h-3 w-3" />
                            </button>
                          </div>
                          <Button
                            size="sm"
                            loading={scalingGroup === groupName}
                            onClick={() => void handleScaleGroup(groupName, desired)}
                          >
                            {tr('扩缩容', 'Scale')}
                          </Button>
                        </div>
                      )
                    }
                  >
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 text-center text-xs">
                      {[
                        { label: tr('运行中', 'Running'), val: stats.Running || 0, cls: 'text-emerald-600 dark:text-emerald-400' },
                        { label: tr('启动中', 'Starting'), val: stats.Starting || 0, cls: 'text-indigo-600 dark:text-indigo-400' },
                        { label: tr('排队中', 'Queued'), val: stats.Queued || 0, cls: 'text-amber-600 dark:text-amber-400' },
                        { label: tr('已完成', 'Complete'), val: stats.Complete || 0, cls: 'text-slate-600 dark:text-slate-300' },
                        { label: tr('失败', 'Failed'), val: stats.Failed || 0, cls: stats.Failed ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400' },
                        { label: tr('失联', 'Lost'), val: stats.Lost || 0, cls: stats.Lost ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400' },
                      ].map((m) => (
                        <div key={m.label} className="rounded-lg bg-slate-50/80 py-2 dark:bg-slate-950/50">
                          <div className={`font-mono text-base font-bold tabular-nums ${m.cls}`}>{m.val}</div>
                          <div className="mt-0.5 text-[10px] text-slate-500">{m.label}</div>
                        </div>
                      ))}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          {/* Active Deployments */}
          {jobDeps.length > 0 && (
            <Card
              title={
                <TermLabel
                  term={`Deployments (${jobDeps.length})`}
                  tip={tr('滚动发布与金丝雀升级控制器，支持 Promote（放行全量）、Pause、Resume 与 Fail 回滚。', 'Rolling/canary deployment controller supporting Promote, Pause, Resume, and Fail rollback.')}
                />
              }
              bodyClassName="p-4"
            >
              <div className="space-y-2 text-xs">
                {jobDeps.slice(0, 5).map((d) => (
                  <div
                    key={d.ID}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-slate-50/50 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-950/30"
                  >
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="font-mono font-semibold text-slate-800 dark:text-slate-100">{d.ID.slice(0, 8)}</span>
                      <StatusBadge value={d.Status} />
                      <span className="text-slate-600 dark:text-slate-300">{d.StatusDescription || '-'}</span>
                    </div>
                    {isAdmin && d.Status === 'running' && (
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() =>
                            void apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/promote`, {})
                              .then(() => {
                                toast.success(tr('已放行 Deployment (Promote)', 'Deployment promoted'));
                                return loadJobRuntime(true);
                              })
                              .catch((ex) => setErr(ex.message))
                          }
                        >
                          Promote
                        </Button>
                        <Button
                          size="sm"
                          onClick={() =>
                            void apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/pause`, {})
                              .then(() => {
                                toast.success(tr('已暂停 Deployment', 'Deployment paused'));
                                return loadJobRuntime(true);
                              })
                              .catch((ex) => setErr(ex.message))
                          }
                        >
                          Pause
                        </Button>
                        <Button
                          size="sm"
                          onClick={() =>
                            void apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/resume`, {})
                              .then(() => {
                                toast.success(tr('已恢复 Deployment', 'Deployment resumed'));
                                return loadJobRuntime(true);
                              })
                              .catch((ex) => setErr(ex.message))
                          }
                        >
                          Resume
                        </Button>
                        <Button
                          size="sm"
                          variant="danger-outline"
                          onClick={() =>
                            void askConfirm(tr(`确定要将 Deployment ${d.ID.slice(0, 8)} 标记为失败并触发回滚吗？`, `Mark Deployment ${d.ID.slice(0, 8)} as failed and trigger rollback?`), {
                              title: tr('回滚 Deployment', 'Rollback Deployment'),
                              confirmText: tr('确认 Fail', 'Fail Deployment'),
                              danger: true,
                            })
                              .then((ok) =>
                                ok
                                  ? apiPost(`/api/v1/nomad/${clusterId}/deployments/${d.ID}/fail`, {}).then(() => {
                                      toast.success(tr('已触发 Deployment Fail', 'Deployment marked as failed'));
                                      return loadJobRuntime(true);
                                    })
                                  : undefined,
                              )
                              .catch((ex) => setErr(ex.message))
                          }
                        >
                          Fail
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Allocations Table */}
          <Card
            title={
              <TermLabel
                term={tr(`实例副本 · Allocations (${jobAllocs.length})`, `Allocations (${jobAllocs.length})`)}
                tip={tr('Task Group 在具体 Client 节点上运行的容器/进程实例，可直接查看实时日志、CPU/内存监控、文件与进入交互终端。', 'Task Group instances running on Client nodes; inspect live logs, CPU/memory metrics, files, and interactive terminal.')}
              />
            }
          >
            <div className="space-y-3 text-xs">
              {selectedJob.status === 'pending' && jobAllocs.length === 0 && (() => {
                const latestEval = jobEvals.find(
                  (ev) => ev.BlockedEval || ev.StatusDescription || (ev.FailedTGAllocs && Object.keys(ev.FailedTGAllocs).length > 0),
                );
                if (!latestEval) return null;
                const reasons: string[] = [];
                if (latestEval.FailedTGAllocs && typeof latestEval.FailedTGAllocs === 'object') {
                  for (const [grp, m] of Object.entries<any>(latestEval.FailedTGAllocs)) {
                    if (m?.NodesEvaluated === 0) reasons.push(tr(`任务组 ${grp} 没有匹配且在线的 Client 节点`, `Task group ${grp} has no eligible online Client nodes`));
                    if (m?.ConstraintFiltered && typeof m.ConstraintFiltered === 'object') {
                      for (const [k, cnt] of Object.entries<any>(m.ConstraintFiltered)) {
                        reasons.push(tr(`任务组 ${grp}：${k}（${cnt} 个节点不满足）`, `Task group ${grp}: ${k} (${cnt} nodes filtered)`));
                      }
                    }
                    if (m?.DimensionExhausted && typeof m.DimensionExhausted === 'object') {
                      for (const [k, cnt] of Object.entries<any>(m.DimensionExhausted)) {
                        reasons.push(tr(`任务组 ${grp} 资源不足：${k}（${cnt} 个节点）`, `Task group ${grp} exhausted ${k} (${cnt} nodes)`));
                      }
                    }
                  }
                }
                if (reasons.length === 0 && latestEval.StatusDescription) {
                  reasons.push(String(latestEval.StatusDescription));
                }
                if (reasons.length === 0) return null;
                return (
                  <div
                    role="alert"
                    className="rounded-xl border border-amber-300 bg-amber-50/90 p-3 text-xs text-amber-950 space-y-1 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100"
                  >
                    <div className="font-semibold">
                      {tr(`调度阻塞原因（Evaluation ${String(latestEval.ID || '').slice(0, 8)}）：`, `Scheduling Blocked (Evaluation ${String(latestEval.ID || '').slice(0, 8)}):`)}
                    </div>
                    {reasons.map((r, i) => (
                      <p key={i} className="leading-5">
                        • {r}
                      </p>
                    ))}
                  </div>
                );
              })()}

              {jobAllocs.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-slate-400 dark:border-slate-800">
                  {tr('暂无 Allocation 实例', 'No Allocations yet')}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200/80 dark:border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50/70 text-slate-500 dark:bg-slate-950/40 dark:text-slate-400">
                      <tr className="border-b border-slate-200/80 dark:border-slate-800">
                        <th className="px-3 py-2.5 font-medium">Allocation ID</th>
                        <th className="px-3 py-2.5 font-medium">Task Group</th>
                        <th className="px-3 py-2.5 font-medium">{tr('运行节点', 'Node')}</th>
                        <th className="px-3 py-2.5 font-medium">{tr('状态 / Tasks', 'Status / Tasks')}</th>
                        <th className="px-3 py-2.5 text-right font-medium">{tr('操作', 'Actions')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                      {jobAllocs.map((a) => {
                        const taskEntries = Object.entries<any>(a.TaskStates || {});
                        const runningTask = taskEntries.find(([, st]) => st?.State === 'running')?.[0];
                        return (
                          <tr key={a.ID} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                            <td className="px-3 py-2.5 font-mono font-semibold text-slate-900 dark:text-slate-100">
                              <button
                                type="button"
                                onClick={() => void inspectAlloc(a, 'logs')}
                                className="hover:text-indigo-600 hover:underline dark:hover:text-indigo-400"
                              >
                                {a.ID.slice(0, 8)}
                              </button>
                            </td>
                            <td className="px-3 py-2.5 text-slate-700 dark:text-slate-300">{a.TaskGroup || '-'}</td>
                            <td className="px-3 py-2.5 font-mono text-slate-600 dark:text-slate-300">{a.NodeName || '-'}</td>
                            <td className="px-3 py-2.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <StatusBadge value={a.ClientStatus} />
                                {taskEntries.map(([tName, st]) => (
                                  <Badge key={tName} tone={st?.State === 'running' ? 'green' : st?.Failed ? 'red' : 'neutral'}>
                                    {tName}: {st?.State || '-'}
                                  </Badge>
                                ))}
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <div className="flex flex-wrap items-center justify-end gap-1.5">
                                <Button size="sm" onClick={() => void inspectAlloc(a, 'logs')}>
                                  {tr('日志与详情', 'Logs & Inspect')}
                                </Button>
                                {isAdmin && runningTask && (
                                  <Button
                                    size="sm"
                                    onClick={() => setTerminal({ allocId: a.ID, task: runningTask })}
                                  >
                                    <Terminal className="h-3.5 w-3.5" />
                                    <span>{tr('终端', 'Exec')}</span>
                                  </Button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>

          {/* Bottom 2-Column Details: Evaluations + Revisions */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title={tr(`最近调度评估 (${jobEvals.length})`, `Recent Evaluations (${jobEvals.length})`)} bodyClassName="p-4">
              {jobEvals.length === 0 ? (
                <div className="py-4 text-center text-xs text-slate-400">{tr('暂无调度评估记录', 'No evaluations yet')}</div>
              ) : (
                <div className="space-y-2 text-xs">
                  {jobEvals.slice(0, 6).map((ev) => (
                    <div
                      key={ev.ID}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200/80 bg-slate-50/50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/30"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold text-slate-800 dark:text-slate-100">{ev.ID.slice(0, 8)}</span>
                        <span className="text-slate-500">{ev.TriggeredBy || '-'}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <StatusBadge value={ev.Status} />
                        {ev.BlockedEval && <Badge tone="amber">blocked</Badge>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title={tr(`修订历史与回滚 (${revisions.length})`, `Revision History & Revert (${revisions.length})`)} bodyClassName="p-4">
              {revisions.length === 0 ? (
                <div className="py-4 text-center text-xs text-slate-400">{tr('暂无控制面修订记录', 'No revision history')}</div>
              ) : (
                <div className="space-y-2 text-xs">
                  {revisions.slice(0, 6).map((rv) => (
                    <div
                      key={rv.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200/80 bg-slate-50/50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/30"
                    >
                      <div className="min-w-0">
                        <span className="font-mono font-semibold text-slate-800 dark:text-slate-100">v{rv.revision_no}</span>
                        <span className="ml-2 text-slate-500">
                          {rv.source} · {rv.submit_status} · {fmtTime(rv.created_at, locale)}
                        </span>
                      </div>
                      {isAdmin && rv.remote_job_version != null && (
                        <Button
                          size="sm"
                          onClick={async () => {
                            if (
                              !(await askConfirm(tr(`确认将 Job「${selectedJob.id}」回滚至修订 v${rv.revision_no}吗？`, `Revert Job "${selectedJob.id}" to revision v${rv.revision_no}?`), {
                                title: tr('回滚 Job 版本', 'Revert Job Version'),
                                confirmText: tr('确认回滚', 'Revert'),
                              }))
                            ) {
                              return;
                            }
                            void apiPost(
                              `/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(selectedJob.namespace)}/jobs/${encodeURIComponent(selectedJob.id)}/revert`,
                              { version: rv.remote_job_version },
                            )
                              .then(() => {
                                toast.success(tr(`已回滚至 v${rv.revision_no}`, `Reverted to v${rv.revision_no}`));
                                return loadJobRuntime(true);
                              })
                              .catch((ex) => setErr(ex.message));
                          }}
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>{tr('回滚', 'Revert')}</span>
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* Allocation Inspection Drawer */}
      {selectedAlloc && (
        <Drawer
          title={
            <>
              <span className="font-mono">Allocation {selectedAlloc.ID.slice(0, 8)}</span>
              <StatusBadge value={selectedAlloc.ClientStatus} />
            </>
          }
          subtitle={`Job ${selectedJob.id} · ${selectedAlloc.TaskGroup || ''} · ${tr('节点', 'Node')} ${selectedAlloc.NodeName || '-'} · ID: ${selectedAlloc.ID}`}
          width="2xl"
          onClose={closeAllocDrawer}
          headerExtra={
            <Button size="sm" onClick={() => void inspectAlloc(selectedAlloc, allocTab)}>
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{tr('刷新', 'Refresh')}</span>
            </Button>
          }
          footer={
            <div className="flex flex-wrap items-center justify-between gap-2 w-full">
              <div className="flex flex-wrap items-center gap-1.5">
                {isAdmin && logTask && (
                  <>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={selectedAlloc.TaskStates?.[logTask]?.State !== 'running'}
                      onClick={() => setTerminal({ allocId: selectedAlloc.ID, task: logTask })}
                    >
                      <Terminal className="h-3.5 w-3.5" />
                      <span>{tr('打开交互式终端', 'Open Shell (Exec)')}</span>
                    </Button>
                    <Button
                      size="sm"
                      disabled={selectedAlloc.TaskStates?.[logTask]?.State !== 'running'}
                      onClick={() =>
                        void askConfirm(tr(`确定要重启 Allocation ${selectedAlloc.ID.slice(0, 8)} 中的任务 ${logTask} 吗？`, `Restart task ${logTask} in Allocation ${selectedAlloc.ID.slice(0, 8)}?`), {
                          title: tr('重启 Task', 'Restart Task'),
                          confirmText: tr('确认重启', 'Restart'),
                        })
                          .then((ok) =>
                            ok
                              ? apiPost(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/restart`, {
                                  task: logTask,
                                }).then(() => {
                                  toast.success(tr('已请求重启 Task', 'Task restart requested'));
                                  return loadJobRuntime(true);
                                })
                              : undefined,
                          )
                          .catch((ex) => setErr(ex.message))
                      }
                    >
                      {tr('重启 Task', 'Restart Task')}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger-outline"
                      disabled={['complete', 'failed', 'lost'].includes(selectedAlloc.ClientStatus)}
                      onClick={() =>
                        void askConfirm(tr(`确定要停止 Allocation ${selectedAlloc.ID.slice(0, 8)} 吗？调度器可能会重新拉起新副本。`, `Stop Allocation ${selectedAlloc.ID.slice(0, 8)}? The scheduler may place a replacement.`), {
                          title: tr('停止 Allocation', 'Stop Allocation'),
                          confirmText: tr('确认停止', 'Stop'),
                          danger: true,
                        })
                          .then((ok) =>
                            ok
                              ? apiPost(`/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/stop`, {}).then(() => {
                                  toast.success(tr('已请求停止 Alloc', 'Allocation stop requested'));
                                  return loadJobRuntime(true);
                                })
                              : undefined,
                          )
                          .catch((ex) => setErr(ex.message))
                      }
                    >
                      {tr('停止 Alloc', 'Stop Alloc')}
                    </Button>
                  </>
                )}
              </div>
              <Button size="sm" variant="secondary" onClick={closeAllocDrawer}>
                {tr('关闭', 'Close')}
              </Button>
            </div>
          }
        >
          <div className="space-y-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTabs
                variant="underline"
                tabs={[
                  { id: 'logs', label: tr('实时日志', 'Live Logs') },
                  { id: 'events', label: tr('事件与资源', 'Events & Resources') },
                  { id: 'files', label: tr('文件浏览', 'Files') },
                ]}
                active={allocTab}
                onChange={(t) => setAllocTab(t as 'logs' | 'events' | 'files')}
              />
              {Object.keys(selectedAlloc.TaskStates || {}).length > 0 && (
                <div className="flex items-center gap-1.5 text-slate-500">
                  <span className="shrink-0">Task:</span>
                  <div className="w-36">
                    <Select
                      aria-label={tr('选择 Task', 'Select Task')}
                      size="sm"
                      value={logTask}
                      onChange={(e) => setLogTask(e.target.value)}
                    >
                      {Object.keys(selectedAlloc.TaskStates || {}).map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              )}
            </div>

            {allocTab === 'logs' && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-slate-800 dark:text-slate-100">
                    {tr(`实时日志输出（${logTask || '-'}）`, `Live Log Stream (${logTask || '-'})`)}
                  </span>
                  <div className="flex items-center gap-2">
                    <div className="w-48">
                      <Select
                        aria-label={tr('日志输出流', 'Log Stream')}
                        size="sm"
                        value={logType}
                        onChange={(e) => setLogType(e.target.value as 'stdout' | 'stderr')}
                      >
                        <option value="stdout">{tr('标准输出 · stdout', 'Stdout')}</option>
                        <option value="stderr">{tr('错误与服务日志 · stderr', 'Stderr')}</option>
                      </Select>
                    </div>
                    <Button
                      size="sm"
                      disabled={!allocLogs}
                      onClick={() =>
                        void copyText(allocLogs)
                          .then(() => toast.success(tr('已复制当前日志', 'Logs copied')))
                          .catch((ex) => toast.error(ex.message))
                      }
                    >
                      <Copy className="h-3.5 w-3.5" />
                      <span>{tr('复制', 'Copy')}</span>
                    </Button>
                  </div>
                </div>
                <pre className="h-[440px] overflow-auto rounded-xl bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100 whitespace-pre-wrap">
                  {allocLogs || tr('等待日志… 若没有输出，请尝试切换 stdout / stderr。', 'Waiting for logs... Try switching stdout / stderr if empty.')}
                </pre>
              </div>
            )}

            {allocTab === 'events' && (
              <div className="space-y-4">
                <ResourceUtilizationPanel
                  cpuSamples={cpuHist}
                  memSamples={memHist}
                  capacity={allocCapacity}
                  nowTs={statsNowTs}
                  hasStats={Boolean(allocStats)}
                />
                <div className="space-y-2">
                  <div className="font-semibold text-slate-800 dark:text-slate-100">{tr('Task 生命周期事件', 'Task Lifecycle Events')}</div>
                  {Object.entries<any>(selectedAlloc.TaskStates || {}).map(([task, state]) => (
                    <div key={task} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                      <div className="flex items-center gap-2 font-mono font-semibold text-slate-900 dark:text-slate-100">
                        <span>{task}</span>
                        <StatusBadge value={state.State} />
                      </div>
                      {(state.Events || [])
                        .slice(-10)
                        .reverse()
                        .map((event: any, i: number) => (
                          <div key={i} className="mt-1.5 whitespace-pre-wrap break-words text-slate-600 dark:text-slate-300">
                            <b>{event.Type}</b>: {event.DisplayMessage || event.Message || '-'}
                          </div>
                        ))}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {allocTab === 'files' && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1 min-w-0">
                    <span className="font-semibold text-slate-800 dark:text-slate-100">{tr('文件浏览器', 'File Browser')}</span>
                    <div className="flex flex-wrap items-center gap-0.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                      <span>(</span>
                      {fsPath ? (
                        <button
                          type="button"
                          disabled={fsLoading}
                          onClick={() => void browseAllocDir('')}
                          className="rounded px-1 text-indigo-600 hover:bg-indigo-50 hover:underline disabled:opacity-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                        >
                          /
                        </button>
                      ) : (
                        <span className="px-0.5 text-slate-700 dark:text-slate-200">/</span>
                      )}
                      {fsPath
                        .split('/')
                        .filter(Boolean)
                        .map((seg, idx, arr) => {
                          const target = arr.slice(0, idx + 1).join('/');
                          const isLast = idx === arr.length - 1;
                          return (
                            <span key={target} className="inline-flex items-center gap-0.5">
                              {idx > 0 && <ChevronRight className="h-3 w-3 text-slate-400" />}
                              {isLast ? (
                                <span className="px-0.5 font-semibold text-slate-800 dark:text-slate-100">{seg}</span>
                              ) : (
                                <button
                                  type="button"
                                  disabled={fsLoading}
                                  onClick={() => void browseAllocDir(target)}
                                  className="rounded px-1 text-indigo-600 hover:bg-indigo-50 hover:underline disabled:opacity-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                                >
                                  {seg}
                                </button>
                              )}
                            </span>
                          );
                        })}
                      <span>)</span>
                    </div>
                  </div>
                  {fsPath && (
                    <Button
                      size="sm"
                      disabled={fsLoading}
                      onClick={() => {
                        const parent = fsPath.split('/').slice(0, -1).join('/');
                        void browseAllocDir(parent);
                      }}
                    >
                      {tr('上级目录', 'Up')}
                    </Button>
                  )}
                </div>
                <div className="h-[440px] overflow-auto rounded-xl border border-slate-200 p-2.5 dark:border-slate-800">
                  {fsLoading && (fsFiles || []).length === 0 ? (
                    <div className="py-10 text-center text-slate-400">{tr('正在读取目录…', 'Reading directory...')}</div>
                  ) : (fsFiles || []).length === 0 ? (
                    <div className="py-10 text-center text-slate-400">{tr('当前目录为空', 'Directory is empty')}</div>
                  ) : (
                    <div className={fsLoading ? 'opacity-60 transition-opacity' : undefined}>
                      {(fsFiles || []).map((f: any) => {
                        const entryPath = fsPath ? `${fsPath}/${f.name}` : f.name;
                        const canReadFile = !f.is_dir && isAdmin && f.readable !== false;
                        const entryContent = (
                          <>
                            <span
                              className={`flex min-w-0 items-center gap-2 font-mono ${
                                !f.is_dir && !canReadFile ? 'text-slate-500 dark:text-slate-400' : ''
                              }`}
                            >
                              {f.is_dir ? (
                                <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                              ) : (
                                <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                              )}
                              <span className="truncate">{f.is_dir ? `${f.name}/` : f.name}</span>
                            </span>
                            <span className="shrink-0 text-slate-500">{fmtBytes(f.size)}</span>
                          </>
                        );
                        return (
                          <div
                            key={f.name}
                            className="flex items-center justify-between gap-2 rounded-lg pr-2 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60"
                          >
                            {f.is_dir || canReadFile ? (
                              <button
                                type="button"
                                disabled={f.is_dir && fsLoading}
                                onClick={() =>
                                  void (f.is_dir ? browseAllocDir(entryPath) : previewAllocFile(entryPath))
                                }
                                className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:text-indigo-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-wait dark:hover:text-indigo-300"
                              >
                                {entryContent}
                              </button>
                            ) : (
                              <div className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-1.5">
                                {entryContent}
                              </div>
                            )}
                            <div className="flex shrink-0 items-center gap-1.5">
                              {f.is_dir ? (
                                <Button
                                  size="sm"
                                  disabled={fsLoading}
                                  onClick={() => void browseAllocDir(entryPath)}
                                >
                                  {tr('进入', 'Open')}
                                </Button>
                              ) : (
                                canReadFile && (
                                  <>
                                    <Button size="sm" onClick={() => void previewAllocFile(entryPath)}>
                                      {tr('预览', 'Preview')}
                                    </Button>
                                    <Button
                                      size="sm"
                                      onClick={() => {
                                        void apiDownload(
                                          `/api/v1/nomad/${clusterId}/allocs/${selectedAlloc.ID}/fs/content/download?path=${encodeURIComponent(entryPath)}`,
                                          undefined,
                                          f.name,
                                        ).catch((ex) => setErr(ex.message));
                                      }}
                                    >
                                      {tr('下载', 'Download')}
                                    </Button>
                                  </>
                                )
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </Drawer>
      )}

      <Modal open={Boolean(filePreview)} title={tr(`文件预览：${filePreview?.path}`, `File Preview: ${filePreview?.path}`)} onClose={() => setFilePreview(null)} wide>
        <pre className="max-h-96 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-xs text-slate-100 whitespace-pre-wrap">
          {filePreview?.text}
        </pre>
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
