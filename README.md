# TriCLI Remote

TriCLI Remote is a self-hosted Web + Android remote-control plane for **Codex**, **Claude Code**, and **Cursor Agent**. It controls the same persistent tmux sessions used by `codex-work`, `claude-work`, and `cursor-work`, so AI CLI work keeps running even when the browser, mobile app, relay, or SSH client disconnects.

## What is included

- **One platform, three CLIs**: Codex, Claude Code, Cursor Agent provider tabs and adapters.
- **Web controller**: dark rounded black/gray UI, mobile-first layout, machine picker, live terminal snapshots, prompt composer, hotkeys, uploads, approval center, CLI jobs, and structured turns.
- **Android controller**: Expo/React Native native UI for direct daemon or relay machines, provider switching, prompt send, hotkeys, uploads, approvals, structured turns, and CLI jobs.
- **Local daemon**: owns tmux sessions, uploads, background monitoring, event history, approvals, jobs, and structured adapter processes.
- **Public relay server**: web hosting, machine registration, reverse polling relay for computers without public IP, notification records, and optional webhook dispatch.
- **Structured adapters**:
  - Codex: `codex app-server --stdio` JSON-RPC.
  - Claude: `claude --print --output-format stream-json`.
  - Cursor: `cursor-agent -p --output-format stream-json --trust`.
- **Raw CLI parity fallback**: arbitrary key/text input to tmux plus `POST /api/jobs` for CLI subcommands.
- **Uploads**: browser/mobile files are saved on the target machine and the resulting local path can be sent to the selected CLI.
- **Single-user token**: set `TRICLI_TOKEN` to protect daemon/server APIs.

## Quick start

```bash
cd /root/tricli-remote
tricli-server --host 0.0.0.0 --port 7320
tricli-daemon --host 0.0.0.0 --port 7317
```

Open:

```text
http://SERVER:7320
```

For same-LAN direct control, enter the target daemon URL in the Web UI:

```text
http://COMPUTER_LAN_IP:7317
```

For cross-network control when the target computer has no public IP, run the daemon in polling relay mode:

```bash
tricli-daemon \
  --host 127.0.0.1 \
  --port 7317 \
  --server-url http://PUBLIC_SERVER:7320 \
  --machine-id my-pc
```

Then open the public server Web UI and choose `my-pc` from the machine list.

## Existing work commands remain the source of truth

Install/refresh the command adapters:

```bash
npm run install:work-commands
# or
tricli-remote install-work-commands
```

Then use the shortcuts:

```bash
codex-work
claude-work
cursor-work
```

TriCLI uses the same tmux sessions non-interactively:

```bash
ai-work ensure codex --cwd /root
ai-work send codex "continue the task"
ai-work capture codex 120
ai-work keys codex C-c
```

Fixed tmux sessions:

| Provider | tmux session | Human command | Remote command |
|---|---:|---|---|
| Codex | `ai-codex` | `codex-work` | `ai-work ... codex` |
| Claude Code | `ai-claude` | `claude-work` | `ai-work ... claude` |
| Cursor Agent | `ai-cursor` | `cursor-work` | `ai-work ... cursor` |

## Structured turn examples

```bash
curl -X POST http://127.0.0.1:7317/api/structured/codex/turn \
  -H 'content-type: application/json' \
  --data '{"prompt":"Reply exactly TRI_OK","cwd":"/root","timeoutMs":60000}'

curl -X POST http://127.0.0.1:7317/api/structured/claude/turn \
  -H 'content-type: application/json' \
  --data '{"prompt":"Reply exactly TRI_CLAUDE_OK","cwd":"/root","permissionMode":"plan"}'

curl -X POST http://127.0.0.1:7317/api/structured/cursor/turn \
  -H 'content-type: application/json' \
  --data '{"prompt":"Reply exactly TRI_CURSOR_OK","cwd":"/root","mode":"ask"}'
```

Each call returns immediately with a daemon-owned turn id. Reconnect later and inspect:

```bash
curl http://127.0.0.1:7317/api/structured/cursor/turns
```


## GitHub Actions Android Release APK

The repository includes `.github/workflows/android-release.yml`. It builds a signed **release APK** on every tag matching `v*` and uploads it to the GitHub Release.

Before the first release, add these GitHub repository secrets:

| Secret | Meaning |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Base64 of your Android JKS/keystore file |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias |
| `ANDROID_KEY_PASSWORD` | Key password |

Generate a keystore if you do not already have one:

```bash
keytool -genkeypair -v   -keystore tricli-release.keystore   -alias tricli   -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 tricli-release.keystore
```

Create a release build by pushing a tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The APK will appear under the GitHub Release assets. Keep the keystore and passwords safe; future app updates must use the same signing key.

## Android

```bash
cd /root/tricli-remote/apps/mobile
npm install
npm run start
# or
npm run android
```

The Android app is a native React Native/Expo controller. Use a reachable URL from the phone/emulator:

- Emulator to host: often `http://10.0.2.2:7317` for daemon or `http://10.0.2.2:7320` for server.
- Physical phone: use LAN IP or public relay URL.

## Service install

Install safe localhost-default systemd units:

```bash
tricli-remote install-services
# edit /etc/tricli-remote.env, set TRICLI_TOKEN, hosts, ports, server URL
systemctl enable --now tricli-daemon tricli-server
```

Use `TRICLI_MONITOR_INTERVAL_MS=5000` (default) so daemon keeps syncing tmux state and detecting approvals even with no connected controller.

## Verification

```bash
npm run check:all
```

This runs Node syntax checks, unit tests, Android TypeScript checks, and the server/daemon relay smoke test.

Additional real smoke already verified in this environment:

- Codex app-server structured turn returned `TRI_OK`.
- Cursor stream-json structured turn returned `TRI_CURSOR_OK` and persisted the Cursor session id.
- Claude stream-json adapter initialized and persisted stream events; the local account returned a rate-limit response during real model output.

## Documentation

- `docs/architecture.md` — runtime components and APIs.
- `docs/work-commands.md` — tmux/session compatibility contract.
- `docs/notifications.md` — notification and push strategy.
- `docs/deployment.md` — LAN, relay, HTTPS/Caddy, token, and systemd deployment.
- `docs/reference-analysis.md` — notes from remote Codex, VibeBridge, Cyborg/Paseo, and HappyClaw references.
- `design-system/tricli-remote/MASTER.md` — UI/UX design system generated with `ui-ux-pro-max`.
