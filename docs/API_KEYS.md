# API keys per integration

Create one key per system that talks to the hub (CRM, n8n, Lovable app...) in
**Dashboard → API Keys**, or via the API below. Send it in the `x-api-key` header.

- Keys look like `wak_…`, are generated with a cryptographic RNG and shown **once**; only a SHA-256
  hash is stored.
- Each key has **scopes** and, optionally, a list of **WhatsApp numbers (sessions)** it may use.
- Keys can expire and be revoked; revocation is immediate. `lastUsedAt` is tracked.
- Checks run in the server before any route: missing scope or session → `403`,
  unknown / revoked / expired key → `401`, with a message saying why.
- A key never has more access than its owner: routes still apply the user's own session permissions.

## Scopes

| Scope | Allows |
|---|---|
| `read` | All `GET` endpoints (messages, chats, contacts, groups, sessions, broadcast history), number check |
| `send` | Send messages/media, chat actions (read, presence, archive...), scheduler, media upload |
| `broadcast` | Create, pause, resume and cancel broadcast campaigns |
| `webhooks` | Manage webhooks, their logs and deliveries |
| `manage` | Contacts, groups, labels, profile, auto-replies, bot settings |
| `admin` | Sessions (create, delete, connect, logout), users, settings, system, API keys |
| `*` | Everything |

A key limited to specific numbers can only call endpoints that include a session in the path
(`/api/messages/{sessionId}/…`, `/api/chat/{sessionId}/…`, media of that session, etc.).

## API

Requires a dashboard login or a key with the `admin` scope.

- `GET /api/api-keys` → your keys (without the secret) and the available scopes.
- `POST /api/api-keys`
  ```json
  { "name": "CRM", "scopes": ["read", "send"], "sessionIds": ["njtnpj"], "expiresInDays": 365 }
  ```
  → `201` with `data.key` (the only time it is returned). `sessionIds` and `expiresInDays` are optional.
- `DELETE /api/api-keys/{id}` → revoke.

## Legacy key

The old single per-user key (`/api/user/api-key`, prefix `wag_`) keeps working with full access, for
existing integrations such as the n8n nodes. Once everything uses per-integration keys, set
`LEGACY_API_KEYS="false"` to disable it.
