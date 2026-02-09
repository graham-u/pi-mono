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

You will also need something like `tailscale serve 3000` to proxy traffic
to the Vite dev server.

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
