# Daily Planner Implementation Research

Research notes on implementing a scheduled daily planner that integrates with the Momo memory system.

## Background

The goal is to have the assistant produce a daily planner (calendar events, to-dos, reminders, context-aware advice) on a schedule. The planner should:

1. Appear as a natural assistant message in the conversation
2. Be enriched by Momo recalled memories (e.g. "you mentioned being anxious about this appointment")
3. Store useful observations as memories for future recall
4. Be triggered automatically by a cron job

A data-gathering script exists at `/home/grahamu/projects/PIM/daily-planner/prepare_daily_planner.sh --print`. The skill file is at `/home/grahamu/projects/PIM/daily-planner/SKILL.md`, symlinked into `~/.pi/agent/skills/daily-planner`.

## Why the Current Inject Endpoint Doesn't Work

The existing `POST /api/inject` endpoint (`packages/assistant-server/src/http.ts`) bypasses the agent loop entirely. It calls `agent.appendMessage()` and `sessionManager.appendMessage()` directly — no extension events fire.

Momo's hooks only fire during the normal agent pipeline:

| Hook | Event | When it fires |
|------|-------|---------------|
| **Recall** | `before_agent_start` | After user prompt, before LLM runs |
| **Capture** | `agent_end` | After agent loop completes |

Both are emitted inside `AgentSession.prompt()`. The inject endpoint never calls `prompt()`, so Momo is completely bypassed.

## How Skills Work (Key to the Solution)

Skills in the pi SDK have a two-step invocation model:

1. **System prompt**: `formatSkillsForPrompt()` (`coding-agent/src/core/skills.ts:290`) appends skill names, descriptions, and file locations to the system prompt as `<available_skills>` XML. The prompt tells the LLM: *"Use the read tool to load a skill's file when the task matches its description."*

2. **LLM-driven activation**: When the LLM sees a user message that matches a skill's description, it reads the SKILL.md file via the read tool and follows the instructions inside.

This means the user's message stays exactly as typed. The skill instructions are never expanded into the user message — unlike `/skill:name` invocation which does text expansion. The LLM recognises the match from the description and loads the instructions itself.

This is how existing skills (e.g. gut-check-progress) work: the user types a natural phrase like "gut check update: [observation]" and the LLM matches it to the skill description, reads the full instructions, and follows them.

## Chosen Approach: Scheduled Skill-Triggered Prompt

### Architecture

```
Cron job
  │
  │  POST /api/trigger  {"prompt": "Generate my daily planner"}
  ▼
Assistant Server
  │
  │  session.prompt("Generate my daily planner")
  ▼
AgentSession.prompt() — full pipeline
  │
  ├─ before_agent_start  →  Momo recall injects memories
  │
  ├─ LLM sees: trigger prompt + Momo memories + skill description in system prompt
  │   │
  │   ├─ Recognises daily-planner skill matches
  │   ├─ Reads SKILL.md for full instructions (via read tool)
  │   ├─ Runs prepare_daily_planner.sh (via bash tool)
  │   ├─ Composes planner using script output + memory context
  │   └─ Optionally stores notable observations via momo_store tool
  │
  └─ WebSocket broadcast  →  All connected UIs update
```

### How the pieces fit together

| Component | Role |
|-----------|------|
| **Cron job** | Fires on schedule, calls `POST /api/trigger` |
| **`/api/trigger` endpoint** | New endpoint that calls `session.prompt()` (unlike `/api/inject` which bypasses the pipeline) |
| **`session.prompt()`** | Enters the normal agent pipeline — all extension hooks fire |
| **Momo recall** | Injects relevant memories before the LLM runs |
| **Daily planner skill** | SKILL.md containing instructions: run the data script, how to present results, when to store memories |
| **Data gathering script** | `prepare_daily_planner.sh --print` — deterministic, fetches calendar/todos/location |
| **LLM** | Orchestrator — recognises the skill, runs the script via bash tool, composes the planner enriched with memory context, selectively stores observations |

### The trigger message

The user message in chat will be "daily planner" (or similar short phrase). This is visible in the conversation, which is acceptable — it's a brief, natural-looking prompt. The skill instructions never appear in the user message; they live in the SKILL.md file which the LLM reads via the read tool.

### Verified behavior

The following has been tested and confirmed working:

