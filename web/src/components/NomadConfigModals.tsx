import React, { useEffect, useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { canEnableSystemProxy } from '../lib/proxy';
import { useConfirm } from './ConfirmDialog';
import { useToast } from './Toast';
import { Badge, Button, ErrorAlert, Input, Modal, Select, TermLabel } from './UI';

export interface HostVolumeDraft {
  name: string;
  path: string;
  read_only: boolean;
  create: boolean;
  customPath?: boolean;
}

export interface MetaDraft {
  key: string;
  value: string;
}

export interface ClientPluginDraft {
  cni: boolean;
  raw_exec: boolean;
  node_pool: string;
  cpu_total_compute: string;
  driver_denylist: string[];
  extra_denylist: string;
  host_volumes: HostVolumeDraft[];
  meta: MetaDraft[];
  docker: {
    allow_privileged: boolean;
    volumes: boolean;
    disable_image_gc: boolean;
    image_gc_delay: string;
    auth_config: string;
  };
}

const COMMON_DRIVERS = ['docker', 'exec', 'raw_exec', 'java', 'qemu'];

export function defaultClientPluginDraft(): ClientPluginDraft {
  return {
    cni: false,
    raw_exec: false,
    node_pool: '',
    cpu_total_compute: '',
    driver_denylist: [],
    extra_denylist: '',
    host_volumes: [],
    meta: [],
    docker: {
      allow_privileged: false,
      volumes: true,
      disable_image_gc: false,
      image_gc_delay: '3m',
      auth_config: '',
    },
  };
}

export function clientPluginDraftFromConfig(cfg: any): ClientPluginDraft {
  const c = cfg || {};
  const d = c.docker || {};
  const deny = Array.isArray(c.driver_denylist) ? (c.driver_denylist as string[]) : [];
  const knownDeny = deny.filter((x) => COMMON_DRIVERS.includes(x));
  const extraDeny = deny.filter((x) => !COMMON_DRIVERS.includes(x)).join(', ');
  const vols: HostVolumeDraft[] = Array.isArray(c.host_volumes)
    ? c.host_volumes.map((v: any) => ({
        name: v.name || '',
        path: v.path || '',
        read_only: Boolean(v.read_only),
        create: v.create !== undefined ? Boolean(v.create) : true,
        customPath: true,
      }))
    : [];
  const metaObj = c.meta && typeof c.meta === 'object' ? (c.meta as Record<string, string>) : {};
  const metaRows: MetaDraft[] = Object.entries(metaObj)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value: String(value ?? '') }));

  return {
    cni: Boolean(c.cni),
    raw_exec: Boolean(c.raw_exec),
    node_pool: c.node_pool || '',
    cpu_total_compute: c.cpu_total_compute ? String(c.cpu_total_compute) : '',
    driver_denylist: knownDeny,
    extra_denylist: extraDeny,
    host_volumes: vols,
    meta: metaRows,
    docker: {
      allow_privileged: Boolean(d.allow_privileged),
      volumes: d.volumes !== undefined ? Boolean(d.volumes) : true,
      disable_image_gc: Boolean(d.disable_image_gc),
      image_gc_delay: d.image_gc_delay || '3m',
      auth_config: d.auth_config || '',
    },
  };
}

