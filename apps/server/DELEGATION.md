# The hub for every agent

Opt-in surface that turns the CC Hub into the place where every agent arrives and reports. Agents
(Claude Code, Claude Desktop, Codex CLI, the Codex app, or a script) delegate work into a
workspace, follow it by a permanent id from any conversation, and leave reports the human and the
other agents can read. The hub also shows everything running on the machine.

Nothing is configured twice:

- **Workspaces** come from a root folder holding one `<name>.code-workspace` per workspace (the
  same folder a shell alias such as `wk` reads). A sibling folder `<name>/` is the workspace
  context (CLAUDE.md, skills, docs). Every other folder in the file is a repo of that workspace.
  The hub lists, creates, edits and opens them, and can install the `wk` alias for bash and
  PowerShell.
- **Delegated runs start in the workspace context folder** with every repo attached
  (`--add-dir`) and a system note mapping repo names to local paths, so the agent uses the
  workspace CLAUDE.md and skills and never asks where a project lives. The Claude runner passes
  `HUB_TRACK_SDK=1`, so the headless session appears in the hub like any other session.
- **Runtimes**: Claude Code sessions (with subagents from the `SubagentStart`/`SubagentStop`
  hooks), Claude Desktop, the Codex app and CLI (process scan) and Codex threads read from
  `~/.codex/sessions`.
- **Clients are told apart.** The hook walks the process tree: a session is `terminal`, `vscode`,
  `claude-desktop` (spawned by the Claude Desktop app), `wsl`, `headless` (`claude -p`) or `hub`
  (a delegated run). Codex threads are `codex-app`, `codex-cli`, `codex-exec` or `codex-vscode`
  from the rollout's originator and source.
- **Liveness.** The hook also records the `claude.exe` pid. Every 30 s the hub ends sessions whose
  process is gone (no `SessionEnd` ever arrives when a terminal or VS Code is closed), and flags
  sessions silent for `HUB_STALE_HOURS` (default 4) as stale, so counts and `hub_overview` stay
  honest. Legacy rows without a Claude pid fall back to the shell or window pid.
- **Live views.** `GET /api/sessions/:id/live` returns the tail of the session transcript (prompts,
  answers, tool calls, results) plus every subagent with its own transcript tail and last message.
  Delegated runs stream: assistant text deltas, tool calls and status changes are stored per run
  (`hub_run_events`) and broadcast as `run-event` on `/api/events`.
- **Reports** land in `hub.db` and, when a vault is linked, in `fontes/hub/<date>.md`.

## Enable

```bash
HUB_DELEGATION=1 npm run dev -w @cch/server
```

| Var | Default | Meaning |
| --- | --- | --- |
| `HUB_DELEGATION` | unset | `1` mounts `/delegation`; otherwise every route answers `404` |
| `HUB_WORKSPACES_ROOT` | unset | Default workspaces root; the value saved in Settings wins |
| `HUB_EDITOR` | `code` | Default editor command used by "Open"; the saved setting wins |
| `HUB_SECOND_BRAIN` | unset | Vault root for `fontes/hub/<date>.md`; the saved setting wins |
| `HUB_CLAUDE_BIN` | `claude` | Claude Code executable |
| `HUB_CODEX_BIN` | newest `codex.exe` under `%LOCALAPPDATA%\OpenAI\Codex\bin` | Codex CLI executable |
| `HUB_DELEGATION_TIMEOUT_MIN` | unset | Overrides the run timeout; when unset the `runTimeoutMinutes` setting wins (default 60, min 5, max 720). `0` disables |
| `HUB_DEV_SEED` | unset | `1` lets `POST /hook` accept an `updatedAt` override so `dev-preview.mjs --seed` can backdate sessions |
| `HUB_STALE_HOURS` | `4` | Sessions silent for longer are flagged stale (inactive) |
| `HUB_TRUSTED_ORIGINS` | unset | Extra browser origins, comma-separated (a Vite dev server) |
| `HUB_SHARE_PORT` | `4318` | Port of the share endpoint (LAN + ngrok target); only `/share/*` lives there |
| `HUB_SHARE_HOST` | `0.0.0.0` | Bind address of the share endpoint; the tunnel forwards to `localhost:<port>`, so it must stay reachable on loopback |
| `HUB_NGROK_BIN` | auto | ngrok executable; otherwise PATH, the WindowsApps alias or the copy the hub downloads |
| `HUB_URL` | derived | CLI and MCP server: full hub URL override |
| `HUB_HOME` / `CODEX_HOME` | user home | Where the Connect installers read and write client configs |

