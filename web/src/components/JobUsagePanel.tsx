import { useEffect, useMemo, useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, Copy, Info, Loader2 } from 'lucide-react';
import { apiPost } from '../lib/api';
import { copyText } from '../lib/clipboard';
import type { HCLDocument } from '../lib/hclBuilder';
import { buildConnectionSnippet, connectionDocumentFromJSON, getJobConnections } from '../lib/jobConnections';
import { useI18n } from '../lib/i18n';
import { useToast } from './Toast';
import { Badge, Button } from './UI';

export function JobUsagePanel({ source, clusterId, namespace, inputType = 'hcl', isAdmin, defaultExpanded = false }: {
  source: string;
  clusterId: string;
  namespace: string;
  inputType?: 'hcl' | 'json';
  isAdmin: boolean;
  defaultExpanded?: boolean;
}) {
  const { tr } = useI18n();
  const toast = useToast();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [parsed, setParsed] = useState<{
    source: string;
    inputType: string;
    clusterId: string;
    document?: HCLDocument;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (!expanded || !source.trim() || !isAdmin) return;
    let active = true;
    // 复用现有语法树接口；输入变化后立即隐藏旧指引，防抖解析新配置。
    const timer = window.setTimeout(async () => {
      try {
        const document = inputType === 'json'
          ? connectionDocumentFromJSON(source)
          : (await apiPost<{ document: HCLDocument }>(`/api/v1/nomad/${clusterId}/job-ops/hcl-tree`, { hcl: source })).document;
        if (active) setParsed({ source, inputType, clusterId, document });
      } catch (ex: any) {
        if (active) setParsed({ source, inputType, clusterId, error: ex?.message || tr('无法解析当前配置', 'Cannot parse the current configuration') });
      }
    }, 400);
    return () => { active = false; window.clearTimeout(timer); };
  }, [expanded, source, inputType, clusterId, isAdmin, tr]);

  const current = parsed?.source === source && parsed.inputType === inputType && parsed.clusterId === clusterId ? parsed : null;
  const guide = useMemo(() => {
    if (!current?.document) return null;
    try { return getJobConnections(current.document, namespace); } catch { return null; }
  }, [current, namespace]);

  const copy = async (text: string) => {
    try {
      await copyText(text);
      toast.success(tr('已复制连接配置', 'Connection configuration copied'));
    } catch (ex: any) {
      toast.error(ex?.message || tr('复制失败，请手动复制', 'Copy failed; please copy manually'));
    }
  };

  const codeBlock = (label: string, code: string) => (
    <div className="min-w-0 overflow-hidden rounded-lg border border-slate-200/80 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 px-3 py-1.5 dark:bg-slate-900">
        <span className="font-medium text-slate-700 dark:text-slate-200">{label}</span>
        <Button size="sm" onClick={() => void copy(code)}>
          <Copy className="h-3 w-3" />{tr('复制', 'Copy')}
        </Button>
      </div>
      <pre className="max-h-80 overflow-auto bg-white p-3 text-[11px] leading-5 text-slate-700 dark:bg-slate-950 dark:text-slate-200"><code>{code}</code></pre>
    </div>
  );

  return (
    <div className="min-w-0 rounded-xl border border-indigo-200/80 bg-indigo-50/30 text-xs dark:border-indigo-500/25 dark:bg-indigo-950/15">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="flex w-full flex-wrap items-center gap-2 px-3.5 py-2.5 text-left">
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
        <span className="font-semibold text-slate-800 dark:text-slate-100">{tr('连接与使用', 'Connect & Use')}</span>
        <span className="text-[11px] text-slate-500 dark:text-slate-400">{tr('服务发现 · 密钥读取 · 引用示例', 'Service discovery · Secrets · Examples')}</span>
      </button>
      {expanded && (
        <div className="min-w-0 space-y-3 border-t border-indigo-200/60 px-3.5 py-3 dark:border-indigo-500/20">
          <p className="flex items-start gap-2 leading-5 text-slate-600 dark:text-slate-300">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-500" />
            {tr('以下指引根据当前配置生成，不代表服务已经部署或健康。先部署此 Job，再在同一 Nomad 集群与 Namespace 的应用中引用。', 'This guide reflects the current configuration, not deployment or health status. Deploy this Job first, then reference it from an application in the same Nomad cluster and namespace.')}
          </p>
          {!isAdmin ? (
            <p className="text-slate-500 dark:text-slate-400">{tr('请联系管理员查看配置并生成连接示例。', 'Ask an administrator to inspect the configuration and generate connection examples.')}</p>
          ) : !source.trim() ? (
            <p className="text-slate-500 dark:text-slate-400">{tr('填写 Job 配置后即可查看连接指引。', 'Enter a Job configuration to view its connection guide.')}</p>
          ) : current?.error ? (
            <p role="alert" className="break-words text-amber-700 dark:text-amber-300">{tr('请先修正配置，连接示例暂不可用：', 'Fix the configuration before generating connection examples: ')}{current.error}</p>
          ) : current?.document && !guide ? (
            <p role="alert" className="text-amber-700 dark:text-amber-300">{tr('当前配置没有可识别的 Job，请先补全 Job 定义。', 'No Job was found in this configuration. Complete the Job definition first.')}</p>
          ) : !guide ? (
            <p role="status" className="flex items-center gap-2 text-slate-500 dark:text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tr('正在读取当前配置…', 'Reading the current configuration...')}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-slate-600 dark:text-slate-300">
                <span>Namespace</span><Badge tone="blue">{guide.namespace || tr('动态表达式，需确认实际值', 'Dynamic expression; confirm the resolved value')}</Badge>
              </div>
              {guide.services.length === 0 && (
                <div className="space-y-2 rounded-lg border border-slate-200/80 bg-white/80 p-3 leading-5 dark:border-slate-800 dark:bg-slate-900/60">
                  {guide.type === 'batch' ? (
                    <p>{tr('这是批处理任务，不提供常驻连接端口。运行后在「运行态 Jobs → Allocation → 日志与详情」查看完成状态、日志及生成文件；定时任务还需查看各次派生执行。', 'This batch Job does not expose a persistent endpoint. After running it, open Runtime Jobs → Allocation → Logs & Inspect for completion status, logs and files. For periodic Jobs, inspect each dispatched run.')}</p>
                  ) : (
                    <>
                      <p>{tr('当前未注册服务，其他 Job 无法通过 nomadService 发现它。若需被应用引用，在提供服务的 Group 中添加以下配置，并将服务名和 port 替换为实际值。', 'No service is registered, so other Jobs cannot discover it with nomadService. Add this block to the serving Group and replace the service name and port label.')}</p>
                      {codeBlock(tr('服务注册示例 · 放入提供方 Group', 'Service registration · Provider Group'), 'service {\n  name     = "your-service"\n  provider = "nomad"\n  port     = "http"\n}')}
                      <p>{tr('只查看本任务的运行结果时，可直接进入运行态 Jobs 查看 Allocation 日志和端口。', 'To inspect this task directly, open its Allocation logs and ports in Runtime Jobs.')}</p>
                    </>
                  )}
                </div>
              )}
              {guide.services.map((service, index) => {
                const snippet = guide.namespace ? buildConnectionSnippet(service) : null;
                return (
                  <div key={`${service.group}-${index}`} className="min-w-0 space-y-3 rounded-lg border border-slate-200/80 bg-white/80 p-3 dark:border-slate-800 dark:bg-slate-900/60">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all font-semibold text-slate-800 dark:text-slate-100">{service.name || tr('服务名为动态表达式或未设置', 'Dynamic or unset service name')}</span>
                      <Badge tone="neutral">{service.provider || tr('动态 provider', 'Dynamic provider')}</Badge>
                      <span className="break-all text-slate-500 dark:text-slate-400">Group: {service.group} · port: {service.port || tr('未确定', 'unresolved')}</span>
                    </div>
                    {service.secrets.length > 0 && (
                      <div className="space-y-1 leading-5 text-slate-600 dark:text-slate-300">
                        <div className="font-medium">{tr('Vault 模板读取路径与字段（不显示密钥值）', 'Vault template paths and fields (values are never displayed)')}</div>
                        {service.secrets.map((secret, i) => <p key={i} className="break-all"><code>{secret.path}</code>{secret.fields.length > 0 && <> · {secret.fields.join(', ')}</>}</p>)}
                      </div>
                    )}
                    {snippet ? (
                      <>
                        <p className="leading-5 text-slate-600 dark:text-slate-300">{tr(`将以下片段放入调用方应用的 Task 中，调用方 Job 的 namespace 设为 ${JSON.stringify(guide.namespace)}。应用需要读取这些环境变量：${snippet.variables.join('、')}；变量名应按应用要求调整。`, `Place this snippet inside the consuming application's Task and set its Job namespace to ${JSON.stringify(guide.namespace)}. The application must read ${snippet.variables.join(', ')}; adapt variable names to its configuration.`)}</p>
                        {codeBlock(tr('调用方 Task 配置', 'Consumer Task configuration'), snippet.task)}
                        {snippet.policy && (
                          <>
                            <p className="leading-5 text-slate-600 dark:text-slate-300">{tr('app-reader 是调用方自己的 Vault Role 占位名。请在「集群联动」的对应联动中添加 Role，将「允许使用的 Nomad Namespace」设为调用方的 Namespace，再把下方策略粘贴到「高级选项 → 自定义 Policy HCL」，保存并应用后替换示例中的 Role 名称。', 'app-reader is a placeholder for the consuming application’s own Vault Role. Add a Role in the matching Cluster Integration, set Allowed Nomad Namespace to the consumer namespace, and paste the policy below into Advanced Options → Custom Policy HCL. Save and apply it, then replace the Role name in the example.')}</p>
                            <p className="leading-5 text-slate-500 dark:text-slate-400">{tr('同时引用多个服务时，Task 只保留一个 vault 块，合并所需路径的读取策略并授权给同一个应用 Role，各 template 块分别保留。', 'For multiple dependencies, keep one vault block, merge the required read policies into one application Role, and keep each template block.')}</p>
                            {service.image.split('/').pop()?.startsWith('mysql:') && <p className="leading-5 text-slate-500 dark:text-slate-400">{tr('示例不注入 root_password。Vault 权限按路径生效，建议将业务账号凭据放到独立路径，与 Root 密码隔离，并同步更新提供方和调用方配置。', 'The example does not inject root_password. Vault authorizes entire paths; keep application credentials at a separate path from the root password and update both provider and consumer configurations.')}</p>}
                            {codeBlock(tr('调用方 Vault Policy · 只读', 'Consumer Vault Policy · Read only'), snippet.policy)}
                          </>
                        )}
                        {service.secrets.length > 0 && !snippet.policy && <p className="leading-5 text-slate-500 dark:text-slate-400">{tr('此示例仅生成地址变量。自定义镜像或密钥字段需按上方路径与字段列表自行补充 Vault 读取模板和应用配置。', 'This example generates only address variables. For custom images or secret fields, add the Vault template and application configuration using the paths and fields listed above.')}</p>}
                        <p className="leading-5 text-slate-500 dark:text-slate-400">{tr('nomadService 获取服务注册的地址和端口，请确认应用所在节点可达该地址。示例取首个实例；多个数据库实例需自行确定主库。未发现服务时不会生成地址变量，应用需等待依赖就绪。连接或密钥变化会触发应用 Task 重启。', 'nomadService returns the registered address and port; ensure the application node can reach it. This example selects the first instance; select the primary explicitly for database clusters. No address variables are generated until a service is discovered, so the application must wait for dependencies. Connection or secret changes restart the consuming Task.')}</p>
                      </>
                    ) : (
                      <p className="leading-5 text-amber-700 dark:text-amber-300">{service.provider && service.provider !== 'nomad'
                        ? tr('此服务未使用 Nomad provider，不能直接套用 nomadService 示例。请使用对应的服务发现方式，或先将 provider 改为 nomad。', 'This service does not use the Nomad provider. Use its matching discovery mechanism or switch its provider to nomad before using nomadService.')
                        : tr('请先将服务名、port 和 Namespace 配置为明确值，再生成可复制的连接示例。', 'Set explicit service name, port and namespace values before generating a copyable connection example.')}</p>
                    )}
                  </div>
                );
              })}
              {guide.services.length === 0 && guide.secrets.length > 0 && (
                <p className="break-all leading-5 text-slate-500 dark:text-slate-400">{tr('本任务读取的 Vault 路径：', 'Vault paths read by this task: ')}{Array.from(new Set(guide.secrets.map((s) => s.path))).join('、')}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
