import React, { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Input,
  LoadingState,
  Modal,
  PageHeader,
  PasswordConfirmModal,
  SecretInput,
  Select,
  StatusBadge,
} from '../components/UI';

export function AccountsPage() {
  const { isAdmin, user } = useAuth();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<any[]>([]);
  const [admins, setAdmins] = useState<any[]>([]);
  const [err, setErr] = useState('');

  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [newAdmin, setNewAdmin] = useState({ username: '', password: '', role: 'viewer' });
  const [pwAction, setPwAction] = useState<{ title: string; run: (pw: string) => Promise<void> } | null>(null);
  const [resetTarget, setResetTarget] = useState<{ id: string; username: string; password: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const sRes = await apiGet('/api/v1/auth/sessions');
      setSessions(sRes.sessions || []);
      if (isAdmin) {
        const aRes = await apiGet('/api/v1/admins');
        setAdmins(aRes.admins || []);
      }
    } catch (ex: any) {
      setErr(ex?.message || '加载账号与会话失败');
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeOwnPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      await apiPut('/api/v1/auth/password', { current_password: curPw, new_password: newPw });
      setCurPw('');
      setNewPw('');
      toast.success('密码修改成功，其他设备会话已自动注销');
      await load();
    } catch (ex: any) {
      toast.error(ex?.message || '改密失败');
    }
  };

  const revokeSession = async (s: any) => {
    if (
      s.current &&
      !(await askConfirm('注销当前会话将立即退出登录，确认继续吗？', {
        title: '注销当前会话',
        confirmText: '确认注销',
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await apiDelete(`/api/v1/auth/sessions/${s.id}`);
      toast.success('会话已注销');
      await load();
    } catch (ex: any) {
      toast.error(ex?.message || '注销会话失败');
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="账号与会话"
        subtitle="修改当前登录密码、管理各设备活跃会话及配置管理员与只读运维账号"
        actions={
          <Button onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </Button>
        }
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {loading ? (
        <LoadingState label="正在加载账号与会话..." />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card title={`修改当前账号密码 (${user?.username})`}>
              <form onSubmit={changeOwnPassword} className="space-y-4">
                <SecretInput label="当前密码" required value={curPw} onChangeValue={setCurPw} />
                <SecretInput label="新密码（至少 10 位）" required minLength={10} value={newPw} onChangeValue={setNewPw} />
                <div className="flex justify-end pt-1">
                  <Button type="submit" variant="primary">修改密码</Button>
                </div>
              </form>
            </Card>

            <Card title="活跃会话">
              {sessions.length === 0 ? (
                <EmptyState title="无活跃会话" description="当前账号没有其它活跃的登录会话。" />
              ) : (
                <div className="space-y-2.5 text-xs">
                  {sessions.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-800 p-3 bg-slate-50/50 dark:bg-slate-800/40"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-mono">
                          <span className="font-medium text-slate-800 dark:text-slate-100">{s.client_ip || '-'}</span>
                          {s.current && <Badge tone="green">当前会话</Badge>}
                        </div>
                        <div className="truncate text-slate-500 dark:text-slate-400 mt-0.5">
                          最后活跃：{fmtTime(s.last_seen_at)} · 过期：{fmtTime(s.expires_at)}
                        </div>
                      </div>
                      <Button size="sm" onClick={() => void revokeSession(s)}>
                        注销
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {isAdmin && (
            <Card
              title="管理员与只读账号"
              actions={
                <Button size="sm" variant="primary" onClick={() => setShowCreate(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  <span>新增账号</span>
                </Button>
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                      <th className="py-2.5 pr-3">用户名</th>
                      <th className="py-2.5 pr-3">角色</th>
                      <th className="py-2.5 pr-3">状态</th>
                      <th className="py-2.5 pr-3">最近登录</th>
                      <th className="py-2.5 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {admins.map((a) => (
                      <tr key={a.id}>
                        <td className="py-3 pr-3 font-medium text-slate-900 dark:text-slate-100">{a.username}</td>
                        <td className="py-3 pr-3">
                          <Badge tone={a.role === 'admin' ? 'blue' : 'neutral'}>{a.role === 'admin' ? '系统管理员' : '只读运维'}</Badge>
                        </td>
                        <td className="py-3 pr-3">
                          <StatusBadge value={a.disabled ? 'disabled' : 'enabled'} label={a.disabled ? '已停用' : '启用'} />
                        </td>
                        <td className="py-3 pr-3 text-slate-500 dark:text-slate-400">{fmtTime(a.last_login_at)}</td>
                        <td className="py-3 text-right">
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <Button
                              size="sm"
                              onClick={() => {
                                const nextRole = a.role === 'admin' ? 'viewer' : 'admin';
                                const nextRoleLabel = nextRole === 'admin' ? '系统管理员' : '只读运维';
                                setPwAction({
                                  title: `将 ${a.username} 角色改为 ${nextRoleLabel}`,
                                  run: async (pw) => {
                                    await apiPut(`/api/v1/admins/${a.id}/role`, { role: nextRole, current_password: pw });
                                    toast.success(`已将 ${a.username} 切换为 ${nextRoleLabel}`);
                                    await load();
                                  },
                                });
                              }}
                            >
                              {a.role === 'admin' ? '设为只读' : '设为管理员'}
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => setResetTarget({ id: a.id, username: a.username, password: '' })}
                            >
                              重置密码
                            </Button>
                            <Button
                              size="sm"
                              variant={a.disabled ? 'primary' : 'danger-outline'}
                              disabled={!a.disabled && a.username === user?.username}
                              title={!a.disabled && a.username === user?.username ? '不能停用当前登录账号' : undefined}
                              onClick={() => {
                                const act = a.disabled ? 'enable' : 'disable';
                                setPwAction({
                                  title: `${a.disabled ? '启用' : '停用'}账号 ${a.username}`,
                                  run: async (pw) => {
                                    await apiPost(`/api/v1/admins/${a.id}/${act}`, { current_password: pw });
                                    toast.success(`已${a.disabled ? '启用' : '停用'}账号 ${a.username}`);
                                    await load();
                                  },
                                });
                              }}
                            >
                              {a.disabled ? '启用' : '停用'}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      <Modal open={showCreate} title="新增控制台账号" onClose={() => setShowCreate(false)}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setShowCreate(false);
            setPwAction({
              title: `创建账号 ${newAdmin.username}`,
              run: async (pw) => {
                await apiPost('/api/v1/admins', { ...newAdmin, current_password: pw });
                setNewAdmin({ username: '', password: '', role: 'viewer' });
                toast.success(`已创建账号 ${newAdmin.username}`);
                await load();
              },
            });
          }}
          className="space-y-4"
        >
          <Input label="用户名" required value={newAdmin.username} onChange={(e) => setNewAdmin({ ...newAdmin, username: e.target.value })} />
          <SecretInput label="初始密码（至少 10 位）" required minLength={10} value={newAdmin.password} onChangeValue={(v) => setNewAdmin({ ...newAdmin, password: v })} />
          <Select label="角色" value={newAdmin.role} onChange={(e) => setNewAdmin({ ...newAdmin, role: e.target.value })}>
            <option value="viewer">viewer（只读运维）</option>
            <option value="admin">admin（完全控制）</option>
          </Select>
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setShowCreate(false)}>取消</Button>
            <Button type="submit" variant="primary">下一步：密码验证</Button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(resetTarget)} title={`重置 ${resetTarget?.username} 密码`} onClose={() => setResetTarget(null)}>
        {resetTarget && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const target = resetTarget;
              setResetTarget(null);
              setPwAction({
                title: `确认重置 ${target.username} 密码`,
                run: async (pw) => {
                  await apiPost(`/api/v1/admins/${target.id}/reset-password`, {
                    new_password: target.password,
                    current_password: pw,
                  });
                  toast.success(`已重置 ${target.username} 的登录密码`);
                  await load();
                },
              });
            }}
            className="space-y-4"
          >
            <SecretInput
              label="新密码（至少 10 位）"
              required
              minLength={10}
              value={resetTarget.password}
              onChangeValue={(v) => setResetTarget({ ...resetTarget, password: v })}
            />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setResetTarget(null)}>取消</Button>
              <Button type="submit" variant="primary">下一步</Button>
            </div>
          </form>
        )}
      </Modal>

      <PasswordConfirmModal
        open={Boolean(pwAction)}
        title={pwAction?.title || ''}
        onClose={() => setPwAction(null)}
        onConfirm={async (pw) => {
          if (pwAction) await pwAction.run(pw);
        }}
      />
    </div>
  );
}
