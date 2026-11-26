import React, { useCallback, useEffect, useState } from 'react';
import { Download, Plus, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { apiDownload, apiGet, apiPost, apiPut, apiUpload, fmtBytes, fmtTime } from '../lib/api';
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
  PasswordConfirmModal,
  SecretInput,
  SectionTabs,
  Select,
  StatusBadge,
  TermLabel,
} from '../components/UI';

const optionalTables = [
  { id: 'admins', label: '管理员账号（迁移可选）' },
  { id: 'job_revisions', label: 'Job 修订历史' },
  { id: 'audit_logs', label: '审计日志' },
  { id: 'operation_tasks', label: '运维任务与步骤日志' },
  { id: 'cron_job_runs', label: '定时任务执行历史' },
];

export function MigrationBackupPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const askConfirm = useConfirm();

  const [tab, setTab] = useState('backup');
  const [err, setErr] = useState('');

  // Migration export/import state
  const [expPass, setExpPass] = useState('');
  const [expInclude, setExpInclude] = useState<string[]>(['admins']);
  const [impPass, setImpPass] = useState('');
  const [impStrategy, setImpStrategy] = useState<'replace' | 'merge'>('replace');
  const [impFile, setImpFile] = useState<File | null>(null);
  const [previewRep, setPreviewRep] = useState<any>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  // Backup state
  const [backupCfg, setBackupCfg] = useState<any>(null);
  const [bkEnabled, setBkEnabled] = useState(false);
  const [bkPass, setBkPass] = useState('');
  const [bkHistoryTables, setBkHistoryTables] = useState<string[]>([]);
  const [targets, setTargets] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [testResult, setTestResult] = useState<any>(null);
  const [clusters, setClusters] = useState<any[]>([]);
  const [targetSnaps, setTargetSnaps] = useState<{ targetId: string; items: any[] } | null>(null);
  const [importSnapForm, setImportSnapForm] = useState({ targetId: '', object: '', clusterId: '', passphrase: '' });
  const [showTargetModal, setShowTargetModal] = useState(false);
  const emptySafeKeepTarget = {
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
  const [tForm, setTForm] = useState<any>({ ...emptySafeKeepTarget });

  const [pwAction, setPwAction] = useState<{ title: string; description?: string; run: (pw: string) => Promise<void> } | null>(null);

  const loadBackup = useCallback(async () => {
    setErr('');
    try {
      const [cRes, hRes, clRes] = await Promise.all([
        apiGet('/api/v1/backup/config'),
        apiGet('/api/v1/backup/history?limit=30'),
        apiGet('/api/v1/clusters'),
      ]);
      const cfg = cRes.backup;
      setBackupCfg(cfg);
      setBkEnabled(Boolean(cfg.enabled));
      setBkHistoryTables(cfg.include_history || []);
      setTargets(cfg.targets || []);
      setRuns(hRes.runs || []);
      setClusters(clRes.clusters || []);
    } catch (ex: any) {
      setErr(ex?.message || '加载灾备配置失败');
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void loadBackup();
  }, [isAdmin, loadBackup]);

  if (!isAdmin) {
    return (
      <div className="space-y-5">
        <PageHeader title="迁移与灾备" subtitle="控制面数据加密迁移与异地灾备同步" />
        <Card title="权限受限">迁移与灾备操作仅限 admin 角色。</Card>
      </div>
    );
  }

  const doPreview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!impFile) return;
    setErr('');
    setPreviewBusy(true);
    try {
      const res = await apiUpload(
        '/api/v1/migration/import/preview',
        [
          ['passphrase', impPass],
          ['strategy', impStrategy],
        ],
        impFile,
      );
      setPreviewRep(res.report);
      toast.info('迁移包解析与 Dry-Run 预检完成');
    } catch (ex: any) {
      setPreviewRep(null);
      toast.error(ex?.message || '迁移预检失败');
    } finally {
      setPreviewBusy(false);
    }
  };

  const saveTargetForm = (e: React.FormEvent) => {
    e.preventDefault();
    const copy = { ...tForm };
    if (!copy.id) copy.id = 'tgt_' + Math.random().toString(36).slice(2, 10);
    setTargets((prev) => {
      const idx = prev.findIndex((x) => x.id === copy.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = copy;
        return next;
      }
      return [...prev, copy];
    });
    setShowTargetModal(false);
    toast.info('已暂存目标修改，请记得点击“保存配置”使其持久化');
  };

  const buildTargetPayload = (t: any) => {
    const out: any = {
      id: t.id,
      name: t.name,
      type: 'safekeep',
      enabled: Boolean(t.enabled),
      retention_count: Number(t.retention_count || 14),
      snapshot_retention_count: Number(t.snapshot_retention_count || 7),
      safekeep_url: t.safekeep_url || '',
      safekeep_targets: t.safekeep_targets || '',
      safekeep_subpath: t.safekeep_subpath || '',
      safekeep_mode: t.safekeep_mode || 'sync',
      safekeep_insecure_tls: Boolean(t.safekeep_insecure_tls),
    };
    if (t.safekeep_api_key) {
      out.safekeep_api_key = t.safekeep_api_key;
    }
    return out;
  };

  const testTarget = async (t: any) => {
    setErr('');
    try {
      const res = await apiPost('/api/v1/backup/targets/test', buildTargetPayload(t));
      setTestResult(res.result);
      if (res.result?.ok) toast.success(`目标 ${t.name} 连通正常`);
      else toast.error(res.result?.error || `目标 ${t.name} 测试失败`);
    } catch (ex: any) {
      toast.error(ex?.message || '测试失败');
    }
  };

  const removeTarget = async (t: any) => {
    if (
      !(await askConfirm(`确认从待保存列表中移除备份目标「${t.name}」吗？`, {
        title: '移除备份目标',
        confirmText: '确认移除',
        danger: true,
      }))
    ) {
      return;
    }
    setTargets((prev) => prev.filter((x) => x.id !== t.id));
  };

  const saveBackupConfig = () => {
    setPwAction({
      title: '保存控制面灾备配置',
      run: async (pw) => {
        const payload: any = {
          current_password: pw,
          enabled: bkEnabled,
          include_history: bkHistoryTables,
          targets: targets.map(buildTargetPayload),
        };
        if (bkPass) payload.passphrase = bkPass;
        await apiPut('/api/v1/backup/config', payload);
        setBkPass('');
        toast.success('灾备配置已保存');
        await loadBackup();
      },
    });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="迁移与灾备"
        subtitle="控制面定时灾备与异地快照同步，以及加密迁移包（.ndbundle）导出与恢复"
        actions={
          <Button onClick={() => void loadBackup()}>
            <RefreshCw className="h-4 w-4" />
            <span>刷新</span>
          </Button>
        }
      />

      <SectionTabs
        tabs={[
          { id: 'backup', label: '控制面定时灾备备份', badge: targets.length },
          { id: 'migration', label: '环境迁移（.ndbundle）' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {tab === 'backup' && (
        <div className="space-y-5">
          {backupCfg?.missing_offsite_target && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              生产环境要求至少配置一个已启用的 SafeKeep 灾备目标，否则控制面宿主机磁盘损坏将无法恢复。
            </div>
          )}

          <Card
            title="灾备策略与存储目标"
            actions={
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    void apiPost('/api/v1/backup/run')
                      .then(() => {
                        toast.success('已执行控制面灾备备份并校验通过');
                        return loadBackup();
                      })
                      .catch((ex) => toast.error(ex.message))
                  }
                >
                  立即备份
                </Button>
                <Button size="sm" variant="primary" onClick={saveBackupConfig}>
                  保存配置
                </Button>
              </div>
            }
          >
            <div className="space-y-4 text-xs">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="flex items-center gap-2 font-medium pt-2">
                  <input type="checkbox" checked={bkEnabled} onChange={(e) => setBkEnabled(e.target.checked)} />
                  <span>启用定时灾备（control_plane_backup）与异地 Raft 快照同步</span>
                </label>
                <SecretInput
                  label={
                    <TermLabel
                      term="备份口令（至少 12 位）"
                      tip="用于加密 .ndbundle 灾备归档包（AES-256-GCM + Argon2id），异地恢复时必须提供同一口令。"
                    />
                  }
                  value={bkPass}
                  hasStoredValue={Boolean(backupCfg?.passphrase_set)}
                  resetKey={backupCfg?.passphrase_set}
                  onChangeValue={setBkPass}
                  onRevealStored={async () => {
                    const r = await apiPost('/api/v1/backup/secrets/reveal', { kind: 'passphrase' });
                    return r.secret || '';
                  }}
                />
              </div>

              <div>
                <div className="mb-2 font-medium text-slate-700 dark:text-slate-200">额外包含历史数据（管理员账号固定包含）</div>
                <div className="flex flex-wrap gap-4">
                  {optionalTables
                    .filter((t) => t.id !== 'admins')
                    .map((t) => (
                      <label key={t.id} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={bkHistoryTables.includes(t.id)}
                          onChange={(e) =>
                            setBkHistoryTables((prev) =>
                              e.target.checked ? [...prev, t.id] : prev.filter((x) => x !== t.id),
                            )
                          }
                        />
                        <span>{t.label}</span>
                      </label>
                    ))}
                </div>
              </div>

              <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
                <div className="mb-3 flex items-center justify-between">
                  <span className="font-semibold text-sm text-slate-800 dark:text-slate-100">SafeKeep 灾备目标列表</span>
                  <Button
                    size="sm"
                    onClick={() => {
                      setTForm({ ...emptySafeKeepTarget });
                      setShowTargetModal(true);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>添加 SafeKeep 目标</span>
                  </Button>
                </div>
                {targets.length === 0 ? (
                  <EmptyState title="尚未添加 SafeKeep 灾备目标" description="添加 SafeKeep API 灾备网关目标以启用控制面异地灾备与快照同步。" />
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {targets.map((t) => (
                      <div
                        key={t.id}
                        className="flex flex-col justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 bg-slate-50/50 dark:bg-slate-800/40"
                      >
                        <div>
                          <div className="flex items-center gap-2 font-medium text-sm">
                            <span className="text-slate-900 dark:text-slate-100">{t.name}</span>
                            <Badge>SafeKeep</Badge>
                            <StatusBadge value={t.enabled ? 'enabled' : 'disabled'} label={t.enabled ? '启用' : '停用'} />
                          </div>
                          <div className="text-slate-500 dark:text-slate-400 mt-1 break-all">
                            {t.safekeep_url || '-'}
                            {t.safekeep_subpath ? ` · 路径 ${t.safekeep_subpath}` : ''}
                            {t.safekeep_targets ? ` · 上游 ${t.safekeep_targets}` : ''}
                            {` · ${t.safekeep_mode === 'async' ? 'async' : 'sync'}`}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <Button size="sm" onClick={() => void testTarget(t)}>测试</Button>
                          <Button
                            size="sm"
                            onClick={() =>
                              void apiGet(`/api/v1/backup/targets/${t.id}/snapshots`)
                                .then((r) => setTargetSnaps({ targetId: t.id, items: r.snapshots || [] }))
                                .catch((ex) => toast.error(ex.message))
                            }
                          >
                            异地快照
                          </Button>
                          <Button size="sm" onClick={() => { setTForm({ ...emptySafeKeepTarget, ...t, safekeep_api_key: '' }); setShowTargetModal(true); }}>编辑</Button>
                          <Button size="sm" variant="danger" onClick={() => void removeTarget(t)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {testResult && (
                <div className="rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200/70 dark:border-slate-800 p-3.5">
                  目标测试结果：<b>{testResult.ok ? '成功' : '失败'}</b>（{testResult.target}，耗时 {testResult.latency_ms} ms）
                  {testResult.error && <div className="text-rose-600 mt-1">{testResult.error}</div>}
                </div>
              )}
            </div>
          </Card>

          {targetSnaps && (
            <Card title="目标上的异地 Raft 快照" actions={<Button size="sm" onClick={() => setTargetSnaps(null)}>关闭</Button>}>
              {targetSnaps.items.length === 0 ? (
                <EmptyState title="暂无异地快照归档" description="该存储目标尚未保存集群 Raft 快照。" />
              ) : (
                <div className="space-y-2 text-xs">
                  {targetSnaps.items.map((item) => (
                    <div key={item.object} className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                      <div className="min-w-0">
                        <div className="font-mono break-all">{item.object}</div>
                        <div className="text-slate-500 mt-0.5">{fmtBytes(item.size_bytes)} · {fmtTime(item.mod_time)}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() =>
                          setImportSnapForm({
                            targetId: targetSnaps.targetId,
                            object: item.object,
                            clusterId: clusters[0]?.id || '',
                            passphrase: '',
                          })
                        }
                      >
                        登记到集群
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          <Card title="灾备与异地快照记录">
            {runs.length === 0 ? (
              <EmptyState title="暂无备份记录" description="手动或定时触发灾备后将在此显示执行历史。" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                      <th className="py-2.5 pr-3">类型</th>
                      <th className="py-2.5 pr-3">文件名</th>
                      <th className="py-2.5 pr-3">大小 / 触发</th>
                      <th className="py-2.5 pr-3">状态</th>
                      <th className="py-2.5 pr-3">时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {runs.map((r) => (
                      <tr key={r.id}>
                        <td className="py-2.5 pr-3">{r.kind}{r.cluster_name ? ` (${r.cluster_name})` : ''}</td>
                        <td className="py-2.5 pr-3 font-mono">{r.object_name}</td>
                        <td className="py-2.5 pr-3">{fmtBytes(r.size_bytes)} · {r.trigger_type}</td>
                        <td className="py-2.5 pr-3">
                          <StatusBadge value={r.status} />
                        </td>
                        <td className="py-2.5 pr-3">{fmtTime(r.started_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'migration' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-indigo-100 dark:border-indigo-500/30 bg-indigo-50/60 dark:bg-indigo-500/10 p-4 text-xs text-indigo-800 dark:text-indigo-200">
            <span className="font-semibold">迁移流程：</span>
            <span>1. 导出加密迁移包（.ndbundle）</span>
            <span aria-hidden="true">→</span>
            <span>2. 在新控制面上传并 Dry-Run 预检</span>
            <span aria-hidden="true">→</span>
            <span>3. 确认还原并激活控制面</span>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card title={<span className="flex items-center gap-2"><Download className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />导出加密迁移包（.ndbundle）</span>}>
              <div className="space-y-4 text-xs">
                <p className="text-slate-500 dark:text-slate-400 leading-relaxed">
                  核心配置表默认全选，敏感字段解密后使用临时迁移口令经 Argon2id + AES-256-GCM 封装。
                </p>
                <div className="space-y-2">
                  {optionalTables.map((t) => (
                    <label key={t.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={expInclude.includes(t.id)}
                        onChange={(e) =>
                          setExpInclude((prev) =>
                            e.target.checked ? [...prev, t.id] : prev.filter((x) => x !== t.id),
                          )
                        }
                      />
                      <span>{t.label}</span>
                    </label>
                  ))}
                </div>
                <SecretInput label="临时迁移口令（至少 12 位）" value={expPass} onChangeValue={setExpPass} />
                <Button
                  variant="primary"
                  onClick={() =>
                    setPwAction({
                      title: '验证当前密码并导出迁移包',
                      run: async (pw) => {
                        await apiDownload(
                          '/api/v1/migration/export',
                          {
                            current_password: pw,
                            passphrase: expPass,
                            include: expInclude,
                          },
                          'nomad-deck.ndbundle',
                        );
                        toast.success('迁移包已导出并开始下载');
                      },
                    })
                  }
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>导出 .ndbundle</span>
                </Button>
              </div>
            </Card>

            <Card
              title={<span className="flex items-center gap-2"><Upload className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />导入预检与控制面激活</span>}
              actions={
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() =>
                    setPwAction({
                      title: '激活控制面自动调度与解封',
                      description: '请确认旧控制面已下线，避免双活冲突。',
                      run: async (pw) => {
                        await apiPost('/api/v1/migration/activate', { current_password: pw });
                        toast.success('控制面已激活，定时任务与自动解封已恢复');
                      },
                    })
                  }
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span>激活控制面</span>
                </Button>
              }
            >
              <form onSubmit={doPreview} className="space-y-4 text-xs">
                <Select label="还原策略" value={impStrategy} onChange={(e) => setImpStrategy(e.target.value as any)}>
                  <option value="replace">replace（整库灾难恢复，推荐）</option>
                  <option value="merge">merge（增量合并）</option>
                </Select>
                <SecretInput label="迁移/备份口令" required value={impPass} onChangeValue={setImpPass} />
                <label className="block space-y-1.5">
                  <span className="block font-medium text-slate-700 dark:text-slate-300">选择 .ndbundle 文件</span>
                  <input
                    type="file"
                    required
                    accept=".ndbundle"
                    onChange={(e) => {
                      setImpFile(e.target.files?.[0] || null);
                      setPreviewRep(null);
                    }}
                    className="block w-full text-xs"
                  />
                </label>
                <Button type="submit" variant="primary" disabled={previewBusy || !impFile}>
                  <Upload className="h-3.5 w-3.5" />
                  <span>{previewBusy ? '正在解析预检...' : '上传并 Dry-Run 预检'}</span>
                </Button>
              </form>

              {previewRep && (
                <div className="mt-4 space-y-3 border-t border-slate-200 pt-4 text-xs dark:border-slate-800">
                  <div className="font-semibold text-slate-900 dark:text-slate-100">
                    预检报告（SHA256: <code className="font-mono">{previewRep.bundle_sha256?.slice(0, 12)}…</code>）
                  </div>
                  <div className="text-slate-600 dark:text-slate-300">
                    导入后可登录账号：
                    {(previewRep.login_accounts || []).map((a: any) => `${a.username}(${a.role})`).join('、')}
                  </div>
                  <pre className="max-h-48 overflow-auto rounded-xl bg-slate-950 p-3 font-mono text-slate-100">
                    {JSON.stringify(previewRep.tables, null, 2)}
                  </pre>
                  <Button
                    variant="danger"
                    onClick={() =>
                      setPwAction({
                        title: `确认执行 ${previewRep.strategy} 还原`,
                        description: '还原后现有会话将全部失效，需重新登录并激活控制面。',
                        run: async (pw) => {
                          await apiPost('/api/v1/migration/import/apply', {
                            preview_token: previewRep.preview_token,
                            current_password: pw,
                          });
                          window.location.reload();
                        },
                      })
                    }
                  >
                    执行还原
                  </Button>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* SafeKeep backup target edit modal */}
      <Modal open={showTargetModal} title="配置 SafeKeep 灾备目标" onClose={() => setShowTargetModal(false)}>
        <form onSubmit={saveTargetForm} className="space-y-3 text-xs">
          <Input label="目标名称" required placeholder="SafeKeep-DR" value={tForm.name} onChange={(e) => setTForm({ ...tForm, name: e.target.value })} />
          <Input
            label={<TermLabel term="SafeKeep 服务地址" tip="SafeKeep Client API 根地址，例如 https://safekeep.example.com:8080，将调用 /api/v1/backups 与 /api/v1/upstreams。" />}
            required
            placeholder="https://safekeep.example.com:8080"
            value={tForm.safekeep_url || ''}
            onChange={(e) => setTForm({ ...tForm, safekeep_url: e.target.value })}
          />
          <SecretInput
            label="SafeKeep X-API-Key"
            value={tForm.safekeep_api_key || ''}
            hasStoredValue={Boolean(tForm.safekeep_api_key_set)}
            resetKey={tForm.id}
            onChangeValue={(v) => setTForm({ ...tForm, safekeep_api_key: v })}
            onRevealStored={
              tForm.id && tForm.safekeep_api_key_set
                ? async () => {
                    const r = await apiPost('/api/v1/backup/secrets/reveal', { kind: 'target_secret', target_id: tForm.id });
                    return r.secret || '';
                  }
                : undefined
            }
          />
          <div className="grid grid-cols-2 gap-2">
            <Input
              label="远端子路径 (X-Backup-Path)"
              placeholder="nomad-deck"
              value={tForm.safekeep_subpath || ''}
              onChange={(e) => setTForm({ ...tForm, safekeep_subpath: e.target.value })}
            />
            <Input
              label="上游存储目标 (X-Backup-Targets，逗号分隔，留空默认)"
              placeholder="local,s3-dr"
              value={tForm.safekeep_targets || ''}
              onChange={(e) => setTForm({ ...tForm, safekeep_targets: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 items-center">
            <Select
              label="上传模式 (X-Backup-Mode)"
              value={tForm.safekeep_mode || 'sync'}
              onChange={(e) => setTForm({ ...tForm, safekeep_mode: e.target.value })}
            >
              <option value="sync">sync（等待 SafeKeep 落盘完成）</option>
              <option value="async">async（异步入队）</option>
            </Select>
            <label className="flex items-center gap-1.5 pt-4">
              <input
                type="checkbox"
                checked={Boolean(tForm.safekeep_insecure_tls)}
                onChange={(e) => setTForm({ ...tForm, safekeep_insecure_tls: e.target.checked })}
              />
              <span>跳过 TLS 证书校验（自签环境）</span>
            </label>
          </div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={tForm.enabled} onChange={(e) => setTForm({ ...tForm, enabled: e.target.checked })} /> 启用该目标</label>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => setShowTargetModal(false)}>取消</Button>
            <Button type="submit" variant="primary">确定</Button>
          </div>
        </form>
      </Modal>

      {/* Import offsite snapshot modal */}
      <Modal
        open={Boolean(importSnapForm.object)}
        title="从异地备份目标登记快照"
        onClose={() => setImportSnapForm({ targetId: '', object: '', clusterId: '', passphrase: '' })}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void apiPost('/api/v1/backup/snapshots/import', {
              target_id: importSnapForm.targetId,
              object: importSnapForm.object,
              cluster_id: importSnapForm.clusterId,
              passphrase: importSnapForm.passphrase,
            })
              .then(() => {
                setImportSnapForm({ targetId: '', object: '', clusterId: '', passphrase: '' });
                toast.success('快照已登记到集群，可前往对应集群快照页恢复');
              })
              .catch((ex) => toast.error(ex.message));
          }}
          className="space-y-3 text-xs"
        >
          <Select label="目标集群" value={importSnapForm.clusterId} onChange={(e) => setImportSnapForm({ ...importSnapForm, clusterId: e.target.value })}>
            {clusters.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.type})</option>)}
          </Select>
          <SecretInput
            label="归档口令（留空使用当前配置的备份口令）"
            value={importSnapForm.passphrase}
            onChangeValue={(v) => setImportSnapForm({ ...importSnapForm, passphrase: v })}
          />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setImportSnapForm({ targetId: '', object: '', clusterId: '', passphrase: '' })}>取消</Button>
            <Button type="submit" variant="primary">登记快照</Button>
          </div>
        </form>
      </Modal>

      <PasswordConfirmModal
        open={Boolean(pwAction)}
        title={pwAction?.title || ''}
        description={pwAction?.description}
        onClose={() => setPwAction(null)}
        onConfirm={async (pw) => {
          if (pwAction) await pwAction.run(pw);
        }}
      />
    </div>
  );
}
