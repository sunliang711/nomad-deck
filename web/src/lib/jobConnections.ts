import type { HCLDocument, HCLNode } from './hclBuilder.ts';
import { parseLiteralString, unwrapHeredocOrString } from './hclVisualModel.ts';

export interface ConnectionSecret {
  path: string;
  fields: string[];
}

export interface JobConnection {
  name: string;
  provider: string;
  port: string;
  group: string;
  image: string;
  secrets: ConnectionSecret[];
}

export interface JobConnections {
  namespace: string;
  type: string;
  services: JobConnection[];
  secrets: ConnectionSecret[];
}

const blocks = (node: HCLNode | undefined, name: string) =>
  node?.body?.nodes.filter((n) => n.kind === 'block' && n.name === name) || [];
const attr = (node: HCLNode | undefined, name: string) =>
  node?.body?.nodes.find((n) => n.kind === 'attribute' && n.name === name)?.expression;

// 动态表达式不能当成确定的服务名或路径写进可复制示例。
function literal(expression: string | undefined): string {
  const value = parseLiteralString(expression);
  return value && !value.includes('${') && !value.includes('%{') ? value : '';
}

function taskSecrets(task: HCLNode): ConnectionSecret[] {
  const paths = new Map<string, Set<string>>();
  for (const template of blocks(task, 'template')) {
    const data = unwrapHeredocOrString(attr(template, 'data'));
    if (!data.editable) continue;
    // 只识别模板中的实际 secret 调用，不扫描整个 HCL 或读取 Vault 明文。
    for (const match of data.text.matchAll(/\{\{-?\s*with\s+secret\s+("(?:\\.|[^"\\])*")\s*-?\}\}([\s\S]*?)\{\{-?\s*end\s*-?\}\}/g)) {
      const path = literal(match[1]);
      if (!path) continue;
      const fields = paths.get(path) || new Set<string>();
      for (const field of match[2].matchAll(/\.Data\.data\.([A-Za-z_][A-Za-z0-9_]*)|index\s+\.Data\.data\s+"([A-Za-z_][A-Za-z0-9_]*)"/g)) {
        fields.add(field[1] || field[2]);
      }
      paths.set(path, fields);
    }
  }
  return Array.from(paths, ([path, fields]) => ({ path, fields: Array.from(fields) }));
}

export function getJobConnections(document: HCLDocument, defaultNamespace = 'default'): JobConnections {
  const job = document.nodes.find((n) => n.kind === 'block' && n.name === 'job');
  if (!job) throw new Error('Job block not found');
  const namespaceExpr = attr(job, 'namespace');
  const result: JobConnections = {
    namespace: namespaceExpr === undefined ? defaultNamespace : literal(namespaceExpr),
    type: literal(attr(job, 'type')) || 'service',
    services: [],
    secrets: [],
  };
  for (const group of blocks(job, 'group')) {
    const tasks = blocks(group, 'task');
    for (const task of tasks) result.secrets.push(...taskSecrets(task));
    const addService = (service: HCLNode, owners: HCLNode[]) => {
      const port = literal(attr(service, 'port'));
      const matching = owners.filter((task) => {
        try { return JSON.parse(attr(blocks(task, 'config')[0], 'ports') || '[]').includes(port); } catch { return false; }
      });
      const owner = matching.length === 1 ? matching[0] : owners.length === 1 ? owners[0] : undefined;
      result.services.push({
        name: literal(attr(service, 'name')),
        provider: attr(service, 'provider') === undefined ? 'consul' : literal(attr(service, 'provider')),
        port,
        group: group.labels?.[0] || '',
        image: literal(attr(blocks(owner, 'config')[0], 'image')),
        secrets: owner ? taskSecrets(owner) : [],
      });
    };
    for (const service of blocks(group, 'service')) addService(service, tasks);
    for (const task of tasks) {
      for (const service of blocks(task, 'service')) addService(service, [task]);
    }
  }
  return result;
}

// JSON 编辑模式复用同一套提取规则，仅转换连接指引需要的公开配置。
export function connectionDocumentFromJSON(source: string): HCLDocument {
  const raw = JSON.parse(source);
  const job = raw.Job || raw;
  if (!job || !Array.isArray(job.TaskGroups)) throw new Error('Expected Nomad Job JSON');
  const attribute = (name: string, value: unknown): HCLNode => ({ kind: 'attribute', name, expression: JSON.stringify(value), leading: '' });
  const block = (name: string, nodes: HCLNode[], label?: string): HCLNode => ({
    kind: 'block', name, labels: label ? [label] : [], body: { nodes, trailing: '' }, leading: '',
  });
  const service = (s: any) => block('service', [
    ...(s.Name ? [attribute('name', s.Name)] : []),
    ...(s.PortLabel ? [attribute('port', s.PortLabel)] : []),
    ...(s.Provider ? [attribute('provider', s.Provider)] : []),
  ]);
  return { trailing: '', nodes: [block('job', [
    ...(job.Namespace ? [attribute('namespace', job.Namespace)] : []),
    attribute('type', job.Type || 'service'),
    ...job.TaskGroups.map((g: any) => block('group', [
      ...(g.Services || []).map(service),
      ...(g.Tasks || []).map((t: any) => block('task', [
        block('config', [attribute('image', t.Config?.image || ''), attribute('ports', t.Config?.ports || [])]),
        ...(t.Services || []).map(service),
        ...(t.Templates || []).map((v: any) => block('template', [attribute('data', v.EmbeddedTmpl || '')])),
      ], t.Name)),
    ], g.Name)),
  ], job.ID || job.Name)] };
}

const clientVariables: Record<string, { host: string; port: string; fields: Record<string, string> }> = {
  postgres: { host: 'PGHOST', port: 'PGPORT', fields: { username: 'PGUSER', password: 'PGPASSWORD', database: 'PGDATABASE' } },
  mysql: { host: 'MYSQL_HOST', port: 'MYSQL_PORT', fields: { username: 'MYSQL_USER', password: 'MYSQL_PASSWORD', database: 'MYSQL_DATABASE' } },
  redis: { host: 'REDIS_HOST', port: 'REDIS_PORT', fields: { password: 'REDIS_PASSWORD' } },
};

export function buildConnectionSnippet(connection: JobConnection): { task: string; policy: string; variables: string[] } | null {
  if (!connection.name || connection.provider !== 'nomad' || !connection.port) return null;
  const image = connection.image.split('/').pop()?.split(/[:@]/)[0] || '';
  const name = connection.name.replace(/[^A-Za-z0-9_-]/g, '_');
  const envName = name.toUpperCase().replace(/-/g, '_');
  const prefix = /^[A-Za-z_]/.test(envName) ? envName : `SERVICE_${envName}`;
  const vars = clientVariables[image] || { host: `${prefix}_HOST`, port: `${prefix}_PORT`, fields: {} };
  const secretLines: string[] = [];
  const readPaths: string[] = [];
  const variables = [vars.host, vars.port];
  for (const secret of connection.secrets) {
    // 每个目标变量只写一次；MySQL 客户端示例不会注入 root_password。
    const fields = secret.fields.filter((field) => vars.fields[field] && !variables.includes(vars.fields[field]));
    if (!fields.length) continue;
    secretLines.push(`{{ with secret ${JSON.stringify(secret.path)} }}`, ...fields.map((field) =>
      `${vars.fields[field]}={{ index .Data.data ${JSON.stringify(field)} | toJSON }}`), '{{ end }}');
    variables.push(...fields.map((field) => vars.fields[field]));
    readPaths.push(secret.path);
  }
  const vault = readPaths.length ? 'vault {\n  role = "app-reader"\n  env  = false\n}\n\n' : '';
  const task = `${vault}template {
  destination = "secrets/${name}.env"
  env         = true
  perms       = "0600"
  change_mode = "restart"
  data        = <<-EOT
{{ with nomadService ${JSON.stringify(connection.name)} }}
${vars.host}={{ (index . 0).Address | toJSON }}
${vars.port}={{ (index . 0).Port }}
{{ end }}
${secretLines.length ? `${secretLines.join('\n')}\n` : ''}EOT
}`;
  const policy = Array.from(new Set(readPaths)).map((path) =>
    `path ${JSON.stringify(path)} {\n  capabilities = ["read"]\n}`).join('\n\n');
  return { task, policy, variables };
}
