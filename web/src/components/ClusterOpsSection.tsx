import React, { useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, ArrowUpCircle, CheckCircle2, Circle, KeyRound, Loader2, Server, ShieldAlert, ShieldCheck, SlidersHorizontal, Terminal, Trash2, Wrench } from 'lucide-react';
import { apiGet, fmtTime } from '../lib/api';
import { useOpsDrawer } from '../lib/opsDrawer';
import { isTaskActiveStatus } from '../lib/actionLabels';
import { useConfirm } from './ConfirmDialog';
import { Badge, Button, Card, ExternalUrlLink, Input, Modal, Select, StatusBadge, TermLabel } from './UI';

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
  onInitVault?: () => Promise<unknown> | void;
  onUpgrade: () => Promise<unknown> | void;
  onRenewCerts: () => Promise<unknown> | void;
  onRotateCA: () => Promise<unknown> | void;
  onRotateGossip?: () => Promise<unknown> | void;
  onDoctor: () => Promise<unknown> | void;
  onReconcile: () => Promise<unknown> | void;
  onRevealRootToken?: () => Promise<unknown> | void;
  onOpenWebUI?: (targetUrl: string, label?: string) => void;
  onUninstall?: () => Promise<unknown> | void;
  onOpenJoin: () => void;
  onOpenLogs: (node: any) => void;
  onCheckGate?: (node: any) => Promise<unknown> | void;
  onRestartNode: (node: any) => Promise<unknown> | void;
  onRemoveNode: (node: any, force: boolean) => Promise<unknown> | void;
  onOpenClusterSettings?: () => void;
  onConfigureNode?: (node: any) => void;
  nodeConfigs?: Record<string, any>;
  onError: (msg: string) => void;
  quickActions?: React.ReactNode;
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
  onInitVault,
  onUpgrade,
  onRenewCerts,
  onRotateCA,
  onRotateGossip,
  onDoctor,
  onReconcile,
  onRevealRootToken,
  onOpenWebUI,
  onUninstall,
  onOpenJoin,
  onOpenLogs,
  onCheckGate,
  onRestartNode,
  onRemoveNode,
  onOpenClusterSettings,
  onConfigureNode,
  nodeConfigs,
  onError,
  quickActions,
}: ClusterOpsSectionProps) {
  const askConfirm = useConfirm();
  const [availableVersions, setAvailableVersions] = useState<string[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [removeTarget, setRemoveTarget] = useState<any | null>(null);
  const [forceRemove, setForceRemove] = useState(false);
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
  const anyInstalled = clusterNodes.some(
    (n: any) => Boolean(n.installed_version) || (n.install_state && n.install_state !== 'pending') || n.service_status === 'active',
  );
  const isNotDeployed = needsDeploy && !anyInstalled;
  const isVaultAwaitInit = isVault && needsDeploy && anyInstalled;
  const blocked = Boolean(busyKey || activeTask);
  const productName = isVault ? 'Vault' : 'Nomad';
  const isSingleMode = cluster.mode === 'single';

  const versionPicker = (value: string, onChange: (v: string) => void, label: string) => (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-slate-700 dark:text-slate-300">{label}</span>
        <button
          type="button"
          onClick={() => void fetchVersions()}
          disabled={loadingVersions}
          className="text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50"
        >
          {loadingVersions ? '获取中…' : '获取官方版本列表'}
        </button>
      </div>
      <Input aria-label={label} placeholder="latest 或具体版本号" value={value} onChange={(e) => onChange(e.target.value)} />
      {availableVersions.length > 0 && (
        <Select
          aria-label="选择官方版本"
          value=""
          onChange={(e) => e.target.value && onChange(e.target.value)}
        >
          <option value="">从官方版本列表选择…</option>
          <option value="latest">latest（最新稳定版）</option>
          {availableVersions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Select>
      )}
      <p className="text-xs leading-5 text-slate-500">填写 latest 自动安装最新稳定版，也可指定具体版本号。</p>
    </div>
  );

  const proxyOption = (
    <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
      <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} />
      通过系统代理下载
    </label>
  );

  const headerStatusValue = isNotDeployed
    ? 'uninitialized'
    : isVaultAwaitInit
      ? 'sealed'
      : status?.health_status || cluster.health_status;

  const progressSteps = isVault
    ? [
        { label: '配置已创建', done: true },
        { label: '部署并启动服务', done: anyInstalled || initialized },
        { label: '初始化托管与健康就绪', done: initialized && healthy },
      ]
    : [
        { label: '配置已创建', done: true },
        { label: '部署与 ACL 初始化', done: initialized },
        { label: '集群健康就绪', done: initialized && healthy },
      ];

  return (
    <div className="space-y-5">
      {/* 顶部集群身份与进度卡片 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="rounded-xl bg-indigo-50 p-3 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
              {isVault ? <ShieldCheck className="h-5 w-5" /> : <Server className="h-5 w-5" />}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 break-all">{cluster.name}</h2>
                <StatusBadge
                  value={headerStatusValue}
                  label={isVaultAwaitInit ? '已安装 · 待初始化' : undefined}
                />
                {(status?.maintenance_mode ?? cluster.maintenance_mode) && <Badge tone="amber">维护中</Badge>}
                <Badge>{clusterVersion === '-' ? '尚未安装' : `v${clusterVersion}`}</Badge>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {productName} · {isSingleMode ? '单机体验' : '高可用集群'} · {status ? `${clusterNodes.length} 台主机` : '正在读取主机…'}
              </p>
            </div>
          </div>
          {initialized && quickActions && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">{quickActions}</div>
          )}
        </div>

        {!(initialized && healthy) && (
          <ol className="mt-5 grid grid-cols-1 gap-2 border-t border-slate-100 pt-4 sm:grid-cols-3 dark:border-slate-800" aria-label="集群搭建进度">
            {progressSteps.map((step, i) => (
              <li
                key={step.label}
                className={`flex items-center gap-2 text-xs font-medium ${
                  step.done ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {step.done ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <Circle className="h-4 w-4 shrink-0" />}
                <span>
                  {i + 1}. {step.label}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* 后台执行状态条 */}
      {activeTask && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-500/30 dark:bg-indigo-500/10"
        >
          <span className="flex items-center gap-2 text-sm text-indigo-800 dark:text-indigo-200">
            <Loader2 className="h-4 w-4 animate-spin" />
            集群操作正在后台执行，完成后会自动刷新状态。
          </span>
          <Button size="sm" onClick={() => openTask(activeTask.id)}>
            查看任务进度 <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* 阶段 1：尚未部署任何节点 */}
      {isNotDeployed && isAdmin && (
        <Card
          title="下一步：部署集群服务"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {onOpenClusterSettings && (
                <Button size="sm" disabled={blocked} onClick={onOpenClusterSettings}>
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  <span>集群配置</span>
                </Button>
              )}
              {onUninstall && (
                <Button size="sm" variant="ghost" disabled={blocked} onClick={() => void runBusy('uninstall', onUninstall)}>
                  <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                  <span className="text-rose-600 dark:text-rose-400">删除未部署配置</span>
                </Button>
              )}
            </div>
          }
        >
          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(260px,1fr)]">
            <div className="space-y-3">
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                主机已就绪，开始部署 {productName}
              </h3>
              <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">
                {isVault
                  ? '控制面将通过 SSH 下载官方 Vault 程序包、生成 TLS 证书并启动服务。启动完成后，可直接在当前页面一键初始化并自动解封。'
                  : '控制面将通过 SSH 下载官方 Nomad 程序包、配置 mTLS 加密通信、启动服务并自动完成集群组建与 ACL 初始化。'}
              </p>
              <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300 space-y-2">
                <div className="font-medium text-slate-800 dark:text-slate-100">已选目标主机 ({clusterNodes.length})</div>
                {clusterNodes.map((n: any) => {
                  const cfg = nodeConfigs?.[n.node_id];
                  const hvCount = Array.isArray(cfg?.host_volumes) ? cfg.host_volumes.length : 0;
                  return (
                    <div key={n.node_id} className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5 font-mono">
                        <span className="font-semibold text-slate-800 dark:text-slate-100">{n.name}</span>
                        <span className="text-slate-500">{n.api_addr || n.advertise_addr}</span>
                        {cfg?.cni && <Badge tone="blue">CNI</Badge>}
                        {cfg?.raw_exec && <Badge tone="amber">raw_exec</Badge>}
                        {hvCount > 0 && <Badge tone="green">HostVolume×{hvCount}</Badge>}
                      </div>
                      {onConfigureNode && (
                        <Button size="sm" disabled={blocked} onClick={() => onConfigureNode(n)}>
                          <SlidersHorizontal className="h-3 w-3" />
                          <span>插件/配置</span>
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="space-y-3.5">
              {versionPicker(deployVer, setDeployVer, '部署版本')}
              {proxyOption}
              {isVault && setConfirmSwap && (
                <label className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 cursor-pointer">
                  <input
                    className="mt-0.5"
                    type="checkbox"
                    checked={confirmSwap}
                    onChange={(e) => setConfirmSwap(e.target.checked)}
                  />
                  <span>若目标主机开启未加密 Swap，我已知悉内存密钥可能被换出到磁盘，仍继续部署。</span>
                </label>
              )}
              <Button variant="primary" loading={busyKey === 'deploy'} disabled={blocked} onClick={() => void runBusy('deploy', onDeploy)}>
                部署集群 <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* 阶段 2（Vault 专属）：二进制已安装运行，引导一键初始化托管 */}
      {isVaultAwaitInit && isAdmin && (
        <Card title="下一步：初始化 Vault 并托管密钥">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1.5 max-w-2xl">
              <div className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100">
                <KeyRound className="h-4 w-4 text-indigo-500" />
                <span>Vault 服务已安装运行（v{clusterVersion}），等待首次初始化</span>
              </div>
              <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">
                点击右侧按钮将自动执行 Shamir 密钥分片初始化、加密托管 Unseal Key 并完成自动解封。完成后即可在「Auth / Policy / KV」中管理密钥或对接 Nomad 联动。
              </p>
            </div>
            {onInitVault && (
              <Button
                variant="primary"
                loading={busyKey === 'init-vault'}
                disabled={blocked}
                onClick={() => void runBusy('init-vault', onInitVault)}
              >
                <KeyRound className="h-4 w-4" />
                <span>一键初始化并解封 Vault</span>
              </Button>
            )}
          </div>
        </Card>
      )}

      {/* 已部署后才展示连接信息、仲裁健康、节点成员表与运维工具箱 */}
      {!isNotDeployed && (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card title="连接与运行信息">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-5 gap-y-3 text-sm">
                <dt className="text-slate-500">初始化状态</dt>
                <dd>
                  <StatusBadge value={initState} label={isVaultAwaitInit ? '待初始化托管' : undefined} />
                </dd>
                <dt className="text-slate-500">{isVault ? 'Active 主节点' : 'Leader 主节点'}</dt>
                <dd className="font-mono text-xs break-all">{status?.active_node || status?.leader || (isVaultAwaitInit ? '初始化后自动选主' : '等待集群就绪')}</dd>
                <dt className="text-slate-500">CA 证书到期</dt>
                <dd className="text-xs">{fmtTime(cluster.ca_expires_at)}</dd>
                <dt className="text-slate-500">统一入口</dt>
                <dd className="min-w-0 break-all">
                  {cluster.public_api_url ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <ExternalUrlLink url={cluster.public_api_url} />
                      {(isVault || !cluster?.settings?.ui?.disabled) && isAdmin && initialized && onOpenWebUI && /^https?:\/\//i.test(cluster.public_api_url) && (
                        <button
                          type="button"
                          onClick={() => onOpenWebUI(cluster.public_api_url, '统一入口')}
                          title={`验证管理员密码后生成 1 小时有效的 ${productName} 免密登录链接`}
                          className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-300 dark:hover:bg-indigo-500/25"
                        >
                          <KeyRound className="h-3 w-3" />
                          <span>免密进 UI</span>
                        </button>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-slate-500">未配置，直接使用下方节点地址</span>
                  )}
                </dd>
                {(status?.maintenance_reason || cluster.maintenance_reason) && (
                  <>
                    <dt className="text-amber-600">维护原因</dt>
                    <dd className="break-words text-amber-700 dark:text-amber-300">{status?.maintenance_reason || cluster.maintenance_reason}</dd>
                  </>
                )}
              </dl>
            </Card>

            <Card
              title={
                <TermLabel
                  term={isSingleMode ? '单机运行健康' : 'Raft 仲裁健康'}
                  tip={
                    isSingleMode
                      ? '单机体验模式共 1 个节点，用于学习与功能测试；如需容忍单节点宕机，请使用 3 台及以上主机组建高可用集群。'
                      : '超过半数投票节点在线，集群才能正常选主和写入。3 个投票节点可容忍 1 台故障。'
                  }
                />
              }
            >
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {initialized ? status?.healthy_voters ?? (isSingleMode && healthy ? 1 : '—') : '—'}
                    <span className="text-sm font-normal text-slate-400">
                      {' '}
                      / {initialized ? status?.voters ?? (isSingleMode ? 1 : '—') : '—'}
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-slate-500">{isSingleMode ? '在线节点' : '健康投票节点'}</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {initialized ? (isSingleMode ? '0 (单机)' : status?.failure_tolerance ?? '—') : '—'}
                  </div>
                  <div className="mt-2 text-xs text-slate-500">可容忍故障</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {!initialized
                      ? '—'
                      : isVault
                        ? status
                          ? clusterNodes.filter((n) => n.sealed === false && n.service_status === 'active').length
                          : '—'
                        : status?.ready_clients ?? '—'}
                  </div>
                  <div className="mt-2 text-xs text-slate-500">{isVault ? '已解封节点' : '就绪 Client'}</div>
                </div>
              </div>
              {!isVault && status && (
                <p className="mt-4 text-xs text-slate-500">
                  节点角色：{serverCount} 个 Server · {clientCount} 个 Client
                </p>
              )}
              {isSingleMode && initialized && healthy && (
                <p className="mt-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                  单机体验模式运行正常，不支持节点宕机容灾；生产环境建议使用 3 台主机。
                </p>
              )}
              {status?.raft_error && (
                <p className="mt-4 break-words text-xs text-amber-700 dark:text-amber-300">仲裁信息暂不可用：{status.raft_error}</p>
              )}
              {!isSingleMode && initialized && status?.failure_tolerance === 0 && (
                <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                  当前高可用集群没有故障余量，请先恢复异常节点，再进行重启或缩容。
                </p>
              )}
            </Card>
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
                  {clusterNodes.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-500">
                        正在读取节点状态…
                      </td>
                    </tr>
                  )}
                  {clusterNodes.map((n: any) => {
                    const nodeInstalled = Boolean(n.installed_version) || n.service_status === 'active' || n.reachable;
                    return (
                      <tr key={n.node_id}>
                        <td className="py-3 pr-4">
                          <div className="font-medium text-slate-900 dark:text-slate-100">{n.name}</div>
                          <div className="flex flex-wrap items-center gap-2">
                            <ExternalUrlLink url={n.api_addr || n.advertise_addr} />
                            {(isVault || (n.role !== 'client' && !cluster?.settings?.ui?.disabled)) &&
                              isAdmin &&
                              initialized &&
                              nodeInstalled &&
                              onOpenWebUI &&
                              /^https?:\/\//i.test(String(n.api_addr || n.advertise_addr || '')) && (
                              <button
                                type="button"
                                onClick={() => onOpenWebUI(String(n.api_addr || n.advertise_addr), n.name)}
                                title={`验证管理员密码后生成 1 小时有效的 ${productName} 免密登录链接`}
                                className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-300 dark:hover:bg-indigo-500/25"
                              >
                                <KeyRound className="h-3 w-3" />
                                <span>免密进 UI</span>
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="py-3 pr-4">
                          {isVault ? (
                            <div className="flex flex-wrap items-center gap-1.5">
                              {!nodeInstalled ? (
                                <Badge>待部署</Badge>
                              ) : (
                                <Badge tone={n.sealed == null ? 'neutral' : n.sealed ? 'red' : 'green'}>
                                  {n.sealed == null ? '待探测' : n.sealed ? '已密封' : '已解封'}
                                </Badge>
                              )}
                              <StatusBadge value={n.service_status} />
                            </div>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge>{n.role === 'server_client' ? 'Server + Client' : n.role === 'server' ? 'Server' : 'Client'}</Badge>
                              <StatusBadge value={n.service_status} />
                              {nodeConfigs?.[n.node_id]?.cni && <Badge tone="blue">CNI</Badge>}
                              {nodeConfigs?.[n.node_id]?.raw_exec && <Badge tone="amber">raw_exec</Badge>}
                              {Array.isArray(nodeConfigs?.[n.node_id]?.host_volumes) && nodeConfigs[n.node_id].host_volumes.length > 0 && (
                                <Badge tone="green">HV×{nodeConfigs[n.node_id].host_volumes.length}</Badge>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          {n.raft_role === 'leader' || n.raft_role === 'active'
                            ? '主节点'
                            : n.raft_role === 'follower' || n.raft_role === 'standby'
                              ? '跟随节点'
                              : !n.raft_role || n.raft_role === 'none'
                                ? isVaultAwaitInit
                                  ? '待初始化'
                                  : '待加入'
                                : n.raft_role}
                          {n.is_voter ? ' · 投票成员' : ''}
                        </td>
                        <td className="py-3 pr-4 font-mono text-xs">{n.installed_version || '-'}</td>
                        <td className="py-3 text-right">
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <Button size="sm" onClick={() => onOpenLogs(n)}>
                              <Terminal className="h-3 w-3" /> 日志
                            </Button>
                            {onCheckGate && (
                              <Button
                                size="sm"
                                title="检查当前下线或重启该节点是否会导致 Raft 仲裁多数派受损"
                                loading={busyKey === `gate:${n.node_id}`}
                                disabled={blocked || !initialized}
                                onClick={() => void runBusy(`gate:${n.node_id}`, () => onCheckGate(n))}
                              >
                                门禁
                              </Button>
                            )}
                            {isAdmin && (
                              <>
                                {onConfigureNode && (
                                  <Button
                                    size="sm"
                                    disabled={blocked}
                                    onClick={() => onConfigureNode(n)}
                                  >
                                    <SlidersHorizontal className="h-3 w-3" /> 插件/配置
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  loading={busyKey === `restart:${n.node_id}`}
                                  disabled={blocked || (!initialized && !nodeInstalled)}
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
                                {(() => {
                                  const isLastNode = clusterNodes.length <= 1;
                                  const isOnlyNomadServer =
                                    !isVault && (n.role === 'server' || n.role === 'server_client') && serverCount <= 1;
                                  const mustUninstallInstead = isLastNode || isOnlyNomadServer;
                                  if (mustUninstallInstead && onUninstall) {
                                    return (
                                      <Button
                                        size="sm"
                                        variant="danger-outline"
                                        loading={busyKey === 'uninstall'}
                                        disabled={blocked}
                                        title={
                                          isLastNode
                                            ? '这是集群的最后一个节点，点击将卸载并清理整个集群（失联节点可勾选强制卸载）'
                                            : '该节点是集群唯一 Server，点击将卸载并清理整个集群（失联节点可勾选强制卸载）'
                                        }
                                        onClick={() => void runBusy('uninstall', onUninstall)}
                                      >
                                        卸载清理
                                      </Button>
                                    );
                                  }
                                  return (
                                    <Button
                                      size="sm"
                                      variant="danger-outline"
                                      loading={busyKey === `remove:${n.node_id}`}
                                      disabled={blocked || mustUninstallInstead}
                                      title={
                                        isLastNode
                                          ? '集群仅剩 1 个节点，如需清理请使用下方卸载集群'
                                          : isOnlyNomadServer
                                            ? '不能移除集群的最后一台 Server'
                                            : undefined
                                      }
                                      onClick={() => {
                                        setRemoveTarget(n);
                                        setForceRemove(false);
                                      }}
                                    >
                                      缩容
                                    </Button>
                                  );
                                })()}
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
          </Card>

          {isAdmin && (
            <Card
              title="集群运维"
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  {onOpenClusterSettings && (
                    <Button size="sm" disabled={blocked} onClick={onOpenClusterSettings}>
                      <SlidersHorizontal className="h-3.5 w-3.5" />
                      <span>集群配置</span>
                    </Button>
                  )}
                  <Button size="sm" loading={busyKey === 'doctor'} disabled={blocked || !initialized} onClick={() => void runBusy('doctor', onDoctor)}>
                    集群体检
                  </Button>
                </div>
              }
            >
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {!needsDeploy && (
                  <div className="flex flex-col justify-between gap-3 rounded-xl border border-slate-200/80 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-950/40">
                    <div className="space-y-3">
                      <div className="flex items-start gap-2.5">
                        <div className="rounded-lg bg-indigo-50 p-2 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300 shrink-0">
                          <ArrowUpCircle className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">版本升级</h3>
                            {clusterVersion !== '-' && <Badge>当前 v{clusterVersion}</Badge>}
                          </div>
                          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">按节点逐一滚动升级服务，降低业务中断风险。</p>
                        </div>
                      </div>
                      {versionPicker(upVer, setUpVer, '目标版本')}
                      <div className="space-y-1.5">
                        {proxyOption}
                        {!isVault && setDrainClients && (
                          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                            <input type="checkbox" checked={drainClients} onChange={(e) => setDrainClients(e.target.checked)} />
                            升级前疏散 Client，将任务迁移到其他节点
                          </label>
                        )}
                      </div>
                    </div>
                    <div className="pt-1">
                      <Button size="sm" loading={busyKey === 'upgrade'} disabled={blocked} onClick={() => void runBusy('upgrade', onUpgrade)}>
                        开始滚动升级
                      </Button>
                    </div>
                  </div>
                )}

                <div className="flex flex-col justify-between gap-3 rounded-xl border border-slate-200/80 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-950/40">
                  <div className="space-y-2.5">
                    <div className="flex items-start gap-2.5">
                      <div className="rounded-lg bg-emerald-50 p-2 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300 shrink-0">
                        <KeyRound className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">证书与访问凭据</h3>
                        <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
                          {isVault
                            ? '续期节点 TLS 证书或轮换集群根 CA。请在集群健康时执行，并在后台任务中确认结果。'
                            : '续期节点证书、轮换 CA / Gossip 密钥或查看管理员凭据。请在集群健康时执行，并在后台任务中确认结果。'}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button size="sm" loading={busyKey === 'renew'} disabled={blocked || !initialized} onClick={() => void runBusy('renew', onRenewCerts)}>
                      续期证书
                    </Button>
                    <Button size="sm" disabled={blocked || !initialized} onClick={() => void runBusy('ca', onRotateCA)}>
                      轮换 CA
                    </Button>
                    {!isVault && onRotateGossip && (
                      <Button size="sm" disabled={blocked || !initialized} onClick={() => void runBusy('gossip', onRotateGossip)}>
                        轮换 Gossip
                      </Button>
                    )}
                    {onRevealRootToken && initialized && (
                      <Button size="sm" disabled={blocked} onClick={() => void runBusy('root-token', onRevealRootToken)}>
                        {isVault ? '签发临时 Root Token' : '查看 Root Token'}
                      </Button>
                    )}
                    {isVault && initialized && !onRevealRootToken && (
                      <span className="w-full text-[11px] text-slate-500 dark:text-slate-400">
                        如需签发临时 Root Token，请前往「初始化与密钥托管」页签。
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-col justify-between gap-3 rounded-xl border border-slate-200/80 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-950/40">
                  <div className="flex items-start gap-2.5">
                    <div className="rounded-lg bg-amber-50 p-2 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300 shrink-0">
                      <Wrench className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">异常恢复与维护</h3>
                        {(status?.maintenance_mode ?? cluster.maintenance_mode) && <Badge tone="amber">维护锁开启</Badge>}
                      </div>
                      <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
                        任务中断或状态不一致时，核对远端实际服务并在确认一致后解除维护屏障。
                      </p>
                    </div>
                  </div>
                  <div className="pt-1">
                    <Button size="sm" loading={busyKey === 'reconcile'} disabled={blocked} onClick={() => void runBusy('reconcile', onReconcile)}>
                      核对并解锁
                    </Button>
                  </div>
                </div>

                {onUninstall && (
                  <div className="flex flex-col justify-between gap-3 rounded-xl border border-rose-200/80 bg-rose-50/35 p-4 dark:border-rose-900/50 dark:bg-rose-950/20">
                    <div className="flex items-start gap-2.5">
                      <div className="rounded-lg bg-rose-100/80 p-2 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300 shrink-0">
                        <ShieldAlert className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-rose-800 dark:text-rose-200">危险操作区</h3>
                        <p className="mt-0.5 text-xs leading-5 text-slate-600 dark:text-slate-400">
                          卸载服务并清除此集群全部节点的数据，操作前请先备份快照并二次确认管理员密码。
                        </p>
                      </div>
                    </div>
                    <div className="pt-1">
                      <Button size="sm" variant="danger-outline" loading={busyKey === 'uninstall'} disabled={blocked} onClick={() => void runBusy('uninstall', onUninstall)}>
                        卸载集群
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          )}
        </>
      )}

      <Modal
        open={Boolean(removeTarget)}
        title={`缩容移除节点：${removeTarget?.name || ''}`}
        busy={Boolean(removeTarget && busyKey === `remove:${removeTarget.node_id}`)}
        onClose={() => setRemoveTarget(null)}
      >
        {removeTarget && (
          <div className="space-y-4 text-xs">
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-rose-900 dark:border-rose-900/70 dark:bg-rose-950/60 dark:text-rose-200 space-y-1.5">
              <div className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>确认将节点「{removeTarget.name}」从 {productName} 集群中移出</span>
              </div>
              <p className="leading-5 opacity-90">
                正常缩容会先执行仲裁门禁{!isVault ? '（Client 会先疏散并 Purge）' : ''}、从 Raft 成员移除，再通过 SSH 停服并擦除节点数据。
              </p>
            </div>

            {(removeTarget.service_status === 'unreachable' || removeTarget.reachable === false) && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/50 dark:text-amber-200">
                检测到节点当前处于失联或不可达状态。若虚拟机已删除或无法通过 SSH 连接，请勾选下方「强制移出」。
              </div>
            )}

            <label className="flex items-start gap-2.5 rounded-xl border border-amber-200/90 bg-amber-50/60 p-3 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200 cursor-pointer">
              <input
                type="checkbox"
                checked={forceRemove}
                onChange={(e) => setForceRemove(e.target.checked)}
                className="mt-0.5 shrink-0"
              />
              <span>
                <span className="font-medium">强制移出（跳过失联节点的 SSH 清理）</span>
                <span className="mt-0.5 block text-[11px] leading-4 opacity-85">
                  仅跳过无法连接主机时的 SSH 停服、数据擦除及失联 Client 疏散等待；如集群已初始化，仍会尝试通过存活节点将该成员从 Raft{!isVault ? '、Gossip 及 Client 列表' : ''}中清理（需存活节点仍满足仲裁多数派）。
                </span>
              </span>
            </label>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <Button type="button" disabled={busyKey === `remove:${removeTarget.node_id}`} onClick={() => setRemoveTarget(null)}>
                取消
              </Button>
              <Button
                type="button"
                variant="danger"
                loading={busyKey === `remove:${removeTarget.node_id}`}
                onClick={async () => {
                  const target = removeTarget;
                  const force = forceRemove;
                  setRemoveTarget(null);
                  await runBusy(`remove:${target.node_id}`, () => onRemoveNode(target, force));
                }}
              >
                {forceRemove ? '确认强制移出' : '确认缩容'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
