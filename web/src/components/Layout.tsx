import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  ArchiveRestore,
  ArrowUpCircle,
  Bell,
  Boxes,
  ChevronRight,
  Clock,
  FileCode2,
  LayoutDashboard,
  Link2,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Server,
  Settings,
  Shield,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { useOpsDrawer } from '../lib/opsDrawer';
import { allowNavigation } from './ConfirmDialog';
import { useToast } from './Toast';
import { NotificationDrawer } from './NotificationDrawer';

const navItems = [
  { to: '/', label: '总览仪表盘', icon: LayoutDashboard, group: 'workspace' },
  { to: '/infra', label: '基础设施', icon: Server, group: 'workspace' },
  { to: '/nomad', label: 'Nomad 集群', icon: Boxes, group: 'workspace' },
  { to: '/vault', label: 'Vault 集群', icon: Shield, group: 'workspace' },
  { to: '/integrations', label: '集群联动', icon: Link2, group: 'workspace' },
  { to: '/jobs', label: 'Nomad Job 中心', icon: FileCode2, group: 'workspace' },
  { to: '/cron', label: '定时任务', icon: Clock, group: 'admin' },
  { to: '/audit', label: '审计日志', icon: ScrollText, group: 'admin' },
  { to: '/migration-backup', label: '环境迁移', icon: ArchiveRestore, group: 'admin' },
  { to: '/settings', label: '系统设置', icon: Settings, group: 'admin' },
  { to: '/accounts', label: '账号与会话', icon: Users, group: 'admin' },
  { to: '/version', label: '版本与升级', icon: ArrowUpCircle, group: 'admin' },
];

export function navLabelForPath(path: string): string {
  const item = navItems.find((n) => (n.to === '/' ? path === '/' : path.startsWith(n.to)));
  return item?.label || '控制面';
}

const SIDEBAR_COLLAPSED_KEY = 'nomad-deck.sidebar-collapsed';

