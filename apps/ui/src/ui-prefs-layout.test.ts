import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { layoutSize, mergeLayoutPatch, withLayoutSize, type UiLayout } from "./ui-prefs-layout";

const layout: UiLayout = { today: { backlog: 380 }, note: { side: 300, other: 120 } };

describe("layoutSize", () => {
  it("reads a saved size", () => {
    assert.equal(layoutSize(layout, "today", "backlog", 360), 380);
  });

  it("falls back when layout, screen or key are missing", () => {
    assert.equal(layoutSize(undefined, "today", "backlog", 360), 360);
    assert.equal(layoutSize(layout, "usage", "backlog", 360), 360);
    assert.equal(layoutSize(layout, "today", "missing", 360), 360);
  });

  it("falls back for invalid stored values", () => {
    assert.equal(layoutSize({ today: { backlog: Number.NaN } }, "today", "backlog", 360), 360);
    assert.equal(layoutSize({ today: { backlog: -5 } }, "today", "backlog", 360), 360);
    assert.equal(layoutSize({ today: { backlog: "300" as unknown as number } }, "today", "backlog", 360), 360);
  });

  it("does not read inherited properties", () => {
    assert.equal(layoutSize({}, "constructor", "name", 100), 100);
    assert.equal(layoutSize(layout, "today", "toString", 100), 100);
  });
});

describe("withLayoutSize", () => {
  it("builds a patch for one screen and keeps its other sizes", () => {
    assert.deepEqual(withLayoutSize(layout, "note", "side", 320), { layout: { note: { side: 320, other: 120 } } });
  });

  it("builds a patch for a screen that is not saved yet", () => {
    assert.deepEqual(withLayoutSize(undefined, "session", "drawer", 640.4), { layout: { session: { drawer: 640 } } });
  });

  it("does not touch other screens", () => {
    assert.deepEqual(Object.keys(withLayoutSize(layout, "note", "side", 320).layout), ["note"]);
  });

  it("does not mutate the input", () => {
    const before = JSON.stringify(layout);
    withLayoutSize(layout, "note", "side", 320);
    assert.equal(JSON.stringify(layout), before);
  });

  it("keeps the existing sizes for an invalid size", () => {
    assert.deepEqual(withLayoutSize(layout, "today", "backlog", Number.NaN), { layout: { today: { backlog: 380 } } });
  });
});

describe("mergeLayoutPatch", () => {
  it("applies a patch per screen", () => {
    const merged = mergeLayoutPatch(layout, withLayoutSize(layout, "note", "side", 320));
    assert.deepEqual(merged, { today: { backlog: 380 }, note: { side: 320, other: 120 } });
  });

  it("starts from an empty layout", () => {
    assert.deepEqual(mergeLayoutPatch(undefined, { layout: { today: { backlog: 400 } } }), { today: { backlog: 400 } });
  });
});
