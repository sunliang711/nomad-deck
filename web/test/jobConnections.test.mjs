import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConnectionSnippet, connectionDocumentFromJSON, getJobConnections } from '../src/lib/jobConnections.ts';
import { STARTER_SAMPLES } from '../src/lib/jobBlueprints.ts';

function job({ name = 'postgres', namespace, provider = 'nomad', path = 'secret/data/apps/postgres', image = 'postgres:17-bookworm' } = {}) {
  return {
    ID: 'database-custom',
    ...(namespace ? { Namespace: namespace } : {}),
    TaskGroups: [{
      Name: 'database',
      Services: [{ Name: name, PortLabel: 'db', ...(provider ? { Provider: provider } : {}) }],
      Tasks: [{
        Name: 'db',
        Config: { image, ports: ['db'] },
        Templates: [{ EmbeddedTmpl: `{{ with secret "${path}" }}
USER={{ .Data.data.username }}
PASS={{ .Data.data.password }}
DB={{ index .Data.data "database" }}
ROOT={{ .Data.data.root_password }}
{{ end }}` }],
      }],
    }],
  };
}

function guide(value, namespace = 'default') {
  return getJobConnections(connectionDocumentFromJSON(JSON.stringify(value)), namespace);
}

test('数据库与缓存模板注册的服务端口与 Docker 映射一致，并提供 TCP 健康检查', () => {
  for (const [id, port] of [['postgres', 'db'], ['mysql', 'db'], ['redis', 'redis']]) {
    const hcl = STARTER_SAMPLES.find((s) => s.id === id).hcl;
    assert.match(hcl, new RegExp(`service \\{\\s+name\\s*= "${id}"\\s+port\\s*= "${port}"\\s+provider\\s*= "nomad"`));
    assert.match(hcl, /type\s*= "tcp"/);
    assert.match(hcl, new RegExp(`ports\\s*= \\["${port}"\\]`));
    assert.match(hcl, /shutdown_delay\s*= "5s"/);
  }
});

test('连接指引跟随当前服务名、Namespace 和 Vault 路径，而不是默认模板值', () => {
  const info = guide(job({ name: 'orders-db', namespace: 'orders', path: 'kv/data/prod/orders' }));
  const snippet = buildConnectionSnippet(info.services[0]);
  assert.equal(info.namespace, 'orders');
  assert.match(snippet.task, /nomadService "orders-db"/);
  assert.match(snippet.task, /secret "kv\/data\/prod\/orders"/);
  assert.match(snippet.task, /PGHOST=.*Address/);
  assert.match(snippet.task, /PGPORT=.*Port/);
  assert.match(snippet.task, /role = "app-reader"/);
  assert.match(snippet.policy, /path "kv\/data\/prod\/orders"/);
  assert.equal(snippet.policy.includes('update'), false);
  assert.equal(snippet.task.includes('secret/data/apps/postgres'), false);
});

test('Namespace 未显式填写时使用工作台选择，并支持 Nomad Job 包装 JSON', () => {
  assert.equal(guide({ Job: job() }, 'team-a').namespace, 'team-a');
});

