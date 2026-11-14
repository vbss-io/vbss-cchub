import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapScope, mapSummaryLine, navClickMode, navCurrentKey, parseSessionsMode, resolveSessionsMode, sessionsModeRouteOf, sessionsSubtitle } from "./sessions-mode";

describe("parseSessionsMode", () => {
  it("reads map and falls back to list for anything else", () => {
    assert.equal(parseSessionsMode("map"), "map");
    assert.equal(parseSessionsMode("list"), "list");
    assert.equal(parseSessionsMode(null), "list");
    assert.equal(parseSessionsMode(undefined), "list");
    assert.equal(parseSessionsMode("grid"), "list");
  });
});

describe("resolveSessionsMode", () => {
  it("keeps the remembered mode while the Flow plugin is on", () => {
    assert.equal(resolveSessionsMode("map", true), "map");
    assert.equal(resolveSessionsMode("list", true), "list");
  });

  it("falls back to the list when the Flow plugin is off", () => {
    assert.equal(resolveSessionsMode("map", false), "list");
    assert.equal(resolveSessionsMode("list", false), "list");
  });
});

describe("sessionsModeRouteOf", () => {
  it("sends #/flow to the Map mode of Sessions when Flow is on", () => {
    assert.equal(sessionsModeRouteOf("flow", true), "map");
  });

  it("leaves #/flow to the disabled-view fallback when Flow is off", () => {
    assert.equal(sessionsModeRouteOf("flow", false), null);
  });

  it("ignores every other view", () => {
    assert.equal(sessionsModeRouteOf("sessions", true), null);
    assert.equal(sessionsModeRouteOf("tasks", true), null);
    assert.equal(sessionsModeRouteOf("board", false), null);
  });
});

describe("navCurrentKey", () => {
  it("makes Flow the current item while Sessions is in Map mode and Flow is on", () => {
    assert.equal(navCurrentKey("sessions", "map", true), "flow");
  });

  it("keeps Sessions current in List mode", () => {
    assert.equal(navCurrentKey("sessions", "list", true), "sessions");
  });

  it("keeps Sessions current when Flow is off, whatever the remembered mode", () => {
    assert.equal(navCurrentKey("sessions", "map", false), "sessions");
  });

  it("never touches other views", () => {
    assert.equal(navCurrentKey("board", "map", true), "board");
    assert.equal(navCurrentKey("settings", "map", true), "settings");
  });
});

describe("navClickMode", () => {
  it("opens List from Sessions and Map from Flow", () => {
    assert.equal(navClickMode("sessions", true), "list");
    assert.equal(navClickMode("sessions", false), "list");
    assert.equal(navClickMode("flow", true), "map");
  });

  it("leaves Flow to the disabled-view fallback when the plugin is off and ignores other items", () => {
    assert.equal(navClickMode("flow", false), null);
    assert.equal(navClickMode("board", true), null);
  });
});

describe("mapScope", () => {
  it("shows everything on All and drops tasks when Delegated is off", () => {
    assert.deepEqual(mapScope("all", true), { sessions: true, codex: true, tasks: true });
    assert.deepEqual(mapScope("all", false), { sessions: true, codex: true, tasks: false });
  });

  it("narrows the map to the picked origin", () => {
    assert.deepEqual(mapScope("claude", true), { sessions: true, codex: false, tasks: false });
    assert.deepEqual(mapScope("codex", true), { sessions: false, codex: true, tasks: false });
    assert.deepEqual(mapScope("delegated", true), { sessions: false, codex: false, tasks: true });
  });

  it("treats the Delegated origin as All when the plugin is off", () => {
    assert.deepEqual(mapScope("delegated", false), { sessions: true, codex: true, tasks: false });
  });
});

describe("mapSummaryLine", () => {
  it("joins the counts in one discreet line", () => {
    assert.equal(mapSummaryLine({ live: 3, subagents: 2, tasks: 1, needYou: 4 }, true), "3 live · 2 subagents · 1 tasks · 4 need you");
  });

  it("leaves tasks out when Delegated is off", () => {
    assert.equal(mapSummaryLine({ live: 1, subagents: 0, tasks: 5, needYou: 0 }, false), "1 live · 0 subagents · 0 need you");
  });
});

describe("sessionsSubtitle", () => {
  it("mentions delegated work only when the Delegated plugin is on", () => {
    assert.match(sessionsSubtitle(true), /delegated/i);
    assert.doesNotMatch(sessionsSubtitle(false), /delegat/i);
    assert.match(sessionsSubtitle(false), /Claude/);
    assert.match(sessionsSubtitle(false), /Codex/);
  });
});
