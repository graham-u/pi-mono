# Pi Assistant — User Guide

How to configure and run the assistant.

---

## Running

The backend and frontend run as systemd user services and start automatically
on boot. Tailscale serve is configured separately and also persists across
reboots.

| Service | What it does | Port | Managed by |
|---------|-------------|------|------------|
| `pi-assistant-backend` | WebSocket server (coding-agent SDK) | 3001 | systemd user service |
| `pi-assistant-frontend` | Vite dev server | 3000 | systemd user service |
| `momo` | Memory backend (Docker container) | 3100 | Docker (`--restart unless-stopped`) |
| Tailscale serve | HTTPS reverse proxy | 8443 (assistant), 8444 (momo dashboard) | `tailscale serve --bg` |

The assistant services use **systemd user services** (`~/.config/systemd/user/`).
The momo memory backend runs as a **Docker container** (the prebuilt binary
requires GLIBC 2.38+ which is newer than this Ubuntu 22.04 system provides).
Docker itself is enabled at boot (`systemctl is-enabled docker`), and the
container's `--restart unless-stopped` policy means it survives reboots.

Useful commands:

```bash
# Check status
systemctl --user status pi-assistant-backend pi-assistant-frontend

# After editing assistant-server code, rebuild and restart:
cd ~/pi-mono/packages/assistant-server && npx tsc -p tsconfig.build.json --skipLibCheck
systemctl --user restart pi-assistant-backend
# (assistant-frontend changes are picked up automatically by Vite hot-reload)

# View logs
journalctl --user -u pi-assistant-backend -f
journalctl --user -u pi-assistant-frontend -f

# Momo (Docker)
docker logs momo -f          # view logs
docker restart momo           # restart
docker stop momo              # stop
docker start momo             # start
```

For manual/one-off use (e.g. on a different machine without the services
installed), start both from the repo root:

```bash
# Terminal 1: backend
node packages/assistant-server/dist/cli.js --port 3001

# Terminal 2: frontend
cd packages/assistant-frontend && npx vite
```

The server automatically resumes the most recent session on startup, so you
will see your previous conversation when you reconnect.

---

## Sessions

The UI includes a session sidebar for managing conversations:

- **Desktop:** The sidebar is always visible on the left (260px wide).
- **Mobile:** Tap the hamburger menu in the header to open the sidebar as an
  overlay.

From the sidebar you can:

- **New Chat** — Start a fresh session (previous sessions are preserved).
- **Switch sessions** — Click any session to load its conversation history.

Session previews show the first message, relative date, and message count.
The active session is highlighted. For providers that support prompt caching
(Anthropic, Bedrock, OpenAI with long retention), a countdown timer appears
next to sessions with a warm cache, showing how long until the cache expires.

Each browser tab independently tracks its own session. Switching sessions on
one device does not affect other connected tabs or devices. If two tabs view
the same session, both see streaming responses in real time.

---

## Configuration

### API Key

The server reads API keys from environment variables. Set yours in `.env`
at the repo root (this file is gitignored):

```
ANTHROPIC_API_KEY=sk-ant-...
```

See `.env.example` for the template. The server loads this file via `dotenv`
at startup.

Other supported providers and their environment variables:

| Provider | Variable |
|----------|----------|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Groq | `GROQ_API_KEY` |
| xAI | `XAI_API_KEY` |

### Default Model