test('MySQL 使用业务凭据，Redis 只生成密码变量，示例不包含明文值', () => {
  const mysql = buildConnectionSnippet(guide(job({ image: 'mysql:8.4' })).services[0]);
  assert.deepEqual(mysql.variables, ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE']);
  assert.equal(mysql.task.includes('root_password'), false);
  const redis = buildConnectionSnippet(guide(job({ image: 'redis:7-alpine' })).services[0]);
  assert.deepEqual(redis.variables, ['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD']);
  assert.equal(redis.task.includes('PGUSER'), false);
  assert.match(redis.task, /perms\s*= "0600"/);
  assert.match(redis.task, /change_mode = "restart"/);
  assert.match(redis.task, /toJSON/);
});

test('缺省 Consul provider 和动态名称不能生成误导性的 nomadService 示例', () => {
  const consul = guide(job({ provider: '' })).services[0];
  assert.equal(consul.provider, 'consul');
  assert.equal(buildConnectionSnippet(consul), null);
  const dynamic = guide(job({ name: '${var.service_name}', namespace: '${var.ns}', path: '${var.vault_path}' }));
  assert.equal(dynamic.namespace, '');
  assert.equal(dynamic.services[0].name, '');
  assert.equal(buildConnectionSnippet(dynamic.services[0]), null);
  assert.deepEqual(dynamic.services[0].secrets, []);
});

test('按照服务端口匹配所属 Task，任务级服务不混入其他任务的密钥', () => {
  const value = job();
  value.TaskGroups[0].Tasks.unshift({ Name: 'sidecar', Config: { image: 'nginx:alpine', ports: ['http'] } });
  const task = value.TaskGroups[0].Tasks[1];
  task.Services = [{ Name: 'task-db', Provider: 'nomad', PortLabel: 'db' }];
  const info = guide(value);
  assert.equal(info.services.length, 2);
  for (const service of info.services) {
    assert.equal(service.image, 'postgres:17-bookworm');
    assert.match(buildConnectionSnippet(service).task, /PGPASSWORD/);
  }
});

test('移除服务注册和替换密钥字段后不继续使用旧配置', () => {
  const value = job();
  value.TaskGroups[0].Services = [];
  const info = guide(value);
  assert.deepEqual(info.services, []);
  assert.equal(info.secrets[0].path, 'secret/data/apps/postgres');
  const other = job();
  other.TaskGroups[0].Tasks[0].Templates[0].EmbeddedTmpl = '{{ with secret "secret/data/app" }}{{ .Data.data.custom_password }}{{ end }}';
  const snippet = buildConnectionSnippet(guide(other).services[0]);
  assert.equal(snippet.task.includes('PGPASSWORD'), false);
  assert.equal(snippet.task.includes('app-reader'), false);
  assert.equal(snippet.policy, '');
});

test('同一密钥的重复引用不重复注入变量，批处理无注册服务也能提取使用信息', () => {
  const value = job();
  value.TaskGroups[0].Tasks[0].Templates.push(...value.TaskGroups[0].Tasks[0].Templates);
  const snippet = buildConnectionSnippet(guide(value).services[0]);
  assert.equal((snippet.task.match(/PGPASSWORD=/g) || []).length, 1);
  assert.equal((snippet.policy.match(/capabilities/g) || []).length, 1);
  value.Type = 'batch';
  value.TaskGroups[0].Services = [];
  assert.equal(guide(value).type, 'batch');
  assert.throws(() => connectionDocumentFromJSON('{}'));
  assert.throws(() => getJobConnections({ nodes: [], trailing: '' }));
});

test('多个依赖使用不同目标文件，通用服务的环境变量互不覆盖', () => {
  const db = buildConnectionSnippet(guide(job()).services[0]);
  const redis = buildConnectionSnippet(guide(job({ name: 'redis', image: 'redis:7-alpine' })).services[0]);
  assert.match(db.task, /destination = "secrets\/postgres.env"/);
  assert.match(redis.task, /destination = "secrets\/redis.env"/);
  const web = buildConnectionSnippet(guide(job({ name: 'api-service', image: 'custom/app:1' })).services[0]);
  assert.deepEqual(web.variables, ['API_SERVICE_HOST', 'API_SERVICE_PORT']);
  assert.equal(web.policy, '');
  const numeric = buildConnectionSnippet(guide(job({ name: '123-service', image: 'custom/app:1' })).services[0]);
  assert.deepEqual(numeric.variables, ['SERVICE_123_SERVICE_HOST', 'SERVICE_123_SERVICE_PORT']);
});

test('多任务服务无法确定端口归属时不猜测或传播其它任务的凭据', () => {
  const value = job();
  value.TaskGroups[0].Services[0].PortLabel = 'other';
  value.TaskGroups[0].Tasks.push({ Name: 'sidecar', Config: { image: 'nginx:alpine', ports: ['http'] } });
  const service = guide(value).services[0];
  assert.equal(service.image, '');
  assert.deepEqual(service.secrets, []);
  assert.equal(buildConnectionSnippet(service).policy, '');
});
