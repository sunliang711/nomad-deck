import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Boxes, Download, Play, RefreshCw, RotateCcw, Square, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { apiDelete, apiDownload, apiGet, apiPost, fmtTime, openSSE } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  LoadingState,
  Input,
  Modal,
  PageHeader,
  SectionTabs,
  Select,
  StatusBadge,
  TermLabel,
  statusTone,
} from '../components/UI';
import { CodeEditor } from '../components/CodeEditor';
import { VisualJobBuilder, type VisualJobBuilderHandle } from '../components/VisualJobBuilder';

const STARTER_SAMPLES: Array<{ id: string; label: string; desc: string; hcl: string }> = [
  {
    id: 'raw_exec',
    label: 'Shell 入门 (raw_exec)',
    desc: '无需 Docker，直接在节点运行轻量脚本',
    hcl: `job "hello-shell" {
  datacenters = ["dc1"]
  type        = "service"

  group "app" {
    count = 1
    task "echo" {
      driver = "raw_exec"
      config {
        command = "/bin/sh"
        args    = ["-c", "while true; do echo 'NomadDeck hello at '$(date); sleep 15; done"]
      }
      resources {
        cpu    = 50
        memory = 64
      }
    }
  }
}
`,
  },
  {
    id: 'docker',
    label: 'Nginx 容器 (docker)',
    desc: '标准 Docker 容器服务示例',
    hcl: `job "hello" {
  datacenters = ["dc1"]
  type        = "service"

  group "app" {
    count = 1
    task "server" {
      driver = "docker"
      config {
        image = "nginx:alpine"
      }
      resources {
        cpu    = 100
        memory = 128
      }
    }
  }
}
`,
  },
  {
    id: 'batch',
    label: '一次性批处理 (batch)',
    desc: '执行完即退出的短任务示例',
    hcl: `job "hello-batch" {
  datacenters = ["dc1"]
  type        = "batch"

  group "job" {
    count = 1
    task "run" {
      driver = "raw_exec"
      config {
        command = "/bin/sh"
        args    = ["-c", "echo 'Batch task finished on '$(hostname); uname -a"]
      }
      resources {
        cpu    = 50
        memory = 32
      }
    }
  }
}
`,
  },
];

const sampleHCL = STARTER_SAMPLES[0].hcl;

