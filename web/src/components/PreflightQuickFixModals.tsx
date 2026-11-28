import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Dices, Eye, EyeOff, KeyRound, Loader2, Plus, ShieldCheck, Terminal, Trash2 } from 'lucide-react';
import { apiGet, apiPost, apiPut, openSSE } from '../lib/api';
import { isTaskActiveStatus, isTaskFailureStatus } from '../lib/actionLabels';
import { useI18n } from '../lib/i18n';
import type { BlueprintSecretFieldHint } from '../lib/jobBlueprints';
import { useOpsDrawer } from '../lib/opsDrawer';
import { useToast } from './Toast';
import { Badge, Button, ErrorAlert, Input, Modal } from './UI';

export interface PreflightFixAction {
  type: 'vault_role' | 'vault_kv' | 'link';
  label?: string;
  label_en?: string;
  path?: string;
  // vault_role
  integration_id?: string;
  integration_name?: string;
  role_id?: string;
  role_name?: string;
  policy_name?: string;
  token_period?: string;
  namespace?: string;
  policy_mode?: string;
  secret_paths?: string[];
  custom_policy_hcl?: string;
  needs_apply_only?: boolean;
  // vault_kv
  vault_cluster_id?: string;
  vault_cluster?: string;
  mount?: string;
  secret_path?: string;
  required_keys?: string[];
  optional_keys?: string[];
  existing_keys?: string[];
  missing_keys?: string[];
}

export interface PreflightCheck {
  id: string;
  kind: string;
  status: 'ok' | 'error' | 'warning';
  title: string;
  title_en?: string;
  detail: string;
  detail_en?: string;
  fix_action?: PreflightFixAction;
}

const PASSWORD_KEY_RE = /(pass|secret|token|key)/i;