export function buildClientSettingsPayload(draft: ClientPluginDraft) {
  const extra = draft.extra_denylist
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const denylist = Array.from(new Set([...draft.driver_denylist, ...extra]));
  const meta: Record<string, string> = {};
  for (const row of draft.meta) {
    const k = row.key.trim();
    if (k) meta[k] = row.value;
  }
  const hostVolumes = draft.host_volumes
    .filter((v) => v.name.trim() || v.path.trim())
    .map((v) => ({
      name: v.name.trim(),
      path: v.path.trim(),
      read_only: v.read_only,
      create: v.create,
    }));

  return {
    cni: draft.cni,
    raw_exec: draft.raw_exec,
    node_pool: draft.node_pool.trim() || undefined,
    cpu_total_compute: Number(draft.cpu_total_compute) || 0,
    driver_denylist: denylist.length > 0 ? denylist : undefined,
    host_volumes: hostVolumes.length > 0 ? hostVolumes : undefined,
    meta: Object.keys(meta).length > 0 ? meta : undefined,
    docker: {
      allow_privileged: draft.docker.allow_privileged,
      volumes: draft.docker.volumes,
      disable_image_gc: draft.docker.disable_image_gc,
      image_gc_delay: draft.docker.image_gc_delay.trim() || undefined,
      auth_config: draft.docker.auth_config.trim() || undefined,
    },
  };
}

