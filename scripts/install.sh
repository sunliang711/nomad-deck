#!/usr/bin/env bash
set -euo pipefail

REPO="${NOMAD_DECK_REPO:-sunliang711/nomad-deck}"
VERSION="${NOMAD_DECK_VERSION:-latest}"
LISTEN_ADDR="${NOMAD_DECK_LISTEN:-}"
UNINSTALL=0
REPAIR_SERVICE=0

INSTALL_ROOT="/opt/nomad-deck-control"
BIN_DIR="${INSTALL_ROOT}/bin"
VERSIONS_DIR="${BIN_DIR}/versions"
ETC_DIR="${INSTALL_ROOT}/etc"
DATA_DIR="${INSTALL_ROOT}/data"
CONFIG_FILE="${ETC_DIR}/nomad-deck.toml"
SERVICE_USER="nomad-deck"
SYSTEMD_DIR="/etc/systemd/system"

log()  { printf '[nomad-deck] %s\n' "$*"; }
warn() { printf '[nomad-deck] 警告: %s\n' "$*" >&2; }
die()  { printf '[nomad-deck] 错误: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
NomadDeck Linux systemd 一键安装/升级/卸载脚本

用法:
  install.sh [选项]

选项:
  --version <tag>   指定安装版本（例如 v0.1.0），默认 latest
  --repo <repo>     指定 GitHub 仓库（默认 sunliang711/nomad-deck）
  --listen <addr>   首次生成配置时写入监听地址（默认 0.0.0.0:8555）
  --uninstall       卸载 NomadDeck systemd 服务与程序文件（保留配置与数据）
  --repair-service  修复已有 systemd 单元并重启（保留程序、配置与数据）
  -h, --help        显示帮助
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version 需要参数"
      VERSION="$2"
      shift 2
      ;;
    --repo)
      [ "$#" -ge 2 ] || die "--repo 需要参数"
      REPO="$2"
      shift 2
      ;;
    --listen)
      [ "$#" -ge 2 ] || die "--listen 需要参数"
      LISTEN_ADDR="$2"
      shift 2
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    --repair-service)
      REPAIR_SERVICE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数: $1（使用 --help 查看帮助）"
      ;;
  esac
done

check_linux_systemd() {
  local os
  os="$(uname -s)"
  [ "${os}" = "Linux" ] || die "仅支持 Linux systemd 环境（当前系统: ${os}）"
  [ "$(id -u)" -eq 0 ] || die "请使用 root 或 sudo 运行此脚本"
  command -v systemctl >/dev/null 2>&1 || die "未检测到 systemctl，仅支持 systemd 发行版"
  [ -d /run/systemd/system ] || die "当前系统未以 systemd 作为 PID 1 运行"
}

detect_arch() {
  local machine
  machine="$(uname -m)"
  case "${machine}" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) die "不支持的 CPU 架构: ${machine}（仅支持 amd64 / arm64）" ;;
  esac
}

verify_sha256() {
  local sums_file="$1"
  local archive_name="$2"
  local line
  line="$(grep -E "[[:space:]](\./)?${archive_name}$" "${sums_file}" | head -n 1 || true)"
  [ -n "${line}" ] || die "SHA256SUMS 中未找到 ${archive_name} 的校验条目"
  local expected actual
  expected="$(printf '%s\n' "${line}" | awk '{print $1}')"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "${archive_name}" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "${archive_name}" | awk '{print $1}')"
  else
    die "缺少 sha256sum 或 shasum 命令，无法校验下载包完整性"
  fi
  [ "${expected}" = "${actual}" ] || die "SHA-256 校验失败（期望 ${expected}，实际 ${actual}）"
}

resolve_tag() {
  local req="$1"
  if [ "${req}" != "latest" ] && [ -n "${req}" ]; then
    case "${req}" in
      v*) printf '%s\n' "${req}" ;;
      *)  printf 'v%s\n' "${req}" ;;
    esac
    return 0
  fi

  local effective tag
  effective="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest" || true)"
  tag="${effective##*/}"
  if [ -z "${tag}" ] || [ "${tag}" = "latest" ] || [ "${tag}" = "releases" ]; then
    tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
      | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 || true)"
  fi
  [ -n "${tag}" ] || die "无法获取 ${REPO} 的最新 Release 版本，请确认仓库已发布 GitHub Release 或使用 --version 指定标签"
  printf '%s\n' "${tag}"
}

ensure_service_user() {
  if ! getent group "${SERVICE_USER}" >/dev/null 2>&1; then
    groupadd --system "${SERVICE_USER}"
  fi
  if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    local nologin="/usr/sbin/nologin"
    [ -x "${nologin}" ] || nologin="/sbin/nologin"
    [ -x "${nologin}" ] || nologin="/bin/false"
    useradd --system --gid "${SERVICE_USER}" --home-dir "${INSTALL_ROOT}" --shell "${nologin}" "${SERVICE_USER}"
  fi
}

