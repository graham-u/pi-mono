# Pi Assistant

This is a fork of the [pi-mono](https://github.com/mariozechner/pi-mono) monorepo. It adds a web-based assistant frontend backed by the local pi-coding-agent SDK.

## New Packages

- `packages/assistant-server/` — WebSocket server wrapping the coding-agent SDK
- `packages/assistant-frontend/` — Browser app using pi-web-ui components with a RemoteAgent adapter

## Getting Started

Read these documents:

1. **[docs/assistant-guide.md](docs/assistant-guide.md)** — User guide: API keys, default model, system prompt, building, and running.

2. **[docs/pi-assistant-spec.md](docs/pi-assistant-spec.md)** — Full specification: architecture, protocol, RemoteAgent design, input handler chain, skills integration, and implementation phases.

3. **[docs/assistant-implementation.md](docs/assistant-implementation.md)** — Implementation notes: decisions made, interface contracts, build instructions, phase status, and known issues.

## Upstream Packages

All packages except `assistant-server` and `assistant-frontend` are upstream
framework code from [pi-mono](https://github.com/mariozechner/pi-mono). Our
modifications to these packages are tracked in
**[docs/upstream-modifications.md](docs/upstream-modifications.md)**.

When modifying an upstream package, update that file with the rationale and
scope of the change.

## Before Committing

Before creating a commit, check the `docs/` folder and update any relevant documentation (spec, implementation notes, user guide) to reflect the changes being committed.

## Quick Reference

```bash
# Build dependencies (in order)
cd packages/tui && tsc -p tsconfig.build.json --target ES2024 --skipLibCheck
cd packages/ai && tsc -p tsconfig.build.json --skipLibCheck
cd packages/agent && tsc -p tsconfig.build.json --skipLibCheck
cd packages/coding-agent && tsc -p tsconfig.build.json --skipLibCheck
cd packages/web-ui && tsc -p tsconfig.build.json --skipLibCheck
cd packages/web-ui && npx @tailwindcss/cli -i ./src/app.css -o ./dist/app.css --minify

# Build the server
cd packages/assistant-server && tsc -p tsconfig.build.json --skipLibCheck

# Run the server (MUST run from repo root so dotenv picks up .env)
node packages/assistant-server/dist/cli.js --port 3001

# Run the frontend (separate terminal)
cd packages/assistant-frontend && npx vite
```
