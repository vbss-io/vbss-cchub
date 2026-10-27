import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { focusLinesPreserved, organizeFocus, type ComposeBoard } from "../src/daily.js";
import { makeSandbox, startServer, type RunningServer, type Sandbox } from "./helpers.js";

interface HttpResult {
  status: number;
  json: Record<string, unknown>;
}

const HEADING = "Foco de hoje";
const BOM = String.fromCharCode(0xfeff);

function stubBoard(order: string[]): ComposeBoard {
  const projects = [
    { id: "acme", name: "acme", title: "Acme Corp" },
    { id: "initech", name: "initech", title: "Initech" },
    { id: "umbrella", name: "umbrella", title: "Umbrella" },
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
      const wiki = text.match(/^\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/);
      if (wiki) return byLabel(wiki[1] ?? "") ?? (wiki[2] ? byLabel(wiki[2]) : null);
      const sep = text.indexOf(" - ");
      return sep === -1 ? null : byLabel(text.slice(0, sep));
    },
  };
}

const MESSY = [
  "# 2026-04-02",
  "",
  "## Foco de hoje",
  "- [ ] [[umbrella|Umbrella]] - Align with the project spec",
  "- [-] [[hooli|Hooli]] - Fixes found in the tests",
  "- [-] [[initech]] - Provider credits dashboard",
  "- [-] [[acme]] - Auto login after e-mail validation",
  "  - [x] server part",
  "  - [ ] client part",
  "- [ ] [[acme]] - Queue base - running in another session",
  "- [ ] [[hooli|Hooli]] - Extract Hooli exporter",
  "- Loose plain note",
  "- [ ]",
  "",
  "",
  "## Reuniões",
  "",
  "- Standup",
  "",
].join("\n");

const MESSY_ORGANIZED = [
  "# 2026-04-02",
  "",
  "## Foco de hoje",
  "",
  "- [ ] [[umbrella|Umbrella]] - Align with the project spec",
  "",
  "- [-] [[acme|Acme Corp]] - Auto login after e-mail validation",
  "  - [x] server part",
  "  - [ ] client part",
  "- [ ] [[acme|Acme Corp]] - Queue base - running in another session",
  "",
  "- [-] [[initech|Initech]] - Provider credits dashboard",
  "",
  "- [-] [[hooli|Hooli]] - Fixes found in the tests",
  "- [ ] [[hooli|Hooli]] - Extract Hooli exporter",
  "",
  "- Loose plain note",
  "",
  "## Reuniões",
  "",
  "- Standup",
  "",
].join("\n");

const opts = (board: ComposeBoard | null, wikilinks = true) => ({ heading: HEADING, wikilinks, board });

