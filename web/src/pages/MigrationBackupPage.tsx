import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Download, RefreshCw, ShieldCheck, Upload } from 'lucide-react';
import { apiDownload, apiGet, apiPost, apiUpload, fmtBytes, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Modal,
  PageHeader,
  PasswordConfirmModal,
  SecretInput,
  SectionTabs,
  Select,
  StatusBadge,
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

  // Backup recovery & history state (SafeKeep target & schedule config live in CronPage)
  const [backupCfg, setBackupCfg] = useState<any>(null);
  const [targets, setTargets] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [testResult, setTestResult] = useState<any>(null);
  const [clusters, setClusters] = useState<any[]>([]);
  const [targetSnaps, setTargetSnaps] = useState<{ targetId: string; items: any[] } | null>(null);
  const [importSnapForm, setImportSnapForm] = useState({ targetId: '', object: '', clusterId: '', passphrase: '' });

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
      setTargets(cfg.targets || []);
      setRuns(hRes.runs || []);
      setClusters(clRes.clusters || []);
    } catch (ex: any) {
      setErr(ex?.message || '加载灾备信息失败');
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

  const testTarget = async (t: any) => {
    setErr('');
    try {
      const res = await apiPost('/api/v1/backup/targets/test', {
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
      });
      setTestResult(res.result);
      if (res.result?.ok) toast.success(`目标 ${t.name} 连通正常`);
      else toast.error(res.result?.error || `目标 ${t.name} 测试失败`);
    } catch (ex: any) {
      toast.error(ex?.message || '测试失败');
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="迁移与灾备"
        subtitle="加密迁移包（.ndbundle）导出与恢复、异地 Raft 快照登记及灾备执行记录"
        actions={
          <Button onClick={() => void loadBackup()}>
            <RefreshCw className="h-4 w-4" />
            <span>刷新</span>
          </Button>
        }
      />

      <SectionTabs
        tabs={[
          { id: 'backup', label: '异地快照与灾备记录', badge: targets.length },
          { id: 'migration', label: '环境迁移（.ndbundle）' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {tab === 'backup' && (
        <div className="space-y-5">
          {backupCfg?.missing_offsite_target && targets.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              <span>当前已添加的 SafeKeep 目标均处于停用状态，生产环境建议在定时任务中启用灾备目标。</span>
              <Link to="/cron" className="inline-flex items-center gap-1 font-medium underline">
                前往定时任务启用 <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          )}

          <Card
            title="SafeKeep 灾备目标与异地快照"
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {targets.length > 0 && (
                  <Link
                    to="/cron"
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <span>在定时任务中管理 SafeKeep</span>
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  disabled={targets.length === 0}
                  title={targets.length === 0 ? '请先在「定时任务 → 配置 SafeKeep」中添加存储目标' : '立即触发一次控制面灾备备份'}
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
              </div>
            }
          >
            <div className="space-y-4 text-xs">
              <div className="flex flex-wrap items-center gap-3 text-slate-600 dark:text-slate-300">
                <span>
                  定时灾备状态：
                  <b className="ml-1 text-slate-900 dark:text-slate-100">{backupCfg?.enabled ? '已启用' : '未启用'}</b>
                </span>
                <span>·</span>
                <span>
                  备份加密口令：
                  <b className="ml-1 text-slate-900 dark:text-slate-100">{backupCfg?.passphrase_set ? '已设置' : '未设置'}</b>
                </span>
                <span className="text-slate-400">（定时策略、口令与网关参数在「定时任务」中统一配置）</span>
              </div>

              {targets.length === 0 ? (
                <EmptyState
                  title="尚未添加 SafeKeep 灾备目标"
                  description="请前往「定时任务 → 配置 SafeKeep」添加存储目标并启用控制面灾备。"
                  action={
                    <Link to="/cron" className="primary-button">
                      前往定时任务配置
                    </Link>
                  }
                />
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
                        <Button size="sm" onClick={() => void testTarget(t)}>测试连通性</Button>
                        <Button
                          size="sm"
                          onClick={() =>
                            void apiGet(`/api/v1/backup/targets/${t.id}/snapshots`)
                              .then((r) => setTargetSnaps({ targetId: t.id, items: r.snapshots || [] }))
                              .catch((ex) => toast.error(ex.message))
                          }
                        >
                          查看异地快照
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

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
