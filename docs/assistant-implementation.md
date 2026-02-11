# Pi Assistant — Implementation Notes

Companion to `docs/pi-assistant-spec.md`. Records architecture decisions,
interface contracts, and known issues for anyone continuing this work.

---

## Package Layout

```
packages/assistant-server/    Node.js WebSocket server wrapping coding-agent SDK
packages/assistant-frontend/  Vite browser app using pi-web-ui components
```

Both packages are included in the root workspace via `"packages/*"`.
The frontend is excluded from root `tsconfig.json` (uses DOM libs / bundler
moduleResolution, same as web-ui).

---

## Data Flow

```
User types in browser
  → RemoteAgent.prompt(text)
  → WebSocket: { type: "input", text }
  → Server receives message
    → starts with "/"?
        yes → handleCommand(): skill invocation, bash shorthand, prompt template, or unknown
        no  → session.prompt(text) — runs LLM via coding-agent SDK
  → AgentSessionEvents stream back over WebSocket
  → RemoteAgent updates local AgentState, emits events to subscribers
  → ChatPanel / AgentInterface re-renders
```

---

## assistant-server

### Source Files

| File | Purpose |
|------|---------|
| `src/server.ts` | `createAssistantServer()` — creates AgentSession, sets up HTTP + WebSocket, handles messages |
| `src/http.ts` | HTTP handler — `POST /api/inject` for message injection, localhost-only guard |
| `src/types.ts` | WebSocket protocol types: ClientMessage, ServerMessage, ServerState |
| `src/cli.ts` | CLI entry: `pi-assistant-server [--port 3001] [--cwd /path]` |
| `src/index.ts` | Public exports |

### WebSocket Protocol

**Client → Server:**

| Type | Purpose |
|------|---------|
| `input` | Raw user input — server runs slash-command check, falls back to LLM |
| `prompt` | Direct LLM prompt (bypasses slash-command check) |
| `command` | Direct slash command (bypasses LLM) |
| `steer` | Interrupt agent mid-run |
| `follow_up` | Queue message for after current run |
| `abort` | Cancel current operation |
| `get_state` | Request state sync |
| `get_messages` | Request full message history |
| `get_commands` | Request available slash commands |
| `set_model` | Change model (provider + modelId) |
| `set_thinking_level` | Change thinking level |
| `get_available_models` | List available models |
| `list_sessions` | List all sessions for the cwd |
| `new_session` | Start a fresh session |
| `switch_session` | Switch to a specific session (includes `sessionPath`) |
| `rename_session` | Rename a session (includes `sessionPath` and `name`) |

**Server → Client:**

All `AgentSessionEvent` types are forwarded directly, plus:

| Type | Purpose |
|------|---------|
| `state_sync` | Bulk state update (model, thinkingLevel, isStreaming, sessionPath, etc.) |
| `command_result` | Result of a slash command |
| `response` | Response to a query (get_commands, set_model, list_sessions, etc.) |

### Design Decisions

1. **Mirrors the RPC mode.** The existing `rpc-mode.ts` in coding-agent uses
   JSON over stdin/stdout. The assistant-server does the same but over WebSocket.
   Command names and response shapes are kept consistent.

2. **Uses `createAgentSession()` from the SDK.** This gives us tools, skills,
   extensions, sessions, and model management for free. We don't reimplement
   any agent logic.

3. **Binds extensions with commandContextActions.** Same pattern as RPC mode —
   extensions get `waitForIdle`, `newSession`, `fork`, `navigateTree`,
   `switchSession` capabilities.

4. **Command routing order:**
   - `/skill:name` → goes through LLM (session.prompt expands skill content)
   - `/bash` or `/!` → direct bash execution via `session.executeBash()`
   - Prompt template match → goes through LLM (session.prompt expands template)
   - Unknown → error response

5. **BashResult shape:** The SDK's `BashResult` has a single `.output` field
   (combined stdout+stderr), not separate fields.

6. **HTTP layer shares the WebSocket port.** In standalone mode, an
   `http.createServer()` wraps the WebSocket server so both HTTP and WS
   listen on the same port (default 3001). The HTTP handler is wired via
   `httpServer.on("request", handler)` after the `WebSocketServer` is
   attached. When `options.httpServer` is provided (caller owns the
   server), the HTTP handler is not used.

