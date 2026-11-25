import React, { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Server,
  Boxes,
  Shield,
  Link2,
  FileCode2,
  Activity,
  Clock,
  ScrollText,
  ArchiveRestore,
  Settings,
  Users,
  ArrowUpCircle,
  Sun,
  Moon,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';

const navItems = [
  { to: '/', label: '总览仪表盘', icon: LayoutDashboard },
  { to: '/infra', label: '基础设施', icon: Server },
  { to: '/nomad', label: 'Nomad 集群', icon: Boxes },
  { to: '/vault', label: 'Vault 集群', icon: Shield },
  { to: '/integrations', label: '集群联动', icon: Link2 },
  { to: '/jobs', label: 'Nomad Job 中心', icon: FileCode2 },
  { to: '/operations', label: '运维任务', icon: Activity },
  { to: '/cron', label: '定时任务', icon: Clock },
  { to: '/audit', label: '审计日志', icon: ScrollText },
  { to: '/migration-backup', label: '迁移与灾备', icon: ArchiveRestore },
  { to: '/settings', label: '系统设置', icon: Settings },
  { to: '/accounts', label: '账号与会话', icon: Users },
  { to: '/version', label: '版本与升级', icon: ArrowUpCircle },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, isAdmin, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const loc = useLocation();
  const currentTitle = navItems.find((n) => n.to === loc.pathname)?.label || 'NomadDeck 控制台';

  const navContent = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3.5 dark:border-slate-800">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-600 font-bold text-xs text-white">
          ND
        </div>
        <div>
          <div className="font-bold text-sm tracking-tight">NomadDeck</div>
          <div className="text-[11px] text-slate-500">集群运维控制面</div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2.5 py-3">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition ${
                  isActive
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <aside className="hidden w-56 shrink-0 border-r border-slate-200 bg-white lg:block dark:border-slate-800 dark:bg-slate-900">
        {navContent}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="fixed inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="relative z-50 w-60 bg-white dark:bg-slate-900">{navContent}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white/95 px-4 py-2.5 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMobileOpen((v) => !v)}
              className="rounded p-1.5 hover:bg-slate-100 lg:hidden dark:hover:bg-slate-800"
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <h1 className="font-semibold text-base">{currentTitle}</h1>
          </div>
          <div className="flex items-center gap-2.5">
            {!isAdmin && (
              <span className="rounded-md bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                只读
              </span>
            )}
            <button
              onClick={toggle}
              title="切换深浅色主题"
              className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <span className="hidden text-xs text-slate-600 sm:inline dark:text-slate-300">
              {user?.username} ({user?.role})
            </span>
            <button
              onClick={() => void logout()}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>登出</span>
            </button>
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
