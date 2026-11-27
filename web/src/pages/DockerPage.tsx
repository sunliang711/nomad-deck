import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Container,
  HardDrive,
  Layers,
  RefreshCw,
  Search,
  Server as ServerIcon,
  ShieldAlert,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { buildTabSearchParams, resolveTabParam } from '../lib/selectionMemory';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useOpsDrawer } from '../lib/opsDrawer';
import { useConfirm } from '../components/ConfirmDialog';
import {
  DockerDaemonConfigFields,
  DockerManageModal,
  buildDockerConfigPayload,
  dockerConfigDraftFrom,
  dockerModeLabelOf,
  dockerStatusLabelOf,
  emptyDockerConfigDraft,
  type DockerConfigDraft,
  type DockerManageTarget,
} from '../components/DockerManageModal';
import { useToast } from '../components/Toast';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  InfoTip,
  Input,
  LoadingState,
  PageHeader,
  SectionTabs,
  Select,
  StatusBadge,
  Switch,
} from '../components/UI';

type DockerTab = 'hosts' | 'inspect' | 'clusters';

interface InspectDFRow {
  type: string;
  total_count: string;
  active: string;
  size: string;
  reclaimable: string;
}

interface InspectImage {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created: string;
}

interface InspectContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  nomad_alloc_id?: string;
  nomad_job_id?: string;
  is_nomad_managed: boolean;
}

interface InspectResult {
  node_id: string;
  mode: string;
  status: string;
  version: string;
  disk_usage: InspectDFRow[];
  images: InspectImage[];
  containers: InspectContainer[];
  actual_config: string;
  expected_config: string;
  config_path: string;
  inspect_error?: string;
}

interface UpgradePlanItem {
  node_id: string;
  node: string;
  mode: string;
  current_version: string;
  action: 'upgrade' | 'skip';
  kind?: 'in_place' | 'drain';
  reason: string;
}

interface UpgradePlan {
  target_version: string;
  items: UpgradePlanItem[];
}

