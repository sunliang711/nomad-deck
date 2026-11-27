import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, FolderPlus, Loader2, Server, Terminal } from 'lucide-react';
import { apiGet, apiPost, openSSE } from '../lib/api';
import { isTaskActiveStatus, isTaskFailureStatus } from '../lib/actionLabels';
import { useI18n } from '../lib/i18n';
import { useOpsDrawer } from '../lib/opsDrawer';
import { useToast } from './Toast';
import { Badge, Button, ErrorAlert, Input, Modal } from './UI';

interface ClusterMemberItem {
  node_id: string;
  name: string;
  host?: string;
  role: string;
  advertise_addr?: string;
  api_addr?: string;
  install_state?: string;
  service_status?: string;
  config?: {
    host_volumes?: Array<{
      name: string;
      path: string;
      read_only?: boolean;
      create?: boolean;
    }>;
  };
}

interface ClusterDetailResp {
  cluster: {
    id: string;
    name: string;
    mode: string;
    init_state: string;
  };
  nodes: ClusterMemberItem[];
}

export function HostVolumeCreateModal({
  open,
  clusterId,
  volumeName,
  defaultReadOnly,
  onClose,
  onCreated,
}: {
  open: boolean;
  clusterId: string;
  volumeName: string;
  defaultReadOnly: boolean;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const { openTask } = useOpsDrawer();

  const [loading, setLoading] = useState(false);
  const [cluster, setCluster] = useState<ClusterDetailResp['cluster'] | null>(null);
  const [members, setMembers] = useState<ClusterMemberItem[]>([]);
  const [hostPath, setHostPath] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [createDir, setCreateDir] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmSingle, setConfirmSingle] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [taskStatus, setTaskStatus] = useState('');
  const [stepText, setStepText] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open || !clusterId || !volumeName) return;
    let active = true;
    setLoading(true);
    setCluster(null);
    setMembers([]);
    setHostPath(`/opt/nomad-deck/nomad/volumes/${volumeName}`);
    setReadOnly(defaultReadOnly);
    setCreateDir(true);
    setSelectedIds([]);
    setConfirmSingle(false);
    setSubmitting(false);
    setTaskId('');
    setTaskStatus('');
    setStepText('');
    setErr('');

    void apiGet<ClusterDetailResp>(`/api/v1/clusters/${clusterId}`)
      .then((res) => {
        if (!active) return;
        setCluster(res.cluster || null);
        const allNodes = res.nodes || [];
        setMembers(allNodes);
        const available = allNodes
          .filter((n) => n.role !== 'server')
          .filter((n) => !(n.config?.host_volumes || []).some((hv) => hv.name === volumeName))
          .map((n) => n.node_id);
        setSelectedIds(available);
      })
      .catch((ex: any) => {
        if (active) setErr(ex?.message || tr('读取集群节点列表失败', 'Failed to load cluster nodes'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [open, clusterId, volumeName, defaultReadOnly]);

  useEffect(() => {
    if (!open || !taskId) return;
    let active = true;

    const finalize = async (status: string, errMsg?: string) => {
      if (!active) return;
      setTaskStatus(status);
      if (isTaskFailureStatus(status)) {
        setErr(errMsg || tr('节点创建 Host Volume 任务失败，可打开任务日志查看详情', 'Failed to create Host Volume on node; check task logs for details'));
        return;
      }
      await Promise.resolve(onCreated());
      if (!active) return;
      toast.success(tr(`Host Volume "${volumeName}" 已创建并生效，可在「节点插件与配置」中查看`, `Host Volume "${volumeName}" created and active; view it under Node Plugins & Config`));
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
  }, [open, taskId, volumeName]);

  const clientNodes = useMemo(() => members.filter((n) => n.role !== 'server'), [members]);

  const selectedNodes = useMemo(
    () => clientNodes.filter((n) => selectedIds.includes(n.node_id)),
    [clientNodes, selectedIds],
  );

  const hasInstalledTarget = useMemo(
    () => selectedNodes.some((n) => n.install_state === 'installed'),
    [selectedNodes],
  );

  const needsSingleConfirm = useMemo(
    () =>
      cluster?.mode === 'single' &&
      selectedNodes.some((n) => n.install_state === 'installed' && n.role !== 'client'),
    [cluster, selectedNodes],
  );

  const toggleNode = (nodeId: string, checked: boolean) => {
    setSelectedIds((prev) => (checked ? Array.from(new Set([...prev, nodeId])) : prev.filter((id) => id !== nodeId)));
  };

  const running = Boolean(taskId) && (!taskStatus || isTaskActiveStatus(taskStatus));
  const busy = submitting || running;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!volumeName || selectedIds.length === 0) {
      setErr(tr('请至少选择一个目标 Client 节点', 'Please select at least one target Client node'));
      return;
    }
    if (!hostPath.trim()) {
      setErr(tr('请填写宿主机目录路径', 'Please enter the host directory path'));
      return;
    }
    if (needsSingleConfirm && !confirmSingle) {
      setErr(tr('单机模式更新节点配置会重启唯一节点并短时中断服务，请先勾选下方确认框', 'Updating node config in single-node mode restarts the sole node and causes brief downtime; check the confirmation box below'));
      return;
    }
    setSubmitting(true);
    setErr('');
    setTaskId('');
    setTaskStatus('');
    setStepText('');
    try {
      const res = await apiPost<{ task?: { id: string } }>(`/api/v1/nomad/${clusterId}/host-volumes`, {
        volume: {
          name: volumeName,
          path: hostPath.trim(),
          read_only: readOnly,
          create: createDir,
        },
        node_ids: selectedIds,
        confirm_single_node: confirmSingle,
      });
      if (res?.task?.id) {
        setTaskId(res.task.id);
        setTaskStatus('running');
        setStepText(tr('已提交节点配置任务，正在创建目录并滚动生效…', 'Node config task submitted, creating directory and rolling out...'));
      } else {
        await Promise.resolve(onCreated());
        toast.success(tr(`Host Volume "${volumeName}" 已保存至节点配置（将在部署集群时创建并生效）`, `Host Volume "${volumeName}" saved to node config (will take effect on cluster deploy)`));
        onClose();
      }
    } catch (ex: any) {
      setErr(ex?.message || tr('创建 Host Volume 失败', 'Failed to create Host Volume'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={
        <span className="inline-flex items-center gap-2">
          <FolderPlus className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          <span>{tr(`在节点创建 Host Volume：${volumeName}`, `Create Host Volume on Nodes: ${volumeName}`)}</span>
        </span>
      }
      size="lg"
      busy={busy}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4 text-xs">
        <ErrorAlert message={err} onClose={() => setErr('')} />

        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-slate-600 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300 leading-5">
          {tr('将把该 Host Volume 写入所选 Client 节点的托管配置（生成 ', 'Writes this Host Volume to the managed config of selected Client nodes (generating ')}
          <code className="font-mono">70-host-volume-{volumeName}.hcl</code>
          {tr('），创建完成后可在「Nomad 集群 → 节点插件与配置」中查看与修改。', '), and can be viewed or modified under Nomad Clusters → Node Plugins & Config.')}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr]">
          <Input label={tr('卷名称', 'Volume Name')} value={volumeName} disabled />
          <Input
            label={tr('宿主机目录路径', 'Host Directory Path')}
            required
            disabled={busy}
            placeholder={`/opt/nomad-deck/nomad/volumes/${volumeName}`}
            value={hostPath}
            onChange={(e) => setHostPath(e.target.value)}
            hint={tr('禁止使用 /etc、/usr 等系统目录；在 /opt/nomad-deck/ 下需放在 volumes/ 子目录', 'System dirs like /etc and /usr are disallowed; under /opt/nomad-deck/ it must be inside volumes/')}
          />
        </div>

        <div className="flex flex-wrap gap-5 text-slate-700 dark:text-slate-300">
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              disabled={busy}
              checked={createDir}
              onChange={(e) => setCreateDir(e.target.checked)}
            />
            <span>{tr('目录不存在时自动创建', 'Create directory if missing')}</span>
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              disabled={busy}
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
            />
            <span>{tr('只读（read_only）', 'Read-only (read_only)')}</span>
          </label>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-medium text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <Server className="h-3.5 w-3.5 text-slate-400" />
              {tr('目标 Client 节点', 'Target Client Nodes')}
            </span>
            {clientNodes.length > 0 && (
              <span className="text-[11px] text-slate-500">{tr(`已选 ${selectedIds.length} 台`, `${selectedIds.length} selected`)}</span>
            )}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-4 text-slate-500 dark:border-slate-800">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{tr('正在加载集群节点列表…', 'Loading cluster nodes...')}</span>
            </div>
          ) : clientNodes.length === 0 ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
              {tr('当前集群没有可用的 Client 或 Server+Client 节点，无法配置 Host Volume。', 'No Client or Server+Client nodes available in this cluster to configure a Host Volume.')}
            </div>
          ) : (
            <div className="space-y-1.5 rounded-xl border border-slate-200 p-2 dark:border-slate-800">
              {clientNodes.map((n) => {
                const existing = (n.config?.host_volumes || []).find((hv) => hv.name === volumeName);
                const checked = selectedIds.includes(n.node_id);
                return (
                  <label
                    key={n.node_id}
                    className={`flex flex-wrap items-center justify-between gap-2 rounded-lg px-2.5 py-2 transition ${
                      existing
                        ? 'bg-emerald-50/50 text-slate-500 dark:bg-emerald-500/5 dark:text-slate-400'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        disabled={Boolean(existing) || busy}
                        checked={Boolean(existing) || checked}
                        onChange={(e) => toggleNode(n.node_id, e.target.checked)}
                      />
                      <span className="font-medium text-slate-800 dark:text-slate-100">{n.name}</span>
                      <Badge>{n.role === 'server_client' ? 'Server + Client' : 'Client'}</Badge>
                      <span className="font-mono text-[11px] text-slate-500">{n.advertise_addr || n.host}</span>
                    </div>
                    {existing ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="h-3 w-3" />
                        <span>{tr('已配置：', 'Configured: ')}{existing.path}</span>
                      </span>
                    ) : n.install_state !== 'installed' ? (
                      <Badge tone="neutral">{tr('未部署（将预存配置）', 'Not deployed (will stage config)')}</Badge>
                    ) : (
                      <Badge tone="blue">{tr('已部署（将滚动重启生效）', 'Deployed (rolling restart)')}</Badge>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {hasInstalledTarget && !needsSingleConfirm && (
          <div className="rounded-xl border border-blue-200 bg-blue-50/70 px-3 py-2 text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200">
            {tr('使新 Host Volume 生效需要滚动重启所选节点上的 Nomad 服务（约数秒钟）。', 'Applying the new Host Volume requires a rolling restart of Nomad on the selected nodes (a few seconds).')}
          </div>
        )}

        {needsSingleConfirm && (
          <label className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 cursor-pointer">
            <input
              className="mt-0.5"
              type="checkbox"
              required
              disabled={busy}
              checked={confirmSingle}
              onChange={(e) => setConfirmSingle(e.target.checked)}
            />
            <span>{tr('单机模式更新节点配置会重启唯一节点并短时中断服务，我已知悉并确认继续。', 'Updating node config in single-node mode restarts the only node and causes brief downtime. I understand and confirm.')}</span>
          </label>
        )}

        {taskId && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2.5 text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200">
            <div className="flex items-center gap-2 min-w-0">
              {running && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />}
              <span className="truncate">{stepText || tr('正在执行节点配置更新…', 'Applying node config update...')}</span>
            </div>
            <Button
              size="sm"
              type="button"
              onClick={() => openTask(taskId, tr(`创建 Host Volume: ${volumeName}`, `Create Host Volume: ${volumeName}`))}
            >
              <Terminal className="h-3 w-3" />
              <span>{tr('查看任务日志', 'View Task Logs')}</span>
            </Button>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <Button type="button" disabled={running} onClick={onClose}>
            {tr('取消', 'Cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={loading || clientNodes.length === 0 || selectedIds.length === 0}
          >
            {running
              ? tr('正在创建并生效…', 'Creating & Applying...')
              : hasInstalledTarget
                ? tr('创建并重启节点生效', 'Create & Restart Nodes')
                : tr('保存到节点配置', 'Save to Node Config')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
