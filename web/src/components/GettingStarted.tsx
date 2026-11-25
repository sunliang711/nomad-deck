import { Link } from 'react-router-dom';
import { ArrowUpRight, Boxes, CheckCircle2, FileCode2, Server, Shield } from 'lucide-react';

export function GettingStarted({ hasHosts, hasNomad, hasVault }: { hasHosts: boolean; hasNomad: boolean; hasVault: boolean }) {
  const steps = [
    { title: '接入 Linux 主机', description: '配置 SSH 密钥，添加主机并测试连接。', to: '/infra', icon: Server, done: hasHosts, optional: false },
    { title: '搭建 Nomad', description: '选择节点与角色，部署后即可运行任务。', to: '/nomad', icon: Boxes, done: hasNomad, optional: false },
    { title: '搭建 Vault', description: '集中保管密钥；可通过集群联动供任务读取。', to: '/vault', icon: Shield, done: hasVault, optional: true },
    { title: '运行第一个 Job', description: '从模板开始，校验配置、预览计划并提交运行。', to: '/jobs', icon: FileCode2, done: false, optional: false },
  ];

  return (
    <details className="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 group" open={!hasNomad}>
      <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-slate-900 dark:text-slate-100">入门路线 <span className="ml-2 text-xs font-normal text-slate-500">从接入主机到运行第一个任务</span></summary>
      <div className="grid gap-3 border-t border-slate-100 p-4 sm:grid-cols-2 xl:grid-cols-4 dark:border-slate-800">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <Link key={step.to} to={step.to} className="rounded-xl border border-slate-200 p-4 transition hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-slate-700 dark:hover:border-indigo-500 dark:hover:bg-indigo-500/10">
              <div className="flex items-center justify-between"><Icon className="h-5 w-5 text-indigo-500" />{step.done ? <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" />已接入</span> : <ArrowUpRight className="h-4 w-4 text-slate-400" />}</div>
              <div className="mt-4 text-sm font-semibold text-slate-800 dark:text-slate-100">{index + 1}. {step.title}{step.optional && <span className="ml-1 text-xs font-normal text-slate-400">可选</span>}</div>
              <p className="mt-2 text-xs leading-6 text-slate-500 dark:text-slate-400">{step.description}</p>
            </Link>
          );
        })}
      </div>
    </details>
  );
}
