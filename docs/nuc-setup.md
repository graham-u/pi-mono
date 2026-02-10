# Pi Assistant — NUC Setup Guide

Instructions for setting up the pi-assistant on the NUC. Steps are written for
Claude Code to execute unless marked with **[HUMAN]**, which means the human
needs to provide information or take action before continuing.

## Prerequisites

- Node.js v22+ (`node -v` to verify)
- Git
- npm

## 1. Clone the repo

```bash
cd ~
git clone https://github.com/graham-u/pi-mono.git
cd pi-mono
```

## 2. Install dependencies

```bash
npm install
```

Note: `npm install` can occasionally fail if the xlsx CDN returns 403. Retry if this happens.

## 3. Environment variables

**[HUMAN]** Provide your Anthropic API key and Tailscale domain, then Claude Code will create the `.env` file.

Create `.env` in the repo root (`~/pi-mono/.env`):

```bash
cat > .env <<'EOF'
ANTHROPIC_API_KEY=<your-key>
VITE_ALLOWED_HOSTS=.<your-tailnet>.ts.net
EOF
```

- `ANTHROPIC_API_KEY` — required for the assistant to call the LLM
- `VITE_ALLOWED_HOSTS` — required for Vite to accept connections via Tailscale (set to your tailnet domain, e.g. `.foo-bar.ts.net`)

## 4. Pi agent configuration

The assistant reads configuration from `~/.pi/agent/`. Create the directory structure and config files:

```bash
mkdir -p ~/.pi/agent/skills
```

### settings.json

```bash
cat > ~/.pi/agent/settings.json <<'EOF'
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-haiku-4-5",
  "defaultThinkingLevel": "off"
}
EOF
```

### SYSTEM.md

The system prompt for the assistant. This replaces the default coding-agent prompt entirely.

```bash
cat > ~/.pi/agent/SYSTEM.md <<'EOF'
You are a helpful personal assistant. Be concise and direct in your responses.
EOF
```

### Skills

Skills are Markdown files (or directories containing `SKILL.md`) placed in `~/.pi/agent/skills/`.

Create the test skill:

```bash
cat > ~/.pi/agent/skills/test-skill.md <<'EOF'
---
name: test-greeting
description: Generate a friendly greeting. Use when the user asks for a greeting or says "test skill".
---

# Test Greeting Skill

When invoked, respond with a short, friendly greeting that includes:
1. A warm hello
2. Confirmation that the skill system is working
3. The current date and time

Keep it brief — just 2-3 sentences.
EOF
```

**[HUMAN]** The gut-check-skill repo already exists on this machine. Provide the path to it so Claude Code can create the symlink:

```bash
ln -s /path/to/gut-check-skill ~/.pi/agent/skills/gut-check-skill
```

Skills are discovered at server startup. Adding or removing skills requires a server restart.

## 5. Build

```bash
cd ~/pi-mono

# Build packages in order
cd packages/tui && npx tsc -p tsconfig.build.json --target ES2024 --skipLibCheck && cd ../..
cd packages/ai && npx tsc -p tsconfig.build.json --skipLibCheck && cd ../..
cd packages/agent && npx tsc -p tsconfig.build.json --skipLibCheck && cd ../..
cd packages/coding-agent && npx tsc -p tsconfig.build.json --skipLibCheck && cd ../..
cd packages/web-ui && npx tsc -p tsconfig.build.json --skipLibCheck && cd ../..
cd packages/web-ui && npx @tailwindcss/cli -i ./src/app.css -o ./dist/app.css --minify && cd ../..
cd packages/assistant-server && npx tsc -p tsconfig.build.json --skipLibCheck && cd ../..
```

## 6. Run

Both commands must be run from the **repo root** (so dotenv discovers `.env`):

```bash
# Terminal 1: backend
node packages/assistant-server/dist/cli.js --port 3001

# Terminal 2: frontend
cd packages/assistant-frontend && npx vite
```

The frontend runs on port 3000, the backend on port 3001. Vite proxies `/ws` and `/api` to the backend automatically.

## 7. Tailscale (remote access)

```bash
# Expose the frontend via Tailscale
tailscale serve 3000
```

On Linux/NUC, Vite typically binds to both IPv4 and IPv6, so the default `tailscale serve` should work. On macOS, Vite may bind IPv6 only — in that case use `tailscale serve http://[::1]:3000`.

Multiple clients can connect simultaneously but share the same backend session.

## 8. Claude Code project memory

