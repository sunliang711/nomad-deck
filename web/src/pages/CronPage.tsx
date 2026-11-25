import React, { useCallback, useEffect, useState } from 'react';
import { Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOpsDrawer } from '../lib/opsDrawer';
import { Badge, Button, Card, EmptyState, ErrorAlert, Input, Modal, Select, statusTone } from '../components/UI';

export function CronPage() {
  const { isAdmin } = useAuth();
  const { openTask } = useOpsDrawer();
  const [jobs, setJobs] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [selectedJob, setSelectedJob] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({
    name: '',
    cron_expr: '0 4 * * *',
    overlap_policy: 'skip_if_running',
    misfire_policy: 'skip',
    enabled: true,
    payload_type: 'cluster_snapshot',
    cluster_id: '',
  });

  const load = useCallback(async () => {
    setErr('');
    try {
      const res = await apiGet('/api/v1/cron-jobs');
      setJobs(res.cron_jobs || []);
    } catch (ex: any) {
      setErr(ex?.message || '加载定时任务失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadRuns = async (job: any) => {
    setSelectedJob(job);
    try {
      const res = await apiGet(`/api/v1/cron-jobs/${job.id}/runs?limit=30`);
      setRuns(res.runs || []);
    } catch (ex: any) {
      setErr(ex?.message || '加载执行历史失败');
    }
  };

  const toggleJob = async (j: any) => {
    try {
      await apiPut(`/api/v1/cron-jobs/${j.id}`, { enabled: !j.enabled });
      await load();
    } catch (ex: any) {
      setErr(ex?.message || '更新开关失败');
    }
  };

  const triggerJob = async (j: any) => {
    try {
      await apiPost(`/api/v1/cron-jobs/${j.id}/run`);
      await load();
      await loadRuns(j);
    } catch (ex: any) {
      setErr(ex?.message || '触发失败');
    }
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (creating) {
        await apiPost('/api/v1/cron-jobs', {
          name: form.name,
          cron_expr: form.cron_expr,
          overlap_policy: form.overlap_policy,
          misfire_policy: form.misfire_policy,
          enabled: form.enabled,
          payload: { type: form.payload_type, cluster_id: form.cluster_id },
        });
        setCreating(false);
      } else if (editing) {
        await apiPut(`/api/v1/cron-jobs/${editing.id}`, {
          name: form.name,
          cron_expr: form.cron_expr,
          overlap_policy: form.overlap_policy,
          misfire_policy: form.misfire_policy,
          enabled: form.enabled,
        });
        setEditing(null);
      }
      await load();
    } catch (ex: any) {
      setErr(ex?.message || '保存失败');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5" /> 刷新
        </Button>
        {isAdmin && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setForm({
                name: '',
                cron_expr: '0 4 * * *',
                overlap_policy: 'skip_if_running',
                misfire_policy: 'skip',
                enabled: true,
                payload_type: 'cluster_snapshot',
                cluster_id: '',
              });
              setCreating(true);
            }}
          >
            <Plus className="h-3.5 w-3.5" /> 新建自定义任务
          </Button>
        )}
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />

      <Card>
        {jobs.length === 0 ? (
          <EmptyState text="暂无定时任务" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">名称 / Key</th>
                  <th className="py-2 pr-3">Cron 表达式</th>
                  <th className="py-2 pr-3">策略（重入 / 漏执行）</th>
                  <th className="py-2 pr-3">上次结果</th>
                  <th className="py-2 pr-3">状态</th>
                  <th className="py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="py-2 pr-3">
                      <div className="font-medium">{j.name}</div>
                      <div className="font-mono text-slate-500">{j.job_key || j.id}</div>
                    </td>
                    <td className="py-2 pr-3 font-mono">{j.cron_expr}</td>
                    <td className="py-2 pr-3">{j.overlap_policy} / {j.misfire_policy}</td>
                    <td className="py-2 pr-3">
                      {j.last_status ? <Badge tone={statusTone(j.last_status)}>{j.last_status}</Badge> : '-'}
                      <div className="text-[11px] text-slate-500">{fmtTime(j.last_run_at)}</div>
                    </td>
                    <td className="py-2 pr-3">
                      <Badge tone={j.enabled ? 'green' : 'neutral'}>{j.enabled ? '启用' : '停用'}</Badge>
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button size="sm" onClick={() => void loadRuns(j)}>历史</Button>
                        {isAdmin && (
                          <>
                            <Button size="sm" onClick={() => void triggerJob(j)}>
                              <Play className="h-3 w-3" /> 触发
                            </Button>
                            <Button size="sm" onClick={() => void toggleJob(j)}>
                              {j.enabled ? '停用' : '启用'}
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => {
                                setEditing(j);
                                setForm({
                                  name: j.name,
                                  cron_expr: j.cron_expr,
                                  overlap_policy: j.overlap_policy,
                                  misfire_policy: j.misfire_policy,
                                  enabled: j.enabled,
                                  payload_type: 'cluster_snapshot',
                                  cluster_id: '',
                                });
                              }}
                            >
                              编辑
                            </Button>
                            {!j.is_builtin && (
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() =>
                                  void apiDelete(`/api/v1/cron-jobs/${j.id}`)
                                    .then(() => load())
                                    .catch((ex) => setErr(ex.message))
                                }
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedJob && (
        <Card title={`执行历史：${selectedJob.name}`} actions={<Button size="sm" onClick={() => setSelectedJob(null)}>关闭</Button>}>
          {runs.length === 0 ? (
            <EmptyState text="暂无执行记录" />
          ) : (
            <div className="space-y-2 text-xs">
              {runs.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2.5 dark:border-slate-800">
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                      <span>{r.summary || '-'}</span>
                    </div>
                    <div className="mt-0.5 text-slate-500">
                      触发：{r.trigger_type} · {fmtTime(r.started_at)}
                    </div>
                  </div>
                  {r.operation_task_id && (
                    <Button size="sm" onClick={() => openTask(r.operation_task_id)}>
                      查看运维任务
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Modal
        open={creating || Boolean(editing)}
        title={creating ? '新建自定义定时任务' : `编辑定时任务：${editing?.name}`}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      >
        <form onSubmit={saveEdit} className="space-y-3">
          <Input label="任务名称" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input label="Cron 表达式" required value={form.cron_expr} onChange={(e) => setForm({ ...form, cron_expr: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            <Select label="防重入策略" value={form.overlap_policy} onChange={(e) => setForm({ ...form, overlap_policy: e.target.value })}>
              <option value="skip_if_running">skip_if_running</option>
              <option value="queue_one">queue_one</option>
            </Select>
            <Select label="漏执行策略" value={form.misfire_policy} onChange={(e) => setForm({ ...form, misfire_policy: e.target.value })}>
              <option value="skip">skip</option>
              <option value="run_once">run_once</option>
            </Select>
          </div>
          {creating && (
            <>
              <Select label="任务类型" value={form.payload_type} onChange={(e) => setForm({ ...form, payload_type: e.target.value })}>
                <option value="cluster_snapshot">cluster_snapshot</option>
                <option value="doctor">doctor</option>
                <option value="nomad_job_export">nomad_job_export</option>
              </Select>
              <Input label="关联集群 ID" required value={form.cluster_id} onChange={(e) => setForm({ ...form, cluster_id: e.target.value })} />
            </>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => { setCreating(false); setEditing(null); }}>取消</Button>
            <Button type="submit" variant="primary">保存</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
