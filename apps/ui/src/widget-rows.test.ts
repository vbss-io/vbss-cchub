import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SessionRecord, SessionStatus } from "./types";
import { compactRect, type Rect } from "./widget-layout";
import {
  IDLE_ROW_LIMIT,
  elapsedLabel,
  gaugeResetText,
  headline,
  moreLabel,
  periodLabel,
  planSections,
  sessionRowMeta,
  taskRowMeta,
  tokenLine,
  widgetSurface,
} from "./widget-model";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

const session = (status: SessionStatus, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: "s",
  status,
  cwd: null,
  source: null,
  hostPid: null,
  title: "s",
  customTitle: null,
  lastMessage: null,
  model: null,
  tokensIn: null,
  tokensOut: null,
  contextTokens: null,
  archivedAt: null,
  favoriteAt: null,
  unread: false,
  startedAt: NOW - 30 * MIN,
  updatedAt: NOW - 4 * MIN,
  ...extra,
});

describe("widgetSurface", () => {
  it("waits for the settings before deciding", () => {
    assert.equal(widgetSurface({ loaded: false, enabled: false }), "connecting");
    assert.equal(widgetSurface({ loaded: false, enabled: true }), "connecting");
  });

  it("shows the off panel instead of an empty window when the Widget plugin is off", () => {
    assert.equal(widgetSurface({ loaded: true, enabled: false }), "off");
  });

  it("renders the widget when the plugin is on", () => {
    assert.equal(widgetSurface({ loaded: true, enabled: true }), "on");
  });
});

describe("compactRect", () => {
  const area: Rect = { x: 0, y: 0, width: 1920, height: 1040 };

  it("docks the off panel on the right edge, vertically centered, as wide as the widget panel", () => {
    assert.deepEqual(compactRect("right", area), { x: 1480, y: 432, width: 440, height: 176 });
  });

  it("docks it on the left and top edges too", () => {
    assert.deepEqual(compactRect("left", area), { x: 0, y: 432, width: 440, height: 176 });
    assert.deepEqual(compactRect("top", area), { x: 740, y: 0, width: 440, height: 176 });
  });

  it("never exceeds a tiny work area", () => {
    assert.deepEqual(compactRect("right", { x: 100, y: 50, width: 300, height: 120 }), { x: 100, y: 50, width: 300, height: 120 });
  });
});

describe("elapsedLabel", () => {
  it("keeps the compact minute and hour format and clamps the future", () => {
    assert.equal(elapsedLabel(-5 * MIN), "just now");
    assert.equal(elapsedLabel(30_000), "just now");
    assert.equal(elapsedLabel(7 * MIN), "7m");
    assert.equal(elapsedLabel(60 * MIN), "1h");
    assert.equal(elapsedLabel(66 * MIN), "1h6m");
    assert.equal(elapsedLabel(50 * 60 * MIN), "2d");
  });
});

describe("sessionRowMeta", () => {
  it("says why a session needs you, with how long ago", () => {
    assert.deepEqual(sessionRowMeta(session("waiting"), 0, NOW), { text: "needs input · 4m", extras: [] });
    assert.deepEqual(sessionRowMeta(session("idle", { unread: true }), 0, NOW), { text: "finished · 4m", extras: [] });
  });

  it("shows how long a running session has been running and an idle one has been quiet", () => {
    assert.equal(sessionRowMeta(session("active"), 0, NOW).text, "running · 30m");
    assert.equal(sessionRowMeta(session("idle"), 0, NOW).text, "4m");
  });

  it("folds subagents and peers into +N extras instead of chips", () => {
    const meta = sessionRowMeta(session("active", { agentsRunning: 2, agentsTotal: 5 }), 3, NOW);
    assert.deepEqual(meta.extras, ["2 subagents running · 5 spawned", "3 more here: other live agents share this folder"]);
    assert.equal(moreLabel(meta.extras), "+2");
    assert.deepEqual(sessionRowMeta(session("active", { agentsRunning: 1 }), 0, NOW).extras, ["1 subagent running · 1 spawned"]);
  });
});

describe("taskRowMeta", () => {
  const task = (status: Parameters<typeof taskRowMeta>[0]["status"]) => ({ status, createdAt: NOW - 12 * MIN, updatedAt: NOW - 3 * MIN });

  it("names the attention reason with its age", () => {
    assert.equal(taskRowMeta(task("attention"), null, NOW).text, "needs you · 3m");
    assert.equal(taskRowMeta(task("failed"), null, NOW).text, "failed · 3m");
    assert.equal(taskRowMeta(task("interrupted"), null, NOW).text, "interrupted · 3m");
  });

  it("counts a running task from its start and keeps the worktree branch as plain text", () => {
    assert.deepEqual(taskRowMeta(task("running"), "hub/458d7ac8", NOW), { text: "running · 12m · hub/458d7ac8", extras: [] });
    assert.equal(taskRowMeta(task("pending"), null, NOW).text, "queued");
  });

  it("dates a finished task by its last update", () => {
    assert.equal(taskRowMeta(task("completed"), null, NOW).text, "done · 3m");
  });
});

describe("planSections", () => {
  const counts = { needs: 2, running: 1, idle: 11, delegated: 2, done: 1 };

  it("puts Needs you first and keeps the fixed order", () => {
    assert.deepEqual(
      planSections(counts, true).map((section) => section.label),
      ["Needs you", "Running", "Idle", "Delegated", "Recently done"],
    );
  });

  it("shows at most eight idle rows and counts the rest as more", () => {
    const idle = planSections(counts, true).find((section) => section.key === "idle");
    assert.deepEqual(idle, { key: "idle", label: "Idle", count: 11, shown: IDLE_ROW_LIMIT, more: 3 });
    assert.equal(IDLE_ROW_LIMIT, 8);
  });

  it("hides Delegated and Recently done while the Delegated plugin is off", () => {
    assert.deepEqual(
      planSections(counts, false).map((section) => section.key),
      ["needs", "running", "idle"],
    );
  });

  it("drops empty sections so an idle machine reads as all quiet", () => {
    assert.deepEqual(planSections({ needs: 0, running: 0, idle: 0, delegated: 0, done: 0 }, true), []);
  });
});

describe("moreLabel and headline", () => {
  it("returns null without extras", () => {
    assert.equal(moreLabel([]), null);
  });

  it("keeps the compact header wording", () => {
    assert.equal(headline({ live: 3, idle: 10, needYou: 4 }), "3 live · 10 idle · 4 need you");
  });
});

describe("usage wording", () => {
  it("matches the Usage screen labels", () => {
    assert.equal(tokenLine(1500, 320), "Read 1.5k · Output 320");
    assert.equal(periodLabel(7), "Last 7 days");
  });

  it("uses the Usage screen reset text", () => {
    assert.equal(gaugeResetText(NOW + 90 * MIN, NOW, "fiveHour"), "resets in 1h 30m");
    assert.equal(gaugeResetText(null, NOW, "fiveHour"), "");
    assert.equal(gaugeResetText(null, NOW, "sevenDay", true), "reset time unknown");
    assert.equal(gaugeResetText(NOW + 30 * 86_400_000, NOW, "sevenDay"), "reset time unknown");
  });
});
