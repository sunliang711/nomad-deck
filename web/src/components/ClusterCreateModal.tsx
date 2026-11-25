import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Server } from 'lucide-react';
import { apiPost } from '../lib/api';
import { Badge, Button, EmptyState, ErrorAlert, Input, Modal, Select, StatusBadge } from './UI';

type Member = { node_id: string; role: string; advertise_addr: string };

export function ClusterCreateModal({ open, product, nodes, onClose, onCreated }: {
  open: boolean;
  product: 'nomad' | 'vault';
  nodes: any[];
  onClose: () => void;
  onCreated: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState('cluster');
  const [members, setMembers] = useState<Member[]>([]);
  const [region, setRegion] = useState('global');
  const [datacenter, setDatacenter] = useState('dc1');
  const [publicURL, setPublicURL] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submitting = useRef(false);
  const formId = useId();
  const isNomad = product === 'nomad';
  const productName = isNomad ? 'Nomad' : 'Vault';
  const servers = isNomad ? members.filter((m) => m.role !== 'client').length : members.length;
  const selectionError = mode === 'single'
    ? members.length !== 1 ? '单机模式请选择 1 台主机。' : ''
    : isNomad
      ? servers < 3 || servers % 2 === 0 ? '请选择至少 3 台且为奇数台的 Server，推荐 3 台或 5 台。' : ''
      : members.length < 3 ? '高可用集群至少需要 3 台主机，推荐 3 台或 5 台。' : '';

  useEffect(() => {
    if (!open) return;
    setName('');
    setMode('cluster');
    setMembers([]);
    setRegion('global');
    setDatacenter('dc1');
    setPublicURL('');
    setErr('');
  }, [open]);

  const toggleNode = (node: any, checked: boolean) => {
    setMembers((prev) => checked
      ? [...(mode === 'single' ? [] : prev), { node_id: node.id, role: 'server_client', advertise_addr: node.host }]
      : prev.filter((m) => m.node_id !== node.id));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current || selectionError) return;
    submitting.current = true;
    setBusy(true);
    setErr('');
    try {
      const res = await apiPost('/api/v1/clusters', {
        type: product, name: name.trim(), mode, public_api_url: publicURL.trim(),
        ...(isNomad ? { region, datacenter } : {}),
        nodes: members.map((m) => isNomad ? m : { node_id: m.node_id, advertise_addr: m.advertise_addr }),
      });
      await onCreated(res.cluster.id);
      onClose();
    } catch (ex: any) {
      setErr(ex?.message || `创建 ${productName} 集群失败`);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={`新建 ${productName} 集群`} size="xl" busy={busy} onClose={onClose}
      footer={<div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-slate-500">已选 {members.length} 台主机 · {mode === 'single' ? '单机模式' : '高可用集群'}</span><div className="flex gap-2"><Button disabled={busy} onClick={onClose}>取消</Button><Button type="submit" form={formId} variant="primary" loading={busy} disabled={Boolean(selectionError) || !name.trim()}>创建并前往部署 <ArrowRight className="h-4 w-4" /></Button></div></div>}>
      <form id={formId} onSubmit={submit} className="space-y-6">
        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400" aria-label="集群搭建流程">
          <span className="font-semibold text-indigo-600 dark:text-indigo-300">1 配置集群</span><ArrowRight className="h-3 w-3" />
          <span>2 部署服务</span><ArrowRight className="h-3 w-3" /><span>3 检查健康</span>
        </div>
        <ErrorAlert message={err} onClose={() => setErr('')} />
        <div className="grid gap-6 md:grid-cols-[1fr_240px]">
          <div className="space-y-5 min-w-0">
            <Input label="集群名称" required autoComplete="off" maxLength={63} pattern={'[A-Za-z0-9._\\-]+'} placeholder={isNomad ? '例如 nomad-ha' : '例如 vault-ha'} hint="使用字母、数字、点、下划线或连字符，最多 63 位。" value={name} onChange={(e) => setName(e.target.value)} />
            <fieldset>
              <legend className="mb-2 text-xs font-medium text-slate-700 dark:text-slate-300">部署模式</legend>
              <div className="grid grid-cols-1 min-[480px]:grid-cols-2 gap-2">
                {[{ value: 'cluster', title: '高可用集群', desc: '推荐 · 3 台起，可容忍节点故障' }, { value: 'single', title: '单机体验', desc: '1 台主机，适合学习与试用' }].map((item) => (
                  <label key={item.value} className={`flex items-start gap-2.5 rounded-xl border p-3 cursor-pointer ${mode === item.value ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-500/10' : 'border-slate-200 dark:border-slate-700'}`}>
                    <input className="mt-0.5" type="radio" name={`${product}-mode`} value={item.value} checked={mode === item.value} onChange={() => { setMode(item.value); if (item.value === 'single') setMembers((prev) => prev.slice(0, 1).map((m) => ({ ...m, role: 'server_client' }))); }} />
                    <span><span className="block text-sm font-medium text-slate-900 dark:text-slate-100">{item.title}</span><span className="mt-1 block text-xs leading-5 text-slate-500 dark:text-slate-400">{item.desc}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset aria-label="选择主机">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-slate-700 dark:text-slate-300">选择主机 <span className="text-slate-400">· 已选 {members.length} 台</span></div>
                {nodes.length > 1 && mode === 'cluster' && <Button size="sm" onClick={() => setMembers(members.length === nodes.length ? [] : nodes.map((n) => ({ node_id: n.id, role: 'server_client', advertise_addr: n.host })))}>{members.length === nodes.length ? '取消全选' : '全选主机'}</Button>}
              </div>
              {nodes.length === 0 ? <EmptyState icon={<Server className="h-6 w-6" />} title="还没有可用主机" description="先添加 Linux 主机并测试 SSH 连接，再回来创建集群。" action={<Link className="primary-button" to="/infra" onClick={onClose}>前往添加主机</Link>} /> : (
                <div className="max-h-96 overflow-y-auto space-y-2 p-1 -m-1">
                  {nodes.map((n) => {
                    const picked = members.find((m) => m.node_id === n.id);
                    return (
                      <div key={n.id} className={`rounded-xl border p-3 ${picked ? 'border-indigo-300 bg-indigo-50/50 dark:border-indigo-500/50 dark:bg-indigo-500/10' : 'border-slate-200 dark:border-slate-700'}`}>
                        <div className="flex flex-wrap items-center gap-3">
                          <label className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                            <input type="checkbox" checked={Boolean(picked)} onChange={(e) => toggleNode(n, e.target.checked)} />
                            <span className="min-w-0"><span className="block text-sm font-medium text-slate-900 dark:text-slate-100 break-all">{n.name}</span><span className="block text-xs font-mono text-slate-500">{n.host}</span></span>
                          </label>
                          <StatusBadge value={n.status} />
                        </div>
                        {picked && isNomad && mode === 'cluster' && <div className="mt-3"><Select label={`${n.name} 的节点角色`} value={picked.role} onChange={(e) => setMembers((prev) => prev.map((m) => m.node_id === n.id ? { ...m, role: e.target.value } : m))}><option value="server_client">Server + Client · 调度并运行任务（入门推荐）</option><option value="server">Server · 仅负责集群调度</option><option value="client">Client · 仅运行工作负载</option></Select></div>}
                      </div>
                    );
                  })}
                </div>
              )}
              <p className={`mt-3 text-xs leading-5 ${selectionError ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`} role="status">{selectionError || `已满足${mode === 'single' ? '单机' : '集群'}节点要求。`}</p>
            </fieldset>
            <details className="rounded-xl border border-slate-200 dark:border-slate-700 p-3.5">
              <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-200">高级配置 <span className="text-xs font-normal text-slate-400">· 初次使用可保留默认值</span></summary>
              <div className="mt-4 space-y-4">
                {isNomad && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><Input label="Region" required pattern={'[A-Za-z0-9_\\-]+'} value={region} onChange={(e) => setRegion(e.target.value)} /><Input label="Datacenter" required pattern={'[A-Za-z0-9_\\-]+'} value={datacenter} onChange={(e) => setDatacenter(e.target.value)} /></div>}
                <Input label="统一业务入口 URL（可选）" type="url" placeholder="https://cluster.example.com" value={publicURL} onChange={(e) => setPublicURL(e.target.value)} hint="已有负载均衡或域名时填写；留空使用节点地址，控制面不会自动创建负载均衡。" />
              </div>
            </details>
          </div>
          <aside className="rounded-2xl border border-indigo-100 bg-slate-50 p-5 dark:border-slate-700 dark:bg-slate-950/50 h-fit space-y-5">
            <div><Badge tone="blue">{productName} 搭建指南</Badge><h4 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">{isNomad ? '让任务有处可运行' : '为集群保管密钥'}</h4><p className="mt-2 text-xs leading-6 text-slate-500 dark:text-slate-400">{isNomad ? 'Server 负责调度，Client 负责运行任务。入门时每台主机同时承担两种角色即可。' : 'Vault 使用 Raft 在节点间复制数据。3 台节点组成集群后，可容忍 1 台故障。'}</p></div>
            <div className="border-t border-slate-200 dark:border-slate-700 pt-4 text-sm space-y-2"><div className="flex justify-between"><span className="text-slate-500">已选主机</span><strong>{members.length} 台</strong></div><div className="flex justify-between"><span className="text-slate-500">{isNomad ? 'Server 数量' : 'Raft 节点'}</span><strong>{servers} 台</strong></div>{isNomad && <div className="flex justify-between"><span className="text-slate-500">Client 数量</span><strong>{members.filter((m) => m.role !== 'server').length} 台</strong></div>}</div>
            <p className="flex gap-2 text-xs leading-6 text-slate-500 dark:text-slate-400"><Check className="mt-1 h-4 w-4 shrink-0 text-indigo-500" />创建后进入集群页，选择版本并点击「部署集群」，即可自动安装{isNomad ? '、配置 TLS 并初始化 ACL。' : '并初始化密钥托管。'}</p>
          </aside>
        </div>
      </form>
    </Modal>
  );
}