export function JobCenterPage() {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [clusters, setClusters] = useState<any[]>([]);
  const [clusterId, setClusterId] = useState('');
  const [namespace, setNamespace] = useState('default');
  const [jobs, setJobs] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [editMode, setEditMode] = useState<'hcl' | 'visual' | 'json'>('hcl');
  const [hcl, setHcl] = useState(sampleHCL);
  const [jobVariables, setJobVariables] = useState<Record<string, string>>({});
  const visualRef = useRef<VisualJobBuilderHandle>(null);
  const [visualReady, setVisualReady] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const modeRequestRef = useRef(0);
  const formatCacheRef = useRef<{ hcl: string; variables: Record<string, string>; json: string } | null>(null);
  const [composeText, setComposeText] = useState('');
  const [showCompose, setShowCompose] = useState(false);
  const [plan, setPlan] = useState<any>(null);
  const planRequestRef = useRef(0);
  const [revisions, setRevisions] = useState<any[]>([]);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [tplName, setTplName] = useState('');
  const [err, setErr] = useState('');
  const [loadingClusters, setLoadingClusters] = useState(true);
  const editRequestRef = useRef(0);
  const selectedCluster = clusters.find((c) => c.id === clusterId);
  const needsDeployment = selectedCluster?.init_state === 'uninitialized';

  const loadClusters = useCallback(async () => {
    setErr('');
    try {
      const [cRes, tRes] = await Promise.all([
        apiGet('/api/v1/clusters?type=nomad'),
        isAdmin ? apiGet('/api/v1/job-templates') : Promise.resolve({ templates: [] }),
      ]);
      const list = cRes.clusters || [];
      setClusters(list);
      setTemplates(tRes.templates || []);
      if (list.length > 0) setClusterId((prev) => prev || list[0].id);
    } catch (ex: any) {
      setErr(ex?.message || '加载集群或模板列表失败');
    } finally {
      setLoadingClusters(false);
    }
  }, [isAdmin]);

  const loadJobs = useCallback(async () => {
    if (!clusterId || needsDeployment) { setJobs([]); return; }
    setErr('');
    try {
      const res = await apiGet(`/api/v1/nomad/${clusterId}/jobs?namespace=${encodeURIComponent(namespace)}`);
      setJobs(res.jobs || []);
    } catch (ex: any) {
      setErr(ex?.message || '加载 Job 列表失败');
    }
  }, [clusterId, namespace, needsDeployment]);

  useEffect(() => {
    void loadClusters();
  }, [loadClusters]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    if (!clusterId || needsDeployment) return;
    return openSSE(`/api/v1/nomad/${clusterId}/watch?topics=jobs`, {
      onEvent: (ev) => { if (ev === 'change') void loadJobs(); },
    });
  }, [clusterId, loadJobs, needsDeployment]);

  // clearPlan also invalidates an in-flight preview when its draft or target changes.
  const clearPlan = () => { planRequestRef.current++; setPlan(null); };

  // changeMode flushes the current tree and refuses conversions that would drop JSON fields.
  const changeMode = async (next: 'hcl' | 'visual' | 'json') => {
    if (next === editMode) return;
    if (!isAdmin) { setEditMode(next); return; }
    const request = ++modeRequestRef.current;
    setModeBusy(true);
    clearPlan();
    setErr('');
    try {
      let current = hcl;
      if (editMode === 'visual' && visualRef.current) current = (await visualRef.current.flush()).hcl;
      if (next === 'json') {
        const parsed = await apiPost(`/api/v1/nomad/${clusterId}/job-ops/validate`, { input_type: 'hcl', hcl: current, variables: jobVariables, namespace });
        if (request !== modeRequestRef.current) return;
        formatCacheRef.current = { hcl: current, variables: jobVariables, json: JSON.stringify(parsed.job) };
        setHcl(JSON.stringify(parsed.job, null, 2));
      } else if (editMode === 'json') {
        const job = JSON.parse(hcl);
        const cached = formatCacheRef.current;
        if (cached && cached.json === JSON.stringify(job)) {
          setHcl(cached.hcl);
          setJobVariables(cached.variables);
        } else {
          const parsed = await apiPost(`/api/v1/nomad/${clusterId}/job-ops/json-to-visual`, { job_json: job });
          if (request !== modeRequestRef.current) return;
          if (!parsed.lossless || !parsed.hcl) throw new Error('该 JSON 含有无法完整转换的字段，请继续使用 JSON 编辑，避免丢失配置');
          setHcl(parsed.hcl);
          setJobVariables({});
        }
      } else {
        if (request !== modeRequestRef.current) return;
        setHcl(current);
      }
      if (request !== modeRequestRef.current) return;
      if (next === 'visual') setVisualReady(false);
      setEditMode(next);
    } catch (ex: any) {
      if (request === modeRequestRef.current) setErr(ex?.message || '无法切换编辑模式');
    } finally {
      if (request === modeRequestRef.current) setModeBusy(false);
    }
  };

  // Preserve the authoritative JSON definition and variables when no HCL source exists.
  const jobInput = async () => {
    let current = hcl;
    if (editMode === 'visual' && visualRef.current) {
      const result = await visualRef.current.flush();
      if (!result.valid) throw new Error(result.diagnostics.map((issue) => issue.message).join('；') || '请先完成积木配置');
      current = result.hcl;
    }
    return editMode === 'json'
      ? { input_type: 'json', job_json: JSON.parse(current), namespace, edit_mode: 'json' }
      : { input_type: 'hcl', hcl: current, variables: jobVariables, namespace, edit_mode: 'hcl' };
  };

  const validateJob = async () => {
    setErr('');
    try {
      await apiPost(`/api/v1/nomad/${clusterId}/job-ops/validate`, await jobInput());
      toast.success('Job 校验通过');
    } catch (ex: any) {
      setErr(ex?.message || '校验失败');
    }
  };

  const runPlan = async () => {
    if (!clusterId) return;
    setErr('');
    try {
      const input = await jobInput();
      const request = ++planRequestRef.current;
      const res = await apiPost(`/api/v1/nomad/${clusterId}/job-ops/plan`, input);
      if (request === planRequestRef.current) setPlan(res.plan);
    } catch (ex: any) {
      setErr(ex?.message || 'Plan 失败');
    }
  };

  const runApply = async () => {
    if (!clusterId || !plan?.plan_id) return;
    setErr('');
    try {
      await apiPost(`/api/v1/nomad/${clusterId}/job-ops/apply`, { plan_id: plan.plan_id });
      clearPlan();
      toast.success('Job 已提交运行', {
        label: '查看运行态',
        onClick: () => navigate(`/nomad?id=${clusterId}`),
      });
      await loadJobs();
    } catch (ex: any) {
      setErr(ex?.message || 'Apply 失败');
    }
  };

  const loadJobForEdit = async (j: any) => {
    const request = ++editRequestRef.current;
    modeRequestRef.current++;
    setModeBusy(false);
    formatCacheRef.current = null;
    const ns = j.namespace || namespace;
    setSelectedJobId(j.id);
    clearPlan();
    setHcl('');
    setJobVariables({});
    setErr('');
    try {
      const [src, rev] = await Promise.all([
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(ns)}/jobs/${encodeURIComponent(j.id)}/edit-source`),
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(ns)}/jobs/${encodeURIComponent(j.id)}/revisions`),
      ]);
      if (request !== editRequestRef.current) return;
      const source = src.source;
      if (source?.hcl) {
        setHcl(source.hcl);
        setEditMode('hcl');
      } else if (source?.job) {
        setHcl(JSON.stringify(source.job, null, 2));
        setEditMode('json');
      } else {
        setHcl('');
        setErr('该 Job 没有可用的编辑定义');
      }
      setJobVariables(source?.variables || {});
      setNamespace(ns);
      if (source?.drifted && source?.reason) toast.info(source.reason);
      setRevisions(rev.revisions || []);
    } catch (ex: any) {
      if (request === editRequestRef.current) setErr(ex?.message || '读取 Job 编辑源码失败');
    }
  };

  if (loadingClusters) return <LoadingState label="正在加载 Job 工作区…" />;

  if (!clusters.length) return (
    <div className="space-y-5">
      <PageHeader title="Nomad Job 中心" subtitle="编写任务、预览调度计划并运行工作负载" />
      <ErrorAlert message={err} onClose={() => setErr('')} />
      <Card><EmptyState icon={<Boxes className="h-6 w-6" />} title="先搭建一个 Nomad 集群" description="Job 需要在 Nomad Client 上运行。集群部署完成后，即可在这里编写第一个任务。" action={<Link to="/nomad" className="primary-button">前往 Nomad 集群</Link>} /></Card>
    </div>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Nomad Job 中心"
        subtitle="编写任务 → 校验配置 → 预览计划 → 确认运行，支持 HCL、可视化与 JSON"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <span className="shrink-0">集群</span>
              <div className="w-40">
                <Select aria-label="目标 Nomad 集群" value={clusterId} disabled={modeBusy || (editMode === 'visual' && !visualReady)} onChange={(e) => { setClusterId(e.target.value); clearPlan(); }}>
                  {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </div>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <span className="shrink-0">命名空间</span>
              <div className="w-28">
                <Input aria-label="任务命名空间" value={namespace} onChange={(e) => { setNamespace(e.target.value); clearPlan(); }} placeholder="default" />
              </div>
            </label>
            <Button onClick={() => { void loadClusters(); void loadJobs(); }}>
              <RefreshCw className="h-4 w-4" />
              <span>刷新</span>
            </Button>
            {isAdmin && clusterId && (
              <Button
                onClick={() =>
                  void apiDownload(`/api/v1/nomad/${clusterId}/job-ops/export`, { namespace }, 'nomad-jobs.zip')
                    .catch((ex) => toast.error(ex.message))
                }
              >
                <Download className="h-4 w-4" />
                <span>批量导出 HCL</span>
              </Button>
            )}
          </div>
        }
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {needsDeployment && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200">
          <p>「{selectedCluster.name}」尚未部署。可以先编写配置，部署完成后再校验和运行。</p>
          <Link to={`/nomad?id=${clusterId}`} className="primary-button">前往部署集群</Link>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <Card title="任务与模板" className="min-w-0">
          <div className="space-y-4 text-xs">
            <div className="max-h-80 overflow-y-auto space-y-2">
              {jobs.length === 0 ? (
                <EmptyState title="准备运行第一个 Job" description="编排工作台已准备示例配置，先校验，再预览计划即可提交。" />
              ) : (
                jobs.map((j) => {
                  const jobNs = j.namespace || namespace;
                  return (
                    <div key={`${jobNs}:${j.id}`} className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                      <div className="space-y-1.5">
                        <div className="font-mono font-semibold break-all">{j.id}</div>
                        <StatusBadge value={j.stop ? 'stopped' : j.status} />
                      </div>
                      {isAdmin && (
                        <div className="flex gap-1">
                          <Button size="sm" onClick={() => void loadJobForEdit(j)}>编辑</Button>
                          <Button
                            size="sm"
                            aria-label="启动 Job"
                            disabled={!j.stop}
                            onClick={() =>
                              void apiPost(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(jobNs)}/jobs/${encodeURIComponent(j.id)}/start`, {})
                                .then(() => {
                                  toast.success(`已启动 Job ${j.id}`);
                                  return loadJobs();
                                })
                                .catch((ex) => setErr(ex.message))
                            }
                          >
                            <Play className="h-3 w-3" />
                          </Button>
                          <Button
                            size="sm"
                            aria-label="停止 Job"
                            disabled={j.stop}
                            onClick={async () => {
                              if (!(await askConfirm(`确认停止运行中的 Job「${j.id}」（Namespace: ${jobNs}）吗？`, { title: '停止 Job', confirmText: '确认停止', danger: true }))) return;
                              void apiPost(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(jobNs)}/jobs/${encodeURIComponent(j.id)}/stop`, {})
                                .then(() => {
                                  toast.success(`已停止 Job ${j.id}`);
                                  return loadJobs();
                                })
                                .catch((ex) => setErr(ex.message));
                            }}
                          >
                            <Square className="h-3 w-3" />
                          </Button>
                          <Button
                            size="sm"
                            aria-label="清理 Job"
                            variant="danger"
                            onClick={async () => {
                              if (!(await askConfirm(`确认清理并彻底删除 Job「${j.id}」（Namespace: ${jobNs}）吗？`, { title: '清理删除 Job', confirmText: '确认 Purge', danger: true }))) return;
                              void apiPost(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(jobNs)}/jobs/${encodeURIComponent(j.id)}/purge`, { confirm_job_id: j.id })
                                .then(() => {
                                  toast.success(`已清理 Job ${j.id}`);
                                  return loadJobs();
                                })
                                .catch((ex) => setErr(ex.message));
                            }}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
              <div className="mb-1.5 font-semibold">Job 模板库 ({templates.length})</div>
              <div className="max-h-56 overflow-y-auto space-y-2">
                {templates.map((t) => (
                  <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-2.5 dark:border-slate-800">
                    <span className="break-all">{t.name}</span>
                    <div className="flex shrink-0 gap-1">
                      <Button size="sm" onClick={() => { setHcl(t.hcl || ''); setEditMode('hcl'); setJobVariables({}); clearPlan(); }}>载入</Button>
                      {isAdmin && (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={async () => {
                            if (!(await askConfirm(`确认删除 Job 模板「${t.name}」吗？`, { title: '删除模板', confirmText: '确认删除', danger: true }))) return;
                            void apiDelete(`/api/v1/job-templates/${t.id}`)
                              .then(() => {
                                toast.success(`已删除模板 ${t.name}`);
                                return loadClusters();
                              })
                              .catch((ex) => setErr(ex.message));
                          }}
                        >
                          删
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <Card
          className="min-w-0"
          title={<TermLabel term="Job 编排工作台" tip="支持编写 Nomad HCL（HashiCorp Configuration Language）、表单可视化编排或 JSON 定义，提交前可做语法校验和变更比对。" />}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {selectedCluster && !needsDeployment && (
                <Link
                  to={`/nomad?id=${clusterId}`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400 mr-1"
                >
                  <span>运行态工作台</span>
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              )}
              {isAdmin && (
                <Button size="sm" onClick={() => setShowCompose(true)}>Compose 导入</Button>
              )}
            </div>
          }
        >
          <div className="space-y-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SectionTabs
                tabs={[
                  { id: 'hcl', label: '原生 HCL 编辑器', tip: 'Nomad 原生 HashiCorp Configuration Language 声明式任务定义。' },
                  ...(isAdmin ? [{ id: 'visual', label: '可视化编排' }] : []),
                  { id: 'json', label: 'JSON 定义' },
                ]}
                active={editMode}
                onChange={(m) => { void changeMode(m as 'hcl' | 'visual' | 'json'); }}
              />
              {isAdmin && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-slate-500 dark:text-slate-400 mr-1">入门示例：</span>
                  {STARTER_SAMPLES.map((s) => (
                    <Button
                      key={s.id}
                      size="sm"
                      title={s.desc}
                      onClick={() => {
                        setHcl(s.hcl);
                        setEditMode('hcl');
                        setJobVariables({});
                        clearPlan();
                      }}
                    >
                      {s.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>

            {editMode === 'visual' ? (
              <div className="space-y-3">
                <VisualJobBuilder
                  ref={visualRef}
                  clusterId={clusterId}
                  source={hcl}
                  readOnly={!isAdmin}
                  onSourceChange={(value) => { setHcl(value); clearPlan(); }}
                  onValidityChange={(valid) => { setVisualReady(valid); if (!valid) clearPlan(); }}
                />
                <details className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                  <summary className="cursor-pointer px-4 py-2.5 font-semibold text-slate-700 dark:text-slate-200">
                    实时 HCL 预览 <span className="ml-1.5 font-normal text-slate-400">· 展开查看同步生成的 Nomad 配置源码</span>
                  </summary>
                  <div className="border-t border-slate-100 p-3 dark:border-slate-800">
                    <CodeEditor value={hcl} onChange={(value) => { setHcl(value); clearPlan(); }} readOnly height="280px" />
                  </div>
                </details>
              </div>
            ) : (
              <CodeEditor value={hcl} onChange={(value) => { setHcl(value); clearPlan(); }} readOnly={!isAdmin} height="380px" />
            )}

            {isAdmin && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950/40">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    placeholder="输入名称保存为模板..."
                    value={tplName}
                    onChange={(e) => setTplName(e.target.value)}
                    className="w-48 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950"
                  />
                  <Button
                    size="sm"
                    disabled={!tplName.trim() || modeBusy || editMode === 'json' || (editMode === 'visual' && !visualReady)}
                    onClick={() =>
                      tplName.trim() &&
                      void apiPost('/api/v1/job-templates', { name: tplName.trim(), edit_mode: 'hcl', hcl })
                        .then(() => { setTplName(''); toast.success('模板已保存'); return loadClusters(); })
                        .catch((ex) => setErr(ex.message))
                    }
                  >
                    存为模板
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    disabled={needsDeployment || modeBusy || (editMode === 'visual' && !visualReady)}
                    onClick={() => void validateJob()}
                  >
                    1. 校验配置
                  </Button>
                  <Button
                    size="sm"
                    variant={plan ? 'secondary' : 'primary'}
                    disabled={needsDeployment || modeBusy || (editMode === 'visual' && !visualReady)}
                    onClick={() => void runPlan()}
                  >
                    2. 预览计划
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!plan?.plan_id || needsDeployment || modeBusy}
                    title={!plan?.plan_id ? '请先点击「2. 预览计划」生成执行计划' : '确认将任务提交至 Nomad 集群运行'}
                    onClick={() => void runApply()}
                  >
                    <Play className="h-3.5 w-3.5" />
                    <span>3. 确认运行</span>
                  </Button>
                </div>
              </div>
            )}

            {plan && (
              <div className="space-y-2 rounded-xl border border-indigo-300 bg-indigo-50/40 p-3.5 dark:border-indigo-500/40 dark:bg-indigo-950/30">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="font-semibold text-indigo-900 dark:text-indigo-200 break-all">
                    调度变更预览 · 请核对后点击上方或右侧「3. 确认运行」{' '}
                    <span className="font-mono font-normal text-xs opacity-75">{plan.plan_id}</span>
                  </span>
                  {isAdmin && (
                    <Button size="sm" variant="primary" onClick={() => void runApply()}>
                      <Play className="h-3.5 w-3.5" />
                      <span>3. 确认运行</span>
                    </Button>
                  )}
                </div>
                <pre className="max-h-56 overflow-auto rounded-lg bg-slate-950 p-2.5 font-mono text-[11px] text-slate-100">
                  {JSON.stringify(plan.diff || plan, null, 2)}
                </pre>
              </div>
            )}

            {revisions.length > 0 && (
              <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
                <div className="mb-1.5 font-semibold">修订历史：{selectedJobId}</div>
                <div className="space-y-1">
                  {revisions.slice(0, 8).map((rv) => (
                    <div key={rv.id} className="flex items-center justify-between rounded border border-slate-200 p-1.5 dark:border-slate-800">
                      <span>v{rv.revision_no} · {rv.source} · {rv.submit_status} · {fmtTime(rv.created_at)}</span>
                      {isAdmin && rv.remote_job_version != null && (
                        <Button
                          size="sm"
                          onClick={() =>
                            void apiPost(
                              `/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(namespace)}/jobs/${encodeURIComponent(selectedJobId)}/revert`,
                              { version: rv.remote_job_version },
                            ).then(() => toast.success('已回滚 Job 版本')).catch((ex) => setErr(ex.message))
                          }
                        >
                          <RotateCcw className="h-3 w-3" /> 回滚
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>

      <Modal open={showCompose} title="导入 Docker Compose 转 HCL" onClose={() => setShowCompose(false)} wide>
        <div className="space-y-3 text-xs">
          <CodeEditor value={composeText} onChange={setComposeText} height="260px" />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setShowCompose(false)}>取消</Button>
            <Button
              variant="primary"
              onClick={() =>
                void apiPost(`/api/v1/nomad/${clusterId}/job-ops/compose-convert`, { compose: composeText })
                  .then((r) => {
                    if (r.hcl) setHcl(r.hcl);
                    setEditMode('hcl');
                    setJobVariables({});
                    clearPlan();
                    setShowCompose(false);
                    toast.success('已转换为 Nomad HCL');
                  })
                  .catch((ex) => setErr(ex.message))
              }
            >
              转换并填入编辑器
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
