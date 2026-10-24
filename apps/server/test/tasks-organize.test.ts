import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeSandbox, startServer, waitFor, type RunningServer, type Sandbox } from "./helpers.js";

interface HttpResult {
  status: number;
  json: Record<string, unknown>;
}

interface WireNote {
  line: number;
  raw: string;
  text: string;
}

interface WireTask {
  id: string;
  projectId: string;
  line: number;
  raw: string;
  depth: number;
  title: string;
  status: string;
  reason: string | null;
  priority: number | null;
  section: string;
  doneAt: string | null;
  group: string | null;
  notes: string[];
  noteItems: WireNote[];
  subtasks: WireTask[];
}

interface Target {
  projectId: string;
  line: number;
  raw: string;
}

const box: Sandbox = makeSandbox("cch-tasks-organize-");
const vault = join(box.tmp, "vault");
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

const MOVE = "/delegation/tasks-board/move";
const REPARENT = "/delegation/tasks-board/reparent";
const TO_PROJECT = "/delegation/tasks-board/move-to-project";
const flat = (tasks: WireTask[]): WireTask[] => tasks.flatMap((task) => [task, ...flat(task.subtasks)]);

const configure = async (dir: string, tasks: Record<string, unknown> = {}): Promise<void> => {
  const res = await http("PUT", "/delegation/settings", {
    workspacesRoot: box.root,
    secondBrainRoot: box.brain,
    features: { tasks: true },
    tasks: { section: "Open loops", doneSection: "", doneStamp: " ✅ {{date}}", reasonSeparator: " - ", separator: " - ", ...tasks, root: join(vault, dir) },
  });
  assert.equal(res.status, 200);
};

