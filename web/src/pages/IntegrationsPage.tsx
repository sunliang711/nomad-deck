import React, { useCallback, useEffect, useState } from 'react';
import { Link2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOpsDrawer } from '../lib/opsDrawer';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import {
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Input,
  Modal,
  PageHeader,
  Select,
  StatusBadge,
  TermLabel,
} from '../components/UI';
import { CodeEditor } from '../components/CodeEditor';

export function IntegrationsPage() {
  const { isAdmin } = useAuth();
  const { openTask } = useOpsDrawer();
  const toast = useToast();
  const askConfirm = useConfirm();

  const [items, setItems] = useState<any[]>([]);
  const [clusters, setClusters] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [plan, setPlan] = useState<any>(null);
  const [doctor, setDoctor] = useState<any>(null);
  const [exampleHCL, setExampleHCL] = useState('');
  const [err, setErr] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', source_cluster_id: '', target_cluster_id: '', auth_path: 'jwt-nomad' });
  const [showRole, setShowRole] = useState(false);
  const [roleForm, setRoleForm] = useState({
    role_name: '',
    policy_mode: 'explicit',
    secret_paths: 'secret/data/*',
    bound_namespace: 'default',
    token_period: '1h',
  });

  const load = useCallback(async (focusId?: string) => {
    setErr('');
    try {
      const [iRes, cRes] = await Promise.all([apiGet('/api/v1/integrations'), apiGet('/api/v1/clusters')]);
      const list = iRes.integrations || [];
      setItems(list);
      setClusters(cRes.clusters || []);
      const targetId = focusId || list[0]?.id;
      if (targetId) {
        const fresh = await apiGet(`/api/v1/integrations/${targetId}`);
        setSelected(fresh.integration);
      } else {
        setSelected(null);
      }
    } catch (ex: any) {
      setErr(ex?.message || '加载联动配置失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectItem = async (id: string) => {
    setErr('');
    setPlan(null);
    setDoctor(null);
    setExampleHCL('');
    try {
      const res = await apiGet(`/api/v1/integrations/${id}`);
      setSelected(res.integration);
    } catch (ex: any) {
      setErr(ex?.message || '加载联动详情失败');
    }
  };

  const createIntegration = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const nomadDefault = clusters.find((c) => c.type === 'nomad')?.id || '';
      const vaultDefault = clusters.find((c) => c.type === 'vault')?.id || '';
      const res = await apiPost('/api/v1/integrations', {
        ...createForm,
        source_cluster_id: createForm.source_cluster_id || nomadDefault,
        target_cluster_id: createForm.target_cluster_id || vaultDefault,
      });
      setShowCreate(false);
      toast.success(`已创建联动 ${createForm.name}`);
      await load(res.integration?.id);
    } catch (ex: any) {
      toast.error(ex?.message || '创建联动失败');
    }
  };

  const addRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setErr('');
    try {
      await apiPost(`/api/v1/integrations/${selected.id}/roles`, {
        role_name: roleForm.role_name,
        policy_mode: roleForm.policy_mode,
        secret_paths: roleForm.secret_paths
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        bound_claims: { nomad_namespace: roleForm.bound_namespace.trim() },
        token_period: roleForm.token_period,
      });
      setShowRole(false);
      toast.success(`已保存工作负载 Role ${roleForm.role_name}`);
      await selectItem(selected.id);
    } catch (ex: any) {
      toast.error(ex?.message || '保存 Role 失败');
    }
  };

  const deleteIntegration = async () => {
    if (!selected) return;
    if (
      !(await askConfirm(`确定要删除联动配置「${selected.name}」吗？`, {
        title: '删除集群联动',
        confirmText: '确认删除',
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await apiDelete(`/api/v1/integrations/${selected.id}`);
      setSelected(null);
      toast.success('联动配置已删除');
      await load();
    } catch (ex: any) {
      toast.error(ex?.message || '删除联动失败');
    }
  };

  const deleteRole = async (r: any) => {
    if (!selected) return;
    if (
      !(await askConfirm(`确认删除工作负载 Role「${r.role_name}」吗？`, {
        title: '删除 Role',
        confirmText: '确认删除',
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await apiDelete(`/api/v1/integrations/${selected.id}/roles/${r.id}`);
      toast.success(`已删除 Role ${r.role_name}`);
      await selectItem(selected.id);
    } catch (ex: any) {
      toast.error(ex?.message || '删除 Role 失败');
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="集群联动"
        subtitle="配置 Nomad 与 Vault 之间的 JWT Workload Identity 双向信任、角色策略与四段式链路体检"
        actions={
          <>
            <Button onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" />
              <span>刷新</span>
            </Button>
            {isAdmin && (
              <Button
                variant="primary"
                onClick={() => {
                  const n = clusters.find((c) => c.type === 'nomad')?.id || '';
                  const v = clusters.find((c) => c.type === 'vault')?.id || '';
                  setCreateForm({ name: 'nomad-vault', source_cluster_id: n, target_cluster_id: v, auth_path: 'jwt-nomad' });
                  setShowCreate(true);
                }}
              >
                <Plus className="h-4 w-4" />
                <span>新建联动</span>
              </Button>
            )}
          </>
        }
      />

      {items.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {items.map((it) => (
            <Button
              key={it.id}
              size="sm"
              variant={selected?.id === it.id ? 'primary' : 'secondary'}
              onClick={() => void selectItem(it.id)}
            >
              <span>{it.name}</span>
              <span className="opacity-75">({it.status})</span>
            </Button>
          ))}
        </div>
      )}

      <ErrorAlert message={err} onClose={() => setErr('')} />

      {!selected ? (
        <Card>
          <EmptyState
            icon={<Link2 className="w-6 h-6" />}
            title="暂无 Nomad-Vault 联动配置"
            description="创建联动后即可一键打通 Nomad JWKS 与 Vault JWT Auth，并生成工作负载示例。"
          />
        </Card>
      ) : (
        <div className="space-y-4">
          <Card
            title={`${selected.name}（${selected.source_cluster || selected.source_cluster_id} ↔ ${selected.target_cluster || selected.target_cluster_id}）`}
            actions={
              isAdmin && (
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    onClick={() =>
                      void apiPost(`/api/v1/integrations/${selected.id}/plan`, {})
                        .then((r) => setPlan(r.plan))
                        .catch((ex) => toast.error(ex.message))
                    }
                  >
                    <TermLabel term="Plan 预览" tip="对比 Nomad JWKS、Vault JWT Auth 挂载、Role 与 Policy 期望状态与当前线上状态的差异。" />
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() =>
                      void apiPost(`/api/v1/integrations/${selected.id}/apply`, {})
                        .then((r) => r.task?.id && openTask(r.task.id, `Apply 联动: ${selected.name}`))
                        .catch((ex) => toast.error(ex.message))
                    }
                  >
                    一键 Apply
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      void apiPost(`/api/v1/integrations/${selected.id}/doctor`, {})
                        .then((r) => setDoctor(r.report))
                        .catch((ex) => toast.error(ex.message))
                    }
                  >
                    <TermLabel term="四段式体检" tip="依次检验 Nomad JWKS 公钥可达性、Vault JWT Auth 配置、工作负载 Role 绑定和签名签发链路。" />
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void deleteIntegration()}>
                    删除
                  </Button>
                </div>
              )
            }
          >
            <div className="mb-4 flex flex-wrap items-center gap-4 text-xs text-slate-600 dark:text-slate-300">
              <span>
                <TermLabel term="Auth Mount" tip="Vault 中启用 JWT 认证引擎的挂载路径，用于校验 Nomad 签发给工作负载的身份 JWT（OIDC / JWKS）。" />:{' '}
                <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{selected.auth_path}</code>
              </span>
              <span className="inline-flex items-center gap-1.5">
                状态: <StatusBadge value={selected.status} />
              </span>
            </div>

            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">工作负载 Roles</span>
              {isAdmin && (
                <Button size="sm" onClick={() => setShowRole(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  <span>添加 Role</span>
                </Button>
              )}
            </div>
            {(selected.roles || []).length === 0 ? (
              <EmptyState title="暂无 Role" description="添加至少一个工作负载 Role 以绑定 Vault Policy 和 Secret 路径。" />
            ) : (
              <div className="space-y-2 text-xs">
                {selected.roles.map((r: any) => (
                  <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                    <div>
                      <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">{r.role_name}</span>
                      <span className="ml-2 text-slate-500">
                        mode: {r.policy_mode} · paths: {(r.secret_paths || []).join(', ')}
                      </span>
                    </div>
                    {isAdmin && (
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          onClick={() =>
                            void apiPost(`/api/v1/integrations/${selected.id}/job-example`, { role: r.role_name })
                              .then((res) => setExampleHCL(res.hcl || ''))
                              .catch((ex) => toast.error(ex.message))
                          }
                        >
                          示例 Job
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => void deleteRole(r)}>
                          <Trash2 className="h-3.5 w-3.5" />
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
              <pre className="max-h-72 overflow-auto rounded-xl bg-slate-950 p-4 font-mono text-xs text-slate-100">
                {JSON.stringify(plan, null, 2)}
              </pre>
            </Card>
          )}

          {doctor && (
            <Card title="四段式链路体检" actions={<Button size="sm" onClick={() => setDoctor(null)}>关闭</Button>}>
              <div className="space-y-2 text-xs">
                {(doctor.checks || []).map((c: any, i: number) => (
                  <div key={i} className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                    <span><b>{c.name}</b>：{c.message}</span>
                    <StatusBadge value={c.status} />
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
          <Select label="Nomad 集群" value={createForm.source_cluster_id || clusters.find((c) => c.type === 'nomad')?.id || ''} onChange={(e) => setCreateForm({ ...createForm, source_cluster_id: e.target.value })}>
            {clusters.filter((c) => c.type === 'nomad').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select label="Vault 集群" value={createForm.target_cluster_id || clusters.find((c) => c.type === 'vault')?.id || ''} onChange={(e) => setCreateForm({ ...createForm, target_cluster_id: e.target.value })}>
            {clusters.filter((c) => c.type === 'vault').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Input label="Vault JWT Auth Mount" required value={createForm.auth_path} onChange={(e) => setCreateForm({ ...createForm, auth_path: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setShowCreate(false)}>取消</Button>
            <Button type="submit" variant="primary">创建</Button>
          </div>
        </form>
      </Modal>

      <Modal open={showRole} title="添加工作负载 Role" onClose={() => setShowRole(false)}>
        <form onSubmit={addRole} className="space-y-3 text-xs">
          <Input label="Role 名称" required value={roleForm.role_name} onChange={(e) => setRoleForm({ ...roleForm, role_name: e.target.value })} />
          <Select label="Policy 模式" value={roleForm.policy_mode} onChange={(e) => setRoleForm({ ...roleForm, policy_mode: e.target.value })}>
            <option value="explicit">explicit（固定路径列表）</option>
            <option value="templated">templated（ACL 模板变量）</option>
          </Select>
          <Input label="Secret 路径或挂载（逗号分隔，如 secret/data/*）" required value={roleForm.secret_paths} onChange={(e) => setRoleForm({ ...roleForm, secret_paths: e.target.value })} />
          <Input label="允许的 Nomad Namespace" required value={roleForm.bound_namespace} onChange={(e) => setRoleForm({ ...roleForm, bound_namespace: e.target.value })} />
          <Input label="Token Period" value={roleForm.token_period} onChange={(e) => setRoleForm({ ...roleForm, token_period: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setShowRole(false)}>取消</Button>
            <Button type="submit" variant="primary">保存</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