## Connect the clients

The hub ships an MCP server (`dist/mcp.js` in dev, `sidecar/mcp.cjs` in the installed app). The
Connect tab, `POST /delegation/connect/mcp` or `{"action":"connect-mcp","client":...}` registers it:

| Client | File touched | Entry |
| --- | --- | --- |
| Claude Code | `~/.claude.json` → `mcpServers.cchub` | `{ type: "stdio", command: node, args: [mcp], env: { HUB_PORT } }` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` → `mcpServers.cchub` | `{ command, args, env }` |
| Codex CLI + app | `~/.codex/config.toml` → `[mcp_servers.cchub]` | `command`, `args`, `[mcp_servers.cchub.env]` |

Restart the client after installing. Claude Desktop reads its file once and moves the entry into its
own settings, leaving `mcpServers` empty; the hub remembers the registration and keeps showing
"connected · imported by the app". Claude Desktop code sessions run Claude Code underneath and use
the Claude Code registration (`~/.claude.json`), so keep both installed. The tools every client gets:

| Tool | Purpose |
| --- | --- |
| `hub_overview` | Runtimes, sessions with subagents, Codex threads, tasks in flight or needing attention, latest reports, workspaces |
| `hub_workspaces` | Workspaces with the local path of every repo |
| `hub_delegate` | Delegate into a workspace (`workspace`, `prompt`, optional `repo`, `runner`, `model`, `permissionMode`, `sandbox`, `title`) |
| `hub_task`, `hub_tasks`, `hub_task_events` | Follow one task, list them, read the streamed log |
| `hub_continue`, `hub_cancel` | Steer or abort a run |
| `hub_report`, `hub_reports` | Leave and read reports (`progress`, `result`, `blocked`, `note`) |
| `hub_sessions`, `hub_session_live`, `hub_focus` | List Claude Code and Codex sessions; look inside one (transcript tail, subagents); bring a window to the front |
| `hub_open_workspace`, `hub_create_workspace`, `hub_delete_workspace` | Editor and workspace management |
| `hub_brain_today` | Today's diary, hub source and session trail from the linked vault |
| `hub_shares`, `hub_share_create`, `hub_share_update`, `hub_share_activity` | Share links: list, create (workspace, trust level, optional session, expiry), pause/resume/revoke/rotate/relabel, recent remote requests |
| `hub_tunnel` | Share endpoint and ngrok tunnel: `status`, `start` (installs ngrok on first use), `stop` |

Shell alias: `POST /delegation/connect/shell` appends a guarded block to `~/.bashrc` or the
PowerShell profile that exports `WORKSPACES_ROOT` and sources `shell/wk.sh` or `shell/wk.ps1`
(`wk` lists, `wk <name>` opens). A `wk` the user already defines is detected and left alone.

## Sharing: let someone else's assistant ask your Claude

A share is a link another person drops into their assistant (Claude Code, Claude Desktop, Codex,
anything that can fetch a URL or call an HTTP MCP server). Through it their assistant asks your
Claude, which has your workspace open, instead of asking you by chat.

- **Served on its own port** (`HUB_SHARE_PORT`, default 4318, bound to the LAN) that exposes nothing
  but `/share/*`. The main hub API is never reachable through it. ngrok forwards to this port only.
- **The link is the credential**: `http://<host>:4318/share/<id>?key=<key>`. API calls send the key
  as `Authorization: Bearer <key>` (or `X-Hub-Key`, or `?key=`). Compare is constant-time.
- **Trust levels** decide what the remote agent may do; every level can ask, delegate and follow its
  tasks (`ask`, `implement`, `task_status`, `tasks`). See the table below.
- **Pinned session**: a share can point at one of your sessions; answers then run
  `claude -p --resume <id> --fork-session` in that session's folder, so what your Claude already knows
  there is available and the original session stays untouched.
- **Guardrails you control**: expiry (default 24 h), pause, revoke, key rotation, per-share rate limit
  (default 30 per hour), one question and one implementation at a time, prompt size cap, a session can
  only be pinned when it runs inside the shared workspace, and every question and answer is stored
  (`hub_share_requests`), shown in the Share view, broadcast as `share-request` (clipped, no answer body)
  and written to the second brain. Remote callers get generic error messages; details stay with the owner.
- **Tunnel**: Start tunnel runs `ngrok http <share port>`; when no ngrok is found on the machine the
  hub downloads the official binary into `<data dir>/bin`. The authtoken and static domain are
  optional (Settings › Sharing); with none set ngrok uses its own config file. The public url comes
  from ngrok's JSON log and is attached to every share link while the tunnel is up.

## Persistent forks, identity, streaming and files

- **Persistent forks.** Each (share, asker) pair gets one long-lived `claude -p --input-format stream-json`
  process (`share-runner.ts`): the first question forks the pinned session (`--resume <id> --fork-session`)
  or starts a fresh session, every following question is written to the same process, so it remembers the
  conversation and answers faster. The fork id is stored (`hub_share_forks`); after an idle period
  (`HUB_SHARE_FORK_IDLE_MS`, default 20 min) or a hub restart the next question resumes the fork with
  `--resume <fork id>`. Revoke, pause and delete kill the runners.
- **Identity.** The asker sends `X-Asker: <name>` (or `asker` in the body / tool arguments); it is stored on
  every request, shown in Share › Activity, in the notification and in the guardrail prompt, and it keys
  the fork. Without it the share label is used.
- **Evidence on the original session.** The fork runs with the hub hooks injected (`--settings`), so it
  appears in Sessions as client `share` with badge "Share · <label> · <asker>"; the pinned session card
  shows "N forks · M asks" and its drawer has an **Asks** tab (`GET /api/sessions/:id/asks`).
- **Streaming.** `POST /share/:id/ask` with `Accept: text/event-stream` (or `?stream=1`) answers as
  SSE: `start`, `delta { text }`, `tool { text }`, `status`, `done { requestId, status, answer }`.
  `GET /share/:id/requests/:rid/stream` attaches to a running answer. The owner UI receives
  `share-stream` events and shows the text live under the running request.
- **Files.** `share-artifacts/<share id>/` inside the workspace context: the fork writes deliverables
  there (`GET /share/:id/files`, `GET /share/:id/files/<name>`), askers upload to `inbox/`
  (`POST /share/:id/upload?name=` raw bytes, or JSON `{ name, contentBase64 }`; 25 MB, 200 files per
  share, plain names only). MCP tools `files`, `file`, `upload`. The owner lists and downloads them from
  the share row (Files) and `GET /delegation/shares/:id/files`.
- **Stale forks.** If a stored fork id no longer resumes (transcript deleted, "No conversation found"),
  the runner restarts inside the same question: fork the owner's session again, then a fresh session; the
  asker sees a "session restarted" status and the fork id is only stored once the CLI confirmed it (`init`).
- **Secrets and the environment.** Share children get an allowlisted environment; AWS/Google provider
  variables only pass when Bedrock/Vertex is enabled. The guard denies any command that reads the
  environment (`env`, `printenv`, `set`, `$env:`, `Get-Content Env:`, `GetEnvironmentVariable`,
  `/proc/*/environ`, any `ANTHROPIC_*|AWS_*|GOOGLE_*|HUB_*|NGROK_*` name) and any command or written
  file that carries a secret value verbatim; streamed text, answers and downloaded artifacts are redacted
  against the hub's own secret values as a backstop. High trust still runs commands as the owner: treat
  it as best effort.
- **Limits.** `GET /requests/:rid/stream` answers 409 for implementation requests (follow `/tasks`);
  uploads count against `maxPerHour`; `?limit=` is clamped to 1..500; forks left by a share deleted
  mid-answer are never stored, and orphans are swept at startup.
- **GET-only clients and ChatGPT.** `GET /share/:id/ask?q=&asker=&key=` answers in `text/plain`;
  `GET /share/:id/openapi.json` is an OpenAPI 3.1 schema for a Custom GPT Action (Bearer auth). The
  handoff document is served as `text/plain` (some readers refuse `text/markdown`), starts with a
  provenance paragraph ("Published by <owner name> with CC Hub …") and the Share view offers a ready
  message to send with the link, so other assistants do not treat it as a suspicious random ngrok URL.
  Set your name in Settings › Sharing (`ownerName`).

## Trust levels

| Level | Questions (`ask`) | Implementation (`implement`) | Claude flags |
| --- | --- | --- | --- |
| Low | read-only tools, secret files blocked | plan mode: proposes a plan, edits nothing | `--restricted --strict-mcp-config --permission-prompts none --tools Read Grep Glob`, deny `Read(**/.env)` etc. |
| Medium | read tools + Write limited to `share-artifacts/<id>/` (guard `HUB_WRITE_SCOPE`) | edits files in the workspace, no shell | `acceptEdits --restricted --strict-mcp-config --permission-prompts none`, secret deny list |
| High | read tools + Write limited to `share-artifacts/<id>/` + non-destructive shell | edits and runs commands; git push/commit/reset, rm -rf, deploy, curl/wget/ssh blocked | `acceptEdits --strict-mcp-config --allowedTools Bash`, deny list of destructive commands and secrets |
| Total | everything | everything, like the owner's own delegations | `bypassPermissions`, owner MCP servers available, no deny list |

Every level below Total also runs with a **PreToolUse guard hook** (`hooks/guard.mjs`, injected with
`--settings`) that denies, by content rather than by tool name: secret files for Read, Grep, Glob and
shell commands; writes to agent, hook, git and CI configuration (`.claude/`, `.github/`, `CLAUDE.md`,
`.mcp.json`, ...); scripts and config files whose content carries blocked commands; calls to the hub
API; and, at High, wrappers such as `node -e`, `cmd /c`, `git config`, installers and env dumps. Share
children also get a minimal environment (no hub port, no tokens). **High still runs commands as your
Windows user; the guard stops accidents and the obvious escapes, it is not a sandbox. Hand High or
Total only to people you would let use your terminal.** A share that was deleted leaves its tasks at
Low. Legacy shares stored as `ask` map to Low and `implement` to Medium.

Remote surface (all under `/share/:id`, key required):

| Method and path | Purpose |
| --- | --- |
| `GET /share/:id` (or `.md`) | The handoff document: what the share allows, how to call it, the rules |
| `GET /share/:id/about` | Same as JSON |
| `POST /share/:id/ask` `{ question }` | Synchronous answer (`200`) or `202` with `requestId` when it takes longer than ~110 s |
| `GET /share/:id/requests/:requestId` | Poll a long answer |
| `POST /share/:id/implement` `{ prompt, title? }` | Implement scope only; returns `taskId` |
| `GET /share/:id/tasks` | Every task delegated through this share |
| `GET /share/:id/tasks/:taskId` | Status and result of that task (only tasks created by this share) |
| `POST /share/:id/mcp` | Streamable HTTP MCP (stateless JSON responses): tools `ask`, `request_status`, `implement`, `task_status`, `tasks`, `files`, `file`, `upload`, `about` |
| `GET /share/:id/ask?q=` | Plain-text answer for GET-only clients |
| `GET /share/:id/requests/:rid/stream` | SSE of a running answer |
| `GET /share/:id/files`, `GET /share/:id/files/:name`, `POST /share/:id/upload` | Artifacts in and out |
| `GET /share/:id/openapi.json` | OpenAPI 3.1 for Custom GPT Actions |

- **Windows Firewall**: LAN links need an inbound rule for the share port. The Share view shows whether the
  rule `VBSS CCHUB share` exists and can create it (`netsh advfirewall ... dir=in action=allow`) through a
  UAC prompt; the tunnel needs no rule.

Owner surface (loopback, under `/delegation`): `GET/POST /shares`, `PATCH/DELETE /shares/:id`
(`paused`, `revoke`, `label`, `note`, `expiresInHours`, `maxPerHour`), `GET /shares/:id/doc?base=`,
`GET /shares/activity`, `GET /tunnel`, `POST /tunnel/start|stop|install`, `PUT /tunnel/settings`,
`GET/POST /tunnel/firewall`.
MCP tools for your own agents: `hub_shares`, `hub_share_create`, `hub_share_update`,
`hub_share_activity`, `hub_tunnel`.

## Autonomous delegations, autostart and theme

- **Autonomy** (Settings › General, `autonomy` in `PUT /delegation/settings`): `full` (default) runs every
  delegation you or your agents create with `--permission-mode bypassPermissions` (Claude) or
  `--dangerously-bypass-approvals-and-sandbox` (Codex), so tasks never stop in "Needs you" for a shell
  command, and a `permissionMode` passed by the caller (other than `plan`) is upgraded to bypass so an
  orchestrating agent cannot accidentally leave a task stuck in "Needs you"; `safe` keeps `acceptEdits` and lets commands be denied. Shares ignore this and follow their
  trust level. Hub runs appear in Sessions like any other session (badge "Hub run").
- **Start with Windows** (Settings › General): writes the app path in `HKCU\...\Run`
  (`GET/PUT /delegation/system/autostart`); the desktop app passes its own path to the sidecar as
  `HUB_APP_EXE`.
- **Theme** (Settings › Appearance): Dracula by default (VS Code / Obsidian palette), "Midnight" keeps the
  previous look; stored per browser in `localStorage`, applied as `data-theme` on the root element. The
  logo never changes.

## Worktree isolation

When several agents may edit the same repo at once, delegate with `isolation: "worktree"` (default is
`shared`). The hub then runs `git -C <repo> worktree add -b hub/<task8> <ws>/.worktrees/<repo>/<task8> HEAD`
before creating the task, points the repo's `--add-dir` and the system-prompt map at the worktree, and
links `node_modules` with a junction (Windows) or symlink so installs are reused. Worktree isolation
needs a `repo` of the workspace and that repo must be a git checkout on a branch (400 otherwise).

- **What the agent sees**: the repo is mapped to the worktree, with a note to make every change there,
  never in the original checkout, and to `git add -A && git commit` on `hub/<task8>` — never push, switch
  branch or touch other worktrees. The base branch stays untouched until you merge.
- **Follow it**: `GET /delegation/tasks/:id/worktree` (also embedded under `worktree` in the task detail)
  returns `{ path, branch, baseBranch, exists, dirty, commits, diffStat, mergedAt }`.
- **Merge**: `POST /delegation/tasks/:id/merge` runs `git merge --no-ff --no-edit hub/<task8>` onto the
  base branch and sets `mergedAt`. If the original checkout is already on the base branch the merge runs
  there; otherwise the base branch is merged without disturbing the user's current checkout — into whatever
  worktree already has the base branch checked out, or into a throwaway `_merge-<task8>` worktree it creates
  next to the task worktree and removes afterwards. It answers `409` when the task is still running/pending,
  when the worktree has uncommitted changes, when there is nothing to merge, or when another merge of the
  same repo is already in flight (a per-repo lock serialises them); on a conflict it runs `git merge --abort`
  and answers `409 { error: "merge conflict", files }`, leaving every checkout clean and the base branch
  untouched. The worktree is kept (discard is a separate step).
- **Discard**: `POST /delegation/tasks/:id/worktree/discard` runs `git worktree remove --force` and
  `git branch -D hub/<task8>`, then clears `worktreePath` (branch/base/mergedAt stay for history).
- **MCP**: `hub_delegate` takes `isolation`; `hub_task_merge` (taskId, `discard?`) merges or, with
  `discard: true`, discards. `hub_overview` lists `isolation`/`branch` per task and `crowdedFolders`
  (folders with 2+ live agents) to hint when a worktree is worth it.
- Add `.worktrees/` to the workspace repo's `.gitignore` so the worktrees never get committed back.

## Security model

- **Off by default.** No `HUB_DELEGATION=1`, no routes.
- **Loopback callers only.** The hub keeps binding `0.0.0.0` for the WSL hooks; `/delegation`
  refuses any connection whose remote address is not `127.0.0.1` / `::1`.
- **Exact origin allowlist (CSRF).** Browser requests are accepted only from the hub's own origin,
  the desktop app (`http://tauri.localhost`), the Tauri dev URL or `HUB_TRUSTED_ORIGINS`.
