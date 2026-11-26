import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, RefreshCw, RotateCw, X, XCircle } from 'lucide-react';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { useConfirm, type BeforeNavigateDetail } from '../components/ConfirmDialog';
import {
  Button,
  Card,
  ErrorAlert,
  Input,
  LoadingState,
  PageHeader,
  PasswordConfirmModal,
  SecretInput,
  SectionTabs,
  Select,
  StatusBadge,
  Switch,
  TermLabel,
} from '../components/UI';

type SettingGroup = 'general' | 'releases' | 'clusters';

interface SettingItemMeta {
  key: string;
  group: SettingGroup;
  label: string;
  tip?: string;
  type: 'number' | 'text' | 'bool' | 'textarea' | 'select';
  options?: string[];
}

const settingMeta: SettingItemMeta[] = [
  { key: 'cron.timezone', group: 'general', label: '定时任务时区', tip: '内置和自定义 Cron 任务的触发时区，例如 Asia/Shanghai 或 UTC。', type: 'text' },
  { key: 'ssh.timeout_sec', group: 'general', label: 'SSH 连接超时（秒）', type: 'number' },
  { key: 'ssh.max_concurrency', group: 'general', label: 'SSH 最大并发（需重启）', type: 'number' },
  { key: 'auth.session_ttl_hours', group: 'general', label: '会话绝对有效期（小时）', tip: '单次登录会话最长有效时间，到期必须重新登录。', type: 'number' },
  { key: 'auth.session_idle_minutes', group: 'general', label: '会话空闲超时（分钟）', tip: '连续无操作超过该分钟数后会话自动失效。', type: 'number' },
  { key: 'audit.retention_days', group: 'general', label: '审计日志保留天数', type: 'number' },
  { key: 'ops.retention_days', group: 'general', label: '运维日志保留天数', type: 'number' },

  { key: 'defaults.nomad_version', group: 'releases', label: '默认 Nomad 版本', tip: '填 latest 可自动解析 HashiCorp 最新稳定版，或指定具体版本号。', type: 'text' },
  { key: 'defaults.vault_version', group: 'releases', label: '默认 Vault 版本', tip: '填 latest 可自动解析 HashiCorp 最新稳定版，或指定具体版本号。', type: 'text' },
  { key: 'defaults.docker_version', group: 'releases', label: '默认 Docker 版本', type: 'text' },
  { key: 'release.mirror_url', group: 'releases', label: 'HashiCorp 镜像源 URL', tip: '覆盖默认 releases.hashicorp.com 地址，适合内网制品库或反代加速。', type: 'text' },
  {
    key: 'release.cni_checksums',
    group: 'releases',
    label: '自定义 CNI 插件校验和 (JSON)',
    tip: '按 {"v1.11.0":{"amd64":"<sha256>","arm64":"<sha256>"}} 格式登记额外的 containernetworking/plugins 版本校验和，与内置版本合并展示。',
    type: 'textarea',
  },
  { key: 'release.transfer_rate_limit', group: 'releases', label: '分发限速（字节/秒，0=不限）', tip: '限制控制面向节点 SFTP 分发安装包时的带宽上限。', type: 'number' },
  { key: 'upgrade.max_minor_skip', group: 'releases', label: '滚动升级允许跨小版本上限', tip: '例如设为 2 时，不允许从 1.7 直接跨 3 个次版本升到 1.10，防止 Raft 状态机不兼容。', type: 'number' },
  { key: 'self_update.channel', group: 'releases', label: '自更新发布通道', type: 'select', options: ['stable', 'prerelease'] },
  { key: 'self_update.backup_retention', group: 'releases', label: '升级前数据库备份保留份数', type: 'number' },

  { key: 'snapshot.retention_count', group: 'clusters', label: '定时快照默认保留份数', type: 'number' },
  { key: 'snapshot.dir', group: 'clusters', label: '快照存储目录（留空为默认）', type: 'text' },
  { key: 'cert.alert_days', group: 'clusters', label: '证书到期预警天数', tip: 'mTLS 证书剩余有效期低于该天数时将在仪表盘预警。', type: 'number' },
  { key: 'nomad.stats_interval_seconds', group: 'clusters', label: 'Nomad 资源采样间隔（秒）', type: 'number' },
  { key: 'nomad.exec_idle_minutes', group: 'clusters', label: '终端空闲超时（分钟）', type: 'number' },
  { key: 'nomad.exec_max_minutes', group: 'clusters', label: '终端最长运行时间（分钟）', type: 'number' },
  { key: 'observability.grafana_url_template', group: 'clusters', label: 'Grafana 跳转链接模板', type: 'text' },
  { key: 'docker.test_image', group: 'clusters', label: 'Docker 代理测试镜像', type: 'text' },
];

