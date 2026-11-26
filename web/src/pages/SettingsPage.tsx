import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, RotateCw } from 'lucide-react';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { useConfirm, type BeforeNavigateDetail } from '../components/ConfirmDialog';
import {
  Badge,
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

  const [tab, setTab] = useState<'general' | 'releases' | 'clusters' | 'proxy' | 'security'>('general');
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
    use_for_releases: false,
    use_for_self_update: false,
  });
  const [savedProxySnap, setSavedProxySnap] = useState('');
  const [proxyTest, setProxyTest] = useState<any>(null);
  const [masterKey, setMasterKey] = useState<any>(null);
  const [showRotatePw, setShowRotatePw] = useState(false);
  const [err, setErr] = useState('');

  const buildSettingsSnap = (obj: Record<string, any>) => {
    const out: Record<string, any> = {};
    for (const m of settingMeta) {
      out[m.key] = obj[m.key] ?? '';
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
      use_for_releases: Boolean(p.use_for_releases),
      use_for_self_update: Boolean(p.use_for_self_update),
    });

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const [sRes, pRes] = await Promise.all([apiGet('/api/v1/settings'), apiGet('/api/v1/settings/proxy')]);
      const nextSettings = sRes.settings || {};
      setSettings(nextSettings);
      setSavedSettingsSnap(buildSettingsSnap(nextSettings));

      const pv = pRes.proxy || {};
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
        use_for_releases: Boolean(nextSettings['proxy.use_for_releases']),
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
        if (m.key in settings) payload[m.key] = settings[m.key];
      }
      const res = await apiPut('/api/v1/settings', payload);
      const next = res.settings || {};
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
      if (nextMode === 'custom' && !prev.configured && !prev.use_for_releases && !prev.use_for_self_update) {
        return { ...prev, mode: nextMode, use_for_releases: true, use_for_self_update: true };
      }
      return { ...prev, mode: nextMode };
    });
  };

  const saveProxy = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setSavingProxy(true);
    try {
      if (proxy.mode === 'direct') {
        await Promise.all([
          apiPut('/api/v1/settings/proxy', { enabled: false }),
          apiPut('/api/v1/settings', {
            'proxy.use_for_releases': false,
            'proxy.use_for_self_update': false,
          }),
        ]);
        setProxyTest(null);
        toast.success('已切换为直连模式（已关闭下载代理）');
      } else {
        await Promise.all([
          apiPut('/api/v1/settings/proxy', proxyPayload(true)),
          apiPut('/api/v1/settings', {
            'proxy.use_for_releases': Boolean(proxy.use_for_releases),
            'proxy.use_for_self_update': Boolean(proxy.use_for_self_update),
          }),
        ]);
        toast.success('下载代理与默认使用策略已保存');
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
      await Promise.all([
        apiPut('/api/v1/settings/proxy', { enabled: false }),
        apiPut('/api/v1/settings', {
          'proxy.use_for_releases': false,
          'proxy.use_for_self_update': false,
        }),
      ]);
      setProxyTest(null);
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
      setProxyTest(res.report);
    } catch (ex: any) {
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
            <RefreshCw className="h-4 w-4" />
            <span>刷新</span>
          </Button>
        }
      />

      <SectionTabs
        tabs={[
          { id: 'general', label: '基础与调度' },
          { id: 'releases', label: '版本与分发源', tip: '控制 Nomad / Vault / Docker 默认版本、镜像源与下载限速。' },
          { id: 'clusters', label: '集群与快照', tip: '管理 Raft 快照目录与保留数、证书告警阈值及终端超时。' },
          {
            id: 'proxy',
            label: '下载代理',
            tip: '配置控制面访问 HashiCorp / GitHub / Release 下载时使用的代理与默认生效范围。',
            badge: proxy.configured ? '已启用' : '直连',
          },
          ...(isAdmin
            ? [
                {
                  id: 'security',
                  label: '主密钥与安全',
                  tip: '用于加密数据库中 SSH 私钥、Vault 解封密钥和灾备凭据的主密钥状态与轮换。',
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
              <form onSubmit={saveSettings} className="space-y-5 max-w-4xl">
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
              <form onSubmit={saveProxy} className="space-y-5 text-xs">
                <p className="text-slate-500 dark:text-slate-400 leading-relaxed">
                  作用于控制面拉取 Nomad / Vault 官方安装包、控制面 GitHub Release 自更新以及版本检查请求，保存后立即生效。
                </p>

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">出站模式</label>
                  <div className="inline-flex rounded-lg border border-slate-300 dark:border-slate-700 overflow-hidden bg-slate-50 dark:bg-slate-800">
                    <button
                      type="button"
                      disabled={!isAdmin}
                      onClick={() => switchProxyMode('direct')}
                      className={`px-4 py-2 text-xs font-medium transition border-r border-slate-300 dark:border-slate-700 ${
                        proxy.mode === 'direct'
                          ? 'bg-indigo-600 text-white'
                          : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      直连
                    </button>
                    <button
                      type="button"
                      disabled={!isAdmin}
                      onClick={() => switchProxyMode('custom')}
                      className={`px-4 py-2 text-xs font-medium transition ${
                        proxy.mode === 'custom'
                          ? 'bg-indigo-600 text-white'
                          : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      自定义下载代理
                    </button>
                  </div>
                </div>

                {proxy.mode === 'custom' && (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">代理协议</label>
                        <div className="inline-flex rounded-lg border border-slate-300 dark:border-slate-700 overflow-hidden bg-slate-50 dark:bg-slate-800 w-full">
                          {(['http', 'https', 'socks5'] as const).map((proto) => (
                            <button
                              key={proto}
                              type="button"
                              disabled={!isAdmin}
                              onClick={() => setProxy({ ...proxy, type: proto })}
                              className={`flex-1 px-2.5 py-2 text-xs font-medium uppercase transition border-r last:border-r-0 border-slate-300 dark:border-slate-700 ${
                                proxy.type === proto
                                  ? 'bg-indigo-600 text-white'
                                  : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                              }`}
                            >
                              {proto}
                            </button>
                          ))}
                        </div>
                      </div>
                      <Input
                        label="主机（支持直接粘贴 http://user:pass@host:port）"
                        required
                        disabled={!isAdmin}
                        placeholder="proxy.example.com"
                        value={proxy.host}
                        onPaste={(e) => {
                          const text = e.clipboardData?.getData('text') || '';
                          if (pasteProxyURL(text)) e.preventDefault();
                        }}
                        onChange={(e) => setProxy({ ...proxy, host: e.target.value })}
                      />
                      <Input
                        label="端口"
                        type="number"
                        required
                        disabled={!isAdmin}
                        value={proxy.port}
                        onChange={(e) => setProxy({ ...proxy, port: Number(e.target.value) })}
                      />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Input
                        label="用户名（可选）"
                        disabled={!isAdmin}
                        value={proxy.username}
                        onChange={(e) => setProxy({ ...proxy, username: e.target.value })}
                      />
                      <SecretInput
                        label="密码（可选）"
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
                      label={<TermLabel term="no_proxy（逗号分隔）" tip="不经过代理直连的主机名、IP 或 CIDR，多个值用英文逗号分隔。" />}
                      disabled={!isAdmin}
                      value={proxy.no_proxy}
                      onChange={(e) => setProxy({ ...proxy, no_proxy: e.target.value })}
                    />

                    <div className="rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/50 p-3.5 space-y-2.5">
                      <div className="font-medium text-slate-700 dark:text-slate-200">默认适用范围</div>
                      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                        <div className="flex items-center gap-2.5">
                          <Switch
                            checked={Boolean(proxy.use_for_releases)}
                            disabled={!isAdmin}
                            onChange={(v) => setProxy({ ...proxy, use_for_releases: v })}
                            label="默认用于集群部署 / 升级 / 版本列表"
                          />
                          <span className="text-slate-600 dark:text-slate-300">默认用于集群部署 / 升级与版本列表</span>
                        </div>
                        <div className="flex items-center gap-2.5">
                          <Switch
                            checked={Boolean(proxy.use_for_self_update)}
                            disabled={!isAdmin}
                            onChange={(v) => setProxy({ ...proxy, use_for_self_update: v })}
                            label="默认用于控制面自更新"
                          />
                          <span className="text-slate-600 dark:text-slate-300">默认用于控制面自更新与检查</span>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {isAdmin && (
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
                    <span role="status" className={`text-xs ${proxyDirty ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`}>
                      {proxyDirty ? '代理配置有未保存更改' : '当前无未保存更改'}
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {proxy.configured && (
                        <Button variant="danger" loading={clearingProxy} onClick={() => void clearProxy()}>
                          清空代理
                        </Button>
                      )}
                      {proxy.mode === 'custom' && (
                        <Button onClick={() => void testProxy()} loading={testingProxy}>
                          {testingProxy ? '测试中...' : '用当前表单测试'}
                        </Button>
                      )}
                      <Button type="submit" variant="primary" loading={savingProxy} disabled={!proxyDirty && proxy.mode !== 'direct'}>
                        {savingProxy ? '保存中...' : '保存代理'}
                      </Button>
                    </div>
                  </div>
                )}

                {proxyTest && (
                  <div className="space-y-1.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200/70 dark:border-slate-800 p-3.5">
                    <div>
                      出口 IP：<span className="font-mono font-medium">{proxyTest.exit_ip || '-'}</span>
                    </div>
                    {(proxyTest.results || []).map((c: any, i: number) => (
                      <div key={i} className="flex items-center justify-between gap-2">
                        <span>
                          {c.name} ({c.url})
                        </span>
                        <Badge tone={c.ok ? 'green' : 'red'}>{c.ok ? `OK (${c.status_code})` : c.error}</Badge>
                      </div>
                    ))}
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
                  <RefreshCw className="h-3.5 w-3.5" />
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
