#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  FB Live Streamer — VPS Installation Script
#  Tested on: Ubuntu 20.04 / 22.04 / 24.04, Debian 11/12
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
IFS=$'\n\t'

# ── Colours ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLUE}[*]${NC} $*"; }
success() { echo -e "${GREEN}[✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
die()     { echo -e "${RED}[✗] $*${NC}" >&2; exit 1; }

# ── Detect install directory ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$SCRIPT_DIR}"

echo ""
echo -e "${BOLD}══════════════════════════════════════════════════${NC}"
echo -e "${BOLD}       FB Live Streamer — Installation             ${NC}"
echo -e "${BOLD}══════════════════════════════════════════════════${NC}"
echo ""
info "Install directory: $INSTALL_DIR"

# ── Check we're on a Debian/Ubuntu system ─────────────────────────────────────
if ! command -v apt-get &>/dev/null; then
  warn "apt-get not found.  This script targets Ubuntu/Debian."
  warn "On other distros install: node >= 18, npm, ffmpeg, ffprobe manually."
fi

# ── Root check for apt installs ────────────────────────────────────────────────
SUDO=""
if [[ $EUID -ne 0 ]]; then
  SUDO="sudo"
  info "Running as non-root; will use sudo where needed."
fi

# ── Install FFmpeg ─────────────────────────────────────────────────────────────
if command -v ffmpeg &>/dev/null; then
  FFMPEG_VER=$(ffmpeg -version 2>&1 | head -1)
  success "FFmpeg already installed: $FFMPEG_VER"
else
  info "Installing FFmpeg…"
  $SUDO apt-get update -qq
  $SUDO apt-get install -y ffmpeg
  success "FFmpeg installed: $(ffmpeg -version 2>&1 | head -1)"
fi

if ! command -v ffprobe &>/dev/null; then
  die "ffprobe not found — install ffmpeg package which includes ffprobe."
fi

# ── Install Node.js (via NodeSource) ──────────────────────────────────────────
NODE_REQUIRED=18
if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
  if [[ $NODE_VER -ge $NODE_REQUIRED ]]; then
    success "Node.js already installed: $(node --version)"
  else
    warn "Node.js $(node --version) is below required v${NODE_REQUIRED}."
    info "Upgrading Node.js via NodeSource…"
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
    success "Node.js upgraded: $(node --version)"
  fi
else
  info "Installing Node.js v20 LTS via NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
  success "Node.js installed: $(node --version)"
fi

# ── Install npm dependencies ───────────────────────────────────────────────────
info "Installing npm dependencies…"
cd "$INSTALL_DIR"
npm install --omit=dev --no-audit --no-fund
success "npm packages installed."

# ── Create data directory ──────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR/data"
success "Data directory ready."

# ── Detect service user ────────────────────────────────────────────────────────
SERVICE_USER="${SUDO_USER:-$(whoami)}"
[[ "$SERVICE_USER" == "root" ]] && SERVICE_USER="root"
info "Service will run as user: $SERVICE_USER"

# ── Write systemd unit ────────────────────────────────────────────────────────
SERVICE_FILE="/etc/systemd/system/fb-streamer.service"
info "Writing systemd unit to $SERVICE_FILE…"

$SUDO tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=FB Live Streamer — Facebook RTMP streaming daemon
Documentation=https://github.com/your-repo/fb-live-streamer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v node) $INSTALL_DIR/server.js
Restart=always
RestartSec=5
StartLimitInterval=60
StartLimitBurst=10

# Environment
Environment=NODE_ENV=production
Environment=PORT=3000

# Resource limits (adjust to taste)
LimitNOFILE=65536
LimitNPROC=4096

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=fb-streamer

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable fb-streamer
success "Systemd unit installed and enabled."

# ── Firewall hint ─────────────────────────────────────────────────────────────
if command -v ufw &>/dev/null; then
  if $SUDO ufw status | grep -q "Status: active"; then
    warn "ufw is active. If you need external access to the dashboard, run:"
    warn "  sudo ufw allow 3000/tcp"
  fi
fi

# ── Start service? ─────────────────────────────────────────────────────────────
echo ""
read -r -p "$(echo -e "${BOLD}Start the service now? [Y/n]: ${NC}")" REPLY
REPLY=${REPLY:-Y}
if [[ "$REPLY" =~ ^[Yy]$ ]]; then
  $SUDO systemctl start fb-streamer
  sleep 2
  if $SUDO systemctl is-active --quiet fb-streamer; then
    success "Service started successfully."
    # Try to detect the VPS IP
    VPS_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    echo ""
    echo -e "${BOLD}${GREEN}════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}${GREEN}  Dashboard:  http://${VPS_IP:-localhost}:3000   ${NC}"
    echo -e "${BOLD}${GREEN}════════════════════════════════════════════════${NC}"
  else
    warn "Service may have failed to start. Check logs:"
    warn "  journalctl -u fb-streamer -n 50 --no-pager"
  fi
else
  info "Start manually:   sudo systemctl start fb-streamer"
  info "Watch logs:       journalctl -fu fb-streamer"
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
info "Useful commands:"
echo "  sudo systemctl start|stop|restart|status fb-streamer"
echo "  journalctl -fu fb-streamer          # live logs"
echo "  sudo systemctl disable fb-streamer  # remove auto-start"
echo ""
success "Installation complete!"