export function SettingsPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();

  const validTabs = new Set(['general', 'releases', 'clusters', 'proxy', 'security']);
  const queryTab = searchParams.get('tab');
  const [tab, setTabState] = useState<'general' | 'releases' | 'clusters' | 'proxy' | 'security'>(() =>
    queryTab && validTabs.has(queryTab) ? (queryTab as 'general' | 'releases' | 'clusters' | 'proxy' | 'security') : 'general',
  );
  useEffect(() => {
    if (queryTab && validTabs.has(queryTab) && queryTab !== tab) {
      setTabState(queryTab as typeof tab);
    }
  }, [queryTab, tab]);
  const setTab = (next: 'general' | 'releases' | 'clusters' | 'proxy' | 'security') => {
    setTabState(next);
    setSearchParams(next === 'general' ? {} : { tab: next }, { replace: true });
  };
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingProxy, setSavingProxy] = useState(false);
  const [testingProxy, setTestingProxy] = useState(false);
  const [clearingProxy, setClearingProxy] = useState(false);

  const [settings, setSettings] = useState<Record<string, any>>({});
  const [savedSettingsSnap, setSavedSettingsSnap] = useState('');

  const [proxy, setProxy] = useState<any>({
    configured: false,
    mode: 'direct' as 'direct' | 'custom',
    type: 'http',
    host: '',
    port: 3128,
    username: '',
    password: '',
    password_set: false,
    no_proxy: '',
    use_for_nomad: false,
    use_for_vault: false,
    use_for_docker_install: false,
    use_for_docker_pull: false,
    use_for_self_update: false,
  });
  const [savedProxySnap, setSavedProxySnap] = useState('');
  const [proxyTestReport, setProxyTestReport] = useState<{
    title: string;
    tone: 'ok' | 'partial' | 'fail';
    exit_ip?: string;
    results: Array<{ name: string; ok: boolean; status_code?: number; latency_ms?: number; error?: string }>;
  } | null>(null);
  const [masterKey, setMasterKey] = useState<any>(null);
  const [showRotatePw, setShowRotatePw] = useState(false);
  const [err, setErr] = useState('');

  const buildSettingsSnap = (obj: Record<string, any>) => {
    const out: Record<string, any> = {};
    for (const m of settingMeta) {
      if (m.key === 'release.cni_checksums') {
        const raw = obj[m.key];
        out[m.key] = typeof raw === 'string' ? raw : JSON.stringify(raw || {}, null, 2);
      } else {
        out[m.key] = obj[m.key] ?? '';
      }
    }
    return JSON.stringify(out);
  };

  const buildProxySnap = (p: any) =>
    JSON.stringify({
      mode: p.mode,
      type: p.type,
      host: (p.host || '').trim(),
      port: Number(p.port),
      username: (p.username || '').trim(),
      password: p.password || '',
      no_proxy: (p.no_proxy || '').trim(),
      use_for_nomad: Boolean(p.use_for_nomad),
      use_for_vault: Boolean(p.use_for_vault),
      use_for_docker_install: Boolean(p.use_for_docker_install),
      use_for_docker_pull: Boolean(p.use_for_docker_pull),
      use_for_self_update: Boolean(p.use_for_self_update),
    });

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const [sRes, pRes] = await Promise.all([apiGet('/api/v1/settings'), apiGet('/api/v1/settings/proxy')]);
      const nextSettings = { ...(sRes.settings || {}) };
      if (typeof nextSettings['release.cni_checksums'] !== 'string') {
        nextSettings['release.cni_checksums'] = JSON.stringify(nextSettings['release.cni_checksums'] || {}, null, 2);
      }
      setSettings(nextSettings);
      setSavedSettingsSnap(buildSettingsSnap(nextSettings));

      const pv = pRes.proxy || {};
      const legacyReleases = Boolean(nextSettings['proxy.use_for_releases']);
      const nextProxy = {
        configured: Boolean(pv.configured),
        mode: (pv.configured ? 'custom' : 'direct') as 'direct' | 'custom',
        type: pv.type || 'http',
        host: pv.host || '',
        port: pv.port || 3128,
        username: pv.username || '',
        password: '',
        password_set: Boolean(pv.password_set),
        no_proxy: (pv.no_proxy || []).join(','),
        use_for_nomad: Boolean(nextSettings['proxy.use_for_nomad'] ?? legacyReleases),
        use_for_vault: Boolean(nextSettings['proxy.use_for_vault'] ?? legacyReleases),
        use_for_docker_install: Boolean(nextSettings['proxy.use_for_docker_install'] ?? legacyReleases),
        use_for_docker_pull: Boolean(nextSettings['proxy.use_for_docker_pull']),
        use_for_self_update: Boolean(nextSettings['proxy.use_for_self_update']),
      };
      setProxy(nextProxy);
      setSavedProxySnap(buildProxySnap(nextProxy));

      if (isAdmin) {
        const mkRes = await apiGet('/api/v1/settings/master-key');
        setMasterKey(mkRes.master_key);
      }
    } catch (ex: any) {
      setErr(ex?.message || '加载系统设置失败');
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const settingsDirty = savedSettingsSnap !== '' && buildSettingsSnap(settings) !== savedSettingsSnap;
  const proxyDirty = savedProxySnap !== '' && buildProxySnap(proxy) !== savedProxySnap;

  useEffect(() => {
    if (!settingsDirty && !proxyDirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const beforeNavigate = (event: Event) => {
      const navigation = event as CustomEvent<BeforeNavigateDetail>;
      navigation.detail.waitUntil(
        askConfirm('当前系统设置尚未保存，确认放弃更改并离开吗？', {
          title: '未保存的系统设置',
          confirmText: '放弃更改',
        }),
      );
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('nomad-deck:before-navigate', beforeNavigate);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('nomad-deck:before-navigate', beforeNavigate);
    };
  }, [settingsDirty, proxyDirty, askConfirm]);

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setSavingSettings(true);
    try {
      const payload: Record<string, any> = {};
      for (const m of settingMeta) {
        if (!(m.key in settings)) continue;
        if (m.key === 'release.cni_checksums') {
          const raw = String(settings[m.key] || '').trim() || '{}';
          try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('格式应为 JSON 对象');
            }
            payload[m.key] = parsed;
          } catch (parseErr: any) {
            throw new Error(`自定义 CNI 插件校验和 JSON 无效：${parseErr?.message || '语法错误'}`);
          }
        } else {
          payload[m.key] = settings[m.key];
        }
      }
      const res = await apiPut('/api/v1/settings', payload);
      const next = { ...(res.settings || {}) };
      if (typeof next['release.cni_checksums'] !== 'string') {
        next['release.cni_checksums'] = JSON.stringify(next['release.cni_checksums'] || {}, null, 2);
      }
      setSettings(next);
      setSavedSettingsSnap(buildSettingsSnap(next));
      toast.success(res.restart_required ? '设置已保存（部分参数需重启控制面生效）' : '系统设置已保存');
    } catch (ex: any) {
      toast.error(ex?.message || '保存系统设置失败');
    } finally {
      setSavingSettings(false);
    }
  };

  /** 粘贴 http://user:pass@host:port 或 socks5://… 时自动拆分填入协议/主机/端口/认证字段。 */
  const pasteProxyURL = (text: string): boolean => {
    try {
      const url = new URL(text.trim());
      if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) return false;
      const proto = url.protocol === 'https:' ? 'https' : url.protocol === 'http:' ? 'http' : 'socks5';
      const defaultPort = proto === 'socks5' ? 1080 : proto === 'https' ? 443 : 8080;
      setProxy((prev: any) => ({
        ...prev,
        mode: 'custom',
        type: proto,
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: Number(url.port) || defaultPort,
        username: decodeURIComponent(url.username),
        password: url.password ? decodeURIComponent(url.password) : prev.password,
      }));
      toast.success('已按代理 URL 自动拆分填入各字段');
      return true;
    } catch {
      return false;
    }
  };

  const proxyPayload = (enabled = true) => ({
    enabled,
    type: proxy.type,
    host: proxy.host,
    port: Number(proxy.port),
    username: proxy.username,
    password: proxy.password === '' ? undefined : proxy.password,
    no_proxy: proxy.no_proxy
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean),
  });

  const switchProxyMode = (nextMode: 'direct' | 'custom') => {
    setProxy((prev: any) => {
      if (
        nextMode === 'custom' &&
        !prev.configured &&
        !prev.use_for_nomad &&
        !prev.use_for_vault &&
        !prev.use_for_docker_install &&
        !prev.use_for_docker_pull &&
        !prev.use_for_self_update
      ) {
        return {
          ...prev,
          mode: nextMode,
          use_for_nomad: true,
          use_for_vault: true,
          use_for_docker_install: true,
          use_for_docker_pull: false,
          use_for_self_update: true,
        };
      }
      return { ...prev, mode: nextMode };
    });
  };

  const disabledProxySwitches = {
    'proxy.use_for_releases': false,
    'proxy.use_for_nomad': false,
    'proxy.use_for_vault': false,
    'proxy.use_for_docker_install': false,
    'proxy.use_for_docker_pull': false,
    'proxy.use_for_self_update': false,
  };

  const saveProxy = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setSavingProxy(true);
    try {
      const prev = savedProxySnap ? JSON.parse(savedProxySnap) : {};
      const prevDockerPull = Boolean(prev.use_for_docker_pull);
      const proxyEndpointChanged =
        prev.mode !== proxy.mode ||
        prev.type !== proxy.type ||
        prev.host !== (proxy.host || '').trim() ||
        prev.port !== Number(proxy.port) ||
        prev.username !== (proxy.username || '').trim() ||
        Boolean(proxy.password) ||
        prev.no_proxy !== (proxy.no_proxy || '').trim();

      if (proxy.mode === 'direct') {
        await apiPut('/api/v1/settings/proxy', { enabled: false });
        await apiPut('/api/v1/settings', disabledProxySwitches);
        let syncMsg = '';
        if (prevDockerPull) {
          const syncRes = await apiPost('/api/v1/settings/proxy/sync-docker', {});
          if (syncRes.count > 0) syncMsg = `，已同步更新 ${syncRes.count} 台主机 Docker 镜像代理`;
        }
        toast.success(`已切换为直连模式（已关闭下载代理）${syncMsg}`);
      } else {
        const useDockerPull = proxy.type !== 'socks5' && Boolean(proxy.use_for_docker_pull);
        await apiPut('/api/v1/settings/proxy', proxyPayload(true));
        await apiPut('/api/v1/settings', {
          'proxy.use_for_releases': Boolean(proxy.use_for_nomad || proxy.use_for_vault || proxy.use_for_docker_install),
          'proxy.use_for_nomad': Boolean(proxy.use_for_nomad),
          'proxy.use_for_vault': Boolean(proxy.use_for_vault),
          'proxy.use_for_docker_install': Boolean(proxy.use_for_docker_install),
          'proxy.use_for_docker_pull': useDockerPull,
          'proxy.use_for_self_update': Boolean(proxy.use_for_self_update),
        });
        let syncMsg = '';
        if (useDockerPull !== prevDockerPull || (useDockerPull && proxyEndpointChanged)) {
          const syncRes = await apiPost('/api/v1/settings/proxy/sync-docker', {});
          if (syncRes.count > 0) syncMsg = `，已向 ${syncRes.count} 台 Docker 主机下发镜像代理配置`;
        }
        toast.success(`下载代理与适用范围已保存${syncMsg}`);
      }
      await load();
    } catch (ex: any) {
      toast.error(ex?.message || '保存代理失败');
    } finally {
      setSavingProxy(false);
    }
  };

  const clearProxy = async () => {
    if (
      !(await askConfirm('确认清空当前下载代理地址与凭据吗？', {
        title: '清空下载代理',
        confirmText: '确认清空',
        danger: true,
      }))
    ) {
      return;
    }
    setErr('');
    setClearingProxy(true);
    try {
      const prev = savedProxySnap ? JSON.parse(savedProxySnap) : {};
      const prevDockerPull = Boolean(prev.use_for_docker_pull);
      await apiPut('/api/v1/settings/proxy', { enabled: false });
      await apiPut('/api/v1/settings', disabledProxySwitches);
      if (prevDockerPull) {
        await apiPost('/api/v1/settings/proxy/sync-docker', {});
      }
      toast.success('已清空下载代理配置');
      await load();
    } catch (ex: any) {
      toast.error(ex?.message || '清空代理失败');
    } finally {
      setClearingProxy(false);
    }
  };

  const testProxy = async () => {
    setErr('');
    setTestingProxy(true);
    try {
      const res = await apiPost('/api/v1/settings/proxy/test', proxyPayload(true));
      const rep = res.report || {};
      const results = (rep.results || []) as Array<{
        name: string;
        ok: boolean;
        status_code?: number;
        latency_ms?: number;
        error?: string;
      }>;
      const okCount = results.filter((r) => r.ok).length;
      const details = results.map((r) =>
        r.ok
          ? `✓ ${r.name} · HTTP ${r.status_code ?? 200}${typeof r.latency_ms === 'number' ? ` (${r.latency_ms}ms)` : ''}`
          : `✕ ${r.name} · ${r.error || '连接失败'}`,
      );
      if (rep.exit_ip) {
        details.unshift(`出口 IP：${rep.exit_ip}`);
      }
      const title =
        results.length === 0
          ? '代理测试完成'
          : okCount === results.length
          ? `代理测试通过 (${okCount}/${results.length})`
          : okCount > 0
          ? `代理部分连通 (${okCount}/${results.length})`
          : `代理测试失败 (0/${results.length})`;
      const tone: 'ok' | 'partial' | 'fail' =
        okCount === results.length && results.length > 0 ? 'ok' : okCount > 0 ? 'partial' : 'fail';
      setProxyTestReport({
        title,
        tone,
        exit_ip: rep.exit_ip,
        results,
      });
      if (tone === 'ok') {
        toast.success(title);
      } else if (tone === 'partial') {
        toast.info(title);
      } else {
        toast.error(title, { details });
      }
    } catch (ex: any) {
      setProxyTestReport({
        title: ex?.message || '代理测试失败',
        tone: 'fail',
        results: [],
      });
      toast.error(ex?.message || '代理测试失败');
    } finally {
      setTestingProxy(false);
    }
  };

  const activeGroupTitle =
    tab === 'general' ? '基础与调度参数' : tab === 'releases' ? '版本与分发源参数' : '集群与快照参数';
  const visibleMeta = settingMeta.filter((m) => m.group === tab);

  return (
    <div className="space-y-5">
      <PageHeader
        title="系统设置"
        subtitle="全局调度参数、官方发行版下载源、下载代理与数据库主密钥轮换"
        actions={
          <Button onClick={() => void load()} loading={loading}>
            {!loading && <RefreshCw className="h-4 w-4" />}
            <span>刷新</span>
          </Button>
        }
      />

      <SectionTabs
        tabs={[
          { id: 'general', label: '基础与调度' },
          { id: 'releases', label: '版本与分发源', title: '控制 Nomad / Vault / Docker 默认版本、镜像源与下载限速' },
          { id: 'clusters', label: '集群与快照', title: '管理 Raft 快照目录与保留数、证书告警阈值及终端超时' },
          {
            id: 'proxy',
            label: '下载代理',
            title: '配置控制面访问 HashiCorp / GitHub / Release 下载时使用的代理与默认生效范围',
            badge: proxy.configured ? '已启用' : '直连',
          },
          ...(isAdmin
            ? [
                {
                  id: 'security',
                  label: '主密钥与安全',
                  title: '用于加密数据库中 SSH 私钥、Vault 解封密钥和灾备凭据的主密钥状态与轮换',
                },
              ]
            : []),
        ]}
        active={tab}
        onChange={(id) => setTab(id as typeof tab)}
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {loading ? (
        <LoadingState label="正在加载系统设置..." />
      ) : (
        <>
          {(tab === 'general' || tab === 'releases' || tab === 'clusters') && (
            <Card title={activeGroupTitle}>
              <form onSubmit={saveSettings} className="space-y-5">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {visibleMeta.map((m) => {
                    const labelNode = m.tip ? <TermLabel term={m.label} tip={m.tip} /> : m.label;
                    if (m.type === 'bool') {
                      return (
                        <label key={m.key} className="flex items-center gap-2.5 pt-5 text-xs font-medium text-slate-700 dark:text-slate-200">
                          <input
                            type="checkbox"
                            disabled={!isAdmin}
                            checked={Boolean(settings[m.key])}
                            onChange={(e) => setSettings({ ...settings, [m.key]: e.target.checked })}
                          />
                          <span>{labelNode}</span>
                        </label>
                      );
                    }
                    if (m.type === 'select') {
                      return (
                        <Select
                          key={m.key}
                          label={labelNode}
                          disabled={!isAdmin}
                          value={settings[m.key] ?? m.options?.[0]}
                          onChange={(e) => setSettings({ ...settings, [m.key]: e.target.value })}
                        >
                          {m.options?.map((o) => (
                            <option key={o} value={o}>{o}</option>
                          ))}
                        </Select>
                      );
                    }
                    if (m.type === 'textarea') {
                      return (
                        <label key={m.key} className="block space-y-1.5 sm:col-span-2">
                          <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">{labelNode}</span>
                          <textarea
                            rows={4}
                            disabled={!isAdmin}
                            value={settings[m.key] ?? '{}'}
                            onChange={(e) => setSettings({ ...settings, [m.key]: e.target.value })}
                            className="w-full rounded-lg border border-[#dce3ee] bg-white px-3 py-2 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                          />
                        </label>
                      );
                    }
                    return (
                      <Input
                        key={m.key}
                        label={labelNode}
                        disabled={!isAdmin}
                        type={m.type === 'number' ? 'number' : 'text'}
                        value={settings[m.key] ?? ''}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            [m.key]: m.type === 'number' ? Number(e.target.value) : e.target.value,
                          })
                        }
                      />
                    );
                  })}
                </div>
                {isAdmin && (
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-slate-200 dark:border-slate-800">
                    <span role="status" className={`text-xs ${settingsDirty ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`}>
                      {settingsDirty ? '当前表单有未保存的更改' : '已与服务器配置同步'}
                    </span>
                    <Button type="submit" variant="primary" loading={savingSettings} disabled={!settingsDirty}>
                      {savingSettings ? '保存中...' : settingsDirty ? '保存系统设置' : '已保存'}
                    </Button>
                  </div>
                )}
              </form>
            </Card>
          )}

          {tab === 'proxy' && (
            <Card
              title="下载代理（HTTP / HTTPS / SOCKS5）"
              actions={<StatusBadge value={proxy.configured ? 'enabled' : 'disabled'} label={proxy.configured ? '已启用自定义代理' : '直连'} />}
            >
              <form onSubmit={saveProxy} className="space-y-6">
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  集中控制 Nomad 集群、Vault 集群、Docker 安装/升级及镜像拉取、控制面 GitHub 自更新与版本检查是否走系统代理，保存后立即生效。
                </p>

                <div className="space-y-2">
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">出站方式</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="button"
                      disabled={!isAdmin}
                      onClick={() => switchProxyMode('direct')}
                      className={`text-left rounded-xl border p-3.5 transition ${
                        proxy.mode === 'direct'
                          ? 'border-indigo-500 bg-indigo-50/70 dark:border-indigo-400 dark:bg-indigo-500/15'
                          : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">直连网络</span>
                        <span className={`h-2.5 w-2.5 rounded-full ${proxy.mode === 'direct' ? 'bg-indigo-600 dark:bg-indigo-400' : 'bg-slate-200 dark:bg-slate-700'}`} />
                      </div>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">控制面直接访问官方下载源与 GitHub，适合出网畅通的环境。</p>
                    </button>
                    <button
                      type="button"
                      disabled={!isAdmin}
                      onClick={() => switchProxyMode('custom')}
                      className={`text-left rounded-xl border p-3.5 transition ${
                        proxy.mode === 'custom'
                          ? 'border-indigo-500 bg-indigo-50/70 dark:border-indigo-400 dark:bg-indigo-500/15'
                          : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">自定义下载代理</span>
                        <span className={`h-2.5 w-2.5 rounded-full ${proxy.mode === 'custom' ? 'bg-indigo-600 dark:bg-indigo-400' : 'bg-slate-200 dark:bg-slate-700'}`} />
                      </div>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">通过 HTTP / HTTPS / SOCKS5 代理出站，可单独测试连通性。</p>
                    </button>
                  </div>
                </div>

                {proxy.mode === 'custom' && (
                  <div className="space-y-5">
                    <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-950/30 p-4 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">1. 代理服务器地址</span>
                        <span className="text-[11px] text-slate-400 dark:text-slate-500">
                          可直接粘贴 <code className="font-mono">http://user:pass@host:port</code> 自动拆分
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-12 gap-3.5 items-end">
                        <div className="sm:col-span-3">
                          <Select
                            label="协议"
                            disabled={!isAdmin}
                            value={proxy.type}
                            onChange={(e) => {
                              const nextType = e.target.value;
                              setProxy({
                                ...proxy,
                                type: nextType,
                                use_for_docker_pull: nextType === 'socks5' ? false : proxy.use_for_docker_pull,
                              });
                            }}
                          >
                            <option value="http">HTTP</option>
                            <option value="https">HTTPS</option>
                            <option value="socks5">SOCKS5</option>
                          </Select>
                        </div>
                        <div className="sm:col-span-6">
                          <Input
                            label="主机地址"
                            required
                            disabled={!isAdmin}
                            placeholder="proxy.example.com 或粘贴完整代理 URL"
                            value={proxy.host}
                            onPaste={(e) => {
                              const text = e.clipboardData?.getData('text') || '';
                              if (pasteProxyURL(text)) e.preventDefault();
                            }}
                            onBlur={(e) => {
                              const val = e.target.value.trim();
                              if (/^(https?|socks5h?):\/\//i.test(val)) pasteProxyURL(val);
                            }}
                            onChange={(e) => setProxy({ ...proxy, host: e.target.value })}
                          />
                        </div>
                        <div className="sm:col-span-3">
                          <Input
                            label="端口"
                            type="number"
                            required
                            disabled={!isAdmin}
                            placeholder="3128"
                            value={proxy.port}
                            onChange={(e) => setProxy({ ...proxy, port: Number(e.target.value) })}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-950/30 p-4 space-y-4">
                      <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">2. 身份认证与直连例外（可选）</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <Input
                          label="用户名"
                          disabled={!isAdmin}
                          placeholder="无需认证可留空"
                          value={proxy.username}
                          onChange={(e) => setProxy({ ...proxy, username: e.target.value })}
                        />
                        <SecretInput
                          label="密码"
                          disabled={!isAdmin}
                          value={proxy.password}
                          hasStoredValue={Boolean(proxy.password_set)}
                          resetKey={proxy.password_set}
                          onChangeValue={(v) => setProxy({ ...proxy, password: v })}
                          onRevealStored={
                            isAdmin
                              ? async () => {
                                  const r = await apiPost('/api/v1/settings/proxy/reveal', {});
                                  return r.password || '';
                                }
                              : undefined
                          }
                        />
                      </div>
                      <Input
                        label={<TermLabel term="直连例外（no_proxy）" tip="不经过代理直连的主机名、IP 或 CIDR，多个值用英文逗号分隔。" />}
                        disabled={!isAdmin}
                        placeholder="localhost,127.0.0.1,10.0.0.0/8,.corp.local"
                        value={proxy.no_proxy}
                        onChange={(e) => setProxy({ ...proxy, no_proxy: e.target.value })}
                      />
                    </div>

                    <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-950/30 p-4 space-y-3">
                      <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">3. 按场景启用下载代理</div>
                      <div className="divide-y divide-slate-200/70 dark:divide-slate-800/80">
                        <div className="flex items-center justify-between gap-4 py-2 first:pt-0">
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-slate-800 dark:text-slate-200">Nomad 集群（部署 / 扩容 / 升级 / CNI 插件）</div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">获取 Nomad 官方版本列表、安装包以及下载 CNI 插件包时使用系统代理</div>
                          </div>
                          <Switch
                            checked={Boolean(proxy.use_for_nomad)}
                            disabled={!isAdmin}
                            onChange={(v) => setProxy({ ...proxy, use_for_nomad: v })}
                            label="Nomad 集群使用系统代理"
                          />
                        </div>
                        <div className="flex items-center justify-between gap-4 py-2">
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-slate-800 dark:text-slate-200">Vault 集群（部署 / 扩容 / 升级 / 版本列表）</div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">获取 Vault 官方版本列表、部署、扩容与滚动升级安装包时使用系统代理</div>
                          </div>
                          <Switch
                            checked={Boolean(proxy.use_for_vault)}
                            disabled={!isAdmin}
                            onChange={(v) => setProxy({ ...proxy, use_for_vault: v })}
                            label="Vault 集群使用系统代理"
                          />
                        </div>
                        <div className="flex items-center justify-between gap-4 py-2">
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-slate-800 dark:text-slate-200">Docker 安装 / 升级（主机与版本列表）</div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">拉取 Docker 官方仓库索引及分发安装包到主机时使用系统代理</div>
                          </div>
                          <Switch
                            checked={Boolean(proxy.use_for_docker_install)}
                            disabled={!isAdmin}
                            onChange={(v) => setProxy({ ...proxy, use_for_docker_install: v })}
                            label="Docker 安装与升级使用系统代理"
                          />
                        </div>
                        <div className="flex items-center justify-between gap-4 py-2">
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-slate-800 dark:text-slate-200">Docker 拉取容器镜像</div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">
                              {proxy.type === 'socks5'
                                ? 'Docker 守护进程镜像拉取仅支持 HTTP / HTTPS 代理，SOCKS5 下不可用'
                                : '为主机 Docker 守护进程默认配置 HTTP(S) 拉取代理（保存后将同步到未单独指定自定义代理的主机）'}
                            </div>
                          </div>
                          <Switch
                            checked={proxy.type !== 'socks5' && Boolean(proxy.use_for_docker_pull)}
                            disabled={!isAdmin || proxy.type === 'socks5'}
                            onChange={(v) => setProxy({ ...proxy, use_for_docker_pull: v })}
                            label="Docker 拉取容器镜像使用系统代理"
                          />
                        </div>
                        <div className="flex items-center justify-between gap-4 py-2 last:pb-0">
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-slate-800 dark:text-slate-200">控制面自更新与版本检查（GitHub）</div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">控制面检测新版本并从 GitHub Release 下载二进制包时使用系统代理</div>
                          </div>
                          <Switch
                            checked={Boolean(proxy.use_for_self_update)}
                            disabled={!isAdmin}
                            onChange={(v) => setProxy({ ...proxy, use_for_self_update: v })}
                            label="控制面自更新使用系统代理"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {proxyTestReport && (
                  <div
                    role="status"
                    className={`rounded-xl border p-4 text-xs space-y-2.5 ${
                      proxyTestReport.tone === 'ok'
                        ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/30 dark:bg-emerald-950/25'
                        : proxyTestReport.tone === 'partial'
                          ? 'border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-950/25'
                          : 'border-rose-200 bg-rose-50/60 dark:border-rose-500/30 dark:bg-rose-950/25'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
                        <span>{proxyTestReport.title}</span>
                        {proxyTestReport.exit_ip && (
                          <span className="rounded-md bg-white/80 px-2 py-0.5 font-mono text-[11px] font-normal text-slate-600 dark:bg-slate-900 dark:text-slate-300">
                            出口 IP：{proxyTestReport.exit_ip}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        aria-label="关闭测试报告"
                        onClick={() => setProxyTestReport(null)}
                        className="rounded p-1 text-slate-400 hover:bg-white/60 hover:text-slate-700 dark:hover:bg-slate-800"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {proxyTestReport.results.length > 0 && (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {proxyTestReport.results.map((r) => (
                          <div
                            key={r.name}
                            className="flex items-center justify-between gap-2 rounded-lg border border-slate-200/80 bg-white/90 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/80"
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              {r.ok ? (
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                              ) : (
                                <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
                              )}
                              <span className="truncate font-medium text-slate-800 dark:text-slate-200">{r.name}</span>
                            </div>
                            <span className="shrink-0 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                              {r.ok
                                ? `HTTP ${r.status_code ?? 200}${typeof r.latency_ms === 'number' ? ` · ${r.latency_ms}ms` : ''}`
                                : r.error || '失败'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {isAdmin && (
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-slate-200 dark:border-slate-800">
                    <span role="status" className={`text-xs ${proxyDirty ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`}>
                      {proxyDirty ? '代理配置有未保存更改' : '已与服务器配置同步'}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      {proxy.configured && (
                        <Button variant="danger-outline" loading={clearingProxy} onClick={() => void clearProxy()}>
                          清空代理
                        </Button>
                      )}
                      {proxy.mode === 'custom' && (
                        <Button type="button" onClick={() => void testProxy()} loading={testingProxy}>
                          {testingProxy ? '测试中...' : '测试代理'}
                        </Button>
                      )}
                      <Button type="submit" variant="primary" loading={savingProxy} disabled={!proxyDirty && proxy.mode !== 'direct'}>
                        {savingProxy ? '保存中...' : '保存代理'}
                      </Button>
                    </div>
                  </div>
                )}
              </form>
            </Card>
          )}

          {tab === 'security' && isAdmin && masterKey && (
            <Card
              title={
                <TermLabel
                  term="主密钥状态与在线轮换"
                  tip="控制面使用主密钥通过 AES-GCM 加密 SSH 私钥、Vault Unseal Key 和灾备密码；轮换会用新密钥重加密库内全部密文与快照签名。"
                />
              }
              actions={
                <Button size="sm" onClick={() => void load()} loading={loading}>
                  {!loading && <RefreshCw className="h-3.5 w-3.5" />}
                  <span>刷新</span>
                </Button>
              }
            >
              <div className="space-y-3 text-xs">
                <div className="flex justify-between items-center py-1 border-b border-slate-100 dark:border-slate-800">
                  <span className="text-slate-500">当前主密钥</span>
                  <span className="font-mono font-medium">
                    {masterKey.primary_key_id} ({masterKey.primary_source})
                  </span>
                </div>
                <div className="flex justify-between items-center py-1 border-b border-slate-100 dark:border-slate-800">
                  <span className="text-slate-500">待轮换新密钥</span>
                  <span className="font-mono">
                    {masterKey.next_key_id ? `${masterKey.next_key_id} (${masterKey.next_source})` : '未加载'}
                  </span>
                </div>
                {masterKey.journal && (
                  <div className="rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200/70 dark:border-slate-800 p-3">
                    轮换进度：<StatusBadge value={masterKey.journal.state} />{' '}
                    <span className="ml-2">
                      重加密记录 {masterKey.journal.progress?.reencrypted_rows || 0} 条 · 快照{' '}
                      {masterKey.journal.progress?.snapshots_done || 0}/{masterKey.journal.progress?.snapshots_total || 0}
                    </span>
                  </div>
                )}
                {masterKey.next_steps && <p className="text-slate-600 dark:text-slate-300 leading-relaxed">{masterKey.next_steps}</p>}
                <Button
                  variant="primary"
                  disabled={!masterKey.rotation_ready || masterKey.running}
                  onClick={() => setShowRotatePw(true)}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  <span>发起主密钥轮换</span>
                </Button>
              </div>
            </Card>
          )}
        </>
      )}

      <PasswordConfirmModal
        open={showRotatePw}
        title="发起主密钥在线轮换"
        onClose={() => setShowRotatePw(false)}
        onConfirm={async (pw) => {
          await apiPost('/api/v1/settings/master-key/rotate', { current_password: pw });
          toast.success('主密钥轮换已启动，请刷新查看进度');
          await load();
        }}
      />
    </div>
  );
}
