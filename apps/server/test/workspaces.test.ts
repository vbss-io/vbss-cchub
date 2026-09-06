import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import {
  createWorkspace,
  deleteWorkspace,
  discoverWorkspaces,
  findRepo,
  findWorkspace,
  resolveEditorCommand,
  stripJsonc,
  updateWorkspace,
  workspaceBrief,
  workspaceFor,
} from "../src/workspaces.js";

const tmp = mkdtempSync(join(tmpdir(), "cch-ws-"));
const root = join(tmp, "workspaces");
mkdirSync(join(root, "pilot"), { recursive: true });
mkdirSync(join(tmp, "repo-a"), { recursive: true });
mkdirSync(join(tmp, "repo-b"), { recursive: true });

writeFileSync(
  join(root, "pilot.code-workspace"),
  `{
    // workspace-level context lives in ./pilot
    "folders": [
      { "name": "(workspace)", "path": "pilot" },
      { "name": "Repo A", "path": "../repo-a", },
      { "path": "${resolve(tmp, "repo-b").replace(/\\/g, "\\\\")}" }, /* absolute */
    ],
    "settings": {},
  }`,
);
writeFileSync(join(root, "broken.code-workspace"), "{ this is not json");

describe("stripJsonc", () => {
  it("removes comments and trailing commas but leaves string contents alone", () => {
    const source = `{
      // line comment
      "url": "http://example.com/a//b", /* block */
      "weird": "a,}b", "list": [1, 2, ],
    }`;
    assert.deepEqual(JSON.parse(stripJsonc(source)), { url: "http://example.com/a//b", weird: "a,}b", list: [1, 2] });
  });
});

describe("discovery", () => {
  it("returns nothing for a missing root", () => {
    assert.deepEqual(discoverWorkspaces(null), []);
    assert.deepEqual(discoverWorkspaces(join(tmp, "nope")), []);
  });

  it("reads every .code-workspace, resolves folders and splits the context from repos", () => {
    const found = discoverWorkspaces(root);
    assert.deepEqual(found.map((workspace) => workspace.name), ["broken", "pilot"]);
    assert.ok(found[0]?.error);
    const pilot = found[1]!;
    assert.equal(pilot.contextPath, resolve(root, "pilot"));
    assert.deepEqual(pilot.repos, [
      { name: "Repo A", path: resolve(root, "../repo-a") },
      { name: "repo-b", path: resolve(tmp, "repo-b") },
    ]);
  });

  it("finds repos by name or folder basename, case-insensitively", () => {
    const pilot = findWorkspace(root, "pilot")!;
    assert.equal(findRepo(pilot, "repo a")?.path, resolve(root, "../repo-a"));
    assert.equal(findRepo(pilot, "REPO-A")?.name, "Repo A");
    assert.equal(findRepo(pilot, "repo-b")?.name, "repo-b");
    assert.equal(findRepo(pilot, "missing"), null);
  });

  it("describes the workspace map for agents", () => {
    const pilot = findWorkspace(root, "pilot")!;
    const brief = workspaceBrief(pilot, pilot.contextPath!);
    assert.match(brief, /"pilot" workspace/);
    assert.match(brief, /- Repo A: .*repo-a/);
    assert.match(brief, /never ask which folder/);
  });
});

describe("create and update", () => {
  it("creates the .code-workspace with relative repo paths and seeds the context folder", () => {
    const created = createWorkspace(root, "fresh", [join(tmp, "repo-a"), join(tmp, "repo-a"), join(tmp, "repo-b")]);
    assert.equal(created.name, "fresh");
    assert.equal(created.contextPath, resolve(root, "fresh"));
    assert.deepEqual(created.repos.map((repo) => repo.name), ["repo-a", "repo-b"]);
    const raw = JSON.parse(readFileSync(join(root, "fresh.code-workspace"), "utf8")) as { folders: { name: string; path: string }[] };
    assert.deepEqual(raw.folders[0], { name: "(workspace)", path: "fresh" });
    assert.equal(raw.folders[1]?.path, "../repo-a");
    assert.ok(existsSync(join(root, "fresh", "CLAUDE.md")));
    assert.ok(existsSync(join(root, "fresh", ".claude")));
    assert.match(readFileSync(join(root, "fresh", "CLAUDE.md"), "utf8"), /repo-a/);
  });

  it("refuses duplicates, bad names and missing repo folders", () => {
    assert.throws(() => createWorkspace(root, "fresh", []), /already exists/);
    assert.throws(() => createWorkspace(root, "bad name", []), /workspace name/);
    assert.throws(() => createWorkspace(root, "ghost", [join(tmp, "nope")]), /not a directory/);
  });

  it("maps a working directory back to its workspace", () => {
    const all = discoverWorkspaces(root);
    assert.ok(["fresh", "pilot"].includes(workspaceFor(all, join(tmp, "repo-a", "src"))?.name ?? ""));
    assert.equal(workspaceFor(all, join(root, "pilot", "docs"))?.name, "pilot");
    assert.equal(workspaceFor(all, join(root, "fresh", "docs"))?.name, "fresh");
    assert.equal(workspaceFor(all, join(tmp, "elsewhere")), null);
    assert.equal(workspaceFor(all, null), null);
  });

  it("deletes the workspace file and optionally its context folder", () => {
    createWorkspace(root, "gone", [join(tmp, "repo-a")]);
    const kept = deleteWorkspace(root, "gone", false);
    assert.ok(!existsSync(join(root, "gone.code-workspace")));
    assert.ok(existsSync(join(root, "gone")));
    assert.equal(kept.contextDeleted, false);
    createWorkspace(root, "gone2", [join(tmp, "repo-a")]);
    const removed = deleteWorkspace(root, "gone2", true);
    assert.equal(removed.contextDeleted, true);
    assert.ok(!existsSync(join(root, "gone2")));
    assert.throws(() => deleteWorkspace(root, "gone2", false), /not found/);
    assert.throws(() => deleteWorkspace(root, "../evil", true), /invalid/);
  });

  it("resolves well-known editor launchers or falls back to the command", () => {
    const resolved = resolveEditorCommand("code");
    assert.ok(resolved === "code" || /code\.cmd$/i.test(resolved));
    assert.equal(resolveEditorCommand("C:\\tools\\myeditor.exe"), "C:\\tools\\myeditor.exe");
    assert.equal(resolveEditorCommand("nano"), "nano");
  });

  it("replaces the repo list on update and keeps the settings block", () => {
    writeFileSync(
      join(root, "fresh.code-workspace"),
      JSON.stringify({ folders: [{ name: "(workspace)", path: "fresh" }], settings: { "editor.tabSize": 2 } }),
    );
    const updated = updateWorkspace(root, "fresh", [join(tmp, "repo-b")]);
    assert.deepEqual(updated.repos.map((repo) => repo.name), ["repo-b"]);
    const raw = JSON.parse(readFileSync(join(root, "fresh.code-workspace"), "utf8")) as { settings: Record<string, unknown> };
    assert.deepEqual(raw.settings, { "editor.tabSize": 2 });
    assert.throws(() => updateWorkspace(root, "missing", []), /not found/);
  });
});

after(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