Set your preferred model and provider in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-3-5-haiku-latest"
}
```

You can also change the model from the UI dropdown at any time.

### Thinking Level

Set the default thinking level in the same `settings.json`:

```json
{
  "defaultThinkingLevel": "off"
}
```

Options: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

### System Prompt

The SDK looks for a `SYSTEM.md` file to replace the default coding-agent
system prompt. It checks two locations (first match wins):

1. `.pi/SYSTEM.md` in the project directory (project-specific)
2. `~/.pi/agent/SYSTEM.md` (global)

If neither exists, the default coding-agent prompt is used (which frames
the assistant as a coding agent).

Edit `~/.pi/agent/SYSTEM.md` to customise the assistant's behaviour. Tool
descriptions, project context files, and skills are still injected
automatically regardless of what you put here.

### Memory (Momo)

The assistant uses [Momo](https://github.com/momomemory/momo) for long-term
memory, integrated via the
[pi-momo](https://github.com/momomemory/pi-momo) extension.

**Architecture:**

- **Momo** — A Rust-based memory service running as a Docker container on
  `localhost:3100`. Stores memories in an embedded LibSQL database with native
  vector search (no external vector DB needed). Data is persisted to
  `~/.local/share/momo/`.
- **pi-momo** — A Pi extension (`@momomemory/pi-momo`) that hooks into the
  agent lifecycle. It injects relevant memories before each turn (recall) and
  optionally captures conversations after each turn (capture). Installed as an
  npm package listed in `~/.pi/agent/settings.json`.

**Configuration** (`~/.pi/momo.jsonc`):

```jsonc
{
  "pi": {
    "baseUrl": "http://127.0.0.1:3100",
    "apiKey": "<momo-api-key>",
    "autoRecall": true,       // inject memories before each turn
    "autoCapture": false,     // store conversations after each turn
    "maxRecallResults": 3,    // memories per category per turn (1-20)
    "profileFrequency": 500   // inject full profile every N turns (1-500)
  }
}
```

The API key must match the `MOMO_API_KEYS` value set on the Docker container
(see the NUC setup guide for the Docker run command).

**How recall works:** Before each agent turn, pi-momo performs a semantic
search against stored memories and injects the top results as a hidden
`<momo-context>` block. On turn 1 (and every `profileFrequency` turns), a
full user profile (persistent facts + recent signals) is also included.
Between profile turns, only search results are injected.

**How capture works:** When `autoCapture` is enabled, each agent turn
(user message + assistant response) is stored as a memory after the response
completes. Previously injected `<momo-context>` blocks are stripped before
storage to prevent recursive memory-of-memories.

**Memory types:**

| Type | Decays? | Use for |
|------|---------|---------|
| Fact | No | Stable biographical/characteristic data |
| Preference | No | User likes/dislikes |
| Episode | Yes (30-day cycle) | Conversational exchanges, temporary states |

**Episode decay tuning:** Episodes follow a sigmoid decay curve controlled by
environment variables on the momo Docker container. Accessing a memory resets
its decay clock.

| Variable | Default | What it does |
|----------|---------|-------------|
| `EPISODE_DECAY_DAYS` | 30 | Days until relevance hits 50% (the half-life) |
| `EPISODE_DECAY_FACTOR` | 0.9 | Steepness of the curve (higher = more gradual) |
| `EPISODE_DECAY_THRESHOLD` | 0.3 | Relevance level that triggers forgetting |
| `EPISODE_FORGET_GRACE_DAYS` | 7 | Days between scheduled and actual deletion |

With defaults, an unaccessed episode lasts ~47 days. For longer retention
(e.g. a multi-month activity), set `EPISODE_DECAY_DAYS=60` and
`EPISODE_FORGET_GRACE_DAYS=14` (~3 months lifespan).

**LLM integration:** Momo can use an LLM for contradiction detection (flagging
conflicting facts), query rewriting, and narrative profile generation. The LLM
is configured via environment variables on the Docker container:

| Variable | Value | What it does |
|----------|-------|-------------|
| `LLM_MODEL` | `openrouter/anthropic/claude-3.5-haiku` | Model for analysis tasks |
| `LLM_API_KEY` | OpenRouter API key | Authentication for the LLM provider (key labeled "Momo key for Pi assistant" in OpenRouter to track usage/costs separately) |
| `ENABLE_AUTO_RELATIONS` | `true` | Detect relationships between memories (uses local embedding similarity, not the LLM) |
| `ENABLE_CONTRADICTION_DETECTION` | `true` | Flag conflicting facts (uses the LLM) |
| `ENABLE_QUERY_REWRITE` | `false` | Rewrite queries for better recall (uses the LLM, adds latency) |

Note: relationship detection (`ENABLE_AUTO_RELATIONS`) uses local embedding
similarity (BAAI/bge-small-en-v1.5), not the LLM. It works without an LLM
configured. The LLM is used for contradiction detection, query rewriting, and
periodic narrative profile generation. Relationships are only detected at
storage time — they are not applied retroactively to pre-existing memories.

**Slash commands:** `/remember`, `/recall`, `/momo-profile`, `/momo-debug`

**Agent tools:** `momo_store`, `momo_search`, `momo_forget`, `momo_profile`

**Dashboard:** Browse and manage memories at
`https://monkey.tail77fdad.ts.net:8444/` (Tailscale) or
`http://127.0.0.1:3100/` (local). Enter the API key once — it's saved in
the browser's localStorage.

**Debugging recall:** To see what memories are being injected into a session,
extract the `<momo-context>` blocks from the session file:

```bash
jq -r 'select(.customType=="momo-context") | .content' \
  ~/.pi/agent/sessions/--home-grahamu-pi-mono--/*.jsonl
```

