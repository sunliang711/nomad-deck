import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Search, Terminal } from 'lucide-react';
import { apiGet, fmtTime } from '../lib/api';
import { useOpsDrawer } from '../lib/opsDrawer';
import { Button, EmptyState, ErrorAlert, Modal, PageHeader, StatusBadge } from '../components/UI';
import { FilterDateTime, FilterSelect, type FilterOption } from '../components/FilterControls';

const ACTION_LABELS: Record<string, string> = {
  'auth.setup': '初始化系统',
  'auth.login': '管理员登录',
  'auth.logout': '退出登录',
  'auth.password_change': '修改登录密码',
  'auth.session_revoke': '注销会话',
  'admin.create': '新增控制台账号',
  'admin.rename': '修改账号名称',
  'admin.role_change': '变更账号角色',
  'admin.reset_password': '重置账号密码',
  'admin.reset_password_local': '本地 CLI 重置密码',
  'admin.disable': '停用账号',
  'admin.enable': '启用账号',
  'ssh_key.generate': '生成 SSH 密钥',
  'ssh_key.import': '导入 SSH 密钥',
  'ssh_key.set_default': '设为默认 SSH 密钥',
  'ssh_key.delete': '删除 SSH 密钥',
  'node.create': '新增主机节点',
  'node.update': '更新主机节点',
  'node.delete': '删除主机节点',
  'node.test': '探测主机环境',
  'node.push_key': '推送 SSH 公钥',
  'node.reset_fingerprint': '重置主机指纹',
  'docker.install': '安装 Docker',
  'docker.upgrade': '升级 Docker',
  'docker.adopt': '接管外部 Docker',
  'docker.config': '更新 Docker 配置',
  'cluster.create': '创建集群',
  'cluster.update': '更新集群配置',
  'cluster.delete': '删除集群',
  'cluster.deploy': '部署集群',
  'cluster.upgrade': '滚动升级集群',
  'cluster.join_node': '扩容加入节点',
  'cluster.remove_node': '缩容移除节点',
  'cluster.certs_renew': '续期节点证书',
  'cluster.ca_rotate': '轮换集群 CA',
  'cluster.gossip_rotate': '轮换 Gossip 密钥',
  'cluster.maintenance': '切换维护模式',
  'cluster.proxy_update': '更新集群代理设置',
  'cluster.uninstall': '卸载集群',
  'nomad.management_token_reveal': '查看 Nomad Management Token',
  'vault.init': '初始化 Vault',
  'vault.unseal': '解封 Vault',
  'vault.seal': '封存 Vault',
  'vault.rekey': 'Vault Rekey 轮换',
  'vault.root_token': '签发临时 Root Token',
  'integration.create': '新建集群联动',
  'integration.apply': '应用联动配置',
  'integration.delete': '删除联动配置',
  'nomad.job_apply': '提交 Nomad Job',
  'nomad.job_stop': '停止 Nomad Job',
  'nomad.job_purge': '清理 Nomad Job',
  'cron.create': '创建定时任务',
  'cron.update': '更新定时任务',
  'cron.delete': '删除定时任务',
  'cron.run': '手动触发定时任务',
  'settings.update': '更新系统设置',
  'settings.proxy_update': '更新系统代理',
  'settings.master_key_rotate': '轮换主密钥',
  'backup.config_update': '更新灾备配置',
  'backup.run': '执行控制面灾备',
  'migration.export': '导出迁移包',
  'migration.import': '导入迁移包',
  'migration.activate': '激活控制面',
  'self_update.start': '发起控制面自更新',
  'self_update.rollback': '回退控制面版本',
};

const RESOURCE_LABELS: Record<string, string> = {
  admin: '管理员',
  session: '会话',
  ssh_key: 'SSH 密钥',
  node: 'Linux 主机',
  cluster: '集群',
  vault: 'Vault',
  integration: '集群联动',
  nomad_job: 'Nomad Job',
  cron_job: '定时任务',
  settings: '系统设置',
  backup: '控制面灾备',
  migration: '环境迁移',
  system: '控制面系统',
};