- **Workspaces are the authority for directories.** Clients name a workspace (and optionally a
  repo); the hub resolves paths from the discovered `.code-workspace` and snapshots them on the
  task. Unknown names answer with what exists.
- **Spawn is safe.** Runners start with `shell:false` and separate argv; the prompt goes through
  stdin. Permission mode and sandbox follow the autonomy setting (default: bypass, by the owner's
  choice) or the share's trust level.
- Trust level equals the rest of the hub API: any process running as your user on this machine.

## HTTP API

Base: `http://127.0.0.1:<HUB_PORT>/delegation`

| Method and path | Body | Notes |
| --- | --- | --- |
| `GET /settings`, `PUT /settings` | `{ workspacesRoot?, editorCommand?, secondBrainRoot? }` | Roots must be existing directories; `null` clears |
| `GET /workspaces` | — | Discovered workspaces |
| `POST /workspaces` | `{ name, repos[] }` | Writes the `.code-workspace` and seeds `<name>/CLAUDE.md` |
| `PUT /workspaces/:name` | `{ repos[] }` | Replaces the repo list, keeps settings |
| `DELETE /workspaces/:name?context=1` | — | Removes the file; `context=1` also removes the context folder |
| `POST /workspaces/:name/open` | — | Opens in the editor (`code`/`cursor` resolved even off the PATH) |
| `GET /connect` | — | Shell and MCP status per client |
| `POST /connect/shell` | `{ shell: bash \| powershell, action? }` | Install or uninstall the alias |
| `POST /connect/mcp` | `{ client: claude-code \| claude-desktop \| codex, action? }` | Register or remove the MCP server |
| `GET /overview` | — | Everything in one call |
| `GET /brain/today` | — | Linked vault: diary, hub source, sessions trail |
| `GET /tasks?status=&limit=`, `GET /tasks/:id` | — | Tasks (with `lastError`); detail includes runs and reports |
| `GET /tasks/:id/events` | — | Streamed log of every run (`text`, `tool`, `status`) |
| `POST /tasks` | `{ prompt, workspace, repo?, runner?, model?, permissionMode?, sandbox?, title?, source? }` | Create and launch; `201` |
| `POST /tasks/:id/continue` | `{ prompt, model?, permissionMode? }` | Resume the same session |
| `POST /tasks/:id/cancel` | — | Abort; `202` |
| `GET /reports?taskId=&limit=`, `POST /reports` | `{ text, kind?, taskId?, sessionId?, workspace?, source? }` | Reports |

