# Architecture

## Runtime components

- **Machine daemon** (`apps/daemon`): runs on the controlled computer/server. It manages persistent tmux sessions through `ai-work`, exposes HTTP/SSE APIs, saves uploads locally, and optionally polls a public TriCLI server for relay commands.
- **Public server** (`apps/server`): serves the Web UI, tracks registered machines, proxies direct daemon URLs, and offers a polling relay for machines without a public IP.
- **Web controller** (`apps/web`): mobile-first dark UI for selecting a machine, switching Codex/Claude/Cursor, sending prompts, viewing terminal snapshots, and uploading files.
- **Android controller** (`apps/mobile`): React Native/Expo native app with native controls for machine selection, provider switching, prompt send, hotkeys, uploads, approvals, structured turns, and CLI jobs.

## Persistence guarantee

The control plane never owns the AI CLI process. It only sends keys/text into tmux sessions named:

- `ai-codex` via `codex-work` / `ai-work codex`
- `ai-claude` via `claude-work` / `ai-work claude`
- `ai-cursor` via `cursor-work` / `ai-work cursor`

Therefore, Web/App disconnects, browser refreshes, or relay outages do not stop the underlying CLI. The user can always reattach with the existing work commands.

## Connection modes

1. **LAN direct**: Controller talks to `http://computer:7317`.
2. **Public server relay**: Daemon polls `http(s)://server/api/relay/:machineId/poll`; server queues controller commands and returns results.
3. **Reverse tunnel/proxy-compatible**: If `directUrl` is registered, server proxies directly to that daemon URL. This can point to FRP/rathole/SSH reverse-tunnel endpoints.

## Structured adapter readiness layer

`packages/core/adapters.js` now defines a provider-adapter capability contract. The daemon exposes it at:

```http
GET /api/adapters
```

The readiness probes expose which richer adapters are available on the machine:

- `codex-app-server` when `codex app-server --help` is available.
- `claude-stream-json` when Claude Code advertises `--output-format stream-json`.
- `cursor-stream-json` when Cursor Agent advertises `--output-format stream-json`.
- `cursor-acp` when `cursor-agent acp` is available; this is a readiness probe for future deeper ACP lifecycle control.

Persistent interactive work still defaults to `work-command` / tmux. One-shot structured turns use the richer adapters and are daemon-owned, so they also survive Web/App disconnects.

## Approval and attention recovery

The daemon analyzes terminal snapshots for approval/choice/danger markers. Pending items are persisted in `~/.tricli-remote/daemon/state.json` and exposed at:

```http
GET  /api/approvals?provider=codex
POST /api/approvals/:id/respond
GET  /api/events/history
```

The Web UI renders a lightweight approval center and can send common responses (`y`, `n`, `Enter`) back into the persistent tmux session. This makes approval prompts recoverable after Web/App reconnects.

## Arbitrary CLI job API

For non-interactive subcommands that are not part of the long-running tmux UI,
the daemon exposes a persistent CLI job API:

```http
POST /api/jobs
GET  /api/jobs?provider=codex
GET  /api/jobs/:id
POST /api/jobs/:id/kill
```

Example body:

```json
{ "provider": "codex", "args": ["--version"], "cwd": "/root" }
```

Jobs are owned by the daemon process, not the Web/App request. If the controller
disconnects, the child process continues and stdout/stderr remain available
through the job detail endpoint. Long interactive work still belongs in the
`codex-work` / `claude-work` / `cursor-work` tmux sessions.

## Codex app-server structured turn API

Codex now has a real structured lifecycle path in addition to tmux fallback:

```http
POST /api/structured/codex/turn
GET  /api/structured/codex/turns
GET  /api/structured/codex/turns/:id
POST /api/structured/codex/turns/:id/kill
```

Example:

```json
{
  "prompt": "Summarize this repository.",
  "cwd": "/root/project",
  "timeoutMs": 120000,
  "autoApprove": false
}
```

The endpoint returns immediately with a daemon-owned `structuredTurnId`. The
daemon keeps the `codex app-server --stdio` process alive, collects JSON-RPC
notifications, persists events into `state.json`, and exposes assistant text,
command output, reasoning deltas, item lifecycle events, server requests,
thread id, and turn id through the detail endpoint. If the Web/App connection
closes, the structured turn continues in the daemon until completion, failure,
timeout, or explicit kill.

Safety default: app-server approval requests are not auto-approved unless the
request body includes `"autoApprove": true`. Without auto-approval, command and
file-change approvals receive decline responses instead of blocking forever.

## Claude stream-json structured turn API

Claude now has a daemon-owned structured path:

```http
POST /api/structured/claude/turn
GET  /api/structured/claude/turns
GET  /api/structured/claude/turns/:id
POST /api/structured/claude/turns/:id/kill
```

The daemon launches:

```bash
claude --print --verbose --output-format stream-json --include-partial-messages ...
```

It maps `system`, `assistant`, `thinking`, `tool_use`, `tool_result`, and
`result` stream messages into TriCLI structured events. The returned
`structuredTurnId` is daemon-owned, so Web/App disconnects do not own or stop the
process. If Claude reports retries/rate limits, those `system` stream events are
persisted and visible after reconnect.

## Cursor stream-json structured turn API

Cursor Agent now has a daemon-owned structured path:

```http
POST /api/structured/cursor/turn
GET  /api/structured/cursor/turns
GET  /api/structured/cursor/turns/:id
POST /api/structured/cursor/turns/:id/kill
```

The daemon launches:

```bash
cursor-agent -p --output-format stream-json --trust --workspace <cwd> ...
```

Optional request fields include `model`, `mode`, `resume`, `force`, `args`, and `timeoutMs`. Stream messages are normalized into `cursor-system`, `cursor-assistant`, `cursor-thinking`, `cursor-tool-use`, `cursor-tool-result`, and `cursor-result` events. The Cursor chat/session id is stored as `threadId` / `summary.sessionId`, enabling resume-oriented UI flows.

A real local smoke run completed with `TRI_CURSOR_OK`, proving the daemon-owned Cursor stream-json path works after the HTTP start request returns.

