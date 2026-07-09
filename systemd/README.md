# systemd units

User services for the Pi Assistant, fronted on the tailnet via `tailscale serve`.

- `pi-assistant-backend.service` — WebSocket server on `127.0.0.1:3001`
- `pi-assistant-frontend.service` — Vite dev server on `127.0.0.1:3000` (served at `:8443`)

Paths use the `%h` specifier (home dir), so the units carry no hardcoded
username and work on any box where this repo sits at `~/pi-mono`.

## Install

Symlink each unit into the systemd user dir (edits to the repo file then take
effect after a `daemon-reload`, with no copy to keep in sync):

```bash
systemctl --user link "$PWD/systemd/pi-assistant-backend.service"
systemctl --user link "$PWD/systemd/pi-assistant-frontend.service"
systemctl --user daemon-reload
systemctl --user enable --now pi-assistant-backend pi-assistant-frontend
```

## Clean shutdown

These units deliberately do **not** set `KillMode=process`. Under the default
(`control-group`), `systemctl --user stop`/`restart` tears down the whole
process tree, so no leftover child keeps hold of port 3000/3001 — restarts
rebind cleanly instead of failing with `EADDRINUSE`.
