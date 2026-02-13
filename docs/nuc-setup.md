# Pi Assistant — NUC Setup Guide

Instructions for setting up the pi-assistant on the NUC. Steps are written for
Claude Code to execute unless marked with **[HUMAN]**, which means the human
needs to provide information or take action before continuing.

## Prerequisites

- Node.js v22+ (`node -v` to verify)
- Git
- npm
- Docker (for the momo memory backend)

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
  "defaultThinkingLevel": "off",
  "packages": ["npm:@momomemory/pi-momo"]
}
EOF
```

The `packages` entry tells the SDK to auto-install and load the pi-momo
memory extension on startup.

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

## 5. Memory backend (Momo)

Momo provides long-term memory for the assistant. It runs as a Docker
container because the prebuilt binary requires GLIBC 2.38+ (Ubuntu 22.04
ships GLIBC 2.35).

### Start the container

**[HUMAN]** Generate an API key (e.g. `openssl rand -hex 16`) and substitute
it below.

```bash
mkdir -p ~/.local/share/momo

docker run -d \
  --name momo \
  --restart unless-stopped \
  -p 127.0.0.1:3100:3000 \
  -v /home/grahamu/.local/share/momo:/data \
  -e MOMO_RUNTIME_MODE=all \
  -e MOMO_API_KEYS=<your-api-key> \
  ghcr.io/momomemory/momo:0.3.0
```

- Port 3100 on the host maps to 3000 inside the container (3000 is used by the Vite frontend)
- `--restart unless-stopped` means Docker restarts it on reboot and on crash
- Data is persisted to `~/.local/share/momo/`
- The embedded LibSQL database and BAAI/bge-small-en-v1.5 embedding model are included in the image — no external dependencies

Verify it's running:

```bash
curl -s -H "Authorization: Bearer <your-api-key>" http://127.0.0.1:3100/api/v1/health
```

### Configure pi-momo

Create `~/.pi/momo.jsonc` with the same API key:

```bash
cat > ~/.pi/momo.jsonc <<'EOF'
{
  "pi": {
    "baseUrl": "http://127.0.0.1:3100",
    "apiKey": "<your-api-key>",
    "autoRecall": true,
    "autoCapture": false,
    "maxRecallResults": 3,
    "profileFrequency": 500
  }
}
EOF
```

See the [user guide](assistant-guide.md#memory-momo) for what each setting
does and how to tune them.

## 6. Build

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

## 7. Run

Both commands must be run from the **repo root** (so dotenv discovers `.env`):

```bash
# Terminal 1: backend
node packages/assistant-server/dist/cli.js --port 3001

# Terminal 2: frontend
cd packages/assistant-frontend && npx vite
```

The frontend runs on port 3000, the backend on port 3001. Vite proxies `/ws` and `/api` to the backend automatically.

## 8. Tailscale (remote access)

Port 443 is already used by OpenClaw and OwnTracks on this NUC, so the
assistant and momo dashboard use separate ports:

```bash
tailscale serve --bg --https 8443 3000   # assistant frontend
tailscale serve --bg --https 8444 3100   # momo dashboard
```

The `--bg` flag makes the proxy persistent across reboots.

- Assistant: `https://monkey.tail77fdad.ts.net:8443/`
- Momo dashboard: `https://monkey.tail77fdad.ts.net:8444/`

Multiple clients can connect simultaneously, each independently viewing and
switching sessions without affecting each other.

Check the full Tailscale serve layout with `tailscale serve status`.

## 9. Claude Code project memory

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
