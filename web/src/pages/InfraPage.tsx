import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, AlertTriangle, CheckCircle2, Copy, KeyRound, MoreHorizontal, Plus, RefreshCw, Server as ServerIcon, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut, fmtBytes, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { copyText as copyToClipboard } from '../lib/clipboard';
import { useOpsDrawer } from '../lib/opsDrawer';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { Drawer } from '../components/Drawer';
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

function dockerModeLabelOf(mode?: string): string {
  if (mode === 'managed') return '托管';
  if (mode === 'external') return '外部';
  if (mode === 'absent') return '未安装';
  return mode || '-';
}

function dockerStatusLabelOf(status?: string): string {
  if (status === 'running' || status === 'active') return '运行中';
  if (status === 'absent') return '';
  return status || '';
}

function timeSyncLabelOf(sync?: string): string {
  if (sync === 'synced') return '已同步';
  if (sync === 'unsynced' || sync === 'skewed') return '待校时';
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
  const [dockerNode, setDockerNode] = useState<any>(null);
  const [dockerInfo, setDockerInfo] = useState<any>(null);
  const [dockerErr, setDockerErr] = useState('');
  const [dockerBusy, setDockerBusy] = useState(false);
  const [dockerVer, setDockerVer] = useState('');
  const [dockerUseProxy, setDockerUseProxy] = useState(false);
  const [dockerDrain, setDockerDrain] = useState(false);
  const [dockerConfirm, setDockerConfirm] = useState(false);
  const [dockerAllowInterruption, setDockerAllowInterruption] = useState(false);
  const [dockerCfg, setDockerCfg] = useState({
    registry_mirrors: '',
    use_system_proxy: false,
    proxy_url: '',
  });

  const load = useCallback(async () => {
    setErr('');
    try {
      const [kRes, nRes] = await Promise.all([apiGet('/api/v1/ssh-keys'), apiGet('/api/v1/nodes')]);
      setKeys(kRes.ssh_keys || []);
      setNodes(nRes.nodes || []);
    } catch (ex: any) {
      setErr(ex?.message || '加载基础设施信息失败');
    }
  }, []);

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
      setErr(ex?.message || '生成密钥失败');
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
      setErr(ex?.message || '导入密钥失败');
    } finally {
      setFormBusy(false);
    }
  };

  const openAddNode = () => {
    setErr('');
    setNodeModalErr('');
    if (keys.length === 0) {
      setTab('keys');
      toast.info('请先生成或导入 SSH 密钥，再添加主机');
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
      toast.error(ex?.message || `加载主机 ${node.name} 详情失败`, { position: 'top-right' });
    } finally {
      setDetailLoading(false);
    }
  }, [toast]);

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
          label: '查看详情',
          onClick: () => {
            void openNodeDetail(node, list, peers);
          },
        }
      : undefined;

    if (list.length === 0) {
      const title = options?.prefix
        ? `${options.prefix}，所有环境预检均通过`
        : `主机 ${name} 连接成功，所有环境预检均通过`;
      toast.success(title, {
        position: 'top-right',
        durationMs: 4500,
        action: viewAction,
      });
      return;
    }

    const preview = list.slice(0, 3);
    if (list.length > 3) {
      preview.push(`另有 ${list.length - 3} 项提醒，点击「查看详情」查看完整列表`);
    }
    const title = options?.prefix
      ? `${options.prefix}（发现 ${list.length} 项环境提醒）`
      : `主机 ${name} 连接成功，发现 ${list.length} 项环境提醒`;
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
      toast.error('当前主机与 NomadDeck 控制面同机，不支持通过页面重置 /etc/machine-id', { position: 'top-right' });
      return;
    }
    const peers = Array.isArray(clonePeers) ? clonePeers : [];
    const msg =
      peers.length > 0
        ? `检测到主机「${node.name}」与「${peers.join('、')}」共用相同的 /etc/machine-id（疑似克隆虚拟机）。\n\n是否立即通过 SSH 在目标主机上重新生成新的 /etc/machine-id 并重新探测？\n（提示：可能影响基于 machine-id 的 DHCP 租约与 journald 日志目录）`
        : `确定要在主机「${node.name}」(${node.host}) 上重新生成 /etc/machine-id 并重新探测吗？\n（提示：可能影响基于 machine-id 的 DHCP 租约与 journald 日志目录，建议在加入集群前操作）`;
    const ok = await askConfirm(msg, {
      title: '重新生成节点 ID',
      confirmText: '立即重新生成',
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
        prefix: `已为主机 ${updated.name} 重新生成节点 ID 并完成探测`,
        clonePeers: nextPeers,
      });
      await load();
    } catch (ex: any) {
      toast.error(ex?.message || `重新生成 ${node.name} 节点 ID 失败`, {
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
            `主机「${savedNode.name || nodeForm.name}」已保存，但${pushEx?.message || '推送公钥失败'}。请核对一次性密码重试，或留空密码改用手动配置公钥。`,
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
              ? `主机 ${testedNode.name || nodeForm.name} 已保存、推送公钥并连接成功`
              : `主机 ${testedNode.name || nodeForm.name} 已保存并连接成功`,
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
              ? `主机已保存并完成公钥推送，但探测未通过：${testEx?.message || '请检查主机网络或 SSH 配置'}`
              : `主机已保存，暂未连通：${testEx?.message || '请手动配置公钥或点击「推送公钥」后再测试连接'}`,
            { position: 'top-right', durationMs: 6000 },
          );
        }
      } else {
        toast.success(
          pushed
            ? `主机 ${savedNode?.name || nodeForm.name} 已保存并推送公钥`
            : `主机 ${savedNode?.name || nodeForm.name} 已保存`,
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
      setNodeModalErr(ex?.message || '保存主机失败');
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
      toast.error(`探测主机 ${n.name} 失败：${ex?.message || '连接异常'}`, {
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
            prefix: `已向 ${testedNode.name} 推送公钥并连接成功`,
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
            `已成功推送公钥到主机 ${targetNode.name}，但探测未通过：${testEx?.message || '请稍后重试测试连接'}`,
            { position: 'top-right', durationMs: 6000 },
          );
        }
      } else {
        toast.success(`已成功推送公钥到主机 ${targetNode.name}`, { position: 'top-right' });
      }
      await load();
      if (detectedCloneNode && detectedClonePeers.length > 0) {
        void resetNodeMachineID(detectedCloneNode, detectedClonePeers);
      }
    } catch (ex: any) {
      setPushModalErr(ex?.message || '推送公钥失败');
    } finally {
      setFormBusy(false);
    }
  };

  const openDocker = async (n: any) => {
    setDockerNode(n);
    setDockerInfo(null);
    setDockerErr('');
    setDockerBusy(true);
    try {
      const [res, defaults] = await Promise.all([apiGet(`/api/v1/nodes/${n.id}/docker`), apiGet('/api/v1/settings')]);
      setDockerVer(defaults.settings?.['defaults.docker_version'] || '');
      setDockerUseProxy(Boolean(defaults.settings?.['proxy.use_for_releases']));
      // Nomad's Docker driver can end tasks when the daemon connection closes.
      setDockerDrain(Boolean(res.docker?.cluster_id));
      setDockerConfirm(false);
      setDockerAllowInterruption(false);
      setDockerInfo(res.docker);
      const cfg = res.docker?.host_config || res.docker?.effective || {};
      setDockerCfg({
        registry_mirrors: (cfg.registry_mirrors || []).join(','),
        use_system_proxy: cfg.pull_proxy?.mode === 'system',
        proxy_url: cfg.pull_proxy?.url || '',
      });
    } catch (ex: any) {
      setDockerErr(ex?.message || '加载 Docker 信息失败');
    } finally {
      setDockerBusy(false);
    }
  };

  const runDockerAction = async (action: 'install' | 'upgrade' | 'adopt') => {
    if (!dockerNode || dockerBusy) return;
    setDockerErr('');
    setDockerBusy(true);
    try {
      const res = await apiPost(`/api/v1/nodes/${dockerNode.id}/docker/${action}`, {
        version: dockerVer.trim(),
        use_proxy: dockerUseProxy,
        drain: dockerDrain,
        confirm: dockerConfirm,
        allow_interruption: dockerAllowInterruption,
      });
      if (res.task?.id) {
        setDockerNode(null);
        openTask(res.task.id, `Docker ${action === 'install' ? '安装' : action === 'upgrade' ? '升级' : '转为托管'}：${dockerNode.name}`);
      }
    } catch (ex: any) {
      setDockerErr(ex?.message || `Docker ${action} 失败`);
    } finally {
      setDockerBusy(false);
    }
  };

  const saveDockerCfg = async () => {
    if (!dockerNode || dockerBusy) return;
    setDockerErr('');
    setDockerBusy(true);
    try {
      const mirrors = dockerCfg.registry_mirrors
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await apiPut(`/api/v1/nodes/${dockerNode.id}/docker/config`, {
        registry_mirrors: mirrors,
        pull_proxy: {
          mode: dockerCfg.use_system_proxy ? 'system' : (dockerCfg.proxy_url.trim() ? 'custom' : 'none'),
          url: dockerCfg.proxy_url.trim(),
        },
      });
      if (res.task?.id) {
        setDockerNode(null);
        openTask(res.task.id, `更新 Docker 配置：${dockerNode.name}`);
      }
    } catch (ex: any) {
      setDockerErr(ex?.message || '保存 Docker 配置失败');
    } finally {
      setDockerBusy(false);
    }
  };

  const testDockerProxy = async () => {
    if (!dockerNode || dockerBusy) return;
    setDockerErr('');
    setDockerBusy(true);
    try {
      const res = await apiPost(`/api/v1/nodes/${dockerNode.id}/docker/proxy-test`, {});
      toast.info(`镜像代理测试结果：${JSON.stringify(res.result)}`);
    } catch (ex: any) {
      setDockerErr(ex?.message || '代理测试失败');
    } finally {
      setDockerBusy(false);
    }
  };

  const copyText = (text: string, msg: string) => {
    void copyToClipboard(text)
      .then(() => toast.success(msg, { recordHistory: false }))
      .catch((ex) => toast.error(ex?.message || '复制失败'));
  };

  const refreshAllMetrics = async () => {
    setMetricsBusy(true);
    setErr('');
    try {
      const res = await apiPost('/api/v1/nodes/metrics/refresh', {});
      if (Array.isArray(res.nodes)) setNodes(res.nodes);
      toast.success(`主机实时负载采集完成：成功 ${res.ok ?? 0}，失败 ${res.failed ?? 0}`);
    } catch (ex: any) {
      setErr(ex?.message || '采集主机负载失败');
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
      toast.success(`已刷新 ${node.name} CPU/内存利用率`, { position: 'top-right' });
    } catch (ex: any) {
      toast.error(ex?.message || `采集 ${node.name} 负载失败`, { position: 'top-right' });
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="基础设施"
        subtitle="纳管 Linux 主机节点、SSH Ed25519 密钥库、主机体检与 Docker Engine 管理"
        actions={
          <>
            <Button onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" />
              <span>刷新</span>
            </Button>
            {isAdmin && tab === 'nodes' && (
              <>
                <Button disabled={metricsBusy || nodes.length === 0} onClick={() => void refreshAllMetrics()}>
                  <Activity className="h-4 w-4" />
                  <span>{metricsBusy ? '采集中...' : '采集实时负载'}</span>
                </Button>
                <Button variant="primary" onClick={openAddNode}>
                  <Plus className="h-4 w-4" />
                  <span>新增主机</span>
                </Button>
              </>
            )}
            {isAdmin && tab === 'keys' && (
              <>
                <Button onClick={() => setShowImportKey(true)}>导入私钥</Button>
                <Button variant="primary" onClick={() => setShowGenKey(true)}>
                  <Plus className="h-4 w-4" />
                  <span>生成 Ed25519</span>
                </Button>
              </>
            )}
          </>
        }
      />

      <SectionTabs
        tabs={[
          { id: 'nodes', label: '主机节点', badge: nodes.length },
          {
            id: 'keys',
            label: 'SSH 密钥库',
            badge: keys.length,
            tip: '控制面使用 Ed25519 私钥免密登录目标主机（首次连接支持 TOFU 主机指纹信任）。',
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
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">主机在线状态</div>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <span className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{onlineCount}</span>
                    <span className="text-xs text-slate-400">/ {nodes.length} 台在线</span>
                  </div>
                </div>
                <div className="rounded-xl border border-[#e3e8f1] bg-white px-4 py-3 dark:border-slate-800/90 dark:bg-[#0f172a]/95">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">Docker 运行环境</div>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <span className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{dockerReadyCount}</span>
                    <span className="text-xs text-slate-400">/ {nodes.length} 台就绪</span>
                  </div>
                </div>
                <div className="rounded-xl border border-[#e3e8f1] bg-white px-4 py-3 dark:border-slate-800/90 dark:bg-[#0f172a]/95">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">CPU 核心汇总</div>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <span className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{totalCPU}</span>
                    <span className="text-xs text-slate-400">vCPU</span>
                  </div>
                </div>
                <div className="rounded-xl border border-[#e3e8f1] bg-white px-4 py-3 dark:border-slate-800/90 dark:bg-[#0f172a]/95">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">内存容量汇总</div>
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
                      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">接入你的第一台 Linux 主机</h2>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        控制面通过 SSH 管理集群。1 台主机即可单机体验，准备 3 台主机可组建高可用集群。
                      </p>
                    </div>
                    {isAdmin && (
                      <Button variant="primary" onClick={openAddNode}>
                        <Plus className="h-4 w-4" />
                        <span>新增第一台主机</span>
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3 text-xs">
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-4 space-y-2">
                      <div className="font-semibold text-indigo-600 dark:text-indigo-300">1. 准备 SSH 授权</div>
                      <p className="leading-5 text-slate-500 dark:text-slate-400">
                        {defKey
                          ? `已就绪默认密钥「${defKey.name}」。有密码可在新增主机时选填一次性密码自动推送；无密码请复制下方授权命令到目标机执行。`
                          : '前往「SSH 密钥库」生成或导入私钥。'}
                      </p>
                      {defKey && (
                        <Button size="sm" onClick={() => copyText(authCmd, '已复制目标主机授权命令')}>
                          <Copy className="h-3 w-3" /> 复制授权命令
                        </Button>
                      )}
                    </div>
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-4 space-y-1.5">
                      <div className="font-semibold text-indigo-600 dark:text-indigo-300">2. 登记主机地址</div>
                      <p className="leading-5 text-slate-500 dark:text-slate-400">
                        点击右上角「新增第一台主机」，填入主机名称、IP 或域名及 SSH 用户；有一次性密码也可一并填入推送公钥。
                      </p>
                    </div>
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-4 space-y-1.5">
                      <div className="font-semibold text-indigo-600 dark:text-indigo-300">3. 自动探测与建群</div>
                      <p className="leading-5 text-slate-500 dark:text-slate-400">
                        保存后将自动探测系统、内存与时间同步；确认「在线」后即可前往创建 Nomad 或 Vault 集群。
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
                    <th className="py-2.5 pr-4">主机 / SSH 地址</th>
                    <th className="py-2.5 pr-4">状态</th>
                    <th className="py-2.5 pr-4 min-w-[190px]">CPU / 内存利用率</th>
                    <th className="py-2.5 pr-4">系统 / 内核</th>
                    <th className="py-2.5 pr-4">Docker</th>
                    <th className="py-2.5 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {nodes.map((n) => {
                    const cpuPct = typeof n.cpu_percent === 'number' && n.cpu_percent >= 0 ? n.cpu_percent : null;
                    const memPct = typeof n.mem_percent === 'number' && n.mem_percent >= 0 ? n.mem_percent : null;
                    const dockerModeLabel = dockerModeLabelOf(n.docker_mode);
                    const dockerStatusLabel = dockerStatusLabelOf(n.docker_status);
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
                              <Badge tone="amber">控制面同机</Badge>
                              <InfoTip text="该主机与 NomadDeck 控制面同机：若控制面运行在 Docker 容器中，请勿在本页重装或重启 Docker；组成多节点集群时 advertise_addr 请填写真实内网 IP 而非 127.0.0.1。" />
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
                          <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">待校时</div>
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
                                内存{n.mem_total_bytes > 0 ? ` ${formatCompactBytes(n.mem_used_bytes)}/${formatCompactBytes(n.mem_total_bytes)}` : ''}
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
                        {isAdmin ? (
                          <button
                            type="button"
                            onClick={() => void openDocker(n)}
                            title="点击管理或安装 Docker Engine"
                            className="group text-left rounded-lg border border-transparent px-2 py-1 -mx-2 hover:border-indigo-200 hover:bg-indigo-50/50 dark:hover:border-indigo-500/30 dark:hover:bg-indigo-500/10 transition"
                          >
                            <div className="flex items-center gap-1.5">
                              <Badge tone={n.docker_mode === 'absent' ? 'neutral' : 'blue'}>{dockerModeLabel}</Badge>
                              {n.docker_version && <span className="font-mono text-[11px] text-slate-600 dark:text-slate-300">{n.docker_version}</span>}
                            </div>
                            <div className="mt-0.5 text-[11px] text-slate-500 group-hover:text-indigo-600 dark:group-hover:text-indigo-300">
                              {dockerStatusLabel || '点击安装 →'}
                            </div>
                          </button>
                        ) : (
                          <div>
                            <div className="flex items-center gap-1.5">
                              <Badge tone={n.docker_mode === 'absent' ? 'neutral' : 'blue'}>{dockerModeLabel}</Badge>
                              {n.docker_version && <span className="font-mono text-[11px] text-slate-500">{n.docker_version}</span>}
                            </div>
                            {dockerStatusLabel && <div className="text-slate-500 mt-0.5">{dockerStatusLabel}</div>}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 text-right">
                        <div className="relative inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
                          {isAdmin && n.status !== 'online' && (
                            <Button size="sm" variant="primary" onClick={() => openPushModal(n)}>
                              推送公钥
                            </Button>
                          )}
                          <Button size="sm" onClick={() => void openNodeDetail(n)}>
                            详情
                          </Button>
                          {isAdmin && (
                            <Button size="sm" onClick={() => void testNode(n)}>
                              测试连接
                            </Button>
                          )}
                          {isAdmin && (
                            <>
                            <Button
                              size="sm"
                              aria-label={`更多操作：${n.name}`}
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
                                  Docker 管理
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { setOpenMenu(null); openEditNode(n); }}
                                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                  编辑主机
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { setOpenMenu(null); void refreshNodeMetrics(n); }}
                                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                  采集实时负载
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { setOpenMenu(null); openPushModal(n); }}
                                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                  推送 SSH 公钥
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { setOpenMenu(null); setPwResetNode(n); }}
                                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                  重置主机指纹
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  disabled={Boolean(n.is_control_plane_host) || resettingMidId === n.id}
                                  title={n.is_control_plane_host ? '控制面同机不支持通过页面重置' : undefined}
                                  onClick={() => { setOpenMenu(null); void resetNodeMachineID(n); }}
                                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                  重新生成节点 ID
                                </button>
                                <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={async () => {
                                    setOpenMenu(null);
                                    if (
                                      !(await askConfirm(`确定要删除主机「${n.name}」(${n.host}) 吗？`, {
                                        title: '删除主机节点',
                                        confirmText: '确认删除',
                                        danger: true,
                                      }))
                                    ) {
                                      return;
                                    }
                                    void apiDelete(`/api/v1/nodes/${n.id}`)
                                      .then(() => {
                                        toast.success(`已删除主机 ${n.name}`);
                                        if (detailNode?.id === n.id) closeDetailDrawer();
                                        return load();
                                      })
                                      .catch((ex) => toast.error(ex.message));
                                  }}
                                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                                >
                                  删除主机
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
            <EmptyState icon={<KeyRound className="h-6 w-6" />} title="先准备一把 SSH 密钥" description="已有免密登录私钥可直接导入；也可以生成新密钥，再向主机推送公钥。" action={isAdmin && <div className="flex flex-wrap gap-2 justify-center"><Button onClick={() => { setErr(''); setShowImportKey(true); }}>导入已有私钥</Button><Button variant="primary" onClick={() => { setErr(''); setShowGenKey(true); }}>生成新密钥</Button></div>} />
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
                      {k.is_default && <Badge tone="green">默认</Badge>}
                    </div>
                    <div className="font-mono text-slate-500">
                      指纹：{k.fingerprint} · 创建于 {fmtTime(k.created_at)}
                    </div>
                    <div className="truncate font-mono text-[11px] text-slate-500">{k.public_key}</div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      onClick={() => copyText(k.public_key, '已复制公钥')}
                    >
                      <Copy className="h-3 w-3" /> 复制公钥
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        copyText(
                          setupCommandForKey(k),
                          '已复制目标机配置命令',
                        )
                      }
                    >
                      复制授权命令
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
                        设为默认
                      </Button>
                    )}
                    {isAdmin && (
                      <Button
                        size="sm"
                        variant="danger-outline"
                        onClick={async () => {
                          if (
                            !(await askConfirm(`确定要删除 SSH 密钥「${k.name}」吗？`, {
                              title: '删除 SSH 密钥',
                              confirmText: '确认删除',
                              danger: true,
                            }))
                          ) {
                            return;
                          }
                          void apiDelete(`/api/v1/ssh-keys/${k.id}`)
                            .then(() => {
                              toast.success(`已删除 SSH 密钥 ${k.name}`);
                              return load();
                            })
                            .catch((ex) => toast.error(ex.message));
                        }}
                      >
                        删除
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
      <Modal open={showGenKey} title="生成 Ed25519 SSH 密钥对" busy={formBusy} onClose={() => setShowGenKey(false)}>
        <form onSubmit={generateKey} className="space-y-4">
          <ErrorAlert message={err} onClose={() => setErr('')} />
          <Input label="密钥名称" required value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button type="button" disabled={formBusy} onClick={() => setShowGenKey(false)}>取消</Button>
            <Button type="submit" variant="primary" loading={formBusy}>生成</Button>
          </div>
        </form>
      </Modal>

      {/* Import SSH key modal */}
      <Modal open={showImportKey} title="导入现有 SSH 私钥" busy={formBusy} onClose={() => setShowImportKey(false)}>
        <form onSubmit={importKey} className="space-y-4">
          <ErrorAlert message={err} onClose={() => setErr('')} />
          <Input label="密钥名称" required value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          <label className="block space-y-1">
            <span className="block text-xs font-medium">私钥 PEM/OpenSSH 原文（无口令）</span>
            <textarea
              required
              rows={6}
              value={privPEM}
              onChange={(e) => setPrivPEM(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" disabled={formBusy} onClick={() => setShowImportKey(false)}>取消</Button>
            <Button type="submit" variant="primary" loading={formBusy}>导入</Button>
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
              ? '保存、推送公钥并测试'
              : '保存并推送公钥'
            : saveAndTest
              ? '保存并测试连接'
              : '保存';
        const authSetupSection = selectedKey && (
          <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-950/40">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">SSH 公钥认证准备</span>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">支持一次性密码自动推送，或无密码手动配置</span>
            </div>
            <SecretInput
              label="一次性 SSH 密码（可选，用于自动推送公钥）"
              placeholder="有密码可在此填写；无密码或已授权请留空"
              autoComplete="new-password"
              resetKey={`${showNodeModal}:${editingNode?.id || 'new'}`}
              value={oneTimePassword}
              onChangeValue={setOneTimePassword}
              hint="仅本次在内存中使用以写入目标主机 ~/.ssh/authorized_keys，不会保存或记入审计日志。"
            />
            <div className="space-y-2 rounded-lg border border-slate-200/90 bg-white px-3 py-2.5 text-xs dark:border-slate-800 dark:bg-slate-900/70">
              <p className="leading-5 text-slate-600 dark:text-slate-300">
                {oneTimePassword !== ''
                  ? `已填写一次性密码，保存时将自动推送密钥「${selectedKey.name}」的公钥。`
                  : `机器没有密码或已禁用密码登录？请先在目标主机执行授权命令，或手动配置密钥「${selectedKey.name}」的公钥：`}
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Button type="button" size="sm" onClick={() => copyText(selectedKeyCmd, '已复制目标主机授权命令')}>
                  <Copy className="h-3 w-3" /> 复制授权命令
                </Button>
                <Button type="button" size="sm" onClick={() => copyText(selectedKey.public_key, '已复制公钥')}>
                  <Copy className="h-3 w-3" /> 复制公钥
                </Button>
              </div>
              <details className="pt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                <summary className="cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-200">
                  查看手动授权命令
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
            title={editingNode ? '编辑主机' : '新增 Linux 主机'}
            busy={formBusy}
            onClose={closeNodeModal}
            footer={
              <div className="flex justify-end gap-2">
                <Button type="button" disabled={formBusy} onClick={closeNodeModal}>取消</Button>
                <Button type="submit" form="node-form" variant="primary" loading={formBusy}>{submitLabel}</Button>
              </div>
            }
          >
            <form id="node-form" onSubmit={saveNode} className="space-y-3.5">
              <ErrorAlert message={nodeModalErr} onClose={() => setNodeModalErr('')} />
              <Input label="主机名称" required placeholder="例如 node-1" value={nodeForm.name} onChange={(e) => setNodeForm({ ...nodeForm, name: e.target.value })} />
              <div className="grid grid-cols-3 gap-2.5">
                <div className="col-span-2">
                  <Input label="主机地址 (IP/域名)" required placeholder="例如 10.0.1.10" value={nodeForm.host} onChange={(e) => setNodeForm({ ...nodeForm, host: e.target.value })} />
                </div>
                <Input
                  label="SSH 端口"
                  type="number"
                  min={1}
                  max={65535}
                  required
                  value={nodeForm.ssh_port}
                  onChange={(e) => setNodeForm({ ...nodeForm, ssh_port: Number(e.target.value) })}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input label="SSH 用户" autoComplete="off" required placeholder="root" value={nodeForm.ssh_user} onChange={(e) => setNodeForm({ ...nodeForm, ssh_user: e.target.value })} />
                <Select label="SSH 密钥" value={nodeForm.ssh_key_id} onChange={(e) => setNodeForm({ ...nodeForm, ssh_key_id: e.target.value })}>
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
                    重新推送或手动配置 SSH 公钥（可选）
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
                    <span>使用免密 sudo（非 root 用户安装服务时需要）</span>
                  </label>
                ) : (
                  <p className="text-xs text-slate-500 dark:text-slate-400">当前使用 root 登录，将直接管理服务，无需 sudo 提权。</p>
                )}
                <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={saveAndTest}
                    onChange={(e) => setSaveAndTest(e.target.checked)}
                  />
                  <span>保存后立即测试 SSH 连接并探测环境</span>
                </label>
              </div>
              <Input label="备注（可选）" placeholder="用途说明或机房位置" value={nodeForm.notes} onChange={(e) => setNodeForm({ ...nodeForm, notes: e.target.value })} />
            </form>
          </Modal>
        );
      })()}

      {/* Push key modal */}
      {(() => {
        const pushTargetKey = keys.find((k) => k.id === pushNode?.ssh_key_id) || keys.find((k) => k.is_default) || keys[0];
        const pushTargetCmd = setupCommandForKey(pushTargetKey);
        return (
          <Modal open={Boolean(pushNode)} title={`推送公钥到 ${pushNode?.name}`} busy={formBusy} onClose={closePushModal}>
            <form onSubmit={doPushKey} className="space-y-4">
              <ErrorAlert message={pushModalErr} onClose={() => setPushModalErr('')} />
              <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
                使用一次性 SSH 密码将关联密钥{pushTargetKey ? `「${pushTargetKey.name}」` : ''}的公钥幂等写入目标主机 <code className="font-mono">~/.ssh/authorized_keys</code>，密码仅在内存使用，不入库、不记审计。
              </p>
              <SecretInput
                label="目标主机一次性 SSH 密码"
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
                <span>推送成功后立即测试 SSH 连接并探测环境</span>
              </label>
              {pushTargetKey && (
                <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-xs dark:border-slate-800 dark:bg-slate-950/40">
                  <p className="text-slate-500 dark:text-slate-400">
                    目标主机没有密码或禁用密码登录？可复制命令手动配置公钥：
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <Button type="button" size="sm" onClick={() => copyText(pushTargetCmd, '已复制目标主机授权命令')}>
                      <Copy className="h-3 w-3" /> 复制授权命令
                    </Button>
                    <Button type="button" size="sm" onClick={() => copyText(pushTargetKey.public_key, '已复制公钥')}>
                      <Copy className="h-3 w-3" /> 复制公钥
                    </Button>
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" disabled={formBusy} onClick={closePushModal}>取消</Button>
                <Button type="submit" variant="primary" loading={formBusy}>推送公钥</Button>
              </div>
            </form>
          </Modal>
        );
      })()}

      {/* Docker management modal */}
      <Modal open={Boolean(dockerNode)} title={`Docker 管理：${dockerNode?.name}`} busy={dockerBusy} onClose={() => setDockerNode(null)} wide>
        <ErrorAlert message={dockerErr} onClose={() => setDockerErr('')} />
        {!dockerInfo && <p role="status" className="py-8 text-center text-sm text-slate-500">{dockerBusy ? '正在读取 Docker 状态…' : '无法读取 Docker 信息，请关闭后重试。'}</p>}
        {dockerInfo && (
          <div className="space-y-4 text-xs">
            <div className="grid gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-950 sm:grid-cols-3">
              <div>管理方式：<span className="font-semibold">{{ absent: '未安装', managed: '平台托管', external: '外部安装' }[dockerInfo.mode as string] || dockerInfo.mode}</span></div>
              <div>版本：<span className="font-mono">{dockerInfo.version || '-'}</span></div>
              <div>状态：{dockerInfo.mode === 'absent' ? <Badge tone="neutral">等待安装</Badge> : <StatusBadge value={dockerInfo.status} />}</div>
            </div>
            <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700 space-y-3">
              <div className="text-sm font-semibold">{dockerInfo.mode === 'absent' ? '1. 安装容器运行环境' : '版本与维护'}</div>
              <p className="text-xs leading-5 text-slate-500">Docker 用于运行 PostgreSQL 等容器任务。安装包由控制面下载、验签并分发到当前主机。</p>
              <div className="flex flex-wrap items-end gap-2">
              <div className="w-48">
                <Input label={dockerInfo.mode === 'absent' ? '安装版本（可选）' : '目标版本'} placeholder={dockerInfo.mode === 'absent' ? '留空安装仓库最新版' : '请输入完整版本号'} value={dockerVer} onChange={(e) => setDockerVer(e.target.value)} />
              </div>
              {dockerInfo.mode === 'absent' && <Button variant="primary" loading={dockerBusy} onClick={() => void runDockerAction('install')}>安装 Docker</Button>}
              {dockerInfo.mode === 'managed' && <Button loading={dockerBusy} disabled={!dockerVer.trim()} onClick={() => void runDockerAction('upgrade')}>升级 Docker</Button>}
              {dockerInfo.mode === 'external' && (
                <Button loading={dockerBusy} onClick={() => void runDockerAction('adopt')}>转为托管</Button>
              )}
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={dockerUseProxy} onChange={(e) => setDockerUseProxy(e.target.checked)} />
              <span>安装/升级使用系统代理</span>
            </label>
            </div>
            {dockerInfo.mode !== 'absent' && <details className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <summary className="cursor-pointer font-medium">升级策略与中断确认</summary>
              <div className="mt-3 space-y-3">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={dockerDrain} onChange={(e) => setDockerDrain(e.target.checked)} />
              <span>升级前疏散 Nomad 工作负载</span>
            </label>
            <p className="text-slate-500">Nomad 客户端默认疏散，需有可调度的替代节点；关闭疏散时，Docker 驱动重连可能中断 Task。</p>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={dockerConfirm} onChange={(e) => setDockerConfirm(e.target.checked)} />
              <span>确认跨主版本升级</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={dockerAllowInterruption} onChange={(e) => setDockerAllowInterruption(e.target.checked)} />
              <span>允许无法疏散节点的容器中断</span>
            </label>
              </div>
            </details>}
            {dockerInfo.mode !== 'absent' && <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <div className="text-sm font-semibold">镜像下载与代理</div>
              <p className="leading-5 text-slate-500">安装包代理和镜像代理分别配置。如果无法拉取 Docker Hub 镜像，可在这里沿用系统代理。</p>
              <Input
                label="Registry Mirrors（逗号分隔）"
                value={dockerCfg.registry_mirrors}
                onChange={(e) => setDockerCfg({ ...dockerCfg, registry_mirrors: e.target.value })}
              />
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={dockerCfg.use_system_proxy}
                  onChange={(e) => setDockerCfg({ ...dockerCfg, use_system_proxy: e.target.checked })}
                />
                <span>沿用控制面系统代理作为镜像拉取代理</span>
              </label>
              {!dockerCfg.use_system_proxy && (
                <Input
                  label="自定义镜像代理 URL"
                  placeholder="http://10.0.0.1:3128"
                  value={dockerCfg.proxy_url}
                  onChange={(e) => setDockerCfg({ ...dockerCfg, proxy_url: e.target.value })}
                />
              )}
              <div className="flex gap-2">
                <Button variant="primary" loading={dockerBusy} onClick={() => void saveDockerCfg()}>应用守护进程配置</Button>
                <Button disabled={dockerBusy} onClick={() => void testDockerProxy()}>从节点测试代理</Button>
              </div>
            </div>}
          </div>
        )}
      </Modal>

      <PasswordConfirmModal
        open={Boolean(pwResetNode)}
        title={`重置主机指纹：${pwResetNode?.name || ''}`}
        description="重置后下次连接将重新通过 TOFU 固定该节点公钥指纹。"
        onClose={() => setPwResetNode(null)}
        onConfirm={async (pw) => {
          if (!pwResetNode) return;
          const target = pwResetNode;
          await apiPost(`/api/v1/nodes/${target.id}/reset-fingerprint`, { current_password: pw });
          toast.success(`已重置 ${target.name} 主机指纹`, { position: 'top-right' });
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
                {dn.is_control_plane_host && <Badge tone="amber">控制面同机</Badge>}
              </>
            }
            subtitle={`${dn.ssh_user}@${dn.host}:${dn.ssh_port} · ${dn.last_checked_at ? `最近探测 ${fmtTime(dn.last_checked_at)}` : '尚未探测'}`}
            width="lg"
            onClose={closeDetailDrawer}
            headerExtra={
              isAdmin ? (
                <Button size="sm" loading={detailTesting} onClick={() => void testNode(dn)}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>重新探测</span>
                </Button>
              ) : undefined
            }
            footer={
              <div className="flex flex-wrap items-center justify-between gap-2 w-full">
                <div className="flex flex-wrap items-center gap-1.5">
                  {isAdmin && dn.status !== 'online' && (
                    <Button size="sm" onClick={() => openPushModal(dn)}>推送公钥</Button>
                  )}
                  {isAdmin && (
                    <>
                      <Button size="sm" onClick={() => void refreshNodeMetrics(dn)}>采集负载</Button>
                      <Button size="sm" onClick={() => void openDocker(dn)}>Docker</Button>
                      <Button size="sm" onClick={() => setPwResetNode(dn)}>重置指纹</Button>
                      <Button size="sm" onClick={() => openEditNode(dn)}>编辑主机</Button>
                    </>
                  )}
                </div>
                <Button size="sm" variant="primary" onClick={closeDetailDrawer}>关闭</Button>
              </div>
            }
          >
            <div className="space-y-4 text-xs">
              {detailLoading && (
                <div className="text-slate-500 dark:text-slate-400">正在加载完整探测档案…</div>
              )}

              {detailWarnings.length > 0 ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-3.5 space-y-2.5 dark:border-amber-500/30 dark:bg-amber-500/10">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 font-semibold text-amber-800 dark:text-amber-300">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span>环境预检提醒（{detailWarnings.length} 项）</span>
                    </div>
                    {isAdmin && detailClonePeers.length > 0 && !dn.is_control_plane_host && (
                      <Button
                        size="sm"
                        variant="primary"
                        loading={resettingMidId === dn.id}
                        onClick={() => void resetNodeMachineID(dn, detailClonePeers)}
                      >
                        立即重新生成节点 ID
                      </Button>
                    )}
                  </div>
                  <ul className="list-disc space-y-1 pl-5 text-amber-900 dark:text-amber-200 leading-5">
                    {detailWarnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              ) : dn.status === 'online' ? (
                <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/80 px-3.5 py-2.5 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>所有环境预检项均通过，可用于组建或扩展集群。</span>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-slate-600 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
                  该主机尚未连通或探测，可先推送/配置 SSH 公钥后点击右上角「重新探测」。
                </div>
              )}

              <div className="rounded-xl border border-slate-200 p-4 space-y-3 dark:border-slate-800">
                <div className="font-semibold text-slate-900 dark:text-slate-100">实时资源与系统</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="flex justify-between text-slate-500">
                      <span>CPU{dn.cpu_cores > 0 ? ` (${dn.cpu_cores} 核)` : ''}</span>
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
                      <span>内存{dn.mem_total_bytes > 0 ? ` (${fmtBytes(dn.mem_used_bytes)}/${fmtBytes(dn.mem_total_bytes)})` : ''}</span>
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
                    <dt className="text-slate-500">操作系统</dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100">{dn.os_info || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">架构 / 家族</dt>
                    <dd className="mt-0.5 font-mono text-slate-900 dark:text-slate-100">
                      {[dn.arch, dn.os_family, dn.os_codename].filter(Boolean).join(' · ') || '-'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">内核版本</dt>
                    <dd className="mt-0.5 font-mono text-slate-900 dark:text-slate-100">{dp?.kernel || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">包管理器</dt>
                    <dd className="mt-0.5 font-mono text-slate-900 dark:text-slate-100">{dn.package_manager || '-'}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-slate-500">Docker Engine</dt>
                    <dd className="mt-0.5 flex flex-wrap items-center gap-2">
                      <Badge tone={dn.docker_mode === 'absent' ? 'neutral' : 'blue'}>{dockerModeLabelOf(dn.docker_mode)}</Badge>
                      {dn.docker_version && <span className="font-mono text-slate-800 dark:text-slate-200">{dn.docker_version}</span>}
                      {dockerStatusLabelOf(dn.docker_status) && <span className="text-slate-500">{dockerStatusLabelOf(dn.docker_status)}</span>}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-xl border border-slate-200 p-4 space-y-3 dark:border-slate-800">
                <div className="font-semibold text-slate-900 dark:text-slate-100">环境预检明细</div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                  <div>
                    <dt className="text-slate-500"><TermLabel term="时间同步" tip="Raft 一致性依赖各节点系统时间同步（chrony / systemd-timesyncd），偏差过大会导致选举抖动或 TLS 校验异常。" /></dt>
                    <dd className={`mt-0.5 font-medium ${dn.time_sync === 'synced' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                      {timeSyncLabelOf(dn.time_sync)}（{dn.clock_skew_ms ?? 0} ms）
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">提权权限（sudo）</dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
                      {isRootUser ? 'root 直连' : dn.sudo_ready ? '免密 sudo 就绪' : dn.use_sudo ? '未就绪（需 NOPASSWD）' : '未启用'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">SELinux 模式</dt>
                    <dd className="mt-0.5 font-mono text-slate-900 dark:text-slate-100">{dn.selinux_mode || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Swap 交换空间</dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
                      {dn.status === 'unknown' ? '-' : dn.swap_enabled ? (swapEncrypted ? '已启用（已加密）' : '已启用（未加密）') : '已禁用'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">/opt/nomad-deck 目录</dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
                      {optWritable === null ? '-' : optWritable ? '可写' : '不可写'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">基础命令检查</dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
                      {dp ? (missingTools.length === 0 ? '完整' : `缺少：${missingTools.join('、')}`) : '-'}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-xl border border-slate-200 p-4 space-y-2.5 dark:border-slate-800">
                <div className="font-semibold text-slate-900 dark:text-slate-100">SSH 连接与节点身份</div>
                <dl className="space-y-2.5">
                  <div>
                    <dt className="text-slate-500">SSH 密钥</dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100">{sshKeyObj?.name || dn.ssh_key_id || '-'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">主机公钥指纹（TOFU）</dt>
                    <dd className="mt-0.5 font-mono break-all text-slate-800 dark:text-slate-200">
                      {dn.host_key_fingerprint || '尚未记录（首次连接时自动信任并固定）'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500"><TermLabel term="节点 ID（/etc/machine-id）" tip="/etc/machine-id；控制面结合硬件 UUID、网卡 MAC 与主机指纹区分克隆虚拟机与重复登记。" /></dt>
                    <dd className="mt-0.5 flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono break-all text-slate-800 dark:text-slate-200">{dn.machine_id || '-'}</span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {dn.machine_id && (
                          <Button size="sm" onClick={() => copyText(dn.machine_id, '已复制节点 ID')}>
                            <Copy className="h-3 w-3" /> 复制
                          </Button>
                        )}
                        {isAdmin && !dn.is_control_plane_host && (
                          <Button
                            size="sm"
                            loading={resettingMidId === dn.id}
                            onClick={() => void resetNodeMachineID(dn, detailClonePeers)}
                          >
                            重新生成
                          </Button>
                        )}
                      </div>
                    </dd>
                  </div>
                  {(dp?.product_uuid || (Array.isArray(dp?.mac_addrs) && dp.mac_addrs.length > 0)) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div>
                        <dt className="text-slate-500">硬件 UUID</dt>
                        <dd className="mt-0.5 font-mono break-all text-slate-800 dark:text-slate-200">
                          {dp?.product_uuid || '-'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">网卡 MAC</dt>
                        <dd className="mt-0.5 font-mono break-all text-slate-800 dark:text-slate-200">
                          {Array.isArray(dp?.mac_addrs) && dp.mac_addrs.length > 0 ? dp.mac_addrs.join('、') : '-'}
                        </dd>
                      </div>
                    </div>
                  )}
                  <div>
                    <dt className="text-slate-500">地址别名</dt>
                    <dd className="mt-1 flex flex-wrap gap-1.5">
                      {aliases.length > 0 ? aliases.map((a) => <Badge key={a}>{a}</Badge>) : <span className="text-slate-500">-</span>}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">备注</dt>
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
