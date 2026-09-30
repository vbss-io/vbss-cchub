import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampOffset,
  collapsedLength,
  dockRect,
  formatTokens,
  offsetFromPosition,
  resetCountdown,
  ringTone,
  urgencyTone,
  type Rect,
} from "./widget-layout";

const area: Rect = { x: 0, y: 0, width: 1920, height: 1040 };

describe("dockRect", () => {
  it("docks the collapsed tab centered on the left edge", () => {
    assert.deepEqual(dockRect("left", true, area, 0, 2), { x: 0, y: 439, width: 56, height: 162 });
  });

  it("docks the collapsed tab centered on the right edge", () => {
    assert.deepEqual(dockRect("right", true, area, 0, 2), { x: 1864, y: 439, width: 56, height: 162 });
  });

  it("docks the collapsed tab centered on the top edge", () => {
    assert.deepEqual(dockRect("top", true, area, 0, 2), { x: 879, y: 0, width: 162, height: 56 });
  });

  it("anchors the expanded panel to the left edge, vertically centered", () => {
    assert.deepEqual(dockRect("left", false, area, 0), { x: 0, y: 210, width: 440, height: 620 });
  });

  it("anchors the expanded panel to the right edge, vertically centered", () => {
    assert.deepEqual(dockRect("right", false, area, 0), { x: 1480, y: 210, width: 440, height: 620 });
  });

  it("anchors the expanded panel to the top edge, horizontally centered", () => {
    assert.deepEqual(dockRect("top", false, area, 0), { x: 650, y: 0, width: 620, height: 440 });
  });

  it("respects a work area that does not start at the origin and excludes the taskbar", () => {
    const offsetArea: Rect = { x: 1920, y: 40, width: 1600, height: 900 };
    assert.deepEqual(dockRect("right", true, offsetArea, 0, 2), { x: 3464, y: 409, width: 56, height: 162 });
    assert.deepEqual(dockRect("top", false, offsetArea, 0), { x: 2410, y: 40, width: 620, height: 440 });
  });

  it("shifts the collapsed tab along the edge and clamps it inside the work area", () => {
    assert.equal(dockRect("left", true, area, 100, 2).y, 539);
    assert.equal(dockRect("left", true, area, 9999, 2).y, 1040 - 162);
    assert.equal(dockRect("left", true, area, -9999, 2).y, 0);
    assert.equal(dockRect("top", true, area, -200, 2).x, 679);
    assert.equal(dockRect("top", true, area, 99999, 2).x, 1920 - 162);
  });

  it("keeps the expanded panel centered regardless of the offset", () => {
    assert.deepEqual(dockRect("right", false, area, 300), dockRect("right", false, area, 0));
  });

  it("shrinks the expanded panel to fit a small work area", () => {
    const small: Rect = { x: 0, y: 0, width: 300, height: 400 };
    assert.deepEqual(dockRect("left", false, small, 0), { x: 0, y: 0, width: 300, height: 400 });
  });
});

describe("collapsed tab length", () => {
  it("grows with the number of rings", () => {
    assert.equal(collapsedLength(0), 70);
    assert.equal(collapsedLength(1), 116);
    assert.equal(collapsedLength(2), 162);
  });

  it("ignores a negative or non-finite ring count", () => {
    assert.equal(collapsedLength(-3), 70);
    assert.equal(collapsedLength(Number.NaN), 70);
  });

  it("shrinks the docked window to the tab for every ring count", () => {
    assert.deepEqual(dockRect("right", true, area, 0, 0), { x: 1864, y: 485, width: 56, height: 70 });
    assert.deepEqual(dockRect("right", true, area, 0, 1), { x: 1864, y: 462, width: 56, height: 116 });
    assert.deepEqual(dockRect("top", true, area, 0, 1), { x: 902, y: 0, width: 116, height: 56 });
    assert.deepEqual(dockRect("left", true, area, 0, 0), { x: 0, y: 485, width: 56, height: 70 });
  });

  it("keeps the expanded panel independent of the ring count", () => {
    assert.deepEqual(dockRect("right", false, area, 0, 0), dockRect("right", false, area, 0, 2));
  });
});

