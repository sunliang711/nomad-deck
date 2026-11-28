import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost, apiPut } from '../lib/api';
import {
  buildDockerConfigPayload,
  dockerConfigDraftFrom,
  emptyDockerConfigDraft,
  type DockerConfigDraft,
  type PullProxyMode,
} from '../lib/dockerConfig';
import { useI18n } from '../lib/i18n';
import { getLocale, trText, type Locale } from '../lib/locale';
import { useOpsDrawer } from '../lib/opsDrawer';
import { useToast } from './Toast';
import { Badge, Button, ErrorAlert, Input, SecretInput, Select, StatusBadge, TermLabel } from './UI';

export {
  buildDockerConfigPayload,
  dockerConfigDraftFrom,
  emptyDockerConfigDraft,
  type DockerConfigDraft,
  type PullProxyMode,
};

export interface DockerManageTarget {
  id: string;
  name: string;
}

export interface DockerProxyTestResult {
  ok: boolean;
  registry: string;
  status_code: number;
  duration_ms: number;
  error?: string;
}

export function DockerDaemonConfigFields({
  value,
  onChange,
  disabled = false,
  dataRootEditable = false,
  effectiveDataRoot,
  externalOnly = false,
  inheritLabel,
  systemPullProxyEnabled,
}: {
  value: DockerConfigDraft;
  onChange: (next: DockerConfigDraft) => void;
  disabled?: boolean;
  dataRootEditable?: boolean;
  effectiveDataRoot?: string;
  externalOnly?: boolean;
  inheritLabel?: string;
  systemPullProxyEnabled?: boolean;
}) {
  const { tr } = useI18n();

  return (
    <div className="space-y-3">
      {!externalOnly && (
        <>
          <Input
            label={tr('镜像加速源 Registry Mirrors（逗号分隔）', 'Registry Mirrors (comma-separated)')}
            placeholder="https://mirror.example.com"
            disabled={disabled}
            value={value.registry_mirrors}
            onChange={(e) => onChange({ ...value, registry_mirrors: e.target.value })}
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              label={
                <TermLabel
                  term={tr('数据目录 (data-root)', 'Data Root (data-root)')}
                  tip={tr(
                    '仅在首次安装 Docker 时可修改，安装完成后保持只读以防已有容器和镜像层路径失效。',
                    'Editable only on initial Docker install; read-only afterward to avoid stranding existing container/image layers.',
                  )}
                />
              }
              placeholder="/var/lib/docker"
              disabled={disabled || !dataRootEditable}
              value={dataRootEditable ? value.data_root : value.data_root || effectiveDataRoot || '/var/lib/docker'}
              onChange={(e) => onChange({ ...value, data_root: e.target.value })}
            />
            <Input
              label={tr('日志单文件上限 (max-size)', 'Log Max Size (max-size)')}
              placeholder="50m"
              disabled={disabled}
              value={value.log_max_size}
              onChange={(e) => onChange({ ...value, log_max_size: e.target.value })}
            />
            <Input
              label={tr('日志保留份数 (max-file)', 'Log Max Files (max-file)')}
              placeholder="3"
              type="number"
              min={1}
              max={100}
              disabled={disabled}
              value={value.log_max_file}
              onChange={(e) => onChange({ ...value, log_max_file: e.target.value })}
            />
          </div>
        </>
      )}

      <div className="space-y-3 rounded-xl border border-slate-200/90 bg-slate-50/70 p-3 dark:border-slate-700/80 dark:bg-slate-950/40">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-medium text-slate-800 dark:text-slate-100">
            {tr('镜像拉取代理 (Pull Proxy)', 'Image Pull Proxy')}
          </div>
          {systemPullProxyEnabled !== undefined && (
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              {tr('系统默认拉取代理：', 'System default pull proxy: ')}
              {systemPullProxyEnabled ? tr('开启', 'Enabled') : tr('直连', 'Direct')}
            </span>
          )}
        </div>
        <Select
          label={tr('代理模式', 'Proxy Mode')}
          disabled={disabled}
          value={value.pull_proxy_mode}
          onChange={(e) => onChange({ ...value, pull_proxy_mode: e.target.value as PullProxyMode })}
        >
          <option value="">{inheritLabel || tr('沿用上级默认（集群模板 / 系统设置）', 'Inherit (Cluster Defaults / System Proxy)')}</option>
          <option value="system">{tr('强制走系统下载代理', 'Use System Proxy')}</option>
          <option value="none">{tr('强制直连（不使用代理）', 'Direct (Disable Proxy)')}</option>
          <option value="custom">{tr('自定义 HTTP(S) 代理', 'Custom HTTP(S) Proxy')}</option>
        </Select>

        {value.pull_proxy_mode === 'custom' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <Input
                label={tr('代理 URL（http:// 或 https://主机:端口）', 'Proxy URL (http(s)://host:port)')}
                placeholder="http://10.0.0.1:3128"
                disabled={disabled}
                value={value.pull_proxy_url}
                onChange={(e) => onChange({ ...value, pull_proxy_url: e.target.value })}
              />
            </div>
            <Input
              label={tr('用户名（可选）', 'Username (optional)')}
              disabled={disabled}
              value={value.pull_proxy_username}
              onChange={(e) => onChange({ ...value, pull_proxy_username: e.target.value })}
            />
            <div className="sm:col-span-2">
              <SecretInput
                label={
                  value.pull_proxy_password_set
                    ? tr('密码（已加密保存，留空保持不变）', 'Password (saved encrypted; leave blank to keep)')
                    : tr('密码（可选）', 'Password (optional)')
                }
                hasStoredValue={value.pull_proxy_password_set}
                disabled={disabled}
                value={value.pull_proxy_password}
                onChangeValue={(val) => onChange({ ...value, pull_proxy_password: val })}
              />
            </div>
          </div>
        )}

        {(value.pull_proxy_mode === 'system' || value.pull_proxy_mode === 'custom') && (
          <Input
            label={tr('直连例外 no_proxy（逗号分隔，自动附加回环与集群节点 IP）', 'Bypass no_proxy (comma-separated; loopback & cluster IPs auto-added)')}
            placeholder="registry.internal, 10.0.0.0/8"
            disabled={disabled}
            value={value.pull_proxy_no_proxy}
            onChange={(e) => onChange({ ...value, pull_proxy_no_proxy: e.target.value })}
          />
        )}
      </div>
    </div>
  );
}