export function DockerPage() {
  const { isAdmin } = useAuth();
  const { locale, tr } = useI18n();
  const { openTask } = useOpsDrawer();
  const askConfirm = useConfirm();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const tab = resolveTabParam(searchParams, ['hosts', 'inspect', 'clusters'] as const, 'hosts');
  const [nodes, setNodes] = useState<any[]>([]);
  const [clusters, setClusters] = useState<any[]>([]);
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  // Host matrix filters & modal
  const [hostQuery, setHostQuery] = useState('');
  const [modeFilter, setModeFilter] = useState<'all' | 'managed' | 'external' | 'absent'>('all');
  const [dockerNode, setDockerNode] = useState<DockerManageTarget | null>(null);
  const [syncProxyBusy, setSyncProxyBusy] = useState(false);

  // Runtime inspector & prune
  const [inspectNodeId, setInspectNodeId] = useState<string>(() => searchParams.get('node') || '');
  const [inspectData, setInspectData] = useState<InspectResult | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectErr, setInspectErr] = useState('');
  const [pruneOpts, setPruneOpts] = useState({
    dangling_images: true,
    unused_images: false,
    build_cache: true,
    stopped_containers: false,
  });
  const [pruneBusy, setPruneBusy] = useState(false);

  // Cluster policy & rolling upgrade
  const [selectedClusterId, setSelectedClusterId] = useState<string>(() => searchParams.get('cluster') || '');
  const [upgradeTargetVer, setUpgradeTargetVer] = useState('');
  const [upgradePlan, setUpgradePlan] = useState<UpgradePlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [upgradeDrain, setUpgradeDrain] = useState(true);
  const [upgradeConfirm, setUpgradeConfirm] = useState(false);
  const [upgradeAllowInt, setUpgradeAllowInt] = useState(false);

  const [clusterDefaultVer, setClusterDefaultVer] = useState('');
  const [clusterAutoInstall, setClusterAutoInstall] = useState(false);
  const [clusterCfg, setClusterCfg] = useState<DockerConfigDraft>(emptyDockerConfigDraft);
  const [defaultsBusy, setDefaultsBusy] = useState(false);

  const nomadClusters = useMemo(() => clusters.filter((c) => c.type === 'nomad'), [clusters]);
  const selectedCluster = useMemo(
    () => nomadClusters.find((c) => c.id === selectedClusterId) || nomadClusters[0] || null,
    [nomadClusters, selectedClusterId],
  );
  const selectedInspectNode = useMemo(
    () => nodes.find((n) => n.id === inspectNodeId) || null,
    [nodes, inspectNodeId],
  );

  const switchTab = (next: DockerTab, extra?: Record<string, string>) => {
    const params = buildTabSearchParams(searchParams, next, 'hosts', { extra });
    if (params.toString() !== searchParams.toString()) {
      setSearchParams(params);
    }
  };

  const load = useCallback(async () => {
    setErr('');
    try {
      const [nRes, cRes, sRes] = await Promise.all([
        apiGet('/api/v1/nodes'),
        apiGet('/api/v1/clusters'),
        apiGet('/api/v1/settings'),
      ]);
      const nextNodes = nRes.nodes || [];
      const nextClusters = (cRes.clusters || []).filter((c: any) => c.type === 'nomad');
      const nextSettings = sRes.settings || {};
      setNodes(nextNodes);
      setClusters(cRes.clusters || []);
      setSettings(nextSettings);

      setInspectNodeId((cur) => {
        if (cur && nextNodes.some((n: any) => n.id === cur)) return cur;
        const preferred = nextNodes.find((n: any) => n.docker_mode && n.docker_mode !== 'absent');
        return preferred?.id || nextNodes[0]?.id || '';
      });

      setSelectedClusterId((cur) => {
        if (cur && nextClusters.some((c: any) => c.id === cur)) return cur;
        return nextClusters[0]?.id || '';
      });

      setUpgradeTargetVer((cur) => cur || nextSettings['defaults.docker_version'] || '');
    } catch (ex: any) {
      setErr(ex?.message || tr('加载容器运行时状态失败', 'Failed to load container runtime state'));
    } finally {
      setLoading(false);
    }
  }, [tr]);

  useEffect(() => {
    void load();
  }, [load]);

  // Sync cluster defaults form when selected cluster changes
  useEffect(() => {
    if (!selectedCluster) return;
    const dd = selectedCluster.settings?.docker_defaults || {};
    setClusterDefaultVer(dd.version || '');
    setClusterAutoInstall(Boolean(dd.auto_install));
    setClusterCfg(dockerConfigDraftFrom(dd, Boolean(dd.pull_proxy?.password_set)));
    setUpgradePlan(null);
    if (!upgradeTargetVer) {
      setUpgradeTargetVer(dd.version || settings['defaults.docker_version'] || '');
    }
  }, [selectedCluster?.id, selectedCluster?.settings]);

  const runInspect = useCallback(
    async (targetNodeId: string) => {
      if (!targetNodeId) return;
      setInspectErr('');
      setInspectLoading(true);
      try {
        const res = await apiGet(`/api/v1/nodes/${targetNodeId}/docker/inspect`);
        setInspectData(res.inspect || null);
      } catch (ex: any) {
        setInspectErr(ex?.message || tr('采集宿主机 Docker 运行时状态失败', 'Failed to inspect host Docker runtime'));
        setInspectData(null);
      } finally {
        setInspectLoading(false);
      }
    },
    [tr],
  );

  // Auto-inspect when switching into inspect tab for an installed node
  useEffect(() => {
    if (tab !== 'inspect' || !inspectNodeId) return;
    if (inspectData?.node_id === inspectNodeId) return;
    void runInspect(inspectNodeId);
  }, [tab, inspectNodeId, inspectData?.node_id, runInspect]);

  const stats = useMemo(() => {
    const total = nodes.length;
    const online = nodes.filter((n) => n.status === 'online').length;
    const managed = nodes.filter((n) => n.docker_mode === 'managed').length;
    const external = nodes.filter((n) => n.docker_mode === 'external').length;
    const absent = nodes.filter((n) => !n.docker_mode || n.docker_mode === 'absent').length;
    const running = nodes.filter((n) => n.docker_status === 'running' || n.docker_status === 'active').length;
    const verCounts = new Map<string, number>();
    for (const n of nodes) {
      if (n.docker_version) {
        verCounts.set(n.docker_version, (verCounts.get(n.docker_version) || 0) + 1);
      }
    }
    const topVersions = Array.from(verCounts.entries()).sort((a, b) => b[1] - a[1]);
    return { total, online, managed, external, absent, running, verCount: verCounts.size, topVersion: topVersions[0]?.[0] || '-' };
  }, [nodes]);

  const filteredNodes = useMemo(() => {
    const q = hostQuery.trim().toLowerCase();
    return nodes.filter((n) => {
      const mode = n.docker_mode || 'absent';
      if (modeFilter !== 'all' && mode !== modeFilter) return false;
      if (!q) return true;
      return (
        String(n.name || '').toLowerCase().includes(q) ||
        String(n.host || '').toLowerCase().includes(q) ||
        String(n.docker_version || '').toLowerCase().includes(q)
      );
    });
  }, [nodes, hostQuery, modeFilter]);

  const handleSyncPullProxy = async () => {
    if (syncProxyBusy) return;
    const confirmed = await askConfirm(
      tr(
        '将向所有沿用系统代理的 Docker 宿主机重新下发拉取代理配置并重启 Docker 守护进程（托管容器保持 live-restore）。确认继续？',
        'Reapply the system pull proxy configuration to all Docker hosts inheriting system proxy and restart Docker daemons (live-restore keeps managed containers running). Continue?',
      ),
      {
        title: tr('同步全局拉取代理', 'Sync Global Pull Proxy'),
        confirmText: tr('立即同步', 'Sync Now'),
      },
    );
    if (!confirmed) return;
    setSyncProxyBusy(true);
    try {
      const res = await apiPost('/api/v1/settings/proxy/sync-docker', {});
      const count = Number(res?.count || 0);
      if (count > 0) {
        toast.success(tr(`已向 ${count} 台 Docker 主机下发代理同步任务`, `Submitted proxy sync tasks to ${count} Docker host(s)`));
        if (Array.isArray(res?.task_ids) && res.task_ids[0]) {
          openTask(res.task_ids[0], tr('同步 Docker 全局拉取代理', 'Sync Docker Pull Proxy'));
        }
      } else {
        toast.info(tr('没有需要同步的主机（所有主机已处于最新配置或使用自定义/直连策略）', 'No hosts needed proxy sync'));
      }
    } catch (ex: any) {
      toast.error(ex?.message || tr('同步拉取代理失败', 'Failed to sync pull proxy'));
    } finally {
      setSyncProxyBusy(false);
    }
  };

  const handlePrune = async () => {
    if (!inspectNodeId || pruneBusy) return;
    if (!pruneOpts.dangling_images && !pruneOpts.unused_images && !pruneOpts.build_cache && !pruneOpts.stopped_containers) {
      toast.error(tr('请至少勾选一项清理范围', 'Select at least one cleanup scope'));
      return;
    }
    const nodeName = selectedInspectNode?.name || inspectNodeId;
    const confirmed = await askConfirm(
      tr(
        `即将在主机「${nodeName}」上执行 Docker 资源清理（绝不触碰持久化 Volume）。${pruneOpts.unused_images ? '注意：已勾选清理所有未被运行容器引用的镜像（-a），后续部署可能需要重新拉取镜像。' : ''}确认继续？`,
        `Run Docker resource prune on "${nodeName}" (volumes are never touched). ${pruneOpts.unused_images ? 'Note: all unused images (-a) will be removed and may need re-pulling later. ' : ''}Continue?`,
      ),
      {
        title: tr('确认清理 Docker 冗余资源', 'Confirm Docker Prune'),
        confirmText: tr('开始清理', 'Start Prune'),
        danger: pruneOpts.unused_images || pruneOpts.stopped_containers,
      },
    );
    if (!confirmed) return;
    setPruneBusy(true);
    try {
      const res = await apiPost(`/api/v1/nodes/${inspectNodeId}/docker/prune`, pruneOpts);
      if (res?.task?.id) {
        openTask(res.task.id, tr(`清理 Docker 资源：${nodeName}`, `Prune Docker: ${nodeName}`));
        toast.info(tr('已发起后台清理任务，完成后可点击「重新巡检」查看释放结果', 'Prune task started; click Re-inspect after completion to see freed space'));
      }
    } catch (ex: any) {
      toast.error(ex?.message || tr('发起 Docker 清理失败', 'Failed to start Docker prune'));
    } finally {
      setPruneBusy(false);
    }
  };

  const handlePlanClusterUpgrade = async () => {
    if (!selectedCluster || !upgradeTargetVer.trim() || planBusy) return;
    setPlanBusy(true);
    setErr('');
    try {
      const res = await apiPost(`/api/v1/clusters/${selectedCluster.id}/docker/upgrade/plan`, {
        version: upgradeTargetVer.trim(),
      });
      setUpgradePlan(res.plan || null);
    } catch (ex: any) {
      setErr(ex?.message || tr('生成升级预演失败', 'Failed to generate upgrade plan'));
    } finally {
      setPlanBusy(false);
    }
  };

  const handleStartClusterUpgrade = async () => {
    if (!selectedCluster || !upgradeTargetVer.trim() || upgradeBusy) return;
    const upgradeTargets = upgradePlan?.items?.filter((i) => i.action === 'upgrade').length;
    const confirmed = await askConfirm(
      tr(
        `将对集群「${selectedCluster.name}」内符合条件的托管 Docker Client 逐台滚动升级到 ${upgradeTargetVer.trim()}${upgradeTargets !== undefined ? `（预计 ${upgradeTargets} 台主机）` : ''}，任一节点失败将自动熔断。确认继续？`,
        `Roll out Docker ${upgradeTargetVer.trim()} across managed Client nodes in cluster "${selectedCluster.name}"${upgradeTargets !== undefined ? ` (${upgradeTargets} host(s))` : ''}, aborting on first failure. Continue?`,
      ),
      {
        title: tr('确认集群 Docker 滚动升级', 'Confirm Cluster Docker Rolling Upgrade'),
        confirmText: tr('开始滚动升级', 'Start Rolling Upgrade'),
      },
    );
    if (!confirmed) return;
    setUpgradeBusy(true);
    setErr('');
    try {
      const res = await apiPost(`/api/v1/clusters/${selectedCluster.id}/docker/upgrade`, {
        version: upgradeTargetVer.trim(),
        drain: upgradeDrain,
        confirm: upgradeConfirm,
        allow_interruption: upgradeAllowInt,
      });
      if (res?.task?.id) {
        openTask(res.task.id, tr(`集群滚动升级 Docker：${selectedCluster.name}`, `Cluster Docker Upgrade: ${selectedCluster.name}`));
        void load();
      }
    } catch (ex: any) {
      setErr(ex?.message || tr('发起集群 Docker 滚动升级失败', 'Failed to start cluster Docker upgrade'));
    } finally {
      setUpgradeBusy(false);
    }
  };

  const handleSaveClusterDefaults = async () => {
    if (!selectedCluster || defaultsBusy) return;
    setDefaultsBusy(true);
    setErr('');
    try {
      const cfgPayload = buildDockerConfigPayload(clusterCfg, { includeDataRoot: true });
      await apiPut(`/api/v1/clusters/${selectedCluster.id}/docker/defaults`, {
        version: clusterDefaultVer.trim(),
        auto_install: clusterAutoInstall,
        ...cfgPayload,
      });
      toast.success(tr(`已保存集群「${selectedCluster.name}」的 Docker 默认模板`, `Saved Docker defaults for "${selectedCluster.name}"`));
      await load();
    } catch (ex: any) {
      setErr(ex?.message || tr('保存集群 Docker 默认配置失败', 'Failed to save cluster Docker defaults'));
    } finally {
      setDefaultsBusy(false);
    }
  };

  const normalizeText = (s?: string) => (s || '').trim();
  const configInSync =
    inspectData &&
    inspectData.mode !== 'absent' &&
    normalizeText(inspectData.actual_config) !== '' &&
    normalizeText(inspectData.actual_config) === normalizeText(inspectData.expected_config);

  const orphanContainers = useMemo(
    () => (inspectData?.containers || []).filter((c) => !c.is_nomad_managed),
    [inspectData?.containers],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={tr('容器运行时 (Docker)', 'Container Runtime (Docker)')}
        subtitle={tr(
          '管理宿主机 Docker Engine、集群默认模板、滚动升级、磁盘空间与镜像缓存；容器工作负载编排与运行态请前往 Nomad Job 中心。',
          'Manage host Docker Engines, cluster default templates, rolling upgrades, disk usage, and image cache; manage container workloads in Nomad Job Center.',
        )}
        actions={
          <>
            <Link
              to="/jobs"
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700/90 dark:bg-slate-800/90 dark:text-slate-200 dark:hover:bg-slate-700/90 transition"
            >
              <span>{tr('Nomad Job 中心', 'Nomad Job Center')}</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
            {isAdmin && (
              <Button loading={syncProxyBusy} disabled={nodes.length === 0} onClick={() => void handleSyncPullProxy()}>
                <RefreshCw className="h-4 w-4" />
                <span>{tr('同步全局拉取代理', 'Sync Pull Proxy')}</span>
              </Button>
            )}
            <Button onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" />
              <span>{tr('刷新', 'Refresh')}</span>
            </Button>
          </>
        }
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {loading ? (
        <LoadingState label={tr('正在加载容器运行时数据...', 'Loading container runtime data...')} />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl border border-[#e3e8f1] bg-white px-4 py-3 dark:border-slate-800/90 dark:bg-[#0f172a]/95">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">{tr('Docker 就绪节点', 'Docker Ready Hosts')}</div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{stats.running}</span>
                <span className="text-xs text-slate-400">{tr(`/ ${stats.total} 台主机`, `/ ${stats.total} hosts`)}</span>
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                {tr(`在线主机 ${stats.online} 台`, `${stats.online} hosts online`)}
              </div>
            </div>
            <div className="rounded-xl border border-[#e3e8f1] bg-white px-4 py-3 dark:border-slate-800/90 dark:bg-[#0f172a]/95">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">{tr('托管分布', 'Management Mode')}</div>
              <div className="mt-1 flex flex-wrap items-baseline gap-2 text-xs">
                <span className="text-lg font-semibold tabular-nums text-indigo-600 dark:text-indigo-400">{stats.managed}</span>
                <span className="text-slate-500">{tr('托管', 'Managed')}</span>
                <span className="text-slate-300 dark:text-slate-700">·</span>
                <span className="font-medium tabular-nums text-slate-700 dark:text-slate-300">{stats.external}</span>
                <span className="text-slate-500">{tr('外部', 'External')}</span>
                <span className="text-slate-300 dark:text-slate-700">·</span>
                <span className="font-medium tabular-nums text-slate-700 dark:text-slate-300">{stats.absent}</span>
                <span className="text-slate-500">{tr('未装', 'Absent')}</span>
              </div>
            </div>
            <div className="rounded-xl border border-[#e3e8f1] bg-white px-4 py-3 dark:border-slate-800/90 dark:bg-[#0f172a]/95">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">{tr('版本一致性', 'Version Spread')}</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{stats.verCount}</span>
                <span className="text-xs text-slate-400">{tr('个版本', 'version(s)')}</span>
              </div>
              <div className="mt-1 truncate font-mono text-[11px] text-slate-500">
                {tr('主版本：', 'Primary: ')}{stats.topVersion}
              </div>
            </div>
            <div className="rounded-xl border border-[#e3e8f1] bg-white px-4 py-3 dark:border-slate-800/90 dark:bg-[#0f172a]/95">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">{tr('Nomad 集群策略', 'Nomad Clusters')}</div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{nomadClusters.length}</span>
                <span className="text-xs text-slate-400">{tr('个集群', 'cluster(s)')}</span>
              </div>
              <div className="mt-1 truncate font-mono text-[11px] text-slate-500">
                {tr('默认版本：', 'Default: ')}{settings['defaults.docker_version'] || tr('仓库最新版', 'Latest')}
              </div>
            </div>
          </div>

          <SectionTabs
            tabs={[
              { id: 'hosts', label: tr('宿主机矩阵', 'Host Engines'), badge: nodes.length },
              {
                id: 'inspect',
                label: tr('巡检与清理', 'Inspect & Prune'),
                tip: tr('实时采集宿主机 Docker 磁盘占用、镜像、容器归属（识别非 Nomad 孤儿容器）与 daemon.json 配置对比。', 'Collect live disk usage, images, container ownership (detect non-Nomad containers), and daemon.json drift.'),
              },
              {
                id: 'clusters',
                label: tr('集群策略与滚动升级', 'Cluster Policy & Upgrade'),
                badge: nomadClusters.length,
                tip: tr('配置 Nomad 集群级 Docker 默认模板，以及按序疏散升级集群内托管节点。', 'Configure Nomad cluster Docker default templates and run rolling upgrades across managed Clients.'),
              },
            ]}
            active={tab}
            onChange={(id) => switchTab(id as DockerTab)}
          />

          {tab === 'hosts' && (
            <Card
              title={tr('宿主机 Docker Engine 状态矩阵', 'Host Docker Engine Matrix')}
              description={tr('查看并管理所有纳管 Linux 主机上的容器引擎；业务容器请前往 Nomad Job 中心部署和观测。', 'View and manage Docker Engines across all managed Linux hosts; manage business containers in Nomad Job Center.')}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
                    <input
                      type="search"
                      value={hostQuery}
                      onChange={(e) => setHostQuery(e.target.value)}
                      placeholder={tr('搜索主机 / IP / 版本...', 'Filter host / IP / version...')}
                      className="h-8 w-48 rounded-lg border border-slate-200 bg-white pl-8 pr-2.5 text-xs text-slate-800 outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div className="w-36">
                    <Select
                      size="sm"
                      aria-label={tr('筛选 Docker 模式', 'Filter Docker Mode')}
                      value={modeFilter}
                      onChange={(e) => setModeFilter(e.target.value as any)}
                    >
                      <option value="all">{tr('全部模式', 'All Modes')}</option>
                      <option value="managed">{tr('平台托管', 'Managed')}</option>
                      <option value="external">{tr('外部安装', 'External')}</option>
                      <option value="absent">{tr('未安装', 'Not Installed')}</option>
                    </Select>
                  </div>
                </div>
              }
            >
              {nodes.length === 0 ? (
                <EmptyState
                  title={tr('尚未纳管 Linux 主机', 'No Linux Hosts Registered')}
                  description={tr('请先在「基础设施」中添加并探测 Linux 主机，再回到此页面安装与治理 Docker。', 'Add and probe Linux hosts in Infrastructure first, then manage Docker here.')}
                  action={
                    <Link
                      to="/infra"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                    >
                      <span>{tr('前往基础设施', 'Go to Infrastructure')}</span>
                    </Link>
                  }
                />
              ) : filteredNodes.length === 0 ? (
                <EmptyState
                  title={tr('没有匹配的主机', 'No Matching Hosts')}
                  description={tr('尝试清空搜索关键字或切换 Docker 模式筛选条件。', 'Try clearing the search query or switching the Docker mode filter.')}
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[780px] text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                        <th className="py-2.5 pr-4">{tr('主机 / 地址', 'Host / Address')}</th>
                        <th className="py-2.5 pr-4">{tr('主机连通性', 'Host Status')}</th>
                        <th className="py-2.5 pr-4">{tr('Docker 模式', 'Docker Mode')}</th>
                        <th className="py-2.5 pr-4">{tr('引擎版本与状态', 'Version & Status')}</th>
                        <th className="py-2.5 pr-4">{tr('系统环境', 'OS / Arch')}</th>
                        <th className="py-2.5 text-right">{tr('操作', 'Actions')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                      {filteredNodes.map((n) => (
                        <tr key={n.id}>
                          <td className="py-3 pr-4">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <ServerIcon className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                              <span className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">{n.name}</span>
                              {n.is_control_plane_host && (
                                <span className="inline-flex items-center gap-0.5">
                                  <Badge tone="amber">{tr('控制面同机', 'Control Plane Host')}</Badge>
                                  <InfoTip
                                    text={tr(
                                      '该主机与 NomadDeck 控制面同机：若控制面运行在 Docker 容器中，请勿在此重装或重启 Docker。',
                                      'Co-located with NomadDeck control plane: do not reinstall or restart Docker if NomadDeck runs inside Docker.',
                                    )}
                                  />
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                              {n.ssh_user}@{n.host}:{n.ssh_port}
                            </div>
                          </td>
                          <td className="py-3 pr-4 whitespace-nowrap">
                            <StatusBadge value={n.status || 'unknown'} />
                          </td>
                          <td className="py-3 pr-4 whitespace-nowrap">
                            <Badge tone={!n.docker_mode || n.docker_mode === 'absent' ? 'neutral' : n.docker_mode === 'managed' ? 'blue' : 'amber'}>
                              {dockerModeLabelOf(n.docker_mode, locale)}
                            </Badge>
                          </td>
                          <td className="py-3 pr-4 whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-slate-800 dark:text-slate-200">{n.docker_version || '-'}</span>
                              {n.docker_mode && n.docker_mode !== 'absent' && <StatusBadge value={n.docker_status || 'unknown'} />}
                            </div>
                            {dockerStatusLabelOf(n.docker_status, locale) && (
                              <div className="mt-0.5 text-[11px] text-slate-500">{dockerStatusLabelOf(n.docker_status, locale)}</div>
                            )}
                          </td>
                          <td className="py-3 pr-4">
                            <div className="truncate max-w-[200px] text-slate-700 dark:text-slate-300" title={n.os_info || ''}>
                              {n.os_info || '-'}
                            </div>
                            <div className="font-mono text-[11px] text-slate-500">
                              {[n.arch, n.package_manager].filter(Boolean).join(' · ') || '-'}
                            </div>
                          </td>
                          <td className="py-3 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              {n.docker_mode && n.docker_mode !== 'absent' && (
                                <Button
                                  size="sm"
                                  onClick={() => {
                                    setInspectNodeId(n.id);
                                    setInspectData(null);
                                    switchTab('inspect', { node: n.id });
                                  }}
                                >
                                  <HardDrive className="h-3.5 w-3.5" />
                                  <span>{tr('巡检与清理', 'Inspect & Prune')}</span>
                                </Button>
                              )}
                              {isAdmin && (
                                <Button
                                  size="sm"
                                  variant={!n.docker_mode || n.docker_mode === 'absent' ? 'primary' : 'secondary'}
                                  onClick={() => setDockerNode({ id: n.id, name: n.name })}
                                >
                                  <Container className="h-3.5 w-3.5" />
                                  <span>
                                    {!n.docker_mode || n.docker_mode === 'absent'
                                      ? tr('安装 Docker', 'Install Docker')
                                      : tr('配置与升级', 'Config & Upgrade')}
                                  </span>
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          {tab === 'inspect' && (
            <div className="space-y-4">
              <Card
                title={tr('宿主机运行时实时巡检', 'Live Host Runtime Inspector')}
                description={tr('只读探测单台主机的磁盘占用、本地镜像、容器归属（识别非 Nomad 孤儿容器）与配置文件差异。', 'Read-only probe for host disk usage, local images, container ownership (detect non-Nomad containers), and config drift.')}
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="w-56">
                      <Select
                        size="sm"
                        aria-label={tr('选择巡检主机', 'Select Host to Inspect')}
                        value={inspectNodeId}
                        onChange={(e) => {
                          const nextId = e.target.value;
                          setInspectNodeId(nextId);
                          setInspectData(null);
                          switchTab('inspect', { node: nextId });
                        }}
                      >
                        {nodes.map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.name} ({dockerModeLabelOf(n.docker_mode, locale)})
                          </option>
                        ))}
                      </Select>
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={inspectLoading}
                      disabled={!inspectNodeId}
                      onClick={() => void runInspect(inspectNodeId)}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      <span>{tr('重新巡检', 'Re-inspect')}</span>
                    </Button>
                  </div>
                }
              >
                <ErrorAlert message={inspectErr} onClose={() => setInspectErr('')} />
                {nodes.length === 0 ? (
                  <EmptyState title={tr('暂无可用主机', 'No Hosts Available')} />
                ) : inspectLoading && !inspectData ? (
                  <LoadingState label={tr('正在通过 SSH 采集节点 Docker 运行时状态...', 'Collecting host Docker runtime state over SSH...')} />
                ) : !inspectData ? (
                  <EmptyState
                    title={tr('尚未采集节点信息', 'Not Inspected Yet')}
                    action={
                      <Button variant="primary" onClick={() => void runInspect(inspectNodeId)}>
                        {tr('开始巡检', 'Inspect Now')}
                      </Button>
                    }
                  />
                ) : inspectData.mode === 'absent' ? (
                  <EmptyState
                    title={tr('该主机尚未安装 Docker Engine', 'Docker Engine Not Installed on This Host')}
                    description={tr('安装 Docker Engine 后即可查看空间占用、镜像列表并执行安全清理。', 'Install Docker Engine to inspect disk usage, images, and run safe pruning.')}
                    action={
                      isAdmin && selectedInspectNode ? (
                        <Button variant="primary" onClick={() => setDockerNode({ id: selectedInspectNode.id, name: selectedInspectNode.name })}>
                          {tr('安装 Docker', 'Install Docker')}
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  <div className="space-y-5">
                    {inspectData.inspect_error && (
                      <ErrorAlert
                        message={tr(`部分巡检命令返回异常：${inspectData.inspect_error}`, `Runtime probe reported an error: ${inspectData.inspect_error}`)}
                      />
                    )}

                    {/* Disk Usage Cards */}
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                          <HardDrive className="h-3.5 w-3.5 text-indigo-500" />
                          <span>{tr('磁盘空间占用 (docker system df)', 'Disk Usage (docker system df)')}</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <Badge tone="blue">{dockerModeLabelOf(inspectData.mode, locale)}</Badge>
                          <span className="font-mono text-slate-600 dark:text-slate-300">{inspectData.version || '-'}</span>
                        </div>
                      </div>
                      {inspectData.disk_usage.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-slate-200 p-4 text-xs text-slate-500 dark:border-slate-700">
                          {tr('暂未采集到空间统计数据。', 'No disk usage data returned.')}
                        </div>
                      ) : (
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          {inspectData.disk_usage.map((row) => (
                            <div
                              key={row.type}
                              className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950/50"
                            >
                              <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{row.type}</div>
                              <div className="mt-1 text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">{row.size || '0B'}</div>
                              <div className="mt-1 flex flex-wrap items-center justify-between gap-1 text-[11px] text-slate-500">
                                <span>
                                  {tr(`总数 ${row.total_count} · 活跃 ${row.active}`, `Total ${row.total_count} · Active ${row.active}`)}
                                </span>
                                <span className="font-medium text-emerald-700 dark:text-emerald-300">
                                  {tr('可回收：', 'Reclaimable: ')}{row.reclaimable || '0B'}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Safe Prune Panel */}
                    {isAdmin && (
                      <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                            <Trash2 className="h-4 w-4 text-rose-500" />
                            <span>{tr('安全清理冗余缓存', 'Safe Resource Prune')}</span>
                          </div>
                          <span className="text-[11px] text-slate-500">
                            {tr('安全保护：不会自动清理任何 Data Volume，避免误删数据库或状态数据。', 'Safety guard: Data Volumes are never pruned automatically.')}
                          </span>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 text-xs">
                          <label className="flex items-center gap-2 rounded-lg border border-slate-200/80 px-3 py-2 dark:border-slate-800 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={pruneOpts.dangling_images}
                              disabled={pruneOpts.unused_images}
                              onChange={(e) => setPruneOpts((p) => ({ ...p, dangling_images: e.target.checked }))}
                            />
                            <span>{tr('悬空镜像 (dangling)', 'Dangling images')}</span>
                          </label>
                          <label className="flex items-center gap-2 rounded-lg border border-amber-200/80 bg-amber-50/40 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={pruneOpts.unused_images}
                              onChange={(e) =>
                                setPruneOpts((p) => ({
                                  ...p,
                                  unused_images: e.target.checked,
                                  dangling_images: e.target.checked ? true : p.dangling_images,
                                }))
                              }
                            />
                            <span>{tr('所有未用镜像 (-a)', 'All unused images (-a)')}</span>
                          </label>
                          <label className="flex items-center gap-2 rounded-lg border border-slate-200/80 px-3 py-2 dark:border-slate-800 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={pruneOpts.build_cache}
                              onChange={(e) => setPruneOpts((p) => ({ ...p, build_cache: e.target.checked }))}
                            />
                            <span>{tr('构建缓存 (build cache)', 'Build cache')}</span>
                          </label>
                          <label className="flex items-center gap-2 rounded-lg border border-slate-200/80 px-3 py-2 dark:border-slate-800 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={pruneOpts.stopped_containers}
                              onChange={(e) => setPruneOpts((p) => ({ ...p, stopped_containers: e.target.checked }))}
                            />
                            <span>{tr('已停止容器', 'Stopped containers')}</span>
                          </label>
                        </div>
                        <div className="flex items-center justify-end">
                          <Button variant="danger-outline" size="sm" loading={pruneBusy} onClick={() => void handlePrune()}>
                            <Sparkles className="h-3.5 w-3.5" />
                            <span>{tr('执行清理任务', 'Run Prune Task')}</span>
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Config Drift Diff */}
                    <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                          <Layers className="h-4 w-4 text-indigo-500" />
                          <span>{tr('配置一致性对比', 'Daemon Configuration Diff')}</span>
                          {inspectData.config_path && (
                            <span className="font-mono text-[11px] font-normal text-slate-500">{inspectData.config_path}</span>
                          )}
                        </div>
                        {configInSync ? (
                          <Badge tone="green">
                            <span className="inline-flex items-center gap-1">
                              <CheckCircle2 className="h-3 w-3" />
                              {tr('与期望配置一致', 'In Sync')}
                            </span>
                          </Badge>
                        ) : (
                          <Badge tone="amber">
                            <span className="inline-flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              {normalizeText(inspectData.actual_config) === ''
                                ? tr('宿主机暂无托管配置文件', 'No Config File on Host')
                                : tr('存在配置差异（可重新应用同步）', 'Config Drift Detected')}
                            </span>
                          </Badge>
                        )}
                      </div>
                      <div className="grid gap-3 lg:grid-cols-2 text-xs">
                        <div>
                          <div className="mb-1.5 font-medium text-slate-600 dark:text-slate-300">
                            {tr('宿主机当前实际配置（敏感密码已脱敏）', 'Actual Host Config (credentials redacted)')}
                          </div>
                          <pre className="max-h-60 overflow-auto rounded-xl border border-slate-200 bg-slate-950 p-3 font-mono text-[11px] text-slate-200 dark:border-slate-800">
                            {inspectData.actual_config || tr('# 宿主机当前未生成该配置文件', '# Config file not present on host')}
                          </pre>
                        </div>
                        <div>
                          <div className="mb-1.5 font-medium text-slate-600 dark:text-slate-300">
                            {tr('控制面期望配置（集群模板 + 主机覆盖）', 'Expected Control Plane Config (Cluster + Host)')}
                          </div>
                          <pre className="max-h-60 overflow-auto rounded-xl border border-slate-200 bg-slate-950 p-3 font-mono text-[11px] text-emerald-200 dark:border-slate-800">
                            {inspectData.expected_config || tr('# 无需写入托管配置文件', '# No managed config file required')}
                          </pre>
                        </div>
                      </div>
                    </div>

                    {/* Containers (Nomad vs Orphan) */}
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                          {tr(`宿主机容器清单（${inspectData.containers.length}）`, `Host Containers (${inspectData.containers.length})`)}
                        </div>
                        {orphanContainers.length > 0 && (
                          <Badge tone="amber">
                            <span className="inline-flex items-center gap-1">
                              <ShieldAlert className="h-3 w-3" />
                              {tr(`发现 ${orphanContainers.length} 个非 Nomad 容器`, `${orphanContainers.length} non-Nomad container(s)`)}
                            </span>
                          </Badge>
                        )}
                      </div>
                      {inspectData.containers.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-slate-200 p-4 text-xs text-slate-500 dark:border-slate-700">
                          {tr('当前宿主机没有任何容器（运行中或已停止）。', 'No containers found on this host.')}
                        </div>
                      ) : (
                        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                          <table className="w-full min-w-[680px] text-left text-xs">
                            <thead className="bg-slate-50/80 dark:bg-slate-950/60">
                              <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                                <th className="px-3 py-2">{tr('容器名称 / ID', 'Container / ID')}</th>
                                <th className="px-3 py-2">{tr('镜像', 'Image')}</th>
                                <th className="px-3 py-2">{tr('状态', 'State')}</th>
                                <th className="px-3 py-2">{tr('归属来源', 'Ownership')}</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                              {inspectData.containers.map((c) => (
                                <tr key={c.id}>
                                  <td className="px-3 py-2.5">
                                    <div className="font-medium text-slate-900 dark:text-slate-100">{c.name || '-'}</div>
                                    <div className="font-mono text-[11px] text-slate-500">{c.id}</div>
                                  </td>
                                  <td className="px-3 py-2.5 font-mono text-slate-700 dark:text-slate-300">{c.image}</td>
                                  <td className="px-3 py-2.5">
                                    <StatusBadge value={c.state} />
                                    <div className="mt-0.5 text-[11px] text-slate-500">{c.status}</div>
                                  </td>
                                  <td className="px-3 py-2.5">
                                    {c.is_nomad_managed ? (
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <Badge tone="blue">Nomad</Badge>
                                        {c.nomad_job_id && (
                                          <Link to="/jobs" className="font-mono text-indigo-600 hover:underline dark:text-indigo-400">
                                            {c.nomad_job_id}
                                          </Link>
                                        )}
                                      </div>
                                    ) : (
                                      <Badge tone="amber">{tr('非 Nomad / 外部容器', 'Non-Nomad / External')}</Badge>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    {/* Images */}
                    <div className="space-y-2">
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {tr(`本地镜像清单（${inspectData.images.length}）`, `Local Images (${inspectData.images.length})`)}
                      </div>
                      {inspectData.images.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-slate-200 p-4 text-xs text-slate-500 dark:border-slate-700">
                          {tr('当前宿主机没有本地镜像。', 'No local images found on this host.')}
                        </div>
                      ) : (
                        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                          <table className="w-full min-w-[640px] text-left text-xs">
                            <thead className="bg-slate-50/80 dark:bg-slate-950/60">
                              <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                                <th className="px-3 py-2">{tr('镜像仓库', 'Repository')}</th>
                                <th className="px-3 py-2">{tr('标签', 'Tag')}</th>
                                <th className="px-3 py-2">{tr('大小', 'Size')}</th>
                                <th className="px-3 py-2">{tr('创建时间', 'Created')}</th>
                                <th className="px-3 py-2">{tr('镜像 ID', 'Image ID')}</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                              {inspectData.images.map((img, idx) => (
                                <tr key={`${img.id}-${img.repository}-${img.tag}-${idx}`}>
                                  <td className="px-3 py-2 font-mono text-slate-800 dark:text-slate-200">{img.repository}</td>
                                  <td className="px-3 py-2">
                                    <Badge tone={img.tag === '<none>' ? 'amber' : 'neutral'}>{img.tag}</Badge>
                                  </td>
                                  <td className="px-3 py-2 font-mono tabular-nums text-slate-700 dark:text-slate-300">{img.size}</td>
                                  <td className="px-3 py-2 text-slate-500">{img.created}</td>
                                  <td className="px-3 py-2 font-mono text-[11px] text-slate-500">{img.id}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            </div>
          )}

          {tab === 'clusters' && (
            <div className="space-y-4">
              {nomadClusters.length === 0 ? (
                <Card>
                  <EmptyState
                    title={tr('尚未创建 Nomad 集群', 'No Nomad Clusters Created')}
                    description={tr('创建 Nomad 集群后，可在此统一管理集群默认 Docker 配置模板和 Client 节点滚动升级。', 'Create a Nomad cluster to manage cluster-wide Docker defaults and rolling Client upgrades here.')}
                    action={
                      <Link
                        to="/nomad"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                      >
                        <span>{tr('前往 Nomad 集群', 'Go to Nomad Clusters')}</span>
                      </Link>
                    }
                  />
                </Card>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#e3e8f1] bg-white px-5 py-3.5 dark:border-slate-800/90 dark:bg-[#0f172a]/95">
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {tr('选择目标 Nomad 集群', 'Target Nomad Cluster')}
                    </div>
                    <div className="w-64">
                      <Select
                        size="sm"
                        aria-label={tr('选择 Nomad 集群', 'Select Nomad Cluster')}
                        value={selectedCluster?.id || ''}
                        onChange={(e) => {
                          setSelectedClusterId(e.target.value);
                          switchTab('clusters', { cluster: e.target.value });
                        }}
                      >
                        {nomadClusters.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} ({c.mode})
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>

                  <div className="grid gap-5 xl:grid-cols-2">
                    {/* Cluster Rolling Docker Upgrade */}
                    <Card
                      title={tr('集群级 Docker 滚动升级', 'Cluster Rolling Docker Upgrade')}
                      description={tr('先生成预演计划确认升级方式（原地热升 vs 疏散后升级），再逐台滚动执行，遇错自动熔断。', 'Preview upgrade strategy (in-place vs drain) per Client node, then roll out sequentially with fail-fast circuit breaking.')}
                    >
                      <div className="space-y-4 text-xs">
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="w-56">
                            <Input
                              label={tr('目标 Docker 版本', 'Target Docker Version')}
                              placeholder="27.5.1"
                              value={upgradeTargetVer}
                              onChange={(e) => {
                                setUpgradeTargetVer(e.target.value);
                                setUpgradePlan(null);
                              }}
                            />
                          </div>
                          {isAdmin && (
                            <Button loading={planBusy} disabled={!upgradeTargetVer.trim()} onClick={() => void handlePlanClusterUpgrade()}>
                              {tr('生成升级预演', 'Preview Upgrade Plan')}
                            </Button>
                          )}
                        </div>

                        {upgradePlan && (
                          <div className="space-y-3">
                            <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                              {tr(`预演结果（目标版本 ${upgradePlan.target_version}）`, `Upgrade Plan (Target: ${upgradePlan.target_version})`)}
                            </div>
                            {upgradePlan.items.length === 0 ? (
                              <div className="rounded-xl border border-dashed border-slate-200 p-3 text-slate-500 dark:border-slate-700">
                                {tr('该集群暂无 Client 节点。', 'No Client nodes in this cluster.')}
                              </div>
                            ) : (
                              <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                                <table className="w-full text-left text-xs">
                                  <thead className="bg-slate-50 dark:bg-slate-950/60">
                                    <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                                      <th className="px-3 py-2">{tr('节点', 'Node')}</th>
                                      <th className="px-3 py-2">{tr('当前版本', 'Current')}</th>
                                      <th className="px-3 py-2">{tr('动作 / 方式', 'Action / Strategy')}</th>
                                      <th className="px-3 py-2">{tr('说明', 'Reason')}</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                                    {upgradePlan.items.map((it) => (
                                      <tr key={it.node_id}>
                                        <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">{it.node}</td>
                                        <td className="px-3 py-2 font-mono text-slate-600 dark:text-slate-300">
                                          {it.current_version || '-'} ({dockerModeLabelOf(it.mode, locale)})
                                        </td>
                                        <td className="px-3 py-2 whitespace-nowrap">
                                          {it.action === 'upgrade' ? (
                                            <Badge tone={it.kind === 'in_place' ? 'green' : 'amber'}>
                                              {it.kind === 'in_place' ? tr('升级 · 原地', 'Upgrade · In-place') : tr('升级 · 需疏散', 'Upgrade · Drain')}
                                            </Badge>
                                          ) : (
                                            <Badge tone="neutral">{tr('跳过', 'Skip')}</Badge>
                                          )}
                                        </td>
                                        <td className="px-3 py-2 text-slate-500">{it.reason}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}

                        {isAdmin && (
                          <div className="space-y-2.5 rounded-xl border border-slate-200/80 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-950/40">
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={upgradeDrain} onChange={(e) => setUpgradeDrain(e.target.checked)} />
                              <span>{tr('升级前强制疏散 Client 工作负载（推荐）', 'Drain Client workloads before upgrade (recommended)')}</span>
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={upgradeConfirm} onChange={(e) => setUpgradeConfirm(e.target.checked)} />
                              <span>{tr('确认允许跨主版本升级', 'Confirm major version upgrade')}</span>
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={upgradeAllowInt} onChange={(e) => setUpgradeAllowInt(e.target.checked)} />
                              <span>{tr('单机或无法疏散时允许容器短时中断', 'Allow brief container interruption when drain is impossible')}</span>
                            </label>
                            <div className="pt-1">
                              <Button
                                variant="primary"
                                loading={upgradeBusy}
                                disabled={!upgradeTargetVer.trim()}
                                onClick={() => void handleStartClusterUpgrade()}
                              >
                                {tr('执行集群滚动升级', 'Start Cluster Rolling Upgrade')}
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    </Card>

                    {/* Cluster Docker Defaults Template */}
                    <Card
                      title={tr('集群默认 Docker 配置模板', 'Cluster Docker Default Template')}
                      description={tr('作为该集群所有节点的基础默认配置；单台主机未显式覆盖的字段将继承此处配置。', 'Base configuration inherited by all hosts in this cluster unless overridden per host.')}
                    >
                      <div className="space-y-4 text-xs">
                        <div className="grid gap-3 sm:grid-cols-2 items-end">
                          <Input
                            label={tr('集群默认 Docker 版本（可选）', 'Cluster Default Docker Version (optional)')}
                            placeholder={settings['defaults.docker_version'] || '27.5.1'}
                            disabled={!isAdmin || defaultsBusy}
                            value={clusterDefaultVer}
                            onChange={(e) => setClusterDefaultVer(e.target.value)}
                          />
                          <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-700">
                            <div>
                              <div className="font-medium text-slate-800 dark:text-slate-100">
                                {tr('缺失时自动安装 Docker', 'Auto-install when missing')}
                              </div>
                              <div className="text-[11px] text-slate-500">
                                {tr('开启时需填写上方默认版本', 'Requires default version above')}
                              </div>
                            </div>
                            <Switch
                              checked={clusterAutoInstall}
                              disabled={!isAdmin || defaultsBusy}
                              label={tr('缺失时自动安装 Docker', 'Auto-install when missing')}
                              onChange={setClusterAutoInstall}
                            />
                          </div>
                        </div>

                        <DockerDaemonConfigFields
                          value={clusterCfg}
                          onChange={setClusterCfg}
                          disabled={!isAdmin || defaultsBusy}
                          dataRootEditable
                          systemPullProxyEnabled={Boolean(settings['proxy.use_for_docker_pull'])}
                          inheritLabel={tr('沿用全局系统代理开关', 'Inherit System Pull Proxy Setting')}
                        />

                        {isAdmin && (
                          <div className="flex justify-end pt-1">
                            <Button variant="primary" loading={defaultsBusy} onClick={() => void handleSaveClusterDefaults()}>
                              {tr('保存集群默认模板', 'Save Cluster Defaults')}
                            </Button>
                          </div>
                        )}
                      </div>
                    </Card>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      <DockerManageModal
        node={dockerNode}
        onClose={() => setDockerNode(null)}
        onTaskSubmitted={async () => {
          await load();
          if (tab === 'inspect' && inspectNodeId) {
            void runInspect(inspectNodeId);
          }
        }}
      />
    </div>
  );
}