describe("organizeFocus", () => {
  it("groups the messy tail by project order, fixes bare known labels and drops the placeholder", () => {
    const result = organizeFocus(MESSY, opts(stubBoard(["umbrella", "acme", "initech"])));
    assert.equal(result.content, MESSY_ORGANIZED);
    assert.equal(result.changed, true);
    assert.equal(result.groups, 5);
  });

  it("is idempotent", () => {
    const board = stubBoard(["umbrella", "acme", "initech"]);
    const first = organizeFocus(MESSY, opts(board));
    const second = organizeFocus(first.content, opts(board));
    assert.equal(second.changed, false);
    assert.equal(second.content, first.content);
    assert.equal(second.groups, 5);
  });

  it("moves nested subtasks, notes, blank-then-indented lines and fences with their parent", () => {
    const input = [
      "## Foco de hoje",
      "",
      "- [ ] Initech - Pilot",
      "  some note line",
      "- [ ] Umbrella - Rollout",
      "",
      "  continuation after a blank",
      "  ```",
      "raw line at column zero",
      "  ```",
      "- [x] Acme Corp - Renew",
      "  - [ ] child",
      "    - [-] grandchild",
      "",
      "## Next",
      "",
    ].join("\n");
    const result = organizeFocus(input, opts(stubBoard(["acme", "umbrella", "initech"])));
    assert.equal(
      result.content,
      [
        "## Foco de hoje",
        "",
        "- [x] Acme Corp - Renew",
        "  - [ ] child",
        "    - [-] grandchild",
        "",
        "- [ ] Umbrella - Rollout",
        "",
        "  continuation after a blank",
        "  ```",
        "raw line at column zero",
        "  ```",
        "",
        "- [ ] Initech - Pilot",
        "  some note line",
        "",
        "## Next",
        "",
      ].join("\n"),
    );
  });

  it("puts unresolved labels and plain lines last, keeping their relative order", () => {
    const input = ["## Foco de hoje", "", "Free text line", "- [ ] no label here", "- [ ] Ghost - Mystery", "- [ ] Acme Corp - Renew", "* [ ] star item", ""].join("\n");
    const result = organizeFocus(input, opts(stubBoard(["acme"])));
    assert.equal(
      result.content,
      ["## Foco de hoje", "", "- [ ] Acme Corp - Renew", "", "- [ ] Ghost - Mystery", "", "Free text line", "- [ ] no label here", "* [ ] star item", ""].join("\n"),
    );
  });

  it("only rewrites a bare [[name]] of a known project and leaves aliases and unknown links alone", () => {
    const input = ["## Foco de hoje", "- [ ] [[acme|acme corp]] - Keep my alias", "- [ ] [[acme]] - Bare", "- [ ] [[ghost]] - Unknown", "- [[initech]] - not a task", ""].join("\n");
    const result = organizeFocus(input, opts(stubBoard(["acme", "initech"])));
    assert.equal(
      result.content,
      ["## Foco de hoje", "", "- [ ] [[acme|acme corp]] - Keep my alias", "- [ ] [[acme|Acme Corp]] - Bare", "", "- [[initech|Initech]] - not a task", "", "- [ ] [[ghost]] - Unknown", ""].join("\n"),
    );
    const plain = organizeFocus(input, opts(stubBoard(["acme", "initech"]), false));
    assert.match(plain.content, /- \[ \] \[\[acme\]\] - Bare/);
    assert.match(plain.content, /- \[\[initech\]\] - not a task/);
  });

  it("without a board regroups by the literal label in first-appearance order and rewrites nothing", () => {
    const result = organizeFocus(MESSY, opts(null));
    assert.equal(
      result.content,
      [
        "# 2026-04-02",
        "",
        "## Foco de hoje",
        "",
        "- [ ] [[umbrella|Umbrella]] - Align with the project spec",
        "",
        "- [-] [[hooli|Hooli]] - Fixes found in the tests",
        "- [ ] [[hooli|Hooli]] - Extract Hooli exporter",
        "",
        "- [-] [[initech]] - Provider credits dashboard",
        "",
        "- [-] [[acme]] - Auto login after e-mail validation",
        "  - [x] server part",
        "  - [ ] client part",
        "- [ ] [[acme]] - Queue base - running in another session",
        "",
        "- Loose plain note",
        "",
        "## Reuniões",
        "",
        "- Standup",
        "",
      ].join("\n"),
    );
  });

  it("keeps CRLF, the BOM and every line outside the focus section", () => {
    const input = `${BOM}${MESSY.split("\n").join("\r\n")}`;
    const result = organizeFocus(input, opts(stubBoard(["umbrella", "acme", "initech"])));
    assert.equal(result.content, `${BOM}${MESSY_ORGANIZED.split("\n").join("\r\n")}`);
    assert.equal(result.content.replace(/\r\n/g, "").includes("\n"), false);
  });

  it("keeps a lone placeholder, handles a focus section at the end of the file and reports unchanged input", () => {
    const empty = ["## Foco de hoje", "", "- [ ]", "", "## Next", ""].join("\n");
    const emptyResult = organizeFocus(empty, opts(stubBoard(["acme"])));
    assert.equal(emptyResult.changed, false);
    assert.equal(emptyResult.content, empty);
    const tail = "# Day\n\n## Foco de hoje\n- [ ] Initech - b\n- [ ] Acme Corp - a\n\n\n";
    assert.equal(organizeFocus(tail, opts(stubBoard(["acme", "initech"]))).content, "# Day\n\n## Foco de hoje\n\n- [ ] Acme Corp - a\n\n- [ ] Initech - b\n");
    const noEol = "## Foco de hoje\n- [ ] Initech - b\n- [ ] Acme Corp - a";
    assert.equal(organizeFocus(noEol, opts(stubBoard(["acme", "initech"]))).content, "## Foco de hoje\n\n- [ ] Acme Corp - a\n\n- [ ] Initech - b");
  });

  it("throws when the focus heading is missing", () => {
    assert.throws(() => organizeFocus("# Day\n\n## Other\n- x\n", opts(null)), /focus heading/);
  });
});

