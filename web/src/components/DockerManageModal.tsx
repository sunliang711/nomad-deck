import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { useOpsDrawer } from '../lib/opsDrawer';
import { useToast } from './Toast';
import { Badge, Button, ErrorAlert, Input, Modal, StatusBadge } from './UI';

export interface DockerManageTarget {
  id: string;
  name: string;
}

export function dockerModeLabelOf(mode?: string): string {
  if (mode === 'managed') return '托管';
  if (mode === 'external') return '外部';
  if (mode === 'absent') return '未安装';
  return mode || '-';
}

export function dockerStatusLabelOf(status?: string): string {
  if (status === 'running' || status === 'active') return '运行中';
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
        if (active) setDockerErr(ex?.message || '加载 Docker 信息失败');
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
          `Docker ${action === 'install' ? '安装' : action === 'upgrade' ? '升级' : '转为托管'}：${node.name}`,
        );
        await onTaskSubmitted?.();
      }
    } catch (ex: any) {
      setDockerErr(ex?.message || `Docker ${action} 失败`);
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
        openTask(res.task.id, `更新 Docker 配置：${node.name}`);
        await onTaskSubmitted?.();
      }
    } catch (ex: any) {
      setDockerErr(ex?.message || '保存 Docker 配置失败');
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
      toast.info(`镜像代理测试结果：${JSON.stringify(res.result)}`);
    } catch (ex: any) {
      setDockerErr(ex?.message || '代理测试失败');
    } finally {
      setDockerBusy(false);
    }
  };

  return (
    <Modal open={Boolean(node)} title={`Docker 管理：${node?.name || ''}`} busy={dockerBusy} onClose={onClose} wide>
      <ErrorAlert message={dockerErr} onClose={() => setDockerErr('')} />
      {!dockerInfo && (
        <p role="status" className="py-8 text-center text-sm text-slate-500">
          {dockerBusy ? '正在读取 Docker 状态…' : '无法读取 Docker 信息，请关闭后重试。'}
        </p>
      )}
      {dockerInfo && (
        <div className="space-y-4 text-xs">
          <div className="grid gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-950 sm:grid-cols-3">
            <div>
              管理方式：
              <span className="font-semibold">
                {{ absent: '未安装', managed: '平台托管', external: '外部安装' }[dockerInfo.mode as string] || dockerInfo.mode}
              </span>
            </div>
            <div>
              版本：<span className="font-mono">{dockerInfo.version || '-'}</span>
            </div>
            <div>
              状态：{dockerInfo.mode === 'absent' ? <Badge tone="neutral">未安装</Badge> : <StatusBadge value={dockerInfo.status} />}
            </div>
          </div>
          <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <div className="text-sm font-semibold">{dockerInfo.mode === 'absent' ? '1. 安装容器运行环境' : '版本与维护'}</div>
            <p className="text-xs leading-5 text-slate-500">
              Docker 用于支撑 Nomad Client 运行容器任务。安装包由控制面下载、验签并分发到当前主机。
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-48">
                <Input
                  label={dockerInfo.mode === 'absent' ? '安装版本（可选）' : '目标版本'}
                  placeholder={dockerInfo.mode === 'absent' ? '留空安装仓库最新版' : '请输入完整版本号'}
                  value={dockerVer}
                  onChange={(e) => setDockerVer(e.target.value)}
                />
              </div>
              {dockerInfo.mode === 'absent' && (
                <Button variant="primary" loading={dockerBusy} onClick={() => void runDockerAction('install')}>
                  安装 Docker
                </Button>
              )}
              {dockerInfo.mode === 'managed' && (
                <Button loading={dockerBusy} disabled={!dockerVer.trim()} onClick={() => void runDockerAction('upgrade')}>
                  升级 Docker
                </Button>
              )}
              {dockerInfo.mode === 'external' && (
                <Button loading={dockerBusy} onClick={() => void runDockerAction('adopt')}>
                  转为托管
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-slate-500 dark:text-slate-400">
              <span>安装/升级下载：{dockerInstallProxyEnabled ? '通过系统代理' : '直连'}</span>
              <Link to="/settings?tab=proxy" className="text-indigo-600 hover:underline dark:text-indigo-400">
                前往下载代理设置
              </Link>
            </div>
          </div>
          {dockerInfo.mode !== 'absent' && (
            <details className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <summary className="cursor-pointer font-medium">升级策略与中断确认</summary>
              <div className="mt-3 space-y-3">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={dockerDrain} onChange={(e) => setDockerDrain(e.target.checked)} />
                  <span>升级前疏散 Nomad 工作负载</span>
                </label>
                <p className="text-slate-500">
                  Nomad 客户端默认疏散，需有可调度的替代节点；关闭疏散时，Docker 驱动重连可能中断 Task。
                </p>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={dockerConfirm} onChange={(e) => setDockerConfirm(e.target.checked)} />
                  <span>确认跨主版本升级</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={dockerAllowInterruption}
                    onChange={(e) => setDockerAllowInterruption(e.target.checked)}
                  />
                  <span>允许无法疏散节点的容器中断</span>
                </label>
              </div>
            </details>
          )}
          {dockerInfo.mode !== 'absent' && (
            <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <div className="text-sm font-semibold">镜像下载与代理</div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-slate-500 dark:text-slate-400">
                <span>默认镜像拉取代理：{dockerPullProxyEnabled ? '通过系统代理' : '直连'}</span>
                <Link to="/settings?tab=proxy" className="text-indigo-600 hover:underline dark:text-indigo-400">
                  在系统设置中按需开启
                </Link>
              </div>
              <Input
                label="Registry Mirrors（逗号分隔）"
                value={dockerCfg.registry_mirrors}
                onChange={(e) => setDockerCfg({ ...dockerCfg, registry_mirrors: e.target.value })}
              />
              <Input
                label="自定义镜像代理 URL（可选，覆盖系统设置）"
                placeholder="留空则跟随「系统设置 → 下载代理」，例如 http://10.0.0.1:3128"
                value={dockerCfg.proxy_url}
                onChange={(e) => setDockerCfg({ ...dockerCfg, proxy_url: e.target.value })}
              />
              <div className="flex gap-2">
                <Button variant="primary" loading={dockerBusy} onClick={() => void saveDockerCfg()}>
                  应用守护进程配置
                </Button>
                <Button disabled={dockerBusy} onClick={() => void testDockerProxy()}>
                  从节点测试代理
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
