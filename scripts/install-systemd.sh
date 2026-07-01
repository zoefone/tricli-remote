#!/usr/bin/env bash
set -euo pipefail
ROOT="${TRICLI_ROOT:-/root/tricli-remote}"
ENV_FILE="${TRICLI_ENV_FILE:-/etc/tricli-remote.env}"
INSTALL_ENABLE=0
INSTALL_START=0
for arg in "$@"; do
  case "$arg" in
    --enable) INSTALL_ENABLE=1 ;;
    --start) INSTALL_START=1 ;;
    --help|-h)
      cat <<'USAGE'
Usage: install-systemd.sh [--enable] [--start]

Creates systemd services for TriCLI Remote. It does not enable or start services
unless flags are provided. Configure /etc/tricli-remote.env first for production.

Recommended production env:
  TRICLI_TOKEN=<long random token>
  TRICLI_SERVER_HOST=0.0.0.0
  TRICLI_SERVER_PORT=7320
  TRICLI_DAEMON_HOST=127.0.0.1
  TRICLI_DAEMON_PORT=7317
  # On controlled machines without public IP:
  # TRICLI_SERVER_URL=https://your-public-server.example
  # TRICLI_MACHINE_ID=my-pc
USAGE
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  cat >"$ENV_FILE" <<ENV
# TriCLI Remote environment. Set TRICLI_TOKEN before exposing services publicly.
TRICLI_SERVER_HOST=127.0.0.1
TRICLI_SERVER_PORT=7320
TRICLI_DAEMON_HOST=127.0.0.1
TRICLI_DAEMON_PORT=7317
# TRICLI_TOKEN=
# TRICLI_SERVER_URL=
# TRICLI_MACHINE_ID=
# TRICLI_MACHINE_NAME=
ENV
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE with localhost-safe defaults."
fi

if [ -x "$ROOT/scripts/install-work-commands.sh" ]; then
  "$ROOT/scripts/install-work-commands.sh"
fi

cat >/etc/systemd/system/tricli-daemon.service <<SERVICE
[Unit]
Description=TriCLI Remote Machine Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
EnvironmentFile=-$ENV_FILE
ExecStart=/usr/bin/env node $ROOT/apps/daemon/daemon.js --host \\${TRICLI_DAEMON_HOST} --port \\${TRICLI_DAEMON_PORT}
Restart=always
RestartSec=3
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
SERVICE

cat >/etc/systemd/system/tricli-server.service <<SERVICE
[Unit]
Description=TriCLI Remote Public Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
EnvironmentFile=-$ENV_FILE
ExecStart=/usr/bin/env node $ROOT/apps/server/server.js --host \\${TRICLI_SERVER_HOST} --port \\${TRICLI_SERVER_PORT}
Restart=always
RestartSec=3
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
if [ "$INSTALL_ENABLE" = 1 ]; then
  systemctl enable tricli-daemon.service tricli-server.service
fi
if [ "$INSTALL_START" = 1 ]; then
  systemctl restart tricli-daemon.service tricli-server.service
fi
cat <<DONE
Installed systemd units:
  /etc/systemd/system/tricli-daemon.service
  /etc/systemd/system/tricli-server.service
Environment file:
  $ENV_FILE

Next:
  1. Edit $ENV_FILE and set TRICLI_TOKEN before public exposure.
  2. systemctl enable --now tricli-daemon tricli-server
DONE
