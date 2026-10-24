import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  title: string;
  status: string;
  section: string;
  doneAt: string | null;
  notes: string[];
  noteItems: WireNote[];
  subtasks: WireTask[];
}

const box: Sandbox = makeSandbox("cch-tasks-notes-");
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

const NOTE_ROUTE = "/delegation/tasks-board/note";
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

const addNote = (task: WireTask, text: unknown): Promise<HttpResult> =>
  http("POST", NOTE_ROUTE, { projectId: task.projectId, line: task.line, raw: task.raw, text });

const editNote = (task: WireTask, note: WireNote, text: unknown): Promise<HttpResult> =>
  http("PATCH", NOTE_ROUTE, { projectId: task.projectId, line: note.line, raw: note.raw, text });

const deleteNote = (task: WireTask, note: WireNote): Promise<HttpResult> =>
  http("DELETE", NOTE_ROUTE, { projectId: task.projectId, line: note.line, raw: note.raw });

const lines = (content: string): string[] => content.split(/\r\n|\n/);

const MIXED = [
  "## Open loops",
  "",
  "- [ ] Alpha release",
  "  - [ ] Draft changelog",
  "    - changelog note",
  "  - existing alpha note",
  "- [ ] Beta rollout",
  "- [ ] Gamma audit",
  "  - first gamma note",
  "",
].join("\n");

