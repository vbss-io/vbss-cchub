import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { composeDaily, type ComposeBoard } from "../src/daily.js";
import type { DelegationSettings } from "../src/delegation-types.js";
import { makeSandbox, startServer, type RunningServer, type Sandbox } from "./helpers.js";

interface HttpResult {
  status: number;
  json: Record<string, unknown>;
}

const VAULT: Record<string, string> = {
  "acme.md": "---\ntitle: Acme Corp\n---\n\n## Open loops\n\n- [ ] Renew contract\n",
  "globex.md": "---\ntitle: Globex\n---\n\n## Open loops\n\n- [ ] Rollout checklist\n",
  "initech.md": "# Initech\n\n## Open loops\n\n- [ ] Pilot validation\n",
  "umbrella.md": "---\ntitle: Umbrella\n---\n\n## Open loops\n\n- [ ] Vaccine stock\n",
};

const DATE = "2026-04-02";
const TEMPLATE = "# {{date}}\n\n## Foco de hoje\n\n- [ ]\n\n## Reuniões\n\n-\n\n## Sessões\n\n-\n";
const HEADINGS: DelegationSettings["daily"]["headings"] = { focus: "Foco de hoje", meetings: "Reuniões", sessions: "Sessões" };

function stubBoard(order: string[]): ComposeBoard {
  const projects = [
    { id: "acme", name: "acme", title: "Acme Corp" },
    { id: "initech", name: "initech", title: "Initech" },
  ];
  const byLabel = (label: string): string | null => {
    const wanted = label.trim().toLowerCase();
    return projects.find((project) => project.name === wanted || project.title.toLowerCase() === wanted)?.id ?? null;
  };
  return {
    projects,
    order,
    projectOfLabel: byLabel,
    projectOfLine: (text) => {
      const wiki = text.match(/^\[\[([^\]|]*)/);
      if (wiki) return byLabel(wiki[1] ?? "");
      const sep = text.indexOf(" - ");
      return sep === -1 ? null : byLabel(text.slice(0, sep));
    },
  };
}

describe("composeDaily with a board", () => {
  it("labels, orders and groups with exactly one blank line between groups and none inside", () => {
    const content = composeDaily(
      TEMPLATE,
      {
        focus: [
          { project: "initech", text: "Pilot" },
          { project: "Acme Corp", text: "Renew" },
          { project: "INITECH", text: "Second" },
          { project: "acme", text: "Audit" },
        ],
        meetings: [],
        sessions: [],
      },
      { date: DATE, headings: HEADINGS, wikilinks: true, board: stubBoard(["acme", "initech"]) },
    );
    assert.equal(
      content,
      "# 2026-04-02\n\n## Foco de hoje\n\n" +
        "- [ ] [[acme|Acme Corp]] - Renew\n- [ ] [[acme|Acme Corp]] - Audit\n\n" +
        "- [ ] [[initech|Initech]] - Pilot\n- [ ] [[initech|Initech]] - Second\n\n" +
        "## Reuniões\n\n-\n\n## Sessões\n\n-\n",
    );
  });

  it("follows the given effective order and sends unresolved items last in their relative order", () => {
    const content = composeDaily(
      TEMPLATE,
      {
        focus: [
          { project: null, text: "Loose" },
          { project: "acme", text: "Renew" },
          { project: "Ghost", text: "Mystery" },
          { project: "initech", text: "Pilot" },
        ],
        meetings: [],
        sessions: [],
      },
      { date: DATE, headings: HEADINGS, wikilinks: false, board: stubBoard(["initech", "acme"]) },
    );
    assert.match(content, /## Foco de hoje\n\n- \[ \] Initech - Pilot\n\n- \[ \] Acme Corp - Renew\n\n- \[ \] Loose\n\n- \[ \] Ghost - Mystery\n\n## Reuniões/);
  });

  it("keeps the block text, only turning a bare known [[name]] label into [[name|Title]], and keeps nested lines", () => {
    const content = composeDaily(
      TEMPLATE,
      {
        focus: [
          { project: null, text: "x", block: "- [-] [[initech]] - Doing thing\n  - [x] nested one\n  - [ ] nested two" },
          { project: null, text: "y", block: "- [ ] [[acme|Custom]] - Keep alias" },
          { project: null, text: "z", block: "- [ ] [[ghost]] - Unknown stays" },
        ],
        meetings: [],
        sessions: [],
      },
      { date: DATE, headings: HEADINGS, wikilinks: true, board: stubBoard(["acme", "initech"]) },
    );
    assert.match(
      content,
      /## Foco de hoje\n\n- \[ \] \[\[acme\|Custom\]\] - Keep alias\n\n- \[-\] \[\[initech\|Initech\]\] - Doing thing\n  - \[x\] nested one\n  - \[ \] nested two\n\n- \[ \] \[\[ghost\]\] - Unknown stays\n\n## Reuniões/,
    );
  });

  it("behaves as before when no board is given", () => {
    const content = composeDaily(
      TEMPLATE,
      { focus: [{ project: "initech", text: "Pilot" }, { project: "acme", text: "Renew" }], meetings: [], sessions: [] },
      { date: DATE, headings: HEADINGS, wikilinks: true },
    );
    assert.match(content, /## Foco de hoje\n\n- \[ \] \[\[initech\]\] - Pilot\n\n- \[ \] \[\[acme\]\] - Renew\n\n## Reuniões/);
  });
});

describe("POST /delegation/daily/:date/compose with the tasks feature", () => {
  const box: Sandbox = makeSandbox("cch-compose-order-");
  const vault = join(box.tmp, "vault");
  const dailyPath = join(box.brain, "daily", `${DATE}.md`);
  let hub: RunningServer;

  async function http(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const res = await fetch(`${hub.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  const settings = (patch: Record<string, unknown>): Promise<HttpResult> => http("PUT", "/delegation/settings", patch);
  const compose = (focus: Record<string, unknown>[]): Promise<HttpResult> =>
    http("POST", `/delegation/daily/${DATE}/compose`, { focus, meetings: [], overwrite: true });
  const focusSection = (): string => {
    const content = readFileSync(dailyPath, "utf8");
    const start = content.indexOf("## Foco de hoje\n");
    assert.notEqual(start, -1);
    const end = content.indexOf("\n## ", start + 4);
    return content.slice(start, end === -1 ? undefined : end + 1);
  };

  before(async () => {
    for (const [rel, content] of Object.entries(VAULT)) {
      const full = join(vault, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    mkdirSync(join(box.brain, "_templates"), { recursive: true });
    writeFileSync(join(box.brain, "_templates", "daily.md"), TEMPLATE);
    hub = await startServer(box, { HUB_DELEGATION: "1" });
    const res = await settings({
      workspacesRoot: box.root,
      secondBrainRoot: box.brain,
      features: { daily: true, tasks: true },
      daily: { wikilinks: true, headings: HEADINGS },
      tasks: { root: vault, doneSection: "Done loops" },
    });
    assert.equal(res.status, 200);
  });

  beforeEach(async () => {
    assert.equal((await settings({ features: { daily: true, tasks: true }, daily: { wikilinks: true, projectOrder: [] } })).status, 200);
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("writes [[name|Title]] for a typed project matched by name or title, in tree order, one blank line between projects", async () => {
    const res = await compose([
      { project: "initech", text: "Pilot validation" },
      { project: "ACME corp", text: "Renew contract" },
      { project: "Initech", text: "Second" },
      { project: "Ghost", text: "Mystery" },
    ]);
    assert.equal(res.status, 200);
    assert.equal(
      focusSection(),
      "## Foco de hoje\n\n" +
        "- [ ] [[acme|Acme Corp]] - Renew contract\n\n" +
        "- [ ] [[initech|Initech]] - Pilot validation\n- [ ] [[initech|Initech]] - Second\n\n" +
        "- [ ] [[Ghost]] - Mystery\n\n",
    );
  });

  it("honours daily.projectOrder ahead of the tree order and writes the title alone without wikilinks", async () => {
    assert.equal((await settings({ daily: { projectOrder: ["umbrella", "initech"] } })).status, 200);
    await compose([
      { project: "acme", text: "Renew contract" },
      { project: "umbrella", text: "Vaccine stock" },
      { project: "initech", text: "Pilot validation" },
    ]);
    assert.equal(
      focusSection(),
      "## Foco de hoje\n\n- [ ] [[umbrella|Umbrella]] - Vaccine stock\n\n- [ ] [[initech|Initech]] - Pilot validation\n\n- [ ] [[acme|Acme Corp]] - Renew contract\n\n",
    );
    assert.equal((await settings({ daily: { wikilinks: false } })).status, 200);
    await compose([{ project: "umbrella", text: "Vaccine stock" }, { project: "acme", text: "Renew contract" }]);
    assert.equal(focusSection(), "## Foco de hoje\n\n- [ ] Umbrella - Vaccine stock\n\n- [ ] Acme Corp - Renew contract\n\n");
  });

  it("resolves carried and doing blocks from their first line and fixes only a bare known [[name]]", async () => {
    await compose([
      { project: null, text: "Doing thing", block: "- [-] [[initech]] - Doing thing\n  - [x] nested one" },
      { project: null, text: "Plain", block: "- [ ] Globex - Rollout checklist" },
      { project: "acme", text: "Renew contract" },
      { project: null, text: "Lonely" },
    ]);
    assert.equal(
      focusSection(),
      "## Foco de hoje\n\n" +
        "- [ ] [[acme|Acme Corp]] - Renew contract\n\n" +
        "- [ ] Globex - Rollout checklist\n\n" +
        "- [-] [[initech|Initech]] - Doing thing\n  - [x] nested one\n\n" +
        "- [ ] Lonely\n\n",
    );
  });

  it("is unchanged when the tasks feature is off", async () => {
    assert.equal((await settings({ features: { daily: true, tasks: false } })).status, 200);
    await compose([
      { project: "initech", text: "Pilot validation" },
      { project: "acme", text: "Renew contract" },
    ]);
    assert.equal(focusSection(), "## Foco de hoje\n\n- [ ] [[initech]] - Pilot validation\n\n- [ ] [[acme]] - Renew contract\n\n");
  });
});
