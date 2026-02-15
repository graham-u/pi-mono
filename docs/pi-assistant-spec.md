# Pi Assistant: Web Frontend for Local Agent Backend

## 1. Intention

### What This Is

A web-based personal assistant UI that runs in the browser but controls a local
Pi coding-agent backend. The user interacts through a chat interface. Messages
are routed to either the LLM (via the backend) or directly to local command
execution, depending on context.

### Why It Exists

Pi-mono contains two independent interfaces today:

- **coding-agent** — a terminal app that runs locally in Node.js, with full
  filesystem access, bash execution, session persistence to disk, extensions,
  skills, and slash commands.
- **web-ui** — a browser-only chat interface that calls LLM APIs directly from
  the browser, stores sessions in IndexedDB, and has no access to local
  resources.

These don't talk to each other. The coding-agent has all the backend capability
(tools, skills, extensions, sessions on disk) but only a terminal UI. The web-ui
has polished chat components but no backend. This project bridges them.

### Core Requirements

1. **The browser never calls an LLM directly.** All LLM calls go through the
   backend, which uses the coding-agent's existing infrastructure.

2. **Slash commands execute without invoking the LLM.** Typing `/deploy` in the
   chat sends a command to the backend, which executes it and returns the result.
   No tokens spent.

3. **Skills work as they do in the coding-agent.** The LLM sees skill
   descriptions in its system prompt and can decide to load and follow skill
   instructions. Users can also invoke skills explicitly with `/skill:name`.

4. **Sessions are stored on the filesystem**, not in browser storage. The
   backend's session manager handles persistence.

5. **The existing web-ui components are reused**, not forked. The frontend
   imports `@mariozechner/pi-web-ui` and provides a remote Agent adapter.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                     │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  pi-web-ui components (imported, unmodified)          │   │
│  │  ChatPanel → AgentInterface → MessageEditor           │   │
│  │           → MessageList, StreamingMessageContainer     │   │
│  └──────────────────┬───────────────────────────────────┘   │
│                      │                                       │
│                      │ calls .prompt(), .subscribe(), etc.   │
│                      ▼                                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  RemoteAgent (implements Agent interface)              │   │
│  │                                                        │   │
│  │  .prompt(input):                                       │   │
│  │    → if starts with "/" → send as command               │   │
│  │    → else              → send as prompt                 │   │
│  │                                                        │   │
│  │  .subscribe(fn): receives events from server            │   │
│  │  .state: synced from server state                       │   │
│  │  .abort(): sends abort to server                        │   │
│  │  .setModel(), .setThinkingLevel(): forwarded            │   │
│  └──────────────────┬───────────────────────────────────┘   │
│                      │ WebSocket                             │
└──────────────────────┼───────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  Local Server (Node.js)                                       │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  WebSocket / HTTP Layer                                 │  │
│  │  - Receives: prompt, command, steer, follow_up, abort   │  │
│  │  - Sends: streaming events (text_delta, tool_execution, │  │
│  │           agent_start/end, state updates)               │  │
│  └──────────────────┬─────────────────────────────────────┘  │
│                      │                                        │
│                      ▼                                        │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  AgentSession (from @mariozechner/pi-coding-agent SDK)  │  │
│  │                                                          │  │
│  │  - LLM calls (Anthropic, OpenAI, Google, etc.)          │  │
│  │  - Tools: bash, read, write, edit, grep, find, ls       │  │
│  │  - Skills: loaded from ~/.pi/agent/skills/ etc.         │  │
│  │  - Extensions: loaded from ~/.pi/agent/extensions/      │  │
│  │  - Sessions: persisted to ~/.pi/agent/sessions/         │  │
│  │  - Slash commands: registered by extensions             │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### What Goes Where

| Concern | Location | Rationale |
|---------|----------|-----------|
| Chat UI rendering | Browser (pi-web-ui components) | Reuse existing components |
| Input routing (slash vs prompt) | RemoteAgent adapter (browser) | Simple string check before send |
| LLM calls | Backend (AgentSession) | Never from browser |
| Tool execution (bash, file ops) | Backend (AgentSession) | Needs filesystem access |
| Skill loading & discovery | Backend (AgentSession) | Skills are local files |
| Session persistence | Backend (SessionManager) | Writes to ~/.pi/agent/sessions/ |
| Session listing & switching | Backend → frontend via API | Frontend displays, backend stores |
| API key management | Backend | Keys stay on the server |
| Extension loading | Backend (AgentSession) | Extensions are local .ts files |

