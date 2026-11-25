import React, { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOpsDrawer } from '../lib/opsDrawer';
import { Badge, Button, Card, EmptyState, ErrorAlert, Input, Modal, Select, statusTone } from '../components/UI';
import { CodeEditor } from '../components/CodeEditor';

export function IntegrationsPage() {
  const { isAdmin } = useAuth();
  const { openTask } = useOpsDrawer();
  const [items, setItems] = useState<any[]>([]);
  const [clusters, setClusters] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [plan, setPlan] = useState<any>(null);
  const [doctor, setDoctor] = useState<any>(null);
  const [exampleHCL, setExampleHCL] = useState('');
  const [err, setErr] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', nomad_cluster_id: '', vault_cluster_id: '', auth_mount: 'jwt-nomad' });
  const [showRole, setShowRole] = useState(false);
  const [roleForm, setRoleForm] = useState({
    name: '',
    policy_mode: 'explicit',
    policies: 'default',
    bound_namespaces: 'default',
    token_ttl: '1h',
  });

  const load = useCallback(async () => {
    setErr('');
    try {
      const [iRes, cRes] = await Promise.all([apiGet('/api/v1/integrations'), apiGet('/api/v1/clusters')]);
      const list = iRes.integrations || [];
      setItems(list);
      setClusters(cRes.clusters || []);
      if (selected) {
        const fresh = await apiGet(`/api/v1/integrations/${selected.id}`);
        setSelected(fresh.integration);
      } else if (list.length > 0) {
        const fresh = await apiGet(`/api/v1/integrations/${list[0].id}`);
        setSelected(fresh.integration);
      }
    } catch (ex: any) {
      setErr(ex?.message || '加载联动配置失败');
    }
  }, [selected?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectItem = async (id: string) => {
    setPlan(null);
    setDoctor(null);
    setExampleHCL('');
    const res = await apiGet(`/api/v1/integrations/${id}`);
    setSelected(res.integration);
  };

  const createIntegration = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const res = await apiPost('/api/v1/integrations', createForm);
      setShowCreate(false);
      await load();
      if (res.integration?.id) await selectItem(res.integration.id);
    } catch (ex: any) {
      setErr(ex?.message || '创建联动失败');
    }
  };

  const addRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setErr('');
    try {
      await apiPost(`/api/v1/integrations/${selected.id}/roles`, {
        name: roleForm.name,
        policy_mode: roleForm.policy_mode,
        policies: roleForm.policies.split(',').map((s) => s.trim()).filter(Boolean),
        bound_claims: { nomad_namespace: roleForm.bound_namespaces.split(',').map((s) => s.trim()).filter(Boolean) },
        token_ttl: roleForm.token_ttl,
      });
      setShowRole(false);
      await selectItem(selected.id);
    } catch (ex: any) {
      setErr(ex?.message || '保存 Role 失败');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <div className="flex flex-wrap gap-2">
          {items.map((it) => (
            <Button
              key={it.id}
              size="sm"
              variant={selected?.id === it.id ? 'primary' : 'secondary'}
              onClick={() => void selectItem(it.id)}
            >
              {it.name} ({it.status})
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" /> 刷新</Button>
          {isAdmin && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const n = clusters.find((c) => c.type === 'nomad')?.id || '';
                const v = clusters.find((c) => c.type === 'vault')?.id || '';
                setCreateForm({ name: 'nomad-vault', nomad_cluster_id: n, vault_cluster_id: v, auth_mount: 'jwt-nomad' });
                setShowCreate(true);
              }}
            >
              <Plus className="h-3.5 w-3.5" /> 新建联动
            </Button>
          )}
        </div>
      </div>

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {!selected ? (
        <Card><EmptyState text="暂无 Nomad-Vault 联动配置" /></Card>
      ) : (
        <div className="space-y-4">
          <Card
            title={`${selected.name}（${selected.nomad_cluster_name || selected.nomad_cluster_id} ↔ ${selected.vault_cluster_name || selected.vault_cluster_id}）`}
            actions={
              isAdmin && (
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" onClick={() => void apiPost(`/api/v1/integrations/${selected.id}/plan`).then((r) => setPlan(r.plan)).catch((ex) => setErr(ex.message))}>
                    Plan 预览
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() =>
                      void apiPost(`/api/v1/integrations/${selected.id}/apply`)
                        .then((r) => r.task?.id && openTask(r.task.id, `Apply 联动: ${selected.name}`))
                        .catch((ex) => setErr(ex.message))
                    }
                  >
                    一键 Apply
                  </Button>
                  <Button size="sm" onClick={() => void apiPost(`/api/v1/integrations/${selected.id}/doctor`).then((r) => setDoctor(r.report)).catch((ex) => setErr(ex.message))}>
                    四段式体检
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() =>
                      void apiDelete(`/api/v1/integrations/${selected.id}`)
                        .then(() => { setSelected(null); return load(); })
                        .catch((ex) => setErr(ex.message))
                    }
                  >
                    删除
                  </Button>
                </div>
              )
            }
          >
            <div className="mb-3 flex flex-wrap gap-3 text-xs text-slate-600 dark:text-slate-300">
              <span>Auth Mount: <code className="font-mono">{selected.auth_mount}</code></span>
              <span>状态: <Badge tone={statusTone(selected.status)}>{selected.status}</Badge></span>
            </div>

            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold">工作负载 Roles</span>
              {isAdmin && <Button size="sm" onClick={() => setShowRole(true)}><Plus className="h-3 w-3" /> 添加 Role</Button>}
            </div>
            {(selected.roles || []).length === 0 ? (
              <EmptyState text="暂无 Role" />
            ) : (
              <div className="space-y-2 text-xs">
                {selected.roles.map((r: any) => (
                  <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2.5 dark:border-slate-800">
                    <div>
                      <span className="font-mono font-semibold">{r.name}</span>
                      <span className="ml-2 text-slate-500">mode: {r.policy_mode} · policies: {(r.policies || []).join(', ')}</span>
                    </div>
                    {isAdmin && (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          onClick={() =>
                            void apiPost(`/api/v1/integrations/${selected.id}/job-example`, { role_name: r.name })
                              .then((res) => setExampleHCL(res.hcl || ''))
                              .catch((ex) => setErr(ex.message))
                          }
                        >
                          示例 Job
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => void apiDelete(`/api/v1/integrations/${selected.id}/roles/${r.id}`).then(() => selectItem(selected.id))}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {plan && (
            <Card title="联动 Plan 预览" actions={<Button size="sm" onClick={() => setPlan(null)}>关闭</Button>}>
              <pre className="max-h-72 overflow-auto rounded bg-slate-950 p-3 font-mono text-xs text-slate-100">
                {JSON.stringify(plan, null, 2)}
              </pre>
            </Card>
          )}

          {doctor && (
            <Card title="四段式链路体检" actions={<Button size="sm" onClick={() => setDoctor(null)}>关闭</Button>}>
              <div className="space-y-2 text-xs">
                {(doctor.checks || []).map((c: any, i: number) => (
                  <div key={i} className="flex items-center justify-between rounded border border-slate-200 p-2 dark:border-slate-800">
                    <span><b>{c.name}</b>：{c.message}</span>
                    <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {exampleHCL && (
            <Card title="示例 Nomad Job HCL" actions={<Button size="sm" onClick={() => setExampleHCL('')}>关闭</Button>}>
              <CodeEditor value={exampleHCL} readOnly height="260px" />
            </Card>
          )}
        </div>
      )}

      <Modal open={showCreate} title="新建 Nomad-Vault 联动" onClose={() => setShowCreate(false)}>
        <form onSubmit={createIntegration} className="space-y-3 text-xs">
          <Input label="联动名称" required value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} />
          <Select label="Nomad 集群" value={createForm.nomad_cluster_id} onChange={(e) => setCreateForm({ ...createForm, nomad_cluster_id: e.target.value })}>
            {clusters.filter((c) => c.type === 'nomad').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select label="Vault 集群" value={createForm.vault_cluster_id} onChange={(e) => setCreateForm({ ...createForm, vault_cluster_id: e.target.value })}>
            {clusters.filter((c) => c.type === 'vault').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Input label="Vault JWT Auth Mount" required value={createForm.auth_mount} onChange={(e) => setCreateForm({ ...createForm, auth_mount: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setShowCreate(false)}>取消</Button>
            <Button type="submit" variant="primary">创建</Button>
          </div>
        </form>
      </Modal>

      <Modal open={showRole} title="添加工作负载 Role" onClose={() => setShowRole(false)}>
        <form onSubmit={addRole} className="space-y-3 text-xs">
          <Input label="Role 名称" required value={roleForm.name} onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })} />
          <Select label="Policy 模式" value={roleForm.policy_mode} onChange={(e) => setRoleForm({ ...roleForm, policy_mode: e.target.value })}>
            <option value="explicit">explicit（固定策略列表）</option>
            <option value="templated">templated（ACL 模板变量）</option>
          </Select>
          <Input label="Policies（逗号分隔）" required value={roleForm.policies} onChange={(e) => setRoleForm({ ...roleForm, policies: e.target.value })} />
          <Input label="允许的 Nomad Namespaces（逗号分隔）" required value={roleForm.bound_namespaces} onChange={(e) => setRoleForm({ ...roleForm, bound_namespaces: e.target.value })} />
          <Input label="Token TTL" value={roleForm.token_ttl} onChange={(e) => setRoleForm({ ...roleForm, token_ttl: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setShowRole(false)}>取消</Button>
            <Button type="submit" variant="primary">保存</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