const ACTION_GROUPS: Array<{ group: string; actions: string[] }> = [
  { group: '认证与账号', actions: ['auth.setup', 'auth.login', 'auth.logout', 'auth.password_change', 'auth.session_revoke', 'admin.create', 'admin.role_change', 'admin.reset_password', 'admin.disable', 'admin.enable'] },
  { group: '主机与 Docker', actions: ['ssh_key.generate', 'ssh_key.import', 'ssh_key.delete', 'node.create', 'node.update', 'node.delete', 'node.test', 'node.push_key', 'node.reset_fingerprint', 'docker.install', 'docker.upgrade', 'docker.config'] },
  { group: '集群与证书', actions: ['cluster.create', 'cluster.deploy', 'cluster.upgrade', 'cluster.join_node', 'cluster.remove_node', 'cluster.certs_renew', 'cluster.ca_rotate', 'cluster.gossip_rotate', 'cluster.maintenance', 'cluster.uninstall'] },
  { group: 'Vault 与联动', actions: ['vault.init', 'vault.unseal', 'vault.seal', 'vault.rekey', 'vault.root_token', 'integration.create', 'integration.apply', 'integration.delete'] },
  { group: 'Job 与定时', actions: ['nomad.job_apply', 'nomad.job_stop', 'nomad.job_purge', 'cron.create', 'cron.update', 'cron.delete', 'cron.run'] },
  { group: '设置与灾备', actions: ['settings.update', 'settings.proxy_update', 'settings.master_key_rotate', 'backup.config_update', 'backup.run', 'migration.export', 'migration.import', 'migration.activate', 'self_update.start', 'self_update.rollback'] },
];

