import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const argValue = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
};

const dataArg = argValue("--data");
if (!dataArg || !isAbsolute(dataArg)) {
  console.error("usage: node scripts/demo-preview.mjs --data <absolute empty or demo folder>");
  process.exit(1);
}
const dataDir = resolve(dataArg);
const MARKER = ".cchub-demo";
if (existsSync(dataDir) && readdirSync(dataDir).length > 0 && !existsSync(join(dataDir, MARKER))) {
  console.error(`[demo] refusing to wipe ${dataDir}: it is not empty and has no ${MARKER} marker`);
  process.exit(1);
}

const portBase = Number(process.env.HUB_PORT_BASE) || 14317;
const base = `http://127.0.0.1:${portBase}`;
const uiOrigin = `http://localhost:${portBase + 2}`;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.now();

const pad = (value) => String(value).padStart(2, "0");
const dayOf = (offsetDays) => {
  const date = new Date(now + offsetDays * DAY);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const today = dayOf(0);
const yesterday = dayOf(-1);
const iso = (at) => new Date(at).toISOString();

let seed = 7;
const random = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const between = (min, max) => Math.round(min + random() * (max - min));

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const PROJECTS = [
  { slug: "acme-api", name: "Acme API", workspace: "acme-api" },
  { slug: "mobile-app", name: "Mobile app", workspace: "mobile-app" },
  { slug: "docs-site", name: "Docs site", workspace: "docs-site" },
  { slug: "billing-service", name: "Billing service", workspace: "billing-service" },
];

const vaultDir = join(dataDir, "vault");
const workspacesDir = join(dataDir, "workspaces");
const reposDir = join(dataDir, "repos");
const homeDir = join(dataDir, "home");
const codexHome = join(homeDir, ".codex");

const projectNotes = {
  "acme-api": `---
type: project
status: active
workspace: acme-api
created: ${dayOf(-60)}
updated: ${today}
---

# Acme API

**What it is:** the public REST API behind the Acme products.

## Open loops

- [-] Rate limiting per API key #p0 🛫 ${dayOf(-3)} 📅 ${dayOf(2)}
  - [x] Pick the token bucket store
  - [-] Add the middleware ⏳ ${today}
  - [ ] Load test with 5k clients ⏳ ${dayOf(1)}
- [ ] Rotate the staging signing keys #p1 📅 ${dayOf(4)}
- [ ] OpenAPI spec for the orders endpoints #p1 🛫 ${dayOf(-1)} 📅 ${dayOf(6)}
  - [ ] List and filter
  - [ ] Webhooks section
- [ ] Weekly dependency review #p2 🔁 every week 📅 ${dayOf(3)}
- [ ] Trim the error payloads #p3
- [ ] BLOCK - Move to the new gateway - waiting for the network change #p1
- [ ] HOLD - GraphQL experiment - after the rate limits ship #p3

## Done loops

- [x] Pagination on the search endpoint #p1 ✅ ${dayOf(-2)}
- [x] Health check with dependencies ✅ ${dayOf(-5)}

## Links

- repo: <https://example.com/acme/api>
`,
  "mobile-app": `---
type: project
status: active
workspace: mobile-app
created: ${dayOf(-45)}
updated: ${today}
---

# Mobile app

**What it is:** the iOS and Android app for Acme customers.

## Open loops

- [-] Offline mode for the cart #p0 🛫 ${dayOf(-5)} 📅 ${dayOf(1)}
  - [x] Queue writes while offline
  - [-] Conflict screen ⏳ ${today}
- [ ] Push notification opt-in screen #p1 📅 ${dayOf(5)}
- [ ] Fix the flaky login e2e test #p1 ⏳ ${today}
- [ ] Dark mode audit #p2 🛫 ${dayOf(2)} 📅 ${dayOf(9)}
- [ ] HOLD - Tablet layout - design review next sprint #p2

## Done loops

- [x] Crash on image picker #p0 ✅ ${dayOf(-1)}
- [x] Release 4.2 notes ✅ ${dayOf(-4)}
`,
  "docs-site": `---
type: project
status: active
workspace: docs-site
created: ${dayOf(-30)}
updated: ${today}
---

# Docs site

**What it is:** the developer documentation for the Acme API.

## Open loops

- [ ] Quickstart for the Python SDK #p1 📅 ${dayOf(3)}
- [-] Search with typo tolerance #p2 🛫 ${dayOf(-2)} 📅 ${dayOf(7)}
- [ ] Rate limit guide #p1 ⏳ ${dayOf(2)} 📅 ${dayOf(4)}
- [ ] Broken link check in CI #p3
- [ ] BLOCK - Versioned docs - waiting for the API v3 freeze #p2

## Done loops

- [x] New sidebar navigation ✅ ${dayOf(-3)}
`,
  "billing-service": `---
type: project
status: active
workspace: billing-service
created: ${dayOf(-90)}
updated: ${today}
---

# Billing service

**What it is:** invoices, payments and webhooks.

## Open loops

- [-] Webhook retries with backoff #p0 🛫 ${dayOf(-4)} 📅 ${today}
  - [x] Retry table
  - [ ] Dead letter view ⏳ ${today}
- [ ] Tax codes for the new region #p1 📅 ${dayOf(8)}
- [ ] Monthly invoice export #p2 🔁 every month 📅 ${dayOf(12)}
- [ ] HOLD - Switch the payment provider - contract review #p2

## Done loops

- [x] Idempotency keys on charges #p0 ✅ ${dayOf(-6)}
`,
};

const dailyTemplate = `---
type: daily
created: {{date}}
---

# {{date}}

## Focus

- [ ]

## Meetings

-

## Captures

-

## Sessions

-
`;

const yesterdayNote = `---
type: daily
created: ${yesterday}
---

# ${yesterday}

## Focus

- [x] [[mobile-app|Mobile app]] - Crash on image picker #p0
- [-] [[acme-api|Acme API]] - Rate limiting per API key #p0
- [ ] [[docs-site|Docs site]] - Quickstart for the Python SDK #p1

## Meetings

- 10:00 API review
- 15:30 Mobile release sync

## Captures

- idea: publish the rate limit guide with the launch

## Sessions

- 09:12 acme-api - Rate limiting middleware (14 turns)
- 14:05 mobile-app - Image picker crash (6 turns)
`;

const todayNote = `---
type: daily
created: ${today}
---

# ${today}

## Focus

- [-] [[acme-api|Acme API]] - Rate limiting per API key #p0
  - [-] Add the middleware
- [ ] [[billing-service|Billing service]] - Webhook retries with backoff #p0
  - [ ] Dead letter view
- [ ] [[mobile-app|Mobile app]] - Fix the flaky login e2e test #p1
- [ ] [[acme-api|Acme API]] - Rotate the staging signing keys #p1

## Meetings

- 09:30 Standup
- 14:00 Billing webhooks review

## Captures

- check the 429 response body with the docs team

## Sessions

-
`;

const git = (cwd, ...argv) => {
  const result = spawnSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", ...argv], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${argv.join(" ")} failed: ${result.stderr}`);
};

const displayCwd = (slug) => `C:/work/${slug}`;

const writeVaultAndRepos = () => {
  for (const [slug, text] of Object.entries(projectNotes)) write(join(vaultDir, "projects", `${slug}.md`), text);
  write(join(vaultDir, "_templates", "daily.md"), dailyTemplate);
  write(join(vaultDir, "daily", `${yesterday}.md`), yesterdayNote);
  write(join(vaultDir, "daily", `${today}.md`), todayNote);
  mkdirSync(join(vaultDir, "trail"), { recursive: true });
  for (const project of PROJECTS) {
    const repo = join(reposDir, project.slug);
    write(join(repo, "README.md"), `# ${project.name}\n\nDemo repository.\n`);
    write(join(repo, "src", "index.ts"), `export const name = "${project.slug}";\n`);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "chore: initial demo commit");
    const folders = [{ path: repo.replace(/\\/g, "/") }, { path: displayCwd(project.slug) }];
    write(join(workspacesDir, `${project.workspace}.code-workspace`), `${JSON.stringify({ folders }, null, 2)}\n`);
    write(join(workspacesDir, project.workspace, "CLAUDE.md"), `# ${project.name}\n\nDemo workspace context.\n`);
  }
};

