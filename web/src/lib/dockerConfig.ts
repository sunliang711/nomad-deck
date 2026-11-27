export type PullProxyMode = '' | 'none' | 'system' | 'custom';

export interface DockerConfigDraft {
  registry_mirrors: string;
  data_root: string;
  log_max_size: string;
  log_max_file: string;
  pull_proxy_mode: PullProxyMode;
  pull_proxy_url: string;
  pull_proxy_username: string;
  pull_proxy_password: string;
  pull_proxy_password_set: boolean;
  pull_proxy_no_proxy: string;
}

export function emptyDockerConfigDraft(): DockerConfigDraft {
  return {
    registry_mirrors: '',
    data_root: '',
    log_max_size: '',
    log_max_file: '',
    pull_proxy_mode: '',
    pull_proxy_url: '',
    pull_proxy_username: '',
    pull_proxy_password: '',
    pull_proxy_password_set: false,
    pull_proxy_no_proxy: '',
  };
}

export function dockerConfigDraftFrom(cfg: any, passwordSet = false): DockerConfigDraft {
  const c = cfg || {};
  const pp = c.pull_proxy || null;
  return {
    registry_mirrors: Array.isArray(c.registry_mirrors) ? c.registry_mirrors.join(', ') : '',
    data_root: c.data_root || '',
    log_max_size: c.log_max_size || '',
    log_max_file: c.log_max_file ? String(c.log_max_file) : '',
    pull_proxy_mode: (pp?.mode as PullProxyMode) || '',
    pull_proxy_url: pp?.url || '',
    pull_proxy_username: pp?.username || '',
    pull_proxy_password: '',
    pull_proxy_password_set: Boolean(passwordSet || pp?.password_set),
    pull_proxy_no_proxy: Array.isArray(pp?.no_proxy) ? pp.no_proxy.join(', ') : '',
  };
}

export function buildDockerConfigPayload(
  draft: DockerConfigDraft,
  opts?: { includeDataRoot?: boolean; externalOnly?: boolean; clearPassword?: boolean },
) {
  const splitCSV = (raw: string) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const noProxy = splitCSV(draft.pull_proxy_no_proxy);
  let pull_proxy: any = null;
  if (draft.pull_proxy_mode === 'none' || draft.pull_proxy_mode === 'system') {
    pull_proxy = {
      mode: draft.pull_proxy_mode,
      ...(noProxy.length > 0 ? { no_proxy: noProxy } : {}),
    };
  } else if (draft.pull_proxy_mode === 'custom') {
    pull_proxy = {
      mode: 'custom',
      url: draft.pull_proxy_url.trim(),
      ...(draft.pull_proxy_username.trim() ? { username: draft.pull_proxy_username.trim() } : {}),
      ...(noProxy.length > 0 ? { no_proxy: noProxy } : {}),
    };
  }

  const payload: Record<string, any> = {
    pull_proxy,
  };
  if (draft.pull_proxy_mode === 'custom') {
    if (draft.pull_proxy_password) {
      payload.pull_proxy_password = draft.pull_proxy_password;
    } else if (opts?.clearPassword) {
      payload.pull_proxy_password = '';
    }
  }
  if (!opts?.externalOnly) {
    const mirrors = splitCSV(draft.registry_mirrors);
    if (mirrors.length > 0) payload.registry_mirrors = mirrors;
    if (opts?.includeDataRoot && draft.data_root.trim()) {
      payload.data_root = draft.data_root.trim();
    }
    if (draft.log_max_size.trim()) {
      payload.log_max_size = draft.log_max_size.trim();
    }
    const maxFile = Number(draft.log_max_file.trim());
    if (draft.log_max_file.trim() && Number.isFinite(maxFile) && maxFile > 0) {
      payload.log_max_file = Math.floor(maxFile);
    }
  }
  return payload;
}
