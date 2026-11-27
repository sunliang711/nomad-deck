export interface JobBlueprint {
  id: string;
  label: string;
  tags: string[];
  desc: string;
  hcl: string;
}

export const STARTER_SAMPLES: JobBlueprint[] = [
  {
    id: 'docker',
    label: 'Nginx 容器服务',
    tags: ['Docker', '入门'],
    desc: '标准 Docker Web 容器示例，无需额外前置配置即可在 Nomad Client 运行',
    hcl: `job "hello" {
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
    tags: ['Docker', '网关'],
    desc: '轻量级 Web 服务器与自动 HTTPS 反向代理，内置 Caddyfile 模板并暴露 80 / 443 端口',
    hcl: `job "caddy" {
  datacenters = ["dc1"]
  type        = "service"

  group "proxy" {
    count = 1
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
        data        = <<EOT
# 将 :80 替换为你的域名即可自动签发 HTTPS 证书，例如 example.com { reverse_proxy 10.0.0.10:8080 }
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
    tags: ['Docker', '网关'],
    desc: '云原生边缘路由与反向代理网关，含 80 业务入口、8080 管理面板与动态路由模板',
    hcl: `job "traefik" {
  datacenters = ["dc1"]
  type        = "service"

  group "gateway" {
    count = 1
    network {
      port "web" {
        static = 80
        to     = 80
      }
      port "admin" {
        static = 8080
        to     = 8080
      }
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
        ports   = ["web", "admin"]
        volumes = [
          "local/traefik.yml:/etc/traefik/traefik.yml",
          "local/dynamic.yml:/etc/traefik/dynamic.yml",
        ]
      }

      template {
        destination = "local/traefik.yml"
        change_mode = "restart"
        data        = <<EOT
entryPoints:
  web:
    address: ":80"
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
  # 若需自动发现 Nomad 服务，可启用以下配置并填写 Nomad API 地址：
  # nomad:
  #   endpoint:
  #     address: "http://127.0.0.1:4646"
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
    id: 'postgres',
    label: 'PostgreSQL + Vault 密钥',
    tags: ['Docker', 'Vault', '数据库'],
    desc: '需先配置 postgres Role 与 secret/apps/postgres（username、password、database），自动挂载 0600 密码文件与环境变量',
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
    tags: ['Docker', 'Vault', '数据库'],
    desc: '需先配置 mysql Role 与 secret/apps/mysql（root_password、username、password、database），自动注入 0600 密码文件',
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
    tags: ['Docker', 'Vault', '缓存'],
    desc: '需先配置 redis Role 与 secret/apps/redis（含 password 字段），通过 0600 内存密码文件安全注入 requirepass',
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
    tags: ['Docker', 'Vault', '消息队列'],
    desc: '需先配置 rabbitmq Role 与 secret/apps/rabbitmq（username、password），含 AMQP (5672) 与 Web 管理面板 (15672)',
    hcl: `job "rabbitmq" {
  datacenters = ["dc1"]
  type        = "service"

  group "mq" {
    count = 1
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
    tags: ['Docker', '消息队列'],
    desc: '同 Group 协同运行 NameServer (9876) 与 Broker (10911)，内建 broker.conf 模板与持久化存储目录',
    hcl: `job "rocketmq" {
  datacenters = ["dc1"]
  type        = "service"

  group "rocketmq" {
    count = 1
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
    tags: ['Docker', '监控'],
    desc: '时序指标采集与告警引擎，内置 prometheus.yml 模板（含 Nomad Telemetry 抓取示例）与 9090 端口',
    hcl: `job "prometheus" {
  datacenters = ["dc1"]
  type        = "service"

  group "monitoring" {
    count = 1
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

  # 若需采集 Nomad 集群指标，请取消注释并替换为实际节点地址（需在 Nomad 开启 telemetry.prometheus_metrics）：
  # - job_name: "nomad"
  #   metrics_path: "/v1/metrics"
  #   params:
  #     format: ["prometheus"]
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
    tags: ['Docker', 'Vault', '监控'],
    desc: '需先配置 grafana Role 与 secret/apps/grafana（admin_user、admin_password），可配合系统设置中的 Grafana 跳转链接使用',
    hcl: `job "grafana" {
  datacenters = ["dc1"]
  type        = "service"

  group "dashboard" {
    count = 1
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
    tags: ['Docker', '镜像库'],
    desc: '私有容器镜像仓库与内网镜像缓存（5000 端口），支持删除镜像及切换为 Pull-through Cache',
    hcl: `job "docker-registry" {
  datacenters = ["dc1"]
  type        = "service"

  group "registry" {
    count = 1
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
    tags: ['raw_exec', '轻量'],
    desc: '无需 Docker，直接在节点运行轻量脚本（需先在节点插件配置中开启 raw_exec 驱动）',
    hcl: `job "hello-shell" {
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
    tags: ['batch', 'raw_exec'],
    desc: '执行完即退出的短任务示例，可搭配定时周期调度（需开启 raw_exec 驱动）',
    hcl: `job "hello-batch" {
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
