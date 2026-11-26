import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Boxes, CheckCircle2, FileCode2, Server, Shield } from 'lucide-react';

export function GettingStarted({
  hasHosts,
  hasNomad,
  hasReadyNomad,
  hasVault,
  hasReadyVault,
}: {
  hasHosts: boolean;
  hasNomad: boolean;
  hasReadyNomad?: boolean;
  hasVault: boolean;
  hasReadyVault?: boolean;
}) {
  const nomadReady = hasReadyNomad ?? hasNomad;
  const vaultReady = hasReadyVault ?? hasVault;

  const steps = [
    {
      title: '接入 Linux 主机',
      description: '确认 SSH 密钥与连通性，只需 1 台主机即可单机体验。',
      to: '/infra',
      icon: Server,
      done: hasHosts,
      optional: false,
      cta: '前往接入主机',
    },
    {
      title: '搭建 Nomad',
      description: '选择主机与角色，部署后即可调度和运行任务。',
      to: '/nomad',
      icon: Boxes,
      done: nomadReady,
      optional: false,
      cta: hasNomad ? '完成 Nomad 部署' : '新建 Nomad 集群',
    },
    {
      title: '搭建 Vault',
      description: '安全托管密码、证书与密钥，支持自动解封与联动。',
      to: '/vault',
      icon: Shield,
      done: vaultReady,
      optional: true,
      cta: hasVault ? '完成 Vault 初始化' : '新建 Vault 集群',
    },
    {
      title: '运行第一个 Job',
      description: '使用内置模板或可视化积木，校验、预览计划并提交运行。',
      to: '/jobs',
      icon: FileCode2,
      done: false,
      optional: false,
      cta: '前往 Job 中心',
    },
  ];

  // 定位当前推荐进行的下一步：主机 -> Nomad -> Job（Vault 为可选但若已创建未就绪则提示）
  const activeIndex = !hasHosts ? 0 : !nomadReady ? 1 : hasVault && !vaultReady ? 2 : 3;
  const activeStep = steps[activeIndex];
  const allInfraReady = hasHosts && nomadReady;

  return (
    <div className="rounded-2xl border border-indigo-200/80 bg-gradient-to-br from-indigo-50/90 via-white to-white p-5 sm:p-6 dark:border-indigo-500/25 dark:from-indigo-950/50 dark:via-slate-900 dark:to-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-2 text-xs font-medium text-indigo-600 dark:text-indigo-300">
            <span>{allInfraReady ? '集群控制面就绪' : '快速开始 · 新手引导'}</span>
          </div>
          <h2 className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
            {allInfraReady ? '核心服务已就绪，开始编排你的第一个工作负载' : '4 步搭建你的第一个集群'}
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {allInfraReady
              ? '可直接进入 Job 中心提交示例任务，或按需搭建 Vault 密钥库并开启集群联动。'
              : '按顺序完成以下几步，即可从空白主机快速上线 Nomad 与 Vault。'}
          </p>
        </div>
        <Link to={activeStep.to} className="primary-button shrink-0">
          <span>{activeStep.cta}</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((step, index) => {
          const Icon = step.icon;
          const isCurrent = index === activeIndex;
          return (
            <Link
              key={step.to}
              to={step.to}
              className={`rounded-xl border p-4 transition ${
                isCurrent
                  ? 'border-indigo-400 bg-white shadow-sm dark:border-indigo-500/60 dark:bg-slate-900/90'
                  : 'border-slate-200/90 bg-white/70 hover:border-indigo-300 hover:bg-white dark:border-slate-800 dark:bg-slate-950/40 dark:hover:border-indigo-500/40 dark:hover:bg-slate-900'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${
                    step.done
                      ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300'
                      : isCurrent
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </span>
                {step.done ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                    <CheckCircle2 className="h-3 w-3" />
                    已完成
                  </span>
                ) : isCurrent ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200">
                    当前推荐
                  </span>
                ) : (
                  <ArrowUpRight className="h-4 w-4 text-slate-400" />
                )}
              </div>
              <div className="mt-3 text-sm font-semibold text-slate-800 dark:text-slate-100">
                {index + 1}. {step.title}
                {step.optional && <span className="ml-1.5 text-[11px] font-normal text-slate-400">可选</span>}
              </div>
              <p className="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{step.description}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
