import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Code2, Container, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useConfirm } from './ConfirmDialog';
import { useToast } from './Toast';
import { CodeEditor } from './CodeEditor';
import { dockerModeLabelOf, dockerStatusLabelOf } from './DockerManageModal';
import { Badge, Button, Card, ErrorAlert, Input, Modal, Select, StatusBadge, TermLabel } from './UI';

export interface HostVolumeDraft {
  name: string;
  path: string;
  read_only: boolean;
  create: boolean;
  customPath?: boolean;
}

export interface HostNetworkDraft {
  name: string;
  cidr: string;
  interface: string;
  reserved_ports: string;
}

export interface DanglingContainersDraft {
  customized: boolean;
  enabled: boolean;
  dry_run: boolean;
  period: string;
  creation_grace: string;
}

export interface TelemetryDraft {
  collection_interval: string;
  disable_hostname: boolean;
  prometheus_metrics: boolean;
  publish_allocation_metrics: boolean;
  publish_node_metrics: boolean;
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
  host_networks: HostNetworkDraft[];
  meta: MetaDraft[];
  docker: {
    allow_privileged: boolean;
    volumes: boolean;
    disable_image_gc: boolean;
    image_gc_delay: string;
    disable_container_gc: boolean;
    dangling_containers: DanglingContainersDraft;
    extra_labels: string;
    auth_config: string;
  };
}

const COMMON_DRIVERS = ['docker', 'exec', 'raw_exec', 'java', 'qemu'];
const COMMON_DOCKER_EXTRA_LABELS = 'job_name, task_group_name, task_name, namespace, node_name, short_alloc_id';

export function defaultTelemetryDraft(): TelemetryDraft {
  return {
    collection_interval: '10s',
    disable_hostname: true,
    prometheus_metrics: true,
    publish_allocation_metrics: true,
    publish_node_metrics: true,
  };
}

export function telemetryDraftFromSettings(settings: any): TelemetryDraft {
  const st = settings || {};
  const t = st.telemetry || {};
  const enabled = !st.disable_telemetry;
  return {
    collection_interval: t.collection_interval || '10s',
    disable_hostname: t.disable_hostname !== undefined ? Boolean(t.disable_hostname) : true,
    prometheus_metrics: t.prometheus_metrics !== undefined ? Boolean(t.prometheus_metrics) : enabled,
    publish_allocation_metrics: t.publish_allocation_metrics !== undefined ? Boolean(t.publish_allocation_metrics) : enabled,
    publish_node_metrics: t.publish_node_metrics !== undefined ? Boolean(t.publish_node_metrics) : enabled,
  };
}

export function buildTelemetryPayload(draft: TelemetryDraft) {
  const interval = draft.collection_interval.trim() || '10s';
  return {
    disable_telemetry: !(draft.prometheus_metrics || draft.publish_allocation_metrics || draft.publish_node_metrics),
    telemetry: {
      collection_interval: interval,
      disable_hostname: draft.disable_hostname,
      prometheus_metrics: draft.prometheus_metrics,
      publish_allocation_metrics: draft.publish_allocation_metrics,
      publish_node_metrics: draft.publish_node_metrics,
    },
  };
}

export function defaultClientPluginDraft(): ClientPluginDraft {
  return {
    cni: false,
    raw_exec: false,
    node_pool: '',
    cpu_total_compute: '',
    driver_denylist: [],
    extra_denylist: '',
    host_volumes: [],
    host_networks: [],
    meta: [],
    docker: {
      allow_privileged: false,
      volumes: true,
      disable_image_gc: false,
      image_gc_delay: '3m',
      disable_container_gc: false,
      dangling_containers: {
        customized: false,
        enabled: true,
        dry_run: false,
        period: '5m',
        creation_grace: '5m',
      },
      extra_labels: '',
      auth_config: '',
    },
  };
}

