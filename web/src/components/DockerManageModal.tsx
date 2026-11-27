import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { getLocale, trText, type Locale } from '../lib/locale';
import { useOpsDrawer } from '../lib/opsDrawer';
import { useToast } from './Toast';
import { Badge, Button, ErrorAlert, Input, Modal, StatusBadge } from './UI';

export interface DockerManageTarget {
  id: string;
  name: string;
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

export function DockerManageModal({
  node,
  onClose,
  onTaskSubmitted,
}: {
  node: DockerManageTarget | null;
  onClose: () => void;
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
  const [dockerCfg, setDockerCfg] = useState({
    registry_mirrors: '',
    proxy_url: '',
  });

  useEffect(() => {
    if (!node) return;
    let active = true;
    setDockerInfo(null);
    setDockerErr('');
    setDockerBusy(true);
    void Promise.all([apiGet(`/api/v1/nodes/${node.id}/docker`), apiGet('/api/v1/settings')])
      .then(([res, defaults]) => {
        if (!active) return;
        setDockerVer(defaults.settings?.['defaults.docker_version'] || '');
        setDockerInstallProxyEnabled(
          Boolean(defaults.settings?.['proxy.use_for_docker_install'] ?? defaults.settings?.['proxy.use_for_releases']),
        );
        setDockerPullProxyEnabled(Boolean(defaults.settings?.['proxy.use_for_docker_pull']));
        // Nomad's Docker driver can end tasks when the daemon connection closes.
        setDockerDrain(Boolean(res.docker?.cluster_id));
        setDockerConfirm(false);
        setDockerAllowInterruption(false);
        setDockerInfo(res.docker);
        const cfg = res.docker?.host_config || res.docker?.effective || {};
        setDockerCfg({
          registry_mirrors: (cfg.registry_mirrors || []).join(','),
          proxy_url: cfg.pull_proxy?.mode === 'custom' ? cfg.pull_proxy?.url || '' : '',
        });
      })
      .catch((ex: any) => {
        if (active) setDockerErr(ex?.message || tr('加载 Docker 信息失败', 'Failed to load Docker info'));
      })
      .finally(() => {
        if (active) setDockerBusy(false);
      });
    return () => {
      active = false;
    };
  }, [node?.id]);

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
        onClose();
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
      const mirrors = dockerCfg.registry_mirrors
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const customURL = dockerCfg.proxy_url.trim();
      const res = await apiPut(`/api/v1/nodes/${node.id}/docker/config`, {
        registry_mirrors: mirrors,
        pull_proxy: customURL ? { mode: 'custom', url: customURL } : null,
      });
      if (res.task?.id) {
        onClose();
        openTask(res.task.id, tr(`更新 Docker 配置：${node.name}`, `Update Docker Config: ${node.name}`));
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
    setDockerBusy(true);
    try {
      const res = await apiPost(`/api/v1/nodes/${node.id}/docker/proxy-test`, {});
      toast.info(tr(`镜像代理测试结果：${JSON.stringify(res.result)}`, `Registry proxy test result: ${JSON.stringify(res.result)}`));
    } catch (ex: any) {
      setDockerErr(ex?.message || tr('代理测试失败', 'Proxy test failed'));
    } finally {
      setDockerBusy(false);
    }
  };

  return (
    <Modal open={Boolean(node)} title={tr(`Docker 管理：${node?.name || ''}`, `Docker Management: ${node?.name || ''}`)} busy={dockerBusy} onClose={onClose} wide>
      <ErrorAlert message={dockerErr} onClose={() => setDockerErr('')} />
      {!dockerInfo && (
        <p role="status" className="py-8 text-center text-sm text-slate-500">
          {dockerBusy ? tr('正在读取 Docker 状态…', 'Loading Docker status...') : tr('无法读取 Docker 信息，请关闭后重试。', 'Unable to load Docker info; close and retry.')}
        </p>
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
          {dockerInfo.mode !== 'absent' && (
            <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <div className="text-sm font-semibold">{tr('镜像下载与代理', 'Image Registry & Proxy')}</div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-slate-500 dark:text-slate-400">
                <span>{tr('默认镜像拉取代理：', 'Default pull proxy: ')}{dockerPullProxyEnabled ? tr('通过系统代理', 'Via System Proxy') : tr('直连', 'Direct')}</span>
                <Link to="/settings?tab=proxy" className="text-indigo-600 hover:underline dark:text-indigo-400">
                  {tr('在系统设置中按需开启', 'Configure in Settings')}
                </Link>
              </div>
              <Input
                label={tr('Registry Mirrors（逗号分隔）', 'Registry Mirrors (comma-separated)')}
                value={dockerCfg.registry_mirrors}
                onChange={(e) => setDockerCfg({ ...dockerCfg, registry_mirrors: e.target.value })}
              />
              <Input
                label={tr('自定义镜像代理 URL（可选，覆盖系统设置）', 'Custom Pull Proxy URL (optional, overrides system setting)')}
                placeholder={tr('留空则跟随「系统设置 → 下载代理」，例如 http://10.0.0.1:3128', 'Leave blank to inherit System Proxy, e.g. http://10.0.0.1:3128')}
                value={dockerCfg.proxy_url}
                onChange={(e) => setDockerCfg({ ...dockerCfg, proxy_url: e.target.value })}
              />
              <div className="flex gap-2">
                <Button variant="primary" loading={dockerBusy} onClick={() => void saveDockerCfg()}>
                  {tr('应用守护进程配置', 'Apply Daemon Config')}
                </Button>
                <Button disabled={dockerBusy} onClick={() => void testDockerProxy()}>
                  {tr('从节点测试代理', 'Test Proxy from Host')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