export function ClientPluginFields({
  value,
  onChange,
  cniVersions,
  cniVersion,
  onChangeCNIVersion,
  cniVersionEditable = true,
  nodePools = [],
  showReinstallCNI = false,
  reinstallCNI = false,
  onChangeReinstallCNI,
}: {
  value: ClientPluginDraft;
  onChange: (next: ClientPluginDraft) => void;
  cniVersions: string[];
  cniVersion: string;
  onChangeCNIVersion?: (v: string) => void;
  cniVersionEditable?: boolean;
  nodePools?: string[];
  showReinstallCNI?: boolean;
  reinstallCNI?: boolean;
  onChangeReinstallCNI?: (v: boolean) => void;
}) {
  const toggleDeny = (drv: string, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...value.driver_denylist, drv]))
      : value.driver_denylist.filter((d) => d !== drv);
    onChange({ ...value, driver_denylist: next });
  };

  return (
    <div className="space-y-4 text-xs">
      {/* CNI 网络插件 */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3.5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold text-slate-800 dark:text-slate-100">
            <TermLabel
              term="CNI 网络插件"
              tip="安装 containernetworking/plugins 到 /opt/cni/bin 并启用 bridge 内核参数与 83-cni.hcl，支持 Nomad bridge 网络模式及端口映射。"
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={value.cni}
              onChange={(e) => {
                const on = e.target.checked;
                onChange({ ...value, cni: on });
                if (on && !cniVersion && cniVersions.length > 0 && onChangeCNIVersion) {
                  onChangeCNIVersion(cniVersions[0]);
                }
              }}
            />
            <span>启用 CNI</span>
          </label>
        </div>
        {(value.cni || cniVersion) && (
          <div className="space-y-2.5">
            {cniVersionEditable && onChangeCNIVersion ? (
              <Select
                label="集群 CNI 插件版本"
                value={cniVersion}
                onChange={(e) => onChangeCNIVersion(e.target.value)}
              >
                <option value="">请选择 CNI 版本…</option>
                {cniVersions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </Select>
            ) : (
              <div className="text-slate-500">
                集群 CNI 版本：<span className="font-mono font-medium text-slate-800 dark:text-slate-200">{cniVersion || '未设置'}</span>
              </div>
            )}
            {showReinstallCNI && value.cni && onChangeReinstallCNI && (
              <label className="flex items-center gap-2 cursor-pointer text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={reinstallCNI}
                  onChange={(e) => onChangeReinstallCNI(e.target.checked)}
                />
                <span>重新下载并修复安装 CNI 插件二进制（对应 Doctor 缺少 CNI 插件告警）</span>
              </label>
            )}
          </div>
        )}
      </div>

      {/* Host Volumes */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3.5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold text-slate-800 dark:text-slate-100">
            <TermLabel
              term="Host Volumes（宿主机挂载卷）"
              tip="在 Client 节点生成 70-host-volume-<name>.hcl，Job 可通过 volume 块按名称挂载宿主机目录。禁止使用 /etc、/usr 等系统目录。"
            />
          </div>
          <Button
            size="sm"
            onClick={() =>
              onChange({
                ...value,
                host_volumes: [
                  ...value.host_volumes,
                  { name: '', path: '/opt/nomad-deck/nomad/volumes/', read_only: false, create: true, customPath: false },
                ],
              })
            }
          >
            <Plus className="h-3.5 w-3.5" />
            <span>添加卷</span>
          </Button>
        </div>
        {value.host_volumes.length === 0 ? (
          <p className="text-slate-500">未配置 Host Volume。</p>
        ) : (
          <div className="space-y-2.5">
            {value.host_volumes.map((hv, idx) => (
              <div key={idx} className="rounded-lg border border-slate-200/80 dark:border-slate-800 p-2.5 space-y-2 bg-slate-50/50 dark:bg-slate-950/30">
                <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr_auto] gap-2 items-end">
                  <Input
                    label="卷名称"
                    required
                    placeholder="例如 data"
                    pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,62}"
                    value={hv.name}
                    onChange={(e) => {
                      const nextName = e.target.value;
                      onChange({
                        ...value,
                        host_volumes: value.host_volumes.map((item, i) => {
                          if (i !== idx) return item;
                          const autoPath = nextName.trim() ? `/opt/nomad-deck/nomad/volumes/${nextName.trim()}` : '/opt/nomad-deck/nomad/volumes/';
                          return {
                            ...item,
                            name: nextName,
                            path: item.customPath ? item.path : autoPath,
                          };
                        }),
                      });
                    }}
                  />
                  <Input
                    label="宿主机路径"
                    required
                    placeholder="/opt/nomad-deck/nomad/volumes/data"
                    value={hv.path}
                    onChange={(e) => {
                      const nextPath = e.target.value;
                      onChange({
                        ...value,
                        host_volumes: value.host_volumes.map((item, i) =>
                          i === idx ? { ...item, path: nextPath, customPath: true } : item,
                        ),
                      });
                    }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    title="移除该 Host Volume"
                    onClick={() =>
                      onChange({
                        ...value,
                        host_volumes: value.host_volumes.filter((_, i) => i !== idx),
                      })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-4 text-slate-600 dark:text-slate-300">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hv.read_only}
                      onChange={(e) =>
                        onChange({
                          ...value,
                          host_volumes: value.host_volumes.map((item, i) =>
                            i === idx ? { ...item, read_only: e.target.checked } : item,
                          ),
                        })
                      }
                    />
                    <span>只读（read_only）</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hv.create}
                      onChange={(e) =>
                        onChange({
                          ...value,
                          host_volumes: value.host_volumes.map((item, i) =>
                            i === idx ? { ...item, create: e.target.checked } : item,
                          ),
                        })
                      }
                    />
                    <span>目录不存在时自动创建</span>
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Task Drivers: Docker / raw_exec / Denylist */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3.5 space-y-3">
        <div className="font-semibold text-slate-800 dark:text-slate-100">任务驱动插件（Docker / raw_exec / 驱动黑白名单）</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={value.docker.volumes}
              onChange={(e) => onChange({ ...value, docker: { ...value.docker, volumes: e.target.checked } })}
            />
            <span>Docker 允许卷挂载（volumes）</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={value.docker.allow_privileged}
              onChange={(e) => onChange({ ...value, docker: { ...value.docker, allow_privileged: e.target.checked } })}
            />
            <span>Docker 允许特权容器（privileged）</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={value.docker.disable_image_gc}
              onChange={(e) => onChange({ ...value, docker: { ...value.docker, disable_image_gc: e.target.checked } })}
            />
            <span>关闭 Docker 镜像自动 GC</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-amber-700 dark:text-amber-300">
            <input
              type="checkbox"
              checked={value.raw_exec}
              onChange={(e) => onChange({ ...value, raw_exec: e.target.checked })}
            />
            <span>启用 raw_exec（宿主机直接执行，无隔离）</span>
          </label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label="Docker 镜像 GC 延迟"
            placeholder="3m"
            value={value.docker.image_gc_delay}
            onChange={(e) => onChange({ ...value, docker: { ...value.docker, image_gc_delay: e.target.value } })}
          />
          <Input
            label="Docker 私有仓库 Auth 文件路径（可选）"
            placeholder="/root/.docker/config.json"
            value={value.docker.auth_config}
            onChange={(e) => onChange({ ...value, docker: { ...value.docker, auth_config: e.target.value } })}
          />
        </div>
        <div className="space-y-2 pt-1">
          <div className="text-slate-700 dark:text-slate-300 font-medium">驱动禁用列表（driver.denylist）</div>
          <div className="flex flex-wrap gap-3">
            {COMMON_DRIVERS.map((drv) => (
              <label key={drv} className="flex items-center gap-1.5 cursor-pointer text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={value.driver_denylist.includes(drv)}
                  onChange={(e) => toggleDeny(drv, e.target.checked)}
                />
                <span className="font-mono">{drv}</span>
              </label>
            ))}
          </div>
          <Input
            label="其他禁用驱动（逗号分隔，可选）"
            placeholder="例如 rkt, singularity"
            value={value.extra_denylist}
            onChange={(e) => onChange({ ...value, extra_denylist: e.target.value })}
          />
        </div>
      </div>

      {/* Node Pool / CPU / Meta */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3.5 space-y-3">
        <div className="font-semibold text-slate-800 dark:text-slate-100">节点资源池、算力与 Client Meta 标签</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Input
              label="Node Pool（留空为 default）"
              list="nomad-node-pool-list"
              placeholder="default"
              value={value.node_pool}
              onChange={(e) => onChange({ ...value, node_pool: e.target.value })}
            />
            {nodePools.length > 0 && (
              <datalist id="nomad-node-pool-list">
                {nodePools.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            )}
          </div>
          <Input
            label="CPU 总算力覆盖（MHz，0=自动探测）"
            type="number"
            min={0}
            placeholder="0"
            value={value.cpu_total_compute}
            onChange={(e) => onChange({ ...value, cpu_total_compute: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-medium text-slate-700 dark:text-slate-300">Client Meta（72-client-meta.hcl）</span>
            <Button
              size="sm"
              onClick={() => onChange({ ...value, meta: [...value.meta, { key: '', value: '' }] })}
            >
              <Plus className="h-3.5 w-3.5" />
              <span>添加标签</span>
            </Button>
          </div>
          {value.meta.map((row, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
              <Input
                placeholder="键，例如 rack"
                value={row.key}
                onChange={(e) =>
                  onChange({
                    ...value,
                    meta: value.meta.map((m, i) => (i === idx ? { ...m, key: e.target.value } : m)),
                  })
                }
              />
              <Input
                placeholder="值，例如 r1"
                value={row.value}
                onChange={(e) =>
                  onChange({
                    ...value,
                    meta: value.meta.map((m, i) => (i === idx ? { ...m, value: e.target.value } : m)),
                  })
                }
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onChange({ ...value, meta: value.meta.filter((_, i) => i !== idx) })}
              >
                <Trash2 className="h-3.5 w-3.5 text-rose-500" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function NomadClusterSettingsModal({
  open,
  cluster,
  onClose,
  onSaved,
}: {
  open: boolean;
  cluster: any;
  onClose: () => void;
  onSaved: (taskId?: string) => Promise<void>;
}) {
  const toast = useToast();
  const [cniVersions, setCniVersions] = useState<string[]>([]);
  const [cniVersion, setCniVersion] = useState('');
  const [publicURL, setPublicURL] = useState('');
  const [telemetry, setTelemetry] = useState(true);
  const [uiEnabled, setUiEnabled] = useState(true);
  const [uiLabel, setUiLabel] = useState('');
  const [uiLabelBG, setUiLabelBG] = useState('');
  const [uiLabelFG, setUiLabelFG] = useState('');
  const [vaultUIURL, setVaultUIURL] = useState('');
  const [jobGC, setJobGC] = useState('');
  const [execEnabled, setExecEnabled] = useState(true);
  const [useProxy, setUseProxy] = useState(false);
  const [confirmSingle, setConfirmSingle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const isSingleDeployed = cluster?.mode === 'single' && cluster?.init_state === 'initialized';

  useEffect(() => {
    if (!open || !cluster) return;
    const st = cluster.settings || {};
    const ui = st.ui || {};
    setCniVersion(st.cni_version || '');
    setPublicURL(cluster.public_api_url || '');
    setTelemetry(!st.disable_telemetry);
    setUiEnabled(!ui.disabled);
    setUiLabel(ui.label || '');
    setUiLabelBG(ui.label_background || '');
    setUiLabelFG(ui.label_text_color || '');
    setVaultUIURL(ui.vault_ui_url || '');
    setJobGC(st.job_gc_threshold || '');
    setExecEnabled(st.exec_enabled !== false);
    setUseProxy(Boolean(st.use_proxy));
    setConfirmSingle(false);
    setErr('');

    void apiGet('/api/v1/releases/cni')
      .then((r) => setCniVersions((r.versions || []) as string[]))
      .catch(() => setCniVersions([]));
  }, [open, cluster]);

  const handleToggleProxy = async (next: boolean) => {
    if (!(await canEnableSystemProxy(next, (msg) => { setErr(msg); toast.error(msg); }))) return;
    setErr('');
    setUseProxy(next);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cluster) return;
    setBusy(true);
    setErr('');
    try {
      const res = await apiPut(`/api/v1/clusters/${cluster.id}`, {
        public_api_url: publicURL.trim(),
        cni_version: cniVersion,
        disable_telemetry: !telemetry,
        job_gc_threshold: jobGC.trim(),
        exec_enabled: execEnabled,
        use_proxy: useProxy,
        confirm_single_node: confirmSingle,
        ui: {
          disabled: !uiEnabled,
          label: uiLabel.trim() || undefined,
          label_background: uiLabelBG.trim() || undefined,
          label_text_color: uiLabelFG.trim() || undefined,
          vault_ui_url: vaultUIURL.trim() || undefined,
        },
      });
      await onSaved(res?.task?.id);
      onClose();
    } catch (ex: any) {
      setErr(ex?.message || '更新集群配置失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={`集群配置：${cluster?.name || ''}`} size="lg" busy={busy} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4 text-xs">
        <ErrorAlert message={err} onClose={() => setErr('')} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select label="集群 CNI 插件版本" value={cniVersion} onChange={(e) => setCniVersion(e.target.value)}>
            <option value="">未选择</option>
            {cniVersions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
          <Input
            label="Job GC 回收阈值（例如 4h）"
            placeholder="留空保持 Nomad 默认"
            value={jobGC}
            onChange={(e) => setJobGC(e.target.value)}
          />
        </div>
        <Input
          label="统一业务入口 URL（Public API URL）"
          placeholder="https://nomad.example.com"
          value={publicURL}
          onChange={(e) => setPublicURL(e.target.value)}
        />
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3.5 space-y-3">
          <div className="font-semibold text-slate-800 dark:text-slate-100">Nomad 原生 UI 与运行指标</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={uiEnabled} onChange={(e) => setUiEnabled(e.target.checked)} />
              <span>启用 Nomad 原生 UI（35-ui.hcl）</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={telemetry} onChange={(e) => setTelemetry(e.target.checked)} />
              <span>启用 Prometheus Telemetry（40-telemetry.hcl）</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={execEnabled} onChange={(e) => setExecEnabled(e.target.checked)} />
              <span>允许交互式终端与 Job Action（Exec）</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={useProxy} onChange={(e) => void handleToggleProxy(e.target.checked)} />
              <span>下载 CNI 更新时通过系统代理</span>
            </label>
          </div>
          {uiEnabled && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <Input label="UI 环境标签文字（例如 prod）" value={uiLabel} onChange={(e) => setUiLabel(e.target.value)} />
              <Input label="关联 Vault UI 地址（可选）" placeholder="https://vault.example.com" value={vaultUIURL} onChange={(e) => setVaultUIURL(e.target.value)} />
              <Input label="标签背景色（可选）" placeholder="#dc2626 或 red" value={uiLabelBG} onChange={(e) => setUiLabelBG(e.target.value)} />
              <Input label="标签文字色（可选）" placeholder="#ffffff" value={uiLabelFG} onChange={(e) => setUiLabelFG(e.target.value)} />
            </div>
          )}
        </div>
        {isSingleDeployed && (
          <label className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 cursor-pointer">
            <input
              className="mt-0.5"
              type="checkbox"
              required
              checked={confirmSingle}
              onChange={(e) => setConfirmSingle(e.target.checked)}
            />
            <span>单机模式滚动下发配置会重启唯一节点并短时中断 API 与调度，我已知悉并确认执行。</span>
          </label>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            保存并下发配置
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function NomadNodeConfigModal({
  open,
  cluster,
  member,
  nodePools,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  cluster: any;
  member: any;
  nodePools: string[];
  onClose: () => void;
  onSubmitted: (taskId?: string, title?: string) => Promise<void>;
}) {
  const toast = useToast();
  const askConfirm = useConfirm();
  const [draft, setDraft] = useState<ClientPluginDraft>(defaultClientPluginDraft);
  const [cniVersions, setCniVersions] = useState<string[]>([]);
  const [cniVersion, setCniVersion] = useState('');
  const [reinstallCNI, setReinstallCNI] = useState(false);
  const [extraSANs, setExtraSANs] = useState('');
  const [useProxy, setUseProxy] = useState(false);
  const [confirmSingle, setConfirmSingle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const isClient = member ? member.role !== 'server' : false;
  const isInstalled = member?.install_state === 'installed';
  const isSingleServer = cluster?.mode === 'single' && member?.role !== 'client';
  const gen = Number(member?.config?.config_generation || 0);
  const clusterCNI = cluster?.settings?.cni_version || '';
  const showCNIProxyOption = isInstalled && isClient && draft.cni && (!member?.config?.cni || reinstallCNI || cniVersion !== clusterCNI);

  useEffect(() => {
    if (!open || !cluster || !member) return;
    setDraft(clientPluginDraftFromConfig(member.config));
    setCniVersion(cluster.settings?.cni_version || '');
    setReinstallCNI(false);
    setExtraSANs(Array.isArray(member.config?.extra_sans) ? member.config.extra_sans.join(', ') : '');
    setUseProxy(Boolean(cluster.settings?.use_proxy));
    setConfirmSingle(false);
    setErr('');

    if (isClient) {
      void apiGet('/api/v1/releases/cni')
        .then((r) => setCniVersions((r.versions || []) as string[]))
        .catch(() => setCniVersions([]));
    }
  }, [open, cluster, member, isClient]);

  const handleToggleProxy = async (next: boolean) => {
    if (!(await canEnableSystemProxy(next, (msg) => { setErr(msg); toast.error(msg); }))) return;
    setErr('');
    setUseProxy(next);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cluster || !member) return;
    setBusy(true);
    setErr('');
    try {
      if (isClient && draft.cni) {
        if (!cniVersion) {
          setErr('启用 CNI 时请先选择集群 CNI 插件版本');
          setBusy(false);
          return;
        }
        if (cniVersion !== clusterCNI) {
          await apiPut(`/api/v1/clusters/${cluster.id}`, {
            cni_version: cniVersion,
            confirm_single_node: confirmSingle,
            use_proxy: showCNIProxyOption ? useProxy : undefined,
          });
        }
      }
      const sans = extraSANs
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const clientPayload = isClient ? buildClientSettingsPayload(draft) : {};
      const res = await apiPut(`/api/v1/clusters/${cluster.id}/nodes/${member.node_id}/config`, {
        ...clientPayload,
        extra_sans: sans.length > 0 ? sans : undefined,
        reinstall_cni: reinstallCNI,
        use_proxy: showCNIProxyOption ? useProxy : undefined,
        confirm_single_node: confirmSingle,
      });
      await onSubmitted(res?.task?.id, `更新节点配置: ${member.name}`);
      onClose();
    } catch (ex: any) {
      setErr(ex?.message || '更新节点配置失败');
    } finally {
      setBusy(false);
    }
  };

  const handleRollback = async () => {
    if (!cluster || !member) return;
    if (isInstalled && isSingleServer && !confirmSingle) {
      setErr('单机模式回滚配置会重启唯一节点，请先勾选下方单机维护确认框。');
      return;
    }
    if (
      !(await askConfirm(`确认将节点「${member.name}」的配置切回上一代际并重启 Nomad 服务吗？`, {
        title: '回滚节点配置代际',
        confirmText: '确认回滚',
      }))
    ) {
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const res = await apiPost(`/api/v1/clusters/${cluster.id}/nodes/${member.node_id}/config/rollback`, {
        confirm_single_node: confirmSingle,
      });
      toast.success('已发起配置代际回滚任务');
      await onSubmitted(res?.task?.id, `回滚节点配置: ${member.name}`);
      onClose();
    } catch (ex: any) {
      setErr(ex?.message || '回滚配置失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={
        <span className="inline-flex items-center gap-2">
          <span>节点插件与配置：{member?.name}</span>
          {gen > 0 && <Badge>配置代际 #{gen}</Badge>}
        </span>
      }
      size="xl"
      busy={busy}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4 text-xs">
        <ErrorAlert message={err} onClose={() => setErr('')} />
        {isClient ? (
          <ClientPluginFields
            value={draft}
            onChange={setDraft}
            cniVersions={cniVersions}
            cniVersion={cniVersion}
            onChangeCNIVersion={setCniVersion}
            cniVersionEditable={!cluster?.settings?.cni_version || cluster?.init_state !== 'initialized'}
            nodePools={nodePools}
            showReinstallCNI={isInstalled && Boolean(member?.config?.cni)}
            reinstallCNI={reinstallCNI}
            onChangeReinstallCNI={setReinstallCNI}
          />
        ) : (
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-slate-600 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-300">
            纯 Server 节点不运行任务，仅支持配置 TLS 附加 SAN 与配置代际回滚；CNI、Host Volume、Docker 驱动等仅适用于 Client 或 Server + Client 节点。
          </div>
        )}

        {cluster?.tls_enabled && (
          <Input
            label="节点 TLS 证书附加 SAN（可选，逗号分隔）"
            placeholder="例如 nomad-node.internal, 192.168.10.20"
            value={extraSANs}
            onChange={(e) => setExtraSANs(e.target.value)}
          />
        )}

        {showCNIProxyOption && (
          <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
            <input type="checkbox" checked={useProxy} onChange={(e) => void handleToggleProxy(e.target.checked)} />
            <span>下载 CNI 插件包时通过系统代理</span>
          </label>
        )}

        {isInstalled && isSingleServer && (
          <label className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 cursor-pointer">
            <input
              className="mt-0.5"
              type="checkbox"
              required
              checked={confirmSingle}
              onChange={(e) => setConfirmSingle(e.target.checked)}
            />
            <span>单机模式更新节点配置会重启唯一节点并短时中断服务，我已知悉并确认继续。</span>
          </label>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div>
            {isInstalled && gen > 1 && (
              <Button type="button" disabled={busy} onClick={() => void handleRollback()}>
                <RotateCcw className="h-3.5 w-3.5" />
                <span>回滚上一配置代际</span>
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              {isInstalled ? '保存并滚动生效' : '保存配置'}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
