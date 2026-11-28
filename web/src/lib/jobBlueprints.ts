import type { Locale } from './locale.ts';

export interface JobBlueprint {
  id: string;
  label: string;
  labelEn?: string;
  tags: string[];
  tagsEn?: string[];
  desc: string;
  descEn?: string;
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

export const STARTER_SAMPLES: JobBlueprint[] = [
  {
    id: 'docker',
    label: 'Nginx 容器服务',
    labelEn: 'Nginx Container Service',
    tags: ['Docker', '入门'],
    tagsEn: ['Docker', 'Starter'],
    desc: '标准 Docker Web 容器示例，无需额外前置配置即可在 Nomad Client 运行',
    descEn: 'Standard Docker web container example ready to run on any Docker-enabled Nomad Client',
    hcl: `job "hello" {
  # 前置依赖：Nomad Client 节点已安装并启用 docker 驱动。
  datacenters = ["dc1"]
  type        = "service"

  group "app" {
    count = 1
    task "server" {
      driver = "docker"
      config {
        image = "nginx:alpine"
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
    hcl: `job "caddy" {
  # 前置依赖：
  # 1. Nomad Client 节点已启用 docker 驱动，且宿主端口 80 / 443 未被占用（需防火墙放行）。
  # 2. 若启用反向代理示例中的 nomadService，需确保目标后端服务已在 Nomad 注册同名 service。
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

    # 生产环境建议将 local/caddy-data 替换为 Host Volume 持久化证书，防止重调度丢失 ACME 凭据。
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
        data        = <<EOT
# 用真实域名替换 :80 即可自动签发 HTTPS；反向代理可用 nomadService 自动发现后端地址：
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
    hcl: `job "traefik" {
  # 前置依赖：
  # 1. Nomad Client 节点已启用 docker 驱动，且宿主端口 80 / 443 / 8080 未被占用。
  # 2. 若启用 providers.nomad 或 ACME DNS-01：
  #    - 获取 Nomad 只读 Token：到「Nomad 集群 → 治理 (Namespace / Pool / ACL) → ACL Policies」新建 Policy（如 traefik-readonly，规则：namespace "*" { policy = "read" } 与 node { policy = "read" }），再到「ACL Tokens & Roles」点「签发 Client Token」关联该 Policy 并复制 Secret ID。
  #    - 写入 Vault 密钥：到「Vault 集群 → Auth / Policy / KV → 应用密钥 · KV v2」在 secret/apps/traefik 写入 nomad_token（即上一步 Secret ID）、ali_key、ali_secret。
  #    - 创建联动 Role：到「集群联动 → Role 与 Policy」新建 Role "traefik"（Policy 模式：explicit，路径：secret/apps/traefik）并点击「应用联动」；同时按需挂载 Nomad CA（/opt/nomad-deck/nomad/etc/nomad.d/tls/ca.pem）。
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

    # 生产环境建议将 local/acme 替换为 Host Volume 持久化 acme.json，避免重启重复签发触及限流。
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
          # 启用 providers.nomad 时如需严格校验 Nomad TLS，可取消下方注释挂载 Nomad 节点 CA：
          # "/opt/nomad-deck/nomad/etc/nomad.d/tls/ca.pem:/etc/ssl/nomad-ca.pem:ro",
        ]
      }

      # 如需从 Vault 注入 Nomad 只读 Token 与阿里云 DNS AK/SK，请先完成：
      # - Nomad 只读 Token：在「Nomad 集群 → 治理 → ACL Policies」建只读 Policy（namespace "*" { policy = "read" } + node { policy = "read" }），再到「ACL Tokens & Roles → 签发 Client Token」生成并复制 Secret ID
      # - Vault 密钥（Vault 集群 → KV v2）：在 secret/apps/traefik 写入 nomad_token、ali_key、ali_secret
      # - 联动 Role（集群联动 → Role 与 Policy）：新建 Role "traefik"（explicit 模式，路径 secret/apps/traefik）并点击「应用联动」
      # 完成后取消下方 vault / template 注释：
      # vault {
      #   role = "traefik"
      #   env  = false
      # }
      #
      # template {
      #   destination = "secrets/traefik.env"
      #   env         = true
      #   change_mode = "restart"
      #   data        = <<EOT
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
        data        = <<EOT
entryPoints:
  web:
    address: ":80"
    # 开启全站 HTTP 自动跳转 HTTPS 时取消下方注释：
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
  # 开启 Nomad 服务自动发现（配合可视化编排中的 Traefik 路由标签与只读 NOMAD_TOKEN）：
  # 注意：默认 bridge 容器内 127.0.0.1 指容器自身，请替换为 Nomad 节点内网 IP（如 https://10.0.0.10:4646）：
  # nomad:
  #   exposedByDefault: false
  #   endpoint:
  #     address: "https://10.0.0.10:4646"
  #     tls:
  #       ca: /etc/ssl/nomad-ca.pem
  #       # 若未挂载 Nomad CA，可改用 insecureSkipVerify: true

# 开启阿里云 DNS-01 自动申请通配符证书（需注入 ALICLOUD_ACCESS_KEY / ALICLOUD_SECRET_KEY）：
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
        data        = <<EOT
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
    hcl: `job "nginx-gateway" {
  # 前置依赖：
  # 1. Nomad Client 节点已启用 docker 驱动，且宿主端口 80 / 443 未被占用。
  # 2. 若启用 HTTPS（443）：需先到「集群联动 → Role 与 Policy」创建 Role "nginx-gateway"（Policy 模式：explicit，路径：secret/certs/tls）并「应用联动」，并由 acme-cert-sync（或手动在「Vault 集群 → KV v2」）在 secret/certs/tls 写入 fullchain 与 privkey。
  # 3. 若启用动态上游 upstream：需有已在 Nomad 注册同名 service 的后端任务。
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

      # 搭配 acme-cert-sync 使用 HTTPS：
      # - 联动 Role："nginx-gateway"，Policy 模式：explicit，允许路径：secret/certs/tls（需点击「应用联动」）
      # - Vault 密钥（secret/certs/tls）：fullchain、privkey（可由 acme-cert-sync 自动推送）
      # 准备好后取消下方注释并启用 443 server 块：
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
      #   data          = <<EOT
      # {{ with secret "secret/data/certs/tls" }}{{ .Data.data.fullchain }}{{ end }}
      # EOT
      # }
      #
      # template {
      #   destination   = "secrets/cert.key"
      #   perms         = "0600"
      #   change_mode   = "signal"
      #   change_signal = "SIGHUP"
      #   data          = <<EOT
      # {{ with secret "secret/data/certs/tls" }}{{ .Data.data.privkey }}{{ end }}
      # EOT
      # }

      template {
        destination   = "local/nginx.conf"
        change_mode   = "signal"
        change_signal = "SIGHUP"
        data          = <<EOT
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

  # 通过 nomadService 自动发现后端（按需将 "app" 替换为你的服务名）：
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

    # 开启 Vault 证书后可改为 301 跳转 HTTPS：
    # location / { return 301 https://$host$request_uri; }
    location / {
      return 200 "NomadDeck Nginx Gateway ready\n";
    }
  }

  # 启用 Vault 证书热加载后取消下方注释：
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
    hcl: `job "openresty-gateway" {
  # 前置依赖：
  # 1. Nomad Client 节点已启用 docker 驱动，且宿主端口 80 / 443 未被占用。
  # 2. 若启用 HTTPS（443）：需先到「集群联动 → Role 与 Policy」创建 Role "openresty-gateway"（Policy 模式：explicit，路径：secret/certs/tls）并「应用联动」，并由 acme-cert-sync（或手动在「Vault 集群 → KV v2」）在 secret/certs/tls 写入 fullchain 与 privkey。
  # 3. 若启用动态上游 upstream：需有已在 Nomad 注册同名 service 的后端任务。
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

      # 搭配 acme-cert-sync 使用 HTTPS：
      # - 联动 Role："openresty-gateway"，Policy 模式：explicit，允许路径：secret/certs/tls（需点击「应用联动」）
      # - Vault 密钥（secret/certs/tls）：fullchain、privkey（可由 acme-cert-sync 自动推送）
      # 准备好后取消下方注释并启用 443 server 块：
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
      #   data          = <<EOT
      # {{ with secret "secret/data/certs/tls" }}{{ .Data.data.fullchain }}{{ end }}
      # EOT
      # }
      #
      # template {
      #   destination   = "secrets/cert.key"
      #   perms         = "0600"
      #   change_mode   = "signal"
      #   change_signal = "SIGHUP"
      #   data          = <<EOT
      # {{ with secret "secret/data/certs/tls" }}{{ .Data.data.privkey }}{{ end }}
      # EOT
      # }

      template {
        destination   = "local/ban-rules.conf"
        change_mode   = "signal"
        change_signal = "SIGHUP"
        data          = <<EOT
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
        data          = <<EOT
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
        data          = <<EOT
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

  # 通过 nomadService 自动发现后端（按需将 "app" 替换为你的服务名）：
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

  # 启用 Vault 证书热加载后取消下方注释：
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
    desc: '需先创建 acme-cert-sync Role（读取 secret/certs/dns 并写入 secret/certs/tls），定时续期通配符证书并推送 Vault KV 触发网关 SIGHUP 热加载',
    descEn: 'Requires acme-cert-sync Role (read secret/certs/dns & write secret/certs/tls); renews wildcard certs on schedule and pushes to Vault KV for gateway SIGHUP reload',
    hcl: `job "acme-cert-sync" {
  # 前置依赖：
  # 1. Nomad Client 节点已启用 docker 驱动，容器可访问外网 Alpine APK 源、ACME CA（Let's Encrypt 等）与 DNS 服务商 API。
  # 2. 已完成 Nomad-Vault 联动（应用联动后控制面会自动下发 /opt/nomad-deck/nomad/etc/nomad.d/tls/vault-ca.crt 到 Nomad 节点；若使用非 TLS 测试 Vault 请移除对应挂载或设 vault_skip_verify = "true"）。
  # 3. 联动 Role 与自定义 Policy HCL（因需回写证书到 secret/certs/tls，须在「集群联动 → Role 与 Policy」新建 Role "acme-cert-sync" 并在高级选项填写下方自定义 Policy，再点击「应用联动」）：
  #      path "secret/data/certs/dns" {
  #        capabilities = ["read"]
  #      }
  #      path "secret/data/certs/tls" {
  #        capabilities = ["create", "update", "read"]
  #      }
  #      path "secret/metadata/certs/*" {
  #        capabilities = ["read", "list"]
  #      }
  # 4. 在「Vault 集群 → Auth / Policy / KV → 应用密钥 · KV v2」的 secret/certs/dns 预先写入字段：
  #    - 必填：domain（如 *.example.com）、vault_addr（可在「Vault 集群 → 集群状态详情」查看，如 https://10.0.0.10:8200）
  #    - DNS 鉴权（按 dns_provider 填写，默认 dns_ali）：ali_key、ali_secret
  #    - 可选：alt_domains、dns_provider、acme_ca（默认 letsencrypt）、acme_email、vault_kv_path（默认 secret/data/certs/tls）、vault_skip_verify、vault_cacert
  datacenters = ["dc1"]
  type        = "batch"

  periodic {
    crons            = ["0 2 * * *"]
    prohibit_overlap = true
    time_zone        = "Asia/Shanghai"
  }

  group "acme" {
    count = 1

    # 建议将 /acme.sh 挂载到 Host Volume（如 acme_state），避免每次重调度重新向 CA 申请证书。
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
          # 联动后控制面已自动将 Vault CA 分发到 Nomad 节点此路径；如使用非 TLS 测试 Vault 请移除此行
          "/opt/nomad-deck/nomad/etc/nomad.d/tls/vault-ca.crt:/etc/ssl/vault-ca.crt:ro",
        ]
      }

      # 需读 secret/data/certs/dns 并写 secret/data/certs/tls（详见文件顶部自定义 Policy HCL 说明）
      vault {
        role = "acme-cert-sync"
        env  = true
      }

      template {
        destination = "secrets/acme.env"
        env         = true
        change_mode = "noop"
        data        = <<EOT
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

      # 默认已挂载 Nomad 节点下发的 /etc/ssl/vault-ca.crt；若需覆写 CA，也可在 secret/data/certs/dns 填入 vault_cacert。
      template {
        destination = "secrets/vault-ca.crt"
        perms       = "0644"
        change_mode = "noop"
        data        = <<EOT
{{ with secret "secret/data/certs/dns" }}{{ or .Data.data.vault_cacert "" }}{{ end }}
EOT
      }

      template {
        destination = "local/sync.sh"
        perms       = "0755"
        change_mode = "noop"
        data        = <<EOT
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
  # acme.sh 返回码 2 表示证书尚未到期无需续期
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
    desc: '需先配置 postgres Role 与 secret/apps/postgres（username、password、database），自动挂载 0600 密码文件与环境变量',
    descEn: 'Requires postgres Role & secret/apps/postgres (username, password, database); mounts 0600 secret file & env',
    hcl: `job "postgres" {
  # 前置依赖：
  # 1. Nomad Client 节点已启用 docker 驱动，且宿主端口 5432 未被占用。
  # 2. 在「集群联动 → Role 与 Policy」创建 Role "postgres"（Policy 模式：explicit，路径：secret/apps/postgres）并「应用联动」。
  # 3. 在「Vault 集群 → Auth / Policy / KV → 应用密钥 · KV v2」的 secret/apps/postgres 写入字段：username、password、database。
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

    # 数据保留在当前 Allocation，重新调度前需配置持久卷与备份。
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

      # 依赖 Role "postgres"（explicit 只读 secret/apps/postgres）
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
        data        = <<EOT
{{ with secret "secret/data/apps/postgres" }}{{ .Data.data.password }}{{ end }}
EOT
      }

      template {
        destination = "secrets/postgres.env"
        env         = true
        data        = <<EOT
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
    desc: '需先配置 mysql Role 与 secret/apps/mysql（root_password、username、password、database），自动注入 0600 密码文件',
    descEn: 'Requires mysql Role & secret/apps/mysql (root_password, username, password, database); injects 0600 password files',
    hcl: `job "mysql" {
  # 前置依赖：
  # 1. Nomad Client 节点已启用 docker 驱动，且宿主端口 3306 未被占用。
  # 2. 在「集群联动 → Role 与 Policy」创建 Role "mysql"（Policy 模式：explicit，路径：secret/apps/mysql）并「应用联动」。
  # 3. 在「Vault 集群 → Auth / Policy / KV → 应用密钥 · KV v2」的 secret/apps/mysql 写入字段：root_password、username、password、database。
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

    # 数据保留在当前 Allocation，生产环境建议改用 Host Volume 或 CSI 持久卷。
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

      # 依赖 Role "mysql"（explicit 只读 secret/apps/mysql）
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
        data        = <<EOT
{{ with secret "secret/data/apps/mysql" }}{{ .Data.data.root_password }}{{ end }}
EOT
      }

      template {
        destination = "secrets/mysql-password"
        perms       = "0600"
        change_mode = "noop"
        data        = <<EOT
{{ with secret "secret/data/apps/mysql" }}{{ .Data.data.password }}{{ end }}
EOT
      }

      template {
        destination = "secrets/mysql.env"
        env         = true
        data        = <<EOT
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
    desc: '需先配置 redis Role 与 secret/apps/redis（含 password 字段），通过 0600 内存密码文件安全注入 requirepass',
    descEn: 'Requires redis Role & secret/apps/redis (password field); injects requirepass safely from a 0600 tmpfs file',
    hcl: `job "redis" {
  # 前置依赖：
  # 1. Nomad Client 节点已启用 docker 驱动，且宿主端口 6379 未被占用。
  # 2. 在「集群联动 → Role 与 Policy」创建 Role "redis"（Policy 模式：explicit，路径：secret/apps/redis）并「应用联动」。
  # 3. 在「Vault 集群 → Auth / Policy / KV → 应用密钥 · KV v2」的 secret/apps/redis 写入字段：password。
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

      # 依赖 Role "redis"（explicit 只读 secret/apps/redis）
      vault {
        role = "redis"
        env  = false
      }

      template {
        destination = "secrets/redis-password"
        perms       = "0600"
        change_mode = "restart"
        data        = <<EOT
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
    desc: '需先配置 rabbitmq Role 与 secret/apps/rabbitmq（username、password），含 AMQP (5672) 与 Web 管理面板 (15672)',
    descEn: 'Requires rabbitmq Role & secret/apps/rabbitmq (username, password); exposes AMQP (5672) and Web UI (15672)',
    hcl: `job "rabbitmq" {
  # 前置依赖：
  # 1. Nomad Client 节点已启用 docker 驱动，且宿主端口 5672（AMQP）/ 15672（Web 控制台）未被占用。
  # 2. 在「集群联动 → Role 与 Policy」创建 Role "rabbitmq"（Policy 模式：explicit，路径：secret/apps/rabbitmq）并「应用联动」。
  # 3. 在「Vault 集群 → Auth / Policy / KV → 应用密钥 · KV v2」的 secret/apps/rabbitmq 写入字段：username、password。
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

      # 依赖 Role "rabbitmq"（explicit 只读 secret/apps/rabbitmq）
      vault {
        role = "rabbitmq"
        env  = false
      }

      template {
        destination = "secrets/rabbitmq.env"
        env         = true
        change_mode = "restart"
        data        = <<EOT
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
    hcl: `job "rocketmq" {
  # 前置依赖：
  # 1. Nomad Client 节点已启用 docker 驱动，且宿主端口 9876 / 10909 / 10911 / 10912 未被占用。
  # 2. 同 Group 两个 Task 共需至少 500 MHz CPU 与 1152 MiB 内存；brokerIP1 使用 NOMAD_IP_broker，需确保生产者/消费者可直连该节点 IP。
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
        data        = <<EOT
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
    hcl: `job "prometheus" {
  # 前置依赖：
  # 1. Nomad Client 节点已启用 docker 驱动，且宿主端口 9090 未被占用。
  # 2. 若启用下方 Nomad 指标抓取：
  #    - 到「Nomad 集群 → 集群配置 → 运行指标采集」勾选「暴露 Prometheus 指标 (prometheus_metrics)」并保存。
  #    - 若 Nomad 启用了 ACL：到「Nomad 集群 → 治理 (Namespace / Pool / ACL) → ACL Policies」新建含 agent { policy = "read" } 的 Policy，再到「ACL Tokens & Roles」点「签发 Client Token」复制 Secret ID 填入下方 bearer_token。
  #    - 若 Nomad 启用了 TLS：挂载节点 CA（/opt/nomad-deck/nomad/etc/nomad.d/tls/ca.pem:/etc/ssl/nomad-ca.pem:ro）并在下方配置 scheme: https 与 tls_config.ca_file。
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
        data          = <<EOT
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: "prometheus"
    static_configs:
      - targets: ["localhost:9090"]

  # 若需采集 Nomad 集群指标，请取消注释并替换为实际节点地址（需在「Nomad 集群 → 集群配置」开启 prometheus_metrics）：
  # - job_name: "nomad"
  #   metrics_path: "/v1/metrics"
  #   params:
  #     format: ["prometheus"]
  #   # 若 Nomad 启用了 TLS 与 ACL，按需取消下方注释并挂载 /opt/nomad-deck/nomad/etc/nomad.d/tls/ca.pem：
  #   # scheme: https
  #   # tls_config:
  #   #   ca_file: /etc/ssl/nomad-ca.pem
  #   # bearer_token: "<在 Nomad 集群 → 治理 → 签发 Client Token（关联 agent read Policy）获取>"
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
    desc: '需先配置 grafana Role 与 secret/apps/grafana（admin_user、admin_password），可配合系统设置中的 Grafana 跳转链接使用',
    descEn: 'Requires grafana Role & secret/apps/grafana (admin_user, admin_password); pairs with System Settings Grafana URL',
    hcl: `job "grafana" {
  # 前置依赖：
  # 1. Nomad Client 节点已启用 docker 驱动，且宿主端口 3000 未被占用。
  # 2. 在「集群联动 → Role 与 Policy」创建 Role "grafana"（Policy 模式：explicit，路径：secret/apps/grafana）并「应用联动」。
  # 3. 在「Vault 集群 → Auth / Policy / KV → 应用密钥 · KV v2」的 secret/apps/grafana 写入字段：admin_user、admin_password（可选在「系统设置 → 集群与快照 → Grafana 跳转链接模板」填入地址便于快捷跳转）。
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

      # 依赖 Role "grafana"（explicit 只读 secret/apps/grafana）
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
        data        = <<EOT
{{ with secret "secret/data/apps/grafana" }}{{ .Data.data.admin_password }}{{ end }}
EOT
      }

      template {
        destination = "secrets/grafana.env"
        env         = true
        data        = <<EOT
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
    hcl: `job "docker-registry" {
  # 前置依赖：
  # 1. Nomad Client 节点已启用 docker 驱动，且宿主端口 5000 未被占用。
  # 2. 若客户端节点通过 HTTP（非 HTTPS）直接推拉镜像，需在「Docker 引擎 → 宿主机矩阵 / 集群策略与滚动升级」为 daemon.json 配置 insecure-registries，或前方配合网关挂 HTTPS。
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

    # 生产环境建议将 local/registry 替换为 Host Volume 或 CSI 持久卷。
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
        # 若用作 Docker Hub 拉取缓存代理，可取消下方注释：
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
    hcl: `job "hello-shell" {
  # 前置依赖：需到「Nomad 集群 → 集群配置 → 任务驱动插件」开启「启用 raw_exec」（默认关闭，未开启会卡在 Pending）。
  datacenters = ["dc1"]
  type        = "service"

  group "app" {
    count = 1
    task "echo" {
      driver = "raw_exec"
      config {
        command = "/bin/sh"
        args    = ["-c", "while true; do echo 'NomadDeck hello at '$(date); sleep 15; done"]
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
    hcl: `job "hello-batch" {
  # 前置依赖：需到「Nomad 集群 → 集群配置 → 任务驱动插件」开启「启用 raw_exec」（默认关闭，未开启会卡在 Pending）。
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