write_default_config() {
  cat > "${CONFIG_FILE}" <<'EOF'
# NomadDeck 控制面配置文件
# 默认路径：/opt/nomad-deck-control/etc/nomad-deck.toml

data_dir = "/opt/nomad-deck-control/data"
listen = "0.0.0.0:8555"

[server]
# 反向代理或外部访问控制面时的完整 Origin，用于 Origin/CSRF 校验。
# public_url = "https://deck.example.com"

[tls]
# 可选值：auto（首次启动自动生成自签名 ECDSA 证书）/ file / proxy
mode = "auto"

[log]
level = "info"
format = "text"
EOF
}

write_default_service_unit() {
  cat > "${SYSTEMD_DIR}/nomad-deck.service" <<'EOF'
[Unit]
Description=NomadDeck Control Plane
Documentation=https://github.com/sunliang711/nomad-deck
After=network-online.target
Wants=network-online.target
OnFailure=nomad-deck-rollback.service
StartLimitIntervalSec=600
StartLimitBurst=2

[Service]
Type=notify
User=nomad-deck
Group=nomad-deck
WorkingDirectory=/opt/nomad-deck-control
ExecStart=/opt/nomad-deck-control/bin/nomad-deck serve --config /opt/nomad-deck-control/etc/nomad-deck.toml
# Type=notify runs this only after readiness; healthy restarts must not exhaust the failure budget.
ExecStartPost=+/usr/bin/systemctl reset-failed nomad-deck.service
Restart=on-failure
RestartSec=5s
# Exit 75 requests a version handover, not OnFailure rollback.
SuccessExitStatus=75
RestartForceExitStatus=75
TimeoutStartSec=180
TimeoutStopSec=30
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/nomad-deck-control

[Install]
WantedBy=multi-user.target
EOF
}

write_default_rollback_unit() {
  cat > "${SYSTEMD_DIR}/nomad-deck-rollback.service" <<'EOF'
[Unit]
Description=NomadDeck Control Plane Automatic Rollback
After=nomad-deck.service

[Service]
Type=oneshot
User=nomad-deck
Group=nomad-deck
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/nomad-deck-control
ExecCondition=/opt/nomad-deck-control/bin/nomad-deck.prev rollback --check --bin-dir /opt/nomad-deck-control/bin
ExecStart=/opt/nomad-deck-control/bin/nomad-deck.prev rollback --auto --bin-dir /opt/nomad-deck-control/bin
ExecStartPost=+/usr/bin/systemctl reset-failed nomad-deck.service
ExecStartPost=+/usr/bin/systemctl start --no-block nomad-deck.service
EOF
}

fetch_or_fallback() {
  local raw_url="$1"
  local dest="$2"
  local fallback_fn="$3"
  local tmp_file
  tmp_file="$(mktemp)"
  if curl -fsSL "${raw_url}" -o "${tmp_file}" 2>/dev/null && [ -s "${tmp_file}" ]; then
    install -m 0644 "${tmp_file}" "${dest}"
  else
    "${fallback_fn}"
    chmod 0644 "${dest}"
  fi
  rm -f "${tmp_file}"
}

do_uninstall() {
  check_linux_systemd
  log "停止并禁用 nomad-deck systemd 服务..."
  systemctl stop nomad-deck.service >/dev/null 2>&1 || true
  systemctl stop nomad-deck-rollback.service >/dev/null 2>&1 || true
  systemctl disable nomad-deck.service >/dev/null 2>&1 || true
  rm -f "${SYSTEMD_DIR}/nomad-deck.service" "${SYSTEMD_DIR}/nomad-deck-rollback.service"
  systemctl daemon-reload
  rm -rf "${BIN_DIR}"
  log "已完成服务卸载并清理 ${BIN_DIR}。"
  log "为防止误删数据，保留了配置与数据目录：${ETC_DIR}、${DATA_DIR}"
  log "如需彻底删除全部数据，请手动执行：rm -rf ${INSTALL_ROOT} && userdel ${SERVICE_USER}"
}

