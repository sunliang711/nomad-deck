import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Terminal } from 'lucide-react';
import { apiGet, fmtTime } from '../lib/api';
import { useOpsDrawer } from '../lib/opsDrawer';
import { Button, EmptyState, ErrorAlert, LoadingState, PageHeader, StatusBadge } from '../components/UI';
import { FilterSelect } from '../components/FilterControls';

export function OperationsPage() {
  const [ops, setOps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [err, setErr] = useState('');
  const { openTask } = useOpsDrawer();

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const q = statusFilter ? `?status=${encodeURIComponent(statusFilter)}&limit=100` : '?limit=100';
      const res = await apiGet(`/api/v1/operations${q}`);
      const list = (res.operations || []) as any[];
      list.sort((a, b) => {
        if (a.status === 'needs_reconcile' && b.status !== 'needs_reconcile') return -1;
        if (b.status === 'needs_reconcile' && a.status !== 'needs_reconcile') return 1;
        return 0;
      });
      setOps(list);
    } catch (ex: any) {
      setErr(ex?.message || '加载运维任务失败');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="运维任务"
        subtitle="查看异步 SSH 编排、滚动升级、证书轮换与控制面自更新的实时步骤与日志"
        actions={
          <div className="flex items-center gap-2.5">
            <FilterSelect
              label="任务状态"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: '', label: '全部状态' },
                { value: 'needs_reconcile', label: '待核对 (needs_reconcile)' },
                { value: 'running', label: '执行中 (running)' },
                { value: 'pending', label: '排队中 (pending)' },
                { value: 'success', label: '成功 (success)' },
                { value: 'failed', label: '失败 (failed)' },
                { value: 'rolled_back', label: '已回滚 (rolled_back)' },
              ]}
            />
            <Button onClick={() => void load()} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              <span>刷新</span>
            </Button>
          </div>
        }
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-[#e3e8f1] dark:border-slate-800 shadow-[0_3px_12px_rgba(15,23,42,0.03)] overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[#f8faff] dark:bg-slate-950/60 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-200/80 dark:border-slate-800">
            <tr>
              <th className="text-left px-4 py-3">动作</th>
              <th className="text-left px-4 py-3">目标</th>
              <th className="text-left px-4 py-3">锁模式</th>
              <th className="text-left px-4 py-3">状态</th>
              <th className="text-left px-4 py-3">触发人</th>
              <th className="text-left px-4 py-3">创建时间</th>
              <th className="text-right px-4 py-3">日志</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {loading && (
              <tr>
                <td colSpan={7}>
                  <LoadingState label="正在加载运维任务..." />
                </td>
              </tr>
            )}
            {!loading && ops.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState title="暂无运维任务记录" description="发起集群部署、升级或节点维护任务后将在此记录。" />
                </td>
              </tr>
            )}
            {!loading &&
              ops.map((t) => (
                <tr key={t.id}>
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs font-medium text-slate-800 dark:text-slate-100">{t.action}</div>
                    {t.error_message && <div className="text-[11px] text-rose-600 dark:text-rose-400 mt-0.5 max-w-md">{t.error_message}</div>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600 dark:text-slate-300">
                    {t.target_type}:{t.target_id}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">{t.lock_mode}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <StatusBadge value={t.status} />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600 dark:text-slate-300">{t.triggered_by}</td>
                  <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {fmtTime(t.created_at)}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <Button size="sm" onClick={() => openTask(t.id, `${t.action} (${t.id})`)}>
                      <Terminal className="h-3.5 w-3.5" />
                      <span>查看详情</span>
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
