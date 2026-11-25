import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  ArchiveRestore,
  ArrowUpCircle,
  Boxes,
  ChevronRight,
  Clock,
  FileCode2,
  LayoutDashboard,
  Link2,
  LogOut,
  Menu,
  Moon,
  ScrollText,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { allowNavigation } from './ConfirmDialog';

const navItems = [
  { to: '/', label: '总览仪表盘', icon: LayoutDashboard, group: 'workspace' },
  { to: '/infra', label: '基础设施', icon: Server, group: 'workspace' },
  { to: '/nomad', label: 'Nomad 集群', icon: Boxes, group: 'workspace' },
  { to: '/vault', label: 'Vault 集群', icon: Shield, group: 'workspace' },
  { to: '/integrations', label: '集群联动', icon: Link2, group: 'workspace' },
  { to: '/jobs', label: 'Nomad Job 中心', icon: FileCode2, group: 'workspace' },
  { to: '/operations', label: '运维任务', icon: Activity, group: 'admin' },
  { to: '/cron', label: '定时任务', icon: Clock, group: 'admin' },
  { to: '/audit', label: '审计日志', icon: ScrollText, group: 'admin' },
  { to: '/migration-backup', label: '迁移与灾备', icon: ArchiveRestore, group: 'admin' },
  { to: '/settings', label: '系统设置', icon: Settings, group: 'admin' },
  { to: '/accounts', label: '账号与会话', icon: Users, group: 'admin' },
  { to: '/version', label: '版本与升级', icon: ArrowUpCircle, group: 'admin' },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, isAdmin, version, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const navigation = useRef<HTMLElement>(null);
  const loc = useLocation();
  const navigate = useNavigate();

  const currentItem = navItems.find((n) => (n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to))) || navItems[0];
  const versionLabel = version && version !== 'dev' && !version.startsWith('v') ? `v${version}` : version || 'dev';

  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () =>
      Array.from(navigation.current?.querySelectorAll<HTMLElement>('button, a[href]') || []).filter(
        (el) => el.getClientRects().length > 0,
      );
    focusable()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
      if (event.key === 'Tab') {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [menuOpen]);

  const handleNavClick = async (event: React.MouseEvent, to: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (loc.pathname === to) {
      setMenuOpen(false);
      return;
    }
    if (!(await allowNavigation())) return;
    setMenuOpen(false);
    navigate(to);
    window.scrollTo({ top: 0 });
  };

  const handleLogout = async () => {
    if (!(await allowNavigation())) return;
    await logout();
  };

  return (
    <div className="min-h-screen bg-[#f5f7fb] dark:bg-[#0b1120] transition-colors">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[80] bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 p-3 rounded-lg shadow-lg"
      >
        跳到主要内容
      </a>

      {menuOpen && (
        <button
          type="button"
          className="fixed inset-0 bg-slate-950/50 backdrop-blur-sm z-30 lg:hidden"
          aria-label="关闭导航菜单"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <aside
        ref={navigation}
        id="app-navigation"
        className={`app-sidebar fixed inset-y-0 left-0 w-64 text-slate-200 flex-col z-40 transition-transform duration-200 ${
          menuOpen ? 'flex translate-x-0' : 'hidden -translate-x-full'
        } lg:flex lg:translate-x-0`}
      >
        <div className="px-6 h-[88px] flex items-center gap-3 shrink-0">
          <div className="w-10 h-10 rounded-xl bg-indigo-500 flex items-center justify-center text-white shadow-lg shadow-indigo-950/30 shrink-0">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-xl text-white tracking-tight leading-none flex items-center gap-2">
              <span>
                NomadDeck<span className="text-indigo-400">.</span>
              </span>
              <a
                href="/version"
                onClick={(e) => void handleNavClick(e, '/version')}
                title={`当前版本 ${versionLabel}（点击查看版本与升级）`}
                className="text-[10px] font-mono font-normal px-1.5 py-0.5 rounded bg-white/10 text-slate-300 hover:bg-indigo-500/40 hover:text-white transition truncate"
              >
                {versionLabel}
              </a>
            </div>
            <div className="text-[11px] text-slate-400 mt-2 tracking-wider truncate">集群运维控制面</div>
          </div>
          <button
            type="button"
            onClick={() => setMenuOpen(false)}
            className="lg:hidden ml-auto p-1 text-slate-400 hover:text-white"
            aria-label="收起菜单"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav aria-label="主导航" className="flex-1 px-4 py-3 overflow-y-auto">
          {navItems.map((item, index) => {
            const Icon = item.icon;
            const isActive = item.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(item.to);
            const showGroup = index === 0 || navItems[index - 1].group !== item.group;
            return (
              <React.Fragment key={item.to}>
                {showGroup && (
                  <div
                    className={`text-[10px] font-medium uppercase text-slate-500 tracking-widest px-3 mb-2.5 ${
                      index === 0 ? 'mt-1' : 'mt-6'
                    }`}
                  >
                    {item.group === 'workspace' ? '集群工作区' : '系统与管理'}
                  </div>
                )}
                <a
                  href={item.to}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={(e) => void handleNavClick(e, item.to)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 mb-1 rounded-xl text-[13px] transition ${
                    isActive
                      ? 'bg-indigo-500 text-white font-medium shadow-md shadow-indigo-950/20'
                      : 'text-slate-400 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                  {isActive && <ChevronRight className="w-3.5 h-3.5 ml-auto opacity-70 shrink-0" />}
                </a>
              </React.Fragment>
            );
          })}
        </nav>

        <div className="mx-4 mb-4 rounded-xl bg-white/[0.04] p-3 flex items-center gap-3 text-xs shrink-0">
          <div className="w-9 h-9 rounded-full bg-indigo-400/15 text-indigo-200 flex items-center justify-center font-semibold text-sm shrink-0">
            {(user?.username || 'A').slice(0, 1).toUpperCase()}
          </div>
          <div className="truncate flex-1">
            <div className="text-white font-medium truncate">{user?.username || '-'}</div>
            <div className="text-slate-400 mt-0.5">{isAdmin ? '系统管理员' : '只读运维'}</div>
          </div>
          <button
            type="button"
            onClick={() => void handleLogout()}
            title="退出登录"
            aria-label="退出登录"
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/10"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </aside>

      <div className="lg:pl-64 min-h-screen flex flex-col">
        <header className="h-[72px] border-b border-slate-200/70 dark:border-slate-800 bg-white/90 dark:bg-slate-900/85 backdrop-blur flex items-center justify-between gap-3 px-5 sm:px-8 sticky top-0 z-20">
          <div className="flex items-center gap-2.5 text-xs text-slate-400 dark:text-slate-500 min-w-0">
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="打开导航菜单"
              aria-controls="app-navigation"
              aria-expanded={menuOpen}
              className="lg:hidden p-2 -ml-2 text-slate-600 dark:text-slate-300 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Menu className="w-5 h-5" />
            </button>
            <span className="hidden sm:inline">控制面</span>
            <ChevronRight className="hidden sm:block w-3 h-3 shrink-0" />
            <span className="font-medium text-sm text-slate-800 dark:text-slate-100 truncate">
              {currentItem.label}
            </span>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {!isAdmin && (
              <span className="rounded-full bg-amber-50 border border-amber-200 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/15 dark:border-amber-500/30 dark:text-amber-300">
                只读模式
              </span>
            )}
            <button
              type="button"
              onClick={toggle}
              title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
              aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
              className="inline-flex items-center justify-center h-8 w-8 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/80 text-slate-600 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white transition"
            >
              {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 flex flex-col">
          <div className="page-content max-w-[1440px] w-full mx-auto px-4 py-6 sm:p-8 flex-1">{children}</div>
          <footer className="max-w-[1440px] w-full mx-auto px-5 sm:px-8 py-5 text-[11px] text-slate-400 dark:text-slate-500 flex flex-wrap gap-2 justify-between border-t border-slate-200/50 dark:border-slate-800/60">
            <span>NomadDeck · {versionLabel}</span>
            <span>SSH/SFTP + HTTP API 双通道集群运维控制面</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
