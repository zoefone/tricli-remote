# Notification strategy

Priority order:

1. **FCM + Web Push** for global Android/Web deployments where Google services are reliable.
2. **Domestic Android vendor push** adapters for mainland China devices where FCM is unreliable.
3. **Android foreground service local notification** as fallback. It keeps a small persistent notification while a session is running and shows local alerts when the app is connected to the daemon/server.

Events that must trigger notification:

- task/session started
- task completed or failed
- approval/choice required
- server/daemon disconnected

The daemon/server already emit machine/session events through SSE. Mobile push registration and provider-specific push sending are intentionally isolated so the control plane can work before external push credentials exist.

## Server notification abstraction

The public server keeps notification history at:

```http
GET  /api/notifications
POST /api/notifications/test
```

Daemon machine events are converted into notification records for:

- `approval-detected`
- `session-started`
- `session-stopped`
- `snapshot-analyzed` with `attention` or `ready`

For production push delivery, set a webhook endpoint while FCM/vendor push SDKs
are being integrated:

```bash
TRICLI_NOTIFICATION_WEBHOOK=https://push-gateway.example/tri-cli
```

The webhook receives JSON notification payloads with `title`, `body`,
`severity`, `machineId`, and `data` fields. This lets Android notification
providers be swapped without changing daemon behavior.

## Current Android implementation

`apps/mobile/src/notifications.ts` configures Expo Notifications and creates the Android channel `tricli-session-status`. The native app currently uses local notifications for:

- session started / handoff reminder
- prompt sent
- upload completed

`getPushToken(projectId)` is provided for FCM/Expo push registration. A production deployment can send that token to:

```http
POST /api/push/register
```

with a payload such as:

```json
{ "kind": "expo", "platform": "android", "token": "ExponentPushToken[...]" }
```

Mainland China fallback remains an adapter point: the server stores notification records and can dispatch to `TRICLI_NOTIFICATION_WEBHOOK`, so a vendor-push gateway can be added without changing daemon event generation.
