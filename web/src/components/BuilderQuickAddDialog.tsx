import React, { useState } from 'react';
import { useI18n } from '../lib/i18n';
import { Button, ErrorAlert, Input, Modal, Select } from './UI';

export type QuickAddForm =
  | { kind: 'port'; label: string; labels: string[] }
  | { kind: 'volume'; volumes: string[]; hostVolumes: string[] }
  | { kind: 'service'; name: string; ports: string[]; canDeclarePort: boolean };

export type QuickAddValue =
  | { kind: 'port'; label: string; destination: number }
  | { kind: 'volume'; name: string; type: 'host' | 'csi'; source: string; destination: string; readOnly: boolean }
  | { kind: 'service'; name: string; port: string; provider: string; check: string; path: string; newPort?: { label: string; destination: number } };

export function BuilderQuickAddDialog({ form, onClose, onSave }: {
  form: QuickAddForm;
  onClose: () => void;
  onSave: (value: QuickAddValue) => void;
}) {
  const { tr } = useI18n();
  const [error, setError] = useState('');
  const [volume, setVolume] = useState(form.kind === 'volume' ? form.volumes[0] || '' : '');
  const [volumeType, setVolumeType] = useState<'host' | 'csi'>('host');
  const [source, setSource] = useState(form.kind === 'volume' ? form.hostVolumes[0] || '' : '');
  const [port, setPort] = useState(form.kind === 'service' ? form.ports[0] || '' : '');
  const [provider, setProvider] = useState('nomad');
  const [addPort, setAddPort] = useState(form.kind === 'service' && form.canDeclarePort && form.ports.length === 0);
  const hasServicePort = Boolean(port || addPort);
  const [check, setCheck] = useState('');
  const title = form.kind === 'port' ? tr('声明并绑定端口', 'Declare and Bind Port')
    : form.kind === 'volume' ? tr('挂载持久卷', 'Mount Persistent Volume')
    : tr('注册服务', 'Register Service');

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (key: string) => String(data.get(key) || '').trim();
    if (form.kind === 'port') {
      const label = text('label');
      if (!/^[A-Za-z0-9_-]+$/.test(label)) {
        setError(tr('请输入有效的端口标签。', 'Enter a valid port label.'));
        return;
      }
      if (form.labels.includes(label)) {
        setError(tr('任务组已声明此端口，请在表单里直接选择它。', 'This port is declared in the group. Select it in the form.'));
        return;
      }
      onSave({ kind: 'port', label, destination: Number(text('destination')) });
      return;
    }
    if (form.kind === 'volume') {
      const name = volume || text('label');
      if (!volume && (!name || !source.trim() || form.volumes.includes(name))) {
        setError(tr('请填写存储卷来源和未使用的卷声明名称。', 'Enter a volume source and an unused declaration name.'));
        return;
      }
      const destination = text('destination');
      if (!destination.startsWith('/')) {
        setError(tr('挂载路径必须以 / 开头。', 'The mount path must begin with /.'));
        return;
      }
      onSave({ kind: 'volume', name, type: volumeType, source: volume ? '' : source.trim(), destination, readOnly: data.has('readOnly') });
      return;
    }
    const name = text('label');
    const path = text('path');
    if (!name || (hasServicePort && check === 'http' && !path.startsWith('/'))) {
      setError(tr('请填写服务名称，HTTP 检查路径须以 / 开头。', 'Enter a service name and an HTTP check path beginning with /.'));
      return;
    }
    const label = text('portLabel');
    if (addPort && !/^[A-Za-z0-9_-]+$/.test(label)) {
      setError(tr('请输入有效的端口标签。', 'Enter a valid port label.'));
      return;
    }
    const newPort = addPort ? { label, destination: Number(text('portDestination')) } : undefined;
    onSave({ kind: 'service', name, port: newPort?.label || port, provider, check: hasServicePort ? check : '', path, newPort });
  };

  return (
    <Modal open title={title} onClose={onClose} size="md">
      <form className="space-y-4" onSubmit={submit}>
        <ErrorAlert message={error} onClose={() => setError('')} />
        {form.kind === 'port' && (
          <>
            <Input label={tr('端口标签', 'Port Label')} name="label" defaultValue={form.label} required />
            <Input label={tr('容器端口', 'Container Port')} type="number" name="destination" min={1} max={65535} defaultValue={80} required />
          </>
        )}
        {form.kind === 'volume' && (
          <>
            {form.volumes.length > 0 && (
              <Select label={tr('任务组已声明的卷', 'Declared Group Volumes')} value={volume} onChange={(e) => setVolume(e.target.value)}>
                <option value="">{tr('声明并挂载卷', 'Declare and Mount Volume')}</option>
                {form.volumes.map((name) => <option key={name} value={name}>{name}</option>)}
              </Select>
            )}
            {!volume && (
              <>
                <Input label={tr('卷声明名称', 'Volume Declaration Name')} name="label" defaultValue="data" required />
                <Select label={tr('卷类型', 'Volume Type')} value={volumeType} onChange={(e) => {
                  const type = e.target.value === 'csi' ? 'csi' : 'host';
                  setVolumeType(type);
                  setSource(type === 'host' ? form.hostVolumes[0] || '' : '');
                }}>
                  <option value="host">Host Volume</option>
                  <option value="csi">CSI</option>
                </Select>
                <Input label={tr('已有存储卷来源', 'Existing Volume Source')} list={volumeType === 'host' ? 'builder-host-sources' : undefined} value={source} onChange={(e) => setSource(e.target.value)} required />
                {volumeType === 'host' && (
                  <datalist id="builder-host-sources">
                    {form.hostVolumes.map((name) => <option key={name} value={name} />)}
                  </datalist>
                )}
              </>
            )}
            <Input label={tr('容器挂载路径', 'Container Mount Path')} name="destination" defaultValue="/data" required />
            <label className="flex items-center gap-2 text-xs"><input name="readOnly" type="checkbox" />{tr('只读挂载', 'Read-Only Mount')}</label>
          </>
        )}
        {form.kind === 'service' && (
          <>
            <Input label={tr('服务名称', 'Service Name')} name="label" defaultValue={form.name} required />
            <Select label={tr('注册到', 'Register With')} value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="nomad">Nomad</option>
              <option value="consul">Consul</option>
            </Select>
            <Select label={tr('任务组端口', 'Group Port')} value={port} onChange={(e) => setPort(e.target.value)}>
              <option value="">{tr('暂不选择端口', 'No Port Selected')}</option>
              {form.ports.map((label) => <option key={label} value={label}>{label}</option>)}
            </Select>
            {form.canDeclarePort && form.ports.length === 0 && (
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={addPort} onChange={(e) => setAddPort(e.target.checked)} />
                {tr('同时声明并绑定容器端口', 'Also Declare and Bind a Container Port')}
              </label>
            )}
            {addPort && (
              <div className="grid grid-cols-2 gap-3">
                <Input label={tr('端口标签', 'Port Label')} name="portLabel" defaultValue="http" required />
                <Input label={tr('容器端口', 'Container Port')} type="number" name="portDestination" min={1} max={65535} defaultValue={80} required />
              </div>
            )}
            {hasServicePort && (
              <Select label={tr('健康检查', 'Health Check')} value={check} onChange={(e) => setCheck(e.target.value)}>
                <option value="">{tr('不启用', 'Disabled')}</option>
                <option value="http">HTTP</option>
                <option value="tcp">TCP</option>
              </Select>
            )}
            {hasServicePort && check === 'http' && <Input label={tr('HTTP 路径', 'HTTP Path')} name="path" defaultValue="/" required />}
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>{tr('取消', 'Cancel')}</Button>
          <Button type="submit" variant="primary">{tr('确认', 'Confirm')}</Button>
        </div>
      </form>
    </Modal>
  );
}
