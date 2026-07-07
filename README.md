# VBSS CCHUB

A local hub for running many Claude Code sessions in parallel: each session signals
start, resume, needs-a-decision, or stop via hooks, and the hub shows on a dashboard
which ones need you. Runs on `localhost`, reachable from your phone on the same network.

## Stack

| Layer | Tech |
| --- | --- |
| Back | Node + TypeScript + Express + SQLite (`better-sqlite3`) + SSE |
| Front | React + Vite |
| Desktop | Tauri v2 (system tray, native Windows notifications, `.msi`) |
| Landing | React + Vite standalone (not bundled in Tauri) |

## Structure

```md
apps/
  server/     Express :4317 — receives hooks, persists, streams SSE, serves the front
  ui/         React + Vite :1420 — session dashboard + always-on-top widget
  desktop/    Tauri v2 — wraps the front + tray + native notifications
  landing/    React + Vite :1500 — public open-source landing page
  vscode-ext/ optional VS Code helper (spike) for per-terminal focus
brand/        logo/icon source (radar mark, transparent) + app-icon (with background)
```

## Session states

| Claude Code hook | State | Colour |
| --- | --- | --- |
| `SessionStart`, `UserPromptSubmit` | `active` | blue |
| `Notification` | `waiting` (needs a decision) | amber |
| `Stop` | `idle` (paused, resume) | red |
| `SessionEnd` | `ended` | grey |

Brand accents (logo, interactive highlights) are violet + amber; the status colours
above stay semantic so the board reads at a glance.

## Run (dev)

```bash
npm install
npm run dev          # server :4317 + ui :1420
# in another terminal, the desktop app:
npm run desktop:dev
# landing page (optional):
npm run dev -w @cch/landing   # :1500
```

Phone on the same network: `http://<machine-ip>:4317` (the server serves the front when
`HUB_STATIC_DIR` points at the ui build — see below).

## Set up the Claude Code hooks

Three ways (all idempotent, they touch only the `notify.mjs`/`notify.sh` entries and back
up `settings.json.bak`):

1. **From the app / dashboard** — the "Set up hooks" button at the top (works in Tauri and
   in the browser/phone). Toggles on and off, and it detects WSL distros and installs the
   right hook in each one automatically.
2. **CLI**: `node apps/server/hooks/configure.mjs install` (or `uninstall` / `status`).
3. **Manual**: copy from `apps/server/hooks/settings.example.json` into `~/.claude/settings.json`,
   adjusting the absolute path.

Registered events: `SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`, `SessionEnd`.
On Windows the hook is `notify.mjs` (Node); it reads the hook JSON from stdin and does
`POST /hook`. If the hub is offline it fails silently (2s timeout) and never blocks Claude Code.

## Focus a session

Clicking **Focus** (the card button, the project name, or a widget row) brings the
**window where the session already runs** (VS Code, Windows Terminal, etc.) to the front —
nothing new is opened. `POST /api/sessions/:id/focus`, runs on the host (app, widget and phone).

How it works (no reliance on a fixed window title): `notify.mjs` runs **inside the session's
process tree**, so it walks up (`find-host-window.ps1`) to the first ancestor with a window —
the terminal/editor hosting Claude — and sends that PID (`hostPid`) to the hub. Focus brings
that PID's window forward (`focus.ps1`). When one process owns several windows (e.g. VS Code),
it disambiguates by matching the session's folder name in the window title. The walk runs once
per session (cached in `~/.vbss-cchub/pids/`).

Honest limits: Windows Terminal has one window per process (focuses the window, not the
specific tab). Focus of a session running inside WSL is limited — see below.

## Always-on-top widget

A second Tauri window (frameless, always on top, off the taskbar) with a one-line-per-session
summary of what's running / paused / needs attention. Toggle it from the **tray**
("Show/hide widget"). Click a row to focus that session. Draggable header, collapses to a
single bar.

## Track many Claudes (WSL / another subscription / another machine)

Each session carries a `source` (env `HUB_SOURCE`, default = hostname). When there's more than
one origin, the card shows a `source` badge. WSL has no Node on the native `claude` binary's
path, so WSL sessions use `notify.sh` (curl) posting to `POST /hook/raw`. The "Set up hooks"
button installs this for each WSL distro automatically; the manual equivalent is:

```bash
HUB_SOURCE=wsl HUB_HOST_TARGET=<windows-ip-or-gateway> \
  sh "/mnt/c/path/to/vbss-cchub/apps/server/hooks/notify.sh"
```

`notify.sh` resolves the Windows host via the default-route gateway when `HUB_HOST_TARGET`
is unset. `open/focus` of WSL paths is still limited — native Windows paths work best.

## Environment variables

### Server

| Var | Default | Purpose |
| --- | --- | --- |
| `HUB_PORT` | `4317` | Server port |
| `HUB_HOST` | `0.0.0.0` | Bind (LAN for phone) |
| `HUB_DATA_DIR` | `~/.vbss-cchub` | Where `hub.db` lives |
| `HUB_STATIC_DIR` | — | ui build to serve the front on the same port |

### Hook

| Var | Default | Purpose |
| --- | --- | --- |
| `HUB_HOST_TARGET` | `127.0.0.1` (win) / gateway (wsl) | Hub host the hook posts to |
| `HUB_PORT` | `4317` | Hub port |
| `HUB_SOURCE` | hostname | Session origin label (e.g. `wsl`, `work-sub`) |

### UI

| Var | Default | Purpose |
| --- | --- | --- |
| `VITE_HUB_URL` | `http://<host>:4317` | Override the server URL |

The context bar limit is inferred per model family (200k for Sonnet/Haiku, 1M for Opus).

## Release

```bash
node scripts/release.mjs 1.1.0
```

One command from a clean `main`: bumps the version in every manifest, builds the `.msi`,
copies it to the stable asset name, commits + pushes the bump, publishes the GitHub release
(`gh release create`) and verifies the public download URL. The landing always points to
`releases/latest/download/VBSS-CCHUB-Setup.msi`, so no landing change is needed per release.

## Known gaps

- **Mobile**: serving over the LAN works, but real-device layout and notifications over
  plain-http (secure-context limits Web Notification/AudioContext) still need validation.
- **WSL focus**: opening/focusing WSL paths is best-effort; native Windows paths work best.
