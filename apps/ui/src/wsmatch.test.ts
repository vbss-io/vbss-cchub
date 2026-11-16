import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { WorkspaceRecord } from "./delegation";
import { repoOf, workspaceOf } from "./wsmatch";

const ws = (name: string, contextPath: string | null, repos: [string, string][]): WorkspaceRecord => ({
  name,
  file: `${name}.json`,
  contextPath,
  repos: repos.map(([repoName, path]) => ({ name: repoName, path })),
  error: null,
});

describe("workspaceOf", () => {
  const list = [ws("alpha", "C:\\Work\\.workspaces\\alpha", [["api", "C:/Code/api"]]), ws("beta", null, [["web", "C:/Code/web/"], ["api2", "C:/Code/api"]])];

  it("matches the context folder and repos, ignoring case, slashes and trailing separators", () => {
    assert.equal(workspaceOf(list, "c:/work/.workspaces/alpha/notes"), "alpha");
    assert.equal(workspaceOf(list, "C:\\Code\\web\\src"), "beta");
    assert.equal(workspaceOf(list, "C:/Code/web"), "beta");
  });

  it("keeps the first workspace that holds the folder", () => {
    assert.equal(workspaceOf(list, "C:/Code/api/src"), "alpha");
  });

  it("returns null for no folder, an outside folder or a prefix that is not a parent", () => {
    assert.equal(workspaceOf(list, null), null);
    assert.equal(workspaceOf(list, undefined), null);
    assert.equal(workspaceOf(list, "C:/Code/apix"), null);
    assert.equal(workspaceOf(list, "D:/else"), null);
  });

  it("answers again from a new workspace list instead of an old cached one", () => {
    const before = [ws("one", null, [["r", "C:/R"]])];
    assert.equal(workspaceOf(before, "C:/R/x"), "one");
    const after = [ws("two", null, [["r", "C:/R"]])];
    assert.equal(workspaceOf(after, "C:/R/x"), "two");
    assert.equal(workspaceOf(before, "C:/R/x"), "one");
  });
});

describe("repoOf", () => {
  it("names the repo holding the folder, or null", () => {
    const list = [ws("alpha", null, [["api", "C:/Code/api"]]), ws("beta", null, [["web", "C:/Code/web"]])];
    assert.equal(repoOf(list, "C:\\Code\\web\\pkg"), "web");
    assert.equal(repoOf(list, "C:/Code/api"), "api");
    assert.equal(repoOf(list, "C:/Code/other"), null);
    assert.equal(repoOf(list, null), null);
  });
});
