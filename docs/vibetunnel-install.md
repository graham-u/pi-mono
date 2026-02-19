# VibeTunnel Installation on Linux (NUC)

> This document is not directly related to the pi-mono project. It lives here because VibeTunnel is installed on the same NUC that hosts the pi assistant, and this is a convenient place to keep operational notes.

## Prerequisites

Install the PAM development headers (required by the `authenticate-pam` native module):

```bash
sudo apt install libpam0g-dev
```

## Why `npm install -g vibetunnel` Fails

A straightforward `npm install -g vibetunnel` fails on Linux due to two native module build issues:

1. **`authenticate-pam`** — Needs `<security/pam_appl.h>`, which requires `libpam0g-dev`.
2. **`node-pty`** — Bundled at the package root (not under `node_modules/`), so its dependency on `node-addon-api` is not resolved during install. The build fails with `Cannot find module 'node-addon-api'`.

When either native module fails, npm rolls back the entire install — leaving nothing behind.

## Workaround

Install without running post-install scripts, then manually fix and build the native modules:

```bash
# 1. Install without building native modules
npm install -g vibetunnel --ignore-scripts

# 2. Install the missing build dependency
cd ~/.npm-global/lib/node_modules/vibetunnel
npm install node-addon-api

# 3. Build node-pty
cd ~/.npm-global/lib/node_modules/vibetunnel/node-pty
npx node-gyp rebuild

# 4. Build authenticate-pam
cd ~/.npm-global/lib/node_modules/vibetunnel/node_modules/authenticate-pam
npx node-gyp rebuild
```

## Verification

```bash
vt --help
```

## Running as a Systemd Service

VibeTunnel has a built-in `vibetunnel systemd` command, but it requires a TTY and won't work in non-interactive environments. The service file is created manually instead.

### Service file

`~/.config/systemd/user/vibetunnel.service`:

```ini
[Unit]
Description=VibeTunnel terminal server on :4020
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/home/grahamu/.npm-global/lib/node_modules/vibetunnel
ExecStart=/usr/bin/node /home/grahamu/.npm-global/lib/node_modules/vibetunnel/dist/cli.js --port 4020 --bind 127.0.0.1 --no-auth --no-mdns
Restart=always
RestartSec=10
KillMode=process
Environment=HOME=/home/grahamu
Environment=NODE_ENV=production
Environment=VIBETUNNEL_LOG_LEVEL=info
Environment="PATH=/home/grahamu/.local/bin:/home/grahamu/.npm-global/bin:/home/grahamu/.nvm/current/bin:/home/grahamu/.fnm/current/bin:/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=default.target
```

Key points:
- **`dist/cli.js`** is the server entry point, not the `vibetunnel` CLI binary (which is just a command router and exits immediately in non-TTY mode).
- **`WorkingDirectory`** must point to the vibetunnel package root so it can find `public/index.html`.
- **`--bind 127.0.0.1`** restricts to localhost since Tailscale fronts it.
- **`--no-auth`** disables PAM login — access control is via Tailscale.
- **`--no-mdns`** disables Bonjour advertisement (not needed on a headless server).

### Management

```bash
systemctl --user enable vibetunnel     # auto-start on boot
systemctl --user start vibetunnel
systemctl --user stop vibetunnel
systemctl --user restart vibetunnel
systemctl --user status vibetunnel
journalctl --user -u vibetunnel -f     # live logs
```

## Tailscale

VibeTunnel is exposed via Tailscale HTTPS on port **8445** (tailnet-only):

```bash
tailscale serve --bg --https 8445 http://127.0.0.1:4020
```

Access at: `https://monkey.tail77fdad.ts.net:8445/`

### Tailscale port map (this machine)

| Port | Service |
|------|---------|
| 443 | OpenClaw / OwnTracks |
| 8443 | Pi Assistant (frontend) |
| 8444 | Momo dashboard |
| 8445 | VibeTunnel |

## Notes

- The `authenticate-pam` build emits deprecation warnings about `Nan::MakeCallback` — these are harmless.
- `npm audit` reports vulnerabilities in transitive build-time dependencies (`tar`, `glob`, `rimraf`). These are in vibetunnel's upstream dependency tree and not actionable on our end.
- VibeTunnel logs to `~/.vibetunnel/log.txt` as well as journald.
- Tested with Node.js v22.21.0 on Ubuntu 22.04 (kernel 6.8.0-90-generic), February 2026.
- Upstream issue tracking these Linux build problems: https://github.com/amantus-ai/vibetunnel/issues/499
