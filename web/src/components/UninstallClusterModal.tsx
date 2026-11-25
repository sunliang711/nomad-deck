import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { apiPost } from '../lib/api';
import { Button, ErrorAlert, Input, Modal, SecretInput } from './UI';

export interface UninstallPlan {
  nodes?: string[];
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
  const [confirmName, setConfirmName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setConfirmName('');
    setPassword('');
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
      });
      onClose();
      onSubmitted(res.task?.id);
    } catch (ex: any) {
      setErr(ex?.message || '卸载集群失败');
    } finally {
      setBusy(false);
    }
  };

  const nameMatches = Boolean(cluster && confirmName.trim() === cluster.name);

  return (
    <Modal open={open} title={`卸载集群：${cluster?.name || ''}`} busy={busy} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4 text-xs">
        <ErrorAlert message={err} onClose={() => setErr('')} />
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-rose-900 dark:border-rose-900/70 dark:bg-rose-950/60 dark:text-rose-200 space-y-2">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>高危操作：将停止并擦除集群内所有节点的运行态与数据</span>
          </div>
          {plan?.nodes && plan.nodes.length > 0 && (
            <div>涉及节点：{plan.nodes.join('、')}</div>
          )}
          {typeof plan?.snapshots === 'number' && plan.snapshots > 0 && (
            <div>关联快照数：{plan.snapshots} 份（将随集群一并删除）</div>
          )}
          {plan?.warnings && plan.warnings.length > 0 && (
            <ul className="list-disc pl-4 space-y-1">
              {plan.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>

        <Input
          label={`请输入集群名称「${cluster?.name || ''}」确认卸载`}
          required
          placeholder={cluster?.name || ''}
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
        />
        <SecretInput
          label="当前管理员登录密码"
          required
          value={password}
          onChangeValue={setPassword}
        />

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <Button type="button" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="danger" loading={busy} disabled={!nameMatches || !password}>
            确认卸载并清除数据
          </Button>
        </div>
      </form>
    </Modal>
  );
}
