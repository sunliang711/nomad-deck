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
export function parseKVPath(raw: string, fallbackMount = 'secret'): ParsedKVPath {
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
    ? `${mount}/data/${rest.replace(/\*/g, '<你的密钥名>')}`
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
