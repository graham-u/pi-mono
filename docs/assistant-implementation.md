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
        yes → handleCommand(): skill invocation, bash shorthand, built-in commands,
              prompt templates, extension commands, or unknown
              → extension commands: ctx.ui.notify() output captured as command_result
        no  → runInputHandlers(): run handler chain with session-scoped broadcast
              → user message persisted lazily (only when a handler claims input)
              → first handler returning { handled: true } wins
              → no handler claimed → session.prompt(text) — runs LLM via coding-agent SDK
  → AgentSessionEvents stream back over WebSocket
  → RemoteAgent updates local AgentState, emits events to subscribers
  → command_result events → injectMessage() → transient CommandResultMessage in chat
  → ChatPanel / AgentInterface re-renders
```

---

## assistant-server

### Source Files

| File | Purpose |
|------|---------|
| `src/server.ts` | `createAssistantServer()` — creates AgentSession, sets up HTTP + WebSocket, handles messages |
| `src/handlers.ts` | Input handler chain — types, loader, chain runner, `persistAssistantMessage()` (persist only) and `persistAndBroadcastAll()` (persist + global broadcast for `/api/inject`) |
| `src/http.ts` | HTTP handler — `POST /api/inject` for message injection, push notification routes, localhost-only guard |
| `src/push.ts` | Push notification support — VAPID init, subscription store, send-to-all |
| `src/types.ts` | WebSocket protocol types: ClientMessage, ServerMessage, ServerState |
| `src/cli.ts` | CLI entry: `pi-assistant-server [--port 3001] [--cwd /path]` |
| `src/index.ts` | Public exports |

### WebSocket Protocol

**Client → Server:**

| Type | Purpose |
|------|---------|
| `input` | Raw user input — server runs slash-command check, then input handler chain, falls back to LLM |
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
| `delete_session` | Delete a session file (includes `sessionPath`) |

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
   - Built-in commands (`/reload`, `/compact`, `/name`, `/session`, `/export`) → mapped to AgentSession API methods
   - Prompt template match → goes through LLM (session.prompt expands template)
   - Extension commands → dispatched via `session.extensionRunner.getCommand()`, `ctx.ui.notify()` output captured and sent as `command_result`
   - Unknown → error response

5. **BashResult shape:** The SDK's `BashResult` has a single `.output` field
   (combined stdout+stderr), not separate fields.

6. **HTTP layer shares the WebSocket port.** In standalone mode, an
   `http.createServer()` wraps the WebSocket server so both HTTP and WS
   listen on the same port (default 3001). The HTTP handler is wired via
   `httpServer.on("request", handler)` after the `WebSocketServer` is
   attached. When `options.httpServer` is provided (caller owns the
   server), the HTTP handler is not used. HTTP routes include
   `POST /api/inject` (message injection) and `/api/push/*` (push
   notification management).

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
   (agent streaming, state changes, etc.). New clients bind to the active
   session via `getActiveSession()` (initial session if still alive, else
   first available pooled session). The `resourceLoader` is created once and
   shared across all sessions (it's stateless). On server shutdown, all
   pooled sessions are disposed.

10. **Memory via Momo extension.** Long-term memory is provided by the
    `@momomemory/pi-momo` extension (installed via `packages` in
    `settings.json`). The momo backend runs as a Docker container on port
    3100 with data in `~/.local/share/momo/`. The extension hooks into
    `before_agent_start` (recall — injects a hidden `<momo-context>`
    CustomMessage) and `agent_end` (capture — stores the conversation turn).
    Context files loaded via `agentsFilesOverride` in `server.ts:63` were
    reduced to `["USER.md", "ASSISTANT.md"]` after removing the old
    file-based `MEMORY-INSTRUCTIONS.md`. Configuration is in
    `~/.pi/momo.jsonc` under the `"pi"` key. See `docs/assistant-guide.md`
    for user-facing settings.

11. **Push notifications use Web Push with VAPID (no Firebase).** The server
    uses the `web-push` npm package with VAPID keys from `.env`. Subscriptions
    are stored in `~/.pi/agent/push-subscriptions.json` (atomic writes via
    temp-then-rename). The frontend registers a service worker (`public/sw.js`)
    and subscribes via the Push API on first connect. Any local process can
    send notifications via `POST /api/push/send` (localhost-only). The push
    routes share the same localhost guard as `/api/inject` — remote browsers
    reach them through the Vite proxy. On Android, delivery while the phone
    is in Doze mode may be delayed until the device wakes (platform limitation).

12. **System prompt uses the SDK's built-in mechanism.** The coding-agent
   SDK's `ResourceLoader` discovers `SYSTEM.md` files automatically —
   checking `.pi/SYSTEM.md` (project-local) then `~/.pi/agent/SYSTEM.md`
   (global). When found, the contents replace the default coding-agent
   framing via `buildSystemPrompt({ customPrompt })`, while tool
   descriptions, project context, and skills are still injected. No custom
   file-loading code was needed. See `docs/assistant-guide.md` for user
   configuration details.

13. **Server-side input handler chain.** User input passes through a
    chain-of-responsibility pattern before reaching the LLM. Handlers are
    `.js` files in `~/.pi/agent/handlers/` that export a factory function
    returning `{ name, handle(input, ctx) }`. The chain runs after slash
    commands but before the LLM fallthrough. `ctx.reply(text)` persists an
    assistant message and broadcasts it only to clients viewing the current
    session (via `runInputHandlers()` in server.ts which builds a scoped
    reply closure). `/api/inject` uses `persistAndBroadcastAll()` which
    broadcasts globally — appropriate for external scripts. When a handler
    claims input, the user's message is lazily persisted and broadcast
    before the reply, since `session.prompt()` (which normally handles
    this) is bypassed. Handlers are loaded at startup and reloaded on
    `/reload`. The spec originally placed handlers on the frontend, but
    they need backend access (filesystem, scripts, local APIs), so they
    run server-side.

---

## assistant-frontend

### Source Files

| File | Purpose |
|------|---------|
| `src/remote-agent.ts` | `RemoteAgent` class — extends Agent, proxies over WebSocket, session management |
| `src/main.ts` | App entry — store setup, connection, ChatPanel wiring, session sidebar, autocomplete |
| `src/push.ts` | Push notification registration — SW registration, VAPID key fetch, subscription |
| `src/fuzzy.ts` | Fuzzy matching utilities (ported from `packages/tui/src/fuzzy.ts`) |
| `src/command-store.ts` | Merged list of built-in + dynamic slash commands for autocomplete |
| `src/autocomplete-dropdown.ts` | Lit custom element — dropdown UI for slash command autocomplete |
| `src/app.css` | Tailwind CSS with `@source` directives for mini-lit, web-ui, and local components |
| `public/sw.js` | Service worker for push notification display and click handling |
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
| `deleteSession(path)` | Returns `Promise<void>` — sends `delete_session`, resolves when server confirms |
| `requestCommands()` | Returns `Promise<SlashCommandInfo[]>` — sends `get_commands`, resolves with response |
| `onCommandResult(fn)` | Subscribe to `command_result` events (command name, success, output) |
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

### Cache Countdown Indicator

The sidebar shows a countdown timer next to sessions with a warm prompt cache.
The server is the source of truth — it computes `cacheExpiresAt` for each
session in the `list_sessions` response. The frontend just displays it.

**Server side** (`server.ts`):
- `getCacheTtlMs(provider, baseUrl, retention)` returns the cache TTL in ms
  for the given provider, or `null` if the provider doesn't support caching.
  For Anthropic with `PI_CACHE_RETENTION=long`, the 1-hour TTL is only returned
  when `baseUrl` includes `api.anthropic.com` (mirrors the upstream SDK check).
  `PI_CACHE_RETENTION=none` returns `null` for all providers.
- In `list_sessions`, for each session in the pool, finds the last assistant
  message timestamp and computes `cacheExpiresAt = timestamp + TTL`. Only
  included if the expiry is in the future.

**Frontend side** (`main.ts`):
- `getCacheRemaining(session)` reads `cacheExpiresAt` from the session DTO.
- `ensureCacheTick()` starts/stops a 1 Hz `setInterval` based on whether any
  session has an active countdown. The interval calls `renderApp()` (lit-html
  diffing makes this cheap — only the countdown text nodes change).
- No event-based detection. Countdowns update when the session list refreshes
  (on `agent_end`, session change, or initial load).

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

### Phase 2: Slash Commands (partially done)
- Server-side routing implemented for `/bash`, `/!`, `/skill:name`, prompt templates
- Built-in commands mapped to AgentSession API: `/reload`, `/compact`, `/name`, `/session`, `/export`
- State-mutating commands (`/reload`, `/compact`, `/name`) send `state_sync` after execution
- Slash command autocomplete: dropdown appears when user types `/`, filters with fuzzy matching,
  keyboard (ArrowUp/Down/Tab/Enter/Escape) and mouse navigation, auto-refreshes after `/reload`.
  Uses event delegation (listeners on `document`) and `show()`/`hide()` methods with explicit
  `requestUpdate()` to work around intermittent Lit reactivity issues under esbuild transpilation.
- `command_result` messages rendered in chat via `registerMessageRenderer("command-result")` + `injectMessage()`
- Extension commands dispatched via `session.extensionRunner.getCommand()` in `handleCommand()` with `ctx.ui.notify()` output captured as `command_result`

### Phase 3: Session Management ✅
- Server resumes most recent session on startup (`SessionManager.continueRecent`)
- `list_sessions`, `new_session`, `switch_session`, `rename_session`, `delete_session` protocol messages
- Session sidebar in frontend: session list with preview/date/count, "New Chat"
  button, active session highlighting, inline rename via pencil icon, delete with
  5-second countdown and undo
- Session deletion: trash icon on every session, starts 5s countdown with
  "Deleting in Ns..." text and undo button. Multiple sessions can be queued for
  deletion simultaneously with independent timers. Server tries `trash` CLI first
  (recoverable), falls back to `unlink` (permanent). Aborts streaming sessions
  before disposing. Affected clients are rebound to the most recent remaining
  session (or a new session if none remain).
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

1. ~~**Extension commands not fully wired.**~~ Resolved — see below.

2. ~~**command_result not rendered.**~~ Resolved — see below.

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

4. **Session management blocked after deleting initial session.** The
   `handleClientMessage` handler resolved the session from `sessionPool`
   at the top of the function, before dispatching to individual cases.
   If the server's initial session was deleted, its path was removed from
   the pool but new connections still bound to it (`defaultSession` was
   a const). All commands — including `new_session` — failed with "Bound
   session not found in pool". Fixed by splitting the handler into two
   phases: session-management commands (`new_session`, `list_sessions`,
   `switch_session`, `rename_session`, `delete_session`) run before the
   pool lookup since they don't need the bound session. Also replaced the
   fixed `defaultSession` binding with a dynamic `getActiveSession()`
   lookup so new connections always bind to a live session.

5. **Extension commands not dispatched.** The server's `handleCommand()` only
   handled hardcoded commands and prompt templates, bypassing extension commands
   registered via `pi.registerCommand()`. Fixed by checking
   `session.extensionRunner.getCommand()` before the "Unknown command" fallback.
   The command context's `ctx.ui.notify()` is intercepted to capture output,
   which is sent back as a `command_result` WebSocket message.

6. **command_result not rendered.** Slash command results went to `console.log`
   only. Fixed by: (a) adding `injectMessage()` to `RemoteAgent` for pushing
   transient client-side messages; (b) declaring a `CommandResultMessage` type
   via `CustomAgentMessages` declaration merge; (c) registering a message
   renderer for `"command-result"` role; (d) wiring the `onCommandResult`
   listener to inject results into the chat. Note: injected command results
   are **transient** — they exist only in the client's in-memory state. They
   are lost on WebSocket reconnect (the server sends fresh messages which
   replace the client array). This is by design: command results are
   ephemeral UI feedback, not persisted conversation history.

7. **Slash command autocomplete intermittently invisible.** Lit's reactive
   property setters were not reliably triggering re-renders under esbuild's
   decorator transpilation (despite `useDefineForClassFields: false` and
   confirmed proto setters). Fixed by giving `AutocompleteDropdown` explicit
   `show()`/`hide()` methods that call `requestUpdate()` internally, so the
   component owns its render lifecycle.