const reset = (dir: string, files: Record<string, string>): void => {
  rmSync(join(vault, dir), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(vault, dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
};

const readRaw = (rel: string): string => readFileSync(join(vault, rel), "utf8");
const listTasks = async (): Promise<WireTask[]> => flat((await http("GET", "/delegation/tasks-board")).json.tasks as WireTask[]);

const find = async (projectId: string, title: string): Promise<WireTask> => {
  const found = (await listTasks()).find((task) => task.projectId === projectId && task.title === title);
  assert.ok(found, `${projectId} ${title}`);
  return found;
};

const at = (task: WireTask): Target => ({ projectId: task.projectId, line: task.line, raw: task.raw });

const noteOf = (task: WireTask, text: string): Target => {
  const found = task.noteItems.find((note) => note.text === text);
  assert.ok(found, text);
  return { projectId: task.projectId, line: found.line, raw: found.raw };
};

const moveItem = (target: Target, direction: unknown): Promise<HttpResult> => http("POST", MOVE, { ...target, direction });

const reparent = (target: Target, parent: Target | null | undefined): Promise<HttpResult> =>
  http("POST", REPARENT, { ...target, parent: parent ? { line: parent.line, raw: parent.raw } : parent });

const toProject = (target: Target, targetProjectId: string, parent?: Target): Promise<HttpResult> =>
  http("POST", TO_PROJECT, { ...target, targetProjectId, ...(parent ? { parent: { line: parent.line, raw: parent.raw } } : {}) });

const doc = (...lines: string[]): string => lines.join("\n");

const taskOf = (res: HttpResult): WireTask => res.json.task as WireTask;

const listen = async (): Promise<{ text: () => string; stop: () => void }> => {
  const controller = new AbortController();
  const stream = await fetch(`${hub.base}/api/events`, { signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.ok(stream.body);
  let received = "";
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        received += decoder.decode(chunk.value);
      }
    } catch {
      return;
    }
  })();
  return { text: () => received, stop: () => controller.abort() };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const lockFile = (file: string): (() => void) => {
  if (process.platform === "win32") {
    chmodSync(file, 0o444);
    return () => chmodSync(file, 0o666);
  }
  const dir = dirname(file);
  chmodSync(dir, 0o555);
  return () => chmodSync(dir, 0o755);
};

const tmpLeftovers = (dir: string): string[] => readdirSync(join(vault, dir), { recursive: true }).map(String).filter((name) => name.endsWith(".tmp"));

const GROUPS = doc(
  "# Acme",
  "",
  "## Open loops",
  "",
  "### Alpha",
  "",
  "- [ ] Alpha one #p1",
  "- [ ] Alpha two",
  "  - [ ] Alpha two child",
  "  - alpha two note",
  "- [ ] Alpha three",
  "",
  "### Beta",
  "",
  "- [ ] Beta one",
  "",
  "- [ ] HOLD - Beta two - waiting vendor",
  "",
  "## Later",
  "",
  "- [ ] outside the section",
  "",
);

const MIXED = doc(
  "## Open loops",
  "",
  "- [ ] Parent",
  "  - first note",
  "    - deeper note",
  "  - [ ] Sub one #p2",
  "    - sub one note",
  "  - [ ] Sub two",
  "",
  "  - second note",
  "- [ ] Next",
  "",
);

const NEST = doc(
  "## Open loops",
  "",
  "- [ ] Root task",
  "  - [ ] Keep before",
  "  - [ ] Lift me #p0",
  "    - lift note",
  "",
  "    - [ ] Lift child",
  "      ```ts",
  "      - [ ] not a task",
  "      ```",
  "    - after fence note",
  "  - [ ] Keep after",
  "- [ ] Other root",
  "",
);

describe("tasks board organize operations", () => {
  before(async () => {
    mkdirSync(vault, { recursive: true });
    hub = await startServer(box, { HUB_DELEGATION: "1" });
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe("move up and down", () => {
    it("swaps top-level tasks inside their ### group and refuses to cross groups", async () => {
      reset("groups", { "acme.md": GROUPS });
      await configure("groups");
      const two = await find("acme", "Alpha two");
      const res = await moveItem(at(two), "up");
      assert.equal(res.status, 200);
      const moved = taskOf(res);
      assert.equal(moved.title, "Alpha two");
      assert.equal(moved.line, 6);
      assert.equal(moved.group, "Alpha");
      assert.equal(moved.subtasks.length, 1);
      assert.deepEqual(moved.notes, ["alpha two note"]);
      const swapped = GROUPS.replace(
        "- [ ] Alpha one #p1\n- [ ] Alpha two\n  - [ ] Alpha two child\n  - alpha two note\n",
        "- [ ] Alpha two\n  - [ ] Alpha two child\n  - alpha two note\n- [ ] Alpha one #p1\n",
      );
      assert.equal(readRaw("groups/acme.md"), swapped);
      const first = await moveItem(at(await find("acme", "Alpha two")), "up");
      assert.equal(first.status, 400);
      assert.equal(first.json.error, "already first");
      const last = await moveItem(at(await find("acme", "Alpha three")), "down");
      assert.equal(last.status, 400);
      assert.equal(last.json.error, "already last");
      const betaFirst = await moveItem(at(await find("acme", "Beta one")), "up");
      assert.equal(betaFirst.status, 400);
      assert.equal(betaFirst.json.error, "already first");
      assert.equal(readRaw("groups/acme.md"), swapped);
    });

    it("treats two groups with the same heading text as different groups for sibling checks", async () => {
      const content = doc("## Open loops", "### G", "- [ ] x1", "- [ ] x2", "### H", "- [ ] h1", "### G", "- [ ] x3", "");
      reset("same-groups", { "g.md": content });
      await configure("same-groups");
      const last = await moveItem(at(await find("g", "x2")), "down");
      assert.equal(last.status, 400);
      assert.equal(last.json.error, "already last");
      const first = await moveItem(at(await find("g", "x3")), "up");
      assert.equal(first.status, 400);
      assert.equal(first.json.error, "already first");
      assert.equal(readRaw("same-groups/g.md"), content);
      const swap = await moveItem(at(await find("g", "x1")), "down");
      assert.equal(swap.status, 200);
      assert.equal(readRaw("same-groups/g.md"), doc("## Open loops", "### G", "- [ ] x2", "- [ ] x1", "### H", "- [ ] h1", "### G", "- [ ] x3", ""));
    });

    it("keeps the blank line between loose siblings and leaves prefixes, reasons and tags alone", async () => {
      reset("loose", { "acme.md": GROUPS });
      await configure("loose");
      const hold = await find("acme", "Beta two");
      const res = await moveItem(at(hold), "up");
      assert.equal(res.status, 200);
      const moved = taskOf(res);
      assert.equal(moved.status, "hold");
      assert.equal(moved.reason, "waiting vendor");
      assert.equal(moved.line, 14);
      assert.equal(readRaw("loose/acme.md"), GROUPS.replace("- [ ] Beta one\n\n- [ ] HOLD - Beta two - waiting vendor\n", "- [ ] HOLD - Beta two - waiting vendor\n\n- [ ] Beta one\n"));
      const down = await moveItem(at(await find("acme", "Beta one")), "down");
      assert.equal(down.status, 400);
      assert.equal(down.json.error, "already last");
      const back = await moveItem(at(await find("acme", "Beta two")), "down");
      assert.equal(back.status, 200);
      assert.equal(readRaw("loose/acme.md"), GROUPS);
    });

    it("keeps the open and the done sections apart and keeps stamps and priorities", async () => {
      const content = doc("## Open loops", "", "- [ ] Open first", "- [ ] Open last", "", "## Done loops", "", "- [x] Done first ✅ 2026-01-02", "- [x] Done second #p3 ✅ 2026-01-01", "");
      reset("sections", { "s.md": content });
      await configure("sections", { doneSection: "Done loops" });
      const openLast = await moveItem(at(await find("s", "Open last")), "down");
      assert.equal(openLast.status, 400);
      assert.equal(openLast.json.error, "already last");
      const doneFirst = await moveItem(at(await find("s", "Done first")), "up");
      assert.equal(doneFirst.status, 400);
      assert.equal(doneFirst.json.error, "already first");
      const res = await moveItem(at(await find("s", "Done second")), "up");
      assert.equal(res.status, 200);
      const moved = taskOf(res);
      assert.equal(moved.section, "done");
      assert.equal(moved.doneAt, "2026-01-01");
      assert.equal(moved.priority, 3);
      assert.equal(readRaw("sections/s.md"), content.replace("- [x] Done first ✅ 2026-01-02\n- [x] Done second #p3 ✅ 2026-01-01\n", "- [x] Done second #p3 ✅ 2026-01-01\n- [x] Done first ✅ 2026-01-02\n"));
    });

    it("moves subtasks and notes as mixed siblings and answers with the owning task for notes", async () => {
      reset("mixed", { "m.md": MIXED });
      await configure("mixed");
      const subTwo = await find("m", "Sub two");
      const res = await moveItem(at(subTwo), "up");
      assert.equal(res.status, 200);
      assert.equal(taskOf(res).title, "Sub two");
      assert.equal(taskOf(res).line, 5);
      assert.equal(readRaw("mixed/m.md"), MIXED.replace("  - [ ] Sub one #p2\n    - sub one note\n  - [ ] Sub two\n", "  - [ ] Sub two\n  - [ ] Sub one #p2\n    - sub one note\n"));

      reset("mixed", { "m.md": MIXED });
      const parent = await find("m", "Parent");
      const noteUp = await moveItem(noteOf(parent, "second note"), "up");
      assert.equal(noteUp.status, 200);
      assert.equal(taskOf(noteUp).title, "Parent");
      assert.equal(taskOf(noteUp).line, 2);
      assert.deepEqual(taskOf(noteUp).notes, ["first note", "deeper note", "second note"]);
      assert.equal(readRaw("mixed/m.md"), MIXED.replace("  - [ ] Sub two\n\n  - second note\n", "  - second note\n\n  - [ ] Sub two\n"));

      reset("mixed", { "m.md": MIXED });
      const fresh = await find("m", "Parent");
      const firstUp = await moveItem(noteOf(fresh, "first note"), "up");
      assert.equal(firstUp.status, 400);
      assert.equal(firstUp.json.error, "already first");
      const deeperUp = await moveItem(noteOf(fresh, "deeper note"), "up");
      assert.equal(deeperUp.json.error, "already first");
      const deeperDown = await moveItem(noteOf(fresh, "deeper note"), "down");
      assert.equal(deeperDown.json.error, "already last");
      const secondDown = await moveItem(noteOf(fresh, "second note"), "down");
      assert.equal(secondDown.json.error, "already last");
      const subNote = await moveItem(noteOf(await find("m", "Sub one"), "sub one note"), "up");
      assert.equal(subNote.json.error, "already first");
      assert.equal(readRaw("mixed/m.md"), MIXED);
      const subOneUp = await moveItem(at(await find("m", "Sub one")), "up");
      assert.equal(subOneUp.status, 200);
      assert.equal(taskOf(subOneUp).line, 3);
      const subOneSwapped = MIXED.replace("  - first note\n    - deeper note\n  - [ ] Sub one #p2\n    - sub one note\n", "  - [ ] Sub one #p2\n    - sub one note\n  - first note\n    - deeper note\n");
      assert.equal(readRaw("mixed/m.md"), subOneSwapped);
      reset("mixed", { "m.md": MIXED });
      const firstDown = await moveItem(noteOf(fresh, "first note"), "down");
      assert.equal(firstDown.status, 200);
      assert.equal(readRaw("mixed/m.md"), subOneSwapped);
    });

    it("keeps CRLF, the BOM and a missing final newline when the last block moves up", async () => {
      const content = "\uFEFF" + ["## Open loops", "", "- [ ] One", "- [ ] Two #p1", "  - two note"].join("\r\n");
      reset("crlf-move", { "w.md": content });
      await configure("crlf-move");
      const res = await moveItem(at(await find("w", "Two")), "up");
      assert.equal(res.status, 200);
      assert.equal(readRaw("crlf-move/w.md"), "\uFEFF" + ["## Open loops", "", "- [ ] Two #p1", "  - two note", "- [ ] One"].join("\r\n"));
      const back = await moveItem(at(await find("w", "One")), "up");
      assert.equal(back.status, 200);
      assert.equal(readRaw("crlf-move/w.md"), content);
    });

    it("refuses neighbours separated by other content, unclosed fences and different indentation", async () => {
      const paragraph = doc("## Open loops", "", "- [ ] First", "Some paragraph", "- [ ] Second", "");
      const fenced = doc("## Open loops", "", "- [ ] Root", "  - [ ] Fenced", "    ```", "not indented code", "    ```", "  - [ ] Sibling", "");
      const indents = doc("## Open loops", "", "- [ ] Holder", "    - [ ] Deep sibling", "  - [ ] Shallow sibling", "");
      reset("refuse", { "p.md": paragraph, "f.md": fenced, "i.md": indents });
      await configure("refuse");
      const second = await moveItem(at(await find("p", "Second")), "up");
      assert.equal(second.status, 400);
      assert.equal(second.json.error, "other content sits between the two items");
      const fence = await moveItem(at(await find("f", "Fenced")), "down");
      assert.equal(fence.status, 400);
      assert.equal(fence.json.error, "the block has a code fence that is not closed inside it");
      const sibling = await moveItem(at(await find("f", "Sibling")), "up");
      assert.equal(sibling.status, 400);
      const shallow = await moveItem(at(await find("i", "Shallow sibling")), "up");
      assert.equal(shallow.status, 400);
      assert.equal(shallow.json.error, "the two items do not share the same indentation");
      assert.equal(readRaw("refuse/p.md"), paragraph);
      assert.equal(readRaw("refuse/f.md"), fenced);
      assert.equal(readRaw("refuse/i.md"), indents);
    });

    it("validates the direction, the target and the freshness", async () => {
      reset("validate", { "v.md": MIXED });
      await configure("validate");
      const parent = await find("v", "Parent");
      assert.equal((await moveItem(at(parent), "left")).status, 400);
      assert.equal((await moveItem(at(parent), undefined)).status, 400);
      const stale = await moveItem({ ...at(parent), raw: "- [ ] Parent changed" }, "down");
      assert.equal(stale.status, 409);
      assert.equal((stale.json.current as WireTask).title, "Parent");
      const staleNote = await moveItem({ ...noteOf(parent, "first note"), raw: "  - old" }, "down");
      assert.equal(staleNote.status, 409);
      assert.equal((staleNote.json.current as WireTask).title, "Parent");
      const heading = await moveItem({ projectId: "v", line: 0, raw: "## Open loops" }, "down");
      assert.equal(heading.status, 400);
      assert.equal((await moveItem({ ...at(parent), projectId: "../v" }, "down")).status, 404);
      assert.equal(readRaw("validate/v.md"), MIXED);
    });
  });

  describe("reparent", () => {
    it("promotes a nested subtask with notes, children, a fence and blank lines right after its top-level ancestor", async () => {
      reset("promote", { "n.md": NEST });
      await configure("promote");
      const lift = await find("n", "Lift me");
      const res = await reparent(at(lift), null);
      assert.equal(res.status, 200);
      assert.equal(
        readRaw("promote/n.md"),
        doc(
          "## Open loops",
          "",
          "- [ ] Root task",
          "  - [ ] Keep before",
          "  - [ ] Keep after",
          "- [ ] Lift me #p0",
          "  - lift note",
          "",
          "  - [ ] Lift child",
          "    ```ts",
          "    - [ ] not a task",
          "    ```",
          "  - after fence note",
          "- [ ] Other root",
          "",
        ),
      );
      const moved = taskOf(res);
      assert.equal(moved.title, "Lift me");
      assert.equal(moved.depth, 0);
      assert.equal(moved.line, 5);
      assert.equal(moved.priority, 0);
      assert.deepEqual(moved.notes, ["lift note", "after fence note"]);
      assert.deepEqual(moved.subtasks.map((task) => task.title), ["Lift child"]);
      const titles = (await listTasks()).filter((task) => task.projectId === "n").map((task) => task.title);
      assert.deepEqual(titles, ["Root task", "Keep before", "Keep after", "Lift me", "Lift child", "Other root"]);
      const top = (await http("GET", "/delegation/tasks-board")).json.tasks as WireTask[];
      assert.deepEqual(top.filter((task) => task.projectId === "n").map((task) => task.title), ["Root task", "Lift me", "Other root"]);
    });

    it("keeps one blank line between the last list item and a following paragraph when the last item leaves", async () => {
      const content = doc("## Open loops", "- [ ] A", "- [ ] B", "", "Context paragraph for the loops.", "", "## Decisions", "- d", "");
      reset("blank-after", { "c.md": content, "o.md": doc("## Open loops", "- [ ] o", "") });
      await configure("blank-after");
      const nested = await reparent(at(await find("c", "B")), at(await find("c", "A")));
      assert.equal(nested.status, 200);
      assert.equal(readRaw("blank-after/c.md"), doc("## Open loops", "- [ ] A", "  - [ ] B", "", "Context paragraph for the loops.", "", "## Decisions", "- d", ""));
      reset("blank-after", { "c.md": content, "o.md": doc("## Open loops", "- [ ] o", "") });
      const sent = await toProject(at(await find("c", "B")), "o");
      assert.equal(sent.status, 200);
      assert.equal(readRaw("blank-after/c.md"), doc("## Open loops", "- [ ] A", "", "Context paragraph for the loops.", "", "## Decisions", "- d", ""));
    });

    it("keeps adjacent items adjacent and loose items loose when a middle or last block leaves", async () => {
      reset("blank-loose", { "l.md": doc("## Open loops", "", "- [ ] A", "", "- [ ] B", "", "- [ ] C", "", "## Next", "- n", ""), "o.md": doc("## Open loops", "- [ ] o", "") });
      await configure("blank-loose");
      const middle = await toProject(at(await find("l", "B")), "o");
      assert.equal(middle.status, 200);
      assert.equal(readRaw("blank-loose/l.md"), doc("## Open loops", "", "- [ ] A", "", "- [ ] C", "", "## Next", "- n", ""));
      const last = await toProject(at(await find("l", "C")), "o");
      assert.equal(last.status, 200);
      assert.equal(readRaw("blank-loose/l.md"), doc("## Open loops", "", "- [ ] A", "", "## Next", "- n", ""));
    });

    it("promotes a sub-subtask after its top-level ancestor and keeps a loose list loose", async () => {
      const content = doc("## Open loops", "", "- [ ] Top", "  - [ ] Middle", "    - [ ] Deepest #p2", "      - deepest note", "", "- [ ] Following", "");
      reset("promote-deep", { "d.md": content });
      await configure("promote-deep");
      const res = await reparent(at(await find("d", "Deepest")), null);
      assert.equal(res.status, 200);
      assert.equal(readRaw("promote-deep/d.md"), doc("## Open loops", "", "- [ ] Top", "  - [ ] Middle", "", "- [ ] Deepest #p2", "  - deepest note", "", "- [ ] Following", ""));
      assert.equal(taskOf(res).line, 5);
      assert.equal(taskOf(res).depth, 0);
      const again = await reparent(at(await find("d", "Deepest")), null);
      assert.equal(again.status, 400);
      assert.equal(again.json.error, "the task is already top-level");
    });

    it("promotes inside a CRLF file without a final newline", async () => {
      const content = ["## Open loops", "", "- [ ] Win root", "  - [ ] Win child", "    - win note"].join("\r\n");
      reset("promote-crlf", { "w.md": content });
      await configure("promote-crlf");
      const res = await reparent(at(await find("w", "Win child")), null);
      assert.equal(res.status, 200);
      assert.equal(readRaw("promote-crlf/w.md"), ["## Open loops", "", "- [ ] Win root", "- [ ] Win child", "  - win note"].join("\r\n"));
    });

    const demoteCase = (unit: string): { before: string; after: string } => ({
      before: doc("## Open loops", "", "- [ ] Host", `${unit}- [ ] Existing child`, `${unit}${unit}- deep note`, "- [ ] Mover #p1", `${unit}- mover note`, `${unit}- [ ] Mover child`, "- [ ] Tail", ""),
      after: doc(
        "## Open loops",
        "",
        "- [ ] Host",
        `${unit}- [ ] Existing child`,
        `${unit}${unit}- deep note`,
        `${unit}- [ ] Mover #p1`,
        `${unit}${unit}- mover note`,
        `${unit}${unit}- [ ] Mover child`,
        "- [ ] Tail",
        "",
      ),
    });

    for (const [label, unit] of [
      ["tabs", "\t"],
      ["2 spaces", "  "],
      ["4 spaces", "    "],
    ] as const) {
      it(`demotes a top-level task under a task with children using ${label}`, async () => {
        const fixture = demoteCase(unit);
        const dir = `demote-${label.replace(/\s/g, "")}`;
        reset(dir, { "h.md": fixture.before });
        await configure(dir);
        const host = await find("h", "Host");
        const res = await reparent(at(await find("h", "Mover")), at(host));
        assert.equal(res.status, 200);
        assert.equal(readRaw(`${dir}/h.md`), fixture.after);
        const moved = taskOf(res);
        assert.equal(moved.title, "Mover");
        assert.equal(moved.line, 5);
        assert.equal(moved.priority, 1);
        assert.deepEqual(moved.notes, ["mover note"]);
        const freshHost = await find("h", "Host");
        assert.deepEqual(freshHost.subtasks.map((task) => task.title), ["Existing child", "Mover"]);
      });
    }

    it("demotes under a parent that comes later in the file and indents with the document unit", async () => {
      const content = doc("## Open loops", "", "- [ ] Mover", "  - mover note", "- [ ] Host", "- [ ] Tail", "");
      reset("demote-later", { "l.md": content });
      await configure("demote-later");
      const res = await reparent(at(await find("l", "Mover")), at(await find("l", "Host")));
      assert.equal(res.status, 200);
      assert.equal(readRaw("demote-later/l.md"), doc("## Open loops", "", "- [ ] Host", "  - [ ] Mover", "    - mover note", "- [ ] Tail", ""));
      assert.equal(taskOf(res).line, 3);
      const same = await reparent(at(await find("l", "Mover")), at(await find("l", "Host")));
      assert.equal(same.status, 200);
      assert.equal(readRaw("demote-later/l.md"), doc("## Open loops", "", "- [ ] Host", "  - [ ] Mover", "    - mover note", "- [ ] Tail", ""));
    });

    it("refuses self, descendants, notes, non-task parents, mixed indentation and a missing parent field", async () => {
      const mixed = doc("## Open loops", "", "- [ ] Top", "  - [ ] Mixed", "\t- mixed note", "- [ ] End", "");
      const fixture = demoteCase("  ");
      reset("refuse-reparent", { "h.md": fixture.before, "x.md": mixed, "f.md": NEST.replace("      ```\n    - after", "    - after") });
      await configure("refuse-reparent");
      const mover = await find("h", "Mover");
      const self = await reparent(at(mover), at(mover));
      assert.equal(self.status, 400);
      assert.equal(self.json.error, "a task cannot become its own subtask");
      const child = await reparent(at(mover), at(await find("h", "Mover child")));
      assert.equal(child.status, 400);
      assert.equal(child.json.error, "a task cannot move under its own subtask");
      const note = await reparent(noteOf(mover, "mover note"), null);
      assert.equal(note.status, 400);
      assert.equal(note.json.error, "notes cannot be reparented");
      const host = await find("h", "Host");
      const noteParent = await reparent(at(mover), noteOf(await find("h", "Existing child"), "deep note"));
      assert.equal(noteParent.status, 400);
      assert.equal(noteParent.json.error, "parent must be a task in the configured section");
      const missing = await http("POST", REPARENT, { ...at(mover) });
      assert.equal(missing.status, 400);
      const badParent = await http("POST", REPARENT, { ...at(mover), parent: { line: -1, raw: "x" } });
      assert.equal(badParent.status, 400);
      const staleParent = await reparent(at(mover), { ...at(host), raw: "- [ ] Host renamed" });
      assert.equal(staleParent.status, 409);
      assert.equal((staleParent.json.current as WireTask).title, "Host");
      const staleItem = await reparent({ ...at(mover), raw: "- [ ] Mover renamed" }, at(host));
      assert.equal(staleItem.status, 409);
      const mixedRes = await reparent(at(await find("x", "Mixed")), null);
      assert.equal(mixedRes.status, 400);
      assert.equal(mixedRes.json.error, "mixed indentation in the block");
      const unclosed = await reparent(at(await find("f", "Lift me")), null);
      assert.equal(unclosed.status, 400);
      assert.equal(readRaw("refuse-reparent/h.md"), fixture.before);
      assert.equal(readRaw("refuse-reparent/x.md"), mixed);
      assert.equal(readRaw("refuse-reparent/f.md"), NEST.replace("      ```\n    - after", "    - after"));
    });
  });

  describe("move to another project", () => {
    const SOURCE = doc(
      "# Left",
      "",
      "## Open loops",
      "",
      "- [ ] Keep",
      "- [ ] Travel #p1",
      "  - travel note",
      "  - [ ] Travel sub",
      "    ```",
      "    - [ ] fenced line",
      "    ```",
      "- [ ] HOLD - Payment gateway - waiting bank #p2",
      "- [ ] Root",
      "  - [ ] Nested mover",
      "    - nested note",
      "- [ ] Stay",
      "",
      "## Done loops",
      "",
      "- [x] Shipped thing #p2 ✅ 2026-02-03",
      "  - [x] shipped child",
      "- [x] Older ✅ 2026-01-01",
      "",
    );

    const placeholderTarget = doc("# Right", "", "## Open loops", "", "-", "", "## Done loops", "", "- [x] Target old ✅ 2026-01-15", "");

    it("moves a task block to the open section of the target, replacing its placeholder", async () => {
      reset("mtp", { "left/left.md": SOURCE, "right/right.md": placeholderTarget });
      await configure("mtp", { doneSection: "Done loops" });
      const res = await toProject(at(await find("left/left", "Travel")), "right/right");
      assert.equal(res.status, 200);
      assert.equal(
        readRaw("mtp/right/right.md"),
        placeholderTarget.replace("\n-\n", "\n- [ ] Travel #p1\n  - travel note\n  - [ ] Travel sub\n    ```\n    - [ ] fenced line\n    ```\n"),
      );
      assert.equal(readRaw("mtp/left/left.md"), SOURCE.replace("- [ ] Travel #p1\n  - travel note\n  - [ ] Travel sub\n    ```\n    - [ ] fenced line\n    ```\n", ""));
      const moved = taskOf(res);
      assert.equal(moved.projectId, "right/right");
      assert.equal(moved.line, 4);
      assert.equal(moved.priority, 1);
      assert.equal(moved.section, "open");
      assert.deepEqual(moved.subtasks.map((task) => task.title), ["Travel sub"]);
      assert.equal((await listTasks()).some((task) => task.title === "fenced line"), false);
    });

    it("keeps reasons and tags, and moves a nested subtask to depth 0 of the target", async () => {
      reset("mtp-nested", { "left/left.md": SOURCE, "right/right.md": doc("# Right", "", "## Open loops", "", "- [ ] Existing right", "") });
      await configure("mtp-nested", { doneSection: "Done loops" });
      const hold = await toProject(at(await find("left/left", "Payment gateway")), "right/right");
      assert.equal(hold.status, 200);
      assert.equal(taskOf(hold).status, "hold");
      assert.equal(taskOf(hold).reason, "waiting bank");
      assert.equal(taskOf(hold).priority, 2);
      const nested = await toProject(at(await find("left/left", "Nested mover")), "right/right");
      assert.equal(nested.status, 200);
      assert.equal(taskOf(nested).depth, 0);
      assert.equal(
        readRaw("mtp-nested/right/right.md"),
        doc("# Right", "", "## Open loops", "", "- [ ] Existing right", "- [ ] HOLD - Payment gateway - waiting bank #p2", "- [ ] Nested mover", "  - nested note", ""),
      );
      assert.equal(readRaw("mtp-nested/left/left.md"), SOURCE.replace("- [ ] HOLD - Payment gateway - waiting bank #p2\n", "").replace("  - [ ] Nested mover\n    - nested note\n", ""));
    });

    it("creates the open section in a target that does not have it", async () => {
      reset("mtp-missing", { "left/left.md": SOURCE, "gamma.md": doc("# Gamma", "", "Some intro text.", "") });
      await configure("mtp-missing");
      const res = await toProject(at(await find("left/left", "Keep")), "gamma");
      assert.equal(res.status, 200);
      assert.equal(readRaw("mtp-missing/gamma.md"), doc("# Gamma", "", "Some intro text.", "", "## Open loops", "", "- [ ] Keep", ""));
      assert.equal(taskOf(res).projectId, "gamma");
    });

    it("sends a stamped done task to the top of the target done section and keeps the stamp", async () => {
      const target = doc("## Open loops", "", "- [ ] T open", "", "## Done loops", "", "- [x] Target old ✅ 2026-01-15", "");
      reset("mtp-done", { "left/left.md": SOURCE, "right/right.md": target });
      await configure("mtp-done", { doneSection: "Done loops" });
      const res = await toProject(at(await find("left/left", "Shipped thing")), "right/right");
      assert.equal(res.status, 200);
      assert.equal(readRaw("mtp-done/right/right.md"), target.replace("- [x] Target old", "- [x] Shipped thing #p2 ✅ 2026-02-03\n  - [x] shipped child\n- [x] Target old"));
      assert.equal(readRaw("mtp-done/left/left.md"), SOURCE.replace("- [x] Shipped thing #p2 ✅ 2026-02-03\n  - [x] shipped child\n", ""));
      const moved = taskOf(res);
      assert.equal(moved.section, "done");
      assert.equal(moved.doneAt, "2026-02-03");
      assert.equal(moved.priority, 2);
      assert.equal(moved.line, 6);
    });

    it("moves under a parent task in the target with the target's child indent", async () => {
      const target = doc("## Open loops", "", "- [ ] Host", "\t- [ ] Host child", "- [ ] After host", "");
      reset("mtp-parent", { "left/left.md": SOURCE, "right/right.md": target });
      await configure("mtp-parent", { doneSection: "Done loops" });
      const host = await find("right/right", "Host");
      const res = await toProject(at(await find("left/left", "Nested mover")), "right/right", at(host));
      assert.equal(res.status, 200);
      assert.equal(readRaw("mtp-parent/right/right.md"), doc("## Open loops", "", "- [ ] Host", "\t- [ ] Host child", "\t- [ ] Nested mover", "\t  - nested note", "- [ ] After host", ""));
      assert.equal(taskOf(res).line, 4);
      assert.equal(taskOf(res).projectId, "right/right");
      const freshHost = await find("right/right", "Host");
      assert.deepEqual(freshHost.subtasks.map((task) => task.title), ["Host child", "Nested mover"]);
      assert.deepEqual(freshHost.subtasks[1]?.notes, ["nested note"]);
    });

    it("answers 400 for the same project or a note, 404 for an unknown target and 409 for stale tokens", async () => {
      const target = doc("## Open loops", "", "- [ ] Host", "");
      reset("mtp-errors", { "left/left.md": SOURCE, "right/right.md": target });
      await configure("mtp-errors", { doneSection: "Done loops" });
      const travel = await find("left/left", "Travel");
      const same = await toProject(at(travel), "left/left");
      assert.equal(same.status, 400);
      const unknown = await toProject(at(travel), "nowhere");
      assert.equal(unknown.status, 404);
      const escape = await toProject(at(travel), "../mtp/right/right");
      assert.equal(escape.status, 404);
      const missingTarget = await http("POST", TO_PROJECT, { ...at(travel) });
      assert.equal(missingTarget.status, 400);
      const stale = await toProject({ ...at(travel), raw: "- [ ] Travel old" }, "right/right");
      assert.equal(stale.status, 409);
      assert.equal((stale.json.current as WireTask).title, "Travel");
      const host = await find("right/right", "Host");
      const staleParent = await toProject(at(travel), "right/right", { ...at(host), raw: "- [ ] Host old" });
      assert.equal(staleParent.status, 409);
      assert.equal((staleParent.json.current as WireTask).title, "Host");
      const note = await toProject(noteOf(travel, "travel note"), "right/right");
      assert.equal(note.status, 400);
      assert.equal(readRaw("mtp-errors/left/left.md"), SOURCE);
      assert.equal(readRaw("mtp-errors/right/right.md"), target);
    });

    it("restores the target when the source write fails", async () => {
      const target = doc("## Open loops", "", "- [ ] Host", "");
      reset("mtp-fail", { "left/left.md": SOURCE, "right/right.md": target });
      await configure("mtp-fail", { doneSection: "Done loops" });
      const travel = await find("left/left", "Travel");
      const events = await listen();
      const unlock = lockFile(join(vault, "mtp-fail", "left", "left.md"));
      let res: HttpResult;
      try {
        res = await toProject(at(travel), "right/right");
        await waitFor(async () => (events.text().split('{"source":"hub","projectId":"right/right"}').length === 3 ? true : null), 5000);
      } finally {
        unlock();
        events.stop();
      }
      assert.ok(res.status >= 400);
      assert.equal(events.text().includes('{"source":"hub","projectId":"left/left"}'), false);
      assert.equal(readRaw("mtp-fail/right/right.md"), target);
      assert.equal(readRaw("mtp-fail/left/left.md"), SOURCE);
      assert.deepEqual(tmpLeftovers("mtp-fail"), []);
    });

    it("keeps each file's EOL, BOM and final newline", async () => {
      const source = "\uFEFF" + ["## Open loops", "", "- [ ] Win keep", "- [ ] Win travel - not a reason", "  - win note", ""].join("\r\n");
      const target = ["## Open loops", "", "- [ ] Lin task"].join("\n");
      reset("mtp-eol", { "win.md": source, "lin.md": target });
      await configure("mtp-eol");
      const res = await toProject(at(await find("win", "Win travel - not a reason")), "lin");
      assert.equal(res.status, 200);
      assert.equal(readRaw("mtp-eol/lin.md"), ["## Open loops", "", "- [ ] Lin task", "- [ ] Win travel - not a reason", "  - win note"].join("\n"));
      assert.equal(readRaw("mtp-eol/win.md"), "\uFEFF" + ["## Open loops", "", "- [ ] Win keep", ""].join("\r\n"));
      const back = await toProject(at(await find("lin", "Lin task")), "win");
      assert.equal(back.status, 200);
      assert.equal(readRaw("mtp-eol/win.md"), "\uFEFF" + ["## Open loops", "", "- [ ] Win keep", "- [ ] Lin task", ""].join("\r\n"));
      assert.equal(readRaw("mtp-eol/lin.md"), ["## Open loops", "", "- [ ] Win travel - not a reason", "  - win note"].join("\n"));
    });

    it("broadcasts a hub tasks event for each written project and no disk echo", async () => {
      reset("mtp-sse", { "left/left.md": SOURCE, "right/right.md": doc("## Open loops", "", "- [ ] Host", "") });
      await configure("mtp-sse", { doneSection: "Done loops" });
      const events = await listen();
      try {
        const res = await toProject(at(await find("left/left", "Travel")), "right/right");
        assert.equal(res.status, 200);
        await waitFor(async () => (events.text().includes('{"source":"hub","projectId":"left/left"}') && events.text().includes('{"source":"hub","projectId":"right/right"}') ? true : null), 5000);
        const moved = await moveItem(at(await find("right/right", "Travel")), "up");
        assert.equal(moved.status, 200);
        const promoted = await reparent(at(await find("left/left", "Nested mover")), null);
        assert.equal(promoted.status, 200);
        await sleep(900);
        assert.equal(events.text().includes('"source":"disk"'), false);
      } finally {
        events.stop();
      }
    });

    it("answers 400 when the feature is off", async () => {
      reset("mtp-off", { "left/left.md": SOURCE, "right/right.md": doc("## Open loops", "", "- [ ] Host", "") });
      await configure("mtp-off");
      const travel = await find("left/left", "Travel");
      const off = await http("PUT", "/delegation/settings", { features: { tasks: false } });
      assert.equal(off.status, 200);
      assert.equal((await toProject(at(travel), "right/right")).status, 400);
      assert.equal((await moveItem(at(travel), "down")).status, 400);
      assert.equal((await reparent(at(travel), null)).status, 400);
      assert.equal(readRaw("mtp-off/left/left.md"), SOURCE);
      await configure("mtp-off");
    });
  });
  describe("title-less status tasks", () => {
    const original = doc("## Open loops", "", "- [ ] HOLD - #p3", "- [ ] Other", "");

    it("reads the prefix with an empty title and answers 400 task has no title without writing", async () => {
      reset("titleless", { "proj.md": original });
      await configure("titleless");
      const task = (await listTasks()).find((candidate) => candidate.projectId === "proj" && candidate.status === "hold");
      assert.ok(task);
      assert.equal(task.title, "");
      assert.equal(task.priority, 3);
      const hold = await http("PATCH", "/delegation/tasks-board/item", { ...at(task), status: "hold" });
      assert.equal(hold.status, 400);
      assert.equal(hold.json.error, "task has no title");
      const priority = await http("PATCH", "/delegation/tasks-board/item", { ...at(task), priority: 1 });
      assert.equal(priority.status, 400);
      assert.equal(readRaw("titleless/proj.md"), original);
      const titled = await http("PATCH", "/delegation/tasks-board/item", { ...at(task), title: "Real" });
      assert.equal(titled.status, 200);
      assert.equal(readRaw("titleless/proj.md"), doc("## Open loops", "", "- [ ] HOLD - Real #p3", "- [ ] Other", ""));
      assert.deepEqual(tmpLeftovers("titleless"), []);
    });
  });
});
