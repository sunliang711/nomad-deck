import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, CheckCircle2, Copy, KeyRound, MoreHorizontal, Plus, RefreshCw, Server as ServerIcon, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut, fmtBytes, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { copyText as copyToClipboard } from '../lib/clipboard';
import { useI18n } from '../lib/i18n';
import type { Locale } from '../lib/locale';
import { useOpsDrawer } from '../lib/opsDrawer';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { Drawer } from '../components/Drawer';
import {
  DockerManageModal,
  dockerModeLabelOf,
  dockerStatusLabelOf,
  type DockerManageTarget,
} from '../components/DockerManageModal';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  InfoTip,
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

function timeSyncLabelOf(sync?: string, locale: Locale = 'zh'): string {
  if (sync === 'synced') return locale === 'en' ? 'Synced' : '已同步';
  if (sync === 'unsynced' || sync === 'skewed') return locale === 'en' ? 'Clock Skew' : '待校时';
  return sync || '-';
}

function formatHostOS(osInfo?: string, arch?: string): { primary: string; secondary: string } {
  const raw = (osInfo || '').trim();
  const cleanArch = (arch || '').trim();
  if (!raw) return { primary: '-', secondary: cleanArch || '-' };
  const [distro, kernel] = raw.split(/\s+\/\s+/);
  const shortDistro = (distro || raw).replace(/^Debian GNU\/Linux\s+/i, 'Debian ');
  const parts: string[] = [];
  if (kernel) {
    const cleanKernel = cleanArch && kernel.endsWith(`-${cleanArch}`) ? kernel.slice(0, -(cleanArch.length + 1)) : kernel;
    parts.push(cleanKernel);
  }
  if (cleanArch) parts.push(cleanArch);
  return {
    primary: shortDistro,
    secondary: parts.join(' · ') || '-',
  };
}

function formatCompactBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0';
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1) return `${gib.toFixed(1)}G`;
  const mib = bytes / (1024 * 1024);
  return `${Math.round(mib)}M`;
}

function setupCommandForKey(k?: { public_key?: string; setup_command?: string } | null): string {
  if (!k) return '';
  if (k.setup_command) return k.setup_command;
  if (!k.public_key) return '';
  const escaped = `'${k.public_key.replace(/'/g, `'\\''`)}'`;
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qxF ${escaped} ~/.ssh/authorized_keys || echo ${escaped} >> ~/.ssh/authorized_keys)`;
}

