import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Copy, KeyRound, MoreHorizontal, Plus, RefreshCw, Server as ServerIcon, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut, fmtBytes, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { copyText as copyToClipboard } from '../lib/clipboard';
import { useOpsDrawer } from '../lib/opsDrawer';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
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
  statusTone,
} from '../components/UI';

export function InfraPage() {
  const { isAdmin } = useAuth();
  const { openTask } = useOpsDrawer();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [tab, setTab] = useState('nodes');
  const [keys, setKeys] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);
  const [err, setErr] = useState('');
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
  const [pushNode, setPushNode] = useState<any>(null);
  const [pushPassword, setPushPassword] = useState('');
  const [pwResetNode, setPwResetNode] = useState<any>(null);
  const [probeWarnings, setProbeWarnings] = useState<{ node: string; warnings: string[] } | null>(null);
  const [openMenu, setOpenMenu] = useState<{ id: string; top: number; right: number } | null>(null);
  const [saveAndTest, setSaveAndTest] = useState(true);
  const [dockerNode, setDockerNode] = useState<any>(null);
  const [dockerInfo, setDockerInfo] = useState<any>(null);
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
    if (keys.length === 0) {
      setTab('keys');
      toast.info('请先生成或导入 SSH 密钥，再添加主机');
      return;
    }
    setEditingNode(null);
    const defKey = keys.find((k) => k.is_default)?.id || keys[0]?.id || '';
    setNodeForm({ name: '', host: '', ssh_port: 22, ssh_user: 'root', ssh_key_id: defKey, use_sudo: true, notes: '' });
    setShowNodeModal(true);
  };

  const openEditNode = (n: any) => {
    setErr('');
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
    setShowNodeModal(true);
  };

  const saveNode = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormBusy(true);
    setErr('');
    try {
      let savedNode: any = editingNode;
      if (editingNode) {
        const res = await apiPut(`/api/v1/nodes/${editingNode.id}`, nodeForm);
        savedNode = res.node || editingNode;
      } else {
        const res = await apiPost('/api/v1/nodes', nodeForm);
        savedNode = res.node;
      }
      setShowNodeModal(false);
      if (saveAndTest && savedNode?.id) {
        try {
          const testRes = await apiPost(`/api/v1/nodes/${savedNode.id}/test`);
          setProbeWarnings({ node: savedNode.name || nodeForm.name, warnings: testRes.warnings || [] });
          toast.success(`主机 ${savedNode.name || nodeForm.name} 已保存并连接成功`);
        } catch (testEx: any) {
          toast.info(`主机已保存，暂未连通：${testEx?.message || '请先完成公钥授权或使用推送公钥'}`);
        }
      } else {
        toast.success(`主机 ${nodeForm.name} 已保存`);
      }
      await load();
    } catch (ex: any) {
      setErr(ex?.message || '保存主机失败');
    } finally {
      setFormBusy(false);
    }
  };

  const testNode = async (n: any) => {
    setErr('');
    try {
      const res = await apiPost(`/api/v1/nodes/${n.id}/test`);
      setProbeWarnings({ node: n.name, warnings: res.warnings || [] });
      await load();
    } catch (ex: any) {
      setErr(ex?.message || '探测失败');
    }
  };

  const doPushKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pushNode) return;
    setFormBusy(true);
    setErr('');
    try {
      await apiPost(`/api/v1/nodes/${pushNode.id}/push-key`, { password: pushPassword });
      setPushPassword('');
      const name = pushNode.name;
      setPushNode(null);
      toast.success(`已成功推送公钥到主机 ${name}`);
    } catch (ex: any) {
      setErr(ex?.message || '推送公钥失败');
    } finally {
      setFormBusy(false);
    }
  };

  const openDocker = async (n: any) => {
    setDockerNode(n);
    setErr('');
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
      setErr(ex?.message || '加载 Docker 信息失败');
    }
  };

  const runDockerAction = async (action: 'install' | 'upgrade' | 'adopt') => {
    if (!dockerNode) return;
    setErr('');
    try {
      const res = await apiPost(`/api/v1/nodes/${dockerNode.id}/docker/${action}`, {
        version: dockerVer.trim(),
        use_proxy: dockerUseProxy,
        drain: dockerDrain,
        confirm: dockerConfirm,
        allow_interruption: dockerAllowInterruption,
      });
      if (res.task?.id) openTask(res.task.id, `Docker ${action}: ${dockerNode.name}`);
    } catch (ex: any) {
      setErr(ex?.message || `Docker ${action} 失败`);
    }
  };

  const saveDockerCfg = async () => {
    if (!dockerNode) return;
    setErr('');
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
      if (res.task?.id) openTask(res.task.id, `更新 Docker 配置: ${dockerNode.name}`);
    } catch (ex: any) {
      setErr(ex?.message || '保存 Docker 配置失败');
    }
  };

  const testDockerProxy = async () => {
    if (!dockerNode) return;
    setErr('');
    try {
      const res = await apiPost(`/api/v1/nodes/${dockerNode.id}/docker/proxy-test`, {});
      toast.info(`镜像代理测试结果：${JSON.stringify(res.result)}`);
    } catch (ex: any) {
      setErr(ex?.message || '代理测试失败');
    }
  };

  const copyText = (text: string, msg: string) => {
    void copyToClipboard(text)
      .then(() => toast.success(msg))
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
      }
      toast.success(`已刷新 ${node.name} CPU/内存利用率`);
    } catch (ex: any) {
      setErr(ex?.message || `采集 ${node.name} 负载失败`);
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

      {probeWarnings && (
        <Card
          title={`主机 ${probeWarnings.node} 环境探测结果`}
          actions={<Button size="sm" onClick={() => setProbeWarnings(null)}>关闭</Button>}
        >
          {probeWarnings.warnings.length === 0 ? (
            <div className="text-sm text-emerald-700 dark:text-emerald-400">所有环境预检项均通过。</div>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-xs text-amber-800 dark:text-amber-300">
              {probeWarnings.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'nodes' && (
        <Card>
          {nodes.length === 0 ? (
            (() => {
              const defKey = keys.find((k) => k.is_default) || keys[0];
              const authCmd = defKey
                ? `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${defKey.public_key}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
                : '';
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
                          ? `已就绪默认密钥「${defKey.name}」，可直接复制下方授权命令到目标主机执行，或添加后再用密码推送公钥。`
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
                        点击右上角「新增第一台主机」，填入主机名称、IP 或域名及 SSH 用户名（如 root）。
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
              <table className="w-full min-w-[920px] text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                    <th className="py-2.5 pr-3">名称 / 地址</th>
                    <th className="py-2.5 pr-3">状态</th>
                    <th className="py-2.5 pr-3">CPU / 内存利用率</th>
                    <th className="py-2.5 pr-3">系统 / 架构</th>
                    <th className="py-2.5 pr-3">Docker</th>
                    <th className="py-2.5 pr-3"><TermLabel term="时间同步" tip="Raft 一致性依赖各节点系统时间同步（chrony / systemd-timesyncd），偏差过大会导致选举抖动或 TLS 校验异常。" /></th>
                    <th className="py-2.5 pr-3"><TermLabel term="节点 ID" tip="/etc/machine-id，用于探测克隆虚拟机导致的节点身份冲突。" /></th>
                    {isAdmin && <th className="py-2.5 text-right">操作</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {nodes.map((n) => {
                    const cpuPct = typeof n.cpu_percent === 'number' && n.cpu_percent >= 0 ? n.cpu_percent : null;
                    const memPct = typeof n.mem_percent === 'number' && n.mem_percent >= 0 ? n.mem_percent : null;
                    const dockerModeLabel =
                      n.docker_mode === 'managed' ? '托管' : n.docker_mode === 'external' ? '外部' : n.docker_mode === 'absent' ? '未安装' : n.docker_mode || '-';
                    const dockerStatusLabel =
                      n.docker_status === 'running' || n.docker_status === 'active'
                        ? '运行中'
                        : n.docker_status === 'absent'
                          ? ''
                          : n.docker_status || '';
                    const timeSyncLabel = n.time_sync === 'synced' ? '已同步' : n.time_sync === 'unsynced' || n.time_sync === 'skewed' ? '待校时' : n.time_sync || '-';
                    return (
                    <tr key={n.id}>
                      <td className="py-3 pr-3">
                        <div className="flex flex-wrap items-center gap-1.5 font-medium">
                          <ServerIcon className="h-3.5 w-3.5 text-slate-400" />
                          <span className="text-slate-900 dark:text-slate-100">{n.name}</span>
                          {n.is_control_plane_host && (
                            <span className="inline-flex items-center gap-0.5">
                              <Badge tone="amber">控制面同机</Badge>
                              <InfoTip text="该主机与 NomadDeck 控制面同机：若控制面运行在 Docker 容器中，请勿在本页重装或重启 Docker；组成多节点集群时 advertise_addr 请填写真实内网 IP 而非 127.0.0.1。" />
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-slate-500 mt-0.5">
                          {n.ssh_user}@{n.host}:{n.ssh_port}
                        </div>
                      </td>
                      <td className="py-3 pr-3">
                        <StatusBadge value={n.status || 'unknown'} />
                      </td>
                      <td className="py-3 pr-3 min-w-[160px]">
                        <div className="space-y-1.5 text-[11px]">
                          <div>
                            <div className="flex justify-between">
                              <span className="text-slate-500">CPU{n.cpu_cores > 0 ? ` (${n.cpu_cores}C)` : ''}</span>
                              <span className="font-mono">{cpuPct !== null ? `${cpuPct.toFixed(1)}%` : '-'}</span>
                            </div>
                            <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
                              <div
                                className={`h-full ${cpuPct !== null && cpuPct >= 85 ? 'bg-rose-500' : cpuPct !== null && cpuPct >= 65 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                                style={{ width: `${Math.min(100, Math.max(0, cpuPct ?? 0))}%` }}
                              />
                            </div>
                          </div>
                          <div>
                            <div className="flex justify-between">
                              <span className="text-slate-500">
                                内存{n.mem_total_bytes > 0 ? ` (${fmtBytes(n.mem_used_bytes)}/${fmtBytes(n.mem_total_bytes)})` : ''}
                              </span>
                              <span className="font-mono">{memPct !== null ? `${memPct.toFixed(1)}%` : '-'}</span>
                            </div>
                            <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
                              <div
                                className={`h-full ${memPct !== null && memPct >= 85 ? 'bg-rose-500' : memPct !== null && memPct >= 65 ? 'bg-amber-500' : 'bg-sky-500'}`}
                                style={{ width: `${Math.min(100, Math.max(0, memPct ?? 0))}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="text-slate-800 dark:text-slate-200">{n.os_info || '-'}</div>
                        <div className="font-mono text-slate-500">{n.arch || '-'}</div>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="flex items-center gap-1.5">
                          <Badge tone={n.docker_mode === 'absent' ? 'neutral' : 'blue'}>{dockerModeLabel}</Badge>
                          {n.docker_version && <span className="font-mono text-[11px] text-slate-500">{n.docker_version}</span>}
                        </div>
                        {dockerStatusLabel && <div className="text-slate-500 mt-0.5">{dockerStatusLabel}</div>}
                      </td>
                      <td className="py-3 pr-3">
                        <div className={n.time_sync === 'synced' ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-amber-600 dark:text-amber-400 font-medium'}>
                          {timeSyncLabel}
                        </div>
                        <div className="text-slate-500 font-mono">{n.clock_skew_ms ?? 0} ms</div>
                      </td>
                      <td className="py-3 pr-3 font-mono text-[11px] text-slate-500" title={n.machine_id || ''}>
                        {n.machine_id ? n.machine_id.slice(0, 10) + '…' : '-'}
                      </td>
                      {isAdmin && (
                        <td className="py-3 text-right">
                          <div className="relative inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
                            <Button size="sm" onClick={() => void testNode(n)}>
                              测试连接
                            </Button>
                            <Button size="sm" onClick={() => void openDocker(n)}>
                              Docker
                            </Button>
                            <Button size="sm" onClick={() => openEditNode(n)}>
                              编辑
                            </Button>
                            <Button
                              size="sm"
                              aria-label={`更多操作：${n.name}`}
                              aria-expanded={openMenu?.id === n.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                const rect = e.currentTarget.getBoundingClientRect();
                                const flipUp = rect.bottom + 180 > window.innerHeight;
                                const top = flipUp ? Math.max(8, rect.top - 168) : rect.bottom + 6;
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
                                  onClick={() => { setOpenMenu(null); void refreshNodeMetrics(n); }}
                                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                  采集实时负载
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { setOpenMenu(null); setErr(''); setPushNode(n); }}
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
                          </div>
                        </td>
                      )}
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
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
                          `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${k.public_key}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
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
                        variant="danger"
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
      <Modal open={showNodeModal} title={editingNode ? '编辑主机' : '新增 Linux 主机'} busy={formBusy} onClose={() => setShowNodeModal(false)}>
        <form onSubmit={saveNode} className="space-y-3.5">
          <ErrorAlert message={err} onClose={() => setErr('')} />
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
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" disabled={formBusy} onClick={() => setShowNodeModal(false)}>取消</Button>
            <Button type="submit" variant="primary" loading={formBusy}>{saveAndTest ? '保存并测试连接' : '保存'}</Button>
          </div>
        </form>
      </Modal>

      {/* Push key modal */}
      <Modal open={Boolean(pushNode)} title={`推送公钥到 ${pushNode?.name}`} busy={formBusy} onClose={() => setPushNode(null)}>
        <form onSubmit={doPushKey} className="space-y-4">
          <ErrorAlert message={err} onClose={() => setErr('')} />
          <p className="text-xs text-slate-500">使用一次性 SSH 密码将关联公钥幂等写入目标主机 authorized_keys，密码仅在内存使用，不入库、不记审计。</p>
          <SecretInput label="目标主机 SSH 密码" required value={pushPassword} onChangeValue={setPushPassword} />
          <div className="flex justify-end gap-2">
            <Button type="button" disabled={formBusy} onClick={() => setPushNode(null)}>取消</Button>
            <Button type="submit" variant="primary" loading={formBusy}>推送公钥</Button>
          </div>
        </form>
      </Modal>

      {/* Docker management modal */}
      <Modal open={Boolean(dockerNode)} title={`Docker 管理：${dockerNode?.name}`} onClose={() => setDockerNode(null)} wide>
        {dockerInfo && (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-3 gap-3 rounded bg-slate-50 p-3 dark:bg-slate-950">
              <div>模式：<span className="font-semibold">{dockerInfo.mode || 'absent'}</span></div>
              <div>版本：<span className="font-mono">{dockerInfo.version || '-'}</span></div>
              <div>状态：<Badge tone={statusTone(dockerInfo.status)}>{dockerInfo.status || '-'}</Badge></div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-48">
                <Input label="目标版本（可选）" placeholder="留空按仓库最新版" value={dockerVer} onChange={(e) => setDockerVer(e.target.value)} />
              </div>
              <Button variant="primary" onClick={() => void runDockerAction('install')}>安装</Button>
              <Button onClick={() => void runDockerAction('upgrade')}>升级</Button>
              {dockerInfo.mode === 'external' && (
                <Button onClick={() => void runDockerAction('adopt')}>转为托管</Button>
              )}
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={dockerUseProxy} onChange={(e) => setDockerUseProxy(e.target.checked)} />
              <span>安装/升级使用系统代理</span>
            </label>
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
            <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
              <div className="font-semibold">守护进程配置与镜像拉取代理</div>
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
                <Button variant="primary" onClick={() => void saveDockerCfg()}>应用守护进程配置</Button>
                <Button onClick={() => void testDockerProxy()}>从节点测试代理</Button>
              </div>
            </div>
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
          await apiPost(`/api/v1/nodes/${pwResetNode.id}/reset-fingerprint`, { current_password: pw });
          toast.success(`已重置 ${pwResetNode.name} 主机指纹`);
          await load();
        }}
      />
    </div>
  );
}
