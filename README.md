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

## Headless sessions

Anything that shells out to `claude -p` (or the Agent SDK) inherits your global hooks, so a
`Stop` hook that summarizes the session would land on the board as a session of its own —
one card per run, no model, no tokens, a derived `<folder>-<hash>` name. The hook skips
those: `CLAUDE_CODE_ENTRYPOINT` is `sdk-*` for headless runs and `cli` for interactive ones.
`HUB_TRACK_SDK=1` reports them anyway.

Whatever still gets through — any session that never produced an assistant turn — sits
behind the **Empty** filter instead of the board, and the server drops it after
`HUB_EMPTY_TTL_HOURS`.

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
single bar. With grouping on, each group header collapses on click (the board does the
same) and a collapsed group keeps showing how many sessions inside need attention.

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

## The hub for every agent

With `HUB_DELEGATION=1` the hub is also where agents arrive and report:

- **Workspaces** are discovered from your `.code-workspace` folder (the one a `wk` alias reads); the hub can create, edit and open them, and install the alias in bash or PowerShell.
- **Delegation**: any Claude Code, Claude Desktop, Codex CLI or Codex app conversation registers the hub as the `cchub` MCP server (Connect tab) and gets `hub_overview`, `hub_workspaces`, `hub_delegate`, `hub_task`, `hub_continue`, `hub_report` and friends. Delegated runs start in the workspace context folder with every repo attached and show up as regular sessions.
- **Everything running**: Claude Code sessions with their subagents, Claude Desktop, the Codex app and CLI, and Codex threads read from `~/.codex/sessions`.
- **Reports** from any agent land in the hub (and, when linked, in the second brain as `fontes/hub/<date>.md`).
- **Share**: a link (LAN, or public through ngrok started from the hub) that lets another person's assistant ask your Claude and delegate work into a workspace at a trust level you pick (Low read-only, Medium edits, High edits + safe shell, Total no blocks), with a key, expiry, rate limit and a full log.
- **Autonomous by default**: delegated runs bypass permissions (Claude) and the sandbox (Codex) so nothing stops in "Needs you"; switch to safe mode in Settings. The app can start with Windows, and the UI ships a Dracula theme (Midnight still available).

Details, security model, MCP tools and the thin CLI in `apps/server/DELEGATION.md`.

## Environment variables

### Server

| Var | Default | Purpose |
| --- | --- | --- |
| `HUB_PORT` | `4317` | Server port |
| `HUB_HOST` | `0.0.0.0` | Bind (LAN for phone) |
| `HUB_DATA_DIR` | `~/.vbss-cchub` | Where `hub.db` lives |
| `HUB_STATIC_DIR` | — | ui build to serve the front on the same port |
| `HUB_EMPTY_TTL_HOURS` | `12` | Drop sessions that never produced a turn after this long (`0` keeps them) |
| `HUB_DELEGATION` | — | `1` enables the delegation surface (see `apps/server/DELEGATION.md`) |
| `HUB_WORKSPACES_ROOT` | — | Default folder of `.code-workspace` files (the Settings value wins) |
| `HUB_SECOND_BRAIN` | — | Vault root; the hub appends delegations and reports to `fontes/hub/<date>.md` |
| `HUB_CODEX_BIN` | newest `codex.exe` | Codex CLI used by the codex runner |
| `HUB_STALE_HOURS` | `4` | Sessions silent for longer are flagged inactive and left out of the counts |
| `HUB_TRUSTED_ORIGINS` | — | Extra browser origins allowed on `/delegation`, comma-separated |
| `HUB_SHARE_PORT` | `4318` | Share endpoint (links for other people's assistants; LAN and ngrok target) |
| `HUB_SHARE_HOST` | `0.0.0.0` | Bind address of the share endpoint |
| `HUB_NGROK_BIN` | auto | ngrok executable for Start tunnel (downloaded automatically when absent) |

### Hook

| Var | Default | Purpose |
| --- | --- | --- |
| `HUB_HOST_TARGET` | `127.0.0.1` (win) / gateway (wsl) | Hub host the hook posts to |
| `HUB_PORT` | `4317` | Hub port |
| `HUB_SOURCE` | hostname | Session origin label (e.g. `wsl`, `work-sub`) |
| `HUB_SKIP` | — | `1` makes the hook exit without reporting |
| `HUB_TRACK_SDK` | — | `1` also reports headless sessions (see below) |

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