describe("tasks board notes CRUD", () => {
  before(async () => {
    mkdirSync(vault, { recursive: true });
    hub = await startServer(box, { HUB_DELEGATION: "1" });
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("exposes noteItems with line, raw and text next to the legacy notes array", async () => {
    reset("shape", {
      "s.md": ["## Open loops", "", "- [ ] Owner", "  - [ ] Child", "    * child note", "  - owner dash", "  plain owner line", ""].join("\n"),
    });
    await configure("shape");
    const owner = await find("s", "Owner");
    assert.deepEqual(owner.notes, ["owner dash", "plain owner line"]);
    assert.deepEqual(owner.noteItems, [
      { line: 5, raw: "  - owner dash", text: "owner dash" },
      { line: 6, raw: "  plain owner line", text: "plain owner line" },
    ]);
    const child = await find("s", "Child");
    assert.deepEqual(child.noteItems, [{ line: 4, raw: "    * child note", text: "child note" }]);
    assert.deepEqual(child.notes, ["child note"]);
  });

  describe("add", () => {
    it("appends after the subtasks and the existing notes with the subtask indent", async () => {
      reset("add", { "a.md": MIXED });
      await configure("add");
      const alpha = await find("a", "Alpha release");
      const res = await addNote(alpha, "  new alpha note  ");
      assert.equal(res.status, 201);
      assert.equal(readRaw("add/a.md"), MIXED.replace("  - existing alpha note\n", "  - existing alpha note\n  - new alpha note\n"));
      const task = res.json.task as WireTask;
      assert.equal(task.title, "Alpha release");
      assert.equal(task.line, alpha.line);
      const added = task.noteItems[task.noteItems.length - 1] as WireNote;
      assert.deepEqual(added, { line: 6, raw: "  - new alpha note", text: "new alpha note" });
      assert.equal(lines(readRaw("add/a.md"))[added.line], added.raw);
      assert.deepEqual(task.notes, ["existing alpha note", "new alpha note"]);
    });

    it("adds under a task without children using one indent unit, and after existing notes", async () => {
      reset("add2", { "a.md": MIXED });
      await configure("add2");
      const beta = await find("a", "Beta rollout");
      assert.equal((await addNote(beta, "beta first")).status, 201);
      const gamma = await find("a", "Gamma audit");
      assert.equal((await addNote(gamma, "gamma second")).status, 201);
      assert.equal(
        readRaw("add2/a.md"),
        MIXED.replace("- [ ] Beta rollout\n", "- [ ] Beta rollout\n  - beta first\n").replace("  - first gamma note\n", "  - first gamma note\n  - gamma second\n"),
      );
      const refreshed = await find("a", "Beta rollout");
      assert.deepEqual(refreshed.notes, ["beta first"]);
    });

    it("adds a note to a subtask and nests it one unit deeper than the subtask", async () => {
      reset("add3", { "a.md": MIXED });
      await configure("add3");
      const sub = await find("a", "Draft changelog");
      const res = await addNote(sub, "sub second");
      assert.equal(res.status, 201);
      assert.equal(readRaw("add3/a.md"), MIXED.replace("    - changelog note\n", "    - changelog note\n    - sub second\n"));
      assert.equal((res.json.task as WireTask).title, "Draft changelog");
      assert.deepEqual((res.json.task as WireTask).notes, ["changelog note", "sub second"]);
    });

    it("follows tab indentation for both the document unit and the parent indent", async () => {
      const tabs = ["## Open loops", "", "- [ ] Tabbed parent", "\t- [ ] Tabbed child", "\t\t- deep tab note", "- [ ] Lonely", ""].join("\n");
      reset("tabs", { "t.md": tabs });
      await configure("tabs");
      const parent = await find("t", "Tabbed parent");
      assert.equal((await addNote(parent, "parent note")).status, 201);
      const lonely = await find("t", "Lonely");
      assert.equal((await addNote(lonely, "lonely note")).status, 201);
      const child = await find("t", "Tabbed child");
      assert.equal((await addNote(child, "child note")).status, 201);
      assert.equal(
        readRaw("tabs/t.md"),
        ["## Open loops", "", "- [ ] Tabbed parent", "\t- [ ] Tabbed child", "\t\t- deep tab note", "\t\t- child note", "\t- parent note", "- [ ] Lonely", "\t- lonely note", ""].join("\n"),
      );
    });

    it("keeps the note outside of the next task when blank lines follow the block", async () => {
      const spaced = ["## Open loops", "", "- [ ] One", "  - [ ] Sub", "", "- [ ] Two", ""].join("\n");
      reset("spaced", { "p.md": spaced });
      await configure("spaced");
      const one = await find("p", "One");
      assert.equal((await addNote(one, "after sub")).status, 201);
      assert.equal(readRaw("spaced/p.md"), ["## Open loops", "", "- [ ] One", "  - [ ] Sub", "  - after sub", "", "- [ ] Two", ""].join("\n"));
    });

    it("appends to a task that ends the file without a trailing newline", async () => {
      reset("eof", { "e.md": "## Open loops\n\n- [ ] Last task" });
      await configure("eof");
      const last = await find("e", "Last task");
      assert.equal((await addNote(last, "tail")).status, 201);
      assert.equal(readRaw("eof/e.md"), "## Open loops\n\n- [ ] Last task\n  - tail");
    });
  });

  describe("edit", () => {
    const EDITABLE = ["## Open loops", "", "- [ ] Host", "  - [ ] Inner", "    * star note", "  - dash note", "  bare note", "\t- tab note", ""].join("\n");

    it("replaces only the text and keeps indent and bullet marker", async () => {
      reset("edit", { "h.md": EDITABLE });
      await configure("edit");
      const inner = await find("h", "Inner");
      const star = inner.noteItems[0] as WireNote;
      const res = await editNote(inner, star, "  starred again  ");
      assert.equal(res.status, 200);
      assert.equal(readRaw("edit/h.md"), EDITABLE.replace("    * star note", "    * starred again"));
      const task = res.json.task as WireTask;
      assert.equal(task.title, "Inner");
      assert.deepEqual(task.noteItems, [{ line: 4, raw: "    * starred again", text: "starred again" }]);
      assert.deepEqual(task.notes, ["starred again"]);
    });

    it("keeps a bare note bare and a dash note dashed", async () => {
      reset("edit2", { "h.md": EDITABLE });
      await configure("edit2");
      const host = await find("h", "Host");
      const dash = host.noteItems.find((note) => note.text === "dash note") as WireNote;
      assert.equal((await editNote(host, dash, "dash edited")).status, 200);
      const reloaded = await find("h", "Host");
      const bare = reloaded.noteItems.find((note) => note.text === "bare note") as WireNote;
      const res = await editNote(reloaded, bare, "bare edited");
      assert.equal(res.status, 200);
      assert.equal(readRaw("edit2/h.md"), EDITABLE.replace("  - dash note", "  - dash edited").replace("  bare note", "  bare edited"));
    });

    it("keeps tab indentation on a tab-indented note", async () => {
      reset("edit3", { "h.md": EDITABLE });
      await configure("edit3");
      const host = await find("h", "Host");
      const tab = host.noteItems.find((note) => note.text === "tab note") as WireNote;
      assert.equal((await editNote(host, tab, "tab edited")).status, 200);
      assert.equal(readRaw("edit3/h.md"), EDITABLE.replace("\t- tab note", "\t- tab edited"));
    });

    it("does not touch the file when the text is unchanged", async () => {
      reset("edit4", { "h.md": EDITABLE });
      await configure("edit4");
      const host = await find("h", "Host");
      const dash = host.noteItems.find((note) => note.text === "dash note") as WireNote;
      const res = await editNote(host, dash, "dash note");
      assert.equal(res.status, 200);
      assert.equal(readRaw("edit4/h.md"), EDITABLE);
    });

    it("refuses text that would turn the note into a task, or fence", async () => {
      reset("edit5", { "h.md": EDITABLE });
      await configure("edit5");
      const host = await find("h", "Host");
      const bare = host.noteItems.find((note) => note.text === "bare note") as WireNote;
      const dash = host.noteItems.find((note) => note.text === "dash note") as WireNote;
      assert.equal((await editNote(host, dash, "[ ] sneaky")).status, 400);
      assert.equal((await editNote(host, bare, "- [ ] sneaky")).status, 400);
      assert.equal((await editNote(host, bare, "```js")).status, 400);
      assert.equal((await addNote(host, "[x] sneaky")).status, 400);
      assert.equal(readRaw("edit5/h.md"), EDITABLE);
    });

    it("validates the supplied text itself so dashed notes and plus bullets cannot look like tasks or fences", async () => {
      reset("edit6", { "h.md": EDITABLE });
      await configure("edit6");
      const host = await find("h", "Host");
      const bare = host.noteItems.find((note) => note.text === "bare note") as WireNote;
      const dash = host.noteItems.find((note) => note.text === "dash note") as WireNote;
      const rejected = ["```", "~~~", "```js", "* [x] y", "+ [ ] sneaky", "- [-] sneaky", "1. [ ] numbered", "2) [x] numbered", "[X] sneaky", "[-] sneaky"];
      for (const text of rejected) {
        const added = await addNote(host, text);
        assert.equal(added.status, 400, `add ${text}`);
        assert.equal(added.json.error, "text must not look like a task or a code fence", `add ${text}`);
        assert.equal((await editNote(host, dash, text)).status, 400, `edit dash ${text}`);
        assert.equal((await editNote(host, bare, text)).status, 400, `edit bare ${text}`);
      }
      assert.equal(readRaw("edit6/h.md"), EDITABLE);
      assert.equal((await addNote(host, "+ plus note")).status, 201);
      assert.equal((await addNote(host, "1. numbered note")).status, 201);
      assert.equal((await addNote(host, "[link](x) note")).status, 201);
    });
  });

  describe("delete", () => {
    it("removes a single note line and shifts the lines of the following notes", async () => {
      reset("del", { "a.md": MIXED });
      await configure("del");
      const alpha = await find("a", "Alpha release");
      const existing = alpha.noteItems.find((note) => note.text === "existing alpha note") as WireNote;
      const res = await deleteNote(alpha, existing);
      assert.equal(res.status, 200);
      assert.equal(readRaw("del/a.md"), MIXED.replace("  - existing alpha note\n", ""));
      const task = res.json.task as WireTask;
      assert.equal(task.title, "Alpha release");
      assert.deepEqual(task.noteItems, []);
      const gamma = await find("a", "Gamma audit");
      assert.equal(lines(readRaw("del/a.md"))[(gamma.noteItems[0] as WireNote).line], "  - first gamma note");
    });

    it("removes the deeper lines nested under the note as part of its block", async () => {
      const nested = ["## Open loops", "", "- [ ] Host", "  - note one", "    - nested a", "      - nested b", "  - note two", "- [ ] After", ""].join("\n");
      reset("del2", { "n.md": nested });
      await configure("del2");
      const host = await find("n", "Host");
      const one = host.noteItems.find((note) => note.text === "note one") as WireNote;
      const res = await deleteNote(host, one);
      assert.equal(res.status, 200);
      assert.equal(readRaw("del2/n.md"), ["## Open loops", "", "- [ ] Host", "  - note two", "- [ ] After", ""].join("\n"));
      assert.deepEqual((res.json.task as WireTask).noteItems, [{ line: 3, raw: "  - note two", text: "note two" }]);
    });

    it("keeps a task nested under the deleted note and removes only the non-task lines nested under it", async () => {
      const nested = ["## Open loops", "", "- [ ] T", "  - context", "    - [ ] Sub under note", "      - sub note", "    - deeper plain", "- [ ] U", ""].join("\n");
      reset("del5", { "n.md": nested });
      await configure("del5");
      const host = await find("n", "T");
      const context = host.noteItems.find((note) => note.text === "context") as WireNote;
      const res = await deleteNote(host, context);
      assert.equal(res.status, 200);
      assert.equal(readRaw("del5/n.md"), ["## Open loops", "", "- [ ] T", "    - [ ] Sub under note", "      - sub note", "- [ ] U", ""].join("\n"));
      const task = res.json.task as WireTask;
      assert.deepEqual(task.noteItems, []);
      assert.deepEqual(task.subtasks.map((sub) => sub.title), ["Sub under note"]);
      assert.deepEqual(task.subtasks[0]?.notes, ["sub note"]);
    });

    it("keeps nested tasks with their own blocks when the note has no other lines", async () => {
      const nested = ["## Open loops", "", "- [ ] T", "  - context", "    - [ ] First", "      - [ ] Second", "    - [ ] Third", "- [ ] U", ""].join("\n");
      reset("del6", { "n.md": nested });
      await configure("del6");
      const host = await find("n", "T");
      const context = host.noteItems.find((note) => note.text === "context") as WireNote;
      assert.equal((await deleteNote(host, context)).status, 200);
      assert.equal(readRaw("del6/n.md"), ["## Open loops", "", "- [ ] T", "    - [ ] First", "      - [ ] Second", "    - [ ] Third", "- [ ] U", ""].join("\n"));
    });

    it("deletes the last line of a file without a trailing newline", async () => {
      reset("del3", { "e.md": "## Open loops\n\n- [ ] Host\n  - only note" });
      await configure("del3");
      const host = await find("e", "Host");
      assert.equal((await deleteNote(host, host.noteItems[0] as WireNote)).status, 200);
      assert.equal(readRaw("del3/e.md"), "## Open loops\n\n- [ ] Host");
    });

    it("deletes a subtask note", async () => {
      reset("del4", { "a.md": MIXED });
      await configure("del4");
      const sub = await find("a", "Draft changelog");
      const res = await deleteNote(sub, sub.noteItems[0] as WireNote);
      assert.equal(res.status, 200);
      assert.equal(readRaw("del4/a.md"), MIXED.replace("    - changelog note\n", ""));
      assert.equal((res.json.task as WireTask).title, "Draft changelog");
    });
  });

  describe("failures", () => {
    it("answers 400 for a bad text on add and edit and leaves the file alone", async () => {
      reset("bad", { "a.md": MIXED });
      await configure("bad");
      const alpha = await find("a", "Alpha release");
      const note = alpha.noteItems[0] as WireNote;
      for (const text of ["", "   ", "line one\nline two", "cr\rhere", 5, null, undefined]) {
        assert.equal((await addNote(alpha, text)).status, 400, `add ${String(text)}`);
        assert.equal((await editNote(alpha, note, text)).status, 400, `edit ${String(text)}`);
      }
      assert.equal(readRaw("bad/a.md"), MIXED);
    });

    it("answers 400 for a malformed target", async () => {
      reset("bad2", { "a.md": MIXED });
      await configure("bad2");
      const alpha = await find("a", "Alpha release");
      const send = (method: string, body: Record<string, unknown>) => http(method, NOTE_ROUTE, body);
      for (const method of ["POST", "PATCH", "DELETE"]) {
        assert.equal((await send(method, { line: alpha.line, raw: alpha.raw, text: "x" })).status, 400, `${method} projectId`);
        assert.equal((await send(method, { projectId: "a", line: -1, raw: alpha.raw, text: "x" })).status, 400, `${method} negative`);
        assert.equal((await send(method, { projectId: "a", line: 1.5, raw: alpha.raw, text: "x" })).status, 400, `${method} fractional`);
        assert.equal((await send(method, { projectId: "a", line: alpha.line, text: "x" })).status, 400, `${method} raw`);
      }
      assert.equal(readRaw("bad2/a.md"), MIXED);
    });

    it("answers 400 when the line is not what the verb needs", async () => {
      reset("bad3", { "a.md": MIXED });
      await configure("bad3");
      const alpha = await find("a", "Alpha release");
      const lineAt = (index: number): string => lines(MIXED)[index] as string;
      assert.equal((await http("POST", NOTE_ROUTE, { projectId: "a", line: 0, raw: lineAt(0), text: "x" })).status, 400);
      assert.equal((await http("POST", NOTE_ROUTE, { projectId: "a", line: 1, raw: lineAt(1), text: "x" })).status, 400);
      assert.equal((await http("POST", NOTE_ROUTE, { projectId: "a", line: 5, raw: lineAt(5), text: "x" })).status, 400);
      assert.equal((await http("PATCH", NOTE_ROUTE, { projectId: "a", line: alpha.line, raw: alpha.raw, text: "x" })).status, 400);
      assert.equal((await http("DELETE", NOTE_ROUTE, { projectId: "a", line: alpha.line, raw: alpha.raw })).status, 400);
      assert.equal((await http("PATCH", NOTE_ROUTE, { projectId: "a", line: 0, raw: lineAt(0), text: "x" })).status, 400);
      assert.equal((await http("DELETE", NOTE_ROUTE, { projectId: "a", line: 1, raw: lineAt(1) })).status, 400);
      assert.equal(readRaw("bad3/a.md"), MIXED);
    });

    it("answers 409 with the fresh owner for a stale raw, and null when the line is gone", async () => {
      reset("stale", { "a.md": MIXED });
      await configure("stale");
      const alpha = await find("a", "Alpha release");
      const note = alpha.noteItems[0] as WireNote;
      const staleAdd = await http("POST", NOTE_ROUTE, { projectId: "a", line: alpha.line, raw: "- [ ] Alpha release (old)", text: "x" });
      assert.equal(staleAdd.status, 409);
      assert.equal(staleAdd.json.error, "changed on disk");
      assert.equal((staleAdd.json.current as WireTask).title, "Alpha release");
      const staleEdit = await http("PATCH", NOTE_ROUTE, { projectId: "a", line: note.line, raw: "  - older text", text: "x" });
      assert.equal(staleEdit.status, 409);
      assert.equal(staleEdit.json.error, "changed on disk");
      assert.equal((staleEdit.json.current as WireTask).title, "Alpha release");
      const staleDelete = await http("DELETE", NOTE_ROUTE, { projectId: "a", line: note.line, raw: "  - older text" });
      assert.equal(staleDelete.status, 409);
      assert.equal((staleDelete.json.current as WireTask).title, "Alpha release");
      const gone = await http("DELETE", NOTE_ROUTE, { projectId: "a", line: 99, raw: "  - ghost" });
      assert.equal(gone.status, 409);
      assert.equal(gone.json.current, null);
      const goneAdd = await http("POST", NOTE_ROUTE, { projectId: "a", line: 99, raw: "- [ ] ghost", text: "x" });
      assert.equal(goneAdd.status, 409);
      assert.equal(goneAdd.json.current, null);
      assert.equal(readRaw("stale/a.md"), MIXED);
    });

    it("answers 404 for an unknown project and 400 when the feature is off", async () => {
      reset("off", { "a.md": MIXED });
      await configure("off");
      const alpha = await find("a", "Alpha release");
      const note = alpha.noteItems[0] as WireNote;
      assert.equal((await http("POST", NOTE_ROUTE, { projectId: "ghost", line: 0, raw: "x", text: "x" })).status, 404);
      assert.equal((await http("PATCH", NOTE_ROUTE, { projectId: "ghost", line: 0, raw: "x", text: "x" })).status, 404);
      assert.equal((await http("DELETE", NOTE_ROUTE, { projectId: "ghost", line: 0, raw: "x" })).status, 404);
      assert.equal((await http("PUT", "/delegation/settings", { features: { tasks: false } })).status, 200);
      assert.equal((await addNote(alpha, "x")).status, 400);
      assert.equal((await editNote(alpha, note, "x")).status, 400);
      assert.equal((await deleteNote(alpha, note)).status, 400);
      assert.equal(readRaw("off/a.md"), MIXED);
      await configure("off");
    });
  });

  describe("file fidelity", () => {
    it("preserves CRLF endings and the BOM across add, edit and delete", async () => {
      const crlf = "\uFEFF" + ["## Open loops", "", "- [ ] Windows task", "  - [ ] Sub", "  - keep me", "- [ ] Other", ""].join("\r\n");
      reset("crlf", { "w.md": crlf });
      await configure("crlf");
      const task = await find("w", "Windows task");
      const added = await addNote(task, "added");
      assert.equal(added.status, 201);
      const afterAdd = readRaw("crlf/w.md");
      assert.equal(afterAdd, "\uFEFF" + ["## Open loops", "", "- [ ] Windows task", "  - [ ] Sub", "  - keep me", "  - added", "- [ ] Other", ""].join("\r\n"));
      const fresh = await find("w", "Windows task");
      const keep = fresh.noteItems.find((note) => note.text === "keep me") as WireNote;
      assert.equal((await editNote(fresh, keep, "kept")).status, 200);
      assert.equal(readRaw("crlf/w.md"), afterAdd.replace("  - keep me", "  - kept"));
      const again = await find("w", "Windows task");
      const addedNote = again.noteItems.find((note) => note.text === "added") as WireNote;
      assert.equal((await deleteNote(again, addedNote)).status, 200);
      const finalText = readRaw("crlf/w.md");
      assert.equal(finalText, "\uFEFF" + ["## Open loops", "", "- [ ] Windows task", "  - [ ] Sub", "  - kept", "- [ ] Other", ""].join("\r\n"));
      assert.equal(finalText.startsWith("\uFEFF"), true);
      assert.equal(/(^|[^\r])\n/.test(finalText), false);
    });

    it("keeps working in a done-section task without moving it or touching the stamp", async () => {
      const done = ["## Open loops", "", "- [ ] Still open", "", "## Done loops", "", "- [x] Shipped feature ✅ 2026-03-01", "  - [x] Shipped child ✅ 2026-03-01", "  - release note", ""].join("\n");
      reset("done", { "d.md": done });
      await configure("done", { doneSection: "Done loops" });
      const shipped = await find("d", "Shipped feature");
      assert.equal(shipped.section, "done");
      assert.deepEqual(shipped.noteItems, [{ line: 8, raw: "  - release note", text: "release note" }]);
      const added = await addNote(shipped, "post mortem");
      assert.equal(added.status, 201);
      assert.equal(readRaw("done/d.md"), done.replace("  - release note\n", "  - release note\n  - post mortem\n"));
      const fresh = await find("d", "Shipped feature");
      assert.equal(fresh.section, "done");
      assert.equal(fresh.doneAt, "2026-03-01");
      assert.equal((await editNote(fresh, fresh.noteItems[0] as WireNote, "release note v2")).status, 200);
      const latest = await find("d", "Shipped feature");
      assert.equal((await deleteNote(latest, latest.noteItems[1] as WireNote)).status, 200);
      assert.equal(readRaw("done/d.md"), done.replace("  - release note\n", "  - release note v2\n"));
      const child = await find("d", "Shipped child");
      const childAdded = await addNote(child, "child detail");
      assert.equal(childAdded.status, 201);
      assert.equal((childAdded.json.task as WireTask).section, "done");
      assert.equal(readRaw("done/d.md").includes("- [x] Shipped feature ✅ 2026-03-01\n"), true);
      await configure("done");
    });

    it("broadcasts a hub tasks event for a write and no disk echo", async () => {
      reset("sse", { "a.md": MIXED });
      await configure("sse");
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
      const alpha = await find("a", "Alpha release");
      assert.equal((await addNote(alpha, "sse note")).status, 201);
      await waitFor(async () => (received.includes("event: tasks") && received.includes('"source":"hub"') ? true : null), 5000);
      await new Promise((resolve) => setTimeout(resolve, 900));
      controller.abort();
      assert.equal(received.includes('"source":"disk"'), false);
    });
  });

  describe("round 3 verifier fixes", () => {
    const titlesOf = async (projectId: string): Promise<string[]> => (await listTasks()).filter((task) => task.projectId === projectId).map((task) => task.title);
    const noteOf = (task: WireTask, text: string): WireNote => {
      const found = task.noteItems.find((note) => note.text === text);
      assert.ok(found, text);
      return found;
    };

    it("removes a fenced block nested under the deleted note without turning its task-looking lines into tasks", async () => {
      const src = ["## Open loops", "", "- [ ] T", "  - note A", "    ```", "    - [ ] code", "    ```", "- [ ] U", ""].join("\n");
      reset("fence1", { "f.md": src });
      await configure("fence1");
      assert.deepEqual(await titlesOf("f"), ["T", "U"]);
      const host = await find("f", "T");
      const res = await deleteNote(host, noteOf(host, "note A"));
      assert.equal(res.status, 200);
      assert.equal(readRaw("fence1/f.md"), ["## Open loops", "", "- [ ] T", "- [ ] U", ""].join("\n"));
      assert.deepEqual(await titlesOf("f"), ["T", "U"]);
      assert.deepEqual((res.json.task as WireTask).subtasks, []);
    });

    it("handles longer and tilde fences and keeps a real subtask with its own fence", async () => {
      const src = [
        "## Open loops",
        "",
        "- [ ] T",
        "  - note A",
        "    ````md",
        "    ```",
        "    - [ ] fake one",
        "    ```",
        "    ````",
        "    ~~~",
        "    - [x] fake two",
        "    ~~~",
        "    - [ ] Real sub",
        "      ```",
        "      - [ ] sub code",
        "      ```",
        "- [ ] U",
        "",
      ].join("\n");
      reset("fence2", { "f.md": src });
      await configure("fence2");
      assert.deepEqual(await titlesOf("f"), ["T", "Real sub", "U"]);
      const host = await find("f", "T");
      assert.equal((await deleteNote(host, noteOf(host, "note A"))).status, 200);
      assert.equal(readRaw("fence2/f.md"), ["## Open loops", "", "- [ ] T", "    - [ ] Real sub", "      ```", "      - [ ] sub code", "      ```", "- [ ] U", ""].join("\n"));
      assert.deepEqual(await titlesOf("f"), ["T", "Real sub", "U"]);
    });

    it("refuses to delete a note whose code fence is not closed inside it and leaves the file alone", async () => {
      const src = ["## Open loops", "", "- [ ] T", "  - note A", "    ```", "    - [ ] code", "- [ ] U", ""].join("\n");
      reset("fence3", { "f.md": src });
      await configure("fence3");
      const host = await find("f", "T");
      const res = await deleteNote(host, noteOf(host, "note A"));
      assert.equal(res.status, 400);
      assert.equal(readRaw("fence3/f.md"), src);
    });

    it("does not leave a blank line between neighbours that were not separated before", async () => {
      reset("blank1", {
        "a.md": ["## Open loops", "", "- [ ] T", "  - [ ] sub", "", "  - note A", "- [ ] U", ""].join("\n"),
        "b.md": ["## Open loops", "", "- [ ] T", "  - note A", "", "  - note B", "- [ ] U", ""].join("\n"),
        "c.md": ["## Open loops", "", "- [ ] T", "  - note A", "", "    deeper para", "", "    - [ ] nested task", "      - nested note", "    - deeper note", "  - note B", ""].join("\n"),
      });
      await configure("blank1");
      const a = await find("a", "T");
      assert.equal((await deleteNote(a, noteOf(a, "note A"))).status, 200);
      assert.equal(readRaw("blank1/a.md"), ["## Open loops", "", "- [ ] T", "  - [ ] sub", "- [ ] U", ""].join("\n"));
      const b = await find("b", "T");
      assert.equal((await deleteNote(b, noteOf(b, "note A"))).status, 200);
      assert.equal(readRaw("blank1/b.md"), ["## Open loops", "", "- [ ] T", "  - note B", "- [ ] U", ""].join("\n"));
      const c = await find("c", "T");
      assert.equal((await deleteNote(c, noteOf(c, "note A"))).status, 200);
      assert.equal(readRaw("blank1/c.md"), ["## Open loops", "", "- [ ] T", "    - [ ] nested task", "      - nested note", "  - note B", ""].join("\n"));
    });

    it("keeps the blank that separates the task block from the next item and spacing elsewhere", async () => {
      const src = ["## Open loops", "", "- [ ] One", "  - [ ] Sub", "  - after sub", "", "- [ ] Two", "", "- [ ] Three", "  - n1", "", "  - n2", "  - n3", ""].join("\n");
      reset("blank2", { "a.md": src });
      await configure("blank2");
      const one = await find("a", "One");
      assert.equal((await deleteNote(one, noteOf(one, "after sub"))).status, 200);
      const three = await find("a", "Three");
      assert.equal((await deleteNote(three, noteOf(three, "n3"))).status, 200);
      assert.equal(readRaw("blank2/a.md"), ["## Open loops", "", "- [ ] One", "  - [ ] Sub", "", "- [ ] Two", "", "- [ ] Three", "  - n1", "", "  - n2", ""].join("\n"));
    });

    it("adds a note with the indent of the task's existing children before falling back to the document unit", async () => {
      const src = ["## Open loops", "", "- [ ] T", "\t- [ ] S", "- [ ] U", "  - unote", "- [ ] V", "   - vnote", ""].join("\n");
      reset("indent", { "i.md": src });
      await configure("indent");
      assert.equal((await addNote(await find("i", "U"), "u2")).status, 201);
      assert.equal((await addNote(await find("i", "T"), "t2")).status, 201);
      assert.equal((await addNote(await find("i", "V"), "v2")).status, 201);
      assert.equal(readRaw("indent/i.md"), ["## Open loops", "", "- [ ] T", "\t- [ ] S", "\t- t2", "- [ ] U", "  - unote", "  - u2", "- [ ] V", "   - vnote", "   - v2", ""].join("\n"));
    });
  });
});
