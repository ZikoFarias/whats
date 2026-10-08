# MCP: connect an AI as a WhatsApp attendant

WA-AKG exposes a [Model Context Protocol](https://modelcontextprotocol.io) server at
`POST /api/mcp` (Streamable HTTP, stateless). Any MCP client (Claude Code, Claude Desktop,
Cowork, other agents) can connect and work as an attendant: read conversations, reply, start
chats, send media and run broadcasts.

## 1. Create a key for the AI

Dashboard → **API Keys** → New key, e.g. name "Atendente IA", scopes `read` + `send`
(+ `broadcast` if it may run campaigns), limited to the number(s) it should answer.

## 2. Connect a client

**Claude Code**
```bash
claude mcp add --transport http wa-akg https://wa.example.com/api/mcp \
  --header "Authorization: Bearer wak_..."
```

**Claude Desktop** (via the `mcp-remote` bridge) — `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "wa-akg": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://wa.example.com/api/mcp",
               "--header", "Authorization: Bearer ${WA_AKG_KEY}"],
      "env": { "WA_AKG_KEY": "wak_..." }
    }
  }
}
```

**Clients that cannot send headers** (e.g. claude.ai custom connectors): set
`MCP_ALLOW_KEY_IN_URL="true"` and use `https://wa.example.com/api/mcp?key=wak_...`.
The key then travels in the URL and may be logged by proxies — use a key limited to the
minimum scopes and numbers, and revoke it if it leaks.

The key can also be sent as `x-api-key`.

## Tools

| Tool | Scope | What it does |
|---|---|---|
| `list_numbers` | read | Numbers (sessions) the key can use, status and phone |
| `list_conversations` | read | Recent chats with last message; `onlyAwaitingReply` for the ones waiting on us |
| `get_conversation` | read | Messages of one chat (by JID or phone), oldest first, paginated |
| `send_message` | send | Text to a contact (reply or new chat), optional quote; reports `isNewChat` |
| `send_media` | send | Image, video, audio or document from a URL |
| `mark_as_read` | send | Mark a chat as read |
| `check_whatsapp_numbers` | read | Which numbers have WhatsApp, with their JIDs |
| `search_contacts` | read | Find contacts by name or number |
| `create_broadcast` | broadcast | Queue a campaign (delays, hours, daily and new-chat limits apply) |
| `get_broadcast` / `list_broadcasts` | read | Campaign progress, waiting/pause reasons, failures |
| `control_broadcast` | broadcast | Pause, resume or cancel a campaign |

`sessionId` can be omitted when the key has access to a single number. The server sends
instructions to the AI on how to attend and on WhatsApp safety (few new chats, broadcasts
through the queue, stop on error 463).

## Typical attendant loop

1. `list_conversations { onlyAwaitingReply: true }`
2. For each: `get_conversation` → decide the answer → `send_message` → `mark_as_read`
3. Repeat every few minutes (e.g. Claude Code `/loop 2m ...`).

For push instead of polling, combine with a `message.received` webhook (see WEBHOOK_DELIVERY.md).
