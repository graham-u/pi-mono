# Daily Planner Implementation Research

Research notes on implementing a scheduled daily planner that integrates with the Momo memory system.

## Background

The goal is to have the assistant produce a daily planner (calendar events, to-dos, reminders, context-aware advice) on a schedule. The planner should:

1. Appear as a natural assistant message in the conversation
2. Be enriched by Momo recalled memories (e.g. "you mentioned being anxious about this appointment")
3. Have the exchange captured by Momo for future recall
4. Be triggered automatically by a cron job

A data-gathering script already exists at `/home/grahamu/projects/PIM/daily-planner/prepare_daily_planner.sh --print`, and presentation instructions exist in `/home/grahamu/projects/PIM/daily-planner/daily_planner_task.md`.

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
  │   └─ Composes planner using script output + memory context
  │
  ├─ agent_end  →  Momo capture stores the exchange
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
| **Daily planner skill** | SKILL.md containing instructions: run the data script, how to present results |
| **Data gathering script** | `prepare_daily_planner.sh --print` — deterministic, fetches calendar/todos/etc. |
| **LLM** | Orchestrator — recognises the skill, runs the script via bash tool, composes the planner enriched with memory context |
| **Momo capture** | Stores the user/assistant exchange after the agent loop completes |

### The trigger message

The user message in chat will be "Generate my daily planner" (or similar short phrase). This is visible in the conversation, which is acceptable — it's a brief, natural-looking prompt. The skill instructions never appear in the user message; they live in the SKILL.md file which the LLM reads via the read tool.

### What the skill file will contain

The daily planner SKILL.md will be based on the existing `daily_planner_task.md`, adapted to work as a skill:

- **Frontmatter**: name, description with trigger phrases
- **Instructions**: run the data gathering script, presentation guidelines
- **Response format**: focus on today and next few days, relate context items to each other, occasional tips

The existing `daily_planner_task.md` maps almost directly — the main change is adding frontmatter and adapting the wording from "prompt for external LLM" to "skill instructions for the assistant".

### Cost considerations

This approach costs one LLM call per trigger (model inference + tool calls for reading the skill file and running the script). For a once-daily schedule this is acceptable, but worth monitoring:

- The LLM needs to: read the skill file (1 tool call), run the bash script (1 tool call), compose the response
- Total cost depends on model choice and output length
- If cost proves too high, could revisit with a cheaper model or the offline injection approach (accepting no memory integration)

## Implementation Tasks

1. **Create the SKILL.md** — adapt `daily_planner_task.md` into a skill file with proper frontmatter, placed where the skill loader will find it
2. **Add `/api/trigger` endpoint** — new HTTP handler that calls `session.prompt()` instead of `appendMessage()`, with guards for when the agent is already streaming
3. **Set up the cron job** — `curl -X POST http://localhost:3001/api/trigger -H 'Content-Type: application/json' -d '{"prompt":"Generate my daily planner"}'`
4. **Test the full flow** — verify Momo recall provides useful context, capture stores the exchange, and the planner renders well in the UI

## Alternatives Considered (Not Chosen)

### Option A: Cron job calls Momo directly

Inject via existing `/api/inject`, then separately POST to Momo's ingest API to store the content. No code changes needed, but Momo recall doesn't fire at injection time — the planner can't be enriched with memories. The content in Momo is disconnected from the conversation session.

### Option B: Modify inject endpoint to fire extension events

Emit `before_agent_start` / `agent_end` synthetically after injection. Fragile because these events expect specific payloads (a user prompt, an agent run's message list) that would need to be fabricated. Tightly coupled to event payload structure.

## Memory Storage Approach

Rather than relying on `autoCapture` (the automatic bulk capture at `agent_end`), memory storage is handled by the LLM using the `momo_store` tool selectively. This produces higher quality memories — focused insights rather than raw conversation dumps.

The daily planner skill includes a "Memory" section that prompts the LLM to consider storing notable observations after composing its full response. This means the LLM can store things like patterns it spotted or connections between context items, rather than just echoing back the raw planner data.

`autoCapture` is disabled in `~/.pi/momo.jsonc`. See the appendix below for a compatibility issue that also affects it.

## Open Questions

1. Can `session.prompt()` be called safely from an HTTP handler? What happens if the agent is mid-turn? (The `prompt()` method throws if `isStreaming` with no `streamingBehavior` set — need a guard or queue.)
2. Should the trigger prompt be configurable, or is a hardcoded "Generate my daily planner" sufficient?

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
