# Open-source reference analysis

The following projects were shallow-cloned under `references/` for local analysis and are ignored by `.gitignore` because they are not vendored into TriCLI Remote.

## remote_codex

Repository: `lanchoxie/remote_codex`

Useful ideas adopted:

- Split **relay/server**, **host-agent/daemon**, and **mobile web UI** responsibilities.
- Keep the host machine authoritative for files, sessions, runtime state, and streamed events.
- Treat app-server / structured adapters as high-fidelity paths while keeping a terminal-compatible fallback.
- Attachments should include images and local/remote file paths and should be forwarded to the agent as concrete filesystem paths.
- Mobile views need compact runtime chips, reconnectable history, and explicit status feedback.

TriCLI implementation:

- `apps/server` is the relay/static web entry.
- `apps/daemon` owns local execution and persistence.
- `packages/core/codex-app-server.js` implements Codex app-server JSON-RPC turns.
- `ai-work` tmux sessions remain the universal persistent fallback.

## VibeBridge

Repository: `Swayyyyy/VibeBridge`

Useful ideas adopted:

- Main/Node architecture with browser only talking to Main in cross-network mode.
- Node registration and machine lists are first-class UI objects.
- The main answer should be easy to read, with raw process/details available on demand.
- Role/multi-user features can be layered later; start with a single-user token model.

TriCLI implementation:

- `POST /api/machines/register`, `/api/relay/:machineId/poll`, and `/api/machines/:machineId/daemon/...` provide the Main/Node pattern.
- Web and Android both expose machine selection.
- Structured turns summarize assistant text while retaining raw events in daemon state.

## Cyborg7 / Paseo lineage

Repository: `Cyborg7-com/cyborg` (built on Paseo)

Useful ideas adopted:

- Every daemon executes agents locally; no central cloud service runs private code.
- Relay brokers cross-network connectivity but should not own credentials or execution.
- Provider adapters should be pluggable because different CLIs expose different protocols.
- Offline/reconnect behavior benefits from local state persistence.

TriCLI implementation:

- Daemon state persists to `~/.tricli-remote/daemon/state.json`.
- Server state persists to `~/.tricli-remote/server/state.json`.
- Adapters live in `packages/core/*` and expose normalized events.

## HappyClaw

Repository: `rwmjhb/happyclaw`

Useful ideas adopted:

- Permission relay is as important as output relay.
- Zero-token push/notification paths should not require asking the model to summarize status.
- Session handoff must support local terminal -> remote controller -> local terminal again.
- A generic PTY fallback is essential for CLIs without perfect SDK support.

TriCLI implementation:

- The approval center detects terminal permission/choice prompts and can send approve/deny/Enter keys.
- `notificationFromMachineEvent` creates server-side notifications directly from daemon events.
- `ai-work` bridges existing local `codex-work`, `claude-work`, and `cursor-work` sessions for handoff.

## Resulting product principles

1. **Daemon-owned execution:** Web/App disconnects must never kill CLI work.
2. **Structured when possible, terminal when necessary:** expose app-server/stream-json for rich UX, but keep raw CLI control for full parity.
3. **Machine-first routing:** direct LAN and relay polling are both normal connection modes.
4. **Mobile-first operations:** start, send, approve, upload, stop, and inspect must fit on a phone.
5. **Token-ready but self-hosted:** a single-user `TRICLI_TOKEN` is supported now; roles can be added later.