function shortId(id?: string): string {
  if (!id) return '';
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export function AuditPage() {
  const { openTask } = useOpsDrawer();
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const requestId = useRef(0);

  const [action, setAction] = useState('');
  const [result, setResult] = useState('');
  const [keyword, setKeyword] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [beforeStack, setBeforeStack] = useState<string[]>([]);
  const [currentBefore, setCurrentBefore] = useState('');
  const [nextBefore, setNextBefore] = useState('');
  const [exportQuery, setExportQuery] = useState('');

  const [detail, setDetail] = useState<any>(null);
  const [err, setErr] = useState('');
  const limit = 50;

  const buildParams = useCallback(
    (includePage: boolean, beforeCursor: string, overrides?: Partial<{ action: string; result: string; keyword: string; fromDate: string; toDate: string }>) => {
      const a = overrides?.action ?? action;
      const r = overrides?.result ?? result;
      const k = overrides?.keyword ?? keyword;
      const f = overrides?.fromDate ?? fromDate;
      const t = overrides?.toDate ?? toDate;
      const params = new URLSearchParams();
      if (includePage) {
        params.set('limit', String(limit));
        if (beforeCursor) params.set('before', beforeCursor);
      }
      if (a) params.set('action', a);
      if (r) params.set('result', r);
      if (k.trim()) params.set('q', k.trim());
      if (f) params.set('from', new Date(f).toISOString());
      if (t) params.set('to', new Date(t).toISOString());
      return params;
    },
    [action, result, keyword, fromDate, toDate],
  );

  const load = useCallback(
    async (beforeCursor = '', overrides?: Partial<{ action: string; result: string; keyword: string; fromDate: string; toDate: string }>) => {
      const seq = ++requestId.current;
      setLoading(true);
      setErr('');
      try {
        const f = overrides?.fromDate ?? fromDate;
        const t = overrides?.toDate ?? toDate;
        if (f && t && new Date(f) > new Date(t)) {
          throw new Error('开始时间不能晚于结束时间');
        }
        const pageParams = buildParams(true, beforeCursor, overrides);
        const exportParams = buildParams(false, '', overrides);
        const res = await apiGet(`/api/v1/audit-logs?${pageParams.toString()}`);
        if (seq !== requestId.current) return;
        setExportQuery(exportParams.toString());
        setLogs(res.audit_logs || []);
        setNextBefore(res.next_before || '');
      } catch (ex: any) {
        if (seq === requestId.current) setErr(ex?.message || '加载审计日志失败');
      } finally {
        if (seq === requestId.current) setLoading(false);
      }
    },
    [buildParams, fromDate, toDate],
  );

  useEffect(() => {
    setBeforeStack([]);
    setCurrentBefore('');
    void load('');
  }, [action, result]);

  const resetFilters = () => {
    setAction('');
    setResult('');
    setKeyword('');
    setFromDate('');
    setToDate('');
    setBeforeStack([]);
    setCurrentBefore('');
    void load('', { action: '', result: '', keyword: '', fromDate: '', toDate: '' });
  };

  const actionOptions: FilterOption[] = [
    { value: '', label: '全部操作' },
    ...ACTION_GROUPS.flatMap((g) =>
      g.actions.map((act) => ({
        value: act,
        label: ACTION_LABELS[act] || act,
        group: g.group,
      })),
    ),
  ];

  const hasFilters = Boolean(action || result || keyword || fromDate || toDate);

  return (
    <div className="space-y-5">
      <PageHeader
        title="审计日志"
        subtitle={`当前展示 ${logs.length} 条审计记录（第 ${beforeStack.length + 1} 页）`}
        actions={
          <>
            <a
              href={`/api/v1/audit-logs/export?format=csv&${exportQuery}`}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-[10px] text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-700"
            >
              <Download className="w-3.5 h-3.5" />
              <span>导出 CSV</span>
            </a>
            <a
              href={`/api/v1/audit-logs/export?format=json&${exportQuery}`}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-[10px] text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-700"
            >
              <Download className="w-3.5 h-3.5" />
              <span>导出 JSON</span>
            </a>
          </>
        }
      />

      <div className="filter-bar audit-filter-bar flex flex-wrap gap-3 bg-white dark:bg-slate-900 p-4 rounded-2xl border border-[#e3e8f1] dark:border-slate-800 shadow-[0_3px_12px_rgba(15,23,42,0.03)]">
        <div className="audit-filter-search flex items-center gap-2 flex-1 min-w-[200px] border border-[#dce3ee] dark:border-slate-700 rounded-[10px] px-3">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setBeforeStack([]);
                setCurrentBefore('');
                void load('');
              }
            }}
            aria-label="搜索关键字"
            placeholder="搜索资源名称、ID、错误或详情关键字..."
            className="w-full text-sm focus:outline-none bg-transparent border-0"
          />
        </div>

        <FilterSelect label="操作类型" value={action} onChange={setAction} wide options={actionOptions} />

        <FilterSelect
          label="执行结果"
          value={result}
          onChange={setResult}
          options={[
            { value: '', label: '全部结果' },
            { value: 'success', label: '成功 (success)' },
            { value: 'failed', label: '失败 (failed)' },
          ]}
        />

        <FilterDateTime label="起始时间" value={fromDate} onChange={setFromDate} />
        <FilterDateTime label="截止时间" value={toDate} onChange={setToDate} />

        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setBeforeStack([]);
            setCurrentBefore('');
            void load('');
          }}
          className="audit-filter-submit px-4 py-1.5 bg-slate-900 dark:bg-indigo-600 hover:bg-slate-800 dark:hover:bg-indigo-500 text-white rounded-[10px] text-sm font-medium disabled:opacity-50"
        >
          {loading ? '查询中...' : '查询'}
        </button>

        {hasFilters && (
          <button
            type="button"
            onClick={resetFilters}
            className="text-sm text-slate-500 dark:text-slate-400 px-2 hover:text-indigo-600 dark:hover:text-indigo-400"
          >
            重置筛选
          </button>
        )}
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />

      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-[#e3e8f1] dark:border-slate-800 shadow-[0_3px_12px_rgba(15,23,42,0.03)] overflow-x-auto">
        <table aria-busy={loading} className="audit-table w-full text-sm">
          <thead className="bg-[#f8faff] dark:bg-slate-950/60 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-slate-800">
            <tr>
              <th className="text-left px-4 py-3">时间</th>
              <th className="text-left px-4 py-3">操作人</th>
              <th className="text-left px-4 py-3">操作</th>
              <th className="text-left px-4 py-3">目标资源</th>
              <th className="text-left px-4 py-3">来源 IP</th>
              <th className="text-left px-4 py-3">结果</th>
              <th className="text-right px-4 py-3">详情</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {!loading &&
              logs.map((l) => {
                const actionLabel = ACTION_LABELS[l.action] || l.action;
                const resLabel = RESOURCE_LABELS[l.resource_type] || l.resource_type || '系统';
                return (
                  <tr key={l.id}>
                    <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {fmtTime(l.created_at)}
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap">
                      <span className="font-medium text-slate-800 dark:text-slate-100">{l.actor_name || '-'}</span>
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap" title={l.action}>
                      <div className="font-medium text-slate-800 dark:text-slate-100">{actionLabel}</div>
                      {actionLabel !== l.action && (
                        <div className="font-mono text-[11px] text-slate-400">{l.action}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600 dark:text-slate-300">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-200/70 dark:border-indigo-500/30 text-[11px] font-medium shrink-0">
                          {resLabel}
                        </span>
                        <span
                          className="truncate max-w-[260px] text-slate-700 dark:text-slate-200"
                          title={l.resource_id ? `${l.resource_name || l.resource_id} (${l.resource_id})` : l.resource_name}
                        >
                          {l.resource_name || shortId(l.resource_id) || '-'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {l.client_ip || '-'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <StatusBadge value={l.result} />
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        {l.operation_task_id && (
                          <button
                            type="button"
                            onClick={() => openTask(l.operation_task_id, `${actionLabel} (${l.operation_task_id})`)}
                            className="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400"
                          >
                            <Terminal className="w-3.5 h-3.5" />
                            <span>任务</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setDetail(l)}
                          className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                          查看
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            {(loading || logs.length === 0) && (
              <tr>
                <td colSpan={7}>
                  <EmptyState
                    title={loading ? '正在检索审计记录...' : '暂无匹配的审计记录'}
                    description={loading ? undefined : '可尝试调整时间范围或清空筛选条件。'}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>第 {beforeStack.length + 1} 页 · 本页 {logs.length} 条</span>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={loading || beforeStack.length === 0}
            onClick={() => {
              const prevStack = [...beforeStack];
              const prevBefore = prevStack.pop() ?? '';
              setBeforeStack(prevStack);
              setCurrentBefore(prevBefore);
              void load(prevBefore);
            }}
          >
            上一页
          </Button>
          <Button
            size="sm"
            disabled={loading || !nextBefore}
            onClick={() => {
              setBeforeStack((prev) => [...prev, currentBefore]);
              setCurrentBefore(nextBefore);
              void load(nextBefore);
            }}
          >
            下一页
          </Button>
        </div>
      </div>

      <Modal
        open={Boolean(detail)}
        title={detail ? `审计详情 · ${ACTION_LABELS[detail.action] || detail.action}` : ''}
        onClose={() => setDetail(null)}
        size="lg"
      >
        {detail && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  {ACTION_LABELS[detail.action] || detail.action}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  记录 ID: <code className="font-mono">{detail.id}</code> · {fmtTime(detail.created_at)}
                </p>
              </div>
              <StatusBadge value={detail.result} />
            </div>

            {detail.error_message && <ErrorAlert message={detail.error_message} />}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs bg-slate-50 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700 p-3.5 rounded-xl text-slate-700 dark:text-slate-200">
              <div>
                <span className="text-slate-400">操作人：</span>
                <span className="font-medium">{detail.actor_name || '-'}</span>
              </div>
              <div>
                <span className="text-slate-400">来源 IP：</span>
                <span className="font-mono">{detail.client_ip || '-'}</span>
              </div>
              <div className="sm:col-span-2">
                <span className="text-slate-400">目标资源：</span>
                <span className="font-medium">{RESOURCE_LABELS[detail.resource_type] || detail.resource_type}</span>
                {detail.resource_name ? ` · ${detail.resource_name}` : ''}
              </div>
              <div>
                <span className="text-slate-400">动作码：</span>
                <code className="font-mono">{detail.action}</code>
              </div>
              <div>
                <span className="text-slate-400">耗时：</span>
                <span className="font-mono">{detail.duration_ms ?? 0} ms</span>
              </div>
              {detail.resource_id && (
                <div className="sm:col-span-2 break-all">
                  <span className="text-slate-400">资源 ID：</span>
                  <code className="font-mono">{detail.resource_id}</code>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">请求摘要（已脱敏）</div>
              <pre className="bg-slate-900 dark:bg-slate-950 border border-slate-800 text-slate-100 p-4 rounded-xl text-xs overflow-auto max-h-72">
                {JSON.stringify(detail.request_summary ?? {}, null, 2)}
              </pre>
            </div>

            <div className="flex justify-end gap-2">
              {detail.operation_task_id && (
                <Button
                  onClick={() => {
                    const tid = detail.operation_task_id;
                    setDetail(null);
                    openTask(tid, `关联运维任务 (${tid})`);
                  }}
                >
                  <Terminal className="w-3.5 h-3.5" />
                  <span>查看关联运维任务</span>
                </Button>
              )}
              <Button onClick={() => setDetail(null)}>关闭</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