function generateStrongSecret(length = 24): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export function VaultRoleQuickFixModal({
  open,
  action,
  clusterMode,
  onClose,
  onFixed,
}: {
  open: boolean;
  action: PreflightFixAction | null;
  clusterMode?: string;
  onClose: () => void;
  onFixed: () => Promise<void> | void;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const { openTask } = useOpsDrawer();

  const [roleName, setRoleName] = useState('');
  const [namespace, setNamespace] = useState('default');
  const [secretPathsText, setSecretPathsText] = useState('');
  const [customPolicy, setCustomPolicy] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [applyImmediately, setApplyImmediately] = useState(true);

  const [needsSingleConfirm, setNeedsSingleConfirm] = useState(false);
  const [confirmSingle, setConfirmSingle] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [taskStatus, setTaskStatus] = useState('');
  const [stepText, setStepText] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open || !action) return;
    setRoleName(action.role_name || '');
    setNamespace(action.namespace || 'default');
    setSecretPathsText((action.secret_paths || []).join(', '));
    setCustomPolicy(action.custom_policy_hcl || '');
    setShowAdvanced(Boolean(action.custom_policy_hcl));
    setApplyImmediately(true);
    setNeedsSingleConfirm(false);
    setConfirmSingle(false);
    setSubmitting(false);
    setTaskId('');
    setTaskStatus('');
    setStepText('');
    setErr('');
  }, [open, action]);

  useEffect(() => {
    if (!open || !taskId) return;
    let active = true;

    const finalize = async (status: string, errMsg?: string) => {
      if (!active) return;
      setTaskStatus(status);
      if (isTaskFailureStatus(status)) {
        setErr(
          errMsg ||
            tr(
              '应用联动任务失败，可点击右侧按钮打开任务日志查看详情',
              'Failed to apply integration; open task logs for details',
            ),
        );
        return;
      }
      await Promise.resolve(onFixed());
      if (!active) return;
      toast.success(
        action?.needs_apply_only
          ? tr(`联动「${action.integration_name || ''}」已应用生效`, `Integration "${action.integration_name || ''}" applied`)
          : tr(`Vault Role「${roleName}」已创建并生效`, `Vault Role "${roleName}" saved and active`),
      );
      onClose();
    };

    const stop = openSSE(`/api/v1/operations/${taskId}/stream`, {
      onEvent: (ev, data) => {
        if (!active) return;
        if (ev === 'step' && data?.name) {
          setStepText(data.name);
        } else if (ev === 'done' && data) {
          stop();
          void finalize(data.status || 'succeeded', data.error);
        }
      },
    });

    const timer = window.setInterval(() => {
      void apiGet<{ operation?: { status?: string; error_message?: string } }>(`/api/v1/operations/${taskId}`)
        .then((res) => {
          const st = res.operation?.status || '';
          if (st && !isTaskActiveStatus(st)) {
            window.clearInterval(timer);
            stop();
            void finalize(st, res.operation?.error_message);
          }
        })
        .catch(() => {});
    }, 2500);

    return () => {
      active = false;
      window.clearInterval(timer);
      stop();
    };
  }, [open, taskId, roleName, action?.needs_apply_only, action?.integration_name]);

  const running = Boolean(taskId) && (!taskStatus || isTaskActiveStatus(taskStatus));
  const busy = submitting || running;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!action?.integration_id || busy) return;
    setErr('');

    const applyOnly = Boolean(action.needs_apply_only);
    const paths = secretPathsText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (!applyOnly) {
      if (!roleName.trim()) {
        setErr(tr('请填写 Vault Role 名称', 'Please enter a Vault Role name'));
        return;
      }
      if (paths.length === 0 && !customPolicy.trim()) {
        setErr(tr('请至少填写一条授权 Secret 路径或自定义 Policy HCL', 'Provide at least one secret path or custom Policy HCL'));
        return;
      }
    }

    setSubmitting(true);
    try {
      if (!applyOnly) {
        const payload: Record<string, any> = {
          role_name: roleName.trim(),
          policy_mode: action.policy_mode || 'explicit',
          secret_paths: paths,
          custom_policy_hcl: customPolicy.trim(),
          bound_claims: { nomad_namespace: namespace.trim() || 'default' },
        };
        if (action.policy_name) payload.policy_name = action.policy_name;
        if (action.token_period) payload.token_period = action.token_period;

        if (action.role_id) {
          await apiPut(`/api/v1/integrations/${action.integration_id}/roles/${action.role_id}`, payload);
        } else {
          await apiPost(`/api/v1/integrations/${action.integration_id}/roles`, payload);
        }
      }

      if (!applyOnly && !applyImmediately) {
        await Promise.resolve(onFixed());
        toast.success(tr(`Vault Role「${roleName.trim()}」已保存为草稿`, `Vault Role "${roleName.trim()}" saved as draft`));
        onClose();
        return;
      }

      const preview = await apiPost<{ plan?: { errors?: string[]; scope?: string } }>(
        `/api/v1/integrations/${action.integration_id}/plan`,
        {},
      );
      if (preview.plan?.errors?.length) {
        throw new Error(preview.plan.errors.join('\n'));
      }
      const requiresSingleConfirm = clusterMode === 'single' && preview.plan?.scope === 'vault_and_nomad';
      if (requiresSingleConfirm && !confirmSingle) {
        setNeedsSingleConfirm(true);
        setErr(
          tr(
            '应用此联动将重启单节点 Nomad Server 并造成短暂中断，请先勾选下方确认框后再继续。',
            'Applying this integration restarts the single-node Nomad Server briefly. Check the confirmation box below to continue.',
          ),
        );
        return;
      }

      const res = await apiPost<{ task?: { id?: string } }>(`/api/v1/integrations/${action.integration_id}/apply`, {
        confirm_single_node: requiresSingleConfirm && confirmSingle,
      });
      if (res.task?.id) {
        setTaskId(res.task.id);
        setTaskStatus('running');
        openTask(
          res.task.id,
          tr(`应用联动：${action.integration_name || action.role_name || ''}`, `Apply Integration: ${action.integration_name || action.role_name || ''}`),
        );
      } else {
        await Promise.resolve(onFixed());
        toast.success(tr('联动已应用生效', 'Integration applied'));
        onClose();
      }
    } catch (ex: any) {
      setErr(ex?.message || tr('操作失败', 'Operation failed'));
    } finally {
      setSubmitting(false);
    }
  };

  const title = action?.needs_apply_only
    ? tr('应用 Nomad-Vault 联动', 'Apply Nomad-Vault Integration')
    : action?.role_id
      ? tr(`一键修复 Vault Role · ${action.role_name || ''}`, `Fix Vault Role · ${action.role_name || ''}`)
      : tr(`一键创建 Vault Role · ${action?.role_name || ''}`, `Create Vault Role · ${action?.role_name || ''}`);

  return (
    <Modal open={open} title={title} onClose={running ? () => {} : onClose} wide>
      {!action ? null : (
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 text-xs">
          <ErrorAlert message={err} onClose={() => setErr('')} />

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-900/50">
            <ShieldCheck className="h-4 w-4 text-indigo-500 shrink-0" />
            <span className="text-slate-600 dark:text-slate-300">
              {tr('目标联动：', 'Target Integration: ')}
              <strong className="font-semibold text-slate-900 dark:text-slate-100">
                {action.integration_name || action.integration_id}
              </strong>
            </span>
            {action.role_id && !action.needs_apply_only && (
              <Badge tone="amber">{tr('将更新已有 Role', 'Updating existing Role')}</Badge>
            )}
          </div>

          {action.needs_apply_only ? (
            <p className="leading-5 text-slate-600 dark:text-slate-300">
              {tr(
                '即将对联动配置执行 Plan 并下发应用，使草稿 Role 或最新 CA 配置生效。仅更新 Vault Role 时不会重启 Nomad Server。',
                'This will plan and apply the integration so pending roles or updated CA certificates become active. Vault-only role updates do not restart Nomad Server.',
              )}
            </p>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label={tr('Vault Role 名称', 'Vault Role Name')}
                  value={roleName}
                  disabled={Boolean(action.role_id) || busy}
                  onChange={(e) => setRoleName(e.target.value)}
                  placeholder="postgres"
                />
                <Input
                  label={tr('允许 Nomad Namespace', 'Allowed Nomad Namespace')}
                  value={namespace}
                  disabled={busy}
                  onChange={(e) => setNamespace(e.target.value)}
                  placeholder="default"
                />
              </div>

              <Input
                label={tr('授权 KV 逻辑路径（逗号分隔，不含 /data/）', 'Authorized KV Logical Paths (comma-separated, without /data/)')}
                value={secretPathsText}
                disabled={busy}
                onChange={(e) => setSecretPathsText(e.target.value)}
                placeholder="secret/apps/postgres"
                hint={tr(
                  '已根据当前模板自动推导所需路径；精确路径不含子路径，如需目录通配可用 /*。',
                  'Automatically inferred from the current template; exact paths do not include subpaths (use /* for wildcards).',
                )}
              />

              <div className="rounded-xl border border-slate-200/80 bg-slate-50/50 p-3 dark:border-slate-800 dark:bg-slate-950/40">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="flex w-full items-center justify-between text-left font-medium text-slate-700 dark:text-slate-200"
                >
                  <span>
                    {tr('自定义 Vault Policy HCL（写权限或细粒度策略）', 'Custom Vault Policy HCL (write permissions or fine-grained rules)')}
                  </span>
                  <span className="text-[11px] text-indigo-600 dark:text-indigo-400">
                    {showAdvanced ? tr('收起', 'Hide') : customPolicy.trim() ? tr('已填入 · 展开查看', 'Pre-filled · Expand') : tr('展开选填', 'Expand optional')}
                  </span>
                </button>
                {showAdvanced && (
                  <div className="mt-2.5 space-y-1.5">
                    <textarea
                      rows={6}
                      value={customPolicy}
                      disabled={busy}
                      onChange={(e) => setCustomPolicy(e.target.value)}
                      placeholder={'path "secret/data/..." {\n  capabilities = ["read"]\n}'}
                      className="w-full rounded-lg border border-slate-200 bg-white p-2.5 font-mono text-[11px] text-slate-900 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    />
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      {tr(
                        '留空则按上方路径自动生成只读 Policy；填入后将以该 HCL 覆盖默认策略。',
                        'Leave blank to auto-generate a read-only policy from the paths above; non-empty HCL overrides the default policy.',
                      )}
                    </p>
                  </div>
                )}
              </div>

              <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={applyImmediately}
                  disabled={busy}
                  onChange={(e) => setApplyImmediately(e.target.checked)}
                />
                <span>
                  {tr(
                    '保存后立即应用联动（仅新增/修改 Role 时只更新 Vault，不重启 Nomad）',
                    'Apply integration immediately after saving (role-only updates touch Vault only without restarting Nomad)',
                  )}
                </span>
              </label>
            </div>
          )}

          {needsSingleConfirm && (
            <label className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-950 cursor-pointer dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={confirmSingle}
                disabled={busy}
                onChange={(e) => setConfirmSingle(e.target.checked)}
              />
              <span className="leading-5">
                {tr(
                  '我了解当前为单节点 Nomad 集群，应用联动会重启 Nomad Server 并造成短暂服务中断。',
                  'I understand this is a single-node Nomad cluster and applying the integration will briefly restart Nomad Server.',
                )}
              </span>
            </label>
          )}

          {taskId && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50/70 px-3.5 py-2.5 dark:border-indigo-500/30 dark:bg-indigo-950/30">
              <div className="flex items-center gap-2 text-indigo-900 dark:text-indigo-200">
                {running ? (
                  <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                )}
                <span>
                  {running
                    ? stepText || tr('正在应用联动配置，请稍候…', 'Applying integration configuration...')
                    : tr('联动应用已完成', 'Integration apply completed')}
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => openTask(taskId, tr(`应用联动：${action.integration_name || ''}`, `Apply Integration: ${action.integration_name || ''}`))}
              >
                <Terminal className="h-3.5 w-3.5" />
                <span>{tr('查看任务日志', 'Task Logs')}</span>
              </Button>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" disabled={running} onClick={onClose}>
              {tr('取消', 'Cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>
                {action.needs_apply_only
                  ? tr('立即应用联动', 'Apply Integration')
                  : applyImmediately
                    ? tr('保存并应用联动', 'Save & Apply')
                    : tr('仅保存草稿', 'Save Draft')}
              </span>
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

interface ExtraKVRow {
  id: string;
  key: string;
  value: string;
}

export function VaultKVQuickFixModal({
  open,
  action,
  secretHints,
  onClose,
  onFixed,
}: {
  open: boolean;
  action: PreflightFixAction | null;
  secretHints?: Record<string, BlueprintSecretFieldHint>;
  onClose: () => void;
  onFixed: () => Promise<void> | void;
}) {
  const { locale, tr } = useI18n();
  const toast = useToast();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [cas, setCas] = useState(0);
  const [existingData, setExistingData] = useState<Record<string, any>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [extraRows, setExtraRows] = useState<ExtraKVRow[]>([]);
  const [showOptional, setShowOptional] = useState(false);

  const requiredKeys = useMemo(() => action?.required_keys || [], [action]);
  const optionalKeys = useMemo(() => action?.optional_keys || [], [action]);
  const missingSet = useMemo(() => new Set(action?.missing_keys || []), [action]);

  const isSecretField = (key: string) => Boolean(secretHints?.[key]?.secret) || PASSWORD_KEY_RE.test(key);

  useEffect(() => {
    if (!open || !action?.vault_cluster_id || !action.mount || !action.secret_path) return;
    let active = true;
    setLoading(true);
    setSaving(false);
    setErr('');
    setCas(0);
    setExistingData({});
    setRevealed({});
    setExtraRows([]);

    const initValues: Record<string, string> = {};
    for (const k of [...(action.required_keys || []), ...(action.optional_keys || [])]) {
      const def = secretHints?.[k]?.defaultValue;
      initValues[k] = def ?? '';
    }
    setValues(initValues);
    const hasDnsAuthOptional = (action.optional_keys || []).some((k) => k === 'ali_key' || k === 'ali_secret');
    setShowOptional((action.required_keys || []).length === 0 || hasDnsAuthOptional);

    const mountQ = encodeURIComponent(action.mount);
    const pathQ = encodeURIComponent(action.secret_path);

    void apiGet<{ secret?: { data?: Record<string, any>; metadata?: { version?: number } } }>(
      `/api/v1/vault/${action.vault_cluster_id}/kv/item?mount=${mountQ}&path=${pathQ}`,
    )
      .then((res) => {
        if (!active) return;
        const data = (res.secret && 'data' in res.secret ? res.secret.data : {}) || {};
        const version = Number(res.secret?.metadata?.version ?? 0);
        setExistingData(data);
        setCas(version);
        setValues((prev) => {
          const merged = { ...prev };
          for (const k of Object.keys(merged)) {
            if (data[k] !== undefined && data[k] !== null) {
              merged[k] = String(data[k]);
            }
          }
          return merged;
        });
      })
      .catch(async () => {
        if (!active) return;
        // Secret may not exist yet or may have been soft-deleted; check metadata version for CAS.
        try {
          const md = await apiGet<{ metadata?: { current_version?: number } }>(
            `/api/v1/vault/${action.vault_cluster_id}/kv/metadata?mount=${mountQ}&path=${pathQ}`,
          );
          if (!active) return;
          setCas(Number(md.metadata?.current_version ?? 0));
        } catch {
          if (active) setCas(0);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [open, action, secretHints]);

  const emptyPasswordKeys = useMemo(
    () => requiredKeys.filter((k) => isSecretField(k) && !(values[k] || '').trim()),
    [requiredKeys, values],
  );

  const fillMissingPasswords = () => {
    setValues((prev) => {
      const next = { ...prev };
      for (const k of emptyPasswordKeys) {
        next[k] = generateStrongSecret(24);
      }
      return next;
    });
    setRevealed((prev) => {
      const next = { ...prev };
      for (const k of emptyPasswordKeys) next[k] = true;
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!action?.vault_cluster_id || !action.mount || !action.secret_path || saving) return;
    setErr('');

    const missingInputs = requiredKeys.filter((k) => !(values[k] || '').trim());
    if (missingInputs.length > 0) {
      setErr(
        tr(
          `请先填写必填字段：${missingInputs.join('、')}`,
          `Please fill required field(s): ${missingInputs.join(', ')}`,
        ),
      );
      return;
    }

    const payloadData: Record<string, any> = { ...existingData };
    for (const k of requiredKeys) {
      payloadData[k] = values[k];
    }
    for (const k of optionalKeys) {
      const val = (values[k] ?? '').trim();
      if (val !== '') {
        payloadData[k] = values[k];
      } else if (existingData[k] !== undefined && values[k] === '') {
        // Keep untouched unless explicitly filled; don't overwrite with empty string if not previously set.
        delete payloadData[k];
      }
    }
    for (const row of extraRows) {
      const k = row.key.trim();
      if (k) payloadData[k] = row.value;
    }
    if (Object.keys(payloadData).length === 0) {
      setErr(tr('请至少填写一个密钥字段', 'Please provide at least one secret field'));
      return;
    }

    setSaving(true);
    try {
      await apiPut(
        `/api/v1/vault/${action.vault_cluster_id}/kv/item?mount=${encodeURIComponent(action.mount)}&path=${encodeURIComponent(action.secret_path)}`,
        { data: payloadData, cas },
      );
      await Promise.resolve(onFixed());
      toast.success(
        tr(
          `已写入 Vault 密钥 ${action.mount}/${action.secret_path}`,
          `Saved Vault secret ${action.mount}/${action.secret_path}`,
        ),
      );
      onClose();
    } catch (ex: any) {
      setErr(ex?.message || tr('写入 Vault 密钥失败', 'Failed to write Vault secret'));
    } finally {
      setSaving(false);
    }
  };

  const renderField = (key: string, required: boolean) => {
    const secret = isSecretField(key);
    const shown = Boolean(revealed[key]);
    const hintObj = secretHints?.[key];
    const placeholder =
      (locale === 'en' ? hintObj?.placeholderEn || hintObj?.placeholder : hintObj?.placeholder) ||
      (secret ? tr('输入密钥值', 'Enter secret value') : tr(`输入 ${key}`, `Enter ${key}`));
    const hintText = locale === 'en' ? hintObj?.hintEn || hintObj?.hint : hintObj?.hint;
    const isMissing = missingSet.has(key);
    const hasExisting = existingData[key] !== undefined;

    return (
      <div key={key} className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <label className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-slate-800 dark:text-slate-100">
            <span>{key}</span>
            {required && <span className="text-rose-500">*</span>}
            {isMissing && <Badge tone="red">{tr('缺失', 'Missing')}</Badge>}
            {!isMissing && hasExisting && <Badge tone="green">{tr('已有', 'Present')}</Badge>}
          </label>
          {hintText && <span className="text-[11px] text-slate-400 dark:text-slate-500">{hintText}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type={secret && !shown ? 'password' : 'text'}
            value={values[key] ?? ''}
            disabled={saving}
            onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
            placeholder={placeholder}
            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          {secret && (
            <>
              <button
                type="button"
                title={shown ? tr('隐藏', 'Hide') : tr('显示', 'Show')}
                onClick={() => setRevealed((prev) => ({ ...prev, [key]: !prev[key] }))}
                className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
              <Button
                type="button"
                size="sm"
                disabled={saving}
                title={tr('随机生成 24 位强密钥', 'Generate 24-char random secret')}
                onClick={() => {
                  setValues((prev) => ({ ...prev, [key]: generateStrongSecret(24) }));
                  setRevealed((prev) => ({ ...prev, [key]: true }));
                }}
              >
                <Dices className="h-3.5 w-3.5" />
                <span>{tr('随机生成', 'Generate')}</span>
              </Button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <Modal
      open={open}
      title={tr(
        `写入 Vault 密钥 · ${action?.mount || 'secret'}/${action?.secret_path || ''}`,
        `Write Vault Secret · ${action?.mount || 'secret'}/${action?.secret_path || ''}`,
      )}
      onClose={saving ? () => {} : onClose}
      wide
    >
      {!action ? null : (
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 text-xs">
          <ErrorAlert message={err} onClose={() => setErr('')} />

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-900/50">
            <div className="flex flex-wrap items-center gap-2 text-slate-600 dark:text-slate-300">
              <KeyRound className="h-4 w-4 text-emerald-600 shrink-0" />
              <span>
                {tr('Vault 集群：', 'Vault Cluster: ')}
                <strong className="font-semibold text-slate-900 dark:text-slate-100">
                  {action.vault_cluster || action.vault_cluster_id}
                </strong>
              </span>
              <span>·</span>
              <code className="font-mono text-slate-800 dark:text-slate-200">
                {action.mount}/{action.secret_path}
              </code>
              {cas > 0 && <Badge tone="blue">{tr(`更新 v${cas}（保留已有字段）`, `Updating v${cas} (preserves existing keys)`)}</Badge>}
            </div>
            {emptyPasswordKeys.length > 0 && (
              <Button type="button" size="sm" onClick={fillMissingPasswords}>
                <Dices className="h-3.5 w-3.5" />
                <span>{tr('一键生成缺失密码', 'Generate Missing Passwords')}</span>
              </Button>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{tr('正在读取当前密钥状态…', 'Loading current secret state...')}</span>
            </div>
          ) : (
            <div className="space-y-4">
              {requiredKeys.length > 0 && (
                <div className="space-y-3">
                  <div className="font-semibold text-slate-800 dark:text-slate-100">
                    {tr('模板必需字段', 'Required Fields')}
                  </div>
                  <div className="space-y-2.5">{requiredKeys.map((k) => renderField(k, true))}</div>
                </div>
              )}

              {optionalKeys.length > 0 && (
                <div className="rounded-xl border border-slate-200/80 bg-slate-50/40 p-3 dark:border-slate-800 dark:bg-slate-950/30">
                  <button
                    type="button"
                    onClick={() => setShowOptional((v) => !v)}
                    className="flex w-full items-center justify-between text-left font-medium text-slate-700 dark:text-slate-200"
                  >
                    <span>
                      {tr(`可选字段（${optionalKeys.length} 项）`, `Optional Fields (${optionalKeys.length})`)}
                    </span>
                    <span className="text-[11px] text-indigo-600 dark:text-indigo-400">
                      {showOptional ? tr('收起', 'Hide') : tr('展开填写', 'Expand')}
                    </span>
                  </button>
                  {showOptional && <div className="mt-3 space-y-2.5">{optionalKeys.map((k) => renderField(k, false))}</div>}
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-600 dark:text-slate-300">
                    {tr('附加自定义字段（可选）', 'Additional Custom Fields (Optional)')}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={saving}
                    onClick={() =>
                      setExtraRows((prev) => [...prev, { id: `${Date.now()}-${prev.length}`, key: '', value: '' }])
                    }
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>{tr('添加字段', 'Add Field')}</span>
                  </Button>
                </div>
                {extraRows.map((row) => (
                  <div key={row.id} className="grid grid-cols-[1fr_1.4fr_auto] gap-2">
                    <input
                      value={row.key}
                      disabled={saving}
                      onChange={(e) =>
                        setExtraRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))
                      }
                      placeholder={tr('字段名', 'Key')}
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                    />
                    <input
                      value={row.value}
                      disabled={saving}
                      onChange={(e) =>
                        setExtraRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))
                      }
                      placeholder={tr('字段值', 'Value')}
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                    />
                    <button
                      type="button"
                      onClick={() => setExtraRows((prev) => prev.filter((r) => r.id !== row.id))}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" disabled={saving} onClick={onClose}>
              {tr('取消', 'Cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={saving} disabled={loading}>
              <KeyRound className="h-3.5 w-3.5" />
              <span>{tr('写入 Vault', 'Save to Vault')}</span>
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