export function dockerModeLabelOf(mode?: string, locale: Locale = getLocale()): string {
  if (mode === 'managed') return trText('托管', 'Managed', locale);
  if (mode === 'external') return trText('外部', 'External', locale);
  if (mode === 'absent') return trText('未安装', 'Not Installed', locale);
  return mode || '-';
}

export function dockerStatusLabelOf(status?: string, locale: Locale = getLocale()): string {
  if (status === 'running' || status === 'active') return trText('运行中', 'Running', locale);
  if (status === 'absent') return '';
  return status || '';
}

export function DockerManagePanel({
  node,
  onTaskSubmitted,
}: {
  node: DockerManageTarget | null;
  onTaskSubmitted?: () => Promise<void> | void;
}) {
  const { tr } = useI18n();
  const { openTask } = useOpsDrawer();
  const toast = useToast();

  const [dockerInfo, setDockerInfo] = useState<any>(null);
  const [dockerErr, setDockerErr] = useState('');
  const [dockerBusy, setDockerBusy] = useState(false);
  const [dockerVer, setDockerVer] = useState('');
  const [dockerInstallProxyEnabled, setDockerInstallProxyEnabled] = useState(false);
  const [dockerPullProxyEnabled, setDockerPullProxyEnabled] = useState(false);
  const [dockerDrain, setDockerDrain] = useState(false);
  const [dockerConfirm, setDockerConfirm] = useState(false);
  const [dockerAllowInterruption, setDockerAllowInterruption] = useState(false);
  const [dockerCfg, setDockerCfg] = useState<DockerConfigDraft>(emptyDockerConfigDraft);
  const [proxyTestRes, setProxyTestRes] = useState<DockerProxyTestResult | null>(null);

  const loadDockerInfo = useCallback(
    async (isActive?: () => boolean) => {
      if (!node) return;
      setDockerInfo(null);
      setDockerErr('');
      setProxyTestRes(null);
      setDockerBusy(true);
      try {
        const [res, defaults] = await Promise.all([
          apiGet(`/api/v1/nodes/${node.id}/docker`),
          apiGet('/api/v1/settings'),
        ]);
        if (isActive && !isActive()) return;
        setDockerVer(res.docker?.host_config?.version || defaults.settings?.['defaults.docker_version'] || '');
        setDockerInstallProxyEnabled(
          Boolean(defaults.settings?.['proxy.use_for_docker_install'] ?? defaults.settings?.['proxy.use_for_releases']),
        );
        setDockerPullProxyEnabled(Boolean(defaults.settings?.['proxy.use_for_docker_pull']));
        // Nomad's Docker driver can end tasks when the daemon connection closes.
        setDockerDrain(Boolean(res.docker?.cluster_id));
        setDockerConfirm(false);
        setDockerAllowInterruption(false);
        setDockerInfo(res.docker);
        const hostCfg = res.docker?.host_config || {};
        setDockerCfg(dockerConfigDraftFrom(hostCfg, Boolean(hostCfg.pull_proxy_password_set)));
      } catch (ex: any) {
        if (!isActive || isActive()) {
          setDockerErr(ex?.message || tr('加载 Docker 信息失败', 'Failed to load Docker info'));
        }
      } finally {
        if (!isActive || isActive()) {
          setDockerBusy(false);
        }
      }
    },
    [node?.id, tr],
  );

  useEffect(() => {
    if (!node) return;
    let active = true;
    void loadDockerInfo(() => active);
    return () => {
      active = false;
    };
  }, [node?.id, loadDockerInfo]);

  const runDockerAction = async (action: 'install' | 'upgrade' | 'adopt') => {
    if (!node || dockerBusy) return;
    setDockerErr('');
    setDockerBusy(true);
    try {
      const res = await apiPost(`/api/v1/nodes/${node.id}/docker/${action}`, {
        version: dockerVer.trim(),
        drain: dockerDrain,
        confirm: dockerConfirm,
        allow_interruption: dockerAllowInterruption,
      });
      if (res.task?.id) {
        openTask(
          res.task.id,
          tr(
            `Docker ${action === 'install' ? '安装' : action === 'upgrade' ? '升级' : '转为托管'}：${node.name}`,
            `Docker ${action === 'install' ? 'Install' : action === 'upgrade' ? 'Upgrade' : 'Adopt'}: ${node.name}`,
          ),
        );
        await onTaskSubmitted?.();
      }
    } catch (ex: any) {
      setDockerErr(ex?.message || tr(`Docker ${action} 失败`, `Docker ${action} failed`));
    } finally {
      setDockerBusy(false);
    }
  };

  const saveDockerCfg = async () => {
    if (!node || dockerBusy) return;
    setDockerErr('');
    setDockerBusy(true);
    try {
      const payload = buildDockerConfigPayload(dockerCfg, {
        includeDataRoot: dockerInfo?.mode === 'absent',
        externalOnly: dockerInfo?.mode === 'external',
      });
      const res = await apiPut(`/api/v1/nodes/${node.id}/docker/config`, payload);
      if (res?.task?.id) {
        openTask(res.task.id, tr(`更新 Docker 配置：${node.name}`, `Update Docker Config: ${node.name}`));
        await onTaskSubmitted?.();
      } else {
        toast.success(tr('已保存节点 Docker 预配置（安装时自动生效）', 'Saved node Docker pre-config (applied on install)'));
        await loadDockerInfo();
        await onTaskSubmitted?.();
      }
    } catch (ex: any) {
      setDockerErr(ex?.message || tr('保存 Docker 配置失败', 'Failed to save Docker config'));
    } finally {
      setDockerBusy(false);
    }
  };

  const testDockerProxy = async () => {
    if (!node || dockerBusy) return;
    setDockerErr('');
    setProxyTestRes(null);
    setDockerBusy(true);
    try {
      const payload = buildDockerConfigPayload(dockerCfg, {
        includeDataRoot: dockerInfo?.mode === 'absent',
        externalOnly: dockerInfo?.mode === 'external',
      });
      const res = await apiPost(`/api/v1/nodes/${node.id}/docker/proxy-test`, payload);
      const r = res.result as DockerProxyTestResult;
      setProxyTestRes(r);
      if (r.ok) {
        toast.success(tr(`代理测试通过（HTTP ${r.status_code}，${r.duration_ms}ms）`, `Proxy test passed (HTTP ${r.status_code}, ${r.duration_ms}ms)`));
      } else {
        toast.error(r.error || tr(`代理测试失败（HTTP ${r.status_code}）`, `Proxy test failed (HTTP ${r.status_code})`));
      }
    } catch (ex: any) {
      setDockerErr(ex?.message || tr('代理测试失败', 'Proxy test failed'));
    } finally {
      setDockerBusy(false);
    }
  };

  if (!node) return null;

  return (
    <div className="space-y-4">
      <ErrorAlert message={dockerErr} onClose={() => setDockerErr('')} />
      {!dockerInfo && (
        <div className="flex flex-col items-center gap-3 py-8 text-center text-sm text-slate-500">
          <p role="status">
            {dockerBusy ? tr('正在读取 Docker 状态…', 'Loading Docker status...') : tr('无法读取 Docker 信息，请重试。', 'Unable to load Docker info; please retry.')}
          </p>
          {!dockerBusy && (
            <Button size="sm" onClick={() => void loadDockerInfo()}>
              {tr('重新读取', 'Retry')}
            </Button>
          )}
        </div>
      )}
      {dockerInfo && (
        <div className="space-y-4 text-xs">
          <div className="grid gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-950 sm:grid-cols-3">
            <div>
              {tr('管理方式：', 'Mode: ')}
              <span className="font-semibold">
                {{
                  absent: tr('未安装', 'Not Installed'),
                  managed: tr('平台托管', 'Managed'),
                  external: tr('外部安装', 'External'),
                }[dockerInfo.mode as string] || dockerInfo.mode}
              </span>
            </div>
            <div>
              {tr('版本：', 'Version: ')}<span className="font-mono">{dockerInfo.version || '-'}</span>
            </div>
            <div>
              {tr('状态：', 'Status: ')}{dockerInfo.mode === 'absent' ? <Badge tone="neutral">{tr('未安装', 'Not Installed')}</Badge> : <StatusBadge value={dockerInfo.status} />}
            </div>
            {dockerInfo.repository && (
              <div className="sm:col-span-3 text-slate-500 dark:text-slate-400">
                {tr('软件源：', 'Repository: ')}<span className="font-mono">{dockerInfo.repository}</span>
              </div>
            )}
            {dockerInfo.unsupported_reason && (
              <div className="sm:col-span-3 text-amber-700 dark:text-amber-300">
                {dockerInfo.unsupported_reason}
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <div className="text-sm font-semibold">{dockerInfo.mode === 'absent' ? tr('1. 安装容器运行环境', '1. Install Container Runtime') : tr('版本与维护', 'Version & Maintenance')}</div>
            <p className="text-xs leading-5 text-slate-500">
              {tr(
                'Docker 用于支撑 Nomad Client 运行容器任务。安装包由控制面下载、验签并分发到当前主机。',
                'Docker powers Nomad Client container workloads. Packages are downloaded, verified, and distributed from the control plane.',
              )}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-48">
                <Input
                  label={dockerInfo.mode === 'absent' ? tr('安装版本（可选）', 'Version (optional)') : tr('目标版本', 'Target Version')}
                  placeholder={dockerInfo.mode === 'absent' ? tr('留空安装仓库最新版', 'Leave blank for latest') : tr('请输入完整版本号', 'Enter full version')}
                  value={dockerVer}
                  onChange={(e) => setDockerVer(e.target.value)}
                />
              </div>
              {dockerInfo.mode === 'absent' && (
                <Button variant="primary" loading={dockerBusy} onClick={() => void runDockerAction('install')}>
                  {tr('安装 Docker', 'Install Docker')}
                </Button>
              )}
              {dockerInfo.mode === 'managed' && (
                <Button loading={dockerBusy} disabled={!dockerVer.trim()} onClick={() => void runDockerAction('upgrade')}>
                  {tr('升级 Docker', 'Upgrade Docker')}
                </Button>
              )}
              {dockerInfo.mode === 'external' && (
                <Button loading={dockerBusy} onClick={() => void runDockerAction('adopt')}>
                  {tr('转为托管', 'Adopt as Managed')}
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-slate-500 dark:text-slate-400">
              <span>{tr('安装/升级下载：', 'Install/Upgrade download: ')}{dockerInstallProxyEnabled ? tr('通过系统代理', 'Via System Proxy') : tr('直连', 'Direct')}</span>
              <Link to="/settings?tab=proxy" className="text-indigo-600 hover:underline dark:text-indigo-400">
                {tr('前往下载代理设置', 'Proxy Settings')}
              </Link>
            </div>
          </div>

          {dockerInfo.mode !== 'absent' && (
            <details className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <summary className="cursor-pointer font-medium">{tr('升级策略与中断确认', 'Upgrade Policy & Interruption Confirmations')}</summary>
              <div className="mt-3 space-y-3">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={dockerDrain} onChange={(e) => setDockerDrain(e.target.checked)} />
                  <span>{tr('升级前疏散 Nomad 工作负载', 'Drain Nomad workloads before upgrade')}</span>
                </label>
                <p className="text-slate-500">
                  {tr(
                    'Nomad 客户端默认疏散，需有可调度的替代节点；关闭疏散时，Docker 驱动重连可能中断 Task。',
                    'Nomad Clients drain by default and require alternative schedulable nodes; disabling drain may interrupt tasks when Docker reconnects.',
                  )}
                </p>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={dockerConfirm} onChange={(e) => setDockerConfirm(e.target.checked)} />
                  <span>{tr('确认跨主版本升级', 'Confirm major version upgrade')}</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={dockerAllowInterruption}
                    onChange={(e) => setDockerAllowInterruption(e.target.checked)}
                  />
                  <span>{tr('允许无法疏散节点的容器中断', 'Allow container interruption if node cannot be drained')}</span>
                </label>
              </div>
            </details>
          )}

          <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">
                {dockerInfo.mode === 'absent'
                  ? tr('2. 守护进程预配置（可选）', '2. Pre-Install Daemon Config (Optional)')
                  : tr('守护进程配置与镜像代理', 'Daemon Config & Registry Proxy')}
              </div>
              <Link to="/settings?tab=proxy" className="text-indigo-600 hover:underline dark:text-indigo-400">
                {tr('配置系统代理', 'System Proxy Settings')}
              </Link>
            </div>
            {dockerInfo.mode === 'external' && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                {tr(
                  '当前主机为外部 Docker，平台仅托管镜像拉取代理（systemd drop-in）；如需托管完整 daemon.json，请先点击上方「转为托管」。',
                  'This host uses external Docker; only pull proxy (systemd drop-in) is managed. Click "Adopt as Managed" above to manage full daemon.json.',
                )}
              </p>
            )}
            <DockerDaemonConfigFields
              value={dockerCfg}
              onChange={setDockerCfg}
              disabled={dockerBusy}
              dataRootEditable={dockerInfo.mode === 'absent'}
              effectiveDataRoot={dockerInfo.effective?.data_root}
              externalOnly={dockerInfo.mode === 'external'}
              systemPullProxyEnabled={dockerPullProxyEnabled}
              inheritLabel={
                dockerInfo.cluster_id
                  ? tr('沿用所属集群默认模板 / 系统代理', 'Inherit Cluster Defaults / System Proxy')
                  : tr('沿用系统设置中的默认拉取代理', 'Inherit System Pull Proxy')
              }
            />
            {proxyTestRes && (
              <div
                className={`rounded-lg border px-3 py-2 ${
                  proxyTestRes.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200'
                    : 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200'
                }`}
              >
                <div>
                  {proxyTestRes.ok ? tr('测试通过', 'Passed') : tr('测试失败', 'Failed')} · HTTP {proxyTestRes.status_code || '-'} · {proxyTestRes.duration_ms}ms ·{' '}
                  <span className="font-mono">{proxyTestRes.registry}</span>
                </div>
                {proxyTestRes.error && <div className="mt-1">{proxyTestRes.error}</div>}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={dockerBusy} onClick={() => void saveDockerCfg()}>
                {dockerInfo.mode === 'absent' ? tr('保存预配置', 'Save Pre-Config') : tr('应用守护进程配置', 'Apply Daemon Config')}
              </Button>
              <Button disabled={dockerBusy} onClick={() => void testDockerProxy()}>
                {tr('从节点测试代理', 'Test Proxy from Host')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
