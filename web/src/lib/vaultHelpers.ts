import type { Locale } from './locale.ts';

export interface ParsedKVPath {
  mount: string;
  path: string;
  rolePath: string;
  templatePath: string;
  templateExamplePath: string;
  hadDataPrefix: boolean;
  hasTrailingSlash: boolean;
  isWildcard: boolean;
}

/**
 * Normalizes a KV v2 path into both the Role authorization path (`<mount>/<path>`)
 * and the Nomad template API path (`<mount>/data/<path>`).
 */
export function parseKVPath(raw: string, fallbackMount = 'secret', locale: Locale = 'zh'): ParsedKVPath {
  const trimmedRaw = raw.trim();
  const cleaned = trimmedRaw.replace(/^\/+|\/+$/g, '');
  if (!cleaned) {
    const m = fallbackMount.trim().replace(/^\/+|\/+$/g, '') || 'secret';
    return {
      mount: m,
      path: '',
      rolePath: '',
      templatePath: '',
      templateExamplePath: '',
      hadDataPrefix: false,
      hasTrailingSlash: false,
      isWildcard: false,
    };
  }
  const hasTrailingSlash = trimmedRaw.endsWith('/') && cleaned.includes('/');
  const slash = cleaned.indexOf('/');
  if (slash < 0) {
    return {
      mount: cleaned,
      path: '',
      rolePath: cleaned,
      templatePath: `${cleaned}/data`,
      templateExamplePath: `${cleaned}/data`,
      hadDataPrefix: false,
      hasTrailingSlash,
      isWildcard: false,
    };
  }
  const mount = cleaned.slice(0, slash);
  let rest = cleaned.slice(slash + 1).replace(/^\/+/, '');
  let hadDataPrefix = false;
  if (rest === 'data') {
    rest = '';
    hadDataPrefix = true;
  } else if (rest.startsWith('data/')) {
    rest = rest.slice('data/'.length);
    hadDataPrefix = true;
  }
  const isWildcard = rest.includes('*');
  const templatePath = rest ? `${mount}/data/${rest}` : `${mount}/data`;
  const templateExamplePath = isWildcard
    ? `${mount}/data/${rest.replace(/\*/g, locale === 'en' ? '<secret-name>' : '<你的密钥名>')}`
    : templatePath;
  return {
    mount,
    path: rest,
    rolePath: rest ? `${mount}/${rest}` : mount,
    templatePath,
    templateExamplePath,
    hadDataPrefix,
    hasTrailingSlash,
    isWildcard,
  };
}

/**
 * Generates a Nomad template block data body for reading a KV v2 secret.
 */
export function buildTemplateData(
  templatePath: string,
  keys: string[] = [],
  mode: 'env' | 'file' = 'env',
): string {
  const safePath = templatePath || 'secret/data/apps/demo';
  if (mode === 'file') {
    const preferredKey =
      keys.find((k) => /pass|secret|token|key/i.test(k)) || keys[0] || '';
    if (preferredKey) {
      return `{{ with secret ${JSON.stringify(safePath)} }}{{ index .Data.data ${JSON.stringify(preferredKey)} }}{{ end }}`;
    }
    return `{{ with secret ${JSON.stringify(safePath)} }}{{ .Data.data | toJSON }}{{ end }}`;
  }
  if (keys.length > 0) {
    const lines = keys.map(
      (k) => `${k.toUpperCase().replace(/[^A-Za-z0-9_]/g, '_')}={{ index .Data.data ${JSON.stringify(k)} | toJSON }}`,
    );
    return `{{ with secret ${JSON.stringify(safePath)} }}\n${lines.join('\n')}\n{{ end }}`;
  }
  return `{{ with secret ${JSON.stringify(safePath)} }}\n{{ range $k, $v := .Data.data }}{{ $k }}={{ $v | toJSON }}\n{{ end }}{{ end }}`;
}

/**
 * Builds a complete `vault {}` + `template {}` HCL snippet ready to paste inside a Nomad `task` block.
 */
export function buildTaskVaultSnippet(opts: {
  role: string;
  secretPath: string;
  keys?: string[];
  mode: 'env' | 'file';
  fileName?: string;
  envVarName?: string;
}): string {
  const parsed = parseKVPath(opts.secretPath);
  const templatePath = parsed.templatePath || 'secret/data/apps/demo';
  const data = buildTemplateData(templatePath, opts.keys, opts.mode);
  const fileName = (opts.fileName || 'app.secret').replace(/^\/+/, '');
  const envVarName = (opts.envVarName || 'APP_SECRET_FILE').trim() || 'APP_SECRET_FILE';
  if (opts.mode === 'file') {
    return `vault {
  role = ${JSON.stringify(opts.role || 'default')}
  env  = false
}

env {
  ${envVarName} = ${JSON.stringify(`/secrets/${fileName}`)}
}

template {
  destination = ${JSON.stringify(`secrets/${fileName}`)}
  perms       = "0600"
  change_mode = "restart"
  data        = <<EOT
${data}
EOT
}`;
  }
  return `vault {
  role = ${JSON.stringify(opts.role || 'default')}
  env  = false
}

template {
  destination = "secrets/app.env"
  env         = true
  change_mode = "restart"
  data        = <<EOT
${data}
EOT
}`;
}

