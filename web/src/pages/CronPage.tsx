import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Play, Plus, RefreshCw, Shield, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOpsDrawer } from '../lib/opsDrawer';
import { Badge, Button, Card, EmptyState, ErrorAlert, Input, Modal, PasswordConfirmModal, SecretInput, Select, TermLabel, statusTone } from '../components/UI';

const defaultSafeKeepTarget = {
  id: '',
  name: '',
  type: 'safekeep',
  enabled: true,
  retention_count: 14,
  snapshot_retention_count: 7,
  safekeep_url: '',
  safekeep_api_key: '',
  safekeep_api_key_set: false,
  safekeep_targets: '',
  safekeep_subpath: 'nomad-deck',
  safekeep_mode: 'sync',
  safekeep_insecure_tls: false,
};

export function CronPage() {
  const { isAdmin } = useAuth();
  const { openTask } = useOpsDrawer();
  const [jobs, setJobs] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [clusters, setClusters] = useState<any[]>([]);
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [backupCfg, setBackupCfg] = useState<any>(null);
  const [selectedJob, setSelectedJob] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({
    name: '',
    cron_expr: '0 4 * * *',
    overlap_policy: 'skip_if_running',
    misfire_policy: 'skip',
    enabled: true,
    payload_type: 'cluster_snapshot',
    cluster_id: '',
    target_id: '',
    integration_id: '',
  });

  // SafeKeep / backup configuration modal right inside CronPage
  const [showDrModal, setShowDrModal] = useState(false);
  const [bkEnabled, setBkEnabled] = useState(false);
  const [bkPass, setBkPass] = useState('');
  const [drTargets, setDrTargets] = useState<any[]>([]);
  const [skForm, setSkForm] = useState<any>({ ...defaultSafeKeepTarget });
  const [skTest, setSkTest] = useState<any>(null);
  const [pwAction, setPwAction] = useState<{ title: string; run: (pw: string) => Promise<void> } | null>(null);

  const load = useCallback(async () => {
    setErr('');
    try {
      const reqs: Array<Promise<any>> = [
        apiGet('/api/v1/cron-jobs'),
        apiGet('/api/v1/clusters'),
        apiGet('/api/v1/integrations'),
      ];
      if (isAdmin) reqs.push(apiGet('/api/v1/backup/config'));
      const [cRes, clRes, intRes, bRes] = await Promise.all(reqs);
      setJobs(cRes.cron_jobs || []);
      setClusters(clRes.clusters || []);
      setIntegrations(intRes.integrations || []);
      if (bRes?.backup) {
        setBackupCfg(bRes.backup);
        setBkEnabled(Boolean(bRes.backup.enabled));
        setDrTargets(bRes.backup.targets || []);
      }
    } catch (ex: any) {
      setErr(ex?.message || '加载定时任务失败');
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const safekeepTargets = (backupCfg?.targets || []).filter((t: any) => t.type === 'safekeep');

  const openDrConfig = () => {
    setBkEnabled(Boolean(backupCfg?.enabled));
    setBkPass('');
    setDrTargets(backupCfg?.targets || []);
    const firstSK = (backupCfg?.targets || []).find((t: any) => t.type === 'safekeep');
    setSkForm(firstSK ? { ...defaultSafeKeepTarget, ...firstSK, safekeep_api_key: '' } : { ...defaultSafeKeepTarget });
    setSkTest(null);
    setShowDrModal(true);
  };

  const buildBackupTargetPayload = (t: any) => {
    const out: any = {
      id: t.id,
      name: t.name,
      type: t.type,
      enabled: Boolean(t.enabled),
      retention_count: Number(t.retention_count || 14),
      snapshot_retention_count: Number(t.snapshot_retention_count || 7),
      path: t.path,
      host: t.host,
      port: Number(t.port || 22),
      username: t.username,
      ssh_key_id: t.ssh_key_id,
      host_key_fingerprint: t.host_key_fingerprint,
      remote_dir: t.remote_dir,
      endpoint: t.endpoint,
      region: t.region,
      bucket: t.bucket,
      prefix: t.prefix,
      access_key_id: t.access_key_id,
      use_ssl: Boolean(t.use_ssl),
      path_style: Boolean(t.path_style),
      safekeep_url: t.safekeep_url || '',
      safekeep_targets: t.safekeep_targets || '',
      safekeep_subpath: t.safekeep_subpath || '',
      safekeep_mode: t.safekeep_mode || 'sync',
      safekeep_insecure_tls: Boolean(t.safekeep_insecure_tls),
    };
    if (t.type === 's3' && t.secret_access_key) out.secret_access_key = t.secret_access_key;
    if (t.type === 'safekeep' && t.safekeep_api_key) out.safekeep_api_key = t.safekeep_api_key;
    return out;
  };

  const applySafeKeepFormToList = () => {
    if (!skForm.safekeep_url?.trim()) return drTargets;
    const item = {
      ...skForm,
      id: skForm.id || 'tgt_' + Math.random().toString(36).slice(2, 10),
      name: skForm.name?.trim() || 'SafeKeep-DR',
      type: 'safekeep',
    };
    const idx = drTargets.findIndex((x) => x.id === item.id);
    if (idx >= 0) {
      const next = [...drTargets];
      next[idx] = item;
      return next;
    }
    return [...drTargets, item];
  };

  const testSafeKeepTarget = async () => {
    setErr('');
    setSkTest(null);
    try {
      const res = await apiPost('/api/v1/backup/targets/test', buildBackupTargetPayload({ ...skForm, type: 'safekeep' }));
      setSkTest(res.result);
    } catch (ex: any) {
      setErr(ex?.message || 'SafeKeep 测试失败');
    }
  };

  const saveDrConfig = () => {
    const updatedTargets = applySafeKeepFormToList();
    setDrTargets(updatedTargets);
    setPwAction({
      title: '保存 SafeKeep 与灾备定时配置',
      run: async (pw) => {
        const payload: any = {
          current_password: pw,
          enabled: bkEnabled,
          include_history: backupCfg?.include_history || [],
          targets: updatedTargets.map(buildBackupTargetPayload),
        };
        if (bkPass) payload.passphrase = bkPass;
        await apiPut('/api/v1/backup/config', payload);
        setBkPass('');
        setShowDrModal(false);
        setNotice('SafeKeep 与灾备定时配置已保存');
        await load();
      },
    });
  };

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
        const payload: any = { type: form.payload_type };
        if (form.payload_type === 'safekeep_backup') {
          payload.target_id = form.target_id;
          if (form.cluster_id) payload.cluster_id = form.cluster_id;
        } else if (form.payload_type === 'static_jwks_sync') {
          payload.integration_id = form.integration_id;
        } else {
          payload.cluster_id = form.cluster_id;
        }
        await apiPost('/api/v1/cron-jobs', {
          name: form.name,
          cron_expr: form.cron_expr,
          overlap_policy: form.overlap_policy,
          misfire_policy: form.misfire_policy,
          enabled: form.enabled,
          payload,
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-500">
          已配置 SafeKeep 灾备目标：<b className="text-slate-700 dark:text-slate-200">{safekeepTargets.length}</b> 个
          {isAdmin && (
            <>
              {' · '}
              <Link to="/migration-backup" className="text-emerald-600 hover:underline dark:text-emerald-400">
                前往迁移与全量灾备页
              </Link>
            </>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> 刷新
          </Button>
          {isAdmin && (
            <>
              <Button size="sm" onClick={openDrConfig}>
                <Shield className="h-3.5 w-3.5" /> 配置 SafeKeep / 灾备
              </Button>
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
                    cluster_id: clusters[0]?.id || '',
                    target_id: safekeepTargets[0]?.id || '',
                    integration_id: integrations[0]?.id || '',
                  });
                  setCreating(true);
                }}
              >
                <Plus className="h-3.5 w-3.5" /> 新建自定义任务
              </Button>
            </>
          )}
        </div>
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />
      {notice && (
        <div className="rounded-md bg-emerald-50 px-3.5 py-2 text-xs text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
          {notice}
        </div>
      )}

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
                  <th className="py-2 pr-3"><TermLabel term="策略（重入 / 漏执行）" tip="防重入（Overlap）：上次未结束时的处理方式；漏执行（Misfire）：控制面停机错过触发时间后的补跑策略。" /></th>
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
                                  target_id: '',
                                  integration_id: '',
                                });
                              }}
                            >
                              编辑
                            </Button>
                            {j.job_key === 'control_plane_backup' && (
                              <Button size="sm" onClick={openDrConfig}>
                                SafeKeep / 灾备参数
                              </Button>
                            )}
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
            <Select
              label={<TermLabel term="防重入策略" tip="skip_if_running：前一次尚未跑完则跳过本次；queue_one：排入 1 个等待槽位。" />}
              value={form.overlap_policy}
              onChange={(e) => setForm({ ...form, overlap_policy: e.target.value })}
            >
              <option value="skip_if_running">skip_if_running</option>
              <option value="queue_one">queue_one</option>
            </Select>
            <Select
              label={<TermLabel term="漏执行策略" tip="控制面重启导致错过触发窗口时：skip 放弃补跑，run_once 立即补偿执行一次。" />}
              value={form.misfire_policy}
              onChange={(e) => setForm({ ...form, misfire_policy: e.target.value })}
            >
              <option value="skip">skip</option>
              <option value="run_once">run_once</option>
            </Select>
          </div>
          {creating && (
            <>
              <Select
                label="任务类型"
                value={form.payload_type}
                onChange={(e) => {
                  const pt = e.target.value;
                  setForm({
                    ...form,
                    payload_type: pt,
                    cluster_id: pt === 'safekeep_backup' ? '' : form.cluster_id || clusters[0]?.id || '',
                    target_id: pt === 'safekeep_backup' ? form.target_id || safekeepTargets[0]?.id || '' : '',
                  });
                }}
              >
                <option value="cluster_snapshot">cluster_snapshot（集群 Raft 快照）</option>
                <option value="safekeep_backup">safekeep_backup（SafeKeep 定时灾备）</option>
                <option value="doctor">doctor（集群体检）</option>
                <option value="nomad_job_export">nomad_job_export（导出 Nomad Jobs）</option>
                <option value="static_jwks_sync">static_jwks_sync（同步静态 JWKS）</option>
              </Select>
              {form.payload_type === 'safekeep_backup' ? (
                <div className="space-y-2 rounded border border-slate-200 p-3 dark:border-slate-800">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">SafeKeep 目标配置</span>
                    <button type="button" onClick={openDrConfig} className="text-emerald-600 hover:underline dark:text-emerald-400">
                      + 新增/管理 SafeKeep 目标
                    </button>
                  </div>
                  <Select
                    label="SafeKeep 目标"
                    required
                    value={form.target_id}
                    onChange={(e) => setForm({ ...form, target_id: e.target.value })}
                  >
                    <option value="">请选择 SafeKeep 目标...</option>
                    {safekeepTargets.map((t: any) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.safekeep_url}){t.enabled ? '' : ' [已停用]'}
                      </option>
                    ))}
                  </Select>
                  <Select
                    label="备份范围"
                    value={form.cluster_id}
                    onChange={(e) => setForm({ ...form, cluster_id: e.target.value })}
                  >
                    <option value="">控制面全量灾备 (.ndbundle)</option>
                    {clusters.map((c: any) => (
                      <option key={c.id} value={c.id}>
                        集群 Raft 快照：{c.name} ({c.type})
                      </option>
                    ))}
                  </Select>
                </div>
              ) : form.payload_type === 'static_jwks_sync' ? (
                <Select
                  label="关联联动"
                  required
                  value={form.integration_id}
                  onChange={(e) => setForm({ ...form, integration_id: e.target.value })}
                >
                  <option value="">请选择 Nomad-Vault 联动...</option>
                  {integrations.map((i: any) => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </Select>
              ) : clusters.length > 0 ? (
                <Select
                  label="关联集群"
                  required
                  value={form.cluster_id}
                  onChange={(e) => setForm({ ...form, cluster_id: e.target.value })}
                >
                  <option value="">请选择集群...</option>
                  {clusters.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                  ))}
                </Select>
              ) : (
                <Input label="关联集群 ID" required value={form.cluster_id} onChange={(e) => setForm({ ...form, cluster_id: e.target.value })} />
              )}
            </>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => { setCreating(false); setEditing(null); }}>取消</Button>
            <Button type="submit" variant="primary">保存</Button>
          </div>
        </form>
      </Modal>

      <Modal open={showDrModal} title="SafeKeep 灾备目标与加密配置" onClose={() => setShowDrModal(false)} wide>
        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 font-medium">
              <input type="checkbox" checked={bkEnabled} onChange={(e) => setBkEnabled(e.target.checked)} />
              <span>启用控制面定时灾备（control_plane_backup）</span>
            </label>
            <SecretInput
              label="灾备加密口令（至少 12 位）"
              value={bkPass}
              hasStoredValue={Boolean(backupCfg?.passphrase_set)}
              resetKey={showDrModal ? 'open' : 'closed'}
              onChangeValue={setBkPass}
              onRevealStored={async () => {
                const r = await apiPost('/api/v1/backup/secrets/reveal', { kind: 'passphrase' });
                return r.secret || '';
              }}
            />
          </div>

          {safekeepTargets.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {safekeepTargets.map((t: any) => (
                <Button
                  key={t.id}
                  size="sm"
                  variant={skForm.id === t.id ? 'primary' : 'secondary'}
                  onClick={() => setSkForm({ ...defaultSafeKeepTarget, ...t, safekeep_api_key: '' })}
                >
                  {t.name}
                </Button>
              ))}
              <Button size="sm" onClick={() => setSkForm({ ...defaultSafeKeepTarget })}>+ 新建 SafeKeep 目标</Button>
            </div>
          )}

          <div className="space-y-2.5 rounded border border-slate-200 p-3 dark:border-slate-800">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                label="目标名称"
                placeholder="SafeKeep-DR"
                value={skForm.name}
                onChange={(e) => setSkForm({ ...skForm, name: e.target.value })}
              />
              <Input
                label="SafeKeep 服务地址"
                placeholder="https://safekeep.example.com:8080"
                value={skForm.safekeep_url}
                onChange={(e) => setSkForm({ ...skForm, safekeep_url: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <SecretInput
                label="SafeKeep X-API-Key"
                value={skForm.safekeep_api_key || ''}
                hasStoredValue={Boolean(skForm.safekeep_api_key_set)}
                resetKey={skForm.id || 'new'}
                onChangeValue={(v) => setSkForm({ ...skForm, safekeep_api_key: v })}
                onRevealStored={
                  skForm.id && skForm.safekeep_api_key_set
                    ? async () => {
                        const r = await apiPost('/api/v1/backup/secrets/reveal', { kind: 'target_secret', target_id: skForm.id });
                        return r.secret || '';
                      }
                    : undefined
                }
              />
              <Input
                label="远端子路径 (X-Backup-Path)"
                value={skForm.safekeep_subpath || ''}
                onChange={(e) => setSkForm({ ...skForm, safekeep_subpath: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Input
                label="上游目标 (X-Backup-Targets)"
                placeholder="留空按 SafeKeep 默认"
                value={skForm.safekeep_targets || ''}
                onChange={(e) => setSkForm({ ...skForm, safekeep_targets: e.target.value })}
              />
              <Select
                label="模式 (X-Backup-Mode)"
                value={skForm.safekeep_mode || 'sync'}
                onChange={(e) => setSkForm({ ...skForm, safekeep_mode: e.target.value })}
              >
                <option value="sync">sync</option>
                <option value="async">async</option>
              </Select>
              <label className="flex items-center gap-1.5 pt-4">
                <input
                  type="checkbox"
                  checked={Boolean(skForm.safekeep_insecure_tls)}
                  onChange={(e) => setSkForm({ ...skForm, safekeep_insecure_tls: e.target.checked })}
                />
                <span>跳过 TLS 校验</span>
              </label>
            </div>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={Boolean(skForm.enabled)}
                onChange={(e) => setSkForm({ ...skForm, enabled: e.target.checked })}
              />
              <span>启用该 SafeKeep 目标</span>
            </label>
            {skTest && (
              <div className="rounded bg-slate-100 p-2 dark:bg-slate-950">
                测试结果：<b>{skTest.ok ? '连通正常' : '失败'}</b>（{skTest.latency_ms} ms）
                {skTest.error && <span className="ml-2 text-rose-600">{skTest.error}</span>}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => setShowDrModal(false)}>取消</Button>
            <Button type="button" onClick={() => void testSafeKeepTarget()}>测试 SafeKeep 连通性</Button>
            <Button type="button" variant="primary" onClick={saveDrConfig}>保存配置</Button>
          </div>
        </div>
      </Modal>

      <PasswordConfirmModal
        open={Boolean(pwAction)}
        title={pwAction?.title || ''}
        onClose={() => setPwAction(null)}
        onConfirm={async (pw) => {
          if (pwAction) await pwAction.run(pw);
        }}
      />
    </div>
  );
}
