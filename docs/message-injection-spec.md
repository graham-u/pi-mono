# Cron-Triggered Message Injection

## Overview

Add the ability for local processes (cron jobs, scripts, curl) to inject
messages into the assistant session via HTTP. The injected message appears as an
assistant message in the chat UI — as though the AI proactively reached out.
Connected frontends update in real time via the existing WebSocket events.

No push notifications, no service worker, no frontend changes.

### Use Case

A cron job runs on the NUC at a scheduled time. It calls a local LLM to
summarise calendar events and to-do items. The summary is injected into the
active assistant session as an assistant message. The user opens the app (or
already has it open) and sees the summary, then replies naturally.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser / Mobile                                                 │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Pi Assistant App                                           │  │
│  │  RemoteAgent ← WebSocket ← events from server              │  │
│  │  ChatPanel re-renders when message events arrive            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                               │ WebSocket                         │
└───────────────────────────────┼───────────────────────────────────┘
                                │
┌───────────────────────────────┼───────────────────────────────────┐
│  NUC (Backend)                │                                    │
│                               ▼                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  assistant-server                                           │  │
│  │                                                             │  │
│  │  WebSocket server (:3001)  ←── existing, unchanged          │  │
│  │  HTTP layer (new)          ←── POST /api/inject             │  │
│  │  AgentSession              ←── existing SDK                 │  │
│  └────────────────────┬───────────────────────────────────────┘  │
│                        │                                          │
│                        │ HTTP POST /api/inject                    │
│                        │                                          │
│  ┌────────────────────┴───────────────────────────────────────┐  │
│  │  Cron script / curl / any local process                     │  │
│  │                                                             │  │
│  │  1. Does its own inference (Ollama, API call, etc.)         │  │
│  │  2. POSTs result to http://localhost:3001/api/inject        │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

## Why the Cron Script Does Its Own Inference

The cron script runs a **separate** LLM call — it does not go through
`session.prompt()`. This is important because:

- `session.prompt()` adds a user message first, then gets an assistant response.
  The user would see a phantom "user" message they didn't send.
- The cron result should appear as a standalone assistant message — the AI
  proactively reaching out, not responding to a prompt.
- The cron script can use a different (cheaper/faster) model for summarisation.
- The cron script's inference is stateless — it doesn't need the session's
  conversation history.

The cron script can use the `@mariozechner/pi-ai` package directly, `curl` to a
local Ollama instance, or any other method. It's completely independent.

---

## HTTP Endpoint: POST /api/inject

The assistant-server gains a small HTTP layer alongside its existing WebSocket
server. This endpoint accepts a message to inject:

```
POST /api/inject
Content-Type: application/json

{
  "content": "Good morning! Here's your daily briefing:\n\n- ..."
}
```

### What the Server Does

1. **Creates** an assistant-role `AgentMessage` with the provided content.
2. **Appends** it to `session.messages` (the in-memory message list).
3. **Persists** the updated session to disk (via the session manager).
4. **Broadcasts** `message_start` and `message_end` events to all connected
   WebSocket clients, so the RemoteAgent picks it up and the UI renders it.
5. **Returns** `200 OK` with `{ "success": true }`.

### Message Format

The injected message must match the `AgentMessage` shape that the RemoteAgent
expects. Looking at the existing event flow in `remote-agent.ts`:

```typescript
// server emits:
{ type: "message_start", message: { role: "assistant", content: [...] } }
// then:
{ type: "message_end",   message: { role: "assistant", content: [...] } }
```

The server creates the message object:

```typescript
function createInjectedMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}
```

The message has no `usage` field. This is fine — the UI only renders the token
usage / cost line when `message.usage` is truthy (`Messages.ts:145`), so
injected messages simply show no usage stats underneath. The aggregate cost
footer also guards with `if (usage)` before accumulating, so injected messages
are invisible to cost tracking.

### How the Frontend Handles It

**No frontend changes are needed.** The RemoteAgent already handles
`message_start` and `message_end` for assistant messages
(`remote-agent.ts:308-340`):

- `message_start` with `role: "assistant"` → sets `streamMessage`
- `message_end` with `role: "assistant"` → moves from `streamMessage` to
  `messages` array, clears `streamMessage`

The UI re-renders automatically via the existing event subscription. The message
appears as a normal assistant message in the chat. The user can reply and it
goes through `session.prompt()` as usual — the injected message is in the
session history, so the LLM has full context.

---

## Session Persistence

The injected message must be persisted so it survives a server restart. The
AgentSession's session manager handles persistence, but we need to verify which
API to use. Options:

- **Direct:** If `session.messages` is a mutable array that the session manager
  saves, pushing to it and triggering a save would work.
- **SDK method:** If the SDK provides a method to add arbitrary messages (e.g.,
  `session.addMessage()`), use that.