7. **Message injection uses `agent.appendMessage()` + `sessionManager.appendMessage()`.**
   The injected message is added to both the in-memory agent state (so the
   LLM sees it on the next turn) and the session manager's tree (so it
   persists across restarts). WS events are broadcast directly to clients
   rather than going through the agent's event system, since `_emit` is
   private. Injected messages use a zeroed `usage` object because the
   agent's compaction and stats code accesses `usage` fields without null
   guards.

8. **Server resumes the most recent session on startup.** Passes
   `sessionManager: SessionManager.continueRecent(cwd)` to
   `createAgentSession()`. The first connecting client sees the full
   conversation history from the previous session.

9. **Per-client session isolation via session pool.** Each WebSocket client
   independently binds to a session from a shared `Map<string, AgentSession>`
   pool. Sessions are created lazily when a client first navigates to them.
   Switching sessions on one device does not affect other connected clients.
   If two clients view the same session, both receive that session's events
   (agent streaming, state changes, etc.). New clients default to the startup
   session (most recent). The `resourceLoader` is created once and shared
   across all sessions (it's stateless). On server shutdown, all pooled
   sessions are disposed.

10. **System prompt uses the SDK's built-in mechanism.** The coding-agent
   SDK's `ResourceLoader` discovers `SYSTEM.md` files automatically —
   checking `.pi/SYSTEM.md` (project-local) then `~/.pi/agent/SYSTEM.md`
   (global). When found, the contents replace the default coding-agent
   framing via `buildSystemPrompt({ customPrompt })`, while tool
   descriptions, project context, and skills are still injected. No custom
   file-loading code was needed. See `docs/assistant-guide.md` for user
   configuration details.

---

## assistant-frontend

### Source Files

| File | Purpose |
|------|---------|
| `src/remote-agent.ts` | `RemoteAgent` class — extends Agent, proxies over WebSocket, session management |
| `src/main.ts` | App entry — store setup, connection, ChatPanel wiring, session sidebar |
| `src/app.css` | Tailwind CSS with `@source` directives for mini-lit, web-ui, and local components |
| `vite.config.ts` | Dev server (:3000), proxies `/ws` and `/api` to `:3001` |
| `index.html` | HTML shell |

### RemoteAgent Design

The RemoteAgent extends the `Agent` class from `@mariozechner/pi-agent-core`.
This is necessary because:

- `ChatPanel.setAgent()` takes `Agent` (the class, not an interface)
- `AgentInterface.session` is typed as `Agent`
- TypeScript's structural typing doesn't work across classes with private fields

**Overridden members:**

| Member | Behavior |
|--------|----------|
| `get state()` | Returns `_remoteState` (our own state, not parent's private `_state`) |
| `subscribe(fn)` | Uses `_remoteListeners` (our own set, not parent's private `listeners`) |
| `prompt(input)` | Sends `{ type: "input", text }` over WebSocket |
| `abort()` | Sends `{ type: "abort" }` over WebSocket |
| `setModel(m)` | Updates local state + sends `{ type: "set_model" }` |
| `setThinkingLevel(l)` | Updates local state + sends `{ type: "set_thinking_level" }` |
| `steer(m)` | Extracts text, sends `{ type: "steer" }` |
| `followUp(m)` | Extracts text, sends `{ type: "follow_up" }` |
| `setTools(t)` | No-op (tools are server-side) |

**Session management methods (not overrides):**

| Method | Behavior |
|--------|----------|
| `listSessions()` | Returns `Promise<SessionInfoDTO[]>` — sends `list_sessions`, resolves with response |
| `newSession()` | Returns `Promise<void>` — sends `new_session`, resolves when server confirms |
| `switchSession(path)` | Returns `Promise<void>` — sends `switch_session`, resolves when server confirms |
| `renameSession(path, name)` | Returns `Promise<void>` — sends `rename_session`, resolves when server confirms |
| `onSessionChange(fn)` | Subscribe to session path changes (from switch, new, or reconnect) |
| `get sessionPath` | Current session file path (tracked from `state_sync`) |

Uses a pending-request map keyed by command name for promise resolution.

**State synchronization from server events:**

| Server Event | State Update |
|-------------|-------------|
| `state_sync` | Bulk update model, thinkingLevel, isStreaming, sessionPath. Clears messages on session change. |
| `agent_start` | `isStreaming = true` |
| `agent_end` | `isStreaming = false`, `streamMessage = null`, messages updated |
| `message_start` | `streamMessage = msg` (assistant) or append to messages (user) |
| `message_update` | `streamMessage = msg` |
| `message_end` | Append to messages, `streamMessage = null` |
| `tool_execution_start` | Add to `pendingToolCalls` |
| `tool_execution_end` | Remove from `pendingToolCalls` |

### API Key Bypass

AgentInterface.sendMessage() checks `getAppStorage().providerKeys.get(provider)`.
If no key found, it calls `onApiKeyRequired`. Two bypass mechanisms:

1. **Pre-seeding:** After connecting, we seed the provider key store:
   `storage.providerKeys.set(model.provider, "backend-managed")`
2. **Callback:** `onApiKeyRequired` seeds the key and returns `true`

### streamFn Bypass

AgentInterface checks `if (session.streamFn === streamSimple)` and replaces it
with a proxy-aware version. RemoteAgent sets `streamFn` to a throwing function
so this comparison fails and the replacement is skipped.

---

## Build Notes

- The monorepo uses `tsgo` (native TS compiler) which isn't always available.
  Fall back to `tsc` with `--skipLibCheck`.
- Build order: `tui → ai → agent → coding-agent → [web-ui →] assistant-server`
- The `tui` package requires `--target ES2024` (regex `v` flag).
- The `xlsx` npm package CDN sometimes returns 403, blocking `npm install`.
  Workspace symlinks usually pre-exist; build individual packages as needed.
- assistant-frontend uses Vite (not tsc) for building.

---

## Phase Status

### Phase 1: Minimal Working Connection ✅
- assistant-server with WebSocket, prompt flow, event streaming
- assistant-frontend with RemoteAgent adapter, ChatPanel wiring
- Branch: `claude/phase-1-assistant-setup-RH95R`

### Phase 2: Slash Commands (partially done — needs review)
- Server-side routing implemented for `/bash`, `/!`, `/skill:name`, prompt templates
- TODO: Render `command_result` messages in the chat UI (currently console.log)
- TODO: Wire up extension commands properly (need ExtensionCommandContext)
- **Before starting work:** verify what the SDK already provides out of the
  box when handling `/` commands through `session.prompt()`. Some of this
  routing may already be handled internally and not need custom code.
  Also review which slash commands are actually wanted for the assistant
  use case vs the coding-agent use case.

### Phase 3: Session Management ✅
- Server resumes most recent session on startup (`SessionManager.continueRecent`)
- `list_sessions`, `new_session`, `switch_session`, `rename_session` protocol messages
- Session sidebar in frontend: session list with preview/date/count, "New Chat"
  button, active session highlighting, inline rename via pencil icon
- Responsive: desktop sidebar always visible (260px), mobile overlay with
  hamburger toggle
- Per-client session isolation: each WebSocket client independently binds to a
  session from a shared pool. Switching on one device doesn't affect others.
- Sidebar refreshes after each agent turn (`agent_end` event)

### Phase 4: Polish (partially done)
- ~~Model selection UI~~ ✅ (uses pi-web-ui's built-in model selector)
- ~~WebSocket reconnection~~ ✅ (auto-reconnect with backoff)
- Command palette — not started
- Error handling — basic error handling in place

---

## Known Issues

1. **Extension commands not fully wired.** The handler signature is
   `(args: string, ctx: ExtensionCommandContext)` — we need to provide the ctx
   from the ExtensionRunner, not call the handler directly.

2. **command_result not rendered.** Slash command results go to `console.log`
   in the RemoteAgent. They should be injected as messages in the chat.

3. ~~**No reconnection.**~~ Resolved — see below.

4. **state_sync triggers fake events.** The `applyStateSync` method emits
   `agent_start` / `agent_end` to force a re-render. Should use a cleaner
   mechanism (e.g., a dedicated state_changed event or direct requestUpdate).

5. **promptTemplates access.** Needs verification that `session.promptTemplates`
   is available after `createAgentSession()` without explicit reload.

## Resolved Issues

1. **Doubled user prompts.** `message_end` was appending user messages that
   were already added at `message_start`. Fixed: only append assistant
   messages at `message_end`; user messages are already in the array.

2. **Disappearing conversation history.** `agent_end.messages` only contains
   the current run's messages, not the full history. The RemoteAgent was
   replacing its accumulated messages with this partial list. Fixed: ignore
   `msg.messages` on `agent_end` and keep accumulated state.

3. **WebSocket auto-reconnect.** Added reconnect logic with backoff (1s x5,
   2s x5, then 5s). Header shows "Reconnecting..." during the process.
   `disconnect()` sets a flag to suppress auto-reconnect.
