import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, RotateCw } from 'lucide-react';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, ErrorAlert, Input, PasswordConfirmModal, Select, statusTone } from '../components/UI';

const settingMeta: Array<{ key: string; label: string; type: 'number' | 'text' | 'bool' | 'textarea' | 'select'; options?: string[] }> = [
  { key: 'cron.timezone', label: '定时任务时区 (cron.timezone)', type: 'text' },
  { key: 'ssh.timeout_sec', label: 'SSH 超时秒数', type: 'number' },
  { key: 'ssh.max_concurrency', label: 'SSH 最大并发（需重启）', type: 'number' },
  { key: 'release.transfer_rate_limit', label: '分发限速 (bytes/s, 0=不限)', type: 'number' },
  { key: 'release.mirror_url', label: 'HashiCorp 镜像源 URL', type: 'text' },
  { key: 'upgrade.max_minor_skip', label: '滚动升级允许跨小版本上限', type: 'number' },
  { key: 'defaults.nomad_version', label: '默认 Nomad 版本', type: 'text' },
  { key: 'defaults.vault_version', label: '默认 Vault 版本', type: 'text' },
  { key: 'defaults.docker_version', label: '默认 Docker 版本', type: 'text' },
  { key: 'auth.session_ttl_hours', label: '会话绝对有效期（小时）', type: 'number' },
  { key: 'auth.session_idle_minutes', label: '会话空闲超时（分钟）', type: 'number' },
  { key: 'audit.retention_days', label: '审计日志保留天数', type: 'number' },
  { key: 'ops.retention_days', label: '运维日志保留天数', type: 'number' },
  { key: 'snapshot.retention_count', label: '定时快照默认保留份数', type: 'number' },
  { key: 'snapshot.dir', label: '快照存储目录（留空为默认）', type: 'text' },
  { key: 'cert.alert_days', label: '证书到期预警天数', type: 'number' },
  { key: 'nomad.stats_interval_seconds', label: 'Nomad 资源采样间隔（秒）', type: 'number' },
  { key: 'nomad.exec_idle_minutes', label: '终端空闲超时（分钟）', type: 'number' },
  { key: 'nomad.exec_max_minutes', label: '终端最长运行时间（分钟）', type: 'number' },
  { key: 'observability.grafana_url_template', label: 'Grafana 跳转链接模板', type: 'text' },
  { key: 'docker.test_image', label: 'Docker 代理测试镜像', type: 'text' },
  { key: 'self_update.channel', label: '自更新发布通道', type: 'select', options: ['stable', 'prerelease'] },
  { key: 'self_update.backup_retention', label: '升级前数据库备份保留份数', type: 'number' },
  { key: 'proxy.use_for_releases', label: '部署/升级默认勾选系统代理', type: 'bool' },
  { key: 'proxy.use_for_self_update', label: '自更新默认勾选系统代理', type: 'bool' },
];

export function SettingsPage() {
  const { isAdmin } = useAuth();
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

  const proxyPayload = () => ({
    enabled: Boolean(proxy.configured),
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
      await apiPut('/api/v1/settings/proxy', proxyPayload());
      setNotice('系统代理设置已保存');
      await load();
    } catch (ex: any) {
      setErr(ex?.message || '保存代理失败');
    }
  };

  const testProxy = async () => {
    setErr('');
    try {
      const res = await apiPost('/api/v1/settings/proxy/test', proxyPayload());
      setProxyTest(res.report);
    } catch (ex: any) {
      setErr(ex?.message || '代理测试失败');
    }
  };

  return (
    <div className="space-y-5">
      <ErrorAlert message={err} onClose={() => setErr('')} />
      {notice && (
        <div className="rounded-md bg-emerald-50 px-3.5 py-2 text-xs text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
          {notice}
        </div>
      )}

      <Card title="全局系统参数">
        <form onSubmit={saveSettings} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {settingMeta.map((m) => {
              if (m.type === 'bool') {
                return (
                  <label key={m.key} className="flex items-center gap-2 pt-4 text-xs font-medium">
                    <input
                      type="checkbox"
                      disabled={!isAdmin}
                      checked={Boolean(settings[m.key])}
                      onChange={(e) => setSettings({ ...settings, [m.key]: e.target.checked })}
                    />
                    <span>{m.label}</span>
                  </label>
                );
              }
              if (m.type === 'select') {
                return (
                  <Select
                    key={m.key}
                    label={m.label}
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
                  label={m.label}
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

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card title="系统代理（HTTP / HTTPS / SOCKS5）">
          <form onSubmit={saveProxy} className="space-y-3 text-xs">
            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                disabled={!isAdmin}
                checked={Boolean(proxy.configured)}
                onChange={(e) => setProxy({ ...proxy, configured: e.target.checked })}
              />
              <span>启用系统代理</span>
            </label>
            <div className="grid grid-cols-3 gap-2">
              <Select label="类型" disabled={!isAdmin} value={proxy.type} onChange={(e) => setProxy({ ...proxy, type: e.target.value })}>
                <option value="http">http</option>
                <option value="https">https</option>
                <option value="socks5">socks5</option>
              </Select>
              <Input label="主机" disabled={!isAdmin} value={proxy.host} onChange={(e) => setProxy({ ...proxy, host: e.target.value })} />
              <Input label="端口" type="number" disabled={!isAdmin} value={proxy.port} onChange={(e) => setProxy({ ...proxy, port: Number(e.target.value) })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input label="用户名" disabled={!isAdmin} value={proxy.username} onChange={(e) => setProxy({ ...proxy, username: e.target.value })} />
              <Input
                label={proxy.password_set ? '密码（已设置，留空不变）' : '密码'}
                type="password"
                disabled={!isAdmin}
                value={proxy.password}
                onChange={(e) => setProxy({ ...proxy, password: e.target.value })}
              />
            </div>
            <Input label="no_proxy（逗号分隔）" disabled={!isAdmin} value={proxy.no_proxy} onChange={(e) => setProxy({ ...proxy, no_proxy: e.target.value })} />
            {isAdmin && (
              <div className="flex gap-2">
                <Button type="submit" variant="primary">保存代理</Button>
                <Button type="button" onClick={() => void testProxy()}>测试连通性</Button>
              </div>
            )}
            {proxyTest && (
              <div className="space-y-1 rounded bg-slate-100 p-3 dark:bg-slate-950">
                <div>出口 IP：<span className="font-mono">{proxyTest.exit_ip || '-'}</span></div>
                {(proxyTest.checks || []).map((c: any, i: number) => (
                  <div key={i} className="flex justify-between">
                    <span>{c.name} ({c.url})</span>
                    <Badge tone={c.ok ? 'green' : 'red'}>{c.ok ? `OK (${c.status_code})` : c.error}</Badge>
                  </div>
                ))}
              </div>
            )}
          </form>
        </Card>

        {isAdmin && masterKey && (
          <Card
            title="主密钥状态与在线轮换"
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
      </div>

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