describe("offsets", () => {
  it("clamps offsets to half the slack along the edge", () => {
    assert.equal(clampOffset("right", area, 1000, 2), 439);
    assert.equal(clampOffset("right", area, -1000, 2), -439);
    assert.equal(clampOffset("top", area, 50.4, 2), 50);
  });

  it("never lets the tab cross the work area edge when the slack is odd", () => {
    const odd: Rect = { x: 0, y: 30, width: 1919, height: 1039 };
    assert.equal(clampOffset("left", odd, 9999, 2), 438);
    assert.equal(clampOffset("left", odd, -9999, 2), -438);
    for (const offset of [-9999, -1, 0, 1, 9999]) {
      const side = dockRect("left", true, odd, offset, 2);
      assert.ok(side.y >= odd.y && side.y + side.height <= odd.y + odd.height);
      const top = dockRect("top", true, odd, offset, 2);
      assert.ok(top.x >= odd.x && top.x + top.width <= odd.x + odd.width);
    }
  });

  it("recovers the offset from a dropped window position", () => {
    const dropped = dockRect("right", true, area, 120, 2);
    assert.equal(offsetFromPosition("right", area, { x: dropped.x - 400, y: dropped.y }, 2), 120);
    const top = dockRect("top", true, area, -300, 2);
    assert.equal(offsetFromPosition("top", area, { x: top.x, y: 250 }, 2), -300);
    assert.equal(offsetFromPosition("left", area, { x: 0, y: 5000 }, 2), 439);
  });
});

describe("ringTone", () => {
  it("is go below 70 percent", () => {
    assert.equal(ringTone(0), "go");
    assert.equal(ringTone(69.9), "go");
  });

  it("is pend from 70 up to 90 percent", () => {
    assert.equal(ringTone(70), "pend");
    assert.equal(ringTone(90), "pend");
  });

  it("is hold above 90 percent", () => {
    assert.equal(ringTone(90.1), "hold");
    assert.equal(ringTone(100), "hold");
  });

  it("falls back to go for a non-finite value", () => {
    assert.equal(ringTone(Number.NaN), "go");
  });
});

describe("urgencyTone", () => {
  it("prioritises needing you, then delegated, then live, then muted", () => {
    assert.equal(urgencyTone({ needYou: 1, delegated: 3, live: 5 }), "hold");
    assert.equal(urgencyTone({ needYou: 0, delegated: 2, live: 5 }), "pend");
    assert.equal(urgencyTone({ needYou: 0, delegated: 0, live: 2 }), "go");
    assert.equal(urgencyTone({ needYou: 0, delegated: 0, live: 0 }), "muted");
  });
});

describe("formatting", () => {
  it("counts down to a reset from seconds or milliseconds", () => {
    const now = Date.UTC(2026, 8, 30, 12, 0, 0);
    assert.equal(resetCountdown(null, now), null);
    assert.equal(resetCountdown(now + 30_000, now), "now");
    assert.equal(resetCountdown(now + 45 * 60_000, now), "45m");
    assert.equal(resetCountdown(Math.round((now + 135 * 60_000) / 1000), now), "2h 15m");
    assert.equal(resetCountdown(now + 3 * 86_400_000 + 4 * 3_600_000, now), "3d 4h");
    assert.equal(resetCountdown(now - 1000, now), "now");
  });

  it("abbreviates token counts", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(842), "842");
    assert.equal(formatTokens(1234), "1.2k");
    assert.equal(formatTokens(48_200), "48k");
    assert.equal(formatTokens(3_400_000), "3.4M");
    assert.equal(formatTokens(2_500_000_000), "2.5B");
  });
});
