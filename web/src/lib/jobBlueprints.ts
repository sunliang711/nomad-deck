import type { Locale } from './locale.ts';

export interface BlueprintRequirementBadge {
  kind: 'driver' | 'vault' | 'port' | 'network';
  label: string;
  labelEn: string;
}

export interface BlueprintNote {
  title: string;
  titleEn: string;
  detail: string;
  detailEn: string;
  optional?: boolean;
  linkTo?: string;
  linkLabel?: string;
  linkLabelEn?: string;
}

export interface BlueprintSecretFieldHint {
  placeholder?: string;
  placeholderEn?: string;
  defaultValue?: string;
  secret?: boolean;
  hint?: string;
  hintEn?: string;
}

export interface JobBlueprint {
  id: string;
  label: string;
  labelEn?: string;
  tags: string[];
  tagsEn?: string[];
  desc: string;
  descEn?: string;
  requires: BlueprintRequirementBadge[];
  notes?: BlueprintNote[];
  secretHints?: Record<string, BlueprintSecretFieldHint>;
  hcl: string;
}

export function getBlueprintLabel(bp: JobBlueprint, locale: Locale = 'zh'): string {
  return locale === 'en' && bp.labelEn ? bp.labelEn : bp.label;
}

export function getBlueprintTags(bp: JobBlueprint, locale: Locale = 'zh'): string[] {
  return locale === 'en' && bp.tagsEn ? bp.tagsEn : bp.tags;
}

export function getBlueprintDesc(bp: JobBlueprint, locale: Locale = 'zh'): string {
  return locale === 'en' && bp.descEn ? bp.descEn : bp.desc;
}

export function getBlueprintRequires(
  bp: JobBlueprint,
  locale: Locale = 'zh',
): Array<{ kind: BlueprintRequirementBadge['kind']; label: string }> {
  return (bp.requires || []).map((r) => ({
    kind: r.kind,
    label: locale === 'en' ? r.labelEn : r.label,
  }));
}

export function getBlueprintNotes(
  bp: JobBlueprint,
  locale: Locale = 'zh',
): Array<{
  title: string;
  detail: string;
  optional: boolean;
  linkTo?: string;
  linkLabel?: string;
}> {
  return (bp.notes || []).map((n) => ({
    title: locale === 'en' ? n.titleEn : n.title,
    detail: locale === 'en' ? n.detailEn : n.detail,
    optional: Boolean(n.optional),
    linkTo: n.linkTo,
    linkLabel: n.linkTo ? (locale === 'en' ? n.linkLabelEn || n.linkLabel : n.linkLabel) : undefined,
  }));
}