---

## 3. Package Structure

All new code lives in this fork of pi-mono:

```
packages/
  ai/                  ← existing, unchanged
  agent/               ← existing, unchanged
  coding-agent/        ← existing, unchanged
  web-ui/              ← existing, unchanged
  assistant-server/    ← NEW: backend server
  assistant-frontend/  ← NEW: browser app
```

### packages/assistant-server

A Node.js server that wraps the coding-agent SDK.

**Dependencies:**
- `@mariozechner/pi-coding-agent` (SDK, tools, session manager, skills)
- `ws` (WebSocket server)
- `express` or `fastify` (optional, for HTTP endpoints like session listing)

**Responsibilities:**
- Create and manage an `AgentSession` via the SDK
- Expose it over WebSocket using a protocol based on the existing RPC spec
- Handle slash command routing (commands that don't need LLM)
- Serve the frontend static files (convenience, not required)

### packages/assistant-frontend

A browser app that imports pi-web-ui components and connects to the server.

**Dependencies:**
- `@mariozechner/pi-web-ui` (ChatPanel, AgentInterface, UI components)
- `@mariozechner/pi-agent-core` (Agent types for interface compatibility)
- `vite` (bundler, same as existing web-ui example)

**Responsibilities:**
- Implement RemoteAgent adapter
- Wire up pi-web-ui components
- Manage WebSocket connection lifecycle (connect, reconnect, etc.)

---

## 4. The RemoteAgent Adapter

This is the central piece. It implements the same interface the pi-web-ui
components expect from an Agent, but proxies everything to the server.

### Interface Contract

The pi-web-ui components use these methods and properties on the Agent:

```typescript
interface Agent {
  // State
  state: AgentState;  // messages, model, tools, isStreaming, etc.

  // Actions
  prompt(input: string | AgentMessage | AgentMessage[]): Promise<void>;
  abort(): void;
  setModel(m: Model): void;
  setThinkingLevel(l: ThinkingLevel): void;
  steer(m: AgentMessage): void;
  followUp(m: AgentMessage): void;
  setTools(t: AgentTool[]): void;

  // Events
  subscribe(fn: (e: AgentEvent) => void): () => void;

  // Used by AgentInterface for stream function and API key resolution
  streamFn: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined>;
}
```

### RemoteAgent Implementation

```typescript
class RemoteAgent {
  private _state: AgentState;
  private listeners: Set<(e: AgentEvent) => void>;
  private ws: WebSocket;
  private inputHandlers: InputHandler[] = [];

  // Components read this
  get state(): AgentState { return this._state; }

  // Register input handlers (order matters — first to handle wins)
  addInputHandler(handler: InputHandler) {
    this.inputHandlers.push(handler);
  }

  // Components call this when user hits send
  async prompt(input: string | AgentMessage | AgentMessage[]): Promise<void> {
    const text = typeof input === "string" ? input : extractText(input);

    // Run through handler chain — first handler to return a result wins
    for (const handler of this.inputHandlers) {
      const result = await handler.handle(text, this);
      if (result.handled) return;
    }

    // No handler claimed it — send to LLM as default
    this.ws.send(JSON.stringify({
      type: "prompt",
      message: input
    }));
  }

  // Used by handlers to send commands to the server
  sendCommand(command: string, originalInput?: string) {
    this.ws.send(JSON.stringify({
      type: "command",
      text: command,
      originalInput
    }));
  }

  // Used by handlers to send prompts to the server
  sendPrompt(message: string | AgentMessage) {
    this.ws.send(JSON.stringify({
      type: "prompt",
      message
    }));
  }

  // Components call this
  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Server pushes events over WebSocket, we emit to listeners
  private handleServerEvent(event: AgentEvent) {
    this.updateState(event);
    for (const fn of this.listeners) fn(event);
  }

  abort() { this.ws.send(JSON.stringify({ type: "abort" })); }
  setModel(m) { this.ws.send(JSON.stringify({ type: "set_model", model: m })); }
  setThinkingLevel(l) { this.ws.send(JSON.stringify({ type: "set_thinking_level", level: l })); }

  // streamFn and getApiKey are no-ops — the backend handles these
  streamFn = (() => { throw new Error("LLM calls handled by server"); }) as any;
  getApiKey = async () => undefined;
}
```

### Key Design Decision: Input Handler Chain

The RemoteAgent is not a dumb proxy — it's an input router with a pluggable
handler chain. Every message passes through a series of handlers. Each handler
gets to inspect the input and decide: handle it, transform it, or pass it along.

```
User input
  ↓
Handler 1 (slash commands)    → handled? done. not handled? ↓
Handler 2 (smart home)        → handled? done. not handled? ↓
Handler 3 (deploy commands)   → handled? done. not handled? ↓
  ↓
No handler claimed it → send to LLM (default)
```

This is a chain-of-responsibility pattern. Each handler is code — not a config
entry — so it can do whatever it needs: check a substring, run a regex, call
an LLM for classification, look up state, parse parameters from the input, etc.

### Input Handler Interface

```typescript
interface InputHandlerResult {
  handled: boolean;
}

interface InputHandler {
  /** Human-readable name for debugging/UI */
  name: string;

  /** Optional description */
  description?: string;

  /**
   * Examine the input and optionally handle it.
   *
   * Return { handled: true } to stop the chain.
   * Return { handled: false } to pass to the next handler.
   *
   * Use agent.sendCommand() to execute a backend command (no LLM).
   * Use agent.sendPrompt() to send to the LLM with modified input.
   */
  handle(input: string, agent: RemoteAgent): Promise<InputHandlerResult>;
}
```

### Built-in Handlers

These ship with the assistant and are registered by default:

```typescript
// Handler 1: Slash commands — always first
const slashCommandHandler: InputHandler = {
  name: "slash-commands",
  description: "Routes /command input directly to the server",
  async handle(input, agent) {
    if (!input.startsWith("/")) return { handled: false };
    agent.sendCommand(input);
    return { handled: true };
  }
};
```

### User-Defined Handlers

Handlers are TypeScript files in `~/.pi/assistant/handlers/`. Each exports a
function that returns an InputHandler. They are loaded at startup and inserted
into the chain after the built-in slash command handler.

```
~/.pi/assistant/handlers/
├── smart-home.ts
├── deploy.ts
└── reminders.ts
```

#### Example: Smart Home (forwards natural language to a script)

```typescript
// ~/.pi/assistant/handlers/smart-home.ts
import type { InputHandler } from "@mariozechner/pi-assistant";

export default function (): InputHandler {
  // Keywords that suggest this is a smart home command
  const triggers = ["lights", "thermostat", "temperature", "blinds", "fan"];

  return {
    name: "smart-home",
    description: "Routes home automation commands to lights.sh",

    async handle(input, agent) {
      const lower = input.toLowerCase();
      const isHomeCommand = triggers.some(t => lower.includes(t));
      if (!isHomeCommand) return { handled: false };

      // Forward the full natural language to the script — it handles parsing
      agent.sendCommand(`/! ~/scripts/lights.sh "${input}"`);
      return { handled: true };
    }
  };
}
```

When the user says "set the bedroom lights to 50%", the handler sees "lights",
claims it, and forwards the entire phrase to `lights.sh` which knows how to
parse "bedroom" and "50%". The handler doesn't need to understand the details.

#### Example: Deploy (regex with parameter extraction)

```typescript
// ~/.pi/assistant/handlers/deploy.ts
import type { InputHandler } from "@mariozechner/pi-assistant";

export default function (): InputHandler {
  return {
    name: "deploy",
    description: "Handles deployment commands",

    async handle(input, agent) {
      const match = input.match(/deploy.*?(prod|staging|dev)/i);
      if (!match) return { handled: false };

      const env = match[1].toLowerCase();
      agent.sendCommand(`/! ~/scripts/deploy.sh --${env}`);
      return { handled: true };
    }
  };
}
```

#### Example: Using an LLM to classify intent

```typescript
// ~/.pi/assistant/handlers/intent-classifier.ts
import type { InputHandler } from "@mariozechner/pi-assistant";

export default function (): InputHandler {
  return {
    name: "intent-classifier",
    description: "Uses a small LLM to classify ambiguous commands",

    async handle(input, agent) {
      // Only run if input is short and looks command-like
      if (input.length > 100) return { handled: false };

      // Call a small/fast model for classification
      const response = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        body: JSON.stringify({
          model: "llama3.2:1b",
          prompt: `Classify this as one of: home_automation, deploy, reminder, or none.\nInput: "${input}"\nCategory:`,
          stream: false
        })
      });
      const result = await response.json();
      const category = result.response.trim().toLowerCase();

      switch (category) {
        case "home_automation":
          agent.sendCommand(`/! ~/scripts/lights.sh "${input}"`);
          return { handled: true };
        case "deploy":
          agent.sendCommand(`/! ~/scripts/deploy.sh`);
          return { handled: true };
        case "reminder":
          agent.sendCommand(`/! ~/scripts/remind.sh "${input}"`);
          return { handled: true };
        default:
          return { handled: false };
      }
    }
  };
}
```

### Handler Registration

```typescript
// In the frontend app initialization
const agent = new RemoteAgent("ws://localhost:3001");

// Built-in: always first
agent.addInputHandler(slashCommandHandler);

// User handlers: loaded from ~/.pi/assistant/handlers/
// Server provides these at startup (they're TypeScript files on the backend,
// but the handler logic runs on the frontend for latency reasons)
const userHandlers = await agent.loadHandlers();
for (const handler of userHandlers) {
  agent.addInputHandler(handler);
}

// Default LLM fallthrough is implicit — if no handler claims it, prompt() sends
// to the LLM automatically.
```

### Where Handlers Run

Handlers run on the **server side**, not in the browser. This is important
because:

- Handlers may need filesystem access (reading config, checking state)
- Handlers may call local services (Ollama for classification, local APIs)
- Handlers execute commands via `agent.sendCommand()` which ultimately runs
  on the server anyway
- Keeping them server-side means the browser doesn't need network access to
  local services

The flow is:

```
Browser                              Server
  │                                    │
  │  prompt("set bedroom to 50%")      │
  │ ──────────────────────────────────>│
  │                                    │ Run handler chain
  │                                    │   1. slash? no
  │                                    │   2. smart-home? yes → lights.sh
  │                                    │
  │  { type: "command_result", ... }   │
  │ <──────────────────────────────────│
```

This means the WebSocket protocol gains one message type:

```typescript
// Client → Server
{ type: "input", text: string }   // Raw user input — server runs handler chain

// The server decides whether it's a command or LLM prompt.
// "prompt" and "command" types still exist for cases where the frontend
// wants to bypass the handler chain (e.g., programmatic use).
```

### Design Notes

- **Handlers are code, not config.** A JSON routing table can't forward
  the original natural language to a script, or extract parameters with
  custom logic, or call an LLM for classification. Code can.
- **Order matters.** Handlers are checked in registration order. Put specific
  handlers before broad ones. The slash command handler is always first.
- **Handlers are async.** A handler can take time (e.g., calling an LLM for
  classification) without blocking others.
- **Handlers can transform.** A handler doesn't just match-and-forward — it
  decides exactly what to send. "Set bedroom lights to 50%" becomes
  `lights.sh "set bedroom lights to 50%"` — the handler chose to pass the
  raw input. Another handler might extract parameters and send something
  entirely different.
- **The LLM is always the fallback.** If no handler claims the input, it goes
  to the LLM. This means you never lose the conversational assistant — you're
  just adding fast-paths for known commands.
- **Handlers are hot-reloadable.** Since they're files in a directory, the
  server can watch for changes and reload without restart.

---

## 5. WebSocket Protocol

Based on the coding-agent's existing RPC protocol, adapted for WebSocket.

### Client → Server Messages

```typescript
// Normal LLM prompt
{ type: "prompt", message: string, images?: ImageContent[] }

// Slash command (no LLM)
{ type: "command", text: string }

// Interrupt agent mid-run
{ type: "steer", message: string }

// Queue for after current run
{ type: "follow_up", message: string }

// Cancel current operation
{ type: "abort" }

// State queries
{ type: "get_state" }
{ type: "get_messages" }
{ type: "list_sessions" }                    // list available sessions
{ type: "switch_session", sessionPath: string }
{ type: "new_session" }
{ type: "rename_session", sessionPath: string, name: string }
{ type: "delete_session", sessionPath: string }

// Model control
{ type: "set_model", provider: string, modelId: string }
{ type: "set_thinking_level", level: string }
{ type: "get_available_models" }
```

### Server → Client Messages

```typescript
// Streaming events (same as AgentEvent types)
{ type: "agent_start" }
{ type: "agent_end", messages: AgentMessage[] }
{ type: "turn_start" }
{ type: "turn_end", message: AgentMessage }
{ type: "message_start", message: AgentMessage }
{ type: "message_update", message: AgentMessage, assistantMessageEvent: Delta }
{ type: "message_end", message: AgentMessage }
{ type: "tool_execution_start", toolCallId: string, toolName: string }
{ type: "tool_execution_update", toolCallId: string, data: any }
{ type: "tool_execution_end", toolCallId: string, result: any }

// Command responses (for slash commands)
{ type: "command_result", command: string, success: boolean, output: string }

// State sync
{ type: "state_sync", state: AgentState }

// Response to queries
{ type: "response", command: string, data: any }
```

---

## 6. Server Implementation

### Core Structure

```typescript
// packages/assistant-server/src/server.ts

import { createAgentSession } from "@mariozechner/pi-coding-agent";
import { WebSocketServer } from "ws";

const { session } = await createAgentSession({
  cwd: process.cwd(),
  // All coding-agent defaults: tools, skills, extensions
});

const wss = new WebSocketServer({ port: 3001 });

wss.on("connection", (ws) => {
  // Subscribe to agent events, forward to client
  const unsubscribe = session.agent.subscribe((event) => {
    ws.send(JSON.stringify(event));
  });

  ws.on("message", async (data) => {
    const msg = JSON.parse(data);

    switch (msg.type) {
      case "prompt":
        await session.prompt(msg.message);
        break;

      case "command":
        await handleCommand(session, msg.text, ws);
        break;

      case "abort":
        session.abort();
        break;

      case "get_state":
        ws.send(JSON.stringify({
          type: "state_sync",
          state: session.agent.state
        }));
        break;

      // ... other message types
    }
  });

  ws.on("close", () => unsubscribe());
});
```

### Command Handler

```typescript
async function handleCommand(
  session: AgentSession,
  text: string,
  ws: WebSocket
) {
  // text is e.g. "/deploy --prod" or "/skill:brave-search query"

  // 1. Check registered extension commands
  const extensionCommands = session.getCommands();
  const cmdName = text.slice(1).split(" ")[0];
  const cmdArgs = text.slice(1 + cmdName.length).trim();

  const extCmd = extensionCommands.find(c => c.name === cmdName);
  if (extCmd) {
    // Execute extension command directly — no LLM
    await extCmd.handler(cmdArgs, session);
    ws.send(JSON.stringify({
      type: "command_result",
      command: cmdName,
      success: true,
      output: "Command executed"
    }));
    return;
  }

  // 2. Check if it's a skill invocation (/skill:name args)
  if (text.startsWith("/skill:")) {
    // Let the session expand it — this injects the skill content
    // into the prompt and DOES call the LLM (the skill instructs it)
    await session.prompt(text);
    return;
  }

  // 3. Direct bash shorthand: /bash command or /! command
  if (cmdName === "bash" || cmdName === "!") {
    const result = await executeBash(cmdArgs);
    ws.send(JSON.stringify({
      type: "command_result",
      command: "bash",
      success: result.exitCode === 0,
      output: result.stdout + result.stderr
    }));
    return;
  }

  // 4. Unknown command
  ws.send(JSON.stringify({
    type: "command_result",
    command: cmdName,
    success: false,
    output: `Unknown command: ${cmdName}`
  }));
}
```

---

## 7. Skills Integration (Agent Skills Standard)

Pi implements the **standardized Agent Skills spec** (https://agentskills.io).
This is not a loose "skills" concept — it's the specific standard where skills
are directories containing a `SKILL.md` file with YAML frontmatter declaring
name and description, and the agent discovers them, loads their descriptions
into context, and uses them when relevant.

The implementation is in `packages/coding-agent/src/core/skills.ts` and
references the spec directly (line 285-286). Because the assistant backend uses
the full coding-agent via `createAgentSession()`, **the entire skills system
carries over with zero additional work.**

### Skill Format (per Agent Skills standard)

Each skill is a directory with a required `SKILL.md`:

```
~/.pi/agent/skills/brave-search/
├── SKILL.md          ← required, YAML frontmatter + instructions
├── search.js         ← any supporting files the skill needs
└── content.js
```

```markdown
---
name: brave-search
description: Web search via Brave Search API. Use for searching documentation,
  facts, or any web content.
disable-model-invocation: false   # optional, hides from LLM if true
---

# Brave Search

## Search
bash ./search.js "query"
```

Validation follows the spec: name must be `[a-z0-9-]`, max 64 chars, must match
parent directory. Description is required, max 1024 chars.

### Discovery

At startup, `loadSkills()` scans:
- `~/.pi/agent/skills/` (global, user-installed skills)
- `.pi/skills/` (project-local skills)
- Custom paths via settings or `--skill` CLI flags

Skills are deduplicated by file path (resolving symlinks) and by name
(first-found wins, collisions produce warnings).

### System Prompt Injection (Progressive Disclosure)

`formatSkillsForPrompt()` produces XML per the Agent Skills integration spec:

```xml
<available_skills>
  <skill>
    <name>brave-search</name>
    <description>Web search via Brave Search API...</description>
    <location>/home/user/.pi/agent/skills/brave-search/SKILL.md</location>
  </skill>
</available_skills>
```

The system prompt instructs the LLM: "Use the read tool to load a skill's file
when the task matches its description." Only names, descriptions, and file
locations are injected — not the full skill body. The LLM decides when to load
the full content based on semantic relevance to the user's request.

Skills with `disable-model-invocation: true` are excluded from the system prompt
entirely and can only be invoked explicitly.

### How Skills Are Triggered

Three mechanisms, all preserved in the assistant:

1. **LLM decides (semantic matching)** — the LLM reads the skill descriptions
   in the system prompt, recognizes relevance to the user's request, and uses
   the `read` tool to load the full SKILL.md. This is the primary mechanism and
   requires no user action — the LLM matches on keywords and intent from the
   description.

2. **Explicit invocation** — the user types `/skill:brave-search react hooks`.
   The session expands this by reading the SKILL.md, wrapping its content in a
   `<skill>` XML block, and appending the user's arguments. This then goes to
   the LLM with full skill instructions.

3. **Slash command palette** — skills register as `/skill:name` commands and
   appear in any command listing UI.

### What This Means for the Frontend

- Mechanism 1 (LLM decides) works automatically — it's part of the system
  prompt on the backend. No frontend involvement needed.
- Mechanism 2 (explicit `/skill:name`) is handled by the command router. The
  RemoteAgent detects the `/` prefix and sends it to the server. The server's
  command handler recognizes `/skill:` and routes it through
  `session.prompt(text)` which expands the skill content before sending to the
  LLM.
- Mechanism 3 (command palette) — the server can expose the list of available
  skills via `get_commands`, and the frontend can render them in a UI.
- **Adding new skills** requires no code changes — drop a directory with a
  SKILL.md into `~/.pi/agent/skills/` and restart the server.

---

## 8. Frontend Implementation

### App Structure

The frontend is structurally similar to `packages/web-ui/example/` but with
RemoteAgent instead of a local Agent.

```typescript
// packages/assistant-frontend/src/main.ts

import { ChatPanel } from "@mariozechner/pi-web-ui";
import { RemoteAgent } from "./remote-agent.js";

// Connect to backend
const agent = new RemoteAgent("ws://localhost:3001");
await agent.connect();

// Create UI (same pattern as web-ui example)
const chatPanel = new ChatPanel();
await chatPanel.setAgent(agent, {
  // No onApiKeyRequired — backend handles keys
  // No toolsFactory — backend has the tools
});

// Render
document.getElementById("app").appendChild(chatPanel);
```

### Session Management

Sessions are on the backend filesystem. The server resumes the most recent
session on startup via `SessionManager.continueRecent(cwd)`. The frontend
displays a sidebar with the session list and provides controls to create new
sessions and switch between them.

```typescript
// Frontend requests session list
const sessions = await agent.listSessions();
// Returns SessionInfoDTO[]: { path, id, name?, created, modified, messageCount, firstMessage, cacheExpiresAt? }

// Create a new session
await agent.newSession();

// Switch to a different session
await agent.switchSession(sessionPath);

// Delete a session (file removed from disk)
await agent.deleteSession(sessionPath);
```

On new/switch, the server sends `state_sync` + `get_messages` to the
requesting client only. Each WebSocket client independently binds to a session
from a shared pool — switching on one device does not affect other connected
clients. If two clients view the same session, both receive that session's
streaming events.

The frontend uses a custom session sidebar (not the pi-web-ui SessionListDialog)
that shows session name or first-message preview, relative date, and message
count. The active session is highlighted and shows a pencil icon for inline
renaming — clicking it turns the name into an editable text input (Enter/blur
saves, Escape cancels). On desktop the sidebar is always visible (260px); on
mobile it's hidden behind a hamburger menu.

### API Key Handling

The `AgentInterface` component checks for API keys before sending (line 213-229
of AgentInterface.ts). In the assistant frontend, we handle this by:

- Setting `agent.getApiKey` to return a dummy truthy value (the real key is on
  the server)
- Or setting `onApiKeyRequired` to a no-op that returns `true`

The backend manages real API keys via its own configuration
(`~/.pi/agent/settings.json` or environment variables).

---

## 9. Implementation Order

### Phase 1: Minimal Working Connection

1. **Create `packages/assistant-server/`** with a WebSocket server that wraps
   `createAgentSession()` from the SDK.
2. **Create `packages/assistant-frontend/`** with a RemoteAgent adapter and
   ChatPanel wired up.
3. **Implement the prompt flow:** user types → RemoteAgent sends over WS →
   server calls `session.prompt()` → events stream back → components render.
4. **Verify:** send a message, see the LLM response stream in the browser.

### Phase 2: Slash Commands

5. **Add command routing** in RemoteAgent (check for `/` prefix).
6. **Add command handler** on server (extension commands, `/bash`, `/!`).
7. **Add `/skill:name` routing** through `session.prompt()` for skill expansion.
8. **Verify:** type `/! ls -la`, see output in chat without LLM call.

### Phase 3: Session Management

9. **Add session list endpoint** on server (uses `SessionManager.list()`).
10. **Add session switching** (server loads session, sends state sync).
11. **Add new session** creation.
12. **Wire up session UI** in frontend (either adapt SessionListDialog or build
    simple list).

### Phase 4: Polish

13. **Model selection** — server exposes available models, frontend shows selector.
14. **Reconnection** — WebSocket auto-reconnect with state resync.
15. **Command palette** — show available commands/skills in UI. ✅ Implemented as
    autocomplete dropdown on `/` prefix with fuzzy filtering.
16. **Error handling** — connection loss, command failures, LLM errors.

---

## 10. What We Don't Change

The following existing packages remain unmodified:

- `packages/agent/` — the Agent core class
- `packages/ai/` — the LLM API layer
- `packages/coding-agent/` — the terminal agent (we import its SDK)
- `packages/web-ui/` — the UI components (we import them)

If we find we need a small change (e.g., making the API key check in
AgentInterface bypassable), we make it backwards-compatible so the existing
web-ui example still works.

---

## 11. Open Questions

1. ~~**Single vs multi-session server**~~ — Resolved: the server maintains a
   session pool (`Map<string, AgentSession>`) and each WebSocket client
   independently binds to its own session.

2. **Authentication** — for local-only use, probably unnecessary. But if exposed
   on a network, needs consideration.

3. **File upload** — the web-ui supports attachments. Should these be sent to
   the server and written to disk? The `user-with-attachments` message type
   exists in the agent.

4. **Tool renderers** — the web-ui has renderers for tool outputs (BashRenderer,
   etc.). These may need adaptation since tool results will come from the server
   in a different shape than browser-executed tools.

5. **Artifacts** — the web-ui's artifact system (interactive HTML, SVG) runs in
   browser sandboxes. This can stay browser-side since artifacts are a rendering
   concern, not a backend concern.
