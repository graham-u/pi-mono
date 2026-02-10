# Pi Assistant — User Guide

How to configure and run the assistant.

---

## Running

Start both the server and frontend (from the repo root):

```bash
# Terminal 1: backend
node packages/assistant-server/dist/cli.js --port 3001

# Terminal 2: frontend
cd packages/assistant-frontend && npx vite
```

Open http://localhost:3000/ in a browser.

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
The active session is highlighted.

Multiple browser tabs share the same backend session. Switching sessions in
one tab updates all connected tabs automatically.

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

### Remote Access (Tailscale etc.)

To access the frontend from other devices (e.g. a phone on your Tailscale
network), add allowed hostnames to `.env`:

```
VITE_ALLOWED_HOSTS=.your-tailnet.ts.net
```

Multiple hosts can be comma-separated. A leading dot matches all subdomains.

You will also need Tailscale serve to proxy traffic to the Vite dev server:

```bash
tailscale serve 3000
```

If port 443 is already in use by another service, serve on a different port:

```bash
tailscale serve --https 8443 3000
```

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