export function clientPluginDraftFromConfig(cfg: any): ClientPluginDraft {
  const c = cfg || {};
  const d = c.docker || {};
  const dc = d.dangling_containers || null;
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
  const nets: HostNetworkDraft[] = Array.isArray(c.host_networks)
    ? c.host_networks.map((hn: any) => ({
        name: hn.name || '',
        cidr: hn.cidr || '',
        interface: hn.interface || '',
        reserved_ports: hn.reserved_ports || '',
      }))
    : [];
  const metaObj = c.meta && typeof c.meta === 'object' ? (c.meta as Record<string, string>) : {};
  const metaRows: MetaDraft[] = Object.entries(metaObj)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value: String(value ?? '') }));
  const extraLabels = Array.isArray(d.extra_labels) ? (d.extra_labels as string[]).join(', ') : '';

  return {
    cni: Boolean(c.cni),
    raw_exec: Boolean(c.raw_exec),
    node_pool: c.node_pool || '',
    cpu_total_compute: c.cpu_total_compute ? String(c.cpu_total_compute) : '',
    driver_denylist: knownDeny,
    extra_denylist: extraDeny,
    host_volumes: vols,
    host_networks: nets,
    meta: metaRows,
    docker: {
      allow_privileged: Boolean(d.allow_privileged),
      volumes: d.volumes !== undefined ? Boolean(d.volumes) : true,
      disable_image_gc: Boolean(d.disable_image_gc),
      image_gc_delay: d.image_gc_delay || '3m',
      disable_container_gc: Boolean(d.disable_container_gc),
      dangling_containers: {
        customized: Boolean(dc),
        enabled: dc?.enabled !== undefined ? Boolean(dc.enabled) : true,
        dry_run: Boolean(dc?.dry_run),
        period: dc?.period || '5m',
        creation_grace: dc?.creation_grace || '5m',
      },
      extra_labels: extraLabels,
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
  const hostNetworks = draft.host_networks
    .filter((n) => n.name.trim() || n.cidr.trim() || n.interface.trim() || n.reserved_ports.trim())
    .map((n) => ({
      name: n.name.trim(),
      cidr: n.cidr.trim() || undefined,
      interface: n.interface.trim() || undefined,
      reserved_ports: n.reserved_ports.trim() || undefined,
    }));
  const extraLabels = Array.from(
    new Set(
      draft.docker.extra_labels
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
  const dc = draft.docker.dangling_containers;

  return {
    cni: draft.cni,
    raw_exec: draft.raw_exec,
    node_pool: draft.node_pool.trim() || undefined,
    cpu_total_compute: Number(draft.cpu_total_compute) || 0,
    driver_denylist: denylist.length > 0 ? denylist : undefined,
    host_volumes: hostVolumes.length > 0 ? hostVolumes : undefined,
    host_networks: hostNetworks.length > 0 ? hostNetworks : undefined,
    meta: Object.keys(meta).length > 0 ? meta : undefined,
    docker: {
      allow_privileged: draft.docker.allow_privileged,
      volumes: draft.docker.volumes,
      disable_image_gc: draft.docker.disable_image_gc,
      image_gc_delay: draft.docker.image_gc_delay.trim() || undefined,
      disable_container_gc: draft.docker.disable_container_gc || undefined,
      dangling_containers: dc.customized
        ? {
            enabled: dc.enabled,
            dry_run: dc.dry_run,
            period: dc.period.trim() || undefined,
            creation_grace: dc.creation_grace.trim() || undefined,
          }
        : undefined,
      extra_labels: extraLabels.length > 0 ? extraLabels : undefined,
      auth_config: draft.docker.auth_config.trim() || undefined,
    },
  };
}

export function TelemetryFields({
  value,
  onChange,
}: {
  value: TelemetryDraft;
  onChange: (next: TelemetryDraft) => void;
}) {
  const { tr } = useI18n();
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 dark:border-slate-700 p-3.5 text-xs">
      <div className="font-semibold text-slate-800 dark:text-slate-100">
        {tr('运行指标采集 (40-telemetry.hcl)', 'Telemetry (40-telemetry.hcl)')}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            checked={value.prometheus_metrics}
            onChange={(e) => onChange({ ...value, prometheus_metrics: e.target.checked })}
          />
          <span>{tr('暴露 Prometheus 指标 (prometheus_metrics)', 'Expose Prometheus Metrics')}</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            checked={value.publish_allocation_metrics}
            onChange={(e) => onChange({ ...value, publish_allocation_metrics: e.target.checked })}
          />
          <span>{tr('上报 Allocation 指标 (publish_allocation_metrics)', 'Publish Allocation Metrics')}</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            checked={value.publish_node_metrics}
            onChange={(e) => onChange({ ...value, publish_node_metrics: e.target.checked })}
          />
          <span>{tr('上报 Node 指标 (publish_node_metrics)', 'Publish Node Metrics')}</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            checked={value.disable_hostname}
            onChange={(e) => onChange({ ...value, disable_hostname: e.target.checked })}
          />
          <span>{tr('指标名省略主机名前缀 (disable_hostname)', 'Omit Hostname Prefix (disable_hostname)')}</span>
        </label>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          label={tr('指标采集周期 (collection_interval)', 'Collection Interval')}
          placeholder="10s"
          hint={tr('Go 时长格式，例如 1s、10s、1m', 'Go duration, e.g. 1s, 10s, 1m')}
          value={value.collection_interval}
          onChange={(e) => onChange({ ...value, collection_interval: e.target.value })}
        />
      </div>
    </div>
  );
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
  const { locale, tr } = useI18n();
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
              term={tr('CNI 网络插件', 'CNI Network Plugins')}
              tip={tr('安装 containernetworking/plugins 到 /opt/cni/bin 并启用 bridge 内核参数与 83-cni.hcl，支持 Nomad bridge 网络模式及端口映射。', 'Installs containernetworking/plugins to /opt/cni/bin and enables bridge sysctls + 83-cni.hcl for Nomad bridge networking and port mapping.')}
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
            <span>{tr('启用 CNI', 'Enable CNI')}</span>
          </label>
        </div>
        {(value.cni || cniVersion) && (
          <div className="space-y-2.5">
            {cniVersionEditable && onChangeCNIVersion ? (
              <Select
                label={tr('集群 CNI 插件版本', 'Cluster CNI Plugin Version')}
                value={cniVersion}
                onChange={(e) => onChangeCNIVersion(e.target.value)}
              >
                <option value="">{tr('请选择 CNI 版本…', 'Select CNI version...')}</option>
                {cniVersions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </Select>
            ) : (
              <div className="text-slate-500">
                {tr('集群 CNI 版本：', 'Cluster CNI version: ')}<span className="font-mono font-medium text-slate-800 dark:text-slate-200">{cniVersion || tr('未设置', 'Unset')}</span>
              </div>
            )}
            {showReinstallCNI && value.cni && onChangeReinstallCNI && (
              <label className="flex items-center gap-2 cursor-pointer text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={reinstallCNI}
                  onChange={(e) => onChangeReinstallCNI(e.target.checked)}
                />
                <span>{tr('重新下载并修复安装 CNI 插件二进制（对应 Doctor 缺少 CNI 插件告警）', 'Re-download and reinstall CNI plugin binaries')}</span>
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
              term={tr('Host Volumes（宿主机挂载卷）', 'Host Volumes')}
              tip={tr('在 Client 节点生成 70-host-volume-<name>.hcl，Job 可通过 volume 块按名称挂载宿主机目录。禁止使用 /etc、/usr 等系统目录。', 'Generates 70-host-volume-<name>.hcl on Client nodes so Jobs can mount host paths by volume name. System dirs like /etc and /usr are disallowed.')}
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
            <span>{tr('添加卷', 'Add Volume')}</span>
          </Button>
        </div>
        {value.host_volumes.length === 0 ? (
          <p className="text-slate-500">{tr('未配置 Host Volume。', 'No Host Volumes configured.')}</p>
        ) : (
          <div className="space-y-2.5">
            {value.host_volumes.map((hv, idx) => (
              <div key={idx} className="rounded-lg border border-slate-200/80 dark:border-slate-800 p-2.5 space-y-2 bg-slate-50/50 dark:bg-slate-950/30">
                <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr_auto] gap-2 items-end">
                  <Input
                    label={tr('卷名称', 'Volume Name')}
                    required
                    placeholder={tr('例如 data', 'e.g. data')}
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
                    label={tr('宿主机路径', 'Host Path')}
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
                    title={tr('移除该 Host Volume', 'Remove Host Volume')}
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
                    <span>{tr('只读（read_only）', 'Read-only (read_only)')}</span>
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
                    <span>{tr('目录不存在时自动创建', 'Create directory if missing')}</span>
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Host Networks */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3.5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold text-slate-800 dark:text-slate-100">
            <TermLabel
              term={tr('Host Networks（宿主机网络）', 'Host Networks')}
              tip={tr('在 Client 节点生成 71-host-network-<name>.hcl（client { host_network }），需至少填写 CIDR 或网卡名，Job 端口可通过 host_network 绑定指定网络。', 'Generates 71-host-network-<name>.hcl (client { host_network }) on Client nodes. Specify cidr and/or interface so Job ports can bind via host_network.')}
            />
          </div>
          <Button
            size="sm"
            onClick={() =>
              onChange({
                ...value,
                host_networks: [
                  ...value.host_networks,
                  { name: '', cidr: '', interface: '', reserved_ports: '' },
                ],
              })
            }
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{tr('添加网络', 'Add Network')}</span>
          </Button>
        </div>
        {value.host_networks.length === 0 ? (
          <p className="text-slate-500">{tr('未配置 Host Network（默认使用宿主机主网卡）。', 'No Host Networks configured.')}</p>
        ) : (
          <div className="space-y-2.5">
            {value.host_networks.map((hn, idx) => (
              <div key={idx} className="rounded-lg border border-slate-200/80 dark:border-slate-800 p-2.5 space-y-2 bg-slate-50/50 dark:bg-slate-950/30">
                <div className="grid grid-cols-1 sm:grid-cols-[130px_1fr_1fr_1fr_auto] gap-2 items-end">
                  <Input
                    label={tr('网络名称', 'Name')}
                    required
                    placeholder="loopback"
                    pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,62}"
                    value={hn.name}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        host_networks: value.host_networks.map((item, i) =>
                          i === idx ? { ...item, name: e.target.value } : item,
                        ),
                      })
                    }
                  />
                  <Input
                    label="CIDR"
                    placeholder="127.0.0.1/32"
                    value={hn.cidr}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        host_networks: value.host_networks.map((item, i) =>
                          i === idx ? { ...item, cidr: e.target.value } : item,
                        ),
                      })
                    }
                  />
                  <Input
                    label={tr('网卡接口 (interface)', 'Interface')}
                    placeholder={tr('例如 lo / eth0', 'e.g. lo / eth0')}
                    value={hn.interface}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        host_networks: value.host_networks.map((item, i) =>
                          i === idx ? { ...item, interface: e.target.value } : item,
                        ),
                      })
                    }
                  />
                  <Input
                    label={tr('保留端口 (reserved_ports)', 'Reserved Ports')}
                    placeholder={tr('例如 22,80-85', 'e.g. 22,80-85')}
                    value={hn.reserved_ports}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        host_networks: value.host_networks.map((item, i) =>
                          i === idx ? { ...item, reserved_ports: e.target.value } : item,
                        ),
                      })
                    }
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    title={tr('移除该 Host Network', 'Remove Host Network')}
                    onClick={() =>
                      onChange({
                        ...value,
                        host_networks: value.host_networks.filter((_, i) => i !== idx),
                      })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Task Drivers: Docker / raw_exec / Denylist */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3.5 space-y-3">
        <div className="font-semibold text-slate-800 dark:text-slate-100">{tr('任务驱动插件（Docker / raw_exec / 驱动黑白名单）', 'Task Drivers (Docker / raw_exec / Denylist)')}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={value.docker.volumes}
              onChange={(e) => onChange({ ...value, docker: { ...value.docker, volumes: e.target.checked } })}
            />
            <span>{tr('Docker 允许卷挂载（volumes）', 'Docker Allow Volumes')}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={value.docker.allow_privileged}
              onChange={(e) => onChange({ ...value, docker: { ...value.docker, allow_privileged: e.target.checked } })}
            />
            <span>{tr('Docker 允许特权容器（privileged）', 'Docker Allow Privileged')}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={value.docker.disable_image_gc}
              onChange={(e) => onChange({ ...value, docker: { ...value.docker, disable_image_gc: e.target.checked } })}
            />
            <span>{tr('关闭 Docker 镜像自动 GC', 'Disable Docker Image Auto-GC')}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={value.docker.disable_container_gc}
              onChange={(e) => onChange({ ...value, docker: { ...value.docker, disable_container_gc: e.target.checked } })}
            />
            <span>{tr('关闭 Docker 容器自动 GC (gc.container=false)', 'Disable Docker Container GC (gc.container=false)')}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-amber-700 dark:text-amber-300 sm:col-span-2">
            <input
              type="checkbox"
              checked={value.raw_exec}
              onChange={(e) => onChange({ ...value, raw_exec: e.target.checked })}
            />
            <span>{tr('启用 raw_exec（宿主机直接执行，无隔离）', 'Enable raw_exec (unisolated host execution)')}</span>
          </label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label={tr('Docker 镜像 GC 延迟 (gc.image_delay)', 'Docker Image GC Delay')}
            placeholder="3m"
            value={value.docker.image_gc_delay}
            onChange={(e) => onChange({ ...value, docker: { ...value.docker, image_gc_delay: e.target.value } })}
          />
          <Input
            label={tr('Docker 私有仓库 Auth 文件路径（可选）', 'Docker Registry Auth File (optional)')}
            placeholder="/root/.docker/config.json"
            value={value.docker.auth_config}
            onChange={(e) => onChange({ ...value, docker: { ...value.docker, auth_config: e.target.value } })}
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {tr('Docker 附加容器标签 (extra_labels，逗号分隔)', 'Docker Extra Labels (extra_labels, comma-separated)')}
            </span>
            <button
              type="button"
              onClick={() => onChange({ ...value, docker: { ...value.docker, extra_labels: COMMON_DOCKER_EXTRA_LABELS } })}
              className="text-indigo-600 hover:underline dark:text-indigo-400"
            >
              {tr('填入常用 Nomad 标签', 'Fill common Nomad labels')}
            </button>
          </div>
          <Input
            placeholder="job_name, task_group_name, task_name, namespace, node_name, short_alloc_id"
            value={value.docker.extra_labels}
            onChange={(e) => onChange({ ...value, docker: { ...value.docker, extra_labels: e.target.value } })}
          />
        </div>
        <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 p-2.5 space-y-2.5 bg-slate-50/50 dark:bg-slate-950/30">
          <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={value.docker.dangling_containers.customized}
              onChange={(e) =>
                onChange({
                  ...value,
                  docker: {
                    ...value.docker,
                    dangling_containers: { ...value.docker.dangling_containers, customized: e.target.checked },
                  },
                })
              }
            />
            <span>{tr('自定义 Docker 悬空容器回收策略 (gc.dangling_containers)', 'Customize Dangling Containers GC (gc.dangling_containers)')}</span>
          </label>
          {value.docker.dangling_containers.customized && (
            <div className="space-y-2.5 pt-1">
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-1.5 cursor-pointer text-slate-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    checked={value.docker.dangling_containers.enabled}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        docker: {
                          ...value.docker,
                          dangling_containers: { ...value.docker.dangling_containers, enabled: e.target.checked },
                        },
                      })
                    }
                  />
                  <span>{tr('启用悬空容器清理 (enabled)', 'Enabled')}</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer text-slate-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    checked={value.docker.dangling_containers.dry_run}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        docker: {
                          ...value.docker,
                          dangling_containers: { ...value.docker.dangling_containers, dry_run: e.target.checked },
                        },
                      })
                    }
                  />
                  <span>{tr('仅演练不删除 (dry_run)', 'Dry Run')}</span>
                </label>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input
                  label={tr('巡检周期 (period)', 'Period')}
                  placeholder="10m"
                  value={value.docker.dangling_containers.period}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      docker: {
                        ...value.docker,
                        dangling_containers: { ...value.docker.dangling_containers, period: e.target.value },
                      },
                    })
                  }
                />
                <Input
                  label={tr('创建宽限期 (creation_grace)', 'Creation Grace')}
                  placeholder="10m"
                  value={value.docker.dangling_containers.creation_grace}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      docker: {
                        ...value.docker,
                        dangling_containers: { ...value.docker.dangling_containers, creation_grace: e.target.value },
                      },
                    })
                  }
                />
              </div>
            </div>
          )}
        </div>
        <div className="space-y-2 pt-1">
          <div className="text-slate-700 dark:text-slate-300 font-medium">{tr('驱动禁用列表（driver.denylist）', 'Driver Denylist (driver.denylist)')}</div>
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
            label={tr('其他禁用驱动（逗号分隔，可选）', 'Additional Denied Drivers (comma-separated)')}
            placeholder={tr('例如 rkt, singularity', 'e.g. rkt, singularity')}
            value={value.extra_denylist}
            onChange={(e) => onChange({ ...value, extra_denylist: e.target.value })}
          />
        </div>
      </div>

      {/* Node Pool / CPU / Meta */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3.5 space-y-3">
        <div className="font-semibold text-slate-800 dark:text-slate-100">{tr('节点资源池、算力与 Client Meta 标签', 'Node Pool, CPU Compute & Client Meta')}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Input
              label={tr('Node Pool（留空为 default）', 'Node Pool (blank = default)')}
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
            label={tr('CPU 总算力覆盖（MHz，0=自动探测）', 'CPU Total Compute Override (MHz, 0=auto)')}
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
              <span>{tr('添加标签', 'Add Tag')}</span>
            </Button>
          </div>
          {value.meta.map((row, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
              <Input
                placeholder={tr('键，例如 rack', 'Key, e.g. rack')}
                value={row.key}
                onChange={(e) =>
                  onChange({
                    ...value,
                    meta: value.meta.map((m, i) => (i === idx ? { ...m, key: e.target.value } : m)),
                  })
                }
              />
              <Input
                placeholder={tr('值，例如 r1', 'Value, e.g. r1')}
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

const CUSTOM_HCL_PRESETS: Array<{
  id: string;
  label: string;
  labelEn: string;
  clientOnly?: boolean;
  hcl: string;
}> = [
  {
    id: 'client-loopback',
    label: 'Client 默认仅绑定回环（单机+反代）',
    labelEn: 'Client Loopback Default (Single-Node + Reverse Proxy)',
    clientOnly: true,
    hcl: `client {
  network_interface                  = "lo"
  preferred_address_family           = "ipv4"
  bind_wildcard_default_host_network = false
}`,
  },
  {
    id: 'client-reserved',
    label: 'Client 预留宿主机资源 (reserved)',
    labelEn: 'Client Reserved Resources',
    clientOnly: true,
    hcl: `client {
  reserved {
    cpu    = 200
    memory = 256
    disk   = 1024
  }
}`,
  },
  {
    id: 'limits',
    label: '连接限流 (limits)',
    labelEn: 'Connection Limits',
    hcl: `limits {
  http_max_conns_per_client = 200
}`,
  },
];

function CustomHCLSection({
  scope,
  value,
  onChange,
  includeClientPresets = true,
}: {
  scope: 'cluster' | 'node';
  value: string;
  onChange: (next: string) => void;
  includeClientPresets?: boolean;
}) {
  const { tr } = useI18n();
  const hasValue = value.trim().length > 0;
  const [expanded, setExpanded] = useState(hasValue);

  useEffect(() => {
    if (value.trim().length > 0) setExpanded(true);
  }, [value]);

  const fileName = scope === 'cluster' ? '90-cluster-custom.hcl' : '95-node-custom.hcl';
  const presets = CUSTOM_HCL_PRESETS.filter((p) => !p.clientOnly || includeClientPresets);

  const insertPreset = (hcl: string) => {
    const trimmed = value.trim();
    onChange(trimmed ? `${trimmed}\n\n${hcl}\n` : `${hcl}\n`);
    setExpanded(true);
  };

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3.5 space-y-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-100 hover:text-indigo-600 dark:hover:text-indigo-400"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Code2 className="h-3.5 w-3.5 text-indigo-500" />
          <span>
            {scope === 'cluster'
              ? tr(`集群自定义 HCL 配置（${fileName}，高级）`, `Cluster Custom HCL (${fileName}, Advanced)`)
              : tr(`节点自定义 HCL 配置（${fileName}，高级）`, `Node Custom HCL (${fileName}, Advanced)`)}
          </span>
          {hasValue && <Badge tone="blue">{tr('已配置', 'Configured')}</Badge>}
        </button>
        {expanded && hasValue && (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange('')}>
            {tr('清空', 'Clear')}
          </Button>
        )}
      </div>

      {expanded && (
        <div className="space-y-2.5 pt-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-slate-500 dark:text-slate-400">{tr('快捷插入：', 'Quick Insert:')}</span>
            {presets.map((p) => (
              <Button key={p.id} type="button" size="sm" onClick={() => insertPreset(p.hcl)}>
                <Plus className="h-3 w-3" />
                <span>{tr(p.label, p.labelEn)}</span>
              </Button>
            ))}
          </div>
          <CodeEditor
            value={value}
            onChange={onChange}
            height="180px"
            label={tr(`自定义 HCL (${fileName})`, `Custom HCL (${fileName})`)}
          />
          <p className="text-[11px] leading-5 text-slate-500 dark:text-slate-400">
            {tr(
              `将作为 ${fileName} 随配置代际下发并经 nomad config validate 校验，支持一键回滚。禁止覆盖核心托管项（tls、acl、ports、advertise、bind_addr、data_dir、vault、server.encrypt 等）；请勿在此硬编码明文密码或 Token。`,
              `Deployed as ${fileName} in the config generation, verified with nomad config validate, and rollback-safe. Overriding core managed fields (tls, acl, ports, advertise, bind_addr, data_dir, vault, server.encrypt, etc.) is blocked. Do not hardcode plaintext secrets or tokens here.`,
            )}
          </p>
        </div>
      )}
    </div>
  );
}

export function NomadClusterSettingsPanel({
  cluster,
  isNotDeployed = false,
  onSaved,
}: {
  cluster: any;
  isNotDeployed?: boolean;
  onSaved: (taskId?: string) => Promise<void> | void;
}) {
  const { locale, tr } = useI18n();
  const [cniVersions, setCniVersions] = useState<string[]>([]);
  const [cniVersion, setCniVersion] = useState('');
  const [publicURL, setPublicURL] = useState('');
  const [telemetryDraft, setTelemetryDraft] = useState<TelemetryDraft>(defaultTelemetryDraft);
  const [uiEnabled, setUiEnabled] = useState(true);
  const [uiLabel, setUiLabel] = useState('');
  const [uiLabelBG, setUiLabelBG] = useState('');
  const [uiLabelFG, setUiLabelFG] = useState('');
  const [vaultUIURL, setVaultUIURL] = useState('');
  const [jobGC, setJobGC] = useState('');
  const [execEnabled, setExecEnabled] = useState(true);
  const [customHCL, setCustomHCL] = useState('');
  const [nomadProxyEnabled, setNomadProxyEnabled] = useState(false);
  const [confirmSingle, setConfirmSingle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const isSingleDeployed = cluster?.mode === 'single' && cluster?.init_state === 'initialized';

  const resetDraft = useCallback(() => {
    if (!cluster) return;
    const st = cluster.settings || {};
    const ui = st.ui || {};
    setCniVersion(st.cni_version || '');
    setPublicURL(cluster.public_api_url || '');
    setTelemetryDraft(telemetryDraftFromSettings(st));
    setUiEnabled(!ui.disabled);
    setUiLabel(ui.label || '');
    setUiLabelBG(ui.label_background || '');
    setUiLabelFG(ui.label_text_color || '');
    setVaultUIURL(ui.vault_ui_url || '');
    setJobGC(st.job_gc_threshold || '');
    setExecEnabled(st.exec_enabled !== false);
    setCustomHCL(st.custom_hcl || '');
    setConfirmSingle(false);
    setErr('');
  }, [cluster]);

  useEffect(() => {
    resetDraft();
  }, [resetDraft]);

  useEffect(() => {
    void apiGet('/api/v1/releases/cni')
      .then((r) => setCniVersions((r.versions || []) as string[]))
      .catch(() => setCniVersions([]));
    void apiGet('/api/v1/settings')
      .then((r) => setNomadProxyEnabled(Boolean(r.settings?.['proxy.use_for_nomad'] ?? r.settings?.['proxy.use_for_releases'])))
      .catch(() => setNomadProxyEnabled(false));
  }, []);

  const st = cluster?.settings || {};
  const ui = st.ui || {};
  const initTelemetry = telemetryDraftFromSettings(st);
  const isDirty = Boolean(
    cluster &&
      (cniVersion !== (st.cni_version || '') ||
        publicURL !== (cluster.public_api_url || '') ||
        uiEnabled !== !ui.disabled ||
        uiLabel !== (ui.label || '') ||
        uiLabelBG !== (ui.label_background || '') ||
        uiLabelFG !== (ui.label_text_color || '') ||
        vaultUIURL !== (ui.vault_ui_url || '') ||
        jobGC !== (st.job_gc_threshold || '') ||
        execEnabled !== (st.exec_enabled !== false) ||
        customHCL !== (st.custom_hcl || '') ||
        JSON.stringify(telemetryDraft) !== JSON.stringify(initTelemetry)),
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cluster) return;
    setBusy(true);
    setErr('');
    try {
      const res = await apiPut(`/api/v1/clusters/${cluster.id}`, {
        public_api_url: publicURL.trim(),
        cni_version: cniVersion,
        ...buildTelemetryPayload(telemetryDraft),
        job_gc_threshold: jobGC.trim(),
        exec_enabled: execEnabled,
        custom_hcl: customHCL,
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
    } catch (ex: any) {
      setErr(ex?.message || tr('更新集群配置失败', 'Failed to update cluster settings'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={tr('集群配置', 'Cluster Settings')}
      description={tr('统一配置 CNI 版本、Public API、原生 UI、运行指标采集与自定义 HCL 片段；保存后自动滚动下发到集群节点。', 'Configure CNI version, Public API, native UI, telemetry, and custom HCL snippets; saving rolls out updates across cluster nodes.')}
      actions={
        isDirty ? (
          <Badge tone="amber">{tr('有未保存修改', 'Unsaved changes')}</Badge>
        ) : undefined
      }
    >
      <form onSubmit={submit} className="space-y-4 text-xs">
        <ErrorAlert message={err} onClose={() => setErr('')} />
        {isNotDeployed && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-3 text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200">
            {tr(
              '当前集群尚未完成首次部署：此处保存的参数会先写入集群草稿配置，回到「集群状态详情」点击部署时将自动生效。',
              'This cluster is not deployed yet: changes saved here are stored as pre-deploy settings and applied automatically when you deploy from Cluster Status.',
            )}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select label={tr('集群 CNI 插件版本', 'Cluster CNI Plugin Version')} value={cniVersion} onChange={(e) => setCniVersion(e.target.value)}>
            <option value="">{tr('未选择', 'Not selected')}</option>
            {cniVersions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
          <Input
            label={tr('Job GC 回收阈值（例如 4h）', 'Job GC Threshold (e.g. 4h)')}
            placeholder={tr('留空保持 Nomad 默认', 'Leave blank for Nomad default')}
            value={jobGC}
            onChange={(e) => setJobGC(e.target.value)}
          />
        </div>
        <Input
          label={tr('统一业务入口 URL（Public API URL）', 'Public API URL')}
          placeholder="https://nomad.example.com"
          value={publicURL}
          onChange={(e) => setPublicURL(e.target.value)}
        />
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3.5 space-y-3">
          <div className="font-semibold text-slate-800 dark:text-slate-100">{tr('Nomad 原生 UI 与交互控制', 'Nomad Native UI & Exec Controls')}</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={uiEnabled} onChange={(e) => setUiEnabled(e.target.checked)} />
              <span>{tr('启用 Nomad 原生 UI（35-ui.hcl）', 'Enable Nomad Native UI (35-ui.hcl)')}</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={execEnabled} onChange={(e) => setExecEnabled(e.target.checked)} />
              <span>{tr('允许交互式终端与 Job Action（Exec）', 'Allow Interactive Terminal & Job Exec')}</span>
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-slate-500 dark:text-slate-400">
            <span>{tr('CNI 下载网络：', 'CNI Download Network: ')}{nomadProxyEnabled ? tr('通过系统代理', 'Via system proxy') : tr('直连', 'Direct')}</span>
            <Link to="/settings?tab=proxy" className="text-indigo-600 dark:text-indigo-400 hover:underline">
              {tr('前往下载代理设置', 'Configure download proxy')}
            </Link>
          </div>
          {uiEnabled && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <Input label={tr('UI 环境标签文字（例如 prod）', 'UI Environment Label (e.g. prod)')} value={uiLabel} onChange={(e) => setUiLabel(e.target.value)} />
              <Input label={tr('关联 Vault UI 地址（可选）', 'Linked Vault UI URL (optional)')} placeholder="https://vault.example.com" value={vaultUIURL} onChange={(e) => setVaultUIURL(e.target.value)} />
              <Input label={tr('标签背景色（可选）', 'Label Background Color (optional)')} placeholder={tr('#dc2626 或 red', '#dc2626 or red')} value={uiLabelBG} onChange={(e) => setUiLabelBG(e.target.value)} />
              <Input label={tr('标签文字色（可选）', 'Label Text Color (optional)')} placeholder="#ffffff" value={uiLabelFG} onChange={(e) => setUiLabelFG(e.target.value)} />
            </div>
          )}
        </div>
        <TelemetryFields value={telemetryDraft} onChange={setTelemetryDraft} />
        <CustomHCLSection scope="cluster" value={customHCL} onChange={setCustomHCL} />
        {isSingleDeployed && (
          <label className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 cursor-pointer">
            <input
              className="mt-0.5"
              type="checkbox"
              required
              checked={confirmSingle}
              onChange={(e) => setConfirmSingle(e.target.checked)}
            />
            <span>{tr('单机模式滚动下发配置会重启唯一节点并短时中断 API 与调度，我已知悉并确认执行。', 'In single-node mode, rolling config deployment restarts the sole node and briefly interrupts API and scheduling. I understand and confirm.')}</span>
          </label>
        )}
        <div className="flex justify-end gap-2 pt-2">
          {isDirty && (
            <Button type="button" disabled={busy} onClick={resetDraft}>
              {tr('重置修改', 'Reset')}
            </Button>
          )}
          <Button type="submit" variant="primary" loading={busy}>
            {isNotDeployed ? tr('保存部署前配置', 'Save Pre-Deploy Config') : tr('保存并下发配置', 'Save & Apply Config')}
          </Button>
        </div>
      </form>
    </Card>
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
  const { locale, tr } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const askConfirm = useConfirm();
  const [draft, setDraft] = useState<ClientPluginDraft>(defaultClientPluginDraft);
  const [cniVersions, setCniVersions] = useState<string[]>([]);
  const [cniVersion, setCniVersion] = useState('');
  const [reinstallCNI, setReinstallCNI] = useState(false);
  const [extraSANs, setExtraSANs] = useState('');
  const [customHCL, setCustomHCL] = useState('');
  const [nomadProxyEnabled, setNomadProxyEnabled] = useState(false);
  const [confirmSingle, setConfirmSingle] = useState(false);
  const [dockerInfo, setDockerInfo] = useState<any>(null);
  const [dockerLoading, setDockerLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const isClient = member ? member.role !== 'server' : false;
  const isInstalled = member?.install_state === 'installed';
  const isSingleServer = cluster?.mode === 'single' && member?.role !== 'client';
  const gen = Number(member?.config?.config_generation || 0);
  const clusterCNI = cluster?.settings?.cni_version || '';
  const showCNIProxyOption = isInstalled && isClient && draft.cni && (!member?.config?.cni || reinstallCNI || cniVersion !== clusterCNI);

  const refreshDockerInfo = useCallback(async () => {
    if (!member?.node_id || !isClient) return;
    setDockerLoading(true);
    try {
      const r = await apiGet(`/api/v1/nodes/${member.node_id}/docker`);
      setDockerInfo(r.docker || null);
    } catch {
      setDockerInfo(null);
    } finally {
      setDockerLoading(false);
    }
  }, [member?.node_id, isClient]);

  useEffect(() => {
    if (!open || !cluster || !member) return;
    setDraft(clientPluginDraftFromConfig(member.config));
    setCniVersion(cluster.settings?.cni_version || '');
    setReinstallCNI(false);
    setExtraSANs(Array.isArray(member.config?.extra_sans) ? member.config.extra_sans.join(', ') : '');
    setCustomHCL(member.config?.custom_hcl || '');
    setConfirmSingle(false);
    setDockerInfo(null);
    setErr('');

    if (isClient) {
      void apiGet('/api/v1/releases/cni')
        .then((r) => setCniVersions((r.versions || []) as string[]))
        .catch(() => setCniVersions([]));
      void apiGet('/api/v1/settings')
        .then((r) => setNomadProxyEnabled(Boolean(r.settings?.['proxy.use_for_nomad'] ?? r.settings?.['proxy.use_for_releases'])))
        .catch(() => setNomadProxyEnabled(false));
      void refreshDockerInfo();
    }
  }, [open, cluster, member, isClient, refreshDockerInfo]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cluster || !member) return;
    setBusy(true);
    setErr('');
    try {
      if (isClient && draft.cni) {
        if (!cniVersion) {
          setErr(tr('启用 CNI 时请先选择集群 CNI 插件版本', 'Please select a cluster CNI plugin version when enabling CNI'));
          setBusy(false);
          return;
        }
        if (cniVersion !== clusterCNI) {
          await apiPut(`/api/v1/clusters/${cluster.id}`, {
            cni_version: cniVersion,
            confirm_single_node: confirmSingle,
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
        custom_hcl: customHCL,
        reinstall_cni: reinstallCNI,
        confirm_single_node: confirmSingle,
      });
      await onSubmitted(res?.task?.id, tr(`更新节点配置: ${member.name}`, `Update Node Config: ${member.name}`));
      onClose();
    } catch (ex: any) {
      setErr(ex?.message || tr('更新节点配置失败', 'Failed to update node config'));
    } finally {
      setBusy(false);
    }
  };

  const handleRollback = async () => {
    if (!cluster || !member) return;
    if (isInstalled && isSingleServer && !confirmSingle) {
      setErr(tr('单机模式回滚配置会重启唯一节点，请先勾选下方单机维护确认框。', 'Rolling back config in single-node mode restarts the sole node; please check the confirmation box below.'));
      return;
    }
    if (
      !(await askConfirm(tr(`确认将节点「${member.name}」的配置切回上一代际并重启 Nomad 服务吗？`, `Roll back node "${member.name}" to the previous config generation and restart Nomad?`), {
        title: tr('回滚节点配置代际', 'Rollback Node Config Generation'),
        confirmText: tr('确认回滚', 'Rollback'),
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
      toast.success(tr('已发起配置代际回滚任务', 'Config generation rollback started'));
      await onSubmitted(res?.task?.id, tr(`回滚节点配置: ${member.name}`, `Rollback Node Config: ${member.name}`));
      onClose();
    } catch (ex: any) {
      setErr(ex?.message || tr('回滚配置失败', 'Failed to rollback config'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={
        <span className="inline-flex items-center gap-2">
          <span>{tr(`节点插件与配置：${member?.name}`, `Node Plugins & Config: ${member?.name}`)}</span>
          {gen > 0 && <Badge>{tr(`配置代际 #${gen}`, `Gen #${gen}`)}</Badge>}
        </span>
      }
      size="xl"
      busy={busy}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4 text-xs">
        <ErrorAlert message={err} onClose={() => setErr('')} />
        {isClient && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3.5 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Container className="h-4 w-4 text-indigo-500 shrink-0" />
                <span className="font-semibold text-slate-800 dark:text-slate-100">
                  <TermLabel
                    term={tr('Docker Engine（容器运行时）', 'Docker Engine (Container Runtime)')}
                    tip={tr('Nomad Client 运行 Docker 类型容器任务所需的宿主机引擎；可直接在此安装、转为托管或配置镜像加速与代理。', 'Host container engine required for Nomad Docker tasks; install, adopt, or configure mirrors & proxy here.')}
                  />
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={dockerInfo?.mode === 'absent' ? 'primary' : 'secondary'}
                  disabled={busy || dockerLoading || !member?.node_id}
                  onClick={() => {
                    onClose();
                    navigate(`/docker?tab=config&node=${encodeURIComponent(member.node_id)}`);
                  }}
                >
                  {dockerInfo?.mode === 'absent' ? tr('前往安装 Docker', 'Install Docker in Runtime') : tr('前往配置 / 升级 Docker →', 'Configure / Upgrade Docker →')}
                </Button>
              </div>
            </div>
            {dockerLoading && !dockerInfo ? (
              <div className="text-slate-500">{tr('正在检查节点 Docker 状态…', 'Checking Docker status...')}</div>
            ) : dockerInfo ? (
              <div className="flex flex-wrap items-center gap-2 text-slate-600 dark:text-slate-300">
                <Badge tone={dockerInfo.mode === 'absent' ? 'amber' : 'blue'}>{dockerModeLabelOf(dockerInfo.mode, locale)}</Badge>
                {dockerInfo.version && <span className="font-mono text-slate-800 dark:text-slate-100">{dockerInfo.version}</span>}
                {dockerInfo.mode !== 'absent' && <StatusBadge value={dockerInfo.status} />}
                {dockerInfo.mode === 'absent' && (
                  <span className="text-amber-700 dark:text-amber-300">
                    {tr('尚未安装 Docker Engine，无法在该节点调度 Docker 容器任务。', 'Docker Engine is not installed; Docker tasks cannot run on this node.')}
                  </span>
                )}
                {dockerInfo.mode !== 'absent' && dockerStatusLabelOf(dockerInfo.status, locale) && (
                  <span className="text-slate-500">({dockerStatusLabelOf(dockerInfo.status, locale)})</span>
                )}
              </div>
            ) : (
              <div className="text-slate-500">{tr('暂未获取到节点 Docker 状态，可点击右侧按钮进入管理或重试。', 'Docker status unavailable; click the button on the right to manage or retry.')}</div>
            )}
          </div>
        )}
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
            {tr('纯 Server 节点不运行任务，仅支持配置 TLS 附加 SAN 与配置代际回滚；CNI、Host Volume、Docker 驱动等仅适用于 Client 或 Server + Client 节点。', 'Server-only nodes do not run tasks; only extra TLS SANs and config rollback apply. CNI, Host Volumes, and Docker apply to Client or Server+Client nodes.')}
          </div>
        )}

        {cluster?.tls_enabled && (
          <Input
            label={tr('节点 TLS 证书附加 SAN（可选，逗号分隔）', 'Extra Node TLS SANs (optional, comma-separated)')}
            placeholder={tr('例如 nomad-node.internal, 192.168.10.20', 'e.g. nomad-node.internal, 192.168.10.20')}
            value={extraSANs}
            onChange={(e) => setExtraSANs(e.target.value)}
          />
        )}

        <CustomHCLSection scope="node" value={customHCL} onChange={setCustomHCL} includeClientPresets={isClient} />

        {showCNIProxyOption && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-slate-500 dark:text-slate-400">
            <span>{tr('CNI 插件下载：', 'CNI plugin download: ')}{nomadProxyEnabled ? tr('通过系统代理', 'Via System Proxy') : tr('直连', 'Direct')}</span>
            <Link to="/settings?tab=proxy" className="text-indigo-600 dark:text-indigo-400 hover:underline">
              {tr('前往下载代理设置', 'Proxy Settings')}
            </Link>
          </div>
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
            <span>{tr('单机模式更新节点配置会重启唯一节点并短时中断服务，我已知悉并确认继续。', 'Updating node config in single-node mode restarts the sole node and causes brief downtime. Confirm?')}</span>
          </label>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div>
            {isInstalled && gen > 1 && (
              <Button type="button" disabled={busy} onClick={() => void handleRollback()}>
                <RotateCcw className="h-3.5 w-3.5" />
                <span>{tr('回滚上一配置代际', 'Rollback Previous Gen')}</span>
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" disabled={busy} onClick={onClose}>
              {tr('取消', 'Cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              {isInstalled ? tr('保存并滚动生效', 'Save & Roll Out') : tr('保存配置', 'Save Config')}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
