import React, { useState } from 'react';
import { Download, ShieldCheck, Upload } from 'lucide-react';
import { apiDownload, apiPost, apiUpload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import {
  Button,
  Card,
  ErrorAlert,
  PageHeader,
  PasswordConfirmModal,
  SecretInput,
  Select,
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

  const [err, setErr] = useState('');

  // Migration export/import state
  const [expPass, setExpPass] = useState('');
  const [expInclude, setExpInclude] = useState<string[]>(['admins']);
  const [impPass, setImpPass] = useState('');
  const [impStrategy, setImpStrategy] = useState<'replace' | 'merge'>('replace');
  const [impFile, setImpFile] = useState<File | null>(null);
  const [previewRep, setPreviewRep] = useState<any>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const [pwAction, setPwAction] = useState<{ title: string; description?: string; run: (pw: string) => Promise<void> } | null>(null);

  if (!isAdmin) {
    return (
      <div className="space-y-5">
        <PageHeader title="环境迁移" subtitle="控制面数据打包导出（.ndbundle）、预检导入与控制面激活" />
        <Card title="权限受限">环境迁移操作仅限 admin 角色。</Card>
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

  return (
    <div className="space-y-5">
      <PageHeader
        title="环境迁移"
        subtitle="控制面数据打包导出（.ndbundle）、Dry-Run 预检导入与控制面激活"
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-indigo-100 dark:border-indigo-500/30 bg-indigo-50/60 dark:bg-indigo-500/10 p-4 text-xs text-indigo-800 dark:text-indigo-200">
          <span className="font-semibold">迁移流程：</span>
          <span>1. 导出迁移包（.ndbundle）</span>
          <span aria-hidden="true">→</span>
          <span>2. 在新控制面上传并 Dry-Run 预检</span>
          <span aria-hidden="true">→</span>
          <span>3. 确认还原并激活控制面</span>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card title={<span className="flex items-center gap-2"><Download className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />导出迁移包（.ndbundle）</span>}>
            <div className="space-y-4 text-xs">
              <p className="text-slate-500 dark:text-slate-400 leading-relaxed">
                核心配置表默认全选；如填写临时迁移口令（至少 6 位），敏感字段解密后将使用 Argon2id + AES-256-GCM 加密封装，留空则不加密。
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
              <SecretInput
                label="临时迁移口令（可选，填写则至少 6 位）"
                value={expPass}
                onChangeValue={setExpPass}
              />
              <Button
                variant="primary"
                onClick={() => {
                  if (expPass && expPass.length < 6) {
                    toast.error('迁移口令至少 6 位（或留空不加密）');
                    return;
                  }
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
                  });
                }}
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
              <SecretInput label="迁移/备份口令（未加密包可留空）" value={impPass} onChangeValue={setImpPass} />
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
