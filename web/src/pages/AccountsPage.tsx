import React, { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
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
  const { locale, tr } = useI18n();
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
      setErr(ex?.message || tr('加载账号与会话失败', 'Failed to load accounts & sessions'));
    } finally {
      setLoading(false);
    }
  }, [isAdmin, tr]);

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
      toast.success(tr('密码修改成功，其他设备会话已自动注销', 'Password updated; other device sessions were revoked'));
      await load();
    } catch (ex: any) {
      toast.error(ex?.message || tr('改密失败', 'Failed to change password'));
    }
  };

  const revokeSession = async (s: any) => {
    if (
      s.current &&
      !(await askConfirm(tr('注销当前会话将立即退出登录，确认继续吗？', 'Revoking your current session will sign you out immediately. Continue?'), {
        title: tr('注销当前会话', 'Revoke Current Session'),
        confirmText: tr('确认注销', 'Revoke'),
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await apiDelete(`/api/v1/auth/sessions/${s.id}`);
      toast.success(tr('会话已注销', 'Session revoked'));
      await load();
    } catch (ex: any) {
      toast.error(ex?.message || tr('注销会话失败', 'Failed to revoke session'));
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={tr('账号与会话', 'Accounts & Sessions')}
        subtitle={tr('修改当前登录密码、管理各设备活跃会话及配置管理员与只读运维账号', 'Update your password, manage active sessions, and configure admin or read-only accounts')}
        actions={
          <Button onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            <span>{tr('刷新', 'Refresh')}</span>
          </Button>
        }
      />

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {loading ? (
        <LoadingState label={tr('正在加载账号与会话...', 'Loading accounts & sessions...')} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card title={tr(`修改当前账号密码 (${user?.username})`, `Change Password (${user?.username})`)}>
              <form onSubmit={changeOwnPassword} className="space-y-4">
                <SecretInput label={tr('当前密码', 'Current Password')} required value={curPw} onChangeValue={setCurPw} />
                <SecretInput label={tr('新密码（至少 10 位）', 'New Password (min 10 chars)')} required minLength={10} value={newPw} onChangeValue={setNewPw} />
                <div className="flex justify-end pt-1">
                  <Button type="submit" variant="primary">{tr('修改密码', 'Update Password')}</Button>
                </div>
              </form>
            </Card>

            <Card title={tr('活跃会话', 'Active Sessions')}>
              {sessions.length === 0 ? (
                <EmptyState title={tr('无活跃会话', 'No Active Sessions')} description={tr('当前账号没有其它活跃的登录会话。', 'No other active login sessions for this account.')} />
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
                          {s.current && <Badge tone="green">{tr('当前会话', 'Current')}</Badge>}
                        </div>
                        <div className="truncate text-slate-500 dark:text-slate-400 mt-0.5">
                          {tr('最后活跃：', 'Last seen: ')}{fmtTime(s.last_seen_at, locale)} · {tr('过期：', 'Expires: ')}{fmtTime(s.expires_at, locale)}
                        </div>
                      </div>
                      <Button size="sm" onClick={() => void revokeSession(s)}>
                        {tr('注销', 'Revoke')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {isAdmin && (
            <Card
              title={tr('管理员与只读账号', 'Admin & Read-Only Accounts')}
              actions={
                <Button size="sm" variant="primary" onClick={() => setShowCreate(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  <span>{tr('新增账号', 'Add Account')}</span>
                </Button>
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                      <th className="py-2.5 pr-3">{tr('用户名', 'Username')}</th>
                      <th className="py-2.5 pr-3">{tr('角色', 'Role')}</th>
                      <th className="py-2.5 pr-3">{tr('状态', 'Status')}</th>
                      <th className="py-2.5 pr-3">{tr('最近登录', 'Last Login')}</th>
                      <th className="py-2.5 text-right">{tr('操作', 'Actions')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {admins.map((a) => (
                      <tr key={a.id}>
                        <td className="py-3 pr-3 font-medium text-slate-900 dark:text-slate-100">{a.username}</td>
                        <td className="py-3 pr-3">
                          <Badge tone={a.role === 'admin' ? 'blue' : 'neutral'}>{a.role === 'admin' ? tr('系统管理员', 'Administrator') : tr('只读运维', 'Read-only')}</Badge>
                        </td>
                        <td className="py-3 pr-3">
                          <StatusBadge value={a.disabled ? 'disabled' : 'enabled'} label={a.disabled ? tr('已停用', 'Disabled') : tr('启用', 'Enabled')} />
                        </td>
                        <td className="py-3 pr-3 text-slate-500 dark:text-slate-400">{fmtTime(a.last_login_at, locale)}</td>
                        <td className="py-3 text-right">
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <Button
                              size="sm"
                              onClick={() => {
                                const nextRole = a.role === 'admin' ? 'viewer' : 'admin';
                                const nextRoleLabel = nextRole === 'admin' ? tr('系统管理员', 'Administrator') : tr('只读运维', 'Read-only');
                                setPwAction({
                                  title: tr(`将 ${a.username} 角色改为 ${nextRoleLabel}`, `Change ${a.username} role to ${nextRoleLabel}`),
                                  run: async (pw) => {
                                    await apiPut(`/api/v1/admins/${a.id}/role`, { role: nextRole, current_password: pw });
                                    toast.success(tr(`已将 ${a.username} 切换为 ${nextRoleLabel}`, `Switched ${a.username} to ${nextRoleLabel}`));
                                    await load();
                                  },
                                });
                              }}
                            >
                              {a.role === 'admin' ? tr('设为只读', 'Set Read-only') : tr('设为管理员', 'Set Admin')}
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => setResetTarget({ id: a.id, username: a.username, password: '' })}
                            >
                              {tr('重置密码', 'Reset Password')}
                            </Button>
                            <Button
                              size="sm"
                              variant={a.disabled ? 'primary' : 'danger-outline'}
                              disabled={!a.disabled && a.username === user?.username}
                              title={!a.disabled && a.username === user?.username ? tr('不能停用当前登录账号', 'Cannot disable current signed-in account') : undefined}
                              onClick={() => {
                                const act = a.disabled ? 'enable' : 'disable';
                                setPwAction({
                                  title: tr(`${a.disabled ? '启用' : '停用'}账号 ${a.username}`, `${a.disabled ? 'Enable' : 'Disable'} account ${a.username}`),
                                  run: async (pw) => {
                                    await apiPost(`/api/v1/admins/${a.id}/${act}`, { current_password: pw });
                                    toast.success(tr(`已${a.disabled ? '启用' : '停用'}账号 ${a.username}`, `${a.disabled ? 'Enabled' : 'Disabled'} account ${a.username}`));
                                    await load();
                                  },
                                });
                              }}
                            >
                              {a.disabled ? tr('启用', 'Enable') : tr('停用', 'Disable')}
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

      <Modal open={showCreate} title={tr('新增控制台账号', 'New Console Account')} onClose={() => setShowCreate(false)}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setShowCreate(false);
            setPwAction({
              title: tr(`创建账号 ${newAdmin.username}`, `Create account ${newAdmin.username}`),
              run: async (pw) => {
                await apiPost('/api/v1/admins', { ...newAdmin, current_password: pw });
                setNewAdmin({ username: '', password: '', role: 'viewer' });
                toast.success(tr(`已创建账号 ${newAdmin.username}`, `Created account ${newAdmin.username}`));
                await load();
              },
            });
          }}
          className="space-y-4"
        >
          <Input label={tr('用户名', 'Username')} required value={newAdmin.username} onChange={(e) => setNewAdmin({ ...newAdmin, username: e.target.value })} />
          <SecretInput label={tr('初始密码（至少 10 位）', 'Initial Password (min 10 chars)')} required minLength={10} value={newAdmin.password} onChangeValue={(v) => setNewAdmin({ ...newAdmin, password: v })} />
          <Select label={tr('角色', 'Role')} value={newAdmin.role} onChange={(e) => setNewAdmin({ ...newAdmin, role: e.target.value })}>
            <option value="viewer">{tr('viewer（只读运维）', 'viewer (Read-only)')}</option>
            <option value="admin">{tr('admin（完全控制）', 'admin (Full Control)')}</option>
          </Select>
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setShowCreate(false)}>{tr('取消', 'Cancel')}</Button>
            <Button type="submit" variant="primary">{tr('下一步：密码验证', 'Next: Verify Password')}</Button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(resetTarget)} title={tr(`重置 ${resetTarget?.username} 密码`, `Reset Password for ${resetTarget?.username}`)} onClose={() => setResetTarget(null)}>
        {resetTarget && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const target = resetTarget;
              setResetTarget(null);
              setPwAction({
                title: tr(`确认重置 ${target.username} 密码`, `Confirm password reset for ${target.username}`),
                run: async (pw) => {
                  await apiPost(`/api/v1/admins/${target.id}/reset-password`, {
                    new_password: target.password,
                    current_password: pw,
                  });
                  toast.success(tr(`已重置 ${target.username} 的登录密码`, `Reset password for ${target.username}`));
                  await load();
                },
              });
            }}
            className="space-y-4"
          >
            <SecretInput
              label={tr('新密码（至少 10 位）', 'New Password (min 10 chars)')}
              required
              minLength={10}
              value={resetTarget.password}
              onChangeValue={(v) => setResetTarget({ ...resetTarget, password: v })}
            />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setResetTarget(null)}>{tr('取消', 'Cancel')}</Button>
              <Button type="submit" variant="primary">{tr('下一步', 'Next')}</Button>
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