function readSidebarCollapsed(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, isAdmin, version, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { runningCount, unreadCount, openTaskList } = useOpsDrawer();
  const { unreadCount: notifUnreadCount, unreadErrorCount: notifUnreadErrorCount, markHistoryRead } = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(readSidebarCollapsed);
  const [notifOpen, setNotifOpen] = useState(false);
  const navigation = useRef<HTMLElement>(null);
  const loc = useLocation();
  const navigate = useNavigate();

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // Ignore storage quota / private mode failures.
      }
      return next;
    });
  };

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
        className={`app-sidebar fixed inset-y-0 left-0 w-64 ${
          collapsed ? 'lg:w-[72px]' : 'lg:w-64'
        } text-slate-200 flex-col z-40 transition-[transform,width] duration-200 ${
          menuOpen ? 'flex translate-x-0' : 'hidden -translate-x-full'
        } lg:flex lg:translate-x-0`}
      >
        <div className={`shrink-0 ${collapsed ? 'px-5 py-5 lg:px-3 lg:py-4' : 'px-5 py-5'}`}>
          <div className={`flex items-center gap-3 ${collapsed ? 'lg:flex-col lg:gap-2.5' : ''}`}>
            <img
              src="/favicon.svg"
              alt="NomadDeck"
              width={40}
              height={40}
              className={`shrink-0 ${collapsed ? 'w-10 h-10 lg:w-9 lg:h-9' : 'w-10 h-10'}`}
            />
            <div className={`min-w-0 flex-1 ${collapsed ? 'lg:hidden' : ''}`}>
              <div className="font-semibold text-lg text-white tracking-tight leading-none">
                NomadDeck<span className="text-indigo-400">.</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-2 tracking-wider">集群运维控制面</div>
            </div>
            <button
              type="button"
              onClick={toggleCollapsed}
              title={collapsed ? '展开左侧导航栏' : '折叠左侧导航栏'}
              aria-label={collapsed ? '展开左侧导航栏' : '折叠左侧导航栏'}
              aria-expanded={!collapsed}
              className="hidden lg:inline-flex shrink-0 items-center justify-center rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
            >
              {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen(false)}
              className="lg:hidden shrink-0 p-1 text-slate-400 hover:text-white"
              aria-label="收起菜单"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <a
            href="/version"
            onClick={(e) => void handleNavClick(e, '/version')}
            title={`当前版本 ${versionLabel}（点击查看版本与升级）`}
            className={`${
              collapsed ? 'lg:hidden ' : ''
            }mt-3 flex items-start gap-2 rounded-lg bg-white/5 px-2.5 py-2 text-xs text-slate-300 hover:bg-indigo-500/20 hover:text-white transition`}
          >
            <span className="shrink-0 text-slate-400">版本</span>
            <span className="min-w-0 break-all font-mono leading-4">{versionLabel}</span>
            <ChevronRight className="ml-auto mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          </a>
        </div>

        <nav aria-label="主导航" className={`flex-1 py-3 overflow-y-auto ${collapsed ? 'px-4 lg:px-2.5' : 'px-4'}`}>
          {navItems.map((item, index) => {
            const Icon = item.icon;
            const isActive = item.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(item.to);
            const showGroup = index === 0 || navItems[index - 1].group !== item.group;
            return (
              <React.Fragment key={item.to}>
                {showGroup && (
                  <>
                    <div
                      className={`text-[10px] font-medium uppercase text-slate-500 tracking-widest px-3 mb-2.5 ${
                        index === 0 ? 'mt-1' : 'mt-6'
                      } ${collapsed ? 'lg:hidden' : ''}`}
                    >
                      {item.group === 'workspace' ? '集群工作区' : '系统与管理'}
                    </div>
                    {collapsed && index > 0 && (
                      <div className="hidden lg:block mx-2 my-3 border-t border-white/10" aria-hidden="true" />
                    )}
                  </>
                )}
                <a
                  href={item.to}
                  title={collapsed ? item.label : undefined}
                  aria-label={item.label}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={(e) => void handleNavClick(e, item.to)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 mb-1 rounded-xl text-[13px] transition ${
                    collapsed ? 'lg:justify-center lg:px-0' : ''
                  } ${
                    isActive
                      ? 'bg-indigo-500 text-white font-medium shadow-md shadow-indigo-950/20'
                      : 'text-slate-400 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <Icon className={`shrink-0 ${collapsed ? 'w-4 h-4 lg:w-[18px] lg:h-[18px]' : 'w-4 h-4'}`} />
                  <span className={`truncate ${collapsed ? 'lg:hidden' : ''}`}>{item.label}</span>
                  {isActive && (
                    <ChevronRight className={`w-3.5 h-3.5 ml-auto opacity-70 shrink-0 ${collapsed ? 'lg:hidden' : ''}`} />
                  )}
                </a>
              </React.Fragment>
            );
          })}
        </nav>

        <div
          className={`rounded-xl bg-white/[0.04] flex items-center text-xs shrink-0 ${
            collapsed ? 'mx-4 mb-4 p-3 gap-3 lg:mx-2.5 lg:p-2 lg:flex-col lg:gap-2' : 'mx-4 mb-4 p-3 gap-3'
          }`}
        >
          <div
            title={`${user?.username || '-'}（${isAdmin ? '系统管理员' : '只读运维'}）`}
            className="w-9 h-9 rounded-full bg-indigo-400/15 text-indigo-200 flex items-center justify-center font-semibold text-sm shrink-0"
          >
            {(user?.username || 'A').slice(0, 1).toUpperCase()}
          </div>
          <div className={`truncate flex-1 ${collapsed ? 'lg:hidden' : ''}`}>
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

      <div className={`min-h-screen flex flex-col transition-[padding] duration-200 ${collapsed ? 'lg:pl-[72px]' : 'lg:pl-64'}`}>
        <header className="h-16 border-b border-slate-200/70 dark:border-slate-800/90 bg-white/90 dark:bg-[#0d1425]/90 backdrop-blur-md flex items-center justify-between gap-3 px-5 sm:px-8 sticky top-0 z-20">
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
              onClick={() => setNotifOpen(true)}
              title={notifUnreadCount > 0 ? `消息历史：${notifUnreadCount} 条未读` : '消息历史（仅本地缓存）'}
              aria-label="消息历史"
              className="relative inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/80 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
            >
              <Bell className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
              <span className="hidden sm:inline">消息</span>
              {notifUnreadCount > 0 && (
                <span
                  className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-white text-[10px] font-semibold ${
                    notifUnreadErrorCount > 0 ? 'bg-rose-600' : 'bg-indigo-600'
                  }`}
                >
                  {notifUnreadCount > 99 ? '99+' : notifUnreadCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={openTaskList}
              title={`后台运维任务：${runningCount} 个运行中，${unreadCount} 个未读异常`}
              aria-label="后台运维任务"
              className="relative inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/80 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
            >
              <Activity className={`w-3.5 h-3.5 ${runningCount > 0 ? 'text-indigo-500 animate-pulse' : 'text-slate-500 dark:text-slate-400'}`} />
              <span className="hidden sm:inline">后台任务</span>
              {runningCount > 0 ? (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-indigo-600 text-white text-[10px] font-semibold">
                  {runningCount}
                </span>
              ) : unreadCount > 0 ? (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-rose-600 text-white text-[10px] font-semibold">
                  {unreadCount}
                </span>
              ) : null}
            </button>
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
            <span>Nomad & Vault 统一集群运维控制面</span>
          </footer>
        </main>
      </div>
      {notifOpen && (
        <NotificationDrawer
          labelForPath={navLabelForPath}
          onClose={() => {
            setNotifOpen(false);
            markHistoryRead();
          }}
        />
      )}
    </div>
  );
}
