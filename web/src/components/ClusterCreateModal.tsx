import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Info, Server } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import {
  buildClientSettingsPayload,
  ClientPluginFields,
  defaultClientPluginDraft,
  type ClientPluginDraft,
} from './NomadConfigModals';
import { Badge, Button, EmptyState, ErrorAlert, Input, Modal, Select, StatusBadge } from './UI';
import { isLoopbackAddress } from '../lib/net';

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
  const [cniVersions, setCniVersions] = useState<string[]>([]);
  const [cniVersion, setCniVersion] = useState('');
  const [clientDefaults, setClientDefaults] = useState<ClientPluginDraft>(defaultClientPluginDraft);
  const [allowInsecureHTTP, setAllowInsecureHTTP] = useState(false);
  const [verifyHTTPSClient, setVerifyHTTPSClient] = useState(false);
  const [httpPort, setHttpPort] = useState('4646');
  const [rpcPort, setRpcPort] = useState('4647');
  const [serfPort, setSerfPort] = useState('4648');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submitting = useRef(false);
  const formId = useId();
  const isNomad = product === 'nomad';
  const productName = isNomad ? 'Nomad' : 'Vault';
  const servers = isNomad ? members.filter((m) => m.role !== 'client').length : members.length;
  const loopbackMembers = mode === 'cluster' ? members.filter((m) => isLoopbackAddress(m.advertise_addr)) : [];
  const selectionError = mode === 'single'
    ? members.length !== 1 ? '单机模式请选择 1 台主机。' : ''
    : isNomad
      ? servers < 3 || servers % 2 === 0 ? '请选择至少 3 台且为奇数台的 Server，推荐 3 台或 5 台。' : ''
      : members.length < 3 ? '高可用集群至少需要 3 台主机，推荐 3 台或 5 台。' : '';
  const memberError = selectionError || (loopbackMembers.length > 0 ? '多节点集群成员的通信地址（advertise_addr）不能使用 127.0.0.1 或 localhost，请填写真实内网 IP。' : '');

  useEffect(() => {
    if (!open) return;
    setName('');
    // 当可用主机少于 3 台时默认切换至单机体验，避免刚打开就报错阻塞新手
    const preferSingle = nodes.length > 0 && nodes.length < 3;
    setMode(preferSingle ? 'single' : 'cluster');
    setMembers(
      preferSingle && nodes.length === 1
        ? [{ node_id: nodes[0].id, role: 'server_client', advertise_addr: nodes[0].host }]
        : [],
    );
    setRegion('global');
    setDatacenter('dc1');
    setPublicURL('');
    setCniVersion('');
    setClientDefaults(defaultClientPluginDraft());
    setAllowInsecureHTTP(false);
    setVerifyHTTPSClient(false);
    setHttpPort('4646');
    setRpcPort('4647');
    setSerfPort('4648');
    setErr('');
    if (isNomad) {
      void apiGet('/api/v1/releases/cni')
        .then((r) => {
          const vers = (r.versions || []) as string[];
          setCniVersions(vers);
          if (vers.length > 0) setCniVersion(vers[0]);
        })
        .catch(() => setCniVersions([]));
    }
  }, [open, nodes, isNomad]);

  const toggleNode = (node: any, checked: boolean) => {
    setMembers((prev) => checked
      ? [...(mode === 'single' ? [] : prev), { node_id: node.id, role: 'server_client', advertise_addr: node.host }]
      : prev.filter((m) => m.node_id !== node.id));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current || memberError) return;
    submitting.current = true;
    setBusy(true);
    setErr('');
    try {
      const nomadPayload = isNomad
        ? {
            region: region.trim() || 'global',
            datacenter: datacenter.trim() || 'dc1',
            allow_insecure_http: allowInsecureHTTP,
            verify_https_client: allowInsecureHTTP ? false : verifyHTTPSClient,
            http_port: Number(httpPort) || 4646,
            rpc_port: Number(rpcPort) || 4647,
            serf_port: Number(serfPort) || 4648,
            cni_version: cniVersion.trim() || undefined,
            client_defaults: buildClientSettingsPayload(clientDefaults),
          }
        : {};
      const normalizedMembers = members.map((m) => {
        const addr = m.advertise_addr.trim();
        return isNomad ? { ...m, advertise_addr: addr } : { node_id: m.node_id, advertise_addr: addr };
      });
      const res = await apiPost('/api/v1/clusters', {
        type: product, name: name.trim(), mode, public_api_url: publicURL.trim(),
        ...nomadPayload,
        nodes: normalizedMembers,
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
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            已选 {members.length} 台主机 · {mode === 'single' ? '单机体验' : '高可用集群'}
          </span>
          <div className="flex gap-2">
            <Button disabled={busy} onClick={onClose}>取消</Button>
            <Button type="submit" form={formId} variant="primary" loading={busy} disabled={Boolean(memberError) || !name.trim()}>
              创建并前往部署 <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-5">
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs text-slate-500 dark:bg-slate-950/60 dark:text-slate-400" aria-label="集群搭建流程">
          <span className="font-semibold text-indigo-600 dark:text-indigo-300">1. 配置集群</span>
          <ArrowRight className="h-3 w-3" />
          <span>2. 一键部署</span>
          <ArrowRight className="h-3 w-3" />
          <span>{isNomad ? '3. 运行任务' : '3. 初始化托管与解封'}</span>
        </div>

        <ErrorAlert message={err} onClose={() => setErr('')} />

        <div className="grid gap-6 md:grid-cols-[1fr_270px]">
          <div className="space-y-5 min-w-0">
            <Input
              label="集群名称"
              required
              autoComplete="off"
              maxLength={63}
              pattern={'[A-Za-z0-9._\\-]+'}
              placeholder={isNomad ? (mode === 'single' ? '例如 nomad-dev' : '例如 nomad-ha') : (mode === 'single' ? '例如 vault-dev' : '例如 vault-ha')}
              hint="仅支持字母、数字、点、下划线或连字符，最多 63 位。"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />

            <fieldset>
              <legend className="mb-2 text-xs font-medium text-slate-700 dark:text-slate-300">部署模式</legend>
              <div className="grid grid-cols-1 min-[480px]:grid-cols-2 gap-2.5">
                {[
                  { value: 'cluster', title: '高可用集群', desc: '生产推荐 · 3 台起，可容忍节点故障' },
                  { value: 'single', title: '单机体验', desc: '1 台主机，快速上手与测试学习' },
                ].map((item) => (
                  <label
                    key={item.value}
                    className={`flex items-start gap-2.5 rounded-xl border p-3.5 cursor-pointer transition ${
                      mode === item.value
                        ? 'border-indigo-400 bg-indigo-50/70 dark:border-indigo-500/70 dark:bg-indigo-500/10'
                        : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
                    }`}
                  >
                    <input
                      className="mt-0.5"
                      type="radio"
                      name={`${product}-mode`}
                      value={item.value}
                      checked={mode === item.value}
                      onChange={() => {
                        setMode(item.value);
                        if (item.value === 'single') {
                          setMembers((prev) =>
                            prev.length > 0
                              ? prev.slice(0, 1).map((m) => ({ ...m, role: 'server_client' }))
                              : nodes.length === 1
                                ? [{ node_id: nodes[0].id, role: 'server_client', advertise_addr: nodes[0].host }]
                                : [],
                          );
                        }
                      }}
                    />
                    <span>
                      <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">{item.title}</span>
                      <span className="mt-1 block text-xs leading-5 text-slate-500 dark:text-slate-400">{item.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
              {nodes.length > 0 && nodes.length < 3 && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <Info className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
                  <span>当前共有 {nodes.length} 台纳管主机，已默认选用单机体验；接入至少 3 台主机即可组建高可用集群。</span>
                </p>
              )}
            </fieldset>

            <fieldset aria-label="选择主机">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  选择主机 <span className="text-slate-400">· 已选 {members.length} 台</span>
                </div>
                {nodes.length > 1 && mode === 'cluster' && (
                  <Button
                    size="sm"
                    onClick={() =>
                      setMembers(
                        members.length === nodes.length
                          ? []
                          : nodes.map((n) => ({ node_id: n.id, role: 'server_client', advertise_addr: n.host })),
                      )
                    }
                  >
                    {members.length === nodes.length ? '取消全选' : '全选主机'}
                  </Button>
                )}
              </div>
              {nodes.length === 0 ? (
                <EmptyState
                  icon={<Server className="h-6 w-6" />}
                  title="还没有可用主机"
                  description="先添加 Linux 主机并测试 SSH 连接，再回来创建集群。"
                  action={
                    <Link className="primary-button" to="/infra" onClick={onClose}>
                      前往添加主机
                    </Link>
                  }
                />
              ) : (
                <div className="max-h-72 overflow-y-auto space-y-2 p-1 -m-1">
                  {nodes.map((n) => {
                    const picked = members.find((m) => m.node_id === n.id);
                    return (
                      <div
                        key={n.id}
                        className={`rounded-xl border p-3 transition ${
                          picked
                            ? 'border-indigo-300 bg-indigo-50/50 dark:border-indigo-500/50 dark:bg-indigo-500/10'
                            : 'border-slate-200 dark:border-slate-700'
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-3">
                          <label className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                            <input type="checkbox" checked={Boolean(picked)} onChange={(e) => toggleNode(n, e.target.checked)} />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium text-slate-900 dark:text-slate-100 break-all">{n.name}</span>
                              <span className="block text-xs font-mono text-slate-500">{n.host}</span>
                            </span>
                          </label>
                          <StatusBadge value={n.status} />
                        </div>
                        {picked && (
                          <div className={`mt-3 grid grid-cols-1 gap-2.5 ${isNomad && mode === 'cluster' ? 'sm:grid-cols-2' : ''}`}>
                            {isNomad && mode === 'cluster' && (
                              <Select
                                label={`${n.name} 的节点角色`}
                                value={picked.role}
                                onChange={(e) =>
                                  setMembers((prev) => prev.map((m) => (m.node_id === n.id ? { ...m, role: e.target.value } : m)))
                                }
                              >
                                <option value="server_client">Server + Client · 调度并运行任务（入门推荐）</option>
                                <option value="server">Server · 仅负责集群调度</option>
                                <option value="client">Client · 仅运行工作负载</option>
                              </Select>
                            )}
                            <div>
                              <Input
                                label="集群通信地址 (advertise_addr)"
                                required
                                value={picked.advertise_addr}
                                placeholder={n.host || '例如 10.0.0.11'}
                                hint="默认填入主机 SSH 地址，用于节点间通信与证书签发；多节点请填真实内网 IP。"
                                onChange={(e) =>
                                  setMembers((prev) =>
                                    prev.map((m) => (m.node_id === n.id ? { ...m, advertise_addr: e.target.value } : m)),
                                  )
                                }
                              />
                              {mode === 'cluster' && isLoopbackAddress(picked.advertise_addr) && (
                                <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
                                  多节点集群不可使用回环地址（127.0.0.1 / localhost），请改为真实内网 IP。
                                </p>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <p
                className={`mt-2.5 text-xs leading-5 ${
                  memberError ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'
                }`}
                role="status"
              >
                {memberError || `已满足${mode === 'single' ? '单机体验' : '高可用集群'}节点要求。`}
              </p>
            </fieldset>

            <details className="rounded-xl border border-slate-200 dark:border-slate-700 p-3.5">
              <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-200">
                高级配置{' '}
                <span className="text-xs font-normal text-slate-400">
                  {isNomad
                    ? '· Region / Datacenter / CNI / Host Volume / 驱动插件 / TLS 与端口（初次使用保留默认即可）'
                    : '· 统一业务入口 URL（初次使用保留默认即可）'}
                </span>
              </summary>
              <div className="mt-4 space-y-4">
                {isNomad && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Input label="Region" required pattern={'[A-Za-z0-9_\\-]+'} value={region} onChange={(e) => setRegion(e.target.value)} />
                    <Input label="Datacenter" required pattern={'[A-Za-z0-9_\\-]+'} value={datacenter} onChange={(e) => setDatacenter(e.target.value)} />
                  </div>
                )}
                <Input
                  label="统一业务入口 URL（可选）"
                  type="url"
                  placeholder="https://cluster.example.com"
                  value={publicURL}
                  onChange={(e) => setPublicURL(e.target.value)}
                  hint="已有负载均衡或域名时填写；留空直接使用节点地址。"
                />
                {isNomad && (
                  <>
                    <ClientPluginFields
                      value={clientDefaults}
                      onChange={setClientDefaults}
                      cniVersions={cniVersions}
                      cniVersion={cniVersion}
                      onChangeCNIVersion={setCniVersion}
                    />
                    <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3.5 space-y-3 text-xs">
                      <div className="font-semibold text-slate-800 dark:text-slate-100">TLS 与通信端口</div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <Input label="HTTP 端口" type="number" min={1} max={65535} value={httpPort} onChange={(e) => setHttpPort(e.target.value)} />
                        <Input label="RPC 端口" type="number" min={1} max={65535} value={rpcPort} onChange={(e) => setRpcPort(e.target.value)} />
                        <Input label="Serf 端口" type="number" min={1} max={65535} value={serfPort} onChange={(e) => setSerfPort(e.target.value)} />
                      </div>
                      <div className="flex flex-wrap gap-4">
                        <label className="flex items-center gap-2 cursor-pointer text-amber-700 dark:text-amber-300">
                          <input
                            type="checkbox"
                            checked={allowInsecureHTTP}
                            onChange={(e) => {
                              setAllowInsecureHTTP(e.target.checked);
                              if (e.target.checked) setVerifyHTTPSClient(false);
                            }}
                          />
                          <span>关闭 TLS（allow_insecure_http，仅限非生产测试）</span>
                        </label>
                        {!allowInsecureHTTP && (
                          <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
                            <input
                              type="checkbox"
                              checked={verifyHTTPSClient}
                              onChange={(e) => setVerifyHTTPSClient(e.target.checked)}
                            />
                            <span>校验 HTTPS 客户端证书（verify_https_client）</span>
                          </label>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </details>
          </div>

          <aside className="rounded-2xl border border-indigo-100 bg-slate-50 p-5 dark:border-slate-700 dark:bg-slate-950/50 h-fit space-y-4">
            <div>
              <Badge tone="blue">{productName} 搭建指南</Badge>
              <h4 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">
                {isNomad ? '让任务有处可运行' : '集中安全托管密钥'}
              </h4>
              <p className="mt-2 text-xs leading-6 text-slate-500 dark:text-slate-400">
                {isNomad
                  ? 'Server 负责调度决策，Client 负责执行任务。入门体验时每台主机同时承担两种角色即可。'
                  : 'Vault 使用 Raft 存储并自动复制数据。单机适合快速体验，3 台及以上组成高可用集群。'}
              </p>
            </div>
            <div className="border-t border-slate-200 dark:border-slate-700 pt-3.5 text-sm space-y-2">
              <div className="flex justify-between">
                <span className="text-slate-500">已选主机</span>
                <strong>{members.length} 台</strong>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">{isNomad ? 'Server 数量' : 'Raft 节点'}</span>
                <strong>{servers} 台</strong>
              </div>
              {isNomad && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Client 数量</span>
                  <strong>{members.filter((m) => m.role !== 'server').length} 台</strong>
                </div>
              )}
            </div>
            <p className="flex gap-2 text-xs leading-6 text-slate-500 dark:text-slate-400">
              <Check className="mt-1 h-4 w-4 shrink-0 text-indigo-500" />
              <span>
                {isNomad
                  ? '创建后点击「部署集群」，即可自动安装、配置 TLS 并完成 ACL 初始化。'
                  : '创建后点击「部署集群」安装并启动服务，随后在页面内一键初始化托管密钥即可使用。'}
              </span>
            </p>
          </aside>
        </div>
      </form>
    </Modal>
  );
}
