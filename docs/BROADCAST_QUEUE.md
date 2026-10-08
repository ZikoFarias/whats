# Broadcast queue

Broadcasts are persistent campaigns processed by a background worker in the server process.
They survive restarts, are rate-limited per WhatsApp number, and pause themselves when
WhatsApp restricts the number.

## API

### Queue a campaign

`POST /api/messages/{sessionId}/broadcast`

```json
{
  "recipients": [
    "5561999998888",
    { "phone": "5561988887777", "variables": { "nome": "Ana" } }
  ],
  "message": "Oi {{nome}}, tudo bem?",
  "media": { "type": "image", "url": "https://example.com/banner.jpg" },
  "delay": 12000
}
```

- `recipients`: phone numbers in any format, or objects with `phone` / `number` / `jid` and optional
  `variables`. Duplicates are removed. Brazilian numbers are resolved with or without the 9th digit.
- `message`: text; `{{key}}` is replaced with the recipient's `variables[key]`. Optional when `media` is set.
- `media` (optional): `type` is `image`, `video` or `document` (`fileName` optional for documents).
- `delay` (optional, ms, minimum 5000, default 12000): base delay between messages; the real delay is
  randomized between `delay` and `2 × delay`.

Response: `{ "broadcastId": "...", "total": 2, "withExistingChat": 1 }`

### Pause / resume / cancel

`POST /api/messages/{sessionId}/broadcast/{broadcastId}/pause|resume|cancel`

Returns `409` if the campaign is not in a state that allows the action.

### Progress

- Socket.io event `broadcast.progress` in the session room:
  `{ broadcastId, status, total, sent, failed, cancelled, pending, progress, pauseReason, note, current }`
- `GET /api/messages/{sessionId}/broadcast/history/{broadcastId}` for campaign + recipients.

Campaign status: `running`, `paused`, `completed`, `cancelled`.
Recipient status: `pending`, `sending`, `sent`, `failed`, `cancelled`.

## Safety rules (per number, across all campaigns)

| Rule | Default | Env |
|---|---|---|
| One message at a time, randomized delay | `delay`..`2×delay` | — |
| Sending hours (system timezone) | 8h–20h | `BROADCAST_HOURS` |
| Messages per day | 500 | `BROADCAST_DAILY_LIMIT` |
| New chats per day (people who never wrote to this number) | 30 | `BROADCAST_NEW_CHAT_DAILY_LIMIT` |

- Recipients who already wrote to the number are sent first.
- When a limit or the time window blocks sending, the campaign stays `running` and waits
  (the reason is emitted as `note`).
- WhatsApp error **463** (account restricted from starting new chats) pauses every running campaign
  of that number with a `pauseReason`. Resume only after the restriction is lifted.
- A late WhatsApp rejection flips the recipient from `sent` to `failed` with the error code.
- If the server stops mid-send, that recipient is marked `failed` (not retried, to avoid duplicates);
  everything else resumes automatically on restart.

Per-number overrides go in the session config: `{ "broadcast": { "dailyLimit": 300, "newChatDailyLimit": 10, "hours": "9-18" } }`.