For live debugging, set `"debug": true` in `~/.pi/momo.jsonc` and tail the
backend logs: `journalctl --user -u pi-assistant-backend -f`

### Push Notifications

Browser push notifications let local processes (cron jobs, monitoring scripts)
send alerts to all subscribed devices — even when the browser tab is closed.
Uses the standard Web Push API with VAPID keys (no Firebase needed).

**Setup:**

1. Generate VAPID keys (one-time):
   ```bash
   cd packages/assistant-server && npx web-push generate-vapid-keys
   ```

2. Add to `.env` at the repo root:
   ```
   VAPID_PUBLIC_KEY=<generated public key>
   VAPID_PRIVATE_KEY=<generated private key>
   VAPID_SUBJECT=mailto:you@example.com
   ```

3. Rebuild and restart the backend:
   ```bash
   cd packages/assistant-server && npx tsc -p tsconfig.build.json --skipLibCheck
   systemctl --user restart pi-assistant-backend
   ```

4. Open the assistant in your browser — it will prompt for notification
   permission. Grant it to subscribe.

**Sending notifications from scripts:**

```bash
curl -X POST http://localhost:3001/api/push/send \
  -H "Content-Type: application/json" \
  -d '{"title": "Reminder", "body": "Time for your meeting", "url": "/"}'
```

The `url` field is optional — tapping the notification focuses or opens
the assistant at that path.

**API endpoints** (all localhost-only):

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/push/vapid-public-key` | GET | Returns the VAPID public key |
| `/api/push/subscribe` | POST | Register a push subscription |
| `/api/push/unsubscribe` | POST | Remove a push subscription |
| `/api/push/send` | POST | Send notification to all subscribers |

Subscriptions are stored in `~/.pi/agent/push-subscriptions.json`. Expired
subscriptions (HTTP 410) are automatically cleaned up on send.

**Android note:** When the phone is in Doze mode (screen off, idle), push
delivery may be delayed until the device wakes. This is an Android platform
limitation. Disabling battery optimization for Chrome may help.

---

### Remote Access (Tailscale etc.)

To access the assistant from other devices on your Tailscale network, add
allowed hostnames to `.env`:

```
VITE_ALLOWED_HOSTS=.your-tailnet.ts.net
```

Multiple hosts can be comma-separated. A leading dot matches all subdomains.

Tailscale serve proxies HTTPS traffic to local services. On this NUC, port
443 is used by OpenClaw/OwnTracks, so the assistant uses port 8443 and the
momo dashboard uses port 8444:

```bash
tailscale serve --bg --https 8443 3000   # assistant frontend
tailscale serve --bg --https 8444 3100   # momo dashboard
```

The `--bg` flag makes the proxy persistent across reboots.

Current Tailscale serve layout:

| Port | Path | Target | Service |
|------|------|--------|---------|
| 443 | `/` | `127.0.0.1:18789` | OpenClaw |
| 443 | `/owntracks` | `127.0.0.1:8083` | OwnTracks |
| 8443 | `/` | `127.0.0.1:3000` | Assistant frontend (Vite) |
| 8444 | `/` | `127.0.0.1:3100` | Momo dashboard |

Check the current config with `tailscale serve status`.

---

## Message Injection

Local processes (cron jobs, scripts) can inject assistant messages into the
active session via HTTP. The message appears in the chat in real time and
is persisted to the session file.

```bash
curl -X POST http://localhost:3001/api/inject \
  -H "Content-Type: application/json" \
  -d '{"content":"Good morning. Here is your daily briefing."}'
```

The endpoint only accepts requests from localhost (127.0.0.1 / ::1).

Injected messages appear as assistant messages. The LLM sees them on the
next turn, so you can reply naturally. See `docs/message-injection-spec.md`
for the full specification and cron script examples.

---

## Building

If you need to rebuild after code changes:

```bash
# Build dependencies (in order)
cd packages/tui && tsc -p tsconfig.build.json --target ES2024 --skipLibCheck
cd packages/ai && tsc -p tsconfig.build.json --skipLibCheck
cd packages/agent && tsc -p tsconfig.build.json --skipLibCheck
cd packages/coding-agent && tsc -p tsconfig.build.json --skipLibCheck
cd packages/web-ui && tsc -p tsconfig.build.json --skipLibCheck

# Build web-ui CSS
cd packages/web-ui && npx @tailwindcss/cli -i ./src/app.css -o ./dist/app.css --minify

# Build the server
cd packages/assistant-server && tsc -p tsconfig.build.json --skipLibCheck
```

The frontend (assistant-frontend) is built on-the-fly by Vite during
development. No manual build step needed.