export const STARTER_SAMPLES: JobBlueprint[] = [
  {
    id: 'docker',
    label: 'Nginx 容器服务',
    labelEn: 'Nginx Container Service',
    tags: ['Docker', '入门'],
    tagsEn: ['Docker', 'Starter'],
    desc: '标准 Docker Web 容器示例，默认动态映射 80 端口，无需额外前置配置即可在 Nomad Client 运行',
    descEn: 'Standard Docker web container example with dynamic port mapping to 80, ready to run on any Docker-enabled Nomad Client',
    requires: [
      { kind: 'driver', label: 'Docker 驱动', labelEn: 'Docker Driver' },
      { kind: 'port', label: '端口 80（动态映射）', labelEn: 'Port 80 (dynamic)' },
    ],
    hcl: `job "nginx" {
  datacenters = ["dc1"]
  type        = "service"

  group "app" {
    count = 1
    network {
      port "http" {
        to = 80
      }
    }

    task "nginx" {
      driver = "docker"
      config {
        image = "nginx:alpine"
        ports = ["http"]
      }
      resources {
        cpu    = 100
        memory = 128
      }
    }
  }
}
`,
  },
  {
    id: 'caddy',
    label: 'Caddy 反向代理',
    labelEn: 'Caddy Reverse Proxy',
    tags: ['Docker', '网关'],
    tagsEn: ['Docker', 'Gateway'],
    desc: '轻量级 Web 服务器与自动 HTTPS 反向代理，内置 nomadService 动态发现示例并暴露 80 / 443 端口',
    descEn: 'Lightweight web server & automatic HTTPS reverse proxy with nomadService upstream example and ports 80/443',
    requires: [
      { kind: 'driver', label: 'Docker 驱动', labelEn: 'Docker Driver' },
      { kind: 'port', label: '端口 80 / 443', labelEn: 'Ports 80 / 443' },
    ],
    notes: [
      {
        title: '生产持久化 ACME 证书',
        titleEn: 'Persist ACME certificates in production',
        detail: '默认使用 ephemeral_disk 暂存证书数据；生产环境建议将 local/caddy-data 替换为 Host Volume，防止重调度丢失 ACME 凭据。',
        detailEn: 'Uses ephemeral_disk by default; replace local/caddy-data with a Host Volume in production so ACME credentials survive rescheduling.',
        optional: false,
      },
      {
        title: '启用自动 HTTPS 与 nomadService 反向代理',
        titleEn: 'Enable auto HTTPS & nomadService upstream',
        detail: '在 local/Caddyfile 中用真实域名替换 :80 即可自动签发 HTTPS；启用反向代理示例时，请确保目标后端已在 Nomad 注册同名 service。',
        detailEn: 'Replace :80 with your domain in local/Caddyfile for automatic HTTPS, and ensure the target backend registers the matching Nomad service name.',
        optional: true,
      },
    ],
    hcl: `job "caddy" {
  datacenters = ["dc1"]
  type        = "service"

  group "proxy" {
    count          = 1
    shutdown_delay = "5s"
    network {
      port "http" {
        static = 80
        to     = 80
      }
      port "https" {
        static = 443
        to     = 443
      }
    }

    ephemeral_disk {
      size   = 256
      sticky = true
    }

    service {
      name     = "caddy"
      port     = "http"
      provider = "nomad"
      check {
        name     = "tcp-http"
        type     = "tcp"
        interval = "15s"
        timeout  = "3s"
      }
    }

    task "caddy" {
      driver = "docker"
      config {
        image   = "caddy:2-alpine"
        ports   = ["http", "https"]
        volumes = [
          "local/Caddyfile:/etc/caddy/Caddyfile",
          "local/caddy-data:/data",
          "local/caddy-config:/config",
        ]
      }

      template {
        destination = "local/Caddyfile"
        change_mode = "restart"
        data        = <<-EOT
# Replace :80 with your domain for automatic HTTPS; use nomadService to discover backends:
# app.example.com {
#   reverse_proxy {{ range nomadService "app" }}{{ .Address }}:{{ .Port }}{{ end }}
# }
:80 {
  respond "NomadDeck Caddy ready" 200
}
EOT
      }

      resources {
        cpu    = 100
        memory = 128
      }
    }
  }
}
`,
  },
  {
    id: 'traefik',
    label: 'Traefik 服务网关',
    labelEn: 'Traefik Service Gateway',
    tags: ['Docker', '网关'],
    tagsEn: ['Docker', 'Gateway'],
    desc: '云原生边缘网关，含 80 / 443 入口、8080 面板、Nomad 服务发现与 ACME DNS-01 (alidns) 自动 HTTPS 模板',
    descEn: 'Cloud-native edge router with 80/443 entrypoints, 8080 dashboard, Nomad provider, and ACME DNS-01 (alidns) template',
    requires: [
      { kind: 'driver', label: 'Docker 驱动', labelEn: 'Docker Driver' },
      { kind: 'port', label: '端口 80 / 443 / 8080', labelEn: 'Ports 80 / 443 / 8080' },
    ],
    notes: [
      {
        title: '可选：启用 Traefik 的 Nomad 服务发现（providers.nomad）',
        titleEn: 'Optional: Enable Traefik Nomad service discovery (providers.nomad)',
        detail: '在「Nomad 集群 → 治理 → ACL Policies」建只读 Policy（namespace "*" read + node read），再到「ACL Tokens & Roles → 签发 Client Token」获取 Secret ID；若需校验 Nomad TLS，挂载 /opt/nomad-deck/nomad/etc/nomad.d/tls/ca.pem 并取消 traefik.yml 中 nomad provider 注释。',
        detailEn: 'Create a read-only ACL Policy (namespace "*" read + node read) under Nomad Cluster -> Governance -> ACL Policies, issue a Client Token, mount the Nomad CA if using TLS, and uncomment providers.nomad in traefik.yml.',
        optional: true,
        linkTo: '/nomad',
        linkLabel: '前往 Nomad ACL 治理',
        linkLabelEn: 'Open Nomad ACL',
      },
      {
        title: '可选：通过 Vault 注入 NOMAD_TOKEN 与阿里云 DNS-01 (alidns)',
        titleEn: 'Optional: Inject NOMAD_TOKEN & Alibaba DNS-01 via Vault',
        detail: '在「Vault 集群 → KV v2」的 secret/apps/traefik 写入 nomad_token、ali_key、ali_secret，在「集群联动」新建 Role "traefik"（授权 secret/apps/traefik）并点击「应用联动」，随后取消 HCL 中 vault / template 与 certificatesResolvers.alidns 注释。',
        detailEn: 'Write nomad_token, ali_key, ali_secret at secret/apps/traefik in Vault KV v2, create Role "traefik" for secret/apps/traefik in Integrations and apply it, then uncomment the vault/template and alidns blocks.',
        optional: true,
        linkTo: '/integrations',
        linkLabel: '前往集群联动',
        linkLabelEn: 'Open Integrations',
      },
      {
        title: '生产持久化 acme.json',
        titleEn: 'Persist acme.json in production',
        detail: '生产环境建议将 local/acme 替换为 Host Volume，避免重调度重复签发证书触发 CA 限流。',
        detailEn: 'Replace local/acme with a Host Volume in production to avoid re-issuing certs and hitting ACME rate limits.',
        optional: false,
      },
    ],
    secretHints: {
      nomad_token: { secret: true, placeholder: 'Nomad 只读 Client Token', placeholderEn: 'Nomad read-only Client Token' },
      ali_key: { secret: true, placeholder: 'Alibaba Cloud AccessKey ID', placeholderEn: 'Alibaba Cloud AccessKey ID' },
      ali_secret: { secret: true, placeholder: 'Alibaba Cloud AccessKey Secret', placeholderEn: 'Alibaba Cloud AccessKey Secret' },
    },
    hcl: `job "traefik" {
  datacenters = ["dc1"]
  type        = "service"

  group "gateway" {
    count          = 1
    shutdown_delay = "5s"
    network {
      port "web" {
        static = 80
        to     = 80
      }
      port "websecure" {
        static = 443
        to     = 443
      }
      port "admin" {
        static = 8080
        to     = 8080
      }
    }

    ephemeral_disk {
      size   = 256
      sticky = true
    }

    service {
      name     = "traefik"
      port     = "web"
      provider = "nomad"
      check {
        name     = "ping"
        type     = "http"
        port     = "admin"
        path     = "/ping"
        interval = "10s"
        timeout  = "2s"
      }
    }

    task "traefik" {
      driver = "docker"
      config {
        image   = "traefik:v3.2"
        ports   = ["web", "websecure", "admin"]
        volumes = [
          "local/traefik.yml:/etc/traefik/traefik.yml",
          "local/dynamic.yml:/etc/traefik/dynamic.yml",
          "local/acme:/acme",
          # Optional: mount Nomad CA for strict TLS verification with providers.nomad:
          # "/opt/nomad-deck/nomad/etc/nomad.d/tls/ca.pem:/etc/ssl/nomad-ca.pem:ro",
        ]
      }

      # Optional: inject NOMAD_TOKEN and ALICLOUD_ACCESS_KEY/SECRET_KEY from Vault (Role "traefik"):
      # vault {
      #   role = "traefik"
      #   env  = false
      # }
      #
      # template {
      #   destination = "secrets/traefik.env"
      #   env         = true
      #   change_mode = "restart"
      #   data        = <<-EOT
      # {{ with secret "secret/data/apps/traefik" }}
      # NOMAD_TOKEN={{ .Data.data.nomad_token | toJSON }}
      # ALICLOUD_ACCESS_KEY={{ .Data.data.ali_key | toJSON }}
      # ALICLOUD_SECRET_KEY={{ .Data.data.ali_secret | toJSON }}
      # {{ end }}
      # EOT
      # }

      template {
        destination = "local/traefik.yml"
        change_mode = "restart"
        data        = <<-EOT
entryPoints:
  web:
    address: ":80"
    # Optional HTTP -> HTTPS redirect:
    # http:
    #   redirections:
    #     entryPoint:
    #       to: websecure
    #       scheme: https
  websecure:
    address: ":443"
  traefik:
    address: ":8080"

ping:
  entryPoint: "traefik"

api:
  dashboard: true
  insecure: true

providers:
  file:
    filename: /etc/traefik/dynamic.yml
    watch: true
  # Optional Nomad service discovery (replace 10.0.0.10 with your Nomad node IP):
  # nomad:
  #   exposedByDefault: false
  #   endpoint:
  #     address: "https://10.0.0.10:4646"
  #     tls:
  #       ca: /etc/ssl/nomad-ca.pem

# Optional Alibaba DNS-01 wildcard certs (requires ALICLOUD_ACCESS_KEY / ALICLOUD_SECRET_KEY):
# certificatesResolvers:
#   alidns:
#     acme:
#       email: "admin@example.com"
#       storage: /acme/acme.json
#       dnsChallenge:
#         provider: alidns
#         delayBeforeCheck: 15
EOT
      }

      template {
        destination = "local/dynamic.yml"
        change_mode = "noop"
        data        = <<-EOT
http:
  routers: {}
  services: {}
EOT
      }

      resources {
        cpu    = 150
        memory = 128
      }
    }
  }
}
`,
  },
  {
    id: 'nginx-gateway',
    label: 'Nginx 网关 + Vault 证书',
    labelEn: 'Nginx Gateway + Vault Certs',
    tags: ['Docker', '网关', 'Vault'],
    tagsEn: ['Docker', 'Gateway', 'Vault'],
    desc: '标准 Nginx 反向代理网关，支持 nomadService 动态上游与 Vault 证书 SIGHUP 无缝热加载（无需 Lua 时的轻量首选）',
    descEn: 'Standard Nginx reverse proxy with nomadService dynamic upstreams and Vault cert SIGHUP hot-reload (lightweight alternative to OpenResty)',
    requires: [
      { kind: 'driver', label: 'Docker 驱动', labelEn: 'Docker Driver' },
      { kind: 'port', label: '端口 80 / 443', labelEn: 'Ports 80 / 443' },
      { kind: 'vault', label: '可选 Vault HTTPS', labelEn: 'Optional Vault HTTPS' },
    ],
    notes: [
      {
        title: '可选：启用 HTTPS 与 Vault 证书 SIGHUP 热加载',
        titleEn: 'Optional: Enable HTTPS with Vault cert SIGHUP hot-reload',
        detail: '在「集群联动」创建 Role "nginx-gateway"（explicit 模式，路径 secret/certs/tls）并点击「应用联动」，通过 acme-cert-sync 或手动在 Vault secret/certs/tls 写入 fullchain 与 privkey，再取消 HCL 中的 vault / cert template 与 443 server 注释（取消后体检会自动核对 Role 与密钥）。',
        detailEn: 'Create Role "nginx-gateway" (explicit path secret/certs/tls) in Integrations and apply it, populate fullchain & privkey at secret/certs/tls (via acme-cert-sync or manually), then uncomment the vault, cert templates, and 443 server block.',
        optional: true,
        linkTo: '/integrations',
        linkLabel: '前往集群联动',
        linkLabelEn: 'Open Integrations',
      },
      {
        title: '可选：启用 nomadService 动态上游',
        titleEn: 'Optional: Enable nomadService dynamic upstream',
        detail: '取消 nginx.conf 中的 upstream app_backend 注释并将 "app" 替换为目标后端在 Nomad 注册的 service 名称。',
        detailEn: 'Uncomment upstream app_backend in nginx.conf and replace "app" with your backend Nomad service name.',
        optional: true,
      },
    ],
    hcl: `job "nginx-gateway" {
  datacenters = ["dc1"]
  type        = "service"

  group "gateway" {
    count          = 1
    shutdown_delay = "5s"
    network {
      port "http" {
        static = 80
        to     = 80
      }
      port "https" {
        static = 443
        to     = 443
      }
    }

    service {
      name     = "nginx-gateway"
      port     = "http"
      provider = "nomad"
      check {
        name     = "http-health"
        type     = "http"
        path     = "/healthz"
        interval = "15s"
        timeout  = "3s"
      }
    }

    task "nginx" {
      driver = "docker"
      config {
        image   = "nginx:alpine"
        ports   = ["http", "https"]
        volumes = [
          "local/nginx.conf:/etc/nginx/nginx.conf:ro",
        ]
      }

      # Optional HTTPS certs from Vault (Role "nginx-gateway", path secret/certs/tls):
      # vault {
      #   role = "nginx-gateway"
      #   env  = false
      # }
      #
      # template {
      #   destination   = "secrets/cert.pem"
      #   perms         = "0640"
      #   change_mode   = "signal"
      #   change_signal = "SIGHUP"
      #   data          = <<-EOT
      # {{ with secret "secret/data/certs/tls" }}{{ .Data.data.fullchain }}{{ end }}
      # EOT
      # }
      #
      # template {
      #   destination   = "secrets/cert.key"
      #   perms         = "0600"
      #   change_mode   = "signal"
      #   change_signal = "SIGHUP"
      #   data          = <<-EOT
      # {{ with secret "secret/data/certs/tls" }}{{ .Data.data.privkey }}{{ end }}
      # EOT
      # }

      template {
        destination   = "local/nginx.conf"
        change_mode   = "signal"
        change_signal = "SIGHUP"
        data          = <<-EOT
events {
  worker_connections 1024;
}

http {
  include       /etc/nginx/mime.types;
  default_type  application/octet-stream;
  server_tokens off;
  sendfile      on;
  client_max_body_size 100M;

  map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
  }

  # Optional nomadService dynamic upstream (replace "app" with your service name):
  # upstream app_backend {
  #   server 127.0.0.1:9 down;
  #   {{- range nomadService "app" }}
  #   server {{ .Address }}:{{ .Port }};
  #   {{- end }}
  #   keepalive 16;
  # }

  server {
    listen 80;
    server_name _;

    location = /healthz {
      access_log off;
      return 200 "ok\n";
    }

    # Optional HTTP -> HTTPS redirect:
    # location / { return 301 https://$host$request_uri; }
    location / {
      return 200 "NomadDeck Nginx Gateway ready\n";
    }
  }

  # Optional HTTPS server (enable with Vault cert templates above):
  # server {
  #   listen 443 ssl http2;
  #   server_name app.example.com;
  #
  #   ssl_certificate     /secrets/cert.pem;
  #   ssl_certificate_key /secrets/cert.key;
  #   ssl_protocols       TLSv1.2 TLSv1.3;
  #   ssl_session_cache   shared:SSL:10m;
  #
  #   location / {
  #     proxy_pass http://app_backend;
  #     proxy_http_version 1.1;
  #     proxy_set_header Host $host;
  #     proxy_set_header X-Real-IP $remote_addr;
  #     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  #     proxy_set_header X-Forwarded-Proto https;
  #     proxy_set_header Upgrade $http_upgrade;
  #     proxy_set_header Connection $connection_upgrade;
  #   }
  # }
}
EOT
      }

      resources {
        cpu    = 100
        memory = 64
      }
    }
  }
}
`,
  },
  {
    id: 'openresty-gateway',
    label: 'OpenResty 网关 + Lua WAF',
    labelEn: 'OpenResty Gateway + Lua WAF',
    tags: ['Docker', '网关', 'OpenResty', 'Vault'],
    tagsEn: ['Docker', 'Gateway', 'OpenResty', 'Vault'],
    desc: '基于 openresty/openresty:alpine，内置 nomadService 动态上游、Lua 敏感路径封禁与 Vault 证书 SIGHUP 热加载',
    descEn: 'OpenResty gateway with nomadService dynamic upstreams, Lua sensitive-path WAF protection, and Vault cert SIGHUP hot-reload',
    requires: [
      { kind: 'driver', label: 'Docker 驱动', labelEn: 'Docker Driver' },
      { kind: 'port', label: '端口 80 / 443', labelEn: 'Ports 80 / 443' },
      { kind: 'vault', label: '可选 Vault HTTPS', labelEn: 'Optional Vault HTTPS' },
    ],
    notes: [
      {
        title: '可选：启用 HTTPS 与 Vault 证书 SIGHUP 热加载',
        titleEn: 'Optional: Enable HTTPS with Vault cert SIGHUP hot-reload',
        detail: '在「集群联动」创建 Role "openresty-gateway"（explicit 模式，路径 secret/certs/tls）并点击「应用联动」，通过 acme-cert-sync 或手动在 Vault secret/certs/tls 写入 fullchain 与 privkey，再取消 HCL 中的 vault / cert template 与 443 server 注释。',
        detailEn: 'Create Role "openresty-gateway" (explicit path secret/certs/tls) in Integrations and apply it, populate fullchain & privkey at secret/certs/tls, then uncomment the vault, cert templates, and 443 server block.',
        optional: true,
        linkTo: '/integrations',
        linkLabel: '前往集群联动',
        linkLabelEn: 'Open Integrations',
      },
      {
        title: '可选：启用 nomadService 动态上游',
        titleEn: 'Optional: Enable nomadService dynamic upstream',
        detail: '取消 nginx.conf 中的 upstream app_backend 注释并将 "app" 替换为目标后端在 Nomad 注册的 service 名称。',
        detailEn: 'Uncomment upstream app_backend in nginx.conf and replace "app" with your backend Nomad service name.',
        optional: true,
      },
    ],
    hcl: `job "openresty-gateway" {
  datacenters = ["dc1"]
  type        = "service"

  group "gateway" {
    count          = 1
    shutdown_delay = "5s"
    network {
      port "http" {
        static = 80
        to     = 80
      }
      port "https" {
        static = 443
        to     = 443
      }
    }

    service {
      name     = "openresty-gateway"
      port     = "http"
      provider = "nomad"
      check {
        name     = "http-health"
        type     = "http"
        path     = "/healthz"
        interval = "15s"
        timeout  = "3s"
      }
    }

    task "openresty" {
      driver = "docker"
      config {
        image   = "openresty/openresty:alpine"
        ports   = ["http", "https"]
        volumes = [
          "local/nginx.conf:/usr/local/openresty/nginx/conf/nginx.conf:ro",
          "local/ban-rules.conf:/usr/local/openresty/nginx/conf/ban-rules.conf:ro",
          "local/ban-check.lua:/usr/local/openresty/nginx/conf/ban-check.lua:ro",
        ]
      }

      # Optional HTTPS certs from Vault (Role "openresty-gateway", path secret/certs/tls):
      # vault {
      #   role = "openresty-gateway"
      #   env  = false
      # }
      #
      # template {
      #   destination   = "secrets/cert.pem"
      #   perms         = "0640"
      #   change_mode   = "signal"
      #   change_signal = "SIGHUP"
      #   data          = <<-EOT
      # {{ with secret "secret/data/certs/tls" }}{{ .Data.data.fullchain }}{{ end }}
      # EOT
      # }
      #
      # template {
      #   destination   = "secrets/cert.key"
      #   perms         = "0600"
      #   change_mode   = "signal"
      #   change_signal = "SIGHUP"
      #   data          = <<-EOT
      # {{ with secret "secret/data/certs/tls" }}{{ .Data.data.privkey }}{{ end }}
      # EOT
      # }

      template {
        destination   = "local/ban-rules.conf"
        change_mode   = "signal"
        change_signal = "SIGHUP"
        data          = <<-EOT
lua_shared_dict waf_probe_counter 10m;
lua_shared_dict waf_ban_ip 10m;

map $uri $sensitive_probe_path {
  default "";
  ~*^/\\.env(?:$|[./]) env;
  ~*^/\\.git/config$ git-config;
  ~*^/wp-admin(?:/|$) wp-admin;
  ~*^/wp-login\\.php$ wp-login;
  ~*^/phpmyadmin(?:/|$) phpmyadmin;
}
EOT
      }

      template {
        destination   = "local/ban-check.lua"
        change_mode   = "signal"
        change_signal = "SIGHUP"
        data          = <<-EOT
local ip = ngx.var.remote_addr or ""
if ip == "" or ip == "127.0.0.1" then
  return
end
local ban = ngx.shared.waf_ban_ip
if ban and ban:get(ip) then
  return ngx.exit(444)
end
local hit = ngx.var.sensitive_probe_path
if hit and hit ~= "" then
  local counter = ngx.shared.waf_probe_counter
  if counter then
    local n = counter:incr(ip, 1, 0, 600)
    if n and n >= 2 and ban then
      ban:set(ip, hit, 3600)
      ngx.log(ngx.WARN, "WAF banned ", ip, " probe=", hit)
    end
  end
  return ngx.exit(444)
end
EOT
      }

      template {
        destination   = "local/nginx.conf"
        change_mode   = "signal"
        change_signal = "SIGHUP"
        data          = <<-EOT
events {
  worker_connections 1024;
}

http {
  include       mime.types;
  default_type  application/octet-stream;
  server_tokens off;
  sendfile      on;
  client_max_body_size 100M;

  include /usr/local/openresty/nginx/conf/ban-rules.conf;

  map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
  }

  # Optional nomadService dynamic upstream (replace "app" with your service name):
  # upstream app_backend {
  #   server 127.0.0.1:9 down;
  #   {{- range nomadService "app" }}
  #   server {{ .Address }}:{{ .Port }};
  #   {{- end }}
  #   keepalive 16;
  # }

  server {
    listen 80;
    server_name _;

    server_rewrite_by_lua_file /usr/local/openresty/nginx/conf/ban-check.lua;

    location = /healthz {
      access_log off;
      return 200 "ok\n";
    }

    location / {
      return 200 "NomadDeck OpenResty Gateway ready\n";
    }
  }

  # Optional HTTPS server (enable with Vault cert templates above):
  # server {
  #   listen 443 ssl http2;
  #   server_name app.example.com;
  #
  #   ssl_certificate     /secrets/cert.pem;
  #   ssl_certificate_key /secrets/cert.key;
  #   ssl_protocols       TLSv1.2 TLSv1.3;
  #   ssl_session_cache   shared:SSL:10m;
  #
  #   server_rewrite_by_lua_file /usr/local/openresty/nginx/conf/ban-check.lua;
  #
  #   location / {
  #     proxy_pass http://app_backend;
  #     proxy_http_version 1.1;
  #     proxy_set_header Host $host;
  #     proxy_set_header X-Real-IP $remote_addr;
  #     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  #     proxy_set_header X-Forwarded-Proto https;
  #     proxy_set_header Upgrade $http_upgrade;
  #     proxy_set_header Connection $connection_upgrade;
  #   }
  # }
}
EOT
      }

      resources {
        cpu    = 120
        memory = 96
      }
    }
  }
}
`,
  },
  {
    id: 'acme-cert-sync',
    label: 'ACME 证书自动续期 (Vault 同步)',
    labelEn: 'ACME Cert Renewal (Vault Sync)',
    tags: ['Docker', '证书', 'Vault', '定时任务'],
    tagsEn: ['Docker', 'TLS', 'Vault', 'Periodic'],
    desc: '需先配置 acme-cert-sync 读写 Role 与 secret/certs/dns，定时续期通配符证书并推送 Vault KV 触发网关 SIGHUP 热加载',
    descEn: 'Requires acme-cert-sync read/write Role & secret/certs/dns; renews wildcard certs on schedule and pushes to Vault KV for gateway SIGHUP reload',
    requires: [
      { kind: 'driver', label: 'Docker 驱动', labelEn: 'Docker Driver' },
      { kind: 'vault', label: 'Role: acme-cert-sync (读写)', labelEn: 'Role: acme-cert-sync (R/W)' },
      { kind: 'vault', label: 'KV: secret/certs/dns', labelEn: 'KV: secret/certs/dns' },
      { kind: 'network', label: '外网访问 ACME / DNS API', labelEn: 'Internet: ACME & DNS API' },
    ],
    notes: [
      {
        title: '外网连通性与持久化建议',
        titleEn: 'Internet access & state persistence',
        detail: '容器需能访问外网 Alpine APK 源、ACME CA（Let\'s Encrypt 等）与 DNS 服务商 API；生产环境建议将 /acme.sh 挂载到 Host Volume，避免重调度重复签发。',
        detailEn: 'Container requires outbound access to Alpine APK repos, ACME CA, and your DNS provider API. Mount /acme.sh on a Host Volume in production to avoid re-issuing on reschedule.',
        optional: false,
      },
      {
        title: '自定义读写 Policy 说明',
        titleEn: 'Custom read/write Policy note',
        detail: '任务需读取 secret/data/certs/dns 并写入 secret/data/certs/tls（create/update/read）；点击下方体检项中的「一键创建并应用 Role」会自动生成完整自定义 Policy HCL。',
        detailEn: 'Reads secret/data/certs/dns and writes secret/data/certs/tls (create/update/read). Clicking "Create & Apply Role" in the preflight panel auto-generates the required custom Policy HCL.',
        optional: false,
        linkTo: '/integrations',
        linkLabel: '查看集群联动',
        linkLabelEn: 'View Integrations',
      },
    ],
    secretHints: {
      domain: { placeholder: '*.example.com', placeholderEn: '*.example.com', hint: '主证书域名', hintEn: 'Primary certificate domain' },
      vault_addr: { placeholder: 'https://10.0.0.10:8200', placeholderEn: 'https://10.0.0.10:8200', hint: '可在「Vault 集群 → 集群状态详情」查看', hintEn: 'Find under Vault Cluster -> Status' },
      ali_key: { secret: true, placeholder: '阿里云 AccessKey ID', placeholderEn: 'Alibaba Cloud AccessKey ID', hint: '默认 dns_ali 所需', hintEn: 'Required for default dns_ali' },
      ali_secret: { secret: true, placeholder: '阿里云 AccessKey Secret', placeholderEn: 'Alibaba Cloud AccessKey Secret', hint: '默认 dns_ali 所需', hintEn: 'Required for default dns_ali' },
      dns_provider: { defaultValue: 'dns_ali', placeholder: 'dns_ali', placeholderEn: 'dns_ali' },
      acme_ca: { defaultValue: 'letsencrypt', placeholder: 'letsencrypt', placeholderEn: 'letsencrypt' },
      acme_email: { placeholder: 'admin@example.com', placeholderEn: 'admin@example.com' },
      alt_domains: { placeholder: 'example.com', placeholderEn: 'example.com', hint: '逗号分隔的附加 SAN 域名', hintEn: 'Comma-separated SAN domains' },
      vault_kv_path: { defaultValue: 'secret/data/certs/tls', placeholder: 'secret/data/certs/tls', placeholderEn: 'secret/data/certs/tls' },
      vault_skip_verify: { defaultValue: 'false', placeholder: 'false', placeholderEn: 'false' },
    },
    hcl: `job "acme-cert-sync" {
  datacenters = ["dc1"]
  type        = "batch"

  periodic {
    crons            = ["0 2 * * *"]
    prohibit_overlap = true
    time_zone        = "Asia/Shanghai"
  }

  group "acme" {
    count = 1

    ephemeral_disk {
      size   = 128
      sticky = true
    }

    task "renew" {
      driver = "docker"
      config {
        image      = "neilpang/acme.sh:latest"
        entrypoint = ["/bin/sh"]
        args       = ["/local/sync.sh"]
        volumes = [
          "local/acme-home:/acme.sh",
          "/opt/nomad-deck/nomad/etc/nomad.d/tls/vault-ca.crt:/etc/ssl/vault-ca.crt:ro",
        ]
      }

      vault {
        role = "acme-cert-sync"
        env  = true
      }

      template {
        destination = "secrets/acme.env"
        env         = true
        change_mode = "noop"
        data        = <<-EOT
{{ with secret "secret/data/certs/dns" }}
DOMAIN={{ .Data.data.domain | toJSON }}
ALT_DOMAINS={{ or .Data.data.alt_domains "" | toJSON }}
DNS_PROVIDER={{ or .Data.data.dns_provider "dns_ali" | toJSON }}
ACME_CA={{ or .Data.data.acme_ca "letsencrypt" | toJSON }}
ACME_EMAIL={{ or .Data.data.acme_email "" | toJSON }}
VAULT_ADDR={{ .Data.data.vault_addr | toJSON }}
VAULT_KV_PATH={{ or .Data.data.vault_kv_path "secret/data/certs/tls" | toJSON }}
VAULT_SKIP_VERIFY={{ or .Data.data.vault_skip_verify "false" | toJSON }}
Ali_Key={{ or .Data.data.ali_key "" | toJSON }}
Ali_Secret={{ or .Data.data.ali_secret "" | toJSON }}
{{ end }}
EOT
      }

      template {
        destination = "secrets/vault-ca.crt"
        perms       = "0644"
        change_mode = "noop"
        data        = <<-EOT
{{ with secret "secret/data/certs/dns" }}{{ or .Data.data.vault_cacert "" }}{{ end }}
EOT
      }

      template {
        destination = "local/sync.sh"
        perms       = "0755"
        change_mode = "noop"
        data        = <<-EOT
#!/bin/sh
set -eu

command -v curl >/dev/null 2>&1 || apk add --no-cache curl >/dev/null

if [ -z "$DOMAIN" ] || [ -z "$VAULT_ADDR" ]; then
  echo "missing DOMAIN or VAULT_ADDR in secret/data/certs/dns" >&2
  exit 1
fi

export HOME=/acme.sh
CERT_DIR="/acme.sh/$DOMAIN""_ecc"
OUT_DIR="/acme.sh/out/$DOMAIN"
mkdir -p "$OUT_DIR"

ISSUED=0
if [ -f "$CERT_DIR/$DOMAIN.cer" ]; then
  acme.sh --renew -d "$DOMAIN" --ecc --home /acme.sh || ISSUED=$?
  # acme.sh exit code 2 means cert is not due for renewal yet
  if [ "$ISSUED" -ne 0 ] && [ "$ISSUED" -ne 2 ]; then
    exit "$ISSUED"
  fi
else
  ARGS="--issue -d $DOMAIN --dns $DNS_PROVIDER --server $ACME_CA --home /acme.sh"
  if [ -n "$ALT_DOMAINS" ]; then
    for d in $(echo "$ALT_DOMAINS" | tr ',' ' '); do
      ARGS="$ARGS -d $d"
    done
  fi
  if [ -n "$ACME_EMAIL" ]; then
    acme.sh --register-account -m "$ACME_EMAIL" --server "$ACME_CA" --home /acme.sh || true
  fi
  # shellcheck disable=SC2086
  acme.sh $ARGS
fi

acme.sh --install-cert -d "$DOMAIN" --ecc --home /acme.sh \\
  --fullchain-file "$OUT_DIR/fullchain.pem" \\
  --key-file "$OUT_DIR/privkey.pem"

esc_pem() {
  awk '{printf "%s\\\\n", $0}' "$1" | sed 's/"/\\\\"/g'
}

FULLCHAIN_JSON="$(esc_pem "$OUT_DIR/fullchain.pem")"
PRIVKEY_JSON="$(esc_pem "$OUT_DIR/privkey.pem")"

CURL_TLS=""
if [ "$VAULT_SKIP_VERIFY" = "true" ]; then
  CURL_TLS="-k"
elif [ -s /secrets/vault-ca.crt ]; then
  CURL_TLS="--cacert /secrets/vault-ca.crt"
elif [ -s /etc/ssl/vault-ca.crt ]; then
  CURL_TLS="--cacert /etc/ssl/vault-ca.crt"
fi

BASE_URL=$(printf '%s' "$VAULT_ADDR" | sed 's:/*$::')
KV_PATH=$(printf '%s' "$VAULT_KV_PATH" | sed 's:^/*::')

# shellcheck disable=SC2086
curl -fsS $CURL_TLS \\
  -X POST \\
  -H "X-Vault-Token: $VAULT_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d "{\\"data\\":{\\"domain\\":\\"$DOMAIN\\",\\"fullchain\\":\\"$FULLCHAIN_JSON\\",\\"privkey\\":\\"$PRIVKEY_JSON\\"}}" \\
  "$BASE_URL/v1/$KV_PATH" >/dev/null

echo "Synced certificate for $DOMAIN to $VAULT_KV_PATH"
EOT
      }

      resources {
        cpu    = 100
        memory = 128
      }
    }
  }
}
`,
  },
  {
    id: 'postgres',
    label: 'PostgreSQL + Vault 密钥',
    labelEn: 'PostgreSQL + Vault Secrets',
    tags: ['Docker', 'Vault', '数据库'],
    tagsEn: ['Docker', 'Vault', 'Database'],
    desc: '自动从 Vault 注入 0600 密码文件与账号环境变量（支持体检面板一键补齐 Role 与密钥）',
    descEn: 'Injects 0600 password file & credentials from Vault (supports one-click Role & secret setup in preflight)',
    requires: [
      { kind: 'driver', label: 'Docker 驱动', labelEn: 'Docker Driver' },
      { kind: 'port', label: '端口 5432', labelEn: 'Port 5432' },
      { kind: 'vault', label: 'Role: postgres', labelEn: 'Role: postgres' },
      { kind: 'vault', label: 'KV: secret/apps/postgres', labelEn: 'KV: secret/apps/postgres' },
    ],
    notes: [
      {
        title: '生产数据持久化建议',
        titleEn: 'Persist database storage in production',
        detail: '示例使用 sticky ephemeral_disk，数据保留在当前 Allocation；生产环境建议替换为 Host Volume 或 CSI 持久卷并定期备份。',
        detailEn: 'Uses a sticky ephemeral_disk for quick starts; switch to a Host Volume or CSI volume with backups for production.',
        optional: false,
      },
    ],
    secretHints: {
      username: { defaultValue: 'postgres', placeholder: 'postgres', placeholderEn: 'postgres' },
      password: { secret: true, placeholder: '强密码（可点右侧随机生成）', placeholderEn: 'Strong password (or click generate)' },
      database: { defaultValue: 'app', placeholder: 'app', placeholderEn: 'app' },
    },
    hcl: `job "postgres" {
  datacenters = ["dc1"]
  type        = "service"

  group "database" {
    count = 1
    network {
      port "db" {
        static = 5432
        to     = 5432
      }
    }

    ephemeral_disk {
      size   = 1024
      sticky = true
    }

    task "postgres" {
      driver = "docker"
      config {
        image   = "postgres:17-bookworm"
        ports   = ["db"]
        volumes = ["local/pgdata:/var/lib/postgresql/data"]
      }

      vault {
        role = "postgres"
        env  = false
      }

      env {
        POSTGRES_PASSWORD_FILE = "/secrets/postgres-password"
      }

      template {
        destination = "secrets/postgres-password"
        perms       = "0600"
        change_mode = "noop"
        data        = <<-EOT
{{ with secret "secret/data/apps/postgres" }}{{ .Data.data.password }}{{ end }}
EOT
      }

      template {
        destination = "secrets/postgres.env"
        env         = true
        data        = <<-EOT
{{ with secret "secret/data/apps/postgres" }}
POSTGRES_USER={{ .Data.data.username | toJSON }}
POSTGRES_DB={{ .Data.data.database | toJSON }}
{{ end }}
EOT
      }

      resources {
        cpu    = 200
        memory = 256
      }
    }
  }
}
`,
  },
  {
    id: 'mysql',
    label: 'MySQL 8 + Vault 密钥',
    labelEn: 'MySQL 8 + Vault Secrets',
    tags: ['Docker', 'Vault', '数据库'],
    tagsEn: ['Docker', 'Vault', 'Database'],
    desc: '自动从 Vault 注入 0600 密码文件与业务库账号（支持体检面板一键补齐 Role 与密钥）',
    descEn: 'Injects 0600 root & user password files from Vault (supports one-click Role & secret setup in preflight)',
    requires: [
      { kind: 'driver', label: 'Docker 驱动', labelEn: 'Docker Driver' },
      { kind: 'port', label: '端口 3306', labelEn: 'Port 3306' },
      { kind: 'vault', label: 'Role: mysql', labelEn: 'Role: mysql' },
      { kind: 'vault', label: 'KV: secret/apps/mysql', labelEn: 'KV: secret/apps/mysql' },
    ],
    notes: [
      {
        title: '生产数据持久化建议',
        titleEn: 'Persist database storage in production',
        detail: '示例使用 sticky ephemeral_disk；生产环境建议改用 Host Volume 或 CSI 持久卷。',
        detailEn: 'Uses a sticky ephemeral_disk by default; switch to a Host Volume or CSI volume for production.',
        optional: false,
      },
    ],
    secretHints: {
      root_password: { secret: true, placeholder: 'Root 强密码', placeholderEn: 'Strong root password' },
      username: { defaultValue: 'app', placeholder: 'app', placeholderEn: 'app' },
      password: { secret: true, placeholder: '业务用户强密码', placeholderEn: 'Strong app password' },
      database: { defaultValue: 'app', placeholder: 'app', placeholderEn: 'app' },
    },
    hcl: `job "mysql" {
  datacenters = ["dc1"]
  type        = "service"

  group "database" {
    count = 1
    network {
      port "db" {
        static = 3306
        to     = 3306
      }
    }

    ephemeral_disk {
      size   = 2048
      sticky = true
    }

    task "mysql" {
      driver = "docker"
      config {
        image   = "mysql:8.4"
        ports   = ["db"]
        volumes = ["local/mysql:/var/lib/mysql"]
      }

      vault {
        role = "mysql"
        env  = false
      }

      env {
        MYSQL_ROOT_PASSWORD_FILE = "/secrets/mysql-root-password"
        MYSQL_PASSWORD_FILE      = "/secrets/mysql-password"
      }

      template {
        destination = "secrets/mysql-root-password"
        perms       = "0600"
        change_mode = "noop"
        data        = <<-EOT
{{ with secret "secret/data/apps/mysql" }}{{ .Data.data.root_password }}{{ end }}
EOT
      }

      template {
        destination = "secrets/mysql-password"
        perms       = "0600"
        change_mode = "noop"
        data        = <<-EOT
{{ with secret "secret/data/apps/mysql" }}{{ .Data.data.password }}{{ end }}
EOT
      }

      template {
        destination = "secrets/mysql.env"
        env         = true
        data        = <<-EOT
{{ with secret "secret/data/apps/mysql" }}
MYSQL_USER={{ .Data.data.username | toJSON }}
MYSQL_DATABASE={{ .Data.data.database | toJSON }}
{{ end }}
EOT
      }

      resources {
        cpu    = 300
        memory = 512
      }
    }
  }
}
`,
  },
  {
    id: 'redis',
    label: 'Redis + Vault 密钥',
    labelEn: 'Redis + Vault Secrets',
    tags: ['Docker', 'Vault', '缓存'],
    tagsEn: ['Docker', 'Vault', 'Cache'],
    desc: '通过 0600 内存密码文件安全注入 requirepass（支持体检面板一键补齐 Role 与密钥）',
    descEn: 'Injects requirepass safely from a 0600 Vault tmpfs file (supports one-click Role & secret setup in preflight)',
    requires: [
      { kind: 'driver', label: 'Docker 驱动', labelEn: 'Docker Driver' },
      { kind: 'port', label: '端口 6379', labelEn: 'Port 6379' },
      { kind: 'vault', label: 'Role: redis', labelEn: 'Role: redis' },
      { kind: 'vault', label: 'KV: secret/apps/redis', labelEn: 'KV: secret/apps/redis' },
    ],
    secretHints: {
      password: { secret: true, placeholder: 'Redis 访问密码', placeholderEn: 'Redis requirepass password' },
    },
    hcl: `job "redis" {
  datacenters = ["dc1"]
  type        = "service"

  group "cache" {
    count = 1
    network {
      port "redis" {
        static = 6379
        to     = 6379
      }
    }

    ephemeral_disk {
      size   = 512
      sticky = true
    }

    task "redis" {
      driver = "docker"
      config {
        image      = "redis:7-alpine"
        ports      = ["redis"]
        entrypoint = ["/bin/sh", "-c"]
        args       = ["exec docker-entrypoint.sh redis-server --bind 0.0.0.0 --port 6379 --appendonly yes --requirepass \\"$(cat /secrets/redis-password)\\""]
      }

      vault {
        role = "redis"
        env  = false
      }

      template {
        destination = "secrets/redis-password"
        perms       = "0600"
        change_mode = "restart"
        data        = <<-EOT
{{ with secret "secret/data/apps/redis" }}{{ .Data.data.password }}{{ end }}
EOT
      }

      resources {
        cpu    = 150
        memory = 128
      }
    }
  }
}
`,
  },
  {
    id: 'rabbitmq',
    label: 'RabbitMQ + Vault 密钥',
    labelEn: 'RabbitMQ + Vault Secrets',
    tags: ['Docker', 'Vault', '消息队列'],
    tagsEn: ['Docker', 'Vault', 'Message Queue'],
    desc: '含 AMQP (5672) 与 Web 管理面板 (15672)，账号密码由 Vault 注入（支持体检面板一键补齐）',
    descEn: 'Exposes AMQP (5672) & Web UI (15672) with Vault-injected credentials (supports one-click setup in preflight)',
    requires: [
      { kind: 'driver', label: 'Docker 驱动', labelEn: 'Docker Driver' },
      { kind: 'port', label: '端口 5672 / 15672', labelEn: 'Ports 5672 / 15672' },
      { kind: 'vault', label: 'Role: rabbitmq', labelEn: 'Role: rabbitmq' },
      { kind: 'vault', label: 'KV: secret/apps/rabbitmq', labelEn: 'KV: secret/apps/rabbitmq' },
    ],
    secretHints: {
      username: { defaultValue: 'admin', placeholder: 'admin', placeholderEn: 'admin' },
      password: { secret: true, placeholder: '管理账号强密码', placeholderEn: 'Strong RabbitMQ password' },
    },
    hcl: `job "rabbitmq" {
  datacenters = ["dc1"]
  type        = "service"

  group "mq" {
    count          = 1
    shutdown_delay = "5s"
    network {
      port "amqp" {
        static = 5672
        to     = 5672
      }
      port "mgmt" {
        static = 15672
        to     = 15672
      }
    }

    ephemeral_disk {
      size   = 1024
      sticky = true
    }

    service {
      name     = "rabbitmq"
      port     = "amqp"
      provider = "nomad"
      check {
        name     = "tcp-amqp"
        type     = "tcp"
        interval = "15s"
        timeout  = "3s"
      }
    }

    task "rabbitmq" {
      driver = "docker"
      config {
        image   = "rabbitmq:3.13-management-alpine"
        ports   = ["amqp", "mgmt"]
        volumes = ["local/rabbitmq:/var/lib/rabbitmq"]
      }

      vault {
        role = "rabbitmq"
        env  = false
      }

      template {
        destination = "secrets/rabbitmq.env"
        env         = true
        change_mode = "restart"
        data        = <<-EOT
{{ with secret "secret/data/apps/rabbitmq" }}
RABBITMQ_DEFAULT_USER={{ .Data.data.username | toJSON }}
RABBITMQ_DEFAULT_PASS={{ .Data.data.password | toJSON }}
{{ end }}
EOT
      }

      resources {
        cpu    = 250
        memory = 384
      }
    }
  }
}
`,
  },
  {
    id: 'rocketmq',
    label: 'RocketMQ 单机服务',
    labelEn: 'RocketMQ Single-Node',
    tags: ['Docker', '消息队列'],
    tagsEn: ['Docker', 'Message Queue'],
    desc: '同 Group 协同运行 NameServer (9876) 与 Broker (10911)，内建 broker.conf 模板与持久化存储目录',
    descEn: 'Runs NameServer (9876) and Broker (10911) together with a built-in broker.conf template and persistent disk',
    requires: [
      { kind: 'driver', label: 'Docker 驱动', labelEn: 'Docker Driver' },
      { kind: 'port', label: '端口 9876 / 10909-10912', labelEn: 'Ports 9876 / 10909-10912' },
      { kind: 'network', label: '节点 IP 直连 & ≥1.2G 内存', labelEn: 'Direct Node IP & >=1.2G RAM' },
    ],
    notes: [
      {
        title: '资源与网络直连要求',
        titleEn: 'Resource & client network requirements',
        detail: '同 Group 两个 Task 共需至少 500 MHz CPU 与 1152 MiB 内存；brokerIP1 使用 NOMAD_IP_broker，需确保生产者/消费者可直连该节点 IP。',
        detailEn: 'Requires at least 500 MHz CPU and 1152 MiB RAM on one node. brokerIP1 advertises NOMAD_IP_broker, so producers and consumers must reach that node IP.',
        optional: false,
      },
    ],
    hcl: `job "rocketmq" {
  datacenters = ["dc1"]
  type        = "service"

  group "rocketmq" {
    count          = 1
    shutdown_delay = "5s"
    network {
      port "namesrv" {
        static = 9876
        to     = 9876
      }
      port "vip" {
        static = 10909
        to     = 10909
      }
      port "broker" {
        static = 10911
        to     = 10911
      }
      port "fast" {
        static = 10912
        to     = 10912
      }
    }

    ephemeral_disk {
      size   = 2048
      sticky = true
    }

    service {
      name     = "rocketmq-namesrv"
      port     = "namesrv"
      provider = "nomad"
      check {
        name     = "tcp-namesrv"
        type     = "tcp"
        interval = "15s"
        timeout  = "3s"
      }
    }

    task "namesrv" {
      driver = "docker"
      config {
        image   = "apache/rocketmq:5.3.1"
        ports   = ["namesrv"]
        command = "sh"
        args    = ["mqnamesrv"]
      }

      env {
        JAVA_OPT_EXT = "-Xms128m -Xmx256m"
      }

      resources {
        cpu    = 200
        memory = 384
      }
    }

    task "broker" {
      driver = "docker"
      config {
        image   = "apache/rocketmq:5.3.1"
        ports   = ["vip", "broker", "fast"]
        command = "sh"
        args    = ["mqbroker", "-n", "\${NOMAD_ADDR_namesrv}", "-c", "/etc/rocketmq/broker.conf"]
        volumes = [
          "local/broker.conf:/etc/rocketmq/broker.conf",
          "local/store:/home/rocketmq/store",
        ]
      }

      env {
        JAVA_OPT_EXT = "-Xms256m -Xmx512m -Xmn128m"
      }

      template {
        destination = "local/broker.conf"
        change_mode = "restart"
        data        = <<-EOT
brokerClusterName = DefaultCluster
brokerName = broker-a
brokerId = 0
deleteWhen = 04
fileReservedTime = 48
brokerRole = ASYNC_MASTER
flushDiskType = ASYNC_FLUSH
brokerIP1 = {{ env "NOMAD_IP_broker" }}
EOT
      }

      resources {
        cpu    = 300
        memory = 768
      }
    }
  }
}
`,
  },
  {
    id: 'prometheus',
    label: 'Prometheus 指标采集',
    labelEn: 'Prometheus Metrics',
    tags: ['Docker', '监控'],
    tagsEn: ['Docker', 'Monitoring'],
    desc: '时序指标采集与告警引擎，内置 prometheus.yml 模板（含 Nomad Telemetry 抓取示例）与 9090 端口',
    descEn: 'Time-series metrics & alerting engine with built-in prometheus.yml template (including Nomad Telemetry) on port 9090',
    requires: [
      { kind: 'driver', label: 'Docker 驱动', labelEn: 'Docker Driver' },
      { kind: 'port', label: '端口 9090', labelEn: 'Port 9090' },
    ],
    notes: [
      {
        title: '可选：采集 Nomad 集群 Prometheus 指标',
        titleEn: 'Optional: Scrape Nomad Telemetry metrics',
        detail: '先在「Nomad 集群 → 集群运维 → 集群配置 → 运行指标采集」勾选 prometheus_metrics；若启用了 ACL，在「治理 → ACL Policies」建含 agent { policy = "read" } 的策略并「签发 Client Token」填入 bearer_token；若启用了 TLS，挂载 /opt/nomad-deck/nomad/etc/nomad.d/tls/ca.pem 并配置 scheme: https。',
        detailEn: 'Enable prometheus_metrics under Nomad Cluster -> Cluster Ops -> Cluster Config -> Telemetry. If ACL is enabled, create a Policy with agent { policy = "read" } and issue a Client Token for bearer_token; if TLS is enabled, mount the Nomad CA and set scheme: https.',
        optional: true,
        linkTo: '/nomad?tab=ops&sub=config',
        linkLabel: '前往 Nomad 集群配置',
        linkLabelEn: 'Open Nomad Cluster Config',
      },
    ],
    hcl: `job "prometheus" {
  datacenters = ["dc1"]
  type        = "service"

  group "monitoring" {
    count          = 1
    shutdown_delay = "5s"
    network {
      port "http" {
        static = 9090
        to     = 9090
      }
    }

    ephemeral_disk {
      size   = 2048
      sticky = true
    }

    service {
      name     = "prometheus"
      port     = "http"
      provider = "nomad"
      check {
        name     = "healthy"
        type     = "http"
        path     = "/-/healthy"
        interval = "15s"
        timeout  = "3s"
      }
    }

    task "prometheus" {
      driver = "docker"
      config {
        image = "prom/prometheus:v3.0.1"
        ports = ["http"]
        args  = [
          "--config.file=/etc/prometheus/prometheus.yml",
          "--storage.tsdb.path=/prometheus",
          "--storage.tsdb.retention.time=15d",
          "--web.enable-lifecycle",
        ]
        volumes = [
          "local/prometheus.yml:/etc/prometheus/prometheus.yml",
          "local/data:/prometheus",
        ]
      }

      template {
        destination   = "local/prometheus.yml"
        change_mode   = "signal"
        change_signal = "SIGHUP"
        data          = <<-EOT
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: "prometheus"
    static_configs:
      - targets: ["localhost:9090"]

  # Optional Nomad telemetry scrape target (replace 10.0.0.10 with your Nomad node IP):
  # - job_name: "nomad"
  #   metrics_path: "/v1/metrics"
  #   params:
  #     format: ["prometheus"]
  #   # scheme: https
  #   # tls_config:
  #   #   ca_file: /etc/ssl/nomad-ca.pem
  #   # bearer_token: "<Nomad Client Token with agent read policy>"
  #   static_configs:
  #     - targets: ["10.0.0.10:4646"]
EOT
      }

      resources {
        cpu    = 200
        memory = 512
      }
    }
  }
}
`,
  },
  {
    id: 'grafana',
    label: 'Grafana + Vault 密钥',
    labelEn: 'Grafana + Vault Secrets',
    tags: ['Docker', 'Vault', '监控'],
    tagsEn: ['Docker', 'Vault', 'Monitoring'],
    desc: '管理员账号密码由 Vault 注入（支持体检面板一键补齐），可配合系统设置中的 Grafana 跳转链接使用',
    descEn: 'Injects admin credentials from Vault (supports one-click setup in preflight); pairs with System Settings Grafana URL',
    requires: [
      { kind: 'driver', label: 'Docker 驱动', labelEn: 'Docker Driver' },
      { kind: 'port', label: '端口 3000', labelEn: 'Port 3000' },
      { kind: 'vault', label: 'Role: grafana', labelEn: 'Role: grafana' },
      { kind: 'vault', label: 'KV: secret/apps/grafana', labelEn: 'KV: secret/apps/grafana' },
    ],
    notes: [
      {
        title: '可选：配置控制台快捷跳转链接',
        titleEn: 'Optional: Configure quick link in System Settings',
        detail: '运行后可在「系统设置 → 集群与快照 → Grafana 跳转链接模板」填入 Grafana 地址，方便在总览与监控页面一键跳转。',
        detailEn: 'Set the Grafana URL template under System Settings to enable quick links from cluster monitoring views.',
        optional: true,
        linkTo: '/settings',
        linkLabel: '前往系统设置',
        linkLabelEn: 'Open Settings',
      },
    ],
    secretHints: {
      admin_user: { defaultValue: 'admin', placeholder: 'admin', placeholderEn: 'admin' },
      admin_password: { secret: true, placeholder: '管理员强密码', placeholderEn: 'Strong admin password' },
    },
    hcl: `job "grafana" {
  datacenters = ["dc1"]
  type        = "service"

  group "dashboard" {
    count          = 1
    shutdown_delay = "5s"
    network {
      port "http" {
        static = 3000
        to     = 3000
      }
    }

    ephemeral_disk {
      size   = 512
      sticky = true
    }

    service {
      name     = "grafana"
      port     = "http"
      provider = "nomad"
      check {
        name     = "api-health"
        type     = "http"
        path     = "/api/health"
        interval = "15s"
        timeout  = "3s"
      }
    }

    task "grafana" {
      driver = "docker"
      config {
        image   = "grafana/grafana:11.4.0"
        ports   = ["http"]
        volumes = ["local/grafana:/var/lib/grafana"]
      }

      vault {
        role = "grafana"
        env  = false
      }

      env {
        GF_SECURITY_ADMIN_PASSWORD__FILE = "/secrets/grafana-admin-password"
      }

      template {
        destination = "secrets/grafana-admin-password"
        perms       = "0600"
        change_mode = "noop"
        data        = <<-EOT
{{ with secret "secret/data/apps/grafana" }}{{ .Data.data.admin_password }}{{ end }}
EOT
      }

      template {
        destination = "secrets/grafana.env"
        env         = true
        data        = <<-EOT
{{ with secret "secret/data/apps/grafana" }}
GF_SECURITY_ADMIN_USER={{ .Data.data.admin_user | toJSON }}
{{ end }}
EOT
      }

      resources {
        cpu    = 200
        memory = 256
      }
    }
  }
}
`,
  },
  {
    id: 'docker_registry',
    label: 'Docker Registry 镜像库',
    labelEn: 'Docker Registry',
    tags: ['Docker', '镜像库'],
    tagsEn: ['Docker', 'Registry'],
    desc: '私有容器镜像仓库与内网镜像缓存（5000 端口），支持删除镜像及切换为 Pull-through Cache',
    descEn: 'Private container registry and pull-through cache (port 5000) with image deletion enabled',
    requires: [
      { kind: 'driver', label: 'Docker 驱动', labelEn: 'Docker Driver' },
      { kind: 'port', label: '端口 5000', labelEn: 'Port 5000' },
    ],
    notes: [
      {
        title: 'HTTP 推拉镜像或挂载 HTTPS 网关',
        titleEn: 'Configure insecure-registries or HTTPS gateway',
        detail: '若宿主机通过 HTTP（非 HTTPS）直接推拉镜像，需在「Docker 引擎」为 daemon.json 配置 insecure-registries，或前方配合网关挂 HTTPS；生产环境建议替换为 Host Volume / CSI 持久卷。',
        detailEn: 'If pushing/pulling over plain HTTP, configure insecure-registries under Docker Engine, or place an HTTPS gateway in front. Use a persistent volume in production.',
        optional: false,
        linkTo: '/docker',
        linkLabel: '前往 Docker 引擎',
        linkLabelEn: 'Open Docker Engine',
      },
    ],
    hcl: `job "docker-registry" {
  datacenters = ["dc1"]
  type        = "service"

  group "registry" {
    count          = 1
    shutdown_delay = "5s"
    network {
      port "http" {
        static = 5000
        to     = 5000
      }
    }

    ephemeral_disk {
      size   = 4096
      sticky = true
    }

    service {
      name     = "docker-registry"
      port     = "http"
      provider = "nomad"
      check {
        name     = "registry-v2"
        type     = "http"
        path     = "/v2/"
        interval = "15s"
        timeout  = "3s"
      }
    }

    task "registry" {
      driver = "docker"
      config {
        image   = "registry:2"
        ports   = ["http"]
        volumes = ["local/registry:/var/lib/registry"]
      }

      env {
        REGISTRY_STORAGE_DELETE_ENABLED = "true"
        # Optional Docker Hub pull-through cache:
        # REGISTRY_PROXY_REMOTEURL = "https://registry-1.docker.io"
      }

      resources {
        cpu    = 150
        memory = 256
      }
    }
  }
}
`,
  },
  {
    id: 'raw_exec',
    label: 'Shell 守护脚本',
    labelEn: 'Shell Daemon Script',
    tags: ['raw_exec', '轻量'],
    tagsEn: ['raw_exec', 'Lightweight'],
    desc: '无需 Docker，直接在节点运行轻量脚本（需先在节点插件配置中开启 raw_exec 驱动）',
    descEn: 'Runs a lightweight script directly on the host without Docker (requires raw_exec enabled on the Client node)',
    requires: [
      { kind: 'driver', label: '需开启 raw_exec 驱动', labelEn: 'Requires raw_exec Driver' },
    ],
    hcl: `job "shell-daemon" {
  datacenters = ["dc1"]
  type        = "service"

  group "app" {
    count = 1
    task "echo" {
      driver = "raw_exec"
      config {
        command = "/bin/sh"
        args    = ["-c", "while true; do echo 'NomadDeck shell-daemon at '$(date); sleep 15; done"]
      }
      resources {
        cpu    = 50
        memory = 64
      }
    }
  }
}
`,
  },
  {
    id: 'batch',
    label: '一次性批处理任务',
    labelEn: 'One-Shot Batch Task',
    tags: ['batch', 'raw_exec'],
    tagsEn: ['batch', 'raw_exec'],
    desc: '执行完即退出的短任务示例，可搭配定时周期调度（需开启 raw_exec 驱动）',
    descEn: 'Short-lived batch job example that exits upon completion, pairable with periodic scheduling (requires raw_exec)',
    requires: [
      { kind: 'driver', label: '需开启 raw_exec 驱动', labelEn: 'Requires raw_exec Driver' },
    ],
    hcl: `job "batch-task" {
  datacenters = ["dc1"]
  type        = "batch"

  group "job" {
    count = 1
    task "run" {
      driver = "raw_exec"
      config {
        command = "/bin/sh"
        args    = ["-c", "echo 'Batch task finished on '$(hostname); uname -a"]
      }
      resources {
        cpu    = 50
        memory = 32
      }
    }
  }
}
`,
  },
];