- **Write-through:** Worst case, write directly to the session JSON file on disk
  (`~/.pi/agent/sessions/<id>.json`).

This needs investigation when implementing — check what the `AgentSession` API
exposes for direct message manipulation.

---

## Authentication

The `/api/inject` endpoint only accepts requests from localhost:

```typescript
// Only accept from loopback
if (req.socket.remoteAddress !== "127.0.0.1" &&
    req.socket.remoteAddress !== "::1" &&
    req.socket.remoteAddress !== "::ffff:127.0.0.1") {
  res.writeHead(403);
  res.end("Forbidden");
  return;
}
```

The cron scripts run on the same NUC, so this is sufficient. Could add a shared
secret in a header later if needed.

---

## Adding the HTTP Layer

The assistant-server currently creates a bare `WebSocketServer({ port })`. To
add HTTP routes on the same port, change to:

1. Create an `http.createServer()` that handles HTTP requests.
2. Attach the WebSocket server to it via `new WebSocketServer({ server })`.
3. Route `/api/*` requests to the appropriate handler.
4. The existing WebSocket protocol is unchanged — upgrade requests are handled
   by the ws library automatically.

This is the `httpServer` option already defined in `AssistantServerOptions`
(`server.ts:26`) but not yet used for self-hosted HTTP.

### Vite Proxy

Add `/api` to the Vite proxy config so frontend HTTP requests reach the backend
(also needed later for push notification registration):

```typescript
// vite.config.ts
proxy: {
  "/ws": { ... },  // existing
  "/api": {
    target: "http://localhost:3001",
    changeOrigin: true,
  },
}
```

---

## Implementation Steps

1. **Add HTTP server** to `assistant-server` — create `http.createServer()`,
   attach WebSocket to it, add route handling for `/api/inject`.
2. **Implement injection logic** — create message, add to session, broadcast
   events, persist.
3. **Add Vite proxy** for `/api`.
4. **Test:** start server + frontend, open browser, then:
   ```bash
   curl -X POST http://localhost:3001/api/inject \
     -H "Content-Type: application/json" \
     -d '{"content":"Hello from cron!"}'
   ```
   The message should appear in the chat.
5. **Test reply:** respond to the injected message in the UI — the LLM should
   have context from the injected message.
6. **Test persistence:** restart the server, reload the frontend — the injected
   message should still be in the conversation history.

---

## Cron Script Examples

### Simple bash script

```bash
#!/bin/bash
# ~/.pi/cron/daily-briefing.sh
# crontab: 0 7 * * * ~/.pi/cron/daily-briefing.sh

# 1. Gather data
CALENDAR=$(gcalcli agenda --nocolor --tsv today tomorrow 2>/dev/null || echo "No calendar data")
TODOS=$(cat ~/notes/todo.md 2>/dev/null || echo "No todos")

# 2. Summarise via local LLM
SUMMARY=$(curl -s http://localhost:11434/api/generate \
  -d "{
    \"model\": \"llama3.2:3b\",
    \"prompt\": \"Summarise this person's day briefly and friendly.\\n\\nCalendar:\\n${CALENDAR}\\n\\nTodos:\\n${TODOS}\",
    \"stream\": false
  }" | jq -r '.response')

# 3. Inject into assistant session
curl -s -X POST http://localhost:3001/api/inject \
  -H "Content-Type: application/json" \
  -d "{\"content\": $(echo "$SUMMARY" | jq -Rs .)}"
```

### Node.js script using the pi-ai package

```typescript
// ~/.pi/cron/daily-briefing.ts
import { streamSimple, getModel } from "@mariozechner/pi-ai";
import "dotenv/config";

const model = getModel("anthropic", "claude-3-5-haiku-latest");
const response = await streamSimple(model, {
  messages: [{ role: "user", content: `Summarise today's schedule: ...` }],
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

await fetch("http://localhost:3001/api/inject", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: response.text }),
});
```

The script is completely standalone — it doesn't need to import any assistant
packages. Anything that can make an HTTP POST works.

---

## Files Changed

| File | Change |
|------|--------|
| `assistant-server/src/server.ts` | Wrap in `http.createServer()`, add `/api/inject` handler |
| `assistant-server/src/http.ts` | New — HTTP route handling, injection logic |
| `assistant-frontend/vite.config.ts` | Add `/api` proxy |

## Open Questions

1. **Session message API.** How to cleanly add a message to `session.messages`
   and persist it. Needs SDK investigation.

2. **User reply context.** The system prompt (`~/.pi/agent/SYSTEM.md`) should
   mention that the assistant sometimes sends proactive messages so the LLM
   doesn't get confused about messages it "doesn't remember generating".

3. **Multiple sessions.** Which session does the cron inject into? Simplest
   default: the active session. The endpoint could accept an optional
   `sessionId` parameter later.