**[HUMAN]** Claude Code project memory is machine-specific. To set it up:

1. Start a Claude Code session in `~/pi-mono` on the NUC — this creates the project memory directory automatically
2. Ask Claude Code to save the following as its project memory (`MEMORY.md`):

```markdown
# Pi Assistant Project Memory

## Project Overview
- Fork of pi-mono adding a web-based assistant UI backed by local coding-agent SDK
- Two new packages: `assistant-server` (WebSocket on :3001) and `assistant-frontend` (Vite on :3000)

## Key Architecture Decisions
- Project context files (CLAUDE.md, AGENTS.md) are disabled via `agentsFilesOverride` — the assistant is NOT a coding agent
- System prompt comes from `~/.pi/agent/SYSTEM.md` (SDK built-in mechanism)
- Default model set in `~/.pi/agent/settings.json`
- API keys loaded from `.env` at repo root via dotenv
- `getWsUrl()` always uses Vite `/ws` proxy path — works on localhost and via reverse proxy/Tailscale
- `VITE_ALLOWED_HOSTS` env var controls Vite host checking (loaded via `loadEnv` in vite.config.ts)

## System Prompt Assembly
- Built by `buildSystemPrompt()` in `packages/coding-agent/src/core/system-prompt.ts`
- When `SYSTEM.md` exists, it **replaces** the default prompt entirely (but tools, skills, context files, metadata still appended)
- `APPEND_SYSTEM.md` (`.pi/APPEND_SYSTEM.md` or `~/.pi/agent/APPEND_SYSTEM.md`) adds content after the base — useful for cherry-picking parts of the default prompt
- Default prompt includes self-documenting references to Pi's own docs/examples directories
- Override points: `systemPromptOverride`, `appendSystemPromptOverride` on DefaultResourceLoader

## Build Chain
`tui` (needs --target ES2024) → `ai` → `agent` → `coding-agent` → `web-ui` (also needs CSS via tailwindcss) → `assistant-server`
- Frontend uses Vite (no manual build needed in dev)
- All packages use `tsc -p tsconfig.build.json --skipLibCheck`
- web-ui changes need rebuild: `cd packages/web-ui && npx tsc -p tsconfig.build.json --skipLibCheck`

## Bugs Fixed
- RemoteAgent `message_end`: was double-adding user messages (already added at `message_start`)
- RemoteAgent `agent_end`: `msg.messages` is only current run, not full history — don't use it to replace state
- WebSocket auto-reconnect added (1s x5, 2s x5, then 5s) with "Reconnecting..." status
- Model search case-sensitivity: search target was lowercased but input wasn't — broke on mobile auto-capitalization (upstream fix in web-ui)
- Mobile viewport: `100dvh` override on `.h-screen` in app.css fixes address bar cutting off content

## Known Remaining Issues
- `state_sync` uses fake `agent_start`/`agent_end` events to trigger re-render (cosmetic, not a bug)
- `command_result` not rendered in chat (goes to console.log)
- Extension commands not fully wired (need ExtensionCommandContext)

## SDK Override Points Used
- `agentsFilesOverride` on `DefaultResourceLoader` — skip project context files
- `resourceLoader` option on `createAgentSession()` — pass custom loader
- `sessionManager` option available but not yet used (could use `continueRecent()` for session persistence)

## Gotchas
- `npm install` can fail if xlsx CDN returns 403
- Pre-commit hook runs biome lint — will fail on unused imports
- Biome auto-reorders imports on check; let it do its thing before committing
- The user prefers to be asked before committing and prefers logical commit splits
- Vite config (`vite.config.ts`) doesn't auto-load `.env` via `process.env` — must use `loadEnv()` from Vite

## Remote Access (Tailscale)
- `tailscale serve 3000` proxies tailnet traffic to local Vite
- Set `VITE_ALLOWED_HOSTS=.your-tailnet.ts.net` in `.env`
- Multiple clients share the same backend session (both see all events)

## Docs
- `docs/pi-assistant-spec.md` — full specification
- `docs/assistant-implementation.md` — implementation notes (for contributors)
- `docs/assistant-guide.md` — user-facing configuration guide
```

## Verification

1. Open `http://localhost:3000` (or your Tailscale URL)
2. Send a message — should get an LLM response
3. Ask "what skills do you have?" — should list `test-greeting` and `gut-check-progress`
4. Try `/skill:test-greeting` — should get a greeting confirming the skill system works