do_install() {
  check_linux_systemd
  command -v curl >/dev/null 2>&1 || die "缺少 curl 命令，请先安装 curl"
  command -v tar >/dev/null 2>&1 || die "缺少 tar 命令，请先安装 tar"

  local arch tag ver_no_v archive_name base_url raw_base tmpdir
  arch="$(detect_arch)"
  tag="$(resolve_tag "${VERSION}")"
  ver_no_v="${tag#v}"
  archive_name="nomad-deck_${ver_no_v}_linux_${arch}.tar.gz"
  base_url="https://github.com/${REPO}/releases/download/${tag}"
  raw_base="https://raw.githubusercontent.com/${REPO}/${tag}"

  tmpdir="$(mktemp -d)"
  trap 'rm -rf "${tmpdir:-}"' EXIT

  log "正在下载 ${REPO} ${tag} (linux/${arch})..."
  curl -fsSL "${base_url}/${archive_name}" -o "${tmpdir}/${archive_name}" \
    || die "下载发布包失败: ${base_url}/${archive_name}"
  curl -fsSL "${base_url}/SHA256SUMS" -o "${tmpdir}/SHA256SUMS" \
    || die "下载校验文件失败: ${base_url}/SHA256SUMS"

  (cd "${tmpdir}" && verify_sha256 "SHA256SUMS" "${archive_name}" && tar -xzf "${archive_name}" nomad-deck)
  [ -x "${tmpdir}/nomad-deck" ] || die "压缩包内未找到可执行文件 nomad-deck"

  ensure_service_user
  install -d -m 0755 "${INSTALL_ROOT}" "${BIN_DIR}" "${VERSIONS_DIR}" "${ETC_DIR}"
  install -d -m 0700 "${DATA_DIR}"

  local target_bin="${VERSIONS_DIR}/nomad-deck-${ver_no_v}"
  local was_active=0
  if systemctl is-active --quiet nomad-deck.service; then
    was_active=1
    if [ -L "${BIN_DIR}/nomad-deck" ]; then
      local cur_target
      cur_target="$(readlink -f "${BIN_DIR}/nomad-deck" || true)"
      if [ -n "${cur_target}" ] && [ "${cur_target}" != "${target_bin}" ] && [ -e "${cur_target}" ]; then
        ln -sfn "${cur_target}" "${BIN_DIR}/nomad-deck.prev"
      fi
    elif [ -f "${BIN_DIR}/nomad-deck" ]; then
      cp -f "${BIN_DIR}/nomad-deck" "${VERSIONS_DIR}/nomad-deck-previous"
      chmod 0755 "${VERSIONS_DIR}/nomad-deck-previous"
      ln -sfn "${VERSIONS_DIR}/nomad-deck-previous" "${BIN_DIR}/nomad-deck.prev"
    fi
    log "检测到现有服务运行中，先停止服务以更新二进制..."
    systemctl stop nomad-deck.service
  fi

  install -m 0755 "${tmpdir}/nomad-deck" "${target_bin}"
  ln -sfn "${target_bin}" "${BIN_DIR}/nomad-deck"

  if [ ! -f "${CONFIG_FILE}" ]; then
    fetch_or_fallback "${raw_base}/deploy/nomad-deck.toml.example" "${CONFIG_FILE}" write_default_config
    if [ -n "${LISTEN_ADDR}" ]; then
      sed -i.bak -E "s|^listen = .*|listen = \"${LISTEN_ADDR}\"|" "${CONFIG_FILE}" && rm -f "${CONFIG_FILE}.bak"
    fi
    log "已生成默认配置文件：${CONFIG_FILE}"
  else
    log "保留已有配置文件：${CONFIG_FILE}"
  fi

  fetch_or_fallback "${raw_base}/deploy/nomad-deck.service" "${SYSTEMD_DIR}/nomad-deck.service" write_default_service_unit
  fetch_or_fallback "${raw_base}/deploy/nomad-deck-rollback.service" "${SYSTEMD_DIR}/nomad-deck-rollback.service" write_default_rollback_unit

  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_ROOT}"
  chmod 0640 "${CONFIG_FILE}"

  systemctl daemon-reload
  systemctl enable nomad-deck.service >/dev/null
  systemctl reset-failed nomad-deck.service
  systemctl start nomad-deck.service

  if [ "${was_active}" -eq 1 ]; then
    log "NomadDeck 已升级至 ${tag} 并重启服务。"
  else
    log "NomadDeck ${tag} 安装并启动成功。"
  fi

  local host_ip
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  [ -n "${host_ip}" ] || host_ip="<服务器IP>"
  log "当前版本：$("${BIN_DIR}/nomad-deck" version 2>/dev/null || echo "${tag}")"
  log "管理台地址：https://${host_ip}:8555"
  log "首次启动初始化 Token 查看：journalctl -u nomad-deck -n 50 --no-pager"
  log "服务状态查看：systemctl status nomad-deck --no-pager"
}

# repair_service applies the bundled policy without downloading or replacing application state.
repair_service() {
  check_linux_systemd
  [ -x "${BIN_DIR}/nomad-deck" ] || die "Existing NomadDeck binary not found"
  [ -f "${CONFIG_FILE}" ] || die "Existing NomadDeck configuration not found"
  [ -f "${SYSTEMD_DIR}/nomad-deck.service" ] || die "Existing NomadDeck systemd unit not found"
  id "${SERVICE_USER}" >/dev/null 2>&1 || die "Existing NomadDeck service user not found"
  [ -x /usr/bin/systemctl ] || die "Required /usr/bin/systemctl not found"
  [ -w "${SYSTEMD_DIR}" ] || die "Systemd unit directory is not writable"

  write_default_service_unit
  write_default_rollback_unit
  systemctl daemon-reload
  systemctl reset-failed nomad-deck.service
  systemctl restart nomad-deck.service
  systemctl is-active --quiet nomad-deck.service
  log "Systemd service policy repaired; existing binary, configuration and data preserved"
}

[ "${UNINSTALL}" -eq 0 ] || [ "${REPAIR_SERVICE}" -eq 0 ] || die "--uninstall and --repair-service cannot be combined"

if [ "${REPAIR_SERVICE}" -eq 1 ]; then
  repair_service
elif [ "${UNINSTALL}" -eq 1 ]; then
  do_uninstall
else
  do_install
fi
