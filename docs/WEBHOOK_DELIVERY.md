# Webhook delivery (outbox with retries)

Every event sent to every subscribed webhook is stored as a `WebhookDelivery` and delivered
from there, so receivers that are down, slow or erroring don't lose events.

## Behaviour

- Delivery is attempted immediately. On failure it is retried with exponential backoff
  (±20% jitter): 10s, 30s, 2m, 10m, 30m, 1h, 2h, 4h, then every 4h, up to `WEBHOOK_MAX_ATTEMPTS`
  (default 10, about 12h in total).
- Retried: network errors, timeouts (`WEBHOOK_TIMEOUT_MS`, default 10s), HTTP 408, 429 and 5xx.
- Not retried: other 4xx responses (the receiver rejected the payload) → `failed` at once.
- Disabled webhooks: their pending deliveries are marked `failed`.
- Restart-safe: pending deliveries resume; an attempt cut off by a restart is sent again.
- Delivered rows are kept 7 days, failed rows 30 days. Every HTTP attempt is also in the
  webhook logs (`deliveryId`, `attempt`).

Delivery is **at-least-once** and not strictly ordered. Receivers should:

1. Dedupe on the `X-Webhook-Delivery` header (same value on every attempt of an event).
2. Verify `X-Webhook-Signature: sha256=<hmac of raw body with the webhook secret>`.
3. Answer 2xx quickly and process asynchronously.

Headers sent: `X-Webhook-Delivery`, `X-Webhook-Event`, `X-Webhook-Attempt` (1 = first try),
`X-Webhook-Signature` (when a secret is set).

## API

- `GET /api/webhooks/{sessionId}/{webhookId}/deliveries?status=failed&limit=50&offset=0`
  Deliveries newest first, plus `counts` per status (`pending`, `delivering`, `delivered`, `failed`).
- `POST /api/webhooks/{sessionId}/{webhookId}/deliveries/{deliveryId}/retry`
  Re-queue a `failed` (or `pending`) delivery with a fresh set of attempts and try it now.