export interface VaultRoleOption {
  role: string;
  namespace?: string;
  status?: string;
  integration?: string;
  integration_id?: string;
  integration_status?: string;
  policy_mode?: string;
  secret_paths?: string[];
  vault_cluster_id?: string;
  vault_cluster?: string;
}

export interface VaultIntegrationOption {
  id: string;
  name: string;
  status: string;
  nomad_side_enabled: boolean;
  vault_cluster_id: string;
  vault_cluster: string;
  kv_mounts?: string[];
}

export const INTEGRATION_DRAFT_JOB_STORAGE_KEY = 'nomad_deck_integration_job_draft';

export type CustomPolicyPresetId =
  | 'from-paths'
  | 'single-rw'
  | 'dir-rw'
  | 'shared-read-app-rw';

export interface CustomPolicyPresetResult {
  hcl: string;
  suggestedSecretPaths?: string;
}

function formatCapabilities(capabilities: string[]): string {
  return `[${capabilities.map((cap) => JSON.stringify(cap)).join(', ')}]`;
}

function renderKVPolicyBlocks(
  mount: string,
  pathPattern: string,
  dataCapabilities: string[],
  metadataCapabilities: string[],
): string {
  const cleanMount = mount.trim().replace(/^\/+|\/+$/g, '') || 'secret';
  const cleanPattern = pathPattern.trim().replace(/^\/+/, '');
  const dataPath = cleanPattern ? `${cleanMount}/data/${cleanPattern}` : `${cleanMount}/data`;
  const metaPath = cleanPattern ? `${cleanMount}/metadata/${cleanPattern}` : `${cleanMount}/metadata`;
  return [
    `path ${JSON.stringify(dataPath)} {`,
    `  capabilities = ${formatCapabilities(dataCapabilities)}`,
    '}',
    '',
    `path ${JSON.stringify(metaPath)} {`,
    `  capabilities = ${formatCapabilities(metadataCapabilities)}`,
    '}',
  ].join('\n');
}

/**
 * Builds an editable Vault KV v2 Policy HCL preset based on current role context.
 */
export function buildCustomPolicyPreset(
  presetId: CustomPolicyPresetId,
  opts: {
    fallbackMount?: string;
    roleName?: string;
    secretPaths?: string;
    policyMode?: 'explicit' | 'templated';
  } = {},
): CustomPolicyPresetResult {
  const fallbackMount = (opts.fallbackMount || 'secret').trim().replace(/^\/+|\/+$/g, '') || 'secret';
  const app = (opts.roleName || '').trim().replace(/^\/+|\/+$/g, '') || 'app';
  const defaultAppPath = `apps/${app}`;
  const rawList = (opts.secretPaths || '')
    .split(/[,\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const parsedList = rawList.map((raw) => parseKVPath(raw, fallbackMount));
  const mount = parsedList.find((p) => p.mount)?.mount || fallbackMount;
  const firstExplicit = parsedList.find((p) => p.path);

  switch (presetId) {
    case 'from-paths': {
      if (opts.policyMode === 'templated') {
        const mounts = rawList.length > 0
          ? rawList.map((m) => m.replace(/^\/+|\/+$/g, '')).filter(Boolean)
          : [mount];
        const blocks = (mounts.length > 0 ? mounts : [mount]).map((m) =>
          renderKVPolicyBlocks(m, `default/${app}/*`, ['read'], ['read', 'list']),
        );
        return { hcl: blocks.join('\n\n') };
      }
      const targets = parsedList.length > 0
        ? parsedList
        : [parseKVPath(`${mount}/${defaultAppPath}`, mount)];
      const blocks = targets.map((p) =>
        renderKVPolicyBlocks(p.mount, p.path || '*', ['read'], ['read', 'list']),
      );
      return { hcl: blocks.join('\n\n') };
    }
    case 'single-rw': {
      const targetMount = firstExplicit && !firstExplicit.isWildcard ? firstExplicit.mount : mount;
      const targetPath = firstExplicit && !firstExplicit.isWildcard ? firstExplicit.path : defaultAppPath;
      return {
        hcl: renderKVPolicyBlocks(targetMount, targetPath, ['create', 'update', 'read'], ['read', 'list']),
        suggestedSecretPaths: `${targetMount}/${targetPath}`,
      };
    }
    case 'dir-rw': {
      const targetMount = firstExplicit ? firstExplicit.mount : mount;
      const base = firstExplicit
        ? firstExplicit.path.replace(/\/?\*+$/, '').replace(/\/+$/, '') || defaultAppPath
        : defaultAppPath;
      const wildcard = `${base}/*`;
      return {
        hcl: renderKVPolicyBlocks(targetMount, wildcard, ['create', 'update', 'read', 'delete'], ['read', 'list', 'delete']),
        suggestedSecretPaths: `${targetMount}/${wildcard}`,
      };
    }
    case 'shared-read-app-rw': {
      return {
        hcl: [
          renderKVPolicyBlocks(mount, 'shared/*', ['read'], ['read', 'list']),
          renderKVPolicyBlocks(mount, `${defaultAppPath}/*`, ['create', 'update', 'read', 'delete'], ['read', 'list', 'delete']),
        ].join('\n\n'),
        suggestedSecretPaths: `${mount}/shared/*, ${mount}/${defaultAppPath}/*`,
      };
    }
  }
}
