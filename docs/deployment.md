# Deployment notes

## Same LAN

On the controlled machine:

```bash
tricli-daemon --host 0.0.0.0 --port 7317
```

On the Web UI or Android app, use:

```text
http://LAN_IP:7317
```

## Public relay for machines without public IP

On the public server:

```bash
TRICLI_TOKEN='change-me' tricli-server --host 0.0.0.0 --port 7320
```

On each controlled machine:

```bash
TRICLI_TOKEN='change-me' tricli-daemon \
  --host 127.0.0.1 \
  --port 7317 \
  --server-url https://your-domain.example \
  --machine-id my-pc
```

The daemon long-polls the public server. The public server never runs Codex/Claude/Cursor itself.

## Caddy HTTPS example

```caddyfile
your-domain.example {
  reverse_proxy 127.0.0.1:7320
}
```

Then use `https://your-domain.example` in the Web/Android connection URL.

## Token behavior

Set the same `TRICLI_TOKEN` on server and daemon. The Web and Android UIs include a token field and send both:

- `Authorization: Bearer <token>`
- `x-tricli-token: <token>`

The server serves static Web assets without a token so a browser can load the UI, but all API routes remain token-protected when `TRICLI_TOKEN` is set.

## systemd

```bash
tricli-remote install-services
sudo editor /etc/tricli-remote.env
sudo systemctl enable --now tricli-server tricli-daemon
```

The installer also refreshes the persistent work commands because `tricli-daemon` depends on `ai-work` for tmux-backed disconnect-safe control. For a public relay-only server, disable or ignore `tricli-daemon`. For a controlled private computer, set `TRICLI_SERVER_URL` in `/etc/tricli-remote.env` so the daemon registers to the public server.