const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"];

const writeClaudeUsage = () => {
  const projectsDir = join(homeDir, ".claude", "projects");
  let counter = 0;
  for (let offset = 6; offset >= 0; offset -= 1) {
    for (const project of PROJECTS) {
      const sessions = between(1, 3);
      for (let index = 0; index < sessions; index += 1) {
        counter += 1;
        const sessionId = `00000000-demo-4000-8000-${String(counter).padStart(12, "0")}`;
        const cwd = `C:/work/${project.slug}`;
        const start = now - offset * DAY - between(1, 9) * HOUR;
        const model = CLAUDE_MODELS[(counter + offset) % CLAUDE_MODELS.length];
        const lines = [];
        const turns = between(8, 30);
        for (let turn = 0; turn < turns; turn += 1) {
          const at = Math.min(now - MINUTE, start + turn * between(1, 4) * MINUTE);
          lines.push(JSON.stringify({ type: "user", cwd, sessionId, timestamp: iso(at), message: { role: "user", content: "Continue with the next step" } }));
          lines.push(
            JSON.stringify({
              type: "assistant",
              cwd,
              sessionId,
              timestamp: iso(at + 20_000),
              message: {
                role: "assistant",
                model,
                content: [{ type: "text", text: "Done with this step." }],
                usage: {
                  input_tokens: between(4, 60),
                  cache_creation_input_tokens: between(1_000, 12_000),
                  cache_read_input_tokens: between(30_000, 160_000) + turn * 4_000,
                  output_tokens: between(300, 2_400),
                },
              },
            }),
          );
        }
        write(join(projectsDir, `C--work-${project.slug}`, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
      }
    }
  }
};

const writeClaudeLimitsCache = () => {
  const utilization = {
    five_hour: { utilization: 62, resets_at: iso(now + 2 * HOUR + 10 * MINUTE) },
    seven_day: { utilization: 63, resets_at: iso(now + 2 * DAY + 5 * HOUR) },
    seven_day_opus: { utilization: 38, resets_at: iso(now + 2 * DAY + 5 * HOUR) },
    seven_day_sonnet: { utilization: 22, resets_at: iso(now + 2 * DAY + 5 * HOUR) },
  };
  write(join(homeDir, ".claude.json"), `${JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: now - 2 * MINUTE, utilization } }, null, 2)}\n`);
};

const CODEX_PROMPTS = [
  "Review the open pull request",
  "Explain why the invoice job retries twice",
  "Write the changelog for this week",
  "Find dead code in the handlers",
  "Check the docs build warnings",
  "Draft tests for the export job",
  "Bump dependencies and fix the lint errors",
];

const writeCodexSessions = () => {
  const codexProjects = [PROJECTS[0], PROJECTS[2], PROJECTS[3]];
  let counter = 0;
  for (let offset = 6; offset >= 0; offset -= 1) {
    for (const project of codexProjects) {
      if (random() < 0.35) continue;
      counter += 1;
      const id = `0190demo-0000-7000-8000-${String(counter).padStart(12, "0")}`;
      const start = now - offset * DAY - between(1, 8) * HOUR;
      const date = new Date(start);
      const folder = join(codexHome, "sessions", String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()));
      const cwd = `C:\\work\\${project.slug}`;
      const lines = [
        { timestamp: iso(start), type: "session_meta", payload: { id, session_id: id, timestamp: iso(start), cwd, originator: "codex_cli_rs", cli_version: "0.160.0", source: "cli", model_provider: "openai" } },
        { timestamp: iso(start + 500), type: "turn_context", payload: { cwd, model: "gpt-5.5-codex" } },
        { timestamp: iso(start + 1_000), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${CODEX_PROMPTS[counter % CODEX_PROMPTS.length]} in ${project.name}` }] } },
      ];
      let total = 0;
      const turns = between(4, 12);
      let lastAt = start;
      for (let turn = 0; turn < turns; turn += 1) {
        const at = Math.min(now - MINUTE, start + (turn + 1) * 3 * MINUTE);
        const input = between(20_000, 90_000);
        const output = between(400, 3_000);
        total += input + output;
        lastAt = at + 2_000;
        lines.push({ timestamp: iso(at - 60_000), type: "event_msg", payload: { type: "task_started" } });
        lines.push({ timestamp: iso(at), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checked the change." }] } });
        lines.push({ timestamp: iso(lastAt), type: "event_msg", payload: { type: "task_complete" } });
        lines.push({
          timestamp: iso(at + 1_000),
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: input, cached_input_tokens: Math.round(input * 0.8), output_tokens: output, reasoning_output_tokens: Math.round(output / 3), total_tokens: input + output },
              total_token_usage: { total_tokens: total },
            },
            rate_limits: {
              primary: { used_percent: 58, window_minutes: 300, resets_in_seconds: Math.max(60, Math.round((now + 3 * HOUR - at) / 1000)) },
              secondary: { used_percent: 54, window_minutes: 10_080, resets_in_seconds: Math.max(60, Math.round((now + 4 * DAY - at) / 1000)) },
              plan_type: "pro",
            },
          },
        });
      }
      const stamp = iso(start).replace(/[:.]/g, "-").slice(0, 19);
      const file = join(folder, `rollout-${stamp}-${id}.jsonl`);
      write(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      utimesSync(file, new Date(lastAt), new Date(lastAt));
    }
  }
};

const prepare = () => {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, MARKER), "demo data for scripts/demo-preview.mjs; safe to delete\n");
  writeVaultAndRepos();
  mkdirSync(join(homeDir, ".claude", "projects"), { recursive: true });
  writeClaudeUsage();
  writeClaudeLimitsCache();
  writeCodexSessions();
};

const request = async (method, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: uiOrigin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) console.warn(`[demo] ${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const waitForHub = async () => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  throw new Error("hub did not come up on time");
};

const seedLimitSamples = () => {
  const Database = createRequire(join(repoRoot, "apps", "server", "package.json"))("better-sqlite3");
  const db = new Database(join(dataDir, "hub.db"));
  try {
    const insert = db.prepare("INSERT OR IGNORE INTO hub_limit_samples (series, at, used, resets_at) VALUES (?, ?, ?, ?)");
    const series = [
      ["claude.fiveHour", 62, 2 * HOUR + 10 * MINUTE, 90 * MINUTE, 22],
      ["claude.sevenDay", 63, 2 * DAY + 5 * HOUR, 2 * DAY, 36],
      ["codex.primary", 58, 3 * HOUR, 90 * MINUTE, 18],
      ["codex.secondary", 54, 4 * DAY, 2 * DAY, 30],
    ];
    for (const [name, current, resetsIn, span, start] of series) {
      for (let step = 0; step <= 8; step += 1) {
        const at = now - span + (span * step) / 8;
        insert.run(name, Math.round(at), start + ((current - start) * step) / 8, now + resetsIn);
      }
    }
  } finally {
    db.close();
  }
};

const SESSIONS = [
  { id: "demo-claude-1", project: "acme-api", title: "Rate limiting middleware", model: "claude-opus-5-5", kind: "notification", message: "Claude needs your permission to use Bash", ago: 1, ctx: 182_000, tin: 2_400_000, tout: 260_000 },
  { id: "demo-claude-2", project: "billing-service", title: "Webhook retries with backoff", model: "claude-opus-5-5", kind: "user_prompt", message: "Writing the retry worker", ago: 0, ctx: 96_000, tin: 1_100_000, tout: 140_000 },
  { id: "demo-claude-3", project: "mobile-app", title: "Flaky login e2e test", model: "claude-sonnet-5-5", kind: "user_prompt", message: "Re-running the suite", ago: 0, ctx: 41_000, tin: 380_000, tout: 52_000 },
  { id: "demo-claude-4", project: "docs-site", title: "Python SDK quickstart", model: "claude-sonnet-5-5", kind: "stop", message: "Draft ready for review", ago: 14, ctx: 64_000, tin: 520_000, tout: 88_000 },
  { id: "demo-claude-5", project: "acme-api", title: "OpenAPI spec for orders", model: "claude-opus-5-5", kind: "stop", message: "Spec covers list and filter", ago: 38, ctx: 120_000, tin: 900_000, tout: 110_000 },
  { id: "demo-claude-6", project: "mobile-app", title: "Offline cart conflicts", model: "claude-opus-5-5", kind: "notification", message: "Which version should win on conflict?", ago: 6, ctx: 150_000, tin: 1_700_000, tout: 190_000 },
];

const seedHub = async () => {
  await request("PUT", "/delegation/settings", {
    ownerName: "Demo",
    workspacesRoot: workspacesDir,
    secondBrainRoot: vaultDir,
    features: { daily: true, trail: true, usage: true, limits: true, tasks: true, flow: true, delegated: true, workspaces: true, reports: true, share: true, widget: true },
    daily: { dir: "daily", template: "_templates/daily.md" },
    tasks: { root: "projects" },
    trail: { dir: "trail" },
    memory: { historyIndex: true, handoffWorkspaces: ["acme-api"] },
    limits: { claude: true, codex: true },
    widget: { rings: { claude: true, codex: true } },
  });
  for (const session of SESSIONS) {
    await request("POST", "/hook", {
      sessionId: session.id,
      kind: "session_start",
      client: "terminal",
      cwd: displayCwd(session.project),
      model: session.model,
      title: session.title,
      claudePid: process.pid,
      updatedAt: now - (session.ago + 30) * MINUTE,
    });
    await request("POST", "/hook", {
      sessionId: session.id,
      kind: session.kind,
      client: session.id === "demo-claude-3" ? "vscode" : "terminal",
      cwd: displayCwd(session.project),
      model: session.model,
      title: session.title,
      message: session.message,
      tokensIn: session.tin,
      tokensOut: session.tout,
      contextTokens: session.ctx,
      claudePid: process.pid,
      updatedAt: now - session.ago * MINUTE,
    });
  }
  const permission = await request("POST", "/api/permissions/request", {
    agent: "claude",
    sessionId: "demo-claude-1",
    toolName: "Bash",
    toolInput: { command: "npm run test:load -- --clients 5000", description: "Run the load test against staging" },
    cwd: displayCwd("acme-api"),
  });
  if (permission?.id && permission.waitToken) {
    void fetch(`${base}/api/permissions/${permission.id}/wait`, { headers: { "x-hub-wait-token": permission.waitToken, origin: uiOrigin } }).catch(() => undefined);
  }
  await request("POST", "/delegation/tasks", { title: "Add pagination tests", prompt: "Add tests for the pagination of the search endpoint.", workspace: "acme-api", runner: "claude" });
  await request("POST", "/delegation/tasks", { title: "Update the changelog", prompt: "Summarize this week's merged changes in the changelog.", workspace: "docs-site", runner: "codex" });
  const routine = await request("POST", "/delegation/routines", {
    name: "Morning dependency check",
    prompt: "Check for outdated dependencies and list the safe upgrades.",
    runner: "claude",
    workspace: "acme-api",
    schedule: { kind: "weekdays", time: "08:30", days: [1, 2, 3, 4, 5] },
    enabled: true,
  });
  await request("POST", "/delegation/routines", {
    name: "Nightly docs link check",
    prompt: "Find broken links in the docs and open a report.",
    runner: "codex",
    workspace: "docs-site",
    schedule: { kind: "daily", time: "23:00" },
    enabled: true,
  });
  if (routine?.id) await request("POST", `/delegation/routines/${routine.id}/run`, {});
  await request("POST", "/delegation/reports", { text: "Pagination tests added for the search endpoint; 18 new cases, all green.", kind: "progress", source: "demo" });
  await request("POST", "/delegation/reports", { text: "Docs changelog drafted for this week, waiting for review.", kind: "note", source: "demo" });
  seedLimitSamples();
  const nowSeconds = Math.round(now / 1000);
  await request("POST", "/delegation/limits/claude-source/report", {
    sessionId: "demo-claude-2",
    rateLimits: { five_hour: { used_percentage: 62, resets_at: nowSeconds + 7_800 }, seven_day: { used_percentage: 63, resets_at: nowSeconds + 190_800 } },
  });
  await request("POST", "/delegation/limits/refresh", {});
};

prepare();
console.log(`[demo] data written to ${dataDir}`);

const child = spawn(process.execPath, [join(repoRoot, "scripts", "dev-preview.mjs"), "--data", dataDir], {
  cwd: repoRoot,
  env: { ...process.env, HUB_PORT_BASE: String(portBase), PREVIEW_CODEX_HOME: codexHome },
  stdio: ["ignore", "inherit", "inherit"],
});
const stop = () => {
  child.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => {
  console.log(`[demo] preview exited (${code})`);
  process.exit(code ?? 0);
});

await waitForHub();
await seedHub();
console.log(`[demo] seeded; open ${uiOrigin}`);