Also on the open API: `GET /api/runtimes`, `GET /api/codex/sessions`,
`GET /api/sessions/:id/agents`, `GET /api/sessions/:id/live`. SSE events on `/api/events`:
`delegation { taskId }`, `report { ... }`, `run-event { taskId, runId, kind, text }`, `share-request { id, shareId, label, kind, status, prompt }` and `tunnel { state, publicUrl, ... }`.

Statuses: `pending`, `running`, `completed`, `attention` (finished but a tool permission was
auto-denied), `failed`, `interrupted` (hub restarted mid-run) and `cancelled`. A task whose launch
never produced a session is relaunched with a fresh one on the next `continue`.

## Thin CLI

```bash
echo '{"action":"overview"}' | node apps/server/dist/cli.js
echo '{"action":"delegate","workspace":"<ws>","repo":"<repo>","prompt":"...","permissionMode":"acceptEdits"}' | node apps/server/dist/cli.js
echo '{"action":"get","taskId":"<id>"}' | node apps/server/dist/cli.js
echo '{"action":"report","text":"...","kind":"result","taskId":"<id>"}' | node apps/server/dist/cli.js
echo '{"action":"connect-mcp","client":"codex"}' | node apps/server/dist/cli.js
```

Actions: `overview`, `settings`, `set-settings`, `workspaces`, `create-workspace`,
`update-workspace`, `open`, `connect`, `connect-shell`, `connect-mcp`, `list`, `get`, `delegate`,
`continue`, `cancel`, `report`, `reports`, `brain`, `sessions`, `codex-sessions`, `runtimes`,
`focus`. In dev use `npm run -s delegate -w @cch/server`.

