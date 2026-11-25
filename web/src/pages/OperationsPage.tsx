import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Terminal } from 'lucide-react';
import { apiGet, fmtTime } from '../lib/api';
import { useOpsDrawer } from '../lib/opsDrawer';
import { Badge, Button, Card, EmptyState, ErrorAlert, Select, statusTone } from '../components/UI';

export function OperationsPage() {
  const [ops, setOps] = useState<any[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [err, setErr] = useState('');
  const { openTask } = useOpsDrawer();

  const load = useCallback(async () => {
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
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="w-48">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">全部状态</option>
            <option value="needs_reconcile">needs_reconcile（待核对）</option>
            <option value="running">running</option>
            <option value="pending">pending</option>
            <option value="success">success</option>
            <option value="failed">failed</option>
            <option value="rolled_back">rolled_back</option>
          </Select>
        </div>
        <Button size="sm" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5" />
          <span>刷新</span>
        </Button>
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />

      <Card>
        {ops.length === 0 ? (
          <EmptyState text="暂无运维任务记录" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">动作</th>
                  <th className="py-2 pr-3">目标</th>
                  <th className="py-2 pr-3">锁模式</th>
                  <th className="py-2 pr-3">状态</th>
                  <th className="py-2 pr-3">触发人</th>
                  <th className="py-2 pr-3">创建时间</th>
                  <th className="py-2 text-right">日志</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {ops.map((t) => (
                  <tr key={t.id}>
                    <td className="py-2 pr-3">
                      <div className="font-mono font-medium">{t.action}</div>
                      {t.error_message && <div className="text-[11px] text-rose-600">{t.error_message}</div>}
                    </td>
                    <td className="py-2 pr-3 font-mono">{t.target_type}:{t.target_id}</td>
                    <td className="py-2 pr-3">{t.lock_mode}</td>
                    <td className="py-2 pr-3"><Badge tone={statusTone(t.status)}>{t.status}</Badge></td>
                    <td className="py-2 pr-3">{t.triggered_by}</td>
                    <td className="py-2 pr-3">{fmtTime(t.created_at)}</td>
                    <td className="py-2 text-right">
                      <Button size="sm" onClick={() => openTask(t.id, `${t.action} (${t.id})`)}>
                        <Terminal className="h-3 w-3" /> 查看详情
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