- **Momo recall**: `<momo-context>` is injected before the LLM runs, containing profile signals and relevant memory matches
- **Skill activation**: the LLM reads the SKILL.md via the read tool when it sees a matching trigger phrase
- **Script execution**: the LLM runs `prepare_daily_planner.sh --print` via bash tool
- **Memory storage**: the LLM uses `momo_store` to save notable observations when the skill instructions prompt it to

### Cost considerations

This approach costs one LLM call per trigger (model inference + tool calls for reading the skill file and running the script). For a once-daily schedule this is acceptable, but worth monitoring:

- The LLM needs to: read the skill file (1 tool call), run the bash script (1 tool call), compose the response, optionally store memories (1 tool call)
- Total cost depends on model choice and output length
- If cost proves too high, could revisit with a cheaper model or the offline injection approach (accepting no memory integration)

## Implementation Status

| Task | Status |
|------|--------|
| Create SKILL.md | Done — `~/projects/PIM/daily-planner/SKILL.md`, symlinked to `~/.pi/agent/skills/daily-planner` |
| Remove legacy memory from script | Done — `prepare_daily_planner.sh` no longer reads from `main-openclaw-agent/memory/` |
| Add `/api/trigger` endpoint | TODO — new HTTP handler that calls `session.prompt()` with guards for streaming state |
| Set up cron job | TODO — `curl -X POST http://localhost:3001/api/trigger -H 'Content-Type: application/json' -d '{"prompt":"daily planner"}'` |

## Memory Storage Approach

Rather than relying on `autoCapture` (the automatic bulk capture at `agent_end`), memory storage is handled by the LLM using the `momo_store` tool selectively. This produces higher quality memories — focused insights rather than raw conversation dumps.

The daily planner skill includes a "Memory" section that prompts the LLM to consider storing notable observations after composing its full response. The bar for storage is: "Would recalling this in a future planner make that planner meaningfully better?" Examples include patterns forming (positive or negative), progress towards goals, or significant upcoming events with personal context.

`autoCapture` is disabled in `~/.pi/momo.jsonc`. See the appendix below for a compatibility issue that also affects it.

## Alternatives Considered (Not Chosen)

### Option A: Cron job calls Momo directly

Inject via existing `/api/inject`, then separately POST to Momo's ingest API to store the content. No code changes needed, but Momo recall doesn't fire at injection time — the planner can't be enriched with memories. The content in Momo is disconnected from the conversation session.

### Option B: Modify inject endpoint to fire extension events

Emit `before_agent_start` / `agent_end` synthetically after injection. Fragile because these events expect specific payloads (a user prompt, an agent run's message list) that would need to be fabricated. Tightly coupled to event payload structure.

## Open Questions

1. Can `session.prompt()` be called safely from an HTTP handler? What happens if the agent is mid-turn? (The `prompt()` method throws if `isStreaming` with no `streamingBehavior` set — need a guard or queue.)
2. Should the trigger prompt be configurable, or is a hardcoded "daily planner" sufficient?

## Appendix: autoCapture Compatibility Issue

During this investigation we found that Momo's `autoCapture` feature appears broken due to a mismatch between the pi-momo extension and the pi SDK.

**The issue:** pi-momo's capture handler checks `isCaptureEvent(event)` before processing, which requires `event.success` to be truthy:

```javascript
// pi-momo: dist/index.js line 1891
function isCaptureEvent(event) {
  if (!event.success)   // ← fails here
    return false;
  if (!Array.isArray(event.messages))
    return false;
  return event.messages.length > 0;
}
```

But the pi SDK's `AgentEndEvent` type does not include a `success` field:

```typescript
// coding-agent: src/core/extensions/types.ts line 493
export interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
}
```

The event is forwarded without enrichment at `agent-session.ts:428`:

```typescript
await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
```

**Result:** `event.success` is always `undefined`, so `isCaptureEvent` returns `false` and capture silently skips every turn. No Momo ingest calls are made.

**Evidence:** Momo container logs show `POST /api/v1/memories` calls only from explicit `momo_store` tool usage (triggered by the LLM), never from `agent_end` autoCapture. The recall side (`POST /api/v1/search` and `POST /api/v1/profile:compute`) works correctly.

**Potential fix (not implemented):** Add `success: true` to the `agent_end` event in `agent-session.ts:428`. This is a one-line change to upstream code but would need tracking in `docs/upstream-modifications.md`. Since we're using selective `momo_store` instead, this is not urgent.
