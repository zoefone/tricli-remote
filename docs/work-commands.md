# `codex-work` / `claude-work` / `cursor-work` integration

## Install / refresh

The project now ships the reusable command adapter in `scripts/ai-work` plus an idempotent installer:

```bash
cd /root/tricli-remote
npm run install:work-commands
# or
tricli-remote install-work-commands
```

It installs/refreshes:

- `/usr/local/bin/ai-work`
- `/usr/local/bin/codex-work` -> `ai-work codex`
- `/usr/local/bin/claude-work` -> `ai-work claude`
- `/usr/local/bin/cursor-work` -> `ai-work cursor`

The existing commands remain the human terminal entrypoints:

```bash
codex-work
claude-work
cursor-work
```

They attach to fixed tmux sessions:

| Provider | Shortcut | tmux session | Remote non-interactive control |
|---|---|---|---|
| Codex | `codex-work` | `ai-codex` | `ai-work ensure/capture/send/keys codex` |
| Claude Code | `claude-work` | `ai-claude` | `ai-work ensure/capture/send/keys claude` |
| Cursor Agent | `cursor-work` | `ai-cursor` | `ai-work ensure/capture/send/keys cursor` |

TriCLI daemon never launches a foreground CLI owned by the Web/App connection. It calls `ai-work ensure PROVIDER` to create a detached tmux session, then uses `capture/send/keys` for control. If the browser, Android app, public server, relay polling loop, SSH connection, or terminal disconnects, the tmux session keeps running.

Manual recovery:

```bash
ai-work list
ai-work attach ai-codex
ai-work attach ai-claude
ai-work attach ai-cursor
```

This remains the compatibility contract for long-running interactive work even though richer structured turn adapters are also available.

## Background monitor

The daemon runs a background monitor every `TRICLI_MONITOR_INTERVAL_MS` milliseconds
(default `5000`). It checks the three provider tmux sessions, captures recent
output, updates `state.json`, and detects approval/choice prompts even when no
Web/App client is connected.

Disable or tune it with:

```bash
TRICLI_MONITOR_INTERVAL_MS=0 tricli-daemon
TRICLI_MONITOR_INTERVAL_MS=10000 tricli-daemon
```
