import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiGet, fmtTime } from '../lib/api';
import { useOpsDrawer } from '../lib/opsDrawer';
import { Badge, Button, Card, EmptyState, ErrorAlert, Input, Modal, Select, statusTone } from '../components/UI';

export function AuditPage() {
  const [logs, setLogs] = useState<any[]>([]);
  const [action, setAction] = useState('');
  const [result, setResult] = useState('');
  const [keyword, setKeyword] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const [err, setErr] = useState('');
  const { openTask } = useOpsDrawer();

  const load = useCallback(async () => {
    setErr('');
    try {
      const q = new URLSearchParams({ limit: '100' });
      if (action.trim()) q.set('action', action.trim());
      if (result) q.set('result', result);
      if (keyword.trim()) q.set('q', keyword.trim());
      const res = await apiGet(`/api/v1/audit-logs?${q.toString()}`);
      setLogs(res.audit_logs || []);
    } catch (ex: any) {
      setErr(ex?.message || '加载审计日志失败');
    }
  }, [action, result, keyword]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Input placeholder="动作过滤（如 auth.login）" value={action} onChange={(e) => setAction(e.target.value)} />
          <Select value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="">全部结果</option>
            <option value="success">success</option>
            <option value="failed">failed</option>
          </Select>
          <Input placeholder="关键字搜索" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" /> 检索
            </Button>
          </div>
        </div>
      </Card>

      <ErrorAlert message={err} onClose={() => setErr('')} />

      <Card>
        {logs.length === 0 ? (
          <EmptyState text="无匹配审计记录" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">时间</th>
                  <th className="py-2 pr-3">操作人 / IP</th>
                  <th className="py-2 pr-3">动作</th>
                  <th className="py-2 pr-3">资源</th>
                  <th className="py-2 pr-3">结果</th>
                  <th className="py-2 text-right">详情</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="py-2 pr-3 whitespace-nowrap">{fmtTime(l.created_at)}</td>
                    <td className="py-2 pr-3">
                      <div className="font-medium">{l.actor_name || '-'}</div>
                      <div className="font-mono text-[11px] text-slate-500">{l.client_ip}</div>
                    </td>
                    <td className="py-2 pr-3 font-mono">{l.action}</td>
                    <td className="py-2 pr-3">
                      {l.resource_type} {l.resource_name || l.resource_id}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge tone={statusTone(l.result)}>{l.result}</Badge>
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex justify-end gap-1">
                        {l.operation_task_id && (
                          <Button size="sm" onClick={() => openTask(l.operation_task_id)}>
                            任务日志
                          </Button>
                        )}
                        <Button size="sm" onClick={() => setDetail(l)}>
                          摘要
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={Boolean(detail)} title={`审计详情：${detail?.action}`} onClose={() => setDetail(null)}>
        {detail && (
          <div className="space-y-3 text-xs">
            {detail.error_message && <ErrorAlert message={detail.error_message} />}
            <pre className="max-h-96 overflow-auto rounded bg-slate-950 p-3 font-mono text-slate-100">
              {JSON.stringify(detail.request_summary, null, 2)}
            </pre>
          </div>
        )}
      </Modal>
    </div>
  );
}
