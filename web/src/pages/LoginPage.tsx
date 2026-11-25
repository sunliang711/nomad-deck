import React, { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Card, ErrorAlert, Input } from '../components/UI';

export function LoginPage() {
  const { needsSetup, refresh } = useAuth();
  const [setupToken, setSetupToken] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const submitSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setInfo('');
    setBusy(true);
    try {
      await apiPost('/api/v1/auth/setup', {
        setup_token: setupToken.trim(),
        username: username.trim(),
        password,
      });
      await apiPost('/api/v1/auth/login', { username: username.trim(), password });
      await refresh();
    } catch (ex: any) {
      setErr(ex?.message || '初始化失败');
    } finally {
      setBusy(false);
    }
  };

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await apiPost('/api/v1/auth/login', { username: username.trim(), password });
      await refresh();
    } catch (ex: any) {
      setErr(ex?.message || '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4 dark:bg-slate-950">
      <div className="w-full max-w-md space-y-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-600 text-white shadow">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">NomadDeck 控制面</h1>
          <p className="text-xs text-slate-500">
            {needsSetup ? '首次启动初始化：创建初始管理员并生成默认 SSH 密钥' : '请登录管理控制台'}
          </p>
        </div>

        <Card>
          <form onSubmit={needsSetup ? submitSetup : submitLogin} className="space-y-4">
            <ErrorAlert message={err} onClose={() => setErr('')} />
            {info && (
              <div className="rounded-md bg-emerald-50 p-3 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                {info}
              </div>
            )}
            {needsSetup && (
              <Input
                label="一次性 Setup Token"
                placeholder="请粘贴终端日志或 data/setup.token 中的令牌"
                required
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
              />
            )}
            <Input
              label="用户名"
              required
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <Input
              label="密码"
              type="password"
              required
              autoComplete={needsSetup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button type="submit" variant="primary" className="w-full" disabled={busy}>
              {busy ? '处理中...' : needsSetup ? '完成初始化并登录' : '登录'}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
