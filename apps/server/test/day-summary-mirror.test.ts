import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "cch-g3-summary-mirror-"));
const root = join(dataDir, "vault");
process.env.HUB_DATA_DIR = join(dataDir, "data");
for (const key of ["HUB_RESOURCE_DIR", "HUB_WORKSPACES_ROOT", "HUB_EDITOR", "HUB_SECOND_BRAIN"]) delete process.env[key];

type Store = typeof import("../src/delegation-store.js");
type Board = typeof import("../src/tasks-board.js");
type Daily = typeof import("../src/daily.js");
type Today = typeof import("../src/today.js");
type Summary = typeof import("../src/day-summary.js");
let store: Store;
let board: Board;
let daily: Daily;
let today: Today;
let summary: Summary;

const SCHEDULED = "⏳";
const pad = (value: number): string => String(value).padStart(2, "0");
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const FOCUS = ["- [ ] [[alpha|Alpha]] - Task one", "- [-] [[alpha|Alpha]] - Task two", "- [ ] free text of the day"];
const DAILY = ["---", "type: daily", "---", "", `# ${TODAY}`, "", "## Focus", "", ...FOCUS, "", "## Meetings", "", "- 10:00 Standup", ""].join("\n");
const ALPHA = ["# Alpha", "", "## Open loops", "", `- [ ] Task one ${SCHEDULED} ${TODAY}`, `- [-] Task two ${SCHEDULED} ${TODAY}`, "- [ ] Task four", "", "## Done loops", "", `- [x] Task zero ✅ ${TODAY}`, ""].join("\n");

function write(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

before(async () => {
  store = await import("../src/delegation-store.js");
  board = await import("../src/tasks-board.js");
  daily = await import("../src/daily.js");
  today = await import("../src/today.js");
  summary = await import("../src/day-summary.js");
  today.installTodayHooks();
  today.setFocusStability({ delayMs: 0 });
  write("_templates/daily.md", ["---", "type: daily", "---", "", "# {{date}}", "", "## Focus", "", "- [ ]", ""].join("\n"));
  write("projects/alpha.md", ALPHA);
  write(`daily/${TODAY}.md`, DAILY);
  store.updateSettings({
    secondBrainRoot: root,
    features: { daily: true, tasks: true, trail: false, usage: false, limits: false },
    tasks: { root: "projects", doneSection: "Done loops", priorityTag: "p" },
    daily: { dir: "daily", template: "_templates/daily.md", wikilinks: true, projectOrder: [], focusSource: "scheduled", headings: { focus: "Focus", meetings: "Meetings", sessions: "Sessions", captures: "" } },
  });
  store.setSetting(`today.migrated.${TODAY}`, "1");
  today.todayApi.regenerateFocusMirror(store.getSettings(), TODAY);
});

after(async () => {
  today.removeTodayHooks();
  daily.stopDailyWatch();
  board.stopTasksBoardWatch();
  (await import("../src/db.js")).db.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("day summary and the Today mirror", () => {
  it("writing the summary keeps the focus, the scheduled dates and the project pages untouched", async () => {
    const settings = store.getSettings();
    assert.equal(read(`daily/${TODAY}.md`), DAILY);
    const result = await summary.writeDaySummary(settings, TODAY);
    assert.equal(result.changed, true);
    assert.match(result.summary.block, /^- Alpha: Task zero$/m);
    const written = read(`daily/${TODAY}.md`);
    assert.equal(written, `${DAILY}\n## Day summary\n\n${result.summary.block}\n`);
    for (let round = 0; round < 3; round += 1) {
      today.flushMirrors(settings);
      assert.equal(today.todayApi.regenerateFocusMirror(settings, TODAY).changed, false, `round ${round}`);
    }
    assert.equal(read("projects/alpha.md"), ALPHA);
    assert.equal(read(`daily/${TODAY}.md`), written);
    assert.deepEqual(
      today.readToday(settings, TODAY).focus.map((entry) => entry.task.title),
      ["Task one", "Task two"],
    );
  });
});
