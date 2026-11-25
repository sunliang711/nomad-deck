import React, { useId, useState } from 'react';
import { ArrowRight, Boxes, Eye, EyeOff, Loader2, LockKeyhole, Moon, Sun } from 'lucide-react';
import { apiPost } from '../lib/api';
import { useAuth, type AuthUser } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { Modal } from '../components/UI';
import { useToast } from '../components/Toast';

function ThemeToggleButton() {
  const { theme, toggle } = useTheme();
  const label = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      className="inline-flex items-center justify-center h-8 w-8 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/80 text-slate-600 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white transition"
    >
      {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
    </button>
  );
}

export function LoginPage() {
  const { needsSetup, version, refresh } = useAuth();
  const versionLabel = version && version !== 'dev' && !version.startsWith('v') ? `v${version}` : version || 'dev';
  const [setupToken, setSetupToken] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (needsSetup && password !== confirm) {
      setErr('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    try {
      if (needsSetup) {
        await apiPost(
          '/api/v1/auth/setup',
          {
            setup_token: setupToken.trim(),
            username: username.trim(),
            password,
          },
          { skipAuthPrompt: true },
        );
      }
      await apiPost(
        '/api/v1/auth/login',
        { username: username.trim(), password },
        { skipAuthPrompt: true },
      );
      await refresh();
    } catch (ex: any) {
      setErr(ex?.message || (needsSetup ? '初始化失败' : '登录失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-[#f7f9fc] dark:bg-[#0b1120] transition-colors">
      <div className="hidden lg:flex flex-col justify-between relative overflow-hidden bg-[#111b34] dark:bg-[#090e1a] border-r border-transparent dark:border-slate-800 text-white p-12 xl:p-16">
        <div className="absolute -right-32 top-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="flex items-center gap-3 font-semibold text-2xl">
          <img src="/favicon.svg" alt="NomadDeck" width={40} height={40} className="w-10 h-10 shrink-0" />
          <span>
            NomadDeck<span className="text-indigo-400">.</span>
          </span>
        </div>

        <div className="relative py-16 max-w-lg">
          <div className="w-16 h-16 bg-indigo-400/10 border border-indigo-400/20 rounded-2xl grid place-items-center mb-8">
            <Boxes className="w-8 h-8 text-indigo-300" />
          </div>
          <div className="text-[40px] xl:text-5xl font-semibold leading-tight tracking-tight">
            Nomad 与 Vault
            <br />
            <span className="text-indigo-300">统一集群控制面</span>
          </div>
          <p className="text-slate-400 text-sm leading-7 mt-6">
            基于纯 Go SSH/SFTP 与官方 HTTP API 的双通道架构，集中编排集群部署、滚动升级、mTLS 证书轮换、Workload Identity 联动与可视化 Job 调度。
          </p>
          <div className="flex flex-wrap gap-4 text-xs text-slate-300 mt-8">
            <span>SSH 无代理编排</span>
            <span className="text-slate-600">/</span>
            <span>Vault 托管与自动解封</span>
            <span className="text-slate-600">/</span>
            <span>Raft 快照与加密灾备</span>
          </div>
        </div>

        <div className="text-xs text-slate-500">
          NomadDeck Control Plane · <span className="font-mono">{versionLabel}</span>
        </div>
      </div>

      <div className="relative flex flex-col items-center justify-center p-6 sm:p-12">
        <div className="absolute top-5 right-5 sm:top-6 sm:right-6">
          <ThemeToggleButton />
        </div>

        <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-xl shadow-slate-200/30 dark:shadow-black/40 p-6 sm:p-9">
          <div className="flex items-center gap-3 mb-6">
            <img src="/favicon.svg" alt="NomadDeck" width={40} height={40} className="w-10 h-10 shrink-0" />
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
                {needsSetup ? '首次初始化配置' : '欢迎回来'}
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {needsSetup ? '创建初始管理员并生成默认集群 SSH 密钥' : '请登录 NomadDeck 管理控制面'}
              </p>
            </div>
          </div>

          {err && (
            <div
              role="alert"
              className="mb-4 p-3 rounded-lg bg-rose-50 dark:bg-rose-500/15 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 text-sm"
            >
              {err}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {needsSetup && (
              <div>
                <label
                  htmlFor="auth-setup-token"
                  className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  一次性 Setup Token
                </label>
                <input
                  id="auth-setup-token"
                  autoFocus
                  type="text"
                  required
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  placeholder="请粘贴终端日志或 data/setup.token 中的令牌"
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            )}

            <div>
              <label
                htmlFor="auth-username"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                用户名
              </label>
              <input
                id="auth-username"
                autoComplete="username"
                autoFocus={!needsSetup}
                type="text"
                required
                minLength={3}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label
                htmlFor="auth-password"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                密码{needsSetup ? '（至少 10 位）' : ''}
              </label>
              <div className="relative">
                <input
                  id="auth-password"
                  autoComplete={needsSetup ? 'new-password' : 'current-password'}
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={needsSetup ? 10 : 8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••"
                  className="w-full pl-3 pr-11 py-2 border border-slate-300 dark:border-slate-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  type="button"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {needsSetup && (
              <div>
                <label
                  htmlFor="auth-confirm"
                  className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  确认密码
                </label>
                <input
                  id="auth-confirm"
                  autoComplete="new-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={10}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="••••••••••"
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full flex justify-center items-center gap-2 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{busy ? '正在验证...' : needsSetup ? '完成初始化并登录' : '登录控制台'}</span>
              {!busy && <ArrowRight className="w-4 h-4" />}
            </button>
          </form>

          {!needsSetup && (
            <details className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
              <summary className="cursor-pointer select-none hover:text-indigo-600 dark:hover:text-indigo-400 font-medium">
                忘记管理员密码？
              </summary>
              <p className="mt-2 leading-5 text-slate-500 dark:text-slate-400">
                可在控制面宿主机执行本机运维命令重置密码：
                <code className="block mt-1.5 rounded bg-slate-100 dark:bg-slate-800 px-2 py-1 font-mono text-[11px] text-slate-700 dark:text-slate-200">
                  nomad-deck reset-password --username admin
                </code>
              </p>
            </details>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500 mt-6">
          <LockKeyhole className="w-3.5 h-3.5" />
          <span>HTTPS 会话凭证与主密钥信封加密保护</span>
        </div>
      </div>
    </div>
  );
}

export function SessionExpiredModal() {
  const { user, completeReauth, abortReauth } = useAuth();
  const toast = useToast();
  const descriptionId = useId();
  const [username, setUsername] = useState(user?.username || '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiPost<{ user: AuthUser; csrf_token: string }>(
        '/api/v1/auth/login',
        { username: username.trim(), password },
        { skipAuthPrompt: true },
      );
      toast.success('会话已恢复，可继续操作');
      completeReauth(res.user, res.csrf_token);
    } catch (err: any) {
      setError(err?.message || '重新登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open
      title="登录会话已过期"
      onClose={() => {}}
      busy={loading}
      dismissible={false}
      size="md"
      backdropClassName="!z-[70]"
    >
      <div className="space-y-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 shrink-0 rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400 grid place-items-center">
            <LockKeyhole aria-hidden="true" className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">请重新验证身份</h2>
            <p id={descriptionId} className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              当前登录会话已过期或被注销。重新登录后将保留当前页面草稿并自动续做请求。
            </p>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="p-3 rounded-lg bg-rose-50 dark:bg-rose-500/15 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 text-sm"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="reauth-username"
              className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              用户名
            </label>
            <input
              id="reauth-username"
              autoComplete="username"
              data-autofocus={!user?.username ? true : undefined}
              type="text"
              required
              minLength={3}
              disabled={loading}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label
              htmlFor="reauth-password"
              className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              密码
            </label>
            <div className="relative">
              <input
                id="reauth-password"
                autoComplete="current-password"
                data-autofocus={user?.username ? true : undefined}
                type={showPassword ? 'text' : 'password'}
                required
                minLength={8}
                disabled={loading}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full pl-3 pr-11 py-2 border border-slate-300 dark:border-slate-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                type="button"
                disabled={loading}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-1">
            <button
              type="button"
              disabled={loading}
              onClick={abortReauth}
              className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              返回登录页
            </button>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{loading ? '验证中...' : '重新登录'}</span>
              {!loading && <ArrowRight className="w-4 h-4" />}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
