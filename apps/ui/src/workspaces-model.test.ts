import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextLabel, decodeWorkspaceParam, filterWorkspaces, repoCountLabel, splitRepoLines, workspaceMenuEntries } from "./workspaces-model";

const NAMES = [{ name: "preview" }, { name: "Storefront" }, { name: "vbss.io" }];

describe("filterWorkspaces", () => {
  it("returns everything for an empty or blank query", () => {
    assert.equal(filterWorkspaces(NAMES, "").length, 3);
    assert.equal(filterWorkspaces(NAMES, "   ").length, 3);
  });

  it("matches the name case-insensitively and by substring", () => {
    assert.deepEqual(filterWorkspaces(NAMES, "STORE"), [{ name: "Storefront" }]);
    assert.deepEqual(filterWorkspaces(NAMES, " io"), [{ name: "vbss.io" }]);
  });

  it("returns nothing when no name matches", () => {
    assert.deepEqual(filterWorkspaces(NAMES, "zzz"), []);
  });

  it("does not return the input array itself", () => {
    assert.notEqual(filterWorkspaces(NAMES, ""), NAMES);
  });
});

describe("splitRepoLines", () => {
  it("splits on LF and CRLF, trims and drops blanks", () => {
    assert.deepEqual(splitRepoLines("C:\\a\r\n  C:\\b  \n\n"), ["C:\\a", "C:\\b"]);
    assert.deepEqual(splitRepoLines(""), []);
  });
});

describe("decodeWorkspaceParam", () => {
  it("decodes URI components", () => {
    assert.equal(decodeWorkspaceParam("my%20wk"), "my wk");
  });

  it("returns the raw value when it is malformed and null when empty", () => {
    assert.equal(decodeWorkspaceParam("100%"), "100%");
    assert.equal(decodeWorkspaceParam(null), null);
    assert.equal(decodeWorkspaceParam(""), null);
  });
});

describe("repoCountLabel", () => {
  it("pluralises", () => {
    assert.equal(repoCountLabel(0), "0 repos");
    assert.equal(repoCountLabel(1), "1 repo");
    assert.equal(repoCountLabel(3), "3 repos");
  });
});

describe("contextLabel", () => {
  it("shows the path or says there is none", () => {
    assert.equal(contextLabel({ contextPath: "C:\\ws\\preview" }), "C:\\ws\\preview");
    assert.equal(contextLabel({ contextPath: null }), "no context folder");
  });
});

describe("workspaceMenuEntries", () => {
  it("offers edit repos and a danger delete", () => {
    const entries = workspaceMenuEntries(false);
    assert.deepEqual(entries.map((entry) => entry.key), ["edit", "delete"]);
    assert.equal(entries[0]?.label, "Edit repos");
    assert.equal(entries[1]?.danger, true);
  });

  it("labels the edit entry as a close while the editor is open", () => {
    assert.equal(workspaceMenuEntries(true)[0]?.label, "Close repos editor");
  });
});