describe("focusLinesPreserved", () => {
  it("accepts a reorder with allowed rewrites and drops", () => {
    assert.equal(focusLinesPreserved(["a", "", "b", "- [ ]"], ["b", "", "", "A"], [["a", "A"]], ["- [ ]"]), true);
  });

  it("rejects a lost, duplicated or invented line", () => {
    assert.equal(focusLinesPreserved(["a", "b"], ["a"], [], []), false);
    assert.equal(focusLinesPreserved(["a", "b"], ["a", "b", "b"], [], []), false);
    assert.equal(focusLinesPreserved(["a", "b"], ["a", "c"], [], []), false);
  });
});

const VAULT: Record<string, string> = {
  "acme.md": "---\ntitle: Acme Corp\n---\n\n## Open loops\n\n- [ ] Renew contract\n",
  "globex.md": "---\ntitle: Globex\n---\n\n## Open loops\n\n- [ ] Rollout checklist\n",
  "initech.md": "# Initech\n\n## Open loops\n\n- [ ] Pilot validation\n",
  "umbrella.md": "---\ntitle: Umbrella\n---\n\n## Open loops\n\n- [ ] Vaccine stock\n",
};

function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

describe("POST /delegation/daily/:date/organize-focus", () => {
  const box: Sandbox = makeSandbox("cch-daily-organize-");
  const vault = join(box.tmp, "vault");
  const DATE = "2026-04-02";
  const dailyPath = (date: string): string => join(box.brain, "daily", `${date}.md`);
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
  const organize = (date: string, body: Record<string, unknown> = {}): Promise<HttpResult> => http("POST", `/delegation/daily/${date}/organize-focus`, body);
  const writeDailyFile = (date: string, content: string): void => {
    mkdirSync(dirname(dailyPath(date)), { recursive: true });
    writeFileSync(dailyPath(date), content);
  };

  before(async () => {
    for (const [rel, content] of Object.entries(VAULT)) {
      const full = join(vault, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    hub = await startServer(box, { HUB_DELEGATION: "1" });
    const res = await settings({
      workspacesRoot: box.root,
      secondBrainRoot: box.brain,
      features: { daily: true, tasks: true },
      daily: { wikilinks: true, headings: { focus: HEADING, meetings: "Reuniões", sessions: "Sessões" } },
      tasks: { root: vault, doneSection: "Done loops" },
    });
    assert.equal(res.status, 200);
  });

  beforeEach(async () => {
    assert.equal((await settings({ features: { daily: true, tasks: true }, daily: { wikilinks: true, projectOrder: ["umbrella", "acme", "initech"] } })).status, 200);
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("organizes the messy tail with the board labels and order, then reports changed:false", async () => {
    writeDailyFile(DATE, MESSY);
    const res = await organize(DATE);
    assert.equal(res.status, 200);
    assert.equal(res.json.changed, true);
    assert.equal(res.json.groups, 5);
    assert.equal(res.json.date, DATE);
    assert.equal(res.json.path, dailyPath(DATE));
    assert.equal(typeof res.json.updatedAt, "number");
    assert.equal(readFileSync(dailyPath(DATE), "utf8"), MESSY_ORGANIZED);
    const mtime = statSync(dailyPath(DATE)).mtimeMs;
    const again = await organize(DATE, { baseUpdatedAt: res.json.updatedAt });
    assert.equal(again.status, 200);
    assert.equal(again.json.changed, false);
    assert.equal(again.json.groups, 5);
    assert.equal(statSync(dailyPath(DATE)).mtimeMs, mtime);
  });

  it("keeps CRLF and the BOM on disk", async () => {
    writeDailyFile(DATE, `${BOM}${MESSY.split("\n").join("\r\n")}`);
    const res = await organize(DATE);
    assert.equal(res.status, 200);
    assert.equal(readFileSync(dailyPath(DATE), "utf8"), `${BOM}${MESSY_ORGANIZED.split("\n").join("\r\n")}`);
  });

  it("groups by the literal label and rewrites nothing when the tasks feature is off", async () => {
    assert.equal((await settings({ features: { daily: true, tasks: false } })).status, 200);
    writeDailyFile(DATE, MESSY);
    const res = await organize(DATE);
    assert.equal(res.status, 200);
    const content = readFileSync(dailyPath(DATE), "utf8");
    assert.match(content, /- \[-\] \[\[initech\]\] - Provider credits dashboard/);
    assert.match(content, /- \[-\] \[\[hooli\|Hooli\]\] - Fixes found in the tests\n- \[ \] \[\[hooli\|Hooli\]\] - Extract Hooli exporter\n\n/);
    assert.equal(content.includes("[[acme|Acme Corp]]"), false);
  });

  it("returns 409 with the disk content when the file changed since baseUpdatedAt", async () => {
    writeDailyFile(DATE, MESSY);
    const read = await http("GET", `/delegation/daily/${DATE}`);
    const base = read.json.updatedAt as number;
    const edited = MESSY.replace("Standup", "Standup moved");
    writeFileSync(dailyPath(DATE), edited);
    const later = new Date(base + 10_000);
    utimesSync(dailyPath(DATE), later, later);
    const res = await organize(DATE, { baseUpdatedAt: base });
    assert.equal(res.status, 409);
    assert.equal(res.json.content, edited);
    assert.equal(readFileSync(dailyPath(DATE), "utf8"), edited);
  });

  it("does not sync task statuses from today's daily", async () => {
    const today = todayLocal();
    writeDailyFile(today, ["## Foco de hoje", "- [x] [[initech]] - Pilot validation", "- [x] [[acme]] - Renew contract", ""].join("\n"));
    const before = Object.keys(VAULT).map((rel) => readFileSync(join(vault, rel), "utf8"));
    const res = await organize(today);
    assert.equal(res.status, 200);
    assert.equal(res.json.changed, true);
    assert.equal(
      readFileSync(dailyPath(today), "utf8"),
      ["## Foco de hoje", "", "- [x] [[acme|Acme Corp]] - Renew contract", "", "- [x] [[initech|Initech]] - Pilot validation", ""].join("\n"),
    );
    assert.deepEqual(
      Object.keys(VAULT).map((rel) => readFileSync(join(vault, rel), "utf8")),
      before,
    );
  });

  it("validates the date, the feature, the file and the heading", async () => {
    assert.equal((await organize("2026-13-40")).status, 400);
    assert.equal((await organize("2031-01-01")).status, 404);
    writeDailyFile(DATE, "# Day\n\n## Other\n\n- x\n");
    const noHeading = await organize(DATE);
    assert.equal(noHeading.status, 400);
    assert.match(String(noHeading.json.error), /focus heading/);
    assert.equal((await settings({ features: { daily: false, tasks: true } })).status, 200);
    writeDailyFile(DATE, MESSY);
    assert.equal((await organize(DATE)).status, 400);
    assert.equal(readFileSync(dailyPath(DATE), "utf8"), MESSY);
  });
});
