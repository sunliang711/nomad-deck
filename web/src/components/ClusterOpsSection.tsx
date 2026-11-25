import React, { useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, Circle, Loader2, Server, ShieldCheck, Terminal } from 'lucide-react';
import { apiGet, fmtTime } from '../lib/api';
import { useOpsDrawer } from '../lib/opsDrawer';
import { isTaskActiveStatus } from '../lib/actionLabels';
import { useConfirm } from './ConfirmDialog';
import { Badge, Button, Card, ExternalUrlLink, Input, StatusBadge, TermLabel } from './UI';

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
  onDeploy: () => Promise<unknown> | void;
  onUpgrade: () => Promise<unknown> | void;
  onRenewCerts: () => Promise<unknown> | void;
  onRotateCA: () => Promise<unknown> | void;
  onRotateGossip?: () => Promise<unknown> | void;
  onDoctor: () => Promise<unknown> | void;
  onReconcile: () => Promise<unknown> | void;
  onRevealRootToken?: () => Promise<unknown> | void;
  onUninstall?: () => Promise<unknown> | void;
  onOpenJoin: () => void;
  onOpenLogs: (node: any) => void;
  onCheckGate?: (node: any) => Promise<unknown> | void;
  onRestartNode: (node: any) => Promise<unknown> | void;
  onRemoveNode: (node: any) => Promise<unknown> | void;
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
  onRevealRootToken,
  onUninstall,
  onOpenJoin,
  onOpenLogs,
  onCheckGate,
  onRestartNode,
  onRemoveNode,
  onError,
}: ClusterOpsSectionProps) {
  const askConfirm = useConfirm();
  const [availableVersions, setAvailableVersions] = useState<string[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const busyRef = useRef(false);
  const { tasks, openTask } = useOpsDrawer();
  const activeTask = tasks.find((task) => task.target_id === cluster.id && isTaskActiveStatus(task.status));

  const runBusy = async (key: string, fn: () => Promise<unknown> | void) => {
    if (busyRef.current || activeTask) return;
    busyRef.current = true;
    setBusyKey(key);
    try {
      await fn();
    } catch (ex: any) {
      onError(ex?.message || '集群操作失败');
    } finally {
      busyRef.current = false;
      setBusyKey('');
    }
  };

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

  const initState = status?.init_state || cluster.init_state;
  const needsDeploy = initState === 'uninitialized';
  const initialized = initState === 'initialized';
  const healthy = (status?.health_status || cluster.health_status) === 'healthy';
  const blocked = Boolean(busyKey || activeTask);
  const productName = isVault ? 'Vault' : 'Nomad';
  const versionPicker = (value: string, onChange: (v: string) => void, label: string) => (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-slate-700 dark:text-slate-300">{label}</span>
        <button type="button" onClick={() => void fetchVersions()} disabled={loadingVersions} className="text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50">{loadingVersions ? '获取中…' : '获取官方版本列表'}</button>
      </div>
      <Input aria-label={label} placeholder="latest 或具体版本号" value={value} onChange={(e) => onChange(e.target.value)} />
      {availableVersions.length > 0 && <select aria-label="选择官方版本" value="" onChange={(e) => e.target.value && onChange(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"><option value="">从官方版本列表选择…</option><option value="latest">latest（最新稳定版）</option>{availableVersions.map((v) => <option key={v} value={v}>{v}</option>)}</select>}
      <p className="text-xs leading-5 text-slate-500">填写 latest 使用最新稳定版，也可指定版本复现环境。</p>
    </div>
  );
  const proxyOption = <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300"><input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} />通过系统代理下载</label>;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0"><div className="rounded-xl bg-indigo-50 p-3 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">{isVault ? <ShieldCheck className="h-5 w-5" /> : <Server className="h-5 w-5" />}</div><div className="min-w-0"><h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 break-all">{cluster.name}</h2><p className="mt-1 text-xs text-slate-500">{productName} · {cluster.mode === 'single' ? '单机体验' : '高可用集群'} · {status ? `${clusterNodes.length} 台主机` : '正在读取主机…'}</p></div></div>
          <div className="flex flex-wrap items-center gap-2"><StatusBadge value={needsDeploy ? 'uninitialized' : status?.health_status || cluster.health_status} />{(status?.maintenance_mode ?? cluster.maintenance_mode) && <Badge tone="amber">维护中</Badge>}<Badge>{clusterVersion === '-' ? '尚未安装' : `v${clusterVersion}`}</Badge></div>
        </div>
        <ol className="mt-5 grid grid-cols-1 gap-2 border-t border-slate-100 pt-4 sm:grid-cols-3 dark:border-slate-800" aria-label="集群搭建进度">
          {[{ label: '配置已创建', done: true }, { label: '部署与初始化', done: initialized }, { label: '集群健康就绪', done: initialized && healthy }].map((step, i) => <li key={step.label} className={`flex items-center gap-2 text-xs ${step.done ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400'}`}>{step.done ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}<span>{i + 1}. {step.label}</span></li>)}
        </ol>
      </div>

      {activeTask && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-500/30 dark:bg-indigo-500/10"><span className="flex items-center gap-2 text-sm text-indigo-800 dark:text-indigo-200"><Loader2 className="h-4 w-4 animate-spin" />集群操作正在后台执行，完成后会自动刷新状态。</span><Button size="sm" onClick={() => openTask(activeTask.id)}>查看任务进度 <ArrowRight className="h-3.5 w-3.5" /></Button></div>}

      {needsDeploy && isAdmin && <Card title="下一步：部署集群服务"><div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(240px,1fr)]"><div><h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">主机已选好，让 {productName} 运行起来</h3><p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">将自动下载程序、配置加密通信、启动服务并完成{isVault ? '初始化与密钥托管' : '集群组建与 ACL 初始化'}。进度可在后台任务中查看。</p></div><div className="space-y-3">{versionPicker(deployVer, setDeployVer, '部署版本')}{proxyOption}{isVault && setConfirmSwap && <label className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200"><input className="mt-0.5" type="checkbox" checked={confirmSwap} onChange={(e) => setConfirmSwap(e.target.checked)} /><span>若主机开启未加密 Swap，我已知悉密钥可能被换出到磁盘，仍继续部署。</span></label>}<Button variant="primary" loading={busyKey === 'deploy'} disabled={blocked} onClick={() => void runBusy('deploy', onDeploy)}>部署集群 <ArrowRight className="h-4 w-4" /></Button></div></div></Card>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="连接与运行信息"><dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-5 gap-y-3 text-sm"><dt className="text-slate-500">初始化</dt><dd><StatusBadge value={initState} /></dd><dt className="text-slate-500">{isVault ? 'Active 主节点' : 'Leader 主节点'}</dt><dd className="font-mono text-xs break-all">{status?.active_node || status?.leader || '等待集群就绪'}</dd><dt className="text-slate-500">CA 到期</dt><dd className="text-xs">{fmtTime(cluster.ca_expires_at)}</dd><dt className="text-slate-500">统一入口</dt><dd className="min-w-0 break-all">{cluster.public_api_url ? <ExternalUrlLink url={cluster.public_api_url} /> : <span className="text-xs text-slate-500">未配置，使用下方节点地址</span>}</dd>{(status?.maintenance_reason || cluster.maintenance_reason) && <><dt className="text-amber-600">维护原因</dt><dd className="break-words text-amber-700 dark:text-amber-300">{status?.maintenance_reason || cluster.maintenance_reason}</dd></>}</dl></Card>
        <Card title={<TermLabel term="Raft 仲裁健康" tip="超过半数投票节点在线，集群才能正常选主和写入。3 个投票节点可容忍 1 台故障。" />}><div className="grid grid-cols-3 gap-3 text-center"><div><div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">{initialized ? status?.healthy_voters ?? '—' : '—'}<span className="text-sm font-normal text-slate-400"> / {initialized ? status?.voters ?? '—' : '—'}</span></div><div className="mt-2 text-xs text-slate-500">健康投票节点</div></div><div><div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">{initialized ? status?.failure_tolerance ?? '—' : '—'}</div><div className="mt-2 text-xs text-slate-500">可容忍故障</div></div><div><div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">{!initialized ? '—' : isVault ? status ? clusterNodes.filter((n) => n.sealed === false).length : '—' : status?.ready_clients ?? '—'}</div><div className="mt-2 text-xs text-slate-500">{isVault ? '已解封节点' : '就绪 Client'}</div></div></div>{!isVault && status && <p className="mt-4 text-xs text-slate-500">成员：{serverCount} 个 Server · {clientCount} 个 Client</p>}{status?.raft_error && <p className="mt-4 break-words text-xs text-amber-700 dark:text-amber-300">仲裁信息暂不可用：{status.raft_error}</p>}{initialized && status?.failure_tolerance === 0 && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">当前没有故障余量，请先恢复异常节点，再进行重启或缩容。</p>}</Card>
      </div>

      <Card
        title="节点成员状态"
        actions={
          isAdmin && (
            <Button size="sm" disabled={blocked || !initialized} onClick={onOpenJoin}>
              扩容节点
            </Button>
          )
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                <th className="py-3 pr-4">节点 / API 地址</th>
                <th className="py-3 pr-4">
                  {isVault ? (
                    <TermLabel
                      term="密封 / 状态"
                      tip="Sealed 表示 Vault 主密钥未在内存中解封，无法提供服务；Unsealed 表示已解封可正常读写。"
                    />
                  ) : (
                    '角色 / 服务状态'
                  )}
                </th>
                <th className="py-3 pr-4">
                  <TermLabel term="Raft 角色" tip="节点在 Raft 共识集群中的角色（leader / follower / voter / none）。" />
                </th>
                <th className="py-3 pr-4">版本</th>
                <th className="py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {clusterNodes.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-slate-500">正在读取节点状态…</td></tr>}
              {clusterNodes.map((n: any) => (
                <tr key={n.node_id}>
                  <td className="py-3 pr-4">
                    <div className="font-medium">{n.name}</div>
                    <div>
                      <ExternalUrlLink url={n.api_addr || n.advertise_addr} />
                    </div>
                  </td>
                  <td className="py-3 pr-4">
                    {isVault ? (
                      <>
                        <Badge tone={n.sealed == null ? 'neutral' : n.sealed ? 'red' : 'green'}>
                          {n.sealed == null ? '待探测' : n.sealed ? '已密封' : '已解封'}
                        </Badge>
                        <span className="ml-1.5"><StatusBadge value={n.service_status} /></span>
                      </>
                    ) : (
                      <>
                        <Badge>{n.role === 'server_client' ? 'Server + Client' : n.role === 'server' ? 'Server' : 'Client'}</Badge>
                        <span className="ml-1.5"><StatusBadge value={n.service_status} /></span>
                      </>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    {n.raft_role === 'leader' ? '主节点' : n.raft_role === 'follower' ? '跟随节点' : !n.raft_role || n.raft_role === 'none' ? '待加入' : n.raft_role}{n.is_voter ? ' · 投票成员' : ''}
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs">{n.installed_version || '-'}</td>
                  <td className="py-3 text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button size="sm" onClick={() => onOpenLogs(n)}>
                        <Terminal className="h-3 w-3" /> 日志
                      </Button>
                      {onCheckGate && (
                        <Button size="sm" loading={busyKey === `gate:${n.node_id}`} disabled={blocked || !initialized} onClick={() => void runBusy(`gate:${n.node_id}`, () => onCheckGate(n))}>
                          <TermLabel
                            term="门禁"
                            tip="检查当前下线或重启该节点是否会导致 Raft 仲裁多数派受损。"
                          />
                        </Button>
                      )}
                      {isAdmin && (
                        <>
                          <Button
                            size="sm"
                            loading={busyKey === `restart:${n.node_id}`}
                            disabled={blocked || !initialized}
                            onClick={async () => {
                              if (
                                !(await askConfirm(`确认重启节点「${n.name}」的 ${product} 服务吗？`, {
                                  title: '重启节点服务',
                                  confirmText: '确认重启',
                                }))
                              ) {
                                return;
                              }
                              await runBusy(`restart:${n.node_id}`, () => onRestartNode(n));
                            }}
                          >
                            重启
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            loading={busyKey === `remove:${n.node_id}`}
                            disabled={blocked || !initialized}
                            onClick={async () => {
                              if (
                                !(await askConfirm(`确定要从集群中缩容移除节点「${n.name}」吗？`, {
                                  title: '缩容移除节点',
                                  confirmText: '确认缩容',
                                  danger: true,
                                }))
                              ) {
                                return;
                              }
                              await runBusy(`remove:${n.node_id}`, () => onRemoveNode(n));
                            }}
                          >
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

      {isAdmin && <Card title="集群运维" actions={<Button size="sm" loading={busyKey === 'doctor'} disabled={blocked || !initialized} onClick={() => void runBusy('doctor', onDoctor)}>集群体检</Button>}>
        <div className="space-y-3">
          {!needsDeploy && <details className="ops-disclosure"><summary>版本升级<span>按节点逐一升级服务</span></summary><div className="ops-disclosure-body space-y-3 max-w-lg">{versionPicker(upVer, setUpVer, '目标版本')}{proxyOption}{!isVault && setDrainClients && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={drainClients} onChange={(e) => setDrainClients(e.target.checked)} />升级前疏散 Client，将任务迁移到其他节点</label>}<Button loading={busyKey === 'upgrade'} disabled={blocked} onClick={() => void runBusy('upgrade', onUpgrade)}>开始滚动升级</Button></div></details>}
          <details className="ops-disclosure"><summary>证书与访问凭据<span>续期、轮换与管理员凭据</span></summary><div className="ops-disclosure-body"><p className="mb-3 text-xs leading-5 text-slate-500">证书和密钥轮换会更新节点配置。请在集群健康时执行，并在后台任务中确认结果。</p><div className="flex flex-wrap gap-2"><Button size="sm" loading={busyKey === 'renew'} disabled={blocked || !initialized} onClick={() => void runBusy('renew', onRenewCerts)}>续期证书</Button><Button size="sm" disabled={blocked || !initialized} onClick={() => void runBusy('ca', onRotateCA)}>轮换 CA</Button>{!isVault && onRotateGossip && <Button size="sm" disabled={blocked || !initialized} onClick={() => void runBusy('gossip', onRotateGossip)}>轮换 Gossip</Button>}{!isVault && onRevealRootToken && initialized && <Button size="sm" disabled={blocked} onClick={() => void runBusy('root-token', onRevealRootToken)}>查看 Root Token</Button>}</div></div></details>
          <details className="ops-disclosure"><summary>异常恢复<span>核对实际状态后解除维护锁</span></summary><div className="ops-disclosure-body"><p className="mb-3 text-xs leading-5 text-slate-500">任务中断或状态不一致时，先核对远端服务。核对成功后解除维护屏障。</p><Button size="sm" loading={busyKey === 'reconcile'} disabled={blocked} onClick={() => void runBusy('reconcile', onReconcile)}>核对并解锁</Button></div></details>
          {onUninstall && <details className="ops-disclosure border-rose-200 dark:border-rose-900/60"><summary className="text-rose-700 dark:text-rose-300">危险操作<span>卸载服务并清除集群数据</span></summary><div className="ops-disclosure-body"><p className="mb-3 text-xs leading-5 text-slate-500">将影响此集群的全部节点，请先保存需要的数据。操作前需要确认集群名称及管理员密码。</p><Button size="sm" variant="danger" loading={busyKey === 'uninstall'} disabled={blocked} onClick={() => void runBusy('uninstall', onUninstall)}>{needsDeploy && clusterNodes.every((n: any) => n.install_state === 'pending') ? '删除未部署集群' : '卸载集群'}</Button></div></details>}
        </div>
      </Card>}
    </div>
  );
}