## UI

Sidebar navigation: **Sessions** (every Claude Code session with a client badge, Codex threads,
filters by status and client, search; a card opens a live drawer with the transcript tail,
subagents and details), **Flow** (a pannable map hub → workspaces → sessions/threads → subagents
and tasks), **Delegated** (follow, live log, continue, cancel, notes), **Workspaces** (open, edit
repos, create, delete), **Reports**, and **Settings** (paths, hooks, connections with MCP per
client and the shell alias, notifications, groups, about). Notifications are per client: Claude Desktop
spawns a short Claude Code session behind each chat step, so `claude-desktop`, `headless` and `hub` are
silent by default. The always-on-top widget is unchanged.

## Installers

`tauri build` produces both an MSI (per-machine, needs UAC) and an NSIS setup (per-user, installs
under `%LOCALAPPDATA%\VBSS CCHUB` without elevation; `/S` for silent).

## Dev preview

`scripts/dev-preview.mjs` (repo root) brings up an isolated hub + UI that never touches the installed
hub on `4317/4318` or your real `~/.codex`:

```bash
node scripts/dev-preview.mjs --seed
```

- Server on `14317` (+ share `14318`), Vite UI on `15173` with `VITE_HUB_URL` pointed at the preview hub.
- `HUB_DATA_DIR` defaults to `.tmp/dev-preview` (override with `--data <dir>`), so the preview keeps its
  own `hub.db`.
- `HUB_TRUSTED_ORIGINS` already allows the Vite origin, `HUB_EMPTY_TTL_HOURS=0` keeps seeded empty
  sessions, `HUB_SKIP=1` keeps the preview out of the real hub, and `CODEX_HOME` points at a throwaway
  temp folder unless you pass `--real-codex`.
- `--seed` POSTs a few sessions and reports through the real endpoints; historical timestamps ride the
  `updatedAt` override enabled by `HUB_DEV_SEED=1`.
- `Ctrl+C` stops the server and Vite and removes the temp Codex home.

## Tests

```bash
npm test
```

Deterministic tests use fake `claude` and `codex` executables (`test/fixtures`), a temporary data
dir, a sandbox home for the installers, a sample Codex rollout and an isolated port.
