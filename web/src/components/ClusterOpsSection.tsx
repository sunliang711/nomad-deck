import React, { useState } from 'react';
import { Terminal } from 'lucide-react';
import { apiGet, fmtTime } from '../lib/api';
import { Badge, Button, Card, ExternalUrlLink, Input, TermLabel, statusTone } from './UI';

interface ClusterOpsSectionProps {
  product: 'nomad' | 'vault';
  cluster: any;
  status: any;
  clusterNodes: any[];
  isAdmin: boolean;
  deployVer: string;
  setDeployVer: (v: string) => void;
  upVer: string;
  setUpVer: (v: string) => void;
  useProxy: boolean;
  setUseProxy: (v: boolean) => void;
  confirmSwap?: boolean;
  setConfirmSwap?: (v: boolean) => void;
  drainClients?: boolean;
  setDrainClients?: (v: boolean) => void;
  onDeploy: () => void;
  onUpgrade: () => void;
  onRenewCerts: () => void;
  onRotateCA: () => void;
  onRotateGossip?: () => void;
  onDoctor: () => void;
  onReconcile: () => void;
  onOpenJoin: () => void;
  onOpenLogs: (node: any) => void;
  onCheckGate?: (node: any) => void;
  onRestartNode: (node: any) => void;
  onRemoveNode: (node: any) => void;
  onError: (msg: string) => void;
}

