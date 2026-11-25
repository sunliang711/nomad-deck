import React, { useCallback, useEffect, useState } from 'react';
import { Activity, Copy, KeyRound, Plus, RefreshCw, Server as ServerIcon, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut, fmtBytes, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOpsDrawer } from '../lib/opsDrawer';
import { Badge, Button, Card, EmptyState, ErrorAlert, InfoTip, Input, Modal, PasswordConfirmModal, SecretInput, SectionTabs, Select, TermLabel, statusTone } from '../components/UI';

export function InfraPage() {
  const { isAdmin } = useAuth();
  const { openTask } = useOpsDrawer();
  const [tab, setTab] = useState('nodes');
  const [keys, setKeys] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [metricsBusy, setMetricsBusy] = useState(false);

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

  const generateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      await apiPost('/api/v1/ssh-keys/generate', { name: keyName.trim() });
      setKeyName('');
      setShowGenKey(false);
      await load();
    } catch (ex: any) {
      setErr(ex?.message || '生成密钥失败');
    }
  };

  const importKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      await apiPost('/api/v1/ssh-keys', { name: keyName.trim(), private_key: privPEM });
      setKeyName('');
      setPrivPEM('');
      setShowImportKey(false);
      await load();
    } catch (ex: any) {
      setErr(ex?.message || '导入密钥失败');
    }
  };

  const openAddNode = () => {
    setEditingNode(null);
    const defKey = keys.find((k) => k.is_default)?.id || keys[0]?.id || '';
    setNodeForm({ name: '', host: '', ssh_port: 22, ssh_user: 'root', ssh_key_id: defKey, use_sudo: true, notes: '' });
    setShowNodeModal(true);
  };

  const openEditNode = (n: any) => {
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
    setErr('');
    try {
      if (editingNode) {
        await apiPut(`/api/v1/nodes/${editingNode.id}`, nodeForm);
      } else {
        await apiPost('/api/v1/nodes', nodeForm);
      }
      setShowNodeModal(false);
      await load();
    } catch (ex: any) {
      setErr(ex?.message || '保存主机失败');
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
    setErr('');
    try {
      await apiPost(`/api/v1/nodes/${pushNode.id}/push-key`, { password: pushPassword });
      setPushPassword('');
      setPushNode(null);
      setNotice(`已成功推送公钥到主机 ${pushNode.name}`);
    } catch (ex: any) {
      setErr(ex?.message || '推送公钥失败');
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
      setNotice(`镜像代理测试结果：${JSON.stringify(res.result)}`);
    } catch (ex: any) {
      setErr(ex?.message || '代理测试失败');
    }
  };

  const copyText = (text: string, msg: string) => {
    void navigator.clipboard.writeText(text);
    setNotice(msg);
  };

  const refreshAllMetrics = async () => {
    setMetricsBusy(true);
    setErr('');
    try {
      const res = await apiPost('/api/v1/nodes/metrics/refresh', {});
      if (Array.isArray(res.nodes)) setNodes(res.nodes);
      setNotice(`主机实时负载采集完成：成功 ${res.ok ?? 0}，失败 ${res.failed ?? 0}`);
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
      setNotice(`已刷新 ${node.name} CPU/内存利用率`);
    } catch (ex: any) {
      setErr(ex?.message || `采集 ${node.name} 负载失败`);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTabs
          tabs={[
            { id: 'nodes', label: `主机节点 (${nodes.length})` },
            { id: 'keys', label: `SSH 密钥库 (${keys.length})`, tip: '控制面使用 Ed25519 私钥免密登录目标主机（首次连接支持 TOFU 主机指纹信任）。' },
          ]}
          active={tab}
          onChange={setTab}
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" />
            <span>刷新</span>
          </Button>
          {isAdmin && tab === 'nodes' && (
            <>
              <Button size="sm" disabled={metricsBusy} onClick={() => void refreshAllMetrics()}>
                <Activity className="h-3.5 w-3.5" />
                <span>{metricsBusy ? '采集中...' : '采集实时负载'}</span>
              </Button>
              <Button size="sm" variant="primary" onClick={openAddNode}>
                <Plus className="h-3.5 w-3.5" />
                <span>新增主机</span>
              </Button>
            </>
          )}
          {isAdmin && tab === 'keys' && (
            <>
              <Button size="sm" onClick={() => setShowImportKey(true)}>
                导入私钥
              </Button>
              <Button size="sm" variant="primary" onClick={() => setShowGenKey(true)}>
                <Plus className="h-3.5 w-3.5" />
                <span>生成 Ed25519</span>
              </Button>
            </>
          )}
        </div>
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />
      {notice && (
        <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200">
          <span>{notice}</span>
          <button onClick={() => setNotice('')} className="underline">
            关闭
          </button>
        </div>
      )}

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
            <EmptyState text="尚未纳管任何 Linux 主机" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                    <th className="py-2 pr-3">名称 / 地址</th>
                    <th className="py-2 pr-3">状态</th>
                    <th className="py-2 pr-3">CPU / 内存利用率</th>
                    <th className="py-2 pr-3">系统 / 架构</th>
                    <th className="py-2 pr-3">Docker</th>
                    <th className="py-2 pr-3"><TermLabel term="时间同步" tip="Raft 一致性依赖各节点系统时间同步（chrony / systemd-timesyncd），偏差过大会导致选举抖动或 TLS 校验异常。" /></th>
                    <th className="py-2 pr-3"><TermLabel term="Machine ID" tip="/etc/machine-id，用于探测克隆虚拟机导致的节点身份冲突。" /></th>
                    {isAdmin && <th className="py-2 text-right">操作</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {nodes.map((n) => {
                    const cpuPct = typeof n.cpu_percent === 'number' && n.cpu_percent >= 0 ? n.cpu_percent : null;
                    const memPct = typeof n.mem_percent === 'number' && n.mem_percent >= 0 ? n.mem_percent : null;
                    return (
                    <tr key={n.id}>
                      <td className="py-2.5 pr-3">
                        <div className="flex flex-wrap items-center gap-1.5 font-medium">
                          <ServerIcon className="h-3.5 w-3.5 text-slate-400" />
                          <span>{n.name}</span>
                          {n.is_control_plane_host && (
                            <span className="inline-flex items-center gap-0.5">
                              <Badge tone="amber">控制面同机</Badge>
                              <InfoTip text="该主机与 NomadDeck 控制面同机：若控制面运行在 Docker 容器中，请勿在本页重装或重启 Docker；组成多节点集群时 advertise_addr 请填写真实内网 IP 而非 127.0.0.1。" />
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-slate-500">
                          {n.ssh_user}@{n.host}:{n.ssh_port}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <Badge tone={statusTone(n.status)}>{n.status || 'unknown'}</Badge>
                      </td>
                      <td className="py-2.5 pr-3 min-w-[160px]">
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
                      <td className="py-2.5 pr-3">
                        <div>{n.os_info || '-'}</div>
                        <div className="font-mono text-slate-500">{n.arch || '-'}</div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <div>{n.docker_mode || '-'} {n.docker_version}</div>
                        <div className="text-slate-500">{n.docker_status || '-'}</div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <div>{n.time_sync || '-'}</div>
                        <div className="text-slate-500">{n.clock_skew_ms ?? 0} ms</div>
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-[11px] text-slate-500">
                        {n.machine_id ? n.machine_id.slice(0, 12) + '…' : '-'}
                      </td>
                      {isAdmin && (
                        <td className="py-2.5 text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button size="sm" onClick={() => void refreshNodeMetrics(n)}>
                              负载
                            </Button>
                            <Button size="sm" onClick={() => void testNode(n)}>
                              探测
                            </Button>
                            <Button size="sm" onClick={() => setPushNode(n)}>
                              推公钥
                            </Button>
                            <Button size="sm" onClick={() => void openDocker(n)}>
                              Docker
                            </Button>
                            <Button size="sm" onClick={() => openEditNode(n)}>
                              编辑
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => setPwResetNode(n)}
                            >
                              重置指纹
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() =>
                                void apiDelete(`/api/v1/nodes/${n.id}`)
                                  .then(() => load())
                                  .catch((ex) => setErr(ex.message))
                              }
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
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
            <EmptyState text="暂无 SSH 密钥" />
          ) : (
            <div className="space-y-3">
              {keys.map((k) => (
                <div
                  key={k.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 p-3 text-xs dark:border-slate-800"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <KeyRound className="h-3.5 w-3.5 text-emerald-500" />
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
                        onClick={() =>
                          void apiDelete(`/api/v1/ssh-keys/${k.id}`)
                            .then(() => load())
                            .catch((ex) => setErr(ex.message))
                        }
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
      <Modal open={showGenKey} title="生成 Ed25519 SSH 密钥对" onClose={() => setShowGenKey(false)}>
        <form onSubmit={generateKey} className="space-y-4">
          <Input label="密钥名称" required value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setShowGenKey(false)}>取消</Button>
            <Button type="submit" variant="primary">生成</Button>
          </div>
        </form>
      </Modal>

      {/* Import SSH key modal */}
      <Modal open={showImportKey} title="导入现有 SSH 私钥" onClose={() => setShowImportKey(false)}>
        <form onSubmit={importKey} className="space-y-4">
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
            <Button type="button" onClick={() => setShowImportKey(false)}>取消</Button>
            <Button type="submit" variant="primary">导入</Button>
          </div>
        </form>
      </Modal>

      {/* Create/Edit Node modal */}
      <Modal open={showNodeModal} title={editingNode ? '编辑主机' : '新增 Linux 主机'} onClose={() => setShowNodeModal(false)}>
        <form onSubmit={saveNode} className="space-y-3">
          <Input label="主机名称" required value={nodeForm.name} onChange={(e) => setNodeForm({ ...nodeForm, name: e.target.value })} />
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <Input label="主机地址 (IP/域名)" required value={nodeForm.host} onChange={(e) => setNodeForm({ ...nodeForm, host: e.target.value })} />
            </div>
            <Input
              label="SSH 端口"
              type="number"
              value={nodeForm.ssh_port}
              onChange={(e) => setNodeForm({ ...nodeForm, ssh_port: Number(e.target.value) })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input label="SSH 用户" required value={nodeForm.ssh_user} onChange={(e) => setNodeForm({ ...nodeForm, ssh_user: e.target.value })} />
            <Select label="SSH 密钥" value={nodeForm.ssh_key_id} onChange={(e) => setNodeForm({ ...nodeForm, ssh_key_id: e.target.value })}>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={nodeForm.use_sudo}
              onChange={(e) => setNodeForm({ ...nodeForm, use_sudo: e.target.checked })}
            />
            <span>使用免密 sudo</span>
          </label>
          <Input label="备注" value={nodeForm.notes} onChange={(e) => setNodeForm({ ...nodeForm, notes: e.target.value })} />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => setShowNodeModal(false)}>取消</Button>
            <Button type="submit" variant="primary">保存</Button>
          </div>
        </form>
      </Modal>

      {/* Push key modal */}
      <Modal open={Boolean(pushNode)} title={`推送公钥到 ${pushNode?.name}`} onClose={() => setPushNode(null)}>
        <form onSubmit={doPushKey} className="space-y-4">
          <p className="text-xs text-slate-500">使用一次性 SSH 密码将关联公钥幂等写入目标主机 authorized_keys，密码仅在内存使用，不入库、不记审计。</p>
          <SecretInput label="目标主机 SSH 密码" required value={pushPassword} onChangeValue={setPushPassword} />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setPushNode(null)}>取消</Button>
            <Button type="submit" variant="primary">推送公钥</Button>
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
          setNotice(`已重置 ${pwResetNode.name} 主机指纹`);
          await load();
        }}
      />
    </div>
  );
}
