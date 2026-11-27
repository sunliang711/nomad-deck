import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileCode2,
  Link2,
  Server,
  Shield,
  Sparkles,
} from 'lucide-react';
import { useI18n } from '../lib/i18n';

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
  const { tr } = useI18n();
  const nomadReady = hasReadyNomad ?? hasNomad;
  const vaultReady = hasReadyVault ?? hasVault;
  const allInfraReady = hasHosts && nomadReady;
  const [expanded, setExpanded] = useState(false);

  const steps = [
    {
      title: tr('接入 Linux 主机', 'Connect Linux Hosts'),
      description: tr('确认 SSH 密钥与连通性，只需 1 台主机即可单机体验。', 'Verify SSH keys and connectivity; just 1 host is enough for single-node mode.'),
      to: '/infra',
      icon: Server,
      done: hasHosts,
      optional: false,
      cta: tr('前往接入主机', 'Add Hosts'),
    },
    {
      title: tr('搭建 Nomad', 'Deploy Nomad'),
      description: tr('选择主机与角色，部署后即可调度和运行任务。', 'Select hosts and roles, then deploy to schedule and run workloads.'),
      to: '/nomad',
      icon: Boxes,
      done: nomadReady,
      optional: false,
      cta: hasNomad ? tr('完成 Nomad 部署', 'Finish Nomad Deploy') : tr('新建 Nomad 集群', 'New Nomad Cluster'),
    },
    {
      title: tr('搭建 Vault', 'Deploy Vault'),
      description: tr('安全托管密码、证书与密钥，支持自动解封与联动。', 'Securely store passwords, certs, and secrets with auto-unseal and integrations.'),
      to: '/vault',
      icon: Shield,
      done: vaultReady,
      optional: true,
      cta: hasVault ? tr('完成 Vault 初始化', 'Initialize Vault') : tr('新建 Vault 集群', 'New Vault Cluster'),
    },
    {
      title: tr('运行第一个 Job', 'Run Your First Job'),
      description: tr('使用内置模板或可视化积木，校验、预览计划并提交运行。', 'Use built-in templates or the visual builder to validate, plan, and submit.'),
      to: '/jobs',
      icon: FileCode2,
      done: false,
      optional: false,
      cta: tr('前往 Job 中心', 'Open Job Center'),
    },
  ];

  // 核心集群已就绪时默认折叠为紧凑快捷操作条，把首屏空间留给监控指标与集群状态
  if (allInfraReady && !expanded) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200/80 bg-gradient-to-r from-emerald-50/70 via-white to-indigo-50/40 px-4 py-3 text-xs dark:border-emerald-500/25 dark:from-emerald-950/30 dark:via-slate-900/95 dark:to-indigo-950/30">
        <div className="flex flex-wrap items-center gap-2.5 min-w-0">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <span className="font-semibold text-slate-900 dark:text-slate-100">
            {vaultReady ? tr('Nomad 与 Vault 集群均已就绪', 'Nomad & Vault Clusters Ready') : tr('Nomad 集群已就绪', 'Nomad Cluster Ready')}
          </span>
          <span className="hidden md:inline text-slate-500 dark:text-slate-400">
            · {tr('常用快捷入口', 'Quick Shortcuts')}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/jobs"
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-700 transition shadow-xs"
          >
            <FileCode2 className="h-3.5 w-3.5" />
            <span>{tr('编排 Job', 'Build Job')}</span>
          </Link>
          <Link
            to="/integrations"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-200 dark:hover:border-indigo-500/40 dark:hover:text-indigo-300 transition"
          >
            <Link2 className="h-3.5 w-3.5" />
            <span>{tr('集群联动', 'Integrations')}</span>
          </Link>
          {vaultReady ? (
            <Link
              to="/vault?tab=manage"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-200 dark:hover:border-indigo-500/40 dark:hover:text-indigo-300 transition"
            >
              <Shield className="h-3.5 w-3.5" />
              <span>{tr('管理密钥', 'Manage Secrets')}</span>
            </Link>
          ) : (
            <Link
              to="/vault"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-200 dark:hover:border-indigo-500/40 dark:hover:text-indigo-300 transition"
            >
              <Shield className="h-3.5 w-3.5" />
              <span>{tr('搭建 Vault', 'Deploy Vault')}</span>
            </Link>
          )}
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition"
            title={tr('展开搭建引导', 'Expand onboarding guide')}
          >
            <span className="hidden sm:inline">{tr('引导', 'Guide')}</span>
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  const activeIndex = !hasHosts ? 0 : !nomadReady ? 1 : hasVault && !vaultReady ? 2 : 3;
  const activeStep = steps[activeIndex];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div className="rounded-2xl border border-indigo-200/80 bg-gradient-to-br from-indigo-50/90 via-white to-white p-5 sm:p-6 dark:border-indigo-500/25 dark:from-indigo-950/45 dark:via-slate-900 dark:to-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-2 text-xs font-medium text-indigo-600 dark:text-indigo-300">
            <span>{allInfraReady ? tr('集群控制面就绪', 'Control Plane Ready') : tr('快速开始 · 新手引导', 'Quick Start · Onboarding')}</span>
            <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-mono text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200">
              {doneCount}/4
            </span>
          </div>
          <h2 className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
            {allInfraReady ? tr('核心服务已就绪，开始编排工作负载', 'Core Services Ready — Start Deploying Workloads') : tr('4 步搭建你的第一个集群', '4 Steps to Launch Your First Cluster')}
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {allInfraReady
              ? tr('可直接进入 Job 中心提交任务，或管理 Vault 密钥与集群联动。', 'Head to the Job Center to submit workloads, or manage Vault secrets and integrations.')
              : tr('按顺序完成以下几步，即可从空白主机快速上线 Nomad 与 Vault。', 'Follow these steps in order to spin up Nomad and Vault from bare Linux hosts.')}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {allInfraReady && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 transition"
            >
              <span>{tr('收起', 'Collapse')}</span>
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
          )}
          <Link to={activeStep.to} className="primary-button">
            <span>{activeStep.cta}</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
                    {tr('已完成', 'Done')}
                  </span>
                ) : isCurrent ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200">
                    {tr('当前推荐', 'Next Step')}
                  </span>
                ) : (
                  <ArrowUpRight className="h-4 w-4 text-slate-400" />
                )}
              </div>
              <div className="mt-3 text-sm font-semibold text-slate-800 dark:text-slate-100">
                {index + 1}. {step.title}
                {step.optional && <span className="ml-1.5 text-[11px] font-normal text-slate-400">{tr('可选', 'Optional')}</span>}
              </div>
              <p className="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{step.description}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
