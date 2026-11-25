import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, RotateCw } from 'lucide-react';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, ErrorAlert, Input, PasswordConfirmModal, SecretInput, SectionTabs, Select, TermLabel, statusTone } from '../components/UI';

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
  { key: 'cron.timezone', group: 'general', label: '定时任务时区 (cron.timezone)', tip: '内置和自定义 Cron 任务的触发时区，例如 Asia/Shanghai 或 UTC。', type: 'text' },
  { key: 'ssh.timeout_sec', group: 'general', label: 'SSH 超时秒数', type: 'number' },
  { key: 'ssh.max_concurrency', group: 'general', label: 'SSH 最大并发（需重启）', type: 'number' },
  { key: 'auth.session_ttl_hours', group: 'general', label: '会话绝对有效期（小时）', tip: '单次登录会话最长有效时间，到期必须重新登录。', type: 'number' },
  { key: 'auth.session_idle_minutes', group: 'general', label: '会话空闲超时（分钟）', tip: '连续无操作超过该分钟数后会话自动失效。', type: 'number' },
  { key: 'audit.retention_days', group: 'general', label: '审计日志保留天数', type: 'number' },
  { key: 'ops.retention_days', group: 'general', label: '运维日志保留天数', type: 'number' },

  { key: 'defaults.nomad_version', group: 'releases', label: '默认 Nomad 版本 (支持 latest 或 x.y.z)', tip: '填 latest 可自动解析 HashiCorp 最新稳定版。', type: 'text' },
  { key: 'defaults.vault_version', group: 'releases', label: '默认 Vault 版本 (支持 latest 或 x.y.z)', tip: '填 latest 可自动解析 HashiCorp 最新稳定版。', type: 'text' },
  { key: 'defaults.docker_version', group: 'releases', label: '默认 Docker 版本', type: 'text' },
  { key: 'release.mirror_url', group: 'releases', label: 'HashiCorp 镜像源 URL', tip: '覆盖默认 releases.hashicorp.com 地址，适合内网制品库或反代加速。', type: 'text' },
  { key: 'release.transfer_rate_limit', group: 'releases', label: '分发限速 (bytes/s, 0=不限)', tip: '限制控制面向节点 SFTP 分发安装包时的带宽上限。', type: 'number' },
  { key: 'upgrade.max_minor_skip', group: 'releases', label: '滚动升级允许跨小版本上限', tip: '例如设为 2 时，不允许从 1.7 直接跨 3 个次版本升到 1.10，防止 Raft 状态机不兼容。', type: 'number' },
  { key: 'self_update.channel', group: 'releases', label: '自更新发布通道', type: 'select', options: ['stable', 'prerelease'] },
  { key: 'self_update.backup_retention', group: 'releases', label: '升级前数据库备份保留份数', type: 'number' },
  { key: 'proxy.use_for_releases', group: 'releases', label: '部署/升级默认勾选系统代理', type: 'bool' },
  { key: 'proxy.use_for_self_update', group: 'releases', label: '自更新默认勾选系统代理', type: 'bool' },

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
  const [tab, setTab] = useState<'general' | 'releases' | 'clusters' | 'proxy' | 'security'>('general');
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [proxy, setProxy] = useState<any>({ configured: false, type: 'http', host: '', port: 3128, username: '', password: '', no_proxy: '' });
  const [proxyTest, setProxyTest] = useState<any>(null);
  const [masterKey, setMasterKey] = useState<any>(null);
  const [showRotatePw, setShowRotatePw] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const [sRes, pRes] = await Promise.all([apiGet('/api/v1/settings'), apiGet('/api/v1/settings/proxy')]);
      setSettings(sRes.settings || {});
      const pv = pRes.proxy || {};
      setProxy({
        configured: Boolean(pv.configured),
        type: pv.type || 'http',
        host: pv.host || '',
        port: pv.port || 3128,
        username: pv.username || '',
        password: '',
        password_set: Boolean(pv.password_set),
        no_proxy: (pv.no_proxy || []).join(','),
      });
      if (isAdmin) {
        const mkRes = await apiGet('/api/v1/settings/master-key');
        setMasterKey(mkRes.master_key);
      }
    } catch (ex: any) {
      setErr(ex?.message || '加载系统设置失败');
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const payload: Record<string, any> = {};
      for (const m of settingMeta) {
        if (m.key in settings) payload[m.key] = settings[m.key];
      }
      const res = await apiPut('/api/v1/settings', payload);
      setSettings(res.settings || {});
      setNotice(res.restart_required ? '设置已保存，部分变更需重启控制面后生效。' : '系统设置已保存。');
    } catch (ex: any) {
      setErr(ex?.message || '保存系统设置失败');
    }
  };

  const proxyPayload = (enabled = true) => ({
    enabled,
    type: proxy.type,
    host: proxy.host,
    port: Number(proxy.port),
    username: proxy.username,
    password: proxy.password === '' ? undefined : proxy.password,
    no_proxy: proxy.no_proxy.split(',').map((s: string) => s.trim()).filter(Boolean),
  });

  const saveProxy = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      await apiPut('/api/v1/settings/proxy', proxyPayload(true));
      setNotice('系统代理设置已保存');
      await load();
    } catch (ex: any) {
      setErr(ex?.message || '保存代理失败');
    }
  };

  const clearProxy = async () => {
    setErr('');
    try {
      await apiPut('/api/v1/settings/proxy', { enabled: false });
      setProxyTest(null);
      setNotice('已清空系统代理配置');
      await load();
    } catch (ex: any) {
      setErr(ex?.message || '清空代理失败');
    }
  };

  const testProxy = async () => {
    setErr('');
    try {
      const res = await apiPost('/api/v1/settings/proxy/test', proxyPayload(true));
      setProxyTest(res.report);
    } catch (ex: any) {
      setErr(ex?.message || '代理测试失败');
    }
  };

  const activeGroupTitle =
    tab === 'general' ? '基础与调度参数' : tab === 'releases' ? '版本与分发源参数' : '集群与快照参数';
  const visibleMeta = settingMeta.filter((m) => m.group === tab);

  return (
    <div className="space-y-4">
      <SectionTabs
        tabs={[
          { id: 'general', label: '基础与调度' },
          { id: 'releases', label: '版本与分发源', tip: '控制 Nomad / Vault / Docker 默认版本、镜像源与下载限速。' },
          { id: 'clusters', label: '集群与快照', tip: '管理 Raft 快照目录与保留数、证书告警阈值及终端超时。' },
          { id: 'proxy', label: '网络代理', tip: '控制面下载官方安装包、自更新及节点 Docker 拉取镜像时可选走的代理。' },
          ...(isAdmin ? [{ id: 'security', label: '主密钥与安全', tip: '用于加密数据库中 SSH 私钥、Vault 解封密钥和灾备凭据的主密钥状态与轮换。' }] : []),
        ]}
        active={tab}
        onChange={(id) => setTab(id as typeof tab)}
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />
      {notice && (
        <div className="rounded-md bg-emerald-50 px-3.5 py-2 text-xs text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
          {notice}
        </div>
      )}

      {(tab === 'general' || tab === 'releases' || tab === 'clusters') && (
        <Card title={activeGroupTitle}>
          <form onSubmit={saveSettings} className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {visibleMeta.map((m) => {
                const labelNode = m.tip ? <TermLabel term={m.label} tip={m.tip} /> : m.label;
                if (m.type === 'bool') {
                  return (
                    <label key={m.key} className="flex items-center gap-2 pt-4 text-xs font-medium">
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
                      {m.options?.map((o) => <option key={o} value={o}>{o}</option>)}
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
              <div className="flex justify-end">
                <Button type="submit" variant="primary">保存系统设置</Button>
              </div>
            )}
          </form>
        </Card>
      )}

      {tab === 'proxy' && (
        <Card
          title="系统代理（HTTP / HTTPS / SOCKS5）"
          actions={<Badge tone={proxy.configured ? 'green' : 'neutral'}>{proxy.configured ? '已配置' : '未配置'}</Badge>}
        >
          <form onSubmit={saveProxy} className="space-y-3 text-xs">
            <p className="text-slate-500">
              此处仅保存系统代理地址与凭据；具体操作是否走代理，由部署、升级、自更新页面的“使用系统代理”勾选项及“版本与分发源”的默认勾选决定。
            </p>
            <div className="grid grid-cols-3 gap-2">
              <Select label="类型" disabled={!isAdmin} value={proxy.type} onChange={(e) => setProxy({ ...proxy, type: e.target.value })}>
                <option value="http">http</option>
                <option value="https">https</option>
                <option value="socks5">socks5</option>
              </Select>
              <Input label="主机" required disabled={!isAdmin} value={proxy.host} onChange={(e) => setProxy({ ...proxy, host: e.target.value })} />
              <Input label="端口" type="number" required disabled={!isAdmin} value={proxy.port} onChange={(e) => setProxy({ ...proxy, port: Number(e.target.value) })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input label="用户名" disabled={!isAdmin} value={proxy.username} onChange={(e) => setProxy({ ...proxy, username: e.target.value })} />
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
              label={<TermLabel term="no_proxy（逗号分隔）" tip="不经过代理直连的主机名、IP 或 CIDR，多个值用英文逗号分隔。" />}
              disabled={!isAdmin}
              value={proxy.no_proxy}
              onChange={(e) => setProxy({ ...proxy, no_proxy: e.target.value })}
            />
            {isAdmin && (
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary">保存代理</Button>
                <Button type="button" onClick={() => void testProxy()}>测试连通性</Button>
                {proxy.configured && (
                  <Button type="button" variant="danger" onClick={() => void clearProxy()}>清空代理</Button>
                )}
              </div>
            )}
            {proxyTest && (
              <div className="space-y-1 rounded bg-slate-100 p-3 dark:bg-slate-950">
                <div>出口 IP：<span className="font-mono">{proxyTest.exit_ip || '-'}</span></div>
                {(proxyTest.results || []).map((c: any, i: number) => (
                  <div key={i} className="flex justify-between">
                    <span>{c.name} ({c.url})</span>
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
          title={<TermLabel term="主密钥状态与在线轮换" tip="控制面使用主密钥通过 AES-GCM 加密 SSH 私钥、Vault Unseal Key 和灾备密码；轮换会用新密钥重加密库内全部密文与快照签名。" />}
          actions={
            <Button size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" /> 刷新
            </Button>
          }
        >
          <div className="space-y-3 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-500">当前主密钥</span>
              <span className="font-mono">{masterKey.primary_key_id} ({masterKey.primary_source})</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">待轮换新密钥</span>
              <span className="font-mono">
                {masterKey.next_key_id ? `${masterKey.next_key_id} (${masterKey.next_source})` : '未加载'}
              </span>
            </div>
            {masterKey.journal && (
              <div className="rounded bg-slate-100 p-2.5 dark:bg-slate-950">
                轮换进度：<Badge tone={statusTone(masterKey.journal.state)}>{masterKey.journal.state}</Badge>{' '}
                <span className="ml-2">
                  重加密记录 {masterKey.journal.progress?.reencrypted_rows || 0} 条 · 快照 {masterKey.journal.progress?.snapshots_done || 0}/{masterKey.journal.progress?.snapshots_total || 0}
                </span>
              </div>
            )}
            {masterKey.next_steps && <p className="text-slate-600 dark:text-slate-300">{masterKey.next_steps}</p>}
            <Button
              variant="primary"
              disabled={!masterKey.rotation_ready || masterKey.running}
              onClick={() => setShowRotatePw(true)}
            >
              <RotateCw className="h-3.5 w-3.5" /> 发起主密钥轮换
            </Button>
          </div>
        </Card>
      )}

      <PasswordConfirmModal
        open={showRotatePw}
        title="发起主密钥在线轮换"
        onClose={() => setShowRotatePw(false)}
        onConfirm={async (pw) => {
          await apiPost('/api/v1/settings/master-key/rotate', { current_password: pw });
          setNotice('主密钥轮换已启动，请刷新查看进度');
          await load();
        }}
      />
    </div>
  );
}
