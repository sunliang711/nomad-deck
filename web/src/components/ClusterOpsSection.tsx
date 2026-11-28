import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, ArrowUpCircle, CheckCircle2, Circle, Copy, Download, KeyRound, Loader2, Server, ShieldAlert, ShieldCheck, SlidersHorizontal, Terminal, Trash2, Wrench } from 'lucide-react';
import { apiGet, fmtTime } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { useI18n } from '../lib/i18n';
import { useOpsDrawer } from '../lib/opsDrawer';
import { isTaskActiveStatus } from '../lib/actionLabels';
import { useConfirm } from './ConfirmDialog';
import { useToast } from './Toast';
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
  proxyEnabled: boolean;
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
  proxyEnabled,
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
  const { locale, tr } = useI18n();
  const askConfirm = useConfirm();
  const toast = useToast();
  const [availableVersions, setAvailableVersions] = useState<string[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [removeTarget, setRemoveTarget] = useState<any | null>(null);
  const [forceRemove, setForceRemove] = useState(false);
  const [showCACert, setShowCACert] = useState(false);
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
      onError(ex?.message || tr('集群操作失败', 'Cluster operation failed'));
    } finally {
      busyRef.current = false;
      setBusyKey('');
    }
  };

  const fetchVersions = async () => {
    setLoadingVersions(true);
    try {
      const res = await apiGet(`/api/v1/releases/${product}`);
      setAvailableVersions((res.versions || []).slice(0, 25));
    } catch (ex: any) {
      onError(ex?.message || tr(`获取 ${product} 版本列表失败`, `Failed to fetch ${product} versions`));
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
          {loadingVersions ? tr('获取中…', 'Fetching...') : tr('获取官方版本列表', 'Fetch Official Versions')}
        </button>
      </div>
      <Input aria-label={label} placeholder={tr('latest 或具体版本号', 'latest or specific version')} value={value} onChange={(e) => onChange(e.target.value)} />
      {availableVersions.length > 0 && (
        <Select
          aria-label={tr('选择官方版本', 'Select official version')}
          value=""
          onChange={(e) => e.target.value && onChange(e.target.value)}
        >
          <option value="">{tr('从官方版本列表选择…', 'Choose from official versions...')}</option>
          <option value="latest">{tr('latest（最新稳定版）', 'latest (Latest Stable)')}</option>
          {availableVersions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Select>
      )}
      <p className="text-xs leading-5 text-slate-500">{tr('填写 latest 自动安装最新稳定版，也可指定具体版本号。', 'Use "latest" for the latest stable release or enter an exact version.')}</p>
    </div>
  );

  const proxyOption = (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
      <span>{tr('下载网络：', 'Download network: ')}{proxyEnabled ? tr('通过系统代理', 'Via System Proxy') : tr('直连', 'Direct')}</span>
      <Link to="/settings?tab=proxy" className="text-indigo-600 dark:text-indigo-400 hover:underline">
        {tr('前往下载代理设置', 'Proxy Settings')}
      </Link>
    </div>
  );

  const headerStatusValue = isNotDeployed
    ? 'uninitialized'
    : isVaultAwaitInit
      ? 'sealed'
      : status?.health_status || cluster.health_status;

  const progressSteps = isVault
    ? [
        { label: tr('配置已创建', 'Config Created'), done: true },
        { label: tr('部署并启动服务', 'Deploy & Start Service'), done: anyInstalled || initialized },
        { label: tr('初始化托管与健康就绪', 'Init Custody & Ready'), done: initialized && healthy },
      ]
    : [
        { label: tr('配置已创建', 'Config Created'), done: true },
        { label: tr('部署与 ACL 初始化', 'Deploy & Init ACL'), done: initialized },
        { label: tr('集群健康就绪', 'Cluster Healthy'), done: initialized && healthy },
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
                  label={isVaultAwaitInit ? tr('已安装 · 待初始化', 'Installed · Pending Init') : undefined}
                />
                {(status?.maintenance_mode ?? cluster.maintenance_mode) && <Badge tone="amber">{tr('维护中', 'Maintenance')}</Badge>}
                <Badge>{clusterVersion === '-' ? tr('尚未安装', 'Not Installed') : `v${clusterVersion}`}</Badge>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {productName} · {isSingleMode ? tr('单机体验', 'Single Node') : tr('高可用集群', 'HA Cluster')} · {status ? tr(`${clusterNodes.length} 台主机`, `${clusterNodes.length} host(s)`) : tr('正在读取主机…', 'Loading hosts...')}
              </p>
            </div>
          </div>
          {initialized && quickActions && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">{quickActions}</div>
          )}
        </div>

        {!(initialized && healthy) && (
          <ol className="mt-5 grid grid-cols-1 gap-2 border-t border-slate-100 pt-4 sm:grid-cols-3 dark:border-slate-800" aria-label={tr('集群搭建进度', 'Cluster setup progress')}>
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
            {tr('集群操作正在后台执行，完成后会自动刷新状态。', 'Cluster operation running in the background; status refreshes automatically upon completion.')}
          </span>
          <Button size="sm" onClick={() => openTask(activeTask.id)}>
            {tr('查看任务进度', 'View Progress')} <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* 阶段 1：尚未部署任何节点 */}
      {isNotDeployed && isAdmin && (
        <Card
          title={tr('下一步：部署集群服务', 'Next: Deploy Cluster Services')}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {onOpenClusterSettings && (
                <Button size="sm" disabled={blocked} onClick={onOpenClusterSettings}>
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  <span>{tr('集群配置', 'Cluster Config')}</span>
                </Button>
              )}
              {onUninstall && (
                <Button size="sm" variant="ghost" disabled={blocked} onClick={() => void runBusy('uninstall', onUninstall)}>
                  <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                  <span className="text-rose-600 dark:text-rose-400">{tr('删除未部署配置', 'Delete Config')}</span>
                </Button>
              )}
            </div>
          }
        >
          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(260px,1fr)]">
            <div className="space-y-3">
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {tr(`主机已就绪，开始部署 ${productName}`, `Hosts Ready — Deploy ${productName}`)}
              </h3>
              <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">
                {isVault
                  ? tr('控制面将通过 SSH 下载官方 Vault 程序包、生成 TLS 证书并启动服务。启动完成后，可直接在当前页面一键初始化并自动解封。', 'The control plane will download Vault over SSH, provision TLS certs, and start the service. Once up, initialize and auto-unseal in one click here.')
                  : tr('控制面将通过 SSH 下载官方 Nomad 程序包、配置 mTLS 加密通信、启动服务并自动完成集群组建与 ACL 初始化。', 'The control plane will download Nomad over SSH, configure mTLS, start the service, form the cluster, and bootstrap ACLs.')}
              </p>
              <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300 space-y-2">
                <div className="font-medium text-slate-800 dark:text-slate-100">{tr('已选目标主机', 'Target Hosts')} ({clusterNodes.length})</div>
                {clusterNodes.map((n: any) => {
                  const cfg = nodeConfigs?.[n.node_id];
                  const hvCount = Array.isArray(cfg?.host_volumes) ? cfg.host_volumes.length : 0;
                  const hnCount = Array.isArray(cfg?.host_networks) ? cfg.host_networks.length : 0;
                  return (
                    <div key={n.node_id} className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5 font-mono">
                        <span className="font-semibold text-slate-800 dark:text-slate-100">{n.name}</span>
                        <span className="text-slate-500">{n.api_addr || n.advertise_addr}</span>
                        {cfg?.cni && <Badge tone="blue">CNI</Badge>}
                        {cfg?.raw_exec && <Badge tone="amber">raw_exec</Badge>}
                        {hvCount > 0 && <Badge tone="green">HostVolume×{hvCount}</Badge>}
                        {hnCount > 0 && <Badge tone="blue">HostNet×{hnCount}</Badge>}
                      </div>
                      {onConfigureNode && (
                        <Button size="sm" disabled={blocked} onClick={() => onConfigureNode(n)}>
                          <SlidersHorizontal className="h-3 w-3" />
                          <span>{tr('插件/配置', 'Plugins & Config')}</span>
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="space-y-3.5">
              {versionPicker(deployVer, setDeployVer, tr('部署版本', 'Deploy Version'))}
              {proxyOption}
              {isVault && setConfirmSwap && (
                <label className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 cursor-pointer">
                  <input
                    className="mt-0.5"
                    type="checkbox"
                    checked={confirmSwap}
                    onChange={(e) => setConfirmSwap(e.target.checked)}
                  />
                  <span>{tr('若目标主机开启未加密 Swap，我已知悉内存密钥可能被换出到磁盘，仍继续部署。', 'I understand unencrypted Swap on target hosts may page in-memory secrets to disk, and wish to proceed.')}</span>
                </label>
              )}
              <Button variant="primary" loading={busyKey === 'deploy'} disabled={blocked} onClick={() => void runBusy('deploy', onDeploy)}>
                {tr('部署集群', 'Deploy Cluster')} <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* 阶段 2（Vault 专属）：二进制已安装运行，引导一键初始化托管 */}
      {isVaultAwaitInit && isAdmin && (
        <Card title={tr('下一步：初始化 Vault 并托管密钥', 'Next: Initialize Vault & Key Custody')}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1.5 max-w-2xl">
              <div className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100">
                <KeyRound className="h-4 w-4 text-indigo-500" />
                <span>{tr(`Vault 服务已安装运行（v${clusterVersion}），等待首次初始化`, `Vault is running (v${clusterVersion}), awaiting initialization`)}</span>
              </div>
              <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">
                {tr(
                  '点击右侧按钮将自动执行 Shamir 密钥分片初始化、加密托管 Unseal Key 并完成自动解封。完成后即可在「Auth / Policy / KV」中管理密钥或对接 Nomad 联动。',
                  'Click the button on the right to perform Shamir initialization, encrypt & store unseal keys, and auto-unseal Vault. Afterward you can manage Auth, Policies, KV, or Nomad integrations.',
                )}
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
                <span>{tr('一键初始化并解封 Vault', 'Initialize & Unseal Vault')}</span>
              </Button>
            )}
          </div>
        </Card>
      )}

      {/* 已部署后才展示连接信息、仲裁健康、节点成员表与运维工具箱 */}
      {!isNotDeployed && (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card title={tr('连接与运行信息', 'Connection & Runtime')}>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-5 gap-y-3 text-sm">
                <dt className="text-slate-500">{tr('初始化状态', 'Init State')}</dt>
                <dd>
                  <StatusBadge value={initState} label={isVaultAwaitInit ? tr('待初始化托管', 'Pending Init') : undefined} />
                </dd>
                <dt className="text-slate-500">{isVault ? tr('Active 主节点', 'Active Node') : tr('Leader 主节点', 'Leader Node')}</dt>
                <dd className="font-mono text-xs break-all">{status?.active_node || status?.leader || (isVaultAwaitInit ? tr('初始化后自动选主', 'Elected after init') : tr('等待集群就绪', 'Waiting for cluster'))}</dd>
                <dt className="text-slate-500">{tr('CA 证书到期', 'CA Expires')}</dt>
                <dd className="text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{fmtTime(cluster.ca_expires_at, locale)}</span>
                    {cluster.tls_enabled && cluster.ca_cert_pem && (
                      <button
                        type="button"
                        onClick={() => setShowCACert(true)}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-indigo-500/50 dark:hover:text-indigo-300"
                      >
                        <ShieldCheck className="h-3 w-3" />
                        <span>{tr('查看 / 下载 CA', 'View / Download CA')}</span>
                      </button>
                    )}
                  </div>
                </dd>
                <dt className="text-slate-500">{tr('统一入口', 'Public Endpoint')}</dt>
                <dd className="min-w-0 break-all">
                  {cluster.public_api_url ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <ExternalUrlLink url={cluster.public_api_url} />
                      {(isVault || !cluster?.settings?.ui?.disabled) && isAdmin && initialized && onOpenWebUI && /^https?:\/\//i.test(cluster.public_api_url) && (
                        <button
                          type="button"
                          onClick={() => onOpenWebUI(cluster.public_api_url, tr('统一入口', 'Public Endpoint'))}
                          title={tr(`验证管理员密码后生成 1 小时有效的 ${productName} 免密登录链接`, `Verify admin password to generate a 1h passwordless ${productName} UI link`)}
                          className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-300 dark:hover:bg-indigo-500/25"
                        >
                          <KeyRound className="h-3 w-3" />
                          <span>{tr('免密进 UI', 'Open UI')}</span>
                        </button>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-slate-500">{tr('未配置，直接使用下方节点地址', 'Not configured; use node addresses below')}</span>
                  )}
                </dd>
                {(status?.maintenance_reason || cluster.maintenance_reason) && (
                  <>
                    <dt className="text-amber-600">{tr('维护原因', 'Maintenance Reason')}</dt>
                    <dd className="break-words text-amber-700 dark:text-amber-300">{status?.maintenance_reason || cluster.maintenance_reason}</dd>
                  </>
                )}
              </dl>
            </Card>

            <Card
              title={
                <TermLabel
                  term={isSingleMode ? tr('单机运行健康', 'Single-Node Health') : tr('Raft 仲裁健康', 'Raft Quorum Health')}
                  tip={
                    isSingleMode
                      ? tr('单机体验模式共 1 个节点，用于学习与功能测试；如需容忍单节点宕机，请使用 3 台及以上主机组建高可用集群。', 'Single-node mode has 1 node for testing. Use 3+ hosts for HA fault tolerance.')
                      : tr('超过半数投票节点在线，集群才能正常选主和写入。3 个投票节点可容忍 1 台故障。', 'A majority of voting peers must be online to elect a leader and commit writes. 3 voters tolerate 1 failure.')
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
                  <div className="mt-2 text-xs text-slate-500">{isSingleMode ? tr('在线节点', 'Online Nodes') : tr('健康投票节点', 'Healthy Voters')}</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {initialized ? (isSingleMode ? tr('0 (单机)', '0 (Single)') : status?.failure_tolerance ?? '—') : '—'}
                  </div>
                  <div className="mt-2 text-xs text-slate-500">{tr('可容忍故障', 'Fault Tolerance')}</div>
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
                  <div className="mt-2 text-xs text-slate-500">{isVault ? tr('已解封节点', 'Unsealed Nodes') : tr('就绪 Client', 'Ready Clients')}</div>
                </div>
              </div>
              {!isVault && status && (
                <p className="mt-4 text-xs text-slate-500">
                  {tr(`节点角色：${serverCount} 个 Server · ${clientCount} 个 Client`, `Roles: ${serverCount} Server(s) · ${clientCount} Client(s)`)}
                </p>
              )}
              {isSingleMode && initialized && healthy && (
                <p className="mt-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                  {tr('单机体验模式运行正常，不支持节点宕机容灾；生产环境建议使用 3 台主机。', 'Single-node mode is healthy (no HA failover). Use 3+ hosts for production.')}
                </p>
              )}
              {status?.raft_error && (
                <p className="mt-4 break-words text-xs text-amber-700 dark:text-amber-300">{tr('仲裁信息暂不可用：', 'Quorum info unavailable: ')}{status.raft_error}</p>
              )}
              {!isSingleMode && initialized && status?.failure_tolerance === 0 && (
                <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                  {tr('当前高可用集群没有故障余量，请先恢复异常节点，再进行重启或缩容。', 'Zero fault tolerance remaining. Recover unhealthy nodes before restarting or removing members.')}
                </p>
              )}
            </Card>
          </div>

          <Card
            title={tr('节点成员状态', 'Cluster Members')}
            actions={
              isAdmin && (
                <Button size="sm" disabled={blocked || !initialized} onClick={onOpenJoin}>
                  {tr('扩容节点', 'Add Node')}
                </Button>
              )
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                    <th className="py-3 pr-4">{tr('节点 / API 地址', 'Node / API Address')}</th>
                    <th className="py-3 pr-4">
                      {isVault ? (
                        <TermLabel
                          term={tr('密封 / 状态', 'Seal / Status')}
                          tip={tr('Sealed 表示 Vault 主密钥未在内存中解封，无法提供服务；Unsealed 表示已解封可正常读写。', 'Sealed means Vault cannot serve requests until unsealed; Unsealed means ready for operations.')}
                        />
                      ) : (
                        tr('角色 / 服务状态', 'Role / Service')
                      )}
                    </th>
                    <th className="py-3 pr-4">
                      <TermLabel term={tr('Raft 角色', 'Raft Role')} tip={tr('节点在 Raft 共识集群中的角色（leader / follower / voter / none）。', 'Role in the Raft consensus group (leader / follower / voter / none).')} />
                    </th>
                    <th className="py-3 pr-4">{tr('版本', 'Version')}</th>
                    <th className="py-3 text-right">{tr('操作', 'Actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {clusterNodes.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-500">
                        {tr('正在读取节点状态…', 'Loading node statuses...')}
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
                                title={tr(`验证管理员密码后生成 1 小时有效的 ${productName} 免密登录链接`, `Verify admin password to generate a 1h passwordless ${productName} UI link`)}
                                className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-300 dark:hover:bg-indigo-500/25"
                              >
                                <KeyRound className="h-3 w-3" />
                                <span>{tr('免密进 UI', 'Open UI')}</span>
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="py-3 pr-4">
                          {isVault ? (
                            <div className="flex flex-wrap items-center gap-1.5">
                              {!nodeInstalled ? (
                                <Badge>{tr('待部署', 'Pending')}</Badge>
                              ) : (
                                <Badge tone={n.sealed == null ? 'neutral' : n.sealed ? 'red' : 'green'}>
                                  {n.sealed == null ? tr('待探测', 'Unknown') : n.sealed ? tr('已密封', 'Sealed') : tr('已解封', 'Unsealed')}
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
                              {Array.isArray(nodeConfigs?.[n.node_id]?.host_networks) && nodeConfigs[n.node_id].host_networks.length > 0 && (
                                <Badge tone="blue">HN×{nodeConfigs[n.node_id].host_networks.length}</Badge>
                              )}
                              {Boolean(nodeConfigs?.[n.node_id]?.custom_hcl) && (
                                <Badge tone="blue">{tr('自定义 HCL', 'Custom HCL')}</Badge>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          {n.raft_role === 'leader' || n.raft_role === 'active'
                            ? tr('主节点', 'Leader')
                            : n.raft_role === 'follower' || n.raft_role === 'standby'
                              ? tr('跟随节点', 'Follower')
                              : !n.raft_role || n.raft_role === 'none'
                                ? isVaultAwaitInit
                                  ? tr('待初始化', 'Pending Init')
                                  : tr('待加入', 'Not Joined')
                                : n.raft_role}
                          {n.is_voter ? tr(' · 投票成员', ' · Voter') : ''}
                        </td>
                        <td className="py-3 pr-4 font-mono text-xs">{n.installed_version || '-'}</td>
                        <td className="py-3 text-right">
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <Button size="sm" onClick={() => onOpenLogs(n)}>
                              <Terminal className="h-3 w-3" /> {tr('日志', 'Logs')}
                            </Button>
                            {onCheckGate && (
                              <Button
                                size="sm"
                                title={tr('检查当前下线或重启该节点是否会导致 Raft 仲裁多数派受损', 'Check if stopping/restarting this node preserves Raft quorum')}
                                loading={busyKey === `gate:${n.node_id}`}
                                disabled={blocked || !initialized}
                                onClick={() => void runBusy(`gate:${n.node_id}`, () => onCheckGate(n))}
                              >
                                {tr('门禁', 'Gate')}
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
                                    <SlidersHorizontal className="h-3 w-3" /> {tr('插件/配置', 'Plugins/Config')}
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  loading={busyKey === `restart:${n.node_id}`}
                                  disabled={blocked || (!initialized && !nodeInstalled)}
                                  onClick={async () => {
                                    if (
                                      !(await askConfirm(tr(`确认重启节点「${n.name}」的 ${product} 服务吗？`, `Restart ${product} service on node "${n.name}"?`), {
                                        title: tr('重启节点服务', 'Restart Node Service'),
                                        confirmText: tr('确认重启', 'Restart'),
                                      }))
                                    ) {
                                      return;
                                    }
                                    await runBusy(`restart:${n.node_id}`, () => onRestartNode(n));
                                  }}
                                >
                                  {tr('重启', 'Restart')}
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
                                            ? tr('这是集群的最后一个节点，点击将卸载并清理整个集群（失联节点可勾选强制卸载）', 'Last node in cluster; clicking will uninstall the entire cluster')
                                            : tr('该节点是集群唯一 Server，点击将卸载并清理整个集群（失联节点可勾选强制卸载）', 'Sole Server in cluster; clicking will uninstall the entire cluster')
                                        }
                                        onClick={() => void runBusy('uninstall', onUninstall)}
                                      >
                                        {tr('卸载清理', 'Uninstall')}
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
                                          ? tr('集群仅剩 1 个节点，如需清理请使用下方卸载集群', 'Only 1 node left; use Uninstall Cluster below')
                                          : isOnlyNomadServer
                                            ? tr('不能移除集群的最后一台 Server', 'Cannot remove the last Server')
                                            : undefined
                                      }
                                      onClick={() => {
                                        setRemoveTarget(n);
                                        setForceRemove(false);
                                      }}
                                    >
                                      {tr('缩容', 'Remove')}
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
              title={tr('集群运维', 'Cluster Operations')}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  {onOpenClusterSettings && (
                    <Button size="sm" disabled={blocked} onClick={onOpenClusterSettings}>
                      <SlidersHorizontal className="h-3.5 w-3.5" />
                      <span>{tr('集群配置', 'Cluster Config')}</span>
                    </Button>
                  )}
                  <Button size="sm" loading={busyKey === 'doctor'} disabled={blocked || !initialized} onClick={() => void runBusy('doctor', onDoctor)}>
                    {tr('集群体检', 'Cluster Doctor')}
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
                            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{tr('版本升级', 'Version Upgrade')}</h3>
                            {clusterVersion !== '-' && <Badge>{tr(`当前 v${clusterVersion}`, `Current v${clusterVersion}`)}</Badge>}
                          </div>
                          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{tr('按节点逐一滚动升级服务，降低业务中断风险。', 'Rolling upgrade one node at a time to minimize service disruption.')}</p>
                        </div>
                      </div>
                      {versionPicker(upVer, setUpVer, tr('目标版本', 'Target Version'))}
                      <div className="space-y-1.5">
                        {proxyOption}
                        {!isVault && setDrainClients && (
                          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                            <input type="checkbox" checked={drainClients} onChange={(e) => setDrainClients(e.target.checked)} />
                            {tr('升级前疏散 Client，将任务迁移到其他节点', 'Drain Clients before upgrade to migrate workloads')}
                          </label>
                        )}
                      </div>
                    </div>
                    <div className="mt-auto border-t border-slate-200/70 pt-3 dark:border-slate-800/80">
                      <Button size="sm" loading={busyKey === 'upgrade'} disabled={blocked} onClick={() => void runBusy('upgrade', onUpgrade)}>
                        {tr('开始滚动升级', 'Start Rolling Upgrade')}
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
                        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{tr('证书与访问凭据', 'Certificates & Credentials')}</h3>
                        <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
                          {isVault
                            ? tr('续期节点 TLS 证书或轮换集群根 CA。请在集群健康时执行，并在后台任务中确认结果。', 'Renew node TLS certs or rotate the cluster root CA while the cluster is healthy.')
                            : tr('续期节点证书、轮换 CA / Gossip 密钥或查看管理员凭据。请在集群健康时执行，并在后台任务中确认结果。', 'Renew node certs, rotate CA / Gossip keys, or reveal admin credentials while healthy.')}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="mt-auto flex flex-wrap gap-2 border-t border-slate-200/70 pt-3 dark:border-slate-800/80">
                    <Button size="sm" loading={busyKey === 'renew'} disabled={blocked || !initialized} onClick={() => void runBusy('renew', onRenewCerts)}>
                      {tr('续期证书', 'Renew Certs')}
                    </Button>
                    <Button size="sm" disabled={blocked || !initialized} onClick={() => void runBusy('ca', onRotateCA)}>
                      {tr('轮换 CA', 'Rotate CA')}
                    </Button>
                    {!isVault && onRotateGossip && (
                      <Button size="sm" disabled={blocked || !initialized} onClick={() => void runBusy('gossip', onRotateGossip)}>
                        {tr('轮换 Gossip', 'Rotate Gossip')}
                      </Button>
                    )}
                    {onRevealRootToken && initialized && (
                      <Button size="sm" disabled={blocked} onClick={() => void runBusy('root-token', onRevealRootToken)}>
                        {isVault ? tr('签发临时 Root Token', 'Issue Temp Root Token') : tr('查看 Root Token', 'Reveal Root Token')}
                      </Button>
                    )}
                    {isVault && initialized && !onRevealRootToken && (
                      <span className="w-full text-[11px] text-slate-500 dark:text-slate-400">
                        {tr('如需签发临时 Root Token，请前往「初始化与密钥托管」页签。', 'Go to the "Init & Key Custody" tab to generate a temporary Root Token.')}
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
                        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{tr('异常恢复与维护', 'Recovery & Maintenance')}</h3>
                        {(status?.maintenance_mode ?? cluster.maintenance_mode) && <Badge tone="amber">{tr('维护锁开启', 'Maintenance Lock')}</Badge>}
                      </div>
                      <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
                        {tr('任务中断或状态不一致时，核对远端实际服务并在确认一致后解除维护屏障。', 'Verify actual remote service state after interrupted tasks and clear the maintenance barrier.')}
                      </p>
                    </div>
                  </div>
                  <div className="mt-auto border-t border-slate-200/70 pt-3 dark:border-slate-800/80">
                    <Button size="sm" loading={busyKey === 'reconcile'} disabled={blocked} onClick={() => void runBusy('reconcile', onReconcile)}>
                      {tr('核对并解锁', 'Reconcile & Unlock')}
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
                        <h3 className="text-sm font-semibold text-rose-800 dark:text-rose-200">{tr('危险操作区', 'Danger Zone')}</h3>
                        <p className="mt-0.5 text-xs leading-5 text-slate-600 dark:text-slate-400">
                          {tr('卸载服务并清除此集群全部节点的数据，操作前请先备份快照并二次确认管理员密码。', 'Uninstall services and wipe data on all cluster nodes. Back up snapshots and confirm your admin password first.')}
                        </p>
                      </div>
                    </div>
                    <div className="mt-auto border-t border-rose-200/70 pt-3 dark:border-rose-900/50">
                      <Button size="sm" variant="danger-outline" loading={busyKey === 'uninstall'} disabled={blocked} onClick={() => void runBusy('uninstall', onUninstall)}>
                        {tr('卸载集群', 'Uninstall Cluster')}
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
        title={tr(`缩容移除节点：${removeTarget?.name || ''}`, `Remove Node: ${removeTarget?.name || ''}`)}
        busy={Boolean(removeTarget && busyKey === `remove:${removeTarget.node_id}`)}
        onClose={() => setRemoveTarget(null)}
      >
        {removeTarget && (
          <div className="space-y-4 text-xs">
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-rose-900 dark:border-rose-900/70 dark:bg-rose-950/60 dark:text-rose-200 space-y-1.5">
              <div className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{tr(`确认将节点「${removeTarget.name}」从 ${productName} 集群中移出`, `Remove node "${removeTarget.name}" from ${productName} cluster?`)}</span>
              </div>
              <p className="leading-5 opacity-90">
                {tr(
                  `正常缩容会先执行仲裁门禁${!isVault ? '（Client 会先疏散并 Purge）' : ''}、从 Raft 成员移除，再通过 SSH 停服并擦除节点数据。`,
                  `Normal removal checks quorum safety${!isVault ? ' (draining & purging Client allocations first)' : ''}, leaves Raft, and wipes node data over SSH.`,
                )}
              </p>
            </div>

            {(removeTarget.service_status === 'unreachable' || removeTarget.reachable === false) && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/50 dark:text-amber-200">
                {tr('检测到节点当前处于失联或不可达状态。若虚拟机已删除或无法通过 SSH 连接，请勾选下方「强制移出」。', 'Node is currently unreachable. Enable "Force Remove" below if the VM is gone or SSH is unavailable.')}
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
                <span className="font-medium">{tr('强制移出（跳过失联节点的 SSH 清理）', 'Force Remove (skip SSH cleanup on unreachable node)')}</span>
                <span className="mt-0.5 block text-[11px] leading-4 opacity-85">
                  {tr(
                    `仅跳过无法连接主机时的 SSH 停服、数据擦除及失联 Client 疏散等待；如集群已初始化，仍会尝试通过存活节点将该成员从 Raft${!isVault ? '、Gossip 及 Client 列表' : ''}中清理（需存活节点仍满足仲裁多数派）。`,
                    `Skips SSH stop/wipe and drain wait on the unreachable host while still removing the peer from Raft${!isVault ? ', Gossip, and Client lists' : ''} via surviving nodes (requires quorum).`,
                  )}
                </span>
              </span>
            </label>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <Button type="button" disabled={busyKey === `remove:${removeTarget.node_id}`} onClick={() => setRemoveTarget(null)}>
                {tr('取消', 'Cancel')}
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
                {forceRemove ? tr('确认强制移出', 'Confirm Force Remove') : tr('确认缩容', 'Confirm Remove')}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={showCACert}
        title={tr(`集群根 CA 证书：${cluster?.name || ''}`, `Cluster Root CA Certificate: ${cluster?.name || ''}`)}
        size="lg"
        onClose={() => setShowCACert(false)}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  if (!cluster?.ca_cert_pem) return;
                  void copyText(cluster.ca_cert_pem)
                    .then(() => toast.success(tr('CA 证书已复制到剪贴板', 'CA certificate copied')))
                    .catch(() => onError(tr('复制失败，请手动全选复制', 'Failed to copy CA certificate')));
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                <span>{tr('复制 PEM', 'Copy PEM')}</span>
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  if (!cluster?.ca_cert_pem) return;
                  const blob = new Blob([cluster.ca_cert_pem], { type: 'application/x-pem-file' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${cluster.name || product}-ca.crt`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                <Download className="h-3.5 w-3.5" />
                <span>{tr('下载 .crt', 'Download .crt')}</span>
              </Button>
            </div>
            <Button type="button" variant="primary" onClick={() => setShowCACert(false)}>
              {tr('关闭', 'Close')}
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-xs">
          <p className="text-slate-600 dark:text-slate-300">
            {tr(
              '这是公开的集群根 CA 证书链（不含私钥），可用于客户端、脚本或容器校验集群的 HTTPS / TLS 服务身份。',
              'Public cluster root CA bundle (no private keys), used by clients, scripts, or containers to verify cluster HTTPS/TLS endpoints.',
            )}
          </p>
          <pre className="max-h-80 overflow-auto rounded-xl border border-slate-200 bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100 select-all dark:border-slate-800">
            {cluster?.ca_cert_pem || ''}
          </pre>
        </div>
      </Modal>
    </div>
  );
}