export function InfraPage() {
  const { isAdmin } = useAuth();
  const { locale, isEn, tr } = useI18n();
  const { openTask } = useOpsDrawer();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [tab, setTab] = useState('nodes');
  const [keys, setKeys] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [nodeModalErr, setNodeModalErr] = useState('');
  const [pushModalErr, setPushModalErr] = useState('');
  const [metricsBusy, setMetricsBusy] = useState(false);
  const [formBusy, setFormBusy] = useState(false);

  // Key modals
  const [showGenKey, setShowGenKey] = useState(false);
  const [showImportKey, setShowImportKey] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [privPEM, setPrivPEM] = useState('');

  // Node modals
  const [showNodeModal, setShowNodeModal] = useState(false);
  const [editingNode, setEditingNode] = useState<any>(null);
  const [nodeForm, setNodeForm] = useState({
    name: '',
    host: '',
    ssh_port: 22,
    ssh_user: 'root',
    ssh_key_id: '',
    use_sudo: true,
    notes: '',
  });
  const [oneTimePassword, setOneTimePassword] = useState('');
  const [pushNode, setPushNode] = useState<any>(null);
  const [pushPassword, setPushPassword] = useState('');
  const [pushAndTest, setPushAndTest] = useState(true);
  const [pwResetNode, setPwResetNode] = useState<any>(null);
  const [detailNode, setDetailNode] = useState<any>(null);
  const [detailProbe, setDetailProbe] = useState<any>(null);
  const [detailWarnings, setDetailWarnings] = useState<string[]>([]);
  const [detailClonePeers, setDetailClonePeers] = useState<string[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTesting, setDetailTesting] = useState(false);
  const [resettingMidId, setResettingMidId] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<{ id: string; top: number; right: number } | null>(null);
  const [saveAndTest, setSaveAndTest] = useState(true);
  const [dockerNode, setDockerNode] = useState<DockerManageTarget | null>(null);

  const load = useCallback(async () => {
    setErr('');
    try {
      const [kRes, nRes] = await Promise.all([apiGet('/api/v1/ssh-keys'), apiGet('/api/v1/nodes')]);
      setKeys(kRes.ssh_keys || []);
      setNodes(nRes.nodes || []);
    } catch (ex: any) {
      setErr(ex?.message || tr('加载基础设施信息失败', 'Failed to load infrastructure data'));
    }
  }, [tr]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [openMenu]);

  const generateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormBusy(true);
    setErr('');
    try {
      await apiPost('/api/v1/ssh-keys/generate', { name: keyName.trim() });
      setKeyName('');
      setShowGenKey(false);
      await load();
    } catch (ex: any) {
      setErr(ex?.message || tr('生成密钥失败', 'Failed to generate key'));
    } finally {
      setFormBusy(false);
    }
  };

  const importKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormBusy(true);
    setErr('');
    try {
      await apiPost('/api/v1/ssh-keys', { name: keyName.trim(), private_key: privPEM });
      setKeyName('');
      setPrivPEM('');
      setShowImportKey(false);
      await load();
    } catch (ex: any) {
      setErr(ex?.message || tr('导入密钥失败', 'Failed to import key'));
    } finally {
      setFormBusy(false);
    }
  };

  const openAddNode = () => {
    setErr('');
    setNodeModalErr('');
    if (keys.length === 0) {
      setTab('keys');
      toast.info(tr('请先生成或导入 SSH 密钥，再添加主机', 'Generate or import an SSH key before adding hosts'));
      return;
    }
    setEditingNode(null);
    const defKey = keys.find((k) => k.is_default)?.id || keys[0]?.id || '';
    setNodeForm({ name: '', host: '', ssh_port: 22, ssh_user: 'root', ssh_key_id: defKey, use_sudo: true, notes: '' });
    setOneTimePassword('');
    setSaveAndTest(true);
    setShowNodeModal(true);
  };

  const openEditNode = (n: any) => {
    setErr('');
    setNodeModalErr('');
    setEditingNode(n);
    setNodeForm({
      name: n.name,
      host: n.host,
      ssh_port: n.ssh_port || 22,
      ssh_user: n.ssh_user || 'root',
      ssh_key_id: n.ssh_key_id || '',
      use_sudo: Boolean(n.use_sudo),
      notes: n.notes || '',
    });
    setOneTimePassword('');
    setSaveAndTest(true);
    setShowNodeModal(true);
  };

  const closeNodeModal = () => {
    setShowNodeModal(false);
    setOneTimePassword('');
    setNodeModalErr('');
  };

  const openPushModal = (n: any) => {
    setErr('');
    setPushModalErr('');
    setPushPassword('');
    setPushAndTest(true);
    setPushNode(n);
  };

  const closePushModal = () => {
    setPushNode(null);
    setPushPassword('');
    setPushModalErr('');
  };

  const openNodeDetail = useCallback(async (node: any, overrideWarnings?: string[], overridePeers?: string[]) => {
    setDetailNode(node);
    setDetailProbe(null);
    setDetailWarnings(overrideWarnings || []);
    setDetailClonePeers(overridePeers || []);
    setDetailLoading(true);
    try {
      const res = await apiGet(`/api/v1/nodes/${node.id}`);
      if (res.node) setDetailNode(res.node);
      setDetailProbe(res.probe || null);
      setDetailWarnings(Array.isArray(res.warnings) ? res.warnings : (overrideWarnings || []));
      setDetailClonePeers(Array.isArray(res.clone_peers) ? res.clone_peers : (overridePeers || []));
    } catch (ex: any) {
      toast.error(ex?.message || tr(`加载主机 ${node.name} 详情失败`, `Failed to load details for host ${node.name}`), { position: 'top-right' });
    } finally {
      setDetailLoading(false);
    }
  }, [toast, tr]);

  const closeDetailDrawer = () => {
    setDetailNode(null);
    setDetailProbe(null);
    setDetailWarnings([]);
    setDetailClonePeers([]);
    setDetailLoading(false);
  };

  const notifyProbeResult = (node: any, warnings: string[], options?: { pushed?: boolean; prefix?: string; clonePeers?: string[] }) => {
    const list = Array.isArray(warnings) ? warnings : [];
    const peers = Array.isArray(options?.clonePeers) ? options.clonePeers : [];
    const name = node?.name || '';
    const viewAction = node?.id
      ? {
          label: tr('查看详情', 'View Details'),
          onClick: () => {
            void openNodeDetail(node, list, peers);
          },
        }
      : undefined;

    if (list.length === 0) {
      const title = options?.prefix
        ? tr(`${options.prefix}，所有环境预检均通过`, `${options.prefix}, all preflight checks passed`)
        : tr(`主机 ${name} 连接成功，所有环境预检均通过`, `Host ${name} connected, all preflight checks passed`);
      toast.success(title, {
        position: 'top-right',
        durationMs: 4500,
        action: viewAction,
      });
      return;
    }

    const preview = list.slice(0, 3);
    if (list.length > 3) {
      preview.push(tr(`另有 ${list.length - 3} 项提醒，点击「查看详情」查看完整列表`, `${list.length - 3} more warnings — click "View Details" to inspect all`));
    }
    const title = options?.prefix
      ? tr(`${options.prefix}（发现 ${list.length} 项环境提醒）`, `${options.prefix} (${list.length} preflight warnings)`)
      : tr(`主机 ${name} 连接成功，发现 ${list.length} 项环境提醒`, `Host ${name} connected with ${list.length} preflight warnings`);
    toast.info(title, {
      position: 'top-right',
      durationMs: 8000,
      details: preview,
      action: viewAction,
    });
  };

  const resetNodeMachineID = async (node: any, clonePeers?: string[]) => {
    if (!node?.id) return;
    if (node.is_control_plane_host) {
      toast.error(tr('当前主机与 NomadDeck 控制面同机，不支持通过页面重置 /etc/machine-id', 'Cannot reset /etc/machine-id from UI on the control-plane host'), { position: 'top-right' });
      return;
    }
    const peers = Array.isArray(clonePeers) ? clonePeers : [];
    const msg =
      peers.length > 0
        ? tr(
            `检测到主机「${node.name}」与「${peers.join('、')}」共用相同的 /etc/machine-id（疑似克隆虚拟机）。\n\n是否立即通过 SSH 在目标主机上重新生成新的 /etc/machine-id 并重新探测？\n（提示：可能影响基于 machine-id 的 DHCP 租约与 journald 日志目录）`,
            `Host "${node.name}" shares the same /etc/machine-id as "${peers.join(', ')}" (likely cloned VMs).\n\nRegenerate /etc/machine-id over SSH and re-probe now?\n(Note: this may affect machine-id based DHCP leases and journald directories.)`,
          )
        : tr(
            `确定要在主机「${node.name}」(${node.host}) 上重新生成 /etc/machine-id 并重新探测吗？\n（提示：可能影响基于 machine-id 的 DHCP 租约与 journald 日志目录，建议在加入集群前操作）`,
            `Regenerate /etc/machine-id on host "${node.name}" (${node.host}) and re-probe?\n(Note: this may affect machine-id based DHCP leases and journald directories.)`,
          );
    const ok = await askConfirm(msg, {
      title: tr('重新生成节点 ID', 'Regenerate Node Machine ID'),
      confirmText: tr('立即重新生成', 'Regenerate'),
    });
    if (!ok) return;

    setResettingMidId(node.id);
    if (detailNode?.id === node.id) setDetailTesting(true);
    try {
      const res = await apiPost(`/api/v1/nodes/${node.id}/reset-machine-id`, {});
      const updated = res.node || node;
      const warnings = Array.isArray(res.warnings) ? res.warnings : [];
      const nextPeers = Array.isArray(res.clone_peers) ? res.clone_peers : [];
      setNodes((prev) => prev.map((x) => (x.id === node.id ? updated : x)));
      if (detailNode?.id === node.id) {
        setDetailNode(updated);
        setDetailProbe(res.probe || null);
        setDetailWarnings(warnings);
        setDetailClonePeers(nextPeers);
      }
      notifyProbeResult(updated, warnings, {
        prefix: tr(`已为主机 ${updated.name} 重新生成节点 ID 并完成探测`, `Regenerated machine-id and re-probed host ${updated.name}`),
        clonePeers: nextPeers,
      });
      await load();
    } catch (ex: any) {
      toast.error(ex?.message || tr(`重新生成 ${node.name} 节点 ID 失败`, `Failed to regenerate machine-id for ${node.name}`), {
        position: 'top-right',
        durationMs: 6000,
      });
    } finally {
      setResettingMidId(null);
      setDetailTesting(false);
    }
  };

  const saveNode = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormBusy(true);
    setNodeModalErr('');
    try {
      let savedNode: any = editingNode;
      if (editingNode) {
        const res = await apiPut(`/api/v1/nodes/${editingNode.id}`, nodeForm);
        savedNode = res.node || editingNode;
      } else {
        const res = await apiPost('/api/v1/nodes', nodeForm);
        savedNode = res.node;
        if (savedNode) {
          setEditingNode(savedNode);
        }
      }

      let pushed = false;
      if (oneTimePassword !== '' && savedNode?.id) {
        try {
          await apiPost(`/api/v1/nodes/${savedNode.id}/push-key`, { password: oneTimePassword });
          setOneTimePassword('');
          pushed = true;
        } catch (pushEx: any) {
          await load();
          setNodeModalErr(
            tr(
              `主机「${savedNode.name || nodeForm.name}」已保存，但${pushEx?.message || '推送公钥失败'}。请核对一次性密码重试，或留空密码改用手动配置公钥。`,
              `Host "${savedNode.name || nodeForm.name}" saved, but key push failed: ${pushEx?.message || 'unknown error'}. Check the one-time password or authorize manually.`,
            ),
          );
          return;
        }
      }

      closeNodeModal();

      let detectedClonePeers: string[] = [];
      let detectedCloneNode: any = null;
      if (saveAndTest && savedNode?.id) {
        try {
          const testRes = await apiPost(`/api/v1/nodes/${savedNode.id}/test`);
          const testedNode = testRes.node || savedNode;
          const warnings = testRes.warnings || [];
          const clonePeers: string[] = Array.isArray(testRes.clone_peers) ? testRes.clone_peers : [];
          notifyProbeResult(testedNode, warnings, {
            pushed,
            prefix: pushed
              ? tr(`主机 ${testedNode.name || nodeForm.name} 已保存、推送公钥并连接成功`, `Host ${testedNode.name || nodeForm.name} saved, key pushed, and connected`)
              : tr(`主机 ${testedNode.name || nodeForm.name} 已保存并连接成功`, `Host ${testedNode.name || nodeForm.name} saved and connected`),
            clonePeers,
          });
          if (detailNode?.id === testedNode.id) {
            void openNodeDetail(testedNode, warnings, clonePeers);
          }
          if (clonePeers.length > 0 && !testedNode.is_control_plane_host && isAdmin) {
            detectedClonePeers = clonePeers;
            detectedCloneNode = testedNode;
          }
        } catch (testEx: any) {
          toast.info(
            pushed
              ? tr(`主机已保存并完成公钥推送，但探测未通过：${testEx?.message || '请检查主机网络或 SSH 配置'}`, `Host saved and key pushed, but probe failed: ${testEx?.message || 'check network or SSH config'}`)
              : tr(`主机已保存，暂未连通：${testEx?.message || '请手动配置公钥或点击「推送公钥」后再测试连接'}`, `Host saved but unreachable yet: ${testEx?.message || 'authorize key manually or push key and retry'}`),
            { position: 'top-right', durationMs: 6000 },
          );
        }
      } else {
        toast.success(
          pushed
            ? tr(`主机 ${savedNode?.name || nodeForm.name} 已保存并推送公钥`, `Host ${savedNode?.name || nodeForm.name} saved and key pushed`)
            : tr(`主机 ${savedNode?.name || nodeForm.name} 已保存`, `Host ${savedNode?.name || nodeForm.name} saved`),
          { position: 'top-right' },
        );
      }
      await load();
      if (detailNode?.id && detailNode.id === savedNode?.id && !saveAndTest) {
        void openNodeDetail(savedNode);
      }
      if (detectedCloneNode && detectedClonePeers.length > 0) {
        void resetNodeMachineID(detectedCloneNode, detectedClonePeers);
      }
    } catch (ex: any) {
      setNodeModalErr(ex?.message || tr('保存主机失败', 'Failed to save host'));
    } finally {
      setFormBusy(false);
    }
  };

  const testNode = async (n: any) => {
    setErr('');
    if (detailNode?.id === n.id) setDetailTesting(true);
    try {
      const res = await apiPost(`/api/v1/nodes/${n.id}/test`);
      const testedNode = res.node || n;
      const warnings = res.warnings || [];
      const clonePeers: string[] = Array.isArray(res.clone_peers) ? res.clone_peers : [];
      notifyProbeResult(testedNode, warnings, { clonePeers });
      await load();
      if (detailNode?.id === n.id) {
        setDetailNode(testedNode);
        setDetailProbe(res.probe || null);
        setDetailWarnings(warnings);
        setDetailClonePeers(clonePeers);
      }
      if (clonePeers.length > 0 && !testedNode.is_control_plane_host && isAdmin) {
        void resetNodeMachineID(testedNode, clonePeers);
      }
    } catch (ex: any) {
      toast.error(tr(`探测主机 ${n.name} 失败：${ex?.message || '连接异常'}`, `Probe host ${n.name} failed: ${ex?.message || 'connection error'}`), {
        position: 'top-right',
        durationMs: 6000,
      });
      await load();
      if (detailNode?.id === n.id) {
        void openNodeDetail(n);
      }
    } finally {
      setDetailTesting(false);
    }
  };

  const doPushKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pushNode) return;
    const targetNode = pushNode;
    setFormBusy(true);
    setPushModalErr('');
    try {
      await apiPost(`/api/v1/nodes/${targetNode.id}/push-key`, { password: pushPassword });
      closePushModal();
      let detectedClonePeers: string[] = [];
      let detectedCloneNode: any = null;
      if (pushAndTest) {
        try {
          const testRes = await apiPost(`/api/v1/nodes/${targetNode.id}/test`);
          const testedNode = testRes.node || targetNode;
          const warnings = testRes.warnings || [];
          const clonePeers: string[] = Array.isArray(testRes.clone_peers) ? testRes.clone_peers : [];
          notifyProbeResult(testedNode, warnings, {
            pushed: true,
            prefix: tr(`已向 ${testedNode.name} 推送公钥并连接成功`, `Key pushed to ${testedNode.name} and connected`),
            clonePeers,
          });
          if (detailNode?.id === targetNode.id) {
            void openNodeDetail(testedNode, warnings, clonePeers);
          }
          if (clonePeers.length > 0 && !testedNode.is_control_plane_host && isAdmin) {
            detectedClonePeers = clonePeers;
            detectedCloneNode = testedNode;
          }
        } catch (testEx: any) {
          toast.info(
            tr(`已成功推送公钥到主机 ${targetNode.name}，但探测未通过：${testEx?.message || '请稍后重试测试连接'}`, `Key pushed to ${targetNode.name}, but probe failed: ${testEx?.message || 'retry later'}`),
            { position: 'top-right', durationMs: 6000 },
          );
        }
      } else {
        toast.success(tr(`已成功推送公钥到主机 ${targetNode.name}`, `Key pushed to host ${targetNode.name}`), { position: 'top-right' });
      }
      await load();
      if (detectedCloneNode && detectedClonePeers.length > 0) {
        void resetNodeMachineID(detectedCloneNode, detectedClonePeers);
      }
    } catch (ex: any) {
      setPushModalErr(ex?.message || tr('推送公钥失败', 'Failed to push public key'));
    } finally {
      setFormBusy(false);
    }
  };

  const openDocker = (n: any) => {
    setDockerNode({ id: n.id, name: n.name });
  };

  const copyText = (text: string, msg: string) => {
    void copyToClipboard(text)
      .then(() => toast.success(msg, { recordHistory: false }))
      .catch((ex) => toast.error(ex?.message || tr('复制失败', 'Copy failed')));
  };

  const refreshAllMetrics = async () => {
    setMetricsBusy(true);
    setErr('');
    try {
      const res = await apiPost('/api/v1/nodes/metrics/refresh', {});
      if (Array.isArray(res.nodes)) setNodes(res.nodes);
      toast.success(tr(`主机实时负载采集完成：成功 ${res.ok ?? 0}，失败 ${res.failed ?? 0}`, `Host metrics refreshed: ${res.ok ?? 0} ok, ${res.failed ?? 0} failed`));
    } catch (ex: any) {
      setErr(ex?.message || tr('采集主机负载失败', 'Failed to refresh host metrics'));
    } finally {
      setMetricsBusy(false);
    }
  };

  const refreshNodeMetrics = async (node: any) => {
    setErr('');
    try {
      const res = await apiPost(`/api/v1/nodes/${node.id}/metrics`, {});
      if (res.node) {
        setNodes((prev) => prev.map((x) => (x.id === node.id ? res.node : x)));
        if (detailNode?.id === node.id) {
          setDetailNode(res.node);
        }
      }
      toast.success(tr(`已刷新 ${node.name} CPU/内存利用率`, `Refreshed CPU/memory utilization for ${node.name}`), { position: 'top-right' });
    } catch (ex: any) {
      toast.error(ex?.message || tr(`采集 ${node.name} 负载失败`, `Failed to fetch metrics for ${node.name}`), { position: 'top-right' });
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={tr('基础设施', 'Infrastructure')}
        subtitle={tr('纳管 Linux 主机节点、SSH Ed25519 密钥库、主机体检与 Docker Engine 管理', 'Manage Linux host nodes, SSH Ed25519 keys, host preflight checks, and Docker Engine')}
        actions={
          <>
            <Button onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" />
              <span>{tr('刷新', 'Refresh')}</span>
            </Button>
            {isAdmin && tab === 'nodes' && (
              <>
                <Button disabled={metricsBusy || nodes.length === 0} onClick={() => void refreshAllMetrics()}>
                  <Activity className="h-4 w-4" />
                  <span>{metricsBusy ? tr('采集中...', 'Collecting...') : tr('采集实时负载', 'Refresh Metrics')}</span>
                </Button>
                <Button variant="primary" onClick={openAddNode}>
                  <Plus className="h-4 w-4" />
                  <span>{tr('新增主机', 'Add Host')}</span>
                </Button>
              </>
            )}
            {isAdmin && tab === 'keys' && (
              <>
                <Button onClick={() => setShowImportKey(true)}>{tr('导入私钥', 'Import Private Key')}</Button>
                <Button variant="primary" onClick={() => setShowGenKey(true)}>
                  <Plus className="h-4 w-4" />
                  <span>{tr('生成 Ed25519', 'Generate Ed25519')}</span>
                </Button>
              </>
            )}
          </>
        }
      />

      <SectionTabs
        tabs={[
          { id: 'nodes', label: tr('主机节点', 'Host Nodes'), badge: nodes.length },
          {
            id: 'keys',
            label: tr('SSH 密钥库', 'SSH Keys'),
            badge: keys.length,
            tip: tr('控制面使用 Ed25519 私钥免密登录目标主机（首次连接支持 TOFU 主机指纹信任）。', 'The control plane uses Ed25519 private keys to access managed hosts (TOFU host key pinning on first connect).'),
          },
        ]}
        active={tab}
        onChange={setTab}
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {tab === 'nodes' && (
        <div className="space-y-4">
          {nodes.length > 0 && (() => {
            const onlineCount = nodes.filter((n) => n.status === 'online').length;
            const dockerReadyCount = nodes.filter((n) => n.docker_status === 'running' || n.docker_status === 'active').length;
            const totalCPU = nodes.reduce((sum, n) => sum + (Number(n.cpu_cores) || 0), 0);
            const totalMem = nodes.reduce((sum, n) => sum + (Number(n.mem_total_bytes) || 0), 0);
            return (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="rounded-xl border border-[#e3e8f1] bg-white px-4 py-3 dark:border-slate-800/90 dark:bg-[#0f172a]/95">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{tr('主机在线状态', 'Hosts Online')}</div>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <span className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{onlineCount}</span>
                    <span className="text-xs text-slate-400">{tr(`/ ${nodes.length} 台在线`, `/ ${nodes.length} online`)}</span>
                  </div>
                </div>
                <div className="rounded-xl border border-[#e3e8f1] bg-white px-4 py-3 dark:border-slate-800/90 dark:bg-[#0f172a]/95">
                  <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                    <span>{tr('Docker 运行环境', 'Docker Runtime')}</span>
                    <Link to="/docker" className="text-indigo-600 hover:underline dark:text-indigo-400">
                      {tr('管理中心 →', 'Console →')}
                    </Link>
                  </div>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <span className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{dockerReadyCount}</span>
                    <span className="text-xs text-slate-400">{tr(`/ ${nodes.length} 台就绪`, `/ ${nodes.length} ready`)}</span>
                  </div>
                </div>
                <div className="rounded-xl border border-[#e3e8f1] bg-white px-4 py-3 dark:border-slate-800/90 dark:bg-[#0f172a]/95">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{tr('CPU 核心汇总', 'Total CPU Cores')}</div>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <span className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{totalCPU}</span>
                    <span className="text-xs text-slate-400">vCPU</span>
                  </div>
                </div>
                <div className="rounded-xl border border-[#e3e8f1] bg-white px-4 py-3 dark:border-slate-800/90 dark:bg-[#0f172a]/95">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{tr('内存容量汇总', 'Total Memory')}</div>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <span className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                      {totalMem > 0 ? fmtBytes(totalMem) : '-'}
                    </span>
                  </div>
                </div>
              </div>
            );
          })()}

        <Card>
          {nodes.length === 0 ? (
            (() => {
              const defKey = keys.find((k) => k.is_default) || keys[0];
              const authCmd = setupCommandForKey(defKey);
              return (
                <div className="space-y-6 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{tr('接入你的第一台 Linux 主机', 'Enroll Your First Linux Host')}</h2>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        {tr('控制面通过 SSH 管理集群。1 台主机即可单机体验，准备 3 台主机可组建高可用集群。', 'The control plane manages clusters via SSH. 1 host is enough for single-node testing; 3 hosts enable HA clusters.')}
                      </p>
                    </div>
                    {isAdmin && (
                      <Button variant="primary" onClick={openAddNode}>
                        <Plus className="h-4 w-4" />
                        <span>{tr('新增第一台主机', 'Add First Host')}</span>
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3 text-xs">
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-4 space-y-2">
                      <div className="font-semibold text-indigo-600 dark:text-indigo-300">{tr('1. 准备 SSH 授权', '1. Prepare SSH Auth')}</div>
                      <p className="leading-5 text-slate-500 dark:text-slate-400">
                        {defKey
                          ? tr(`已就绪默认密钥「${defKey.name}」。有密码可在新增主机时选填一次性密码自动推送；无密码请复制下方授权命令到目标机执行。`, `Default key "${defKey.name}" is ready. Enter a one-time SSH password when adding a host to push it automatically, or run the command below manually.`)
                          : tr('前往「SSH 密钥库」生成或导入私钥。', 'Go to the "SSH Keys" tab to generate or import a key.')}
                      </p>
                      {defKey && (
                        <Button size="sm" onClick={() => copyText(authCmd, tr('已复制目标主机授权命令', 'Copied host setup command'))}>
                          <Copy className="h-3 w-3" /> {tr('复制授权命令', 'Copy Setup Command')}
                        </Button>
                      )}
                    </div>
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-4 space-y-1.5">
                      <div className="font-semibold text-indigo-600 dark:text-indigo-300">{tr('2. 登记主机地址', '2. Register Host')}</div>
                      <p className="leading-5 text-slate-500 dark:text-slate-400">
                        {tr('点击右上角「新增第一台主机」，填入主机名称、IP 或域名及 SSH 用户；有一次性密码也可一并填入推送公钥。', 'Click "Add First Host" and enter name, IP/hostname, and SSH user; optionally provide a one-time password to push the key.')}
                      </p>
                    </div>
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-4 space-y-1.5">
                      <div className="font-semibold text-indigo-600 dark:text-indigo-300">{tr('3. 自动探测与建群', '3. Auto Probe & Deploy')}</div>
                      <p className="leading-5 text-slate-500 dark:text-slate-400">
                        {tr('保存后将自动探测系统、内存与时间同步；确认「在线」后即可前往创建 Nomad 或 Vault 集群。', 'OS, memory, and clock sync are probed automatically. Once Online, proceed to create Nomad or Vault clusters.')}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                    <th className="py-2.5 pr-4">{tr('主机 / SSH 地址', 'Host / SSH')}</th>
                    <th className="py-2.5 pr-4">{tr('状态', 'Status')}</th>
                    <th className="py-2.5 pr-4 min-w-[190px]">{tr('CPU / 内存利用率', 'CPU / Memory')}</th>
                    <th className="py-2.5 pr-4">{tr('系统 / 内核', 'OS / Kernel')}</th>
                    <th className="py-2.5 pr-4">Docker</th>
                    <th className="py-2.5 text-right">{tr('操作', 'Actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {nodes.map((n) => {
                    const cpuPct = typeof n.cpu_percent === 'number' && n.cpu_percent >= 0 ? n.cpu_percent : null;
                    const memPct = typeof n.mem_percent === 'number' && n.mem_percent >= 0 ? n.mem_percent : null;
                    const dockerModeLabel = dockerModeLabelOf(n.docker_mode, locale);
                    const dockerStatusLabel = dockerStatusLabelOf(n.docker_status, locale);
                    const osDisplay = formatHostOS(n.os_info, n.arch);
                    return (
                    <tr key={n.id}>
                      <td className="py-3.5 pr-4">
                        <div className="flex flex-wrap items-center gap-1.5 font-medium">
                          <ServerIcon className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                          <button
                            type="button"
                            onClick={() => void openNodeDetail(n)}
                            className="text-left text-[13px] font-semibold text-slate-900 hover:text-indigo-600 hover:underline underline-offset-2 dark:text-slate-100 dark:hover:text-indigo-400"
                          >
                            {n.name}
                          </button>
                          {n.is_control_plane_host && (
                            <span className="inline-flex items-center gap-0.5">
                              <Badge tone="amber">{tr('控制面同机', 'Control Plane Host')}</Badge>
                              <InfoTip
                                text={
                                  n.control_plane_in_docker
                                    ? tr(
                                        '该主机与 NomadDeck 控制面同机，且当前控制面运行在 Docker 容器中：请勿在本页重装或重启该主机 Docker，否则会中断控制面服务；组成多节点集群时，请在集群配置中将集群通信地址（advertise_addr）设为真实内网 IP 而非 127.0.0.1。',
                                        'Co-located with NomadDeck control plane running inside a Docker container: do not reinstall or restart Docker here, as it will interrupt the control plane; use a real private IP (not 127.0.0.1) for advertise_addr in multi-node clusters.',
                                      )
                                    : tr(
                                        '该主机与 NomadDeck 控制面同机：组成多节点集群时，请在集群配置中将集群通信地址（advertise_addr）设为真实内网 IP 而非 127.0.0.1。',
                                        'Co-located with NomadDeck control plane: use a real private IP (not 127.0.0.1) for advertise_addr in multi-node clusters.',
                                      )
                                }
                              />
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500 mt-0.5 whitespace-nowrap">
                          {n.ssh_user}@{n.host}:{n.ssh_port}
                        </div>
                      </td>
                      <td className="py-3.5 pr-4 whitespace-nowrap">
                        <StatusBadge value={n.status || 'unknown'} />
                        {n.status === 'online' && (n.time_sync === 'unsynced' || n.time_sync === 'skewed') && (
                          <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{tr('待校时', 'Clock Skew')}</div>
                        )}
                      </td>
                      <td className="py-3.5 pr-4 min-w-[190px]">
                        <div className="space-y-1.5 text-[11px]">
                          <div>
                            <div className="flex items-center justify-between gap-2 whitespace-nowrap">
                              <span className="text-slate-500">CPU{n.cpu_cores > 0 ? ` · ${n.cpu_cores}C` : ''}</span>
                              <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">{cpuPct !== null ? `${cpuPct.toFixed(1)}%` : '-'}</span>
                            </div>
                            <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                              <div
                                className={`h-full rounded-full ${cpuPct !== null && cpuPct >= 85 ? 'bg-rose-500' : cpuPct !== null && cpuPct >= 65 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                                style={{ width: `${Math.min(100, Math.max(0, cpuPct ?? 0))}%` }}
                              />
                            </div>
                          </div>
                          <div>
                            <div className="flex items-center justify-between gap-2 whitespace-nowrap">
                              <span className="text-slate-500 tabular-nums">
                                {tr('内存', 'Mem')}{n.mem_total_bytes > 0 ? ` ${formatCompactBytes(n.mem_used_bytes)}/${formatCompactBytes(n.mem_total_bytes)}` : ''}
                              </span>
                              <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">{memPct !== null ? `${memPct.toFixed(1)}%` : '-'}</span>
                            </div>
                            <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                              <div
                                className={`h-full rounded-full ${memPct !== null && memPct >= 85 ? 'bg-rose-500' : memPct !== null && memPct >= 65 ? 'bg-amber-500' : 'bg-sky-500'}`}
                                style={{ width: `${Math.min(100, Math.max(0, memPct ?? 0))}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 pr-4 max-w-[220px]">
                        <div className="truncate font-medium text-slate-800 dark:text-slate-200" title={n.os_info || ''}>
                          {osDisplay.primary}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-slate-500" title={`${n.os_info || ''} (${n.arch || ''})`}>
                          {osDisplay.secondary}
                        </div>
                      </td>
                      <td className="py-3.5 pr-4 whitespace-nowrap">
                        <div>
                          <div className="flex items-center gap-1.5">
                            <Badge tone={n.docker_mode === 'absent' ? 'neutral' : 'blue'}>{dockerModeLabel}</Badge>
                            {n.docker_version && <span className="font-mono text-[11px] text-slate-600 dark:text-slate-300">{n.docker_version}</span>}
                          </div>
                          {dockerStatusLabel && (
                            <div className="mt-0.5 text-[11px] text-slate-500">{dockerStatusLabel}</div>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 text-right">
                        <div className="relative inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
                          {isAdmin && n.status !== 'online' && (
                            <Button size="sm" variant="primary" onClick={() => openPushModal(n)}>
                              {tr('推送公钥', 'Push Key')}
                            </Button>
                          )}
                          <Button size="sm" onClick={() => void openNodeDetail(n)}>
                            {tr('详情', 'Details')}
                          </Button>
                          {isAdmin && (
                            <Button size="sm" onClick={() => void testNode(n)}>
                              {tr('测试连接', 'Test SSH')}
                            </Button>
                          )}
                          {isAdmin && (
                            <>
                            <Button
                              size="sm"
                              aria-label={tr(`更多操作：${n.name}`, `More actions: ${n.name}`)}
                              aria-expanded={openMenu?.id === n.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                const rect = e.currentTarget.getBoundingClientRect();
                                const flipUp = rect.bottom + 260 > window.innerHeight;
                                const top = flipUp ? Math.max(8, rect.top - 248) : rect.bottom + 6;
                                const right = Math.max(8, window.innerWidth - rect.right);
                                setOpenMenu((cur) => (cur?.id === n.id ? null : { id: n.id, top, right }));
                              }}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </Button>
                            {openMenu && openMenu.id === n.id && createPortal(
                              <div
                                role="menu"
                                onClick={(e) => e.stopPropagation()}
                                style={{ top: openMenu.top, right: openMenu.right }}
                                className="fixed z-50 flex w-44 flex-col gap-0.5 rounded-xl border border-slate-200 bg-white p-1.5 text-left shadow-xl dark:border-slate-700 dark:bg-slate-900"
                              >
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { setOpenMenu(null); void openDocker(n); }}
                                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                  {tr('Docker 管理', 'Manage Docker')}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { setOpenMenu(null); openEditNode(n); }}
                                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                  {tr('编辑主机', 'Edit Host')}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { setOpenMenu(null); void refreshNodeMetrics(n); }}
                                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                  {tr('采集实时负载', 'Refresh Metrics')}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { setOpenMenu(null); openPushModal(n); }}
                                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                  {tr('推送 SSH 公钥', 'Push SSH Key')}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { setOpenMenu(null); setPwResetNode(n); }}
                                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                  {tr('重置主机指纹', 'Reset Fingerprint')}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  disabled={Boolean(n.is_control_plane_host) || resettingMidId === n.id}
                                  title={n.is_control_plane_host ? tr('控制面同机不支持通过页面重置', 'Cannot reset on control-plane host') : undefined}
                                  onClick={() => { setOpenMenu(null); void resetNodeMachineID(n); }}
                                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                  {tr('重新生成节点 ID', 'Regenerate Machine ID')}
                                </button>
                                <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={async () => {
                                    setOpenMenu(null);
                                    if (
                                      !(await askConfirm(tr(`确定要删除主机「${n.name}」(${n.host}) 吗？`, `Delete host "${n.name}" (${n.host})?`), {
                                        title: tr('删除主机节点', 'Delete Host'),
                                        confirmText: tr('确认删除', 'Delete'),
                                        danger: true,
                                      }))
                                    ) {
                                      return;
                                    }
                                    void apiDelete(`/api/v1/nodes/${n.id}`)
                                      .then(() => {
                                        toast.success(tr(`已删除主机 ${n.name}`, `Deleted host ${n.name}`));
                                        if (detailNode?.id === n.id) closeDetailDrawer();
                                        return load();
                                      })
                                      .catch((ex) => toast.error(ex.message));
                                  }}
                                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                                >
                                  {tr('删除主机', 'Delete Host')}
                                </button>
                              </div>,
                              document.body
                            )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        </div>
      )}

      {tab === 'keys' && (
        <Card>
          {keys.length === 0 ? (
            <EmptyState icon={<KeyRound className="h-6 w-6" />} title={tr('先准备一把 SSH 密钥', 'Set Up an SSH Key First')} description={tr('已有免密登录私钥可直接导入；也可以生成新密钥，再向主机推送公钥。', 'Import an existing private key or generate a new Ed25519 key pair to push to hosts.')} action={isAdmin && <div className="flex flex-wrap gap-2 justify-center"><Button onClick={() => { setErr(''); setShowImportKey(true); }}>{tr('导入已有私钥', 'Import Private Key')}</Button><Button variant="primary" onClick={() => { setErr(''); setShowGenKey(true); }}>{tr('生成新密钥', 'Generate Key')}</Button></div>} />
          ) : (
            <div className="space-y-3">
              {keys.map((k) => (
                <div
                  key={k.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 p-3 text-xs dark:border-slate-800"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <KeyRound className="h-3.5 w-3.5 text-indigo-500" />
                      <span className="font-semibold text-sm">{k.name}</span>
                      <Badge>{k.algorithm}</Badge>
                      {k.is_default && <Badge tone="green">{tr('默认', 'Default')}</Badge>}
                    </div>
                    <div className="font-mono text-slate-500">
                      {tr('指纹：', 'Fingerprint: ')}{k.fingerprint} · {tr('创建于 ', 'Created ')}{fmtTime(k.created_at, locale)}
                    </div>
                    <div className="truncate font-mono text-[11px] text-slate-500">{k.public_key}</div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      onClick={() => copyText(k.public_key, tr('已复制公钥', 'Copied public key'))}
                    >
                      <Copy className="h-3 w-3" /> {tr('复制公钥', 'Copy Public Key')}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        copyText(
                          setupCommandForKey(k),
                          tr('已复制目标机配置命令', 'Copied host setup command'),
                        )
                      }
                    >
                      {tr('复制授权命令', 'Copy Setup Command')}
                    </Button>
                    {isAdmin && !k.is_default && (
                      <Button
                        size="sm"
                        onClick={() =>
                          void apiPut(`/api/v1/ssh-keys/${k.id}/default`)
                            .then(() => load())
                            .catch((ex) => setErr(ex.message))
                        }
                      >
                        {tr('设为默认', 'Set Default')}
                      </Button>
                    )}
                    {isAdmin && (
                      <Button
                        size="sm"
                        variant="danger-outline"
                        onClick={async () => {
                          if (
                            !(await askConfirm(tr(`确定要删除 SSH 密钥「${k.name}」吗？`, `Delete SSH key "${k.name}"?`), {
                              title: tr('删除 SSH 密钥', 'Delete SSH Key'),
                              confirmText: tr('确认删除', 'Delete'),
                              danger: true,
                            }))
                          ) {
                            return;
                          }
                          void apiDelete(`/api/v1/ssh-keys/${k.id}`)
                            .then(() => {
                              toast.success(tr(`已删除 SSH 密钥 ${k.name}`, `Deleted SSH key ${k.name}`));
                              return load();
                            })
                            .catch((ex) => toast.error(ex.message));
                        }}
                      >
                        {tr('删除', 'Delete')}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Generate SSH key modal */}
      <Modal open={showGenKey} title={tr('生成 Ed25519 SSH 密钥对', 'Generate Ed25519 SSH Key Pair')} busy={formBusy} onClose={() => setShowGenKey(false)}>
        <form onSubmit={generateKey} className="space-y-4">
          <ErrorAlert message={err} onClose={() => setErr('')} />
          <Input label={tr('密钥名称', 'Key Name')} required value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button type="button" disabled={formBusy} onClick={() => setShowGenKey(false)}>{tr('取消', 'Cancel')}</Button>
            <Button type="submit" variant="primary" loading={formBusy}>{tr('生成', 'Generate')}</Button>
          </div>
        </form>
      </Modal>

      {/* Import SSH key modal */}
      <Modal open={showImportKey} title={tr('导入现有 SSH 私钥', 'Import Existing SSH Private Key')} busy={formBusy} onClose={() => setShowImportKey(false)}>
        <form onSubmit={importKey} className="space-y-4">
          <ErrorAlert message={err} onClose={() => setErr('')} />
          <Input label={tr('密钥名称', 'Key Name')} required value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          <label className="block space-y-1">
            <span className="block text-xs font-medium">{tr('私钥 PEM/OpenSSH 原文（无口令）', 'Private Key PEM/OpenSSH (no passphrase)')}</span>
            <textarea
              required
              rows={6}
              value={privPEM}
              onChange={(e) => setPrivPEM(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" disabled={formBusy} onClick={() => setShowImportKey(false)}>{tr('取消', 'Cancel')}</Button>
            <Button type="submit" variant="primary" loading={formBusy}>{tr('导入', 'Import')}</Button>
          </div>
        </form>
      </Modal>

      {/* Create/Edit Node modal */}
      {(() => {
        const selectedKey = keys.find((k) => k.id === nodeForm.ssh_key_id) || keys.find((k) => k.is_default) || keys[0];
        const selectedKeyCmd = setupCommandForKey(selectedKey);
        const submitLabel =
          oneTimePassword !== ''
            ? saveAndTest
              ? tr('保存、推送公钥并测试', 'Save, Push Key & Test')
              : tr('保存并推送公钥', 'Save & Push Key')
            : saveAndTest
              ? tr('保存并测试连接', 'Save & Test SSH')
              : tr('保存', 'Save');
        const authSetupSection = selectedKey && (
          <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-950/40">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">{tr('SSH 公钥认证准备', 'SSH Public Key Setup')}</span>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">{tr('支持一次性密码自动推送，或无密码手动配置', 'Auto-push via one-time password, or configure manually')}</span>
            </div>
            <SecretInput
              label={tr('一次性 SSH 密码（可选，用于自动推送公钥）', 'One-Time SSH Password (optional, auto-pushes public key)')}
              placeholder={tr('有密码可在此填写；无密码或已授权请留空', 'Enter if password login is enabled; leave blank otherwise')}
              autoComplete="new-password"
              resetKey={`${showNodeModal}:${editingNode?.id || 'new'}`}
              value={oneTimePassword}
              onChangeValue={setOneTimePassword}
              hint={tr('仅本次在内存中使用以写入目标主机 ~/.ssh/authorized_keys，不会保存或记入审计日志。', 'Used in memory once to append to ~/.ssh/authorized_keys; never persisted or logged.')}
            />
            <div className="space-y-2 rounded-lg border border-slate-200/90 bg-white px-3 py-2.5 text-xs dark:border-slate-800 dark:bg-slate-900/70">
              <p className="leading-5 text-slate-600 dark:text-slate-300">
                {oneTimePassword !== ''
                  ? tr(`已填写一次性密码，保存时将自动推送密钥「${selectedKey.name}」的公钥。`, `One-time password provided — key "${selectedKey.name}" will be pushed on save.`)
                  : tr(`机器没有密码或已禁用密码登录？请先在目标主机执行授权命令，或手动配置密钥「${selectedKey.name}」的公钥：`, `No password or password login disabled? Run the setup command on the host first or add "${selectedKey.name}" manually:`)}
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Button type="button" size="sm" onClick={() => copyText(selectedKeyCmd, tr('已复制目标主机授权命令', 'Copied host setup command'))}>
                  <Copy className="h-3 w-3" /> {tr('复制授权命令', 'Copy Setup Command')}
                </Button>
                <Button type="button" size="sm" onClick={() => copyText(selectedKey.public_key, tr('已复制公钥', 'Copied public key'))}>
                  <Copy className="h-3 w-3" /> {tr('复制公钥', 'Copy Public Key')}
                </Button>
              </div>
              <details className="pt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                <summary className="cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-200">
                  {tr('查看手动授权命令', 'Show manual setup command')}
                </summary>
                <code className="mt-1.5 block select-all break-all rounded-lg bg-slate-900 p-2.5 font-mono text-[11px] leading-relaxed text-slate-100 dark:bg-slate-950">
                  {selectedKeyCmd}
                </code>
              </details>
            </div>
          </div>
        );

        return (
          <Modal
            open={showNodeModal}
            title={editingNode ? tr('编辑主机', 'Edit Host') : tr('新增 Linux 主机', 'Add Linux Host')}
            busy={formBusy}
            onClose={closeNodeModal}
            footer={
              <div className="flex justify-end gap-2">
                <Button type="button" disabled={formBusy} onClick={closeNodeModal}>{tr('取消', 'Cancel')}</Button>
                <Button type="submit" form="node-form" variant="primary" loading={formBusy}>{submitLabel}</Button>
              </div>
            }
          >
            <form id="node-form" onSubmit={saveNode} className="space-y-3.5">
              <ErrorAlert message={nodeModalErr} onClose={() => setNodeModalErr('')} />
              <Input label={tr('主机名称', 'Host Name')} required placeholder={tr('例如 node-1', 'e.g. node-1')} value={nodeForm.name} onChange={(e) => setNodeForm({ ...nodeForm, name: e.target.value })} />
              <div className="grid grid-cols-3 gap-2.5">
                <div className="col-span-2">
                  <Input label={tr('主机地址 (IP/域名)', 'Host Address (IP / Domain)')} required placeholder={tr('例如 10.0.1.10', 'e.g. 10.0.1.10')} value={nodeForm.host} onChange={(e) => setNodeForm({ ...nodeForm, host: e.target.value })} />
                </div>
                <Input
                  label={tr('SSH 端口', 'SSH Port')}
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={nodeForm.ssh_port}
                  onChange={(e) => setNodeForm({ ...nodeForm, ssh_port: Number(e.target.value) })}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input label={tr('SSH 用户', 'SSH User')} autoComplete="off" required placeholder="root" value={nodeForm.ssh_user} onChange={(e) => setNodeForm({ ...nodeForm, ssh_user: e.target.value })} />
                <Select label={tr('SSH 密钥', 'SSH Key')} value={nodeForm.ssh_key_id} onChange={(e) => setNodeForm({ ...nodeForm, ssh_key_id: e.target.value })}>
                  {keys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
                </Select>
              </div>
              {editingNode?.status === 'online' ? (
                <details className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <summary className="cursor-pointer select-none text-xs font-medium text-slate-700 dark:text-slate-300">
                    {tr('重新推送或手动配置 SSH 公钥（可选）', 'Re-push or manually configure SSH public key (optional)')}
                  </summary>
                  <div className="mt-3">{authSetupSection}</div>
                </details>
              ) : (
                authSetupSection
              )}
              <div className="space-y-2 pt-0.5">
                {nodeForm.ssh_user.trim() !== 'root' ? (
                  <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={nodeForm.use_sudo}
                      onChange={(e) => setNodeForm({ ...nodeForm, use_sudo: e.target.checked })}
                    />
                    <span>{tr('使用免密 sudo（非 root 用户安装服务时需要）', 'Use passwordless sudo (required for non-root installation)')}</span>
                  </label>
                ) : (
                  <p className="text-xs text-slate-500 dark:text-slate-400">{tr('当前使用 root 登录，将直接管理服务，无需 sudo 提权。', 'Connecting as root — services are managed directly without sudo.')}</p>
                )}
                <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={saveAndTest}
                    onChange={(e) => setSaveAndTest(e.target.checked)}
                  />
                  <span>{tr('保存后立即测试 SSH 连接并探测环境', 'Test SSH connection and probe host after saving')}</span>
                </label>
              </div>
              <Input label={tr('备注（可选）', 'Notes (optional)')} placeholder={tr('用途说明或机房位置', 'Role notes or rack location')} value={nodeForm.notes} onChange={(e) => setNodeForm({ ...nodeForm, notes: e.target.value })} />
            </form>
          </Modal>
        );
      })()}

      {/* Push key modal */}
      {(() => {
        const pushTargetKey = keys.find((k) => k.id === pushNode?.ssh_key_id) || keys.find((k) => k.is_default) || keys[0];
        const pushTargetCmd = setupCommandForKey(pushTargetKey);
        return (
          <Modal open={Boolean(pushNode)} title={tr(`推送公钥到 ${pushNode?.name}`, `Push Public Key to ${pushNode?.name}`)} busy={formBusy} onClose={closePushModal}>
            <form onSubmit={doPushKey} className="space-y-4">
              <ErrorAlert message={pushModalErr} onClose={() => setPushModalErr('')} />
              <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
                {tr(
                  <>使用一次性 SSH 密码将关联密钥{pushTargetKey ? `「${pushTargetKey.name}」` : ''}的公钥幂等写入目标主机 <code className="font-mono">~/.ssh/authorized_keys</code>，密码仅在内存使用，不入库、不记审计。</>,
                  <>Use a one-time SSH password to idempotently add key {pushTargetKey ? `"${pushTargetKey.name}"` : ''} to <code className="font-mono">~/.ssh/authorized_keys</code>. The password is only kept in memory and never stored or audited.</>,
                )}
              </p>
              <SecretInput
                label={tr('目标主机一次性 SSH 密码', 'One-Time SSH Password')}
                required
                autoComplete="new-password"
                resetKey={pushNode?.id || ''}
                value={pushPassword}
                onChangeValue={setPushPassword}
              />
              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={pushAndTest}
                  onChange={(e) => setPushAndTest(e.target.checked)}
                />
                <span>{tr('推送成功后立即测试 SSH 连接并探测环境', 'Test SSH connection and probe host after pushing')}</span>
              </label>
              {pushTargetKey && (
                <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-xs dark:border-slate-800 dark:bg-slate-950/40">
                  <p className="text-slate-500 dark:text-slate-400">
                    {tr('目标主机没有密码或禁用密码登录？可复制命令手动配置公钥：', 'No password or password login disabled? Copy the command to configure manually:')}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <Button type="button" size="sm" onClick={() => copyText(pushTargetCmd, tr('已复制目标主机授权命令', 'Copied host setup command'))}>
                      <Copy className="h-3 w-3" /> {tr('复制授权命令', 'Copy Setup Command')}
                    </Button>
                    <Button type="button" size="sm" onClick={() => copyText(pushTargetKey.public_key, tr('已复制公钥', 'Copied public key'))}>
                      <Copy className="h-3 w-3" /> {tr('复制公钥', 'Copy Public Key')}
                    </Button>
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" disabled={formBusy} onClick={closePushModal}>{tr('取消', 'Cancel')}</Button>
                <Button type="submit" variant="primary" loading={formBusy}>{tr('推送公钥', 'Push Key')}</Button>
              </div>
            </form>
          </Modal>
        );
      })()}

      <DockerManageModal node={dockerNode} onClose={() => setDockerNode(null)} onTaskSubmitted={load} />

      <PasswordConfirmModal
        open={Boolean(pwResetNode)}
        title={tr(`重置主机指纹：${pwResetNode?.name || ''}`, `Reset Host Fingerprint: ${pwResetNode?.name || ''}`)}
        description={tr('重置后下次连接将重新通过 TOFU 固定该节点公钥指纹。', 'The next SSH connection will re-pin this node’s host key fingerprint via TOFU.')}
        onClose={() => setPwResetNode(null)}
        onConfirm={async (pw) => {
          if (!pwResetNode) return;
          const target = pwResetNode;
          await apiPost(`/api/v1/nodes/${target.id}/reset-fingerprint`, { current_password: pw });
          toast.success(tr(`已重置 ${target.name} 主机指纹`, `Reset host fingerprint for ${target.name}`), { position: 'top-right' });
          await load();
          if (detailNode?.id === target.id) {
            void openNodeDetail(target);
          }
        }}
      />

      {detailNode && (() => {
        const dn = detailNode;
        const dp = detailProbe && typeof detailProbe === 'object' ? detailProbe : null;
        const sshKeyObj = keys.find((k) => k.id === dn.ssh_key_id);
        const cpuPct = typeof dn.cpu_percent === 'number' && dn.cpu_percent >= 0 ? dn.cpu_percent : null;
        const memPct = typeof dn.mem_percent === 'number' && dn.mem_percent >= 0 ? dn.mem_percent : null;
        const missingTools: string[] = Array.isArray(dp?.missing_tools) ? dp.missing_tools : [];
        const aliases: string[] = Array.isArray(dn.address_aliases) ? dn.address_aliases : [];
        const optWritable = typeof dp?.opt_writable === 'boolean' ? dp.opt_writable : null;
        const swapEncrypted = typeof dp?.swap_encrypted === 'boolean' ? dp.swap_encrypted : null;
        const isRootUser = dn.ssh_user === 'root' || dp?.is_root === true;
        return (
          <Drawer
            title={
              <>
                <ServerIcon className="h-4 w-4 text-indigo-500 shrink-0" />
                <span className="truncate">{dn.name}</span>
                <StatusBadge value={dn.status || 'unknown'} />
                {dn.is_control_plane_host && <Badge tone="amber">{tr('控制面同机', 'Control Plane Host')}</Badge>}
              </>
            }
            subtitle={`${dn.ssh_user}@${dn.host}:${dn.ssh_port} · ${dn.last_checked_at ? tr(`最近探测 ${fmtTime(dn.last_checked_at, locale)}`, `Last probed ${fmtTime(dn.last_checked_at, locale)}`) : tr('尚未探测', 'Not probed yet')}`}
            width="lg"
            onClose={closeDetailDrawer}
            headerExtra={
              isAdmin ? (
                <Button size="sm" loading={detailTesting} onClick={() => void testNode(dn)}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>{tr('重新探测', 'Re-probe')}</span>
                </Button>
              ) : undefined
            }
            footer={
              <div className="flex flex-wrap items-center justify-between gap-2 w-full">
                <div className="flex flex-wrap items-center gap-1.5">
                  {isAdmin && dn.status !== 'online' && (
                    <Button size="sm" onClick={() => openPushModal(dn)}>{tr('推送公钥', 'Push Key')}</Button>
                  )}
                  {isAdmin && (
                    <>
                      <Button size="sm" onClick={() => void refreshNodeMetrics(dn)}>{tr('采集负载', 'Metrics')}</Button>
                      <Button size="sm" onClick={() => void openDocker(dn)}>Docker</Button>
                      <Button size="sm" onClick={() => setPwResetNode(dn)}>{tr('重置指纹', 'Reset Key')}</Button>
                      <Button size="sm" onClick={() => openEditNode(dn)}>{tr('编辑主机', 'Edit Host')}</Button>
                    </>
                  )}
                </div>
                <Button size="sm" variant="primary" onClick={closeDetailDrawer}>{tr('关闭', 'Close')}</Button>
              </div>
            }
          >
            <div className="space-y-4 text-xs">
              {detailLoading && (
                <div className="text-slate-500 dark:text-slate-400">{tr('正在加载完整探测档案…', 'Loading full probe profile...')}</div>
              )}

              {detailWarnings.length > 0 ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-3.5 space-y-2.5 dark:border-amber-500/30 dark:bg-amber-500/10">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 font-semibold text-amber-800 dark:text-amber-300">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span>{tr(`环境预检提醒（${detailWarnings.length} 项）`, `Preflight Warnings (${detailWarnings.length})`)}</span>
                    </div>
                    {isAdmin && detailClonePeers.length > 0 && !dn.is_control_plane_host && (
                      <Button
                        size="sm"
                        variant="primary"
                        loading={resettingMidId === dn.id}
                        onClick={() => void resetNodeMachineID(dn, detailClonePeers)}
                      >
                        {tr('立即重新生成节点 ID', 'Regenerate Machine ID')}
                      </Button>
                    )}
                  </div>
                  <ul className="list-disc space-y-1 pl-5 text-amber-900 dark:text-amber-200 leading-5">
                    {detailWarnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                  {dn.swap_enabled && !swapEncrypted && (
                    <div className="rounded-lg border border-amber-300/70 bg-white/75 px-3 py-2 text-[11px] leading-5 text-amber-950 dark:border-amber-500/30 dark:bg-slate-950/50 dark:text-amber-100">
                      <div className="font-semibold">{tr('未加密 Swap 处理建议（仅部署 Vault 时涉及，只跑 Nomad 可忽略）：', 'Unencrypted Swap Recommendations (Vault only; Nomad ignores swap):')}</div>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">
                        <li>
                          <b>{tr('禁用 Swap（推荐）', 'Disable Swap (recommended)')}</b>{tr('：在目标主机执行 ', ': run ')}
                          <code className="rounded bg-amber-100 px-1 font-mono dark:bg-amber-950/60">sudo swapoff -a</code> {tr('并注释 ', 'and comment out ')}
                          <code className="rounded bg-amber-100 px-1 font-mono dark:bg-amber-950/60">/etc/fstab</code> {tr('中的 ', 'entries for ')}
                          <code className="rounded bg-amber-100 px-1 font-mono dark:bg-amber-950/60">swap</code> {tr('行（若有 zram 或 ', '(and disable any zram / ')}
                          <code className="rounded bg-amber-100 px-1 font-mono dark:bg-amber-950/60">.swap</code> {tr('服务一并停用），完成后点击右上角「重新探测」。', 'units), then click "Re-probe" above.')}
                        </li>
                        <li>
                          <b>{tr('改为加密 Swap', 'Use Encrypted Swap')}</b>{tr('：通过 ', ': mount via ')}
                          <code className="rounded bg-amber-100 px-1 font-mono dark:bg-amber-950/60">dm-crypt</code> /{' '}
                          <code className="rounded bg-amber-100 px-1 font-mono dark:bg-amber-950/60">cryptsetup</code> {tr('挂载为 ', 'on ')}
                          <code className="rounded bg-amber-100 px-1 font-mono dark:bg-amber-950/60">/dev/mapper/...</code>.
                        </li>
                        <li>
                          <b>{tr('测试环境兜底', 'Test Environment Override')}</b>{tr('：若暂不关闭，也可在部署或扩容 Vault 时勾选「确认未加密 Swap 风险」后继续。', ': check "Confirm unencrypted swap risk" when deploying or joining Vault nodes.')}
                        </li>
                      </ul>
                    </div>
                  )}
                </div>
              ) : dn.status === 'online' ? (
                <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/80 px-3.5 py-2.5 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>{tr('所有环境预检项均通过，可用于组建或扩展集群。', 'All preflight checks passed. Ready to provision or join clusters.')}</span>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-slate-600 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
                  {tr('该主机尚未连通或探测，可先推送/配置 SSH 公钥后点击右上角「重新探测」。', 'Host not yet connected or probed. Push or configure the SSH key first, then click "Re-probe".')}
                </div>
              )}

              <div className="rounded-xl border border-slate-200 p-4 space-y-3 dark:border-slate-800">
                <div className="font-semibold text-slate-900 dark:text-slate-100">{tr('实时资源与系统', 'Live Resources & OS')}</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="flex justify-between text-slate-500">
                      <span>CPU{dn.cpu_cores > 0 ? tr(` (${dn.cpu_cores} 核)`, ` (${dn.cpu_cores} cores)`) : ''}</span>
                      <span className="font-mono text-slate-800 dark:text-slate-200">{cpuPct !== null ? `${cpuPct.toFixed(1)}%` : '-'}</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
                      <div
                        className={`h-full ${cpuPct !== null && cpuPct >= 85 ? 'bg-rose-500' : cpuPct !== null && cpuPct >= 65 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${Math.min(100, Math.max(0, cpuPct ?? 0))}%` }}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-slate-500">
                      <span>{tr('内存', 'Memory')}{dn.mem_total_bytes > 0 ? ` (${fmtBytes(dn.mem_used_bytes)}/${fmtBytes(dn.mem_total_bytes)})` : ''}</span>
                      <span className="font-mono text-slate-800 dark:text-slate-200">{memPct !== null ? `${memPct.toFixed(1)}%` : '-'}</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
                      <div
                        className={`h-full ${memPct !== null && memPct >= 85 ? 'bg-rose-500' : memPct !== null && memPct >= 65 ? 'bg-amber-500' : 'bg-sky-500'}`}
                        style={{ width: `${Math.min(100, Math.max(0, memPct ?? 0))}%` }}
                      />
                    </div>
                  </div>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 pt-1 border-t border-slate-100 dark:border-slate-800">
                  <div>
                    <dt className="text-slate-500">{tr('操作系统', 'Operating System')}</dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100">{dn.os_info || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{tr('架构 / 家族', 'Arch / Family')}</dt>
                    <dd className="mt-0.5 font-mono text-slate-900 dark:text-slate-100">
                      {[dn.arch, dn.os_family, dn.os_codename].filter(Boolean).join(' · ') || '-'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{tr('内核版本', 'Kernel')}</dt>
                    <dd className="mt-0.5 font-mono text-slate-900 dark:text-slate-100">{dp?.kernel || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{tr('包管理器', 'Package Manager')}</dt>
                    <dd className="mt-0.5 font-mono text-slate-900 dark:text-slate-100">{dn.package_manager || '-'}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-slate-500">Docker Engine</dt>
                    <dd className="mt-0.5 flex flex-wrap items-center gap-2">
                      <Badge tone={dn.docker_mode === 'absent' ? 'neutral' : 'blue'}>{dockerModeLabelOf(dn.docker_mode, locale)}</Badge>
                      {dn.docker_version && <span className="font-mono text-slate-800 dark:text-slate-200">{dn.docker_version}</span>}
                      {dockerStatusLabelOf(dn.docker_status, locale) && <span className="text-slate-500">{dockerStatusLabelOf(dn.docker_status, locale)}</span>}
                      {dn.docker_mode && dn.docker_mode !== 'absent' && (
                        <Link
                          to={`/docker?tab=inspect&node=${encodeURIComponent(dn.id)}`}
                          onClick={closeDetailDrawer}
                          className="text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          {tr('巡检与清理 →', 'Inspect & Prune →')}
                        </Link>
                      )}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-xl border border-slate-200 p-4 space-y-3 dark:border-slate-800">
                <div className="font-semibold text-slate-900 dark:text-slate-100">{tr('环境预检明细', 'Preflight Check Details')}</div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                  <div>
                    <dt className="text-slate-500"><TermLabel term={tr('时间同步', 'Clock Sync')} tip={tr('Raft 一致性依赖各节点系统时间同步（chrony / systemd-timesyncd），偏差过大会导致选举抖动或 TLS 校验异常。', 'Raft consensus depends on synchronized clocks (chrony / systemd-timesyncd); large skew causes leader elections or TLS failures.')} /></dt>
                    <dd className={`mt-0.5 font-medium ${dn.time_sync === 'synced' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                      {timeSyncLabelOf(dn.time_sync, locale)} ({dn.clock_skew_ms ?? 0} ms)
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{tr('提权权限（sudo）', 'Privilege (sudo)')}</dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
                      {isRootUser ? tr('root 直连', 'Direct root') : dn.sudo_ready ? tr('免密 sudo 就绪', 'Passwordless sudo ready') : dn.use_sudo ? tr('未就绪（需 NOPASSWD）', 'Not ready (NOPASSWD needed)') : tr('未启用', 'Disabled')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{tr('SELinux 模式', 'SELinux Mode')}</dt>
                    <dd className="mt-0.5 font-mono text-slate-900 dark:text-slate-100">{dn.selinux_mode || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">
                      <TermLabel
                        term={tr('Swap 交换空间', 'Swap Memory')}
                        tip={tr('Vault 默认使用 disable_mlock，若启用未加密 Swap，内存中的密钥可能被换出到磁盘；仅部署 Nomad 可忽略。部署 Vault 建议执行 sudo swapoff -a 并注释 /etc/fstab 中的 swap 行，或改用 dm-crypt 加密 Swap。', 'Vault defaults to disable_mlock; unencrypted swap may page secrets to disk (ignored for Nomad-only nodes). Disable swap or use dm-crypt for Vault.')}
                      />
                    </dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
                      {dn.status === 'unknown' ? '-' : dn.swap_enabled ? (swapEncrypted ? tr('已启用（已加密）', 'Enabled (encrypted)') : tr('已启用（未加密）', 'Enabled (unencrypted)')) : tr('已禁用', 'Disabled')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{tr('/opt/nomad-deck 目录', '/opt/nomad-deck Dir')}</dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
                      {optWritable === null ? '-' : optWritable ? tr('可写', 'Writable') : tr('不可写', 'Not writable')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{tr('基础命令检查', 'Base Tools')}</dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
                      {dp ? (missingTools.length === 0 ? tr('完整', 'Complete') : tr(`缺少：${missingTools.join('、')}`, `Missing: ${missingTools.join(', ')}`)) : '-'}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-xl border border-slate-200 p-4 space-y-2.5 dark:border-slate-800">
                <div className="font-semibold text-slate-900 dark:text-slate-100">{tr('SSH 连接与节点身份', 'SSH Connection & Host Identity')}</div>
                <dl className="space-y-2.5">
                  <div>
                    <dt className="text-slate-500">{tr('SSH 密钥', 'SSH Key')}</dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100">{sshKeyObj?.name || dn.ssh_key_id || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{tr('主机公钥指纹（TOFU）', 'Host Key Fingerprint (TOFU)')}</dt>
                    <dd className="mt-0.5 font-mono break-all text-slate-800 dark:text-slate-200">
                      {dn.host_key_fingerprint || tr('尚未记录（首次连接时自动信任并固定）', 'Not recorded yet (pinned automatically on first connect)')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500"><TermLabel term={tr('节点 ID（/etc/machine-id）', 'Machine ID (/etc/machine-id)')} tip={tr('/etc/machine-id；控制面结合硬件 UUID、网卡 MAC 与主机指纹区分克隆虚拟机与重复登记。', '/etc/machine-id; combined with hardware UUID, MAC addresses, and host key to detect cloned VMs.')} /></dt>
                    <dd className="mt-0.5 flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono break-all text-slate-800 dark:text-slate-200">{dn.machine_id || '-'}</span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {dn.machine_id && (
                          <Button size="sm" onClick={() => copyText(dn.machine_id, tr('已复制节点 ID', 'Copied machine-id'))}>
                            <Copy className="h-3 w-3" /> {tr('复制', 'Copy')}
                          </Button>
                        )}
                        {isAdmin && !dn.is_control_plane_host && (
                          <Button
                            size="sm"
                            loading={resettingMidId === dn.id}
                            onClick={() => void resetNodeMachineID(dn, detailClonePeers)}
                          >
                            {tr('重新生成', 'Regenerate')}
                          </Button>
                        )}
                      </div>
                    </dd>
                  </div>
                  {(dp?.product_uuid || (Array.isArray(dp?.mac_addrs) && dp.mac_addrs.length > 0)) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div>
                        <dt className="text-slate-500">{tr('硬件 UUID', 'Hardware UUID')}</dt>
                        <dd className="mt-0.5 font-mono break-all text-slate-800 dark:text-slate-200">
                          {dp?.product_uuid || '-'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">{tr('网卡 MAC', 'MAC Addresses')}</dt>
                        <dd className="mt-0.5 font-mono break-all text-slate-800 dark:text-slate-200">
                          {Array.isArray(dp?.mac_addrs) && dp.mac_addrs.length > 0 ? dp.mac_addrs.join(isEn ? ', ' : '、') : '-'}
                        </dd>
                      </div>
                    </div>
                  )}
                  <div>
                    <dt className="text-slate-500">{tr('地址别名', 'Address Aliases')}</dt>
                    <dd className="mt-1 flex flex-wrap gap-1.5">
                      {aliases.length > 0 ? aliases.map((a) => <Badge key={a}>{a}</Badge>) : <span className="text-slate-500">-</span>}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{tr('备注', 'Notes')}</dt>
                    <dd className="mt-0.5 whitespace-pre-wrap text-slate-800 dark:text-slate-200">{dn.notes || '-'}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </Drawer>
        );
      })()}
    </div>
  );
}
