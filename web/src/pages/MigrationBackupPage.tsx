import React, { useCallback, useEffect, useState } from 'react';
import { Download, Plus, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { apiDownload, apiGet, apiPost, apiPut, apiUpload, fmtBytes, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, EmptyState, ErrorAlert, Input, Modal, PasswordConfirmModal, SectionTabs, Select, statusTone } from '../components/UI';

const optionalTables = [
  { id: 'admins', label: 'admins（管理员账号，迁移可选）' },
  { id: 'job_revisions', label: 'job_revisions（Job 修订历史）' },
  { id: 'audit_logs', label: 'audit_logs（审计日志）' },
  { id: 'operation_tasks', label: 'operation_tasks（运维任务与步骤日志）' },
  { id: 'cron_job_runs', label: 'cron_job_runs（定时任务历史）' },
];

export function MigrationBackupPage() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState('backup');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  // Migration export/import state
  const [expPass, setExpPass] = useState('');
  const [expInclude, setExpInclude] = useState<string[]>(['admins']);
  const [impPass, setImpPass] = useState('');
  const [impStrategy, setImpStrategy] = useState<'replace' | 'merge'>('replace');
  const [impFile, setImpFile] = useState<File | null>(null);
  const [previewRep, setPreviewRep] = useState<any>(null);

  // Backup state
  const [backupCfg, setBackupCfg] = useState<any>(null);
  const [bkEnabled, setBkEnabled] = useState(false);
  const [bkPass, setBkPass] = useState('');
  const [bkHistoryTables, setBkHistoryTables] = useState<string[]>([]);
  const [targets, setTargets] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [testResult, setTestResult] = useState<any>(null);
  const [sshKeys, setSSHKeys] = useState<any[]>([]);
  const [clusters, setClusters] = useState<any[]>([]);
  const [targetSnaps, setTargetSnaps] = useState<{ targetId: string; items: any[] } | null>(null);
  const [importSnapForm, setImportSnapForm] = useState({ targetId: '', object: '', clusterId: '', passphrase: '' });
  const [showTargetModal, setShowTargetModal] = useState(false);
  const [tForm, setTForm] = useState<any>({
    id: '',
    name: '',
    type: 'local',
    enabled: true,
    retention_count: 14,
    snapshot_retention_count: 7,
    path: '',
    host: '',
    port: 22,
    username: 'backup',
    ssh_key_id: '',
    host_key_fingerprint: '',
    remote_dir: '/var/backups/nomad-deck',
    endpoint: '',
    region: 'us-east-1',
    bucket: '',
    prefix: '',
    access_key_id: '',
    secret_access_key: '',
    use_ssl: true,
    path_style: false,
  });

  const [pwAction, setPwAction] = useState<{ title: string; description?: string; run: (pw: string) => Promise<void> } | null>(null);

  const loadBackup = useCallback(async () => {
    setErr('');
    try {
      const [cRes, hRes, kRes, clRes] = await Promise.all([
        apiGet('/api/v1/backup/config'),
        apiGet('/api/v1/backup/history?limit=30'),
        apiGet('/api/v1/ssh-keys'),
        apiGet('/api/v1/clusters'),
      ]);
      const cfg = cRes.backup;
      setBackupCfg(cfg);
      setBkEnabled(Boolean(cfg.enabled));
      setBkHistoryTables(cfg.include_history || []);
      setTargets(cfg.targets || []);
      setRuns(hRes.runs || []);
      setSSHKeys(kRes.ssh_keys || []);
      setClusters(clRes.clusters || []);
    } catch (ex: any) {
      setErr(ex?.message || '加载灾备配置失败');
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void loadBackup();
  }, [isAdmin, loadBackup]);

  if (!isAdmin) {
    return <Card title="权限受限">迁移与灾备操作仅限 admin 角色。</Card>;
  }

  const doPreview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!impFile) return;
    setErr('');
    try {
      const res = await apiUpload('/api/v1/migration/import/preview', [
        ['passphrase', impPass],
        ['strategy', impStrategy],
      ], impFile);
      setPreviewRep(res.report);
    } catch (ex: any) {
      setErr(ex?.message || '迁移预检失败');
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
  };

  const buildTargetPayload = (t: any) => {
    const out: any = {
      id: t.id,
      name: t.name,
      type: t.type,
      enabled: Boolean(t.enabled),
      retention_count: Number(t.retention_count || 0),
      snapshot_retention_count: Number(t.snapshot_retention_count || 0),
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
    };
    if (t.type === 's3' && t.secret_access_key) {
      out.secret_access_key = t.secret_access_key;
    }
    return out;
  };

  const testTarget = async (t: any) => {
    setErr('');
    try {
      const res = await apiPost('/api/v1/backup/targets/test', buildTargetPayload(t));
      setTestResult(res.result);
    } catch (ex: any) {
      setErr(ex?.message || '测试失败');
    }
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
        setNotice('灾备配置已保存');
        await loadBackup();
      },
    });
  };

  return (
    <div className="space-y-4">
      <SectionTabs
        tabs={[
          { id: 'backup', label: '控制面定时灾备备份' },
          { id: 'migration', label: '环境迁移（.ndbundle）' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />
      {notice && (
        <div className="rounded-md bg-emerald-50 px-3.5 py-2 text-xs text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
          {notice}
        </div>
      )}

      {tab === 'backup' && (
        <div className="space-y-5">
          {backupCfg?.missing_offsite_target && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
              生产环境要求至少配置一个已启用的异地目标（SFTP 或 S3），否则控制面宿主机磁盘损坏将无法恢复。
            </div>
          )}

          <Card
            title="灾备策略与存储目标"
            actions={
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void loadBackup()}>
                  <RefreshCw className="h-3.5 w-3.5" /> 刷新
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    void apiPost('/api/v1/backup/run')
                      .then(() => {
                        setNotice('已执行控制面灾备备份并校验通过');
                        return loadBackup();
                      })
                      .catch((ex) => setErr(ex.message))
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
                <label className="flex items-center gap-2 font-medium">
                  <input type="checkbox" checked={bkEnabled} onChange={(e) => setBkEnabled(e.target.checked)} />
                  <span>启用定时灾备（control_plane_backup）与异地 Raft 快照同步</span>
                </label>
                <Input
                  label={backupCfg?.passphrase_set ? '备份口令（已设置，留空保持不变）' : '备份口令（至少 12 位）'}
                  type="password"
                  value={bkPass}
                  onChange={(e) => setBkPass(e.target.value)}
                />
              </div>

              <div>
                <div className="mb-1.5 font-medium">额外包含历史表（admins 固定包含）</div>
                <div className="flex flex-wrap gap-3">
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
                        <span>{t.id}</span>
                      </label>
                    ))}
                </div>
              </div>

              <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold">存储目标列表</span>
                  <Button
                    size="sm"
                    onClick={() => {
                      setTForm({
                        id: '',
                        name: '',
                        type: 'local',
                        enabled: true,
                        retention_count: 14,
                        snapshot_retention_count: 7,
                        path: '',
                        host: '',
                        port: 22,
                        username: 'backup',
                        ssh_key_id: sshKeys[0]?.id || '',
                        host_key_fingerprint: '',
                        remote_dir: '/var/backups/nomad-deck',
                        endpoint: '',
                        region: 'us-east-1',
                        bucket: '',
                        prefix: '',
                        access_key_id: '',
                        secret_access_key: '',
                        use_ssl: true,
                        path_style: false,
                      });
                      setShowTargetModal(true);
                    }}
                  >
                    <Plus className="h-3 w-3" /> 添加目标
                  </Button>
                </div>
                {targets.length === 0 ? (
                  <EmptyState text="尚未添加备份目标" />
                ) : (
                  <div className="space-y-2">
                    {targets.map((t) => (
                      <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2.5 dark:border-slate-800">
                        <div>
                          <div className="flex items-center gap-2 font-medium">
                            <span>{t.name}</span>
                            <Badge>{t.type}</Badge>
                            <Badge tone={t.enabled ? 'green' : 'neutral'}>{t.enabled ? '启用' : '停用'}</Badge>
                          </div>
                          <div className="text-slate-500">
                            灾备保留 {t.retention_count} 份 · 快照保留 {t.snapshot_retention_count} 份 ·{' '}
                            {t.type === 'local' ? t.path || '默认目录' : t.type === 'sftp' ? `${t.username}@${t.host}:${t.remote_dir}` : `s3://${t.bucket}/${t.prefix || ''}`}
                          </div>
                        </div>
                        <div className="flex gap-1">
                          <Button size="sm" onClick={() => void testTarget(t)}>测试</Button>
                          <Button
                            size="sm"
                            onClick={() =>
                              void apiGet(`/api/v1/backup/targets/${t.id}/snapshots`)
                                .then((r) => setTargetSnaps({ targetId: t.id, items: r.snapshots || [] }))
                                .catch((ex) => setErr(ex.message))
                            }
                          >
                            异地快照
                          </Button>
                          <Button size="sm" onClick={() => { setTForm(t); setShowTargetModal(true); }}>编辑</Button>
                          <Button size="sm" variant="danger" onClick={() => setTargets((prev) => prev.filter((x) => x.id !== t.id))}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {testResult && (
                <div className="rounded bg-slate-100 p-3 dark:bg-slate-950">
                  目标测试结果：<b>{testResult.ok ? '成功' : '失败'}</b>（{testResult.target}，耗时 {testResult.latency_ms} ms）
                  {testResult.error && <div className="text-rose-600">{testResult.error}</div>}
                </div>
              )}
            </div>
          </Card>

          {targetSnaps && (
            <Card title="目标上的异地 Raft 快照" actions={<Button size="sm" onClick={() => setTargetSnaps(null)}>关闭</Button>}>
              {targetSnaps.items.length === 0 ? (
                <EmptyState text="该目标暂无异地快照归档" />
              ) : (
                <div className="space-y-2 text-xs">
                  {targetSnaps.items.map((item) => (
                    <div key={item.object} className="flex items-center justify-between gap-2 rounded border border-slate-200 p-2 dark:border-slate-800">
                      <div>
                        <div className="font-mono">{item.object}</div>
                        <div className="text-slate-500">{fmtBytes(item.size_bytes)} · {fmtTime(item.mod_time)}</div>
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
              <EmptyState text="暂无备份记录" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                      <th className="py-2 pr-3">类型</th>
                      <th className="py-2 pr-3">文件名</th>
                      <th className="py-2 pr-3">大小 / 触发</th>
                      <th className="py-2 pr-3">状态</th>
                      <th className="py-2 pr-3">时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {runs.map((r) => (
                      <tr key={r.id}>
                        <td className="py-2 pr-3">{r.kind}{r.cluster_name ? ` (${r.cluster_name})` : ''}</td>
                        <td className="py-2 pr-3 font-mono">{r.object_name}</td>
                        <td className="py-2 pr-3">{fmtBytes(r.size_bytes)} · {r.trigger_type}</td>
                        <td className="py-2 pr-3">
                          <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                        </td>
                        <td className="py-2 pr-3">{fmtTime(r.started_at)}</td>
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
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card title="导出加密迁移包（.ndbundle）">
            <div className="space-y-3 text-xs">
              <p className="text-slate-500">核心配置表默认全选，敏感字段解密后使用临时迁移口令经 Argon2id + AES-256-GCM 封装。</p>
              <div className="space-y-1">
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
              <Input label="临时迁移口令（至少 12 位）" type="password" value={expPass} onChange={(e) => setExpPass(e.target.value)} />
              <Button
                variant="primary"
                onClick={() =>
                  setPwAction({
                    title: '验证当前密码并导出迁移包',
                    run: async (pw) => {
                      await apiDownload('/api/v1/migration/export', {
                        current_password: pw,
                        passphrase: expPass,
                        include: expInclude,
                      }, 'nomad-deck.ndbundle');
                    },
                  })
                }
              >
                <Download className="h-3.5 w-3.5" /> 导出 .ndbundle
              </Button>
            </div>
          </Card>

          <Card
            title="导入预检与控制面激活"
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
                      setNotice('控制面已激活，定时任务与自动解封已恢复。');
                    },
                  })
                }
              >
                <ShieldCheck className="h-3.5 w-3.5" /> 激活控制面
              </Button>
            }
          >
            <form onSubmit={doPreview} className="space-y-3 text-xs">
              <Select label="还原策略" value={impStrategy} onChange={(e) => setImpStrategy(e.target.value as any)}>
                <option value="replace">replace（整库灾难恢复，推荐）</option>
                <option value="merge">merge（增量合并）</option>
              </Select>
              <Input label="迁移/备份口令" type="password" required value={impPass} onChange={(e) => setImpPass(e.target.value)} />
              <label className="block space-y-1">
                <span className="block font-medium">选择 .ndbundle 文件</span>
                <input
                  type="file"
                  required
                  onChange={(e) => setImpFile(e.target.files?.[0] || null)}
                  className="block w-full text-xs"
                />
              </label>
              <Button type="submit" variant="primary">
                <Upload className="h-3.5 w-3.5" /> 上传并 Dry-Run 预检
              </Button>
            </form>

            {previewRep && (
              <div className="mt-4 space-y-3 border-t border-slate-200 pt-3 text-xs dark:border-slate-800">
                <div className="font-semibold">预检报告（SHA256: {previewRep.bundle_sha256?.slice(0, 12)}…）</div>
                <div>
                  导入后可登录账号：
                  {(previewRep.login_accounts || []).map((a: any) => `${a.username}(${a.role})`).join('、')}
                </div>
                <pre className="max-h-48 overflow-auto rounded bg-slate-950 p-2.5 font-mono text-slate-100">
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
      )}

      {/* Backup target edit modal */}
      <Modal open={showTargetModal} title="配置备份目标" onClose={() => setShowTargetModal(false)}>
        <form onSubmit={saveTargetForm} className="space-y-3 text-xs">
          <Input label="目标名称" required value={tForm.name} onChange={(e) => setTForm({ ...tForm, name: e.target.value })} />
          <Select label="类型" value={tForm.type} onChange={(e) => setTForm({ ...tForm, type: e.target.value })}>
            <option value="local">本机目录 (local)</option>
            <option value="sftp">SFTP</option>
            <option value="s3">S3 兼容对象存储</option>
          </Select>
          <div className="grid grid-cols-2 gap-2">
            <Input label="灾备包保留份数" type="number" value={tForm.retention_count} onChange={(e) => setTForm({ ...tForm, retention_count: Number(e.target.value) })} />
            <Input label="快照保留份数" type="number" value={tForm.snapshot_retention_count} onChange={(e) => setTForm({ ...tForm, snapshot_retention_count: Number(e.target.value) })} />
          </div>
          {tForm.type === 'local' && (
            <Input label="目录路径（留空使用默认目录）" value={tForm.path} onChange={(e) => setTForm({ ...tForm, path: e.target.value })} />
          )}
          {tForm.type === 'sftp' && (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2"><Input label="主机" required value={tForm.host} onChange={(e) => setTForm({ ...tForm, host: e.target.value })} /></div>
                <Input label="端口" type="number" value={tForm.port} onChange={(e) => setTForm({ ...tForm, port: Number(e.target.value) })} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input label="用户名" required value={tForm.username} onChange={(e) => setTForm({ ...tForm, username: e.target.value })} />
                <Select label="SSH 密钥" value={tForm.ssh_key_id} onChange={(e) => setTForm({ ...tForm, ssh_key_id: e.target.value })}>
                  {sshKeys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                </Select>
              </div>
              <Input label="远端目录" required value={tForm.remote_dir} onChange={(e) => setTForm({ ...tForm, remote_dir: e.target.value })} />
            </>
          )}
          {tForm.type === 's3' && (
            <>
              <Input label="Endpoint" required value={tForm.endpoint} onChange={(e) => setTForm({ ...tForm, endpoint: e.target.value })} />
              <div className="grid grid-cols-2 gap-2">
                <Input label="Bucket" required value={tForm.bucket} onChange={(e) => setTForm({ ...tForm, bucket: e.target.value })} />
                <Input label="Region" value={tForm.region} onChange={(e) => setTForm({ ...tForm, region: e.target.value })} />
              </div>
              <Input label="Prefix（可选）" value={tForm.prefix} onChange={(e) => setTForm({ ...tForm, prefix: e.target.value })} />
              <Input label="Access Key ID" required value={tForm.access_key_id} onChange={(e) => setTForm({ ...tForm, access_key_id: e.target.value })} />
              <Input label="Secret Access Key（留空保留原值）" type="password" value={tForm.secret_access_key} onChange={(e) => setTForm({ ...tForm, secret_access_key: e.target.value })} />
              <div className="flex gap-4">
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={tForm.use_ssl} onChange={(e) => setTForm({ ...tForm, use_ssl: e.target.checked })} /> HTTPS/TLS</label>
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={tForm.path_style} onChange={(e) => setTForm({ ...tForm, path_style: e.target.checked })} /> Path Style</label>
              </div>
            </>
          )}
          <label className="flex items-center gap-2"><input type="checkbox" checked={tForm.enabled} onChange={(e) => setTForm({ ...tForm, enabled: e.target.checked })} /> 启用该目标</label>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => setShowTargetModal(false)}>取消</Button>
            <Button type="submit" variant="primary">确定</Button>
          </div>
        </form>
      </Modal>

      {/* Import offsite snapshot modal */}
      <Modal open={Boolean(importSnapForm.object)} title="从异地备份目标登记快照" onClose={() => setImportSnapForm({ targetId: '', object: '', clusterId: '', passphrase: '' })}>
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
                setNotice('快照已登记到集群，可前往对应集群快照页恢复。');
              })
              .catch((ex) => setErr(ex.message));
          }}
          className="space-y-3 text-xs"
        >
          <Select label="目标集群" value={importSnapForm.clusterId} onChange={(e) => setImportSnapForm({ ...importSnapForm, clusterId: e.target.value })}>
            {clusters.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.type})</option>)}
          </Select>
          <Input
            label="归档口令（留空使用当前配置的备份口令）"
            type="password"
            value={importSnapForm.passphrase}
            onChange={(e) => setImportSnapForm({ ...importSnapForm, passphrase: e.target.value })}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setImportSnapForm({ targetId: '', object: '', clusterId: '', passphrase: '' })}>取消</Button>
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
