import React, { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut, fmtTime } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, EmptyState, ErrorAlert, Input, Modal, PasswordConfirmModal, SecretInput, Select } from '../components/UI';

export function AccountsPage() {
  const { isAdmin, user } = useAuth();
  const [sessions, setSessions] = useState<any[]>([]);
  const [admins, setAdmins] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [newAdmin, setNewAdmin] = useState({ username: '', password: '', role: 'viewer' });
  const [pwAction, setPwAction] = useState<{ title: string; run: (pw: string) => Promise<void> } | null>(null);
  const [resetTarget, setResetTarget] = useState<{ id: string; username: string; password: string } | null>(null);

  const load = useCallback(async () => {
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
      setNotice('密码修改成功，其他设备会话已自动注销。');
      await load();
    } catch (ex: any) {
      setErr(ex?.message || '改密失败');
    }
  };

  return (
    <div className="space-y-5">
      <ErrorAlert message={err} onClose={() => setErr('')} />
      {notice && (
        <div className="rounded-md bg-emerald-50 px-3.5 py-2 text-xs text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
          {notice}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card title={`修改当前账号密码 (${user?.username})`}>
          <form onSubmit={changeOwnPassword} className="space-y-3">
            <SecretInput label="当前密码" required value={curPw} onChangeValue={setCurPw} />
            <SecretInput label="新密码" required value={newPw} onChangeValue={setNewPw} />
            <Button type="submit" variant="primary">修改密码</Button>
          </form>
        </Card>

        <Card
          title="活跃会话"
          actions={
            <Button size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" /> 刷新
            </Button>
          }
        >
          {sessions.length === 0 ? (
            <EmptyState text="无活跃会话" />
          ) : (
            <div className="space-y-2 text-xs">
              {sessions.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 rounded border border-slate-200 p-2.5 dark:border-slate-800">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-mono">
                      <span>{s.client_ip || '-'}</span>
                      {s.current && <Badge tone="green">当前会话</Badge>}
                    </div>
                    <div className="truncate text-slate-500">
                      最后活跃：{fmtTime(s.last_seen_at)} · 过期：{fmtTime(s.expires_at)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() =>
                      void apiDelete(`/api/v1/auth/sessions/${s.id}`)
                        .then(() => load())
                        .catch((ex) => setErr(ex.message))
                    }
                  >
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
              <Plus className="h-3.5 w-3.5" /> 新增账号
            </Button>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                  <th className="py-2 pr-3">用户名</th>
                  <th className="py-2 pr-3">角色</th>
                  <th className="py-2 pr-3">状态</th>
                  <th className="py-2 pr-3">最近登录</th>
                  <th className="py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {admins.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2 pr-3 font-medium">{a.username}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={a.role === 'admin' ? 'blue' : 'neutral'}>{a.role}</Badge>
                    </td>
                    <td className="py-2 pr-3">
                      <Badge tone={a.disabled ? 'red' : 'green'}>{a.disabled ? '已停用' : '启用'}</Badge>
                    </td>
                    <td className="py-2 pr-3">{fmtTime(a.last_login_at)}</td>
                    <td className="py-2 text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button
                          size="sm"
                          onClick={() => {
                            const nextRole = a.role === 'admin' ? 'viewer' : 'admin';
                            setPwAction({
                              title: `将 ${a.username} 角色改为 ${nextRole}`,
                              run: async (pw) => {
                                await apiPut(`/api/v1/admins/${a.id}/role`, { role: nextRole, current_password: pw });
                                await load();
                              },
                            });
                          }}
                        >
                          切换为 {a.role === 'admin' ? 'viewer' : 'admin'}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => setResetTarget({ id: a.id, username: a.username, password: '' })}
                        >
                          重置密码
                        </Button>
                        <Button
                          size="sm"
                          variant={a.disabled ? 'primary' : 'danger'}
                          onClick={() => {
                            const act = a.disabled ? 'enable' : 'disable';
                            setPwAction({
                              title: `${a.disabled ? '启用' : '停用'}账号 ${a.username}`,
                              run: async (pw) => {
                                await apiPost(`/api/v1/admins/${a.id}/${act}`, { current_password: pw });
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
                await load();
              },
            });
          }}
          className="space-y-3"
        >
          <Input label="用户名" required value={newAdmin.username} onChange={(e) => setNewAdmin({ ...newAdmin, username: e.target.value })} />
          <SecretInput label="初始密码" required value={newAdmin.password} onChangeValue={(v) => setNewAdmin({ ...newAdmin, password: v })} />
          <Select label="角色" value={newAdmin.role} onChange={(e) => setNewAdmin({ ...newAdmin, role: e.target.value })}>
            <option value="viewer">viewer（只读运维）</option>
            <option value="admin">admin（完全控制）</option>
          </Select>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => setShowCreate(false)}>取消</Button>
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
                  await load();
                },
              });
            }}
            className="space-y-3"
          >
            <SecretInput
              label="新密码"
              required
              value={resetTarget.password}
              onChangeValue={(v) => setResetTarget({ ...resetTarget, password: v })}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={() => setResetTarget(null)}>取消</Button>
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
