import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Play, RefreshCw, RotateCcw, Square, Trash2 } from 'lucide-react';
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

const sampleHCL = `job "hello" {
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
`;

export function JobCenterPage() {
  const { isAdmin } = useAuth();
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
  const editRequestRef = useRef(0);

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
    }
  }, [isAdmin]);

  const loadJobs = useCallback(async () => {
    if (!clusterId) return;
    setErr('');
    try {
      const res = await apiGet(`/api/v1/nomad/${clusterId}/jobs?namespace=${encodeURIComponent(namespace)}`);
      setJobs(res.jobs || []);
    } catch (ex: any) {
      setErr(ex?.message || '加载 Job 列表失败');
    }
  }, [clusterId, namespace]);

  useEffect(() => {
    void loadClusters();
  }, [loadClusters]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    if (!clusterId) return;
    return openSSE(`/api/v1/nomad/${clusterId}/watch?topics=jobs`, {
      onEvent: (ev) => { if (ev === 'change') void loadJobs(); },
    });
  }, [clusterId, loadJobs]);

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
      toast.success('Job Apply 提交成功');
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

  return (
    <div className="space-y-5">
      <PageHeader
        title="Nomad Job 中心"
        subtitle="双模式 HCL / 可视化积木 / JSON Job 编排、Plan Dry-Run 对比、模板库与修订回滚"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-40">
              <Select value={clusterId} disabled={modeBusy || (editMode === 'visual' && !visualReady)} onChange={(e) => { setClusterId(e.target.value); clearPlan(); }}>
                {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>
            <div className="w-32">
              <Input value={namespace} onChange={(e) => { setNamespace(e.target.value); clearPlan(); }} placeholder="Namespace" />
            </div>
            <Button onClick={() => void loadJobs()}>
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

      <div className={editMode === 'visual' ? 'grid grid-cols-1 gap-5 2xl:grid-cols-[220px_minmax(0,1fr)]' : 'grid grid-cols-1 gap-5 xl:grid-cols-3'}>
        <Card title="集群 Jobs & 模板">
          <div className="space-y-4 text-xs">
            <div className="space-y-1.5">
              {jobs.length === 0 ? (
                <EmptyState text="暂无 Job" />
              ) : (
                jobs.map((j) => {
                  const jobNs = j.namespace || namespace;
                  return (
                    <div key={`${jobNs}:${j.id}`} className="flex items-center justify-between gap-2 rounded border border-slate-200 p-2 dark:border-slate-800">
                      <div>
                        <div className="font-mono font-semibold">{j.id}</div>
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
              <div className="space-y-1">
                {templates.map((t) => (
                  <div key={t.id} className="flex items-center justify-between rounded border border-slate-200 p-1.5 dark:border-slate-800">
                    <span>{t.name}</span>
                    <div className="flex gap-1">
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
          className={editMode === 'visual' ? '' : 'xl:col-span-2'}
          title={<TermLabel term="双模式 Job 编排工作台" tip="支持编写 Nomad HCL（HashiCorp Configuration Language）、表单可视化编排或 JSON 定义，提交前可做语法校验和变更比对。" />}
          actions={
            isAdmin && (
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" onClick={() => setShowCompose(true)}>Compose 导入</Button>
                <Button size="sm" disabled={modeBusy || editMode === 'visual' && !visualReady} onClick={() => void validateJob()}>
                  <TermLabel term="Validate" tip="调用 Nomad API 校验 HCL/JSON 语法、驱动字段与参数合法性，不改动运行状态。" />
                </Button>
                <Button size="sm" variant="primary" disabled={modeBusy || editMode === 'visual' && !visualReady} onClick={() => void runPlan()}>
                  <TermLabel term="Plan Diff" tip="预演调度变更与滚动影响范围（Plan Dry-Run），确认无误后再提交部署。" />
                </Button>
              </div>
            )
          }
        >
          <div className="space-y-3 text-xs">
            <SectionTabs
              tabs={[
                { id: 'hcl', label: '原生 HCL 编辑器', tip: 'Nomad 原生 HashiCorp Configuration Language 声明式任务定义。' },
                ...(isAdmin ? [{ id: 'visual', label: '可视化编排' }] : []),
                { id: 'json', label: 'JSON 定义' },
              ]}
              active={editMode}
              onChange={(m) => { void changeMode(m as 'hcl' | 'visual' | 'json'); }}
            />

            <div className={editMode === 'visual' ? 'grid items-start gap-3 2xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)]' : ''}>
              {editMode === 'visual' && <VisualJobBuilder ref={visualRef} clusterId={clusterId} source={hcl} readOnly={!isAdmin}
                onSourceChange={(value) => { setHcl(value); clearPlan(); }} onValidityChange={(valid) => { setVisualReady(valid); if (!valid) clearPlan(); }} />}
              <div className="min-w-0 space-y-2">
                {editMode === 'visual' && <div className="font-semibold">实时 HCL 预览</div>}
                <CodeEditor value={hcl} onChange={(value) => { setHcl(value); clearPlan(); }} readOnly={!isAdmin || editMode === 'visual'} height={editMode === 'visual' ? '700px' : '340px'} />
              </div>
            </div>

            {isAdmin && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  placeholder="模板名称"
                  value={tplName}
                  onChange={(e) => setTplName(e.target.value)}
                  className="rounded border border-slate-300 bg-white px-2.5 py-1 dark:border-slate-700 dark:bg-slate-950"
                />
                <Button
                  size="sm"
                  disabled={modeBusy || editMode === 'json' || editMode === 'visual' && !visualReady}
                  onClick={() =>
                    tplName &&
                    void apiPost('/api/v1/job-templates', { name: tplName, edit_mode: 'hcl', hcl })
                      .then(() => { setTplName(''); toast.success('模板已保存'); return loadClusters(); })
                      .catch((ex) => setErr(ex.message))
                  }
                >
                  存为模板
                </Button>
              </div>
            )}

            {plan && (
              <div className="space-y-2 rounded-xl border border-indigo-300 bg-indigo-50/40 p-3.5 dark:border-indigo-500/40 dark:bg-indigo-950/30">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-indigo-900 dark:text-indigo-200">Plan Diff 预览 (plan_id: {plan.plan_id})</span>
                  {isAdmin && <Button size="sm" variant="primary" onClick={() => void runApply()}>确认 Apply</Button>}
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
