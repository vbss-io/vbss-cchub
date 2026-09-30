import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampOffset,
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
    assert.deepEqual(dockRect("left", true, area, 0), { x: 0, y: 454, width: 28, height: 132 });
  });

  it("docks the collapsed tab centered on the right edge", () => {
    assert.deepEqual(dockRect("right", true, area, 0), { x: 1892, y: 454, width: 28, height: 132 });
  });

  it("docks the collapsed tab centered on the top edge", () => {
    assert.deepEqual(dockRect("top", true, area, 0), { x: 894, y: 0, width: 132, height: 28 });
  });

  it("anchors the expanded panel to the left edge, vertically centered", () => {
    assert.deepEqual(dockRect("left", false, area, 0), { x: 0, y: 260, width: 340, height: 520 });
  });

  it("anchors the expanded panel to the right edge, vertically centered", () => {
    assert.deepEqual(dockRect("right", false, area, 0), { x: 1580, y: 260, width: 340, height: 520 });
  });

  it("anchors the expanded panel to the top edge, horizontally centered", () => {
    assert.deepEqual(dockRect("top", false, area, 0), { x: 700, y: 0, width: 520, height: 340 });
  });

  it("respects a work area that does not start at the origin and excludes the taskbar", () => {
    const offsetArea: Rect = { x: 1920, y: 40, width: 1600, height: 900 };
    assert.deepEqual(dockRect("right", true, offsetArea, 0), { x: 3492, y: 424, width: 28, height: 132 });
    assert.deepEqual(dockRect("top", false, offsetArea, 0), { x: 2460, y: 40, width: 520, height: 340 });
  });

  it("shifts the collapsed tab along the edge and clamps it inside the work area", () => {
    assert.equal(dockRect("left", true, area, 100).y, 554);
    assert.equal(dockRect("left", true, area, 9999).y, 1040 - 132);
    assert.equal(dockRect("left", true, area, -9999).y, 0);
    assert.equal(dockRect("top", true, area, -200).x, 694);
    assert.equal(dockRect("top", true, area, 99999).x, 1920 - 132);
  });

  it("keeps the expanded panel centered regardless of the offset", () => {
    assert.deepEqual(dockRect("right", false, area, 300), dockRect("right", false, area, 0));
  });

  it("shrinks the expanded panel to fit a small work area", () => {
    const small: Rect = { x: 0, y: 0, width: 300, height: 400 };
    assert.deepEqual(dockRect("left", false, small, 0), { x: 0, y: 0, width: 300, height: 400 });
  });
});

describe("offsets", () => {
  it("clamps offsets to half the slack along the edge", () => {
    assert.equal(clampOffset("right", area, 1000), 454);
    assert.equal(clampOffset("right", area, -1000), -454);
    assert.equal(clampOffset("top", area, 50.4), 50);
  });

  it("never lets the tab cross the work area edge when the slack is odd", () => {
    const odd: Rect = { x: 0, y: 30, width: 1919, height: 1039 };
    assert.equal(clampOffset("left", odd, 9999), 453);
    assert.equal(clampOffset("left", odd, -9999), -453);
    for (const offset of [-9999, -1, 0, 1, 9999]) {
      const side = dockRect("left", true, odd, offset);
      assert.ok(side.y >= odd.y && side.y + side.height <= odd.y + odd.height);
      const top = dockRect("top", true, odd, offset);
      assert.ok(top.x >= odd.x && top.x + top.width <= odd.x + odd.width);
    }
  });

  it("recovers the offset from a dropped window position", () => {
    const dropped = dockRect("right", true, area, 120);
    assert.equal(offsetFromPosition("right", area, { x: dropped.x - 400, y: dropped.y }), 120);
    const top = dockRect("top", true, area, -300);
    assert.equal(offsetFromPosition("top", area, { x: top.x, y: 250 }), -300);
    assert.equal(offsetFromPosition("left", area, { x: 0, y: 5000 }), 454);
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