export function ClusterOpsSection({
  product,
  cluster,
  status,
  clusterNodes,
  isAdmin,
  deployVer,
  setDeployVer,
  upVer,
  setUpVer,
  useProxy,
  setUseProxy,
  confirmSwap = false,
  setConfirmSwap,
  drainClients = true,
  setDrainClients,
  onDeploy,
  onUpgrade,
  onRenewCerts,
  onRotateCA,
  onRotateGossip,
  onDoctor,
  onReconcile,
  onOpenJoin,
  onOpenLogs,
  onCheckGate,
  onRestartNode,
  onRemoveNode,
  onError,
}: ClusterOpsSectionProps) {
  const [availableVersions, setAvailableVersions] = useState<string[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);

  const fetchVersions = async () => {
    setLoadingVersions(true);
    try {
      const res = await apiGet(`/api/v1/releases/${product}?use_proxy=${useProxy ? 'true' : 'false'}`);
      setAvailableVersions((res.versions || []).slice(0, 25));
    } catch (ex: any) {
      onError(ex?.message || `获取 ${product} 版本列表失败`);
    } finally {
      setLoadingVersions(false);
    }
  };

  const clusterVersion =
    cluster.settings?.version ||
    clusterNodes.find((n: any) => n.installed_version)?.installed_version ||
    '-';

  const isVault = product === 'vault';
  const serverCount = clusterNodes.filter((n: any) => n.role === 'server' || n.role === 'server_client').length;
  const clientCount = clusterNodes.filter((n: any) => n.role === 'client' || n.role === 'server_client').length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="集群概要">
          <div className="space-y-1.5 text-xs">
            <div>
              健康状态：<Badge tone={statusTone(cluster.health_status)}>{cluster.health_status}</Badge>
            </div>
            <div>
              初始化状态：<span className="font-mono">{cluster.init_state}</span>
            </div>
            <div>维护模式：{cluster.maintenance_mode ? `是 (${cluster.maintenance_reason})` : '否'}</div>
            <div>
              {isVault ? 'Active 节点' : 'Leader 节点'}：
              <span className="font-mono">{status?.active_node || status?.leader || '-'}</span>
            </div>
            <div>
              当前版本：<span className="font-mono">{clusterVersion}</span>
            </div>
            <div>CA 到期：{fmtTime(cluster.ca_expires_at)}</div>
            <div>
              统一入口：<ExternalUrlLink url={cluster.public_api_url} />
            </div>
          </div>
        </Card>

        <Card
          title={
            <TermLabel
              term="Raft 仲裁概览"
              tip="Raft 协议需要超过半数的投票节点在线才能选出 Leader 并写入数据；可容忍故障数表示在不失多数派前提下允许离线或重启的节点上限。"
            />
          }
        >
          <div className="space-y-1.5 text-xs">
            <div>
              <TermLabel term="投票成员" tip="参与 Raft 共识投票的节点（Voter）总数与当前健康数。" />：
              {status?.voters ?? '-'}（健康 {status?.healthy_voters ?? '-'}）
            </div>
            <div>
              <TermLabel term="可容忍故障数" tip="当前多数派还能容忍同时故障的节点数；为 0 时禁止再下线任意 Voter。" />：
              <b>{status?.failure_tolerance ?? '-'}</b>
            </div>
            {!isVault && (
              <div>
                成员构成：
                <TermLabel term="Servers" tip="负责集群调度、状态存储与 Raft 仲裁的控制面节点。" /> {serverCount} ·{' '}
                <TermLabel term="Clients" tip="负责实际运行容器/任务的工作节点。" /> {clientCount}
              </div>
            )}
            {status?.failure_tolerance === 0 && (
              <div className="rounded bg-rose-50 p-2 text-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
                注意：可容忍故障数为 0，再有一台投票节点下线将失去多数派！
              </div>
            )}
          </div>
        </Card>

        {isAdmin && (
          <Card title="部署与集群运维">
            <div className="space-y-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <TermLabel
                  term="安装 / 升级版本"
                  tip="支持输入具体版本号（如 1.18.3）或填写 latest 自动解析官方最新稳定版本。"
                />
                <button
                  type="button"
                  onClick={() => void fetchVersions()}
                  disabled={loadingVersions}
                  className="text-[11px] font-medium text-emerald-600 hover:underline disabled:opacity-50 dark:text-emerald-400"
                >
                  {loadingVersions ? '获取中...' : '拉取可选版本'}
                </button>
              </div>

              {availableVersions.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <select
                    value=""
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return;
                      if (cluster.init_state === 'uninitialized') setDeployVer(v);
                      else setUpVer(v);
                    }}
                    className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
                  >
                    <option value="">从官方版本列表选择...</option>
                    <option value="latest">latest（最新稳定版）</option>
                    {availableVersions.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex gap-1.5">
                <div className="flex-1">
                  <Input
                    placeholder="latest 或版本号"
                    value={deployVer}
                    onChange={(e) => setDeployVer(e.target.value)}
                  />
                </div>
                <Button size="sm" onClick={() => setDeployVer('latest')} title="设为 latest">
                  latest
                </Button>
                <Button variant="primary" onClick={onDeploy}>
                  部署
                </Button>
              </div>

              <div className="flex gap-1.5">
                <div className="flex-1">
                  <Input
                    placeholder="升级版本 (latest 或版本号)"
                    value={upVer}
                    onChange={(e) => setUpVer(e.target.value)}
                  />
                </div>
                <Button size="sm" onClick={() => setUpVer('latest')} title="设为 latest">
                  latest
                </Button>
                <Button onClick={onUpgrade}>升级</Button>
              </div>

              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} />
                <span>使用系统代理</span>
              </label>

              {isVault && setConfirmSwap && (
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={confirmSwap}
                    onChange={(e) => setConfirmSwap(e.target.checked)}
                  />
                  <TermLabel
                    term="部署确认未加密 Swap 风险"
                    tip="Vault 运行时会禁用 mlock，若宿主机开启了未加密 Swap，内存中的密钥明文可能被交换到磁盘。"
                  />
                </label>
              )}

              {!isVault && setDrainClients && (
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={drainClients}
                    onChange={(e) => setDrainClients(e.target.checked)}
                  />
                  <TermLabel
                    term="升级前疏散 Client 节点"
                    tip="开启后，升级每台 Nomad Client 前会先 Drain 迁移其上运行中的任务，再重启升级。"
                  />
                </label>
              )}

              <div className="flex flex-wrap gap-1.5 pt-0.5">
                <Button size="sm" onClick={onRenewCerts}>
                  续期证书
                </Button>
                <Button size="sm" onClick={onRotateCA}>
                  轮换 CA
                </Button>
                {!isVault && onRotateGossip && (
                  <Button size="sm" onClick={onRotateGossip}>
                    <TermLabel
                      term="轮换 Gossip"
                      tip="轮换 Nomad Server 之间 Serf Gossip 集群发现通信使用的对称加密密钥。"
                    />
                  </Button>
                )}
                <Button size="sm" onClick={onDoctor}>
                  Doctor 体检
                </Button>
                <Button size="sm" onClick={onReconcile}>
                  核对解锁
                </Button>
              </div>
            </div>
          </Card>
        )}
      </div>

      <Card
        title="节点成员状态"
        actions={
          isAdmin && (
            <Button size="sm" onClick={onOpenJoin}>
              扩容节点
            </Button>
          )
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                <th className="py-2 pr-3">节点 / API 地址</th>
                <th className="py-2 pr-3">
                  {isVault ? (
                    <TermLabel
                      term="密封 / 状态"
                      tip="Sealed 表示 Vault 主密钥未在内存中解封，无法提供服务；Unsealed 表示已解封可正常读写。"
                    />
                  ) : (
                    '角色 / 服务状态'
                  )}
                </th>
                <th className="py-2 pr-3">
                  <TermLabel term="Raft 角色" tip="节点在 Raft 共识集群中的角色（leader / follower / voter / none）。" />
                </th>
                <th className="py-2 pr-3">版本</th>
                <th className="py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {clusterNodes.map((n: any) => (
                <tr key={n.node_id}>
                  <td className="py-2 pr-3">
                    <div className="font-medium">{n.name}</div>
                    <div>
                      <ExternalUrlLink url={n.api_addr || n.advertise_addr} />
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    {isVault ? (
                      <>
                        <Badge tone={n.sealed == null ? 'neutral' : n.sealed ? 'red' : 'green'}>
                          {n.sealed == null ? 'Unknown' : n.sealed ? 'Sealed' : 'Unsealed'}
                        </Badge>
                        <span className="ml-1.5 text-slate-500">{n.service_status}</span>
                      </>
                    ) : (
                      <>
                        <Badge>{n.role}</Badge>
                        <span className="ml-1.5 text-slate-500">{n.service_status}</span>
                      </>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {n.raft_role} {n.is_voter ? '(voter)' : ''}
                  </td>
                  <td className="py-2 pr-3 font-mono">{n.installed_version || '-'}</td>
                  <td className="py-2 text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button size="sm" onClick={() => onOpenLogs(n)}>
                        <Terminal className="h-3 w-3" /> 日志
                      </Button>
                      {onCheckGate && (
                        <Button size="sm" onClick={() => onCheckGate(n)}>
                          <TermLabel
                            term="门禁"
                            tip="检查当前下线或重启该节点是否会导致 Raft 仲裁多数派受损。"
                          />
                        </Button>
                      )}
                      {isAdmin && (
                        <>
                          <Button size="sm" onClick={() => onRestartNode(n)}>
                            重启
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => onRemoveNode(n)}>
                            缩容
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
