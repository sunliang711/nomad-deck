import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { apiPost } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Button, ErrorAlert, Input, Modal, SecretInput } from './UI';

export interface UninstallPlan {
  nodes?: string[];
  unreachable_nodes?: string[];
  snapshots?: number;
  warnings?: string[];
}

export function UninstallClusterModal({
  open,
  cluster,
  plan,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  cluster: { id: string; name: string } | null;
  plan: UninstallPlan | null;
  onClose: () => void;
  onSubmitted: (taskId?: string) => void;
}) {
  const { isEn, tr } = useI18n();
  const [confirmName, setConfirmName] = useState('');
  const [password, setPassword] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setConfirmName('');
    setPassword('');
    setForce(false);
    setErr('');
  }, [open, cluster?.id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cluster) return;
    setBusy(true);
    setErr('');
    try {
      const res = await apiPost(`/api/v1/clusters/${cluster.id}/uninstall`, {
        confirm_name: confirmName.trim(),
        current_password: password,
        force,
      });
      onClose();
      onSubmitted(res.task?.id);
    } catch (ex: any) {
      setErr(ex?.message || tr('卸载集群失败', 'Failed to uninstall cluster'));
    } finally {
      setBusy(false);
    }
  };

  const nameMatches = Boolean(cluster && confirmName.trim() === cluster.name);
  const unreachableNodes = plan?.unreachable_nodes || [];

  return (
    <Modal open={open} title={tr(`卸载集群：${cluster?.name || ''}`, `Uninstall Cluster: ${cluster?.name || ''}`)} busy={busy} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4 text-xs">
        <ErrorAlert message={err} onClose={() => setErr('')} />
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-rose-900 dark:border-rose-900/70 dark:bg-rose-950/60 dark:text-rose-200 space-y-2">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{tr('高危操作：将停止并擦除集群内所有节点的运行态与数据', 'Danger: Stops and erases runtime state and data on all cluster nodes')}</span>
          </div>
          {plan?.nodes && plan.nodes.length > 0 && (
            <div>{tr('涉及节点：', 'Nodes affected: ')}{plan.nodes.join(isEn ? ', ' : '、')}</div>
          )}
          {typeof plan?.snapshots === 'number' && plan.snapshots > 0 && (
            <div>{tr(`关联快照数：${plan.snapshots} 份（将随集群一并删除）`, `Associated snapshots: ${plan.snapshots} (will be deleted with cluster)`)}</div>
          )}
          {plan?.warnings && plan.warnings.length > 0 && (
            <ul className="list-disc pl-4 space-y-1">
              {plan.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>

        {unreachableNodes.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/50 dark:text-amber-200">
            {tr(
              `检测到以下节点当前不可达：${unreachableNodes.join('、')}。若虚拟机已删除或无法 SSH 连接，请勾选下方「强制卸载」。`,
              `Unreachable nodes detected: ${unreachableNodes.join(', ')}. If VMs are deleted or unreachable via SSH, enable "Force Uninstall" below.`,
            )}
          </div>
        )}

        <label className="flex items-start gap-2.5 rounded-xl border border-amber-200/90 bg-amber-50/60 p-3 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200 cursor-pointer">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            className="mt-0.5 shrink-0"
          />
          <span>
            <span className="font-medium">{tr('强制卸载（跳过失联节点的 SSH 清理）', 'Force Uninstall (skip SSH cleanup on unreachable nodes)')}</span>
            <span className="mt-0.5 block text-[11px] leading-4 opacity-85">
              {tr(
                '仍会尽力清理可连通的节点；遇到 SSH 失联或清理失败的节点将自动跳过，并直接删除控制面集群记录与托管凭据。',
                'Reachable nodes will still be cleaned up; unreachable or failing nodes are skipped, and control-plane cluster records and managed credentials are deleted.',
              )}
            </span>
          </span>
        </label>

        <Input
          label={tr(`请输入集群名称「${cluster?.name || ''}」确认卸载`, `Type cluster name "${cluster?.name || ''}" to confirm`)}
          required
          placeholder={cluster?.name || ''}
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
        />
        <SecretInput
          label={tr('当前管理员登录密码', 'Current Admin Password')}
          required
          value={password}
          onChangeValue={setPassword}
        />

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <Button type="button" disabled={busy} onClick={onClose}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button type="submit" variant="danger" loading={busy} disabled={!nameMatches || !password}>
            {force ? tr('确认强制卸载', 'Confirm Force Uninstall') : tr('确认卸载并清除数据', 'Confirm Uninstall & Erase')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
