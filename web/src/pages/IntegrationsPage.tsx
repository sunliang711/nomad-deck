import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOpsDrawer } from '../lib/opsDrawer';
import { isTaskActiveStatus } from '../lib/actionLabels';
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
import { ItemSwitcher } from '../components/ItemSwitcher';

export function IntegrationsPage() {
  const { isAdmin } = useAuth();
  const { tasks, openTask } = useOpsDrawer();
  const [deleting, setDeleting] = useState(false);
  const deleteRef = useRef(false);
  const [deleteTaskId, setDeleteTaskId] = useState('');
  const [applyTaskId, setApplyTaskId] = useState('');
  const [applying, setApplying] = useState(false);
  const applyRef = useRef(false);
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
  const [showEditIntegration, setShowEditIntegration] = useState(false);
  const [savingIntegration, setSavingIntegration] = useState(false);
  const [editIntegrationForm, setEditIntegrationForm] = useState({
    name: '',
    aud: 'vault.io',
    jwks_mode: 'url',
    jwks_url: '',
    vault_address: '',
    default_role: '',
    identity_ttl: '1h',
  });
  const [showRole, setShowRole] = useState(false);
  const [editingRole, setEditingRole] = useState<any>(null);
  const [savingRole, setSavingRole] = useState(false);
  const [roleForm, setRoleForm] = useState({
    role_name: '',
    policy_mode: 'explicit',
    secret_paths: '',
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

  const deleteTask = tasks.find((task) => task.id === deleteTaskId);
  const deletePending = Boolean(deleteTaskId && (!deleteTask || isTaskActiveStatus(deleteTask.status)));

  useEffect(() => {
    if (!deleteTask || isTaskActiveStatus(deleteTask.status)) return;
    setDeleteTaskId('');
    setPlan(null);
    setDoctor(null);
    setExampleHCL('');
    void load();
  }, [deleteTask?.id, deleteTask?.status, load]);

  const applyTask = tasks.find((task) => task.id === applyTaskId);
  const applyPending = Boolean(applyTaskId && (!applyTask || isTaskActiveStatus(applyTask.status)));

  useEffect(() => {
    if (!applyTask || isTaskActiveStatus(applyTask.status)) return;
    setApplyTaskId('');
    setPlan(null);
    void load(applyTask.target_id);
  }, [applyTask?.id, applyTask?.status, load]);

  const applyIntegration = async () => {
    if (!selected || applyRef.current || applyPending) return;
    applyRef.current = true;
    setApplying(true);
    setErr('');
    try {
      const preview = await apiPost(`/api/v1/integrations/${selected.id}/plan`, {});
      if (preview.plan?.errors?.length) throw new Error(preview.plan.errors.join('\n'));
      const source = clusters.find((cluster) => cluster.id === selected.source_cluster_id);
      const confirmSingle = source?.mode === 'single' && preview.plan?.scope === 'vault_and_nomad';
      // 单节点配置下发需要重启服务，确认后才向后端传递维护授权。
      if (confirmSingle && !(await askConfirm('启用联动需要重启这台 Nomad Server，期间调度与 API 会短暂中断。确认现在应用配置吗？', {
        title: '确认单节点维护', confirmText: '确认并应用',
      }))) return;
      const result = await apiPost(`/api/v1/integrations/${selected.id}/apply`, { confirm_single_node: confirmSingle });
      if (result.task?.id) {
        setApplyTaskId(result.task.id);
        openTask(result.task.id, `应用联动：${selected.name}`);
      }
    } catch (ex: any) {
      setErr(ex?.message || '应用联动失败');
    } finally {
      applyRef.current = false;
      setApplying(false);
    }
  };

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

  const openEditIntegration = () => {
    if (!selected) return;
    setEditIntegrationForm({
      name: selected.name || '',
      aud: (selected.config?.aud || ['vault.io']).join(', '),
      jwks_mode: selected.config?.jwks_mode || 'url',
      jwks_url: selected.config?.jwks_url || '',
      vault_address: selected.config?.vault_address || '',
      default_role: selected.config?.default_role || '',
      identity_ttl: selected.config?.identity_ttl || '1h',
    });
    setShowEditIntegration(true);
  };

  const updateIntegration = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || savingIntegration) return;
    setSavingIntegration(true);
    setErr('');
    try {
      const aud = editIntegrationForm.aud
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await apiPut(`/api/v1/integrations/${selected.id}`, {
        name: editIntegrationForm.name.trim(),
        aud: aud.length > 0 ? aud : ['vault.io'],
        jwks_mode: editIntegrationForm.jwks_mode,
        jwks_url: editIntegrationForm.jwks_url.trim(),
        vault_address: editIntegrationForm.vault_address.trim(),
        default_role: editIntegrationForm.default_role.trim(),
        identity_ttl: editIntegrationForm.identity_ttl.trim(),
      });
      setShowEditIntegration(false);
      setPlan(null);
      toast.success('联动配置已更新，如需同步到集群请点击「应用联动」');
      await load(selected.id);
    } catch (ex: any) {
      toast.error(ex?.message || '更新联动配置失败');
    } finally {
      setSavingIntegration(false);
    }
  };

  const openAddRole = () => {
    setEditingRole(null);
    setRoleForm({
      role_name: '',
      policy_mode: 'explicit',
      secret_paths: '',
      bound_namespace: 'default',
      token_period: '1h',
    });
    setShowRole(true);
  };

  const openEditRole = (r: any) => {
    setEditingRole(r);
    setRoleForm({
      role_name: r.role_name || '',
      policy_mode: r.policy_mode || 'explicit',
      secret_paths: (r.secret_paths || []).join(', '),
      bound_namespace: r.bound_claims?.nomad_namespace || 'default',
      token_period: r.token_period || '1h',
    });
    setShowRole(true);
  };

  const saveRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || savingRole) return;
    setSavingRole(true);
    setErr('');
    try {
      const payload: Record<string, any> = {
        role_name: editingRole ? editingRole.role_name : roleForm.role_name.trim(),
        policy_mode: roleForm.policy_mode,
        secret_paths: roleForm.secret_paths
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        bound_claims: {
          ...(editingRole?.bound_claims || {}),
          nomad_namespace: roleForm.bound_namespace.trim(),
        },
        token_period: roleForm.token_period.trim(),
      };
      if (editingRole?.policy_name) payload.policy_name = editingRole.policy_name;
      if (editingRole?.custom_policy_hcl) payload.custom_policy_hcl = editingRole.custom_policy_hcl;

      if (editingRole) {
        await apiPut(`/api/v1/integrations/${selected.id}/roles/${editingRole.id}`, payload);
        toast.success(`已更新工作负载 Role ${payload.role_name}，点击「应用联动」后生效`);
      } else {
        await apiPost(`/api/v1/integrations/${selected.id}/roles`, payload);
        toast.success(`已保存工作负载 Role ${payload.role_name}`);
      }
      setShowRole(false);
      setEditingRole(null);
      setPlan(null);
      await selectItem(selected.id);
    } catch (ex: any) {
      toast.error(ex?.message || '保存 Role 失败');
    } finally {
      setSavingRole(false);
    }
  };

  const deleteIntegration = async () => {
    if (!selected || deleteRef.current || deletePending) return;
    if (
      !(await askConfirm(`确定要删除联动配置「${selected.name}」吗？`, {
        title: '删除集群联动',
        confirmText: '确认删除',
        danger: true,
      }))
    ) {
      return;
    }
    if (deleteRef.current) return;
    deleteRef.current = true;
    setDeleting(true);
    try {
      const res = await apiDelete(`/api/v1/integrations/${selected.id}`);
      if (res?.task?.id) {
        setDeleteTaskId(res.task.id);
        openTask(res.task.id, `删除联动：${selected.name}`);
      } else {
        setSelected(null);
        toast.success('联动配置已删除');
        await load();
      }
    } catch (ex: any) {
      toast.error(ex?.message || '删除联动失败');
    } finally {
      deleteRef.current = false;
      setDeleting(false);
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

      <div className="rounded-2xl border border-indigo-200 bg-indigo-50/70 p-5 text-sm dark:border-indigo-500/30 dark:bg-indigo-950/30">
        <h2 className="font-semibold text-slate-900 dark:text-slate-100">让任务安全读取 Vault 密钥</h2>
        <ol className="mt-3 grid gap-3 text-xs leading-5 text-slate-600 dark:text-slate-300 sm:grid-cols-3">
          <li><strong>1. 保存凭据</strong><br />在 Vault 中启用 KV v2，创建应用 Secret，例如 secret/apps/postgres。</li>
          <li><strong>2. 配置读取权限</strong><br />添加 Role，只授权应用所需的路径，再点击「应用联动」使配置生效。</li>
          <li><strong>3. 在 Job 中引用</strong><br />在 vault 块填写 Role 名称，使用 template 读取密钥；密码无需写入 Job。</li>
        </ol>
      </div>

      <ItemSwitcher
        label="联动配置"
        selectedId={selected?.id || ''}
        onSelect={(id) => void selectItem(id)}
        items={items.map((it) => ({
          id: it.id,
          name: it.name,
          status: it.status,
          subtitle: `${it.source_cluster || it.source_cluster_id} ↔ ${it.target_cluster || it.target_cluster_id}`,
        }))}
      />

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
                  <Button size="sm" onClick={openEditIntegration}>
                    <Pencil className="h-3.5 w-3.5" />
                    <span>编辑</span>
                  </Button>
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
                  <Button size="sm" variant="primary" loading={applying} disabled={applyPending || deletePending}
                    onClick={() => void applyIntegration()}>
                    {applyPending ? '正在应用…' : '应用联动'}
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
                  <Button size="sm" variant="danger" loading={deleting} disabled={deletePending} onClick={() => void deleteIntegration()}>
                    {deletePending ? '正在删除…' : '删除'}
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
              <span>
                JWKS 模式: <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{selected.config?.jwks_mode || 'url'}</code>
              </span>
              <span>
                Audience: <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{(selected.config?.aud || ['vault.io']).join(', ')}</code>
              </span>
              <span>
                身份 TTL: <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{selected.config?.identity_ttl || '1h'}</code>
              </span>
              {selected.config?.default_role && (
                <span>
                  默认 Role: <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{selected.config.default_role}</code>
                </span>
              )}
              <span className="inline-flex items-center gap-1.5">
                状态: <StatusBadge value={selected.status} />
              </span>
            </div>

            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">工作负载 Roles</span>
              {isAdmin && (
                <Button size="sm" onClick={openAddRole}>
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
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">{r.role_name}</span>
                      <StatusBadge value={r.status} />
                      <span className="text-slate-500 break-all">
                        {r.policy_mode === 'explicit' ? '指定路径' : '按任务隔离'} · {(r.secret_paths || []).join(', ') || '默认挂载'} · Namespace: {r.bound_claims?.nomad_namespace || 'default'} · 周期: {r.token_period || '1h'}
                      </span>
                    </div>
                    {isAdmin && (
                      <div className="flex gap-1.5 shrink-0">
                        <Button size="sm" aria-label={`编辑 Role ${r.role_name}`} onClick={() => openEditRole(r)}>
                          <Pencil className="h-3.5 w-3.5" />
                          <span>编辑</span>
                        </Button>
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
                        <Button size="sm" variant="danger" aria-label={`删除 Role ${r.role_name}`} onClick={() => void deleteRole(r)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      <Modal open={Boolean(plan)} title="联动 Plan 预览" onClose={() => setPlan(null)} wide>
        {plan && (
          <div className="space-y-3">
            <pre className="max-h-96 overflow-auto rounded-xl bg-slate-950 p-4 font-mono text-xs text-slate-100">
              {JSON.stringify(plan, null, 2)}
            </pre>
            <div className="flex justify-end">
              <Button size="sm" variant="primary" onClick={() => setPlan(null)}>关闭</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={Boolean(doctor)} title="四段式链路体检" onClose={() => setDoctor(null)} wide>
        {doctor && (
          <div className="space-y-3 text-xs">
            <div className="space-y-2">
              {(doctor.checks || []).map((c: any, i: number) => (
                <div key={i} className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <span><b>{c.name}</b>：{c.message}</span>
                  <StatusBadge value={c.status} />
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <Button size="sm" variant="primary" onClick={() => setDoctor(null)}>关闭</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={Boolean(exampleHCL)} title="示例 Nomad Job HCL" onClose={() => setExampleHCL('')} wide>
        {exampleHCL && (
          <div className="space-y-3">
            <CodeEditor value={exampleHCL} readOnly height="320px" />
            <div className="flex justify-end">
              <Button size="sm" variant="primary" onClick={() => setExampleHCL('')}>关闭</Button>
            </div>
          </div>
        )}
      </Modal>

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

      <Modal open={showEditIntegration} title={`编辑联动：${selected?.name || ''}`} onClose={() => setShowEditIntegration(false)}>
        <form onSubmit={updateIntegration} className="space-y-3 text-xs">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-300">
            源集群（<span className="font-mono">{selected?.source_cluster || selected?.source_cluster_id}</span>）、目标集群（<span className="font-mono">{selected?.target_cluster || selected?.target_cluster_id}</span>）与 Auth Mount（<span className="font-mono">{selected?.auth_path}</span>）创建后不可修改；保存变更后请点击「应用联动」下发。
          </div>
          <Input
            label="联动名称"
            required
            value={editIntegrationForm.name}
            onChange={(e) => setEditIntegrationForm({ ...editIntegrationForm, name: e.target.value })}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="JWKS 模式"
              value={editIntegrationForm.jwks_mode}
              onChange={(e) => setEditIntegrationForm({ ...editIntegrationForm, jwks_mode: e.target.value })}
            >
              <option value="url">url（Vault 实时拉取 Nomad JWKS）</option>
              <option value="static">static（控制面静态下发公钥）</option>
            </Select>
            <Input
              label="身份令牌 TTL"
              required
              placeholder="例如 1h"
              value={editIntegrationForm.identity_ttl}
              onChange={(e) => setEditIntegrationForm({ ...editIntegrationForm, identity_ttl: e.target.value })}
            />
          </div>
          <Input
            label="Audience（aud）"
            placeholder="例如 vault.io，多个用逗号分隔"
            value={editIntegrationForm.aud}
            onChange={(e) => setEditIntegrationForm({ ...editIntegrationForm, aud: e.target.value })}
          />
          <Input
            label="自定义 JWKS URL（可选）"
            placeholder="留空则自动使用 Nomad 统一入口或 Server 地址"
            value={editIntegrationForm.jwks_url}
            onChange={(e) => setEditIntegrationForm({ ...editIntegrationForm, jwks_url: e.target.value })}
          />
          <Input
            label="自定义 Vault 地址（可选）"
            placeholder="留空则自动使用 Vault 统一入口或节点地址"
            value={editIntegrationForm.vault_address}
            onChange={(e) => setEditIntegrationForm({ ...editIntegrationForm, vault_address: e.target.value })}
          />
          <Input
            label="默认 Role（可选）"
            placeholder="例如 default-role，留空则不设默认 Role"
            value={editIntegrationForm.default_role}
            onChange={(e) => setEditIntegrationForm({ ...editIntegrationForm, default_role: e.target.value })}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setShowEditIntegration(false)}>取消</Button>
            <Button type="submit" variant="primary" loading={savingIntegration}>保存</Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={showRole}
        title={editingRole ? `编辑工作负载 Role：${editingRole.role_name}` : '添加工作负载 Role'}
        onClose={() => {
          setShowRole(false);
          setEditingRole(null);
        }}
      >
        <form onSubmit={saveRole} className="space-y-3 text-xs">
          <Input
            label="Role 名称"
            placeholder="例如 postgres，在 Job 的 vault.role 中使用"
            hint={editingRole ? 'Role 名称创建后不可修改。' : undefined}
            disabled={Boolean(editingRole)}
            required
            value={roleForm.role_name}
            onChange={(e) => setRoleForm({ ...roleForm, role_name: e.target.value })}
          />
          <Select label="Policy 模式" value={roleForm.policy_mode} onChange={(e) => setRoleForm({ ...roleForm, policy_mode: e.target.value })}>
            <option value="explicit">explicit（固定路径列表）</option>
            <option value="templated">templated（ACL 模板变量）</option>
          </Select>
          <Input
            label={roleForm.policy_mode === 'templated' ? 'KV 挂载名称' : '允许读取的 Secret 路径'}
            placeholder={roleForm.policy_mode === 'templated' ? '例如 secret' : '例如 secret/apps/postgres'}
            hint={roleForm.policy_mode === 'templated' ? '填写 KV 挂载名称，多个用逗号分隔；权限按 Namespace 和 Job 自动隔离。' : '填写「挂载/密钥路径」，无需加 data/。多个路径用逗号分隔，建议精确授权。'}
            required={roleForm.policy_mode === 'explicit' && !editingRole?.custom_policy_hcl}
            value={roleForm.secret_paths}
            onChange={(e) => setRoleForm({ ...roleForm, secret_paths: e.target.value })}
          />
          <Input label="允许的 Nomad Namespace" required value={roleForm.bound_namespace} onChange={(e) => setRoleForm({ ...roleForm, bound_namespace: e.target.value })} />
          <Input label="Token 续期周期" value={roleForm.token_period} onChange={(e) => setRoleForm({ ...roleForm, token_period: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              onClick={() => {
                setShowRole(false);
                setEditingRole(null);
              }}
            >
              取消
            </Button>
            <Button type="submit" variant="primary" loading={savingRole}>保存</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
