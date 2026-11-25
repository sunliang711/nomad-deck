import { useCallback, useEffect, useState } from 'react';
import { Download, Play, RefreshCw, RotateCcw, Square, Trash2 } from 'lucide-react';
import { apiDelete, apiDownload, apiGet, apiPost, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, EmptyState, ErrorAlert, Input, Modal, SectionTabs, Select, statusTone } from '../components/UI';
import { CodeEditor } from '../components/CodeEditor';

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
  const [clusters, setClusters] = useState<any[]>([]);
  const [clusterId, setClusterId] = useState('');
  const [namespace, setNamespace] = useState('default');
  const [jobs, setJobs] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [editMode, setEditMode] = useState<'hcl' | 'visual'>('hcl');
  const [hcl, setHcl] = useState(sampleHCL);
  const [visual, setVisual] = useState({
    id: 'hello',
    namespace: 'default',
    type: 'service',
    datacenters: 'dc1',
    group: 'app',
    count: 1,
    task: 'server',
    image: 'nginx:alpine',
    cpu: 100,
    memory: 128,
    extra_hcl: '',
  });
  const [composeText, setComposeText] = useState('');
  const [showCompose, setShowCompose] = useState(false);
  const [plan, setPlan] = useState<any>(null);
  const [revisions, setRevisions] = useState<any[]>([]);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [tplName, setTplName] = useState('');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  const loadClusters = useCallback(async () => {
    const [cRes, tRes] = await Promise.all([apiGet('/api/v1/clusters?type=nomad'), apiGet('/api/v1/job-templates')]);
    const list = cRes.clusters || [];
    setClusters(list);
    setTemplates(tRes.templates || []);
    if (!clusterId && list.length > 0) setClusterId(list[0].id);
  }, [clusterId]);

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

  const syncVisualToHCL = async () => {
    if (!clusterId) return;
    setErr('');
    try {
      const spec = {
        id: visual.id,
        name: visual.id,
        namespace: visual.namespace,
        type: visual.type,
        datacenters: visual.datacenters.split(',').map((s) => s.trim()).filter(Boolean),
        groups: [
          {
            name: visual.group,
            count: Number(visual.count),
            tasks: [
              {
                name: visual.task,
                driver: 'docker',
                docker: { image: visual.image },
                resources: { cpu: Number(visual.cpu), memory: Number(visual.memory) },
              },
            ],
          },
        ],
        extra_hcl: visual.extra_hcl,
      };
      const res = await apiPost(`/api/v1/nomad/${clusterId}/job-ops/render`, spec);
      if (res.hcl) setHcl(res.hcl);
      setNotice('已由可视化配置渲染为 HCL');
    } catch (ex: any) {
      setErr(ex?.message || '渲染 HCL 失败');
    }
  };

  const runPlan = async () => {
    if (!clusterId) return;
    setErr('');
    try {
      const res = await apiPost(`/api/v1/nomad/${clusterId}/job-ops/plan`, {
        input_type: 'hcl',
        hcl,
        namespace,
        edit_mode: editMode,
      });
      setPlan(res.plan);
    } catch (ex: any) {
      setErr(ex?.message || 'Plan 失败');
    }
  };

  const runApply = async () => {
    if (!clusterId || !plan?.plan_id) return;
    setErr('');
    try {
      await apiPost(`/api/v1/nomad/${clusterId}/job-ops/apply`, { plan_id: plan.plan_id });
      setPlan(null);
      setNotice('Job Apply 提交成功');
      await loadJobs();
    } catch (ex: any) {
      setErr(ex?.message || 'Apply 失败');
    }
  };

  const loadJobForEdit = async (j: any) => {
    const ns = j.Namespace || namespace;
    setSelectedJobId(j.ID);
    try {
      const [src, rev] = await Promise.all([
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(ns)}/jobs/${encodeURIComponent(j.ID)}/edit-source`),
        apiGet(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(ns)}/jobs/${encodeURIComponent(j.ID)}/revisions`),
      ]);
      if (src.source?.hcl) setHcl(src.source.hcl);
      setRevisions(rev.revisions || []);
    } catch (ex: any) {
      setErr(ex?.message || '读取 Job 编辑源码失败');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={clusterId} onChange={(e) => setClusterId(e.target.value)}>
            {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Input value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="Namespace" />
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void loadJobs()}><RefreshCw className="h-3.5 w-3.5" /> 刷新</Button>
          {isAdmin && clusterId && (
            <Button
              size="sm"
              onClick={() => void apiDownload(`/api/v1/nomad/${clusterId}/job-ops/export`, { namespace }, 'nomad-jobs.zip')}
            >
              <Download className="h-3.5 w-3.5" /> 批量导出 HCL
            </Button>
          )}
        </div>
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />
      {notice && <div className="rounded bg-emerald-50 px-3.5 py-2 text-xs text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">{notice}</div>}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Card title="集群 Jobs & 模板">
          <div className="space-y-4 text-xs">
            <div className="space-y-1.5">
              {jobs.length === 0 ? (
                <EmptyState text="暂无 Job" />
              ) : (
                jobs.map((j) => (
                  <div key={`${j.Namespace}:${j.ID}`} className="flex items-center justify-between gap-2 rounded border border-slate-200 p-2 dark:border-slate-800">
                    <div>
                      <div className="font-mono font-semibold">{j.ID}</div>
                      <Badge tone={statusTone(j.Status)}>{j.Status}</Badge>
                    </div>
                    {isAdmin && (
                      <div className="flex gap-1">
                        <Button size="sm" onClick={() => void loadJobForEdit(j)}>编辑</Button>
                        <Button size="sm" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(j.Namespace)}/jobs/${encodeURIComponent(j.ID)}/start`, {}).then(() => loadJobs())}><Play className="h-3 w-3" /></Button>
                        <Button size="sm" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(j.Namespace)}/jobs/${encodeURIComponent(j.ID)}/stop`, {}).then(() => loadJobs())}><Square className="h-3 w-3" /></Button>
                        <Button size="sm" variant="danger" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(j.Namespace)}/jobs/${encodeURIComponent(j.ID)}/purge`, {}).then(() => loadJobs())}><Trash2 className="h-3 w-3" /></Button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
              <div className="mb-1.5 font-semibold">Job 模板库 ({templates.length})</div>
              <div className="space-y-1">
                {templates.map((t) => (
                  <div key={t.id} className="flex items-center justify-between rounded border border-slate-200 p-1.5 dark:border-slate-800">
                    <span>{t.name}</span>
                    <div className="flex gap-1">
                      <Button size="sm" onClick={() => setHcl(t.hcl_content || '')}>载入</Button>
                      {isAdmin && <Button size="sm" variant="danger" onClick={() => void apiDelete(`/api/v1/job-templates/${t.id}`).then(() => loadClusters())}>删</Button>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <Card
          className="xl:col-span-2"
          title="双模式 Job 编排工作台"
          actions={
            isAdmin && (
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" onClick={() => setShowCompose(true)}>Compose 导入</Button>
                <Button size="sm" onClick={() => void apiPost(`/api/v1/nomad/${clusterId}/job-ops/validate`, { input_type: 'hcl', hcl, namespace }).then(() => setNotice('校验通过')).catch((ex) => setErr(ex.message))}>
                  Validate
                </Button>
                <Button size="sm" variant="primary" onClick={() => void runPlan()}>
                  Plan Diff
                </Button>
              </div>
            )
          }
        >
          <div className="space-y-3 text-xs">
            <SectionTabs
              tabs={[
                { id: 'hcl', label: '原生 HCL 编辑器' },
                { id: 'visual', label: '可视化编排' },
              ]}
              active={editMode}
              onChange={(m) => setEditMode(m as any)}
            />

            {editMode === 'visual' && (
              <div className="space-y-3 rounded border border-slate-200 p-3 dark:border-slate-800">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Input label="Job ID" value={visual.id} onChange={(e) => setVisual({ ...visual, id: e.target.value })} />
                  <Input label="Namespace" value={visual.namespace} onChange={(e) => setVisual({ ...visual, namespace: e.target.value })} />
                  <Select label="类型" value={visual.type} onChange={(e) => setVisual({ ...visual, type: e.target.value })}>
                    <option value="service">service</option>
                    <option value="batch">batch</option>
                    <option value="system">system</option>
                  </Select>
                  <Input label="Group" value={visual.group} onChange={(e) => setVisual({ ...visual, group: e.target.value })} />
                  <Input label="Count" type="number" value={visual.count} onChange={(e) => setVisual({ ...visual, count: Number(e.target.value) })} />
                  <Input label="Docker 镜像" value={visual.image} onChange={(e) => setVisual({ ...visual, image: e.target.value })} />
                  <Input label="CPU (MHz)" type="number" value={visual.cpu} onChange={(e) => setVisual({ ...visual, cpu: Number(e.target.value) })} />
                  <Input label="Memory (MiB)" type="number" value={visual.memory} onChange={(e) => setVisual({ ...visual, memory: Number(e.target.value) })} />
                </div>
                <Button size="sm" variant="primary" onClick={() => void syncVisualToHCL()}>生成右侧 HCL</Button>
              </div>
            )}

            <CodeEditor value={hcl} onChange={setHcl} readOnly={!isAdmin} height="340px" />

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
                  onClick={() =>
                    tplName &&
                    void apiPost('/api/v1/job-templates', { name: tplName, edit_mode: 'hcl', hcl_content: hcl })
                      .then(() => { setTplName(''); setNotice('模板已保存'); return loadClusters(); })
                      .catch((ex) => setErr(ex.message))
                  }
                >
                  存为模板
                </Button>
              </div>
            )}

            {plan && (
              <div className="space-y-2 rounded border border-emerald-300 bg-emerald-50/40 p-3 dark:border-emerald-800 dark:bg-emerald-950/30">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">Plan Diff 预览 (plan_id: {plan.plan_id})</span>
                  {isAdmin && <Button size="sm" variant="primary" onClick={() => void runApply()}>确认 Apply</Button>}
                </div>
                <pre className="max-h-56 overflow-auto rounded bg-slate-950 p-2.5 font-mono text-[11px] text-slate-100">
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
                      {isAdmin && (
                        <Button
                          size="sm"
                          onClick={() =>
                            void apiPost(
                              `/api/v1/nomad/${clusterId}/namespaces/${encodeURIComponent(namespace)}/jobs/${encodeURIComponent(selectedJobId)}/revert`,
                              { version: rv.nomad_version },
                            ).then(() => setNotice('已回滚 Job 版本')).catch((ex) => setErr(ex.message))
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
                    setShowCompose(false);
                    setNotice('已转换为 Nomad HCL');
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
