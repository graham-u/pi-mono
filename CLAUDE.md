# Pi Assistant

This is a fork of the [pi-mono](https://github.com/mariozechner/pi-mono) monorepo. It adds a web-based assistant frontend backed by the local pi-coding-agent SDK.

## New Packages

- `packages/assistant-server/` — WebSocket server wrapping the coding-agent SDK
- `packages/assistant-frontend/` — Browser app using pi-web-ui components with a RemoteAgent adapter

## Getting Started

Read these two documents in order:

1. **[docs/pi-assistant-spec.md](docs/pi-assistant-spec.md)** — Full specification: architecture, protocol, RemoteAgent design, input handler chain, skills integration, and implementation phases.

2. **[docs/assistant-implementation.md](docs/assistant-implementation.md)** — Implementation notes: decisions made, interface contracts, build instructions, phase status, and known issues.

## Quick Reference

```bash
# Build dependencies (in order)
cd packages/tui && tsc -p tsconfig.build.json --target ES2024 --skipLibCheck
cd packages/ai && tsc -p tsconfig.build.json --skipLibCheck
cd packages/agent && tsc -p tsconfig.build.json --skipLibCheck
cd packages/coding-agent && tsc -p tsconfig.build.json --skipLibCheck

# Build and run the server
cd packages/assistant-server && tsc -p tsconfig.build.json --skipLibCheck
node dist/cli.js --port 3001

# Run the frontend (separate terminal)
cd packages/assistant-frontend && npx vite
```
