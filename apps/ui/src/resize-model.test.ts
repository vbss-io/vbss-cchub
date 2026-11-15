import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampSize,
  drawerReserve,
  effectiveMax,
  isStacked,
  KEY_STEP,
  KEY_STEP_LARGE,
  keyboardSize,
  resetSize,
  sharedSplitBounds,
  SPLIT_SIDE_MIN,
  splitSideMin,
  sizeFromDelta,
} from "./resize-model";

describe("clampSize", () => {
  it("keeps values inside the range", () => {
    assert.equal(clampSize(300, 200, 500), 300);
  });

  it("clamps below the minimum and above the maximum", () => {
    assert.equal(clampSize(50, 200, 500), 200);
    assert.equal(clampSize(900, 200, 500), 500);
  });

  it("rounds to whole pixels", () => {
    assert.equal(clampSize(300.6, 200, 500), 301);
  });

  it("falls back to the minimum for non finite input", () => {
    assert.equal(clampSize(Number.NaN, 200, 500), 200);
    assert.equal(clampSize(Number.POSITIVE_INFINITY, 200, 500), 200);
  });

  it("never returns less than the minimum when max is smaller", () => {
    assert.equal(clampSize(300, 400, 100), 400);
  });
});

describe("drawerReserve", () => {
  it("reserves the measured sidebar plus the main column in the panel grid", () => {
    assert.equal(drawerReserve(true, 232), 472);
    assert.equal(drawerReserve(true, 56), 296);
    assert.equal(drawerReserve(true, 56.4), 296);
  });

  it("lets the drawer grow 176 px wider with the collapsed rail", () => {
    assert.equal(effectiveMax(380, 1000, 1280, drawerReserve(true, 56)) - effectiveMax(380, 1000, 1280, drawerReserve(true, 232)), 176);
  });

  it("falls back to the full sidebar when the sidebar is not measured", () => {
    assert.equal(drawerReserve(true, null), 472);
    assert.equal(drawerReserve(true, 0), 472);
    assert.equal(drawerReserve(true, Number.NaN), 472);
  });

  it("keeps the viewport reserve outside the panel grid", () => {
    assert.equal(drawerReserve(false, 56), 96);
    assert.equal(drawerReserve(false, null), 96);
  });
});

describe("effectiveMax", () => {
  it("leaves room for the other pane", () => {
    assert.equal(effectiveMax(200, 800, 700, 240), 460);
  });

  it("is capped by the declared maximum", () => {
    assert.equal(effectiveMax(200, 400, 1600, 240), 400);
  });

  it("never drops below the minimum", () => {
    assert.equal(effectiveMax(200, 800, 300, 240), 200);
  });

  it("ignores an unmeasured container", () => {
    assert.equal(effectiveMax(200, 800, 0, 240), 800);
  });
});

describe("sizeFromDelta", () => {
  it("grows the start panel when dragging right", () => {
    assert.equal(sizeFromDelta(300, 40, "start", 200, 500), 340);
  });

  it("shrinks the start panel when dragging left", () => {
    assert.equal(sizeFromDelta(300, -40, "start", 200, 500), 260);
  });

  it("grows the end panel when dragging left", () => {
    assert.equal(sizeFromDelta(300, -40, "end", 200, 500), 340);
  });

  it("shrinks the end panel when dragging right", () => {
    assert.equal(sizeFromDelta(300, 40, "end", 200, 500), 260);
  });

  it("clamps at both limits", () => {
    assert.equal(sizeFromDelta(300, 900, "start", 200, 500), 500);
    assert.equal(sizeFromDelta(300, -900, "start", 200, 500), 200);
    assert.equal(sizeFromDelta(300, -900, "end", 200, 500), 500);
    assert.equal(sizeFromDelta(300, 900, "end", 200, 500), 200);
  });
});

describe("keyboardSize", () => {
  it("moves the divider right by the small step", () => {
    assert.equal(keyboardSize(300, "ArrowRight", false, "start", 200, 500), 300 + KEY_STEP);
    assert.equal(keyboardSize(300, "ArrowLeft", false, "start", 200, 500), 300 - KEY_STEP);
  });

  it("uses the large step with shift", () => {
    assert.equal(keyboardSize(300, "ArrowRight", true, "start", 200, 500), 300 + KEY_STEP_LARGE);
    assert.equal(keyboardSize(300, "ArrowLeft", true, "start", 200, 500), 300 - KEY_STEP_LARGE);
  });

  it("inverts the direction for the end panel", () => {
    assert.equal(keyboardSize(300, "ArrowLeft", false, "end", 200, 500), 300 + KEY_STEP);
    assert.equal(keyboardSize(300, "ArrowRight", false, "end", 200, 500), 300 - KEY_STEP);
  });

  it("jumps to the limits with Home and End", () => {
    assert.equal(keyboardSize(300, "Home", false, "start", 200, 500), 200);
    assert.equal(keyboardSize(300, "End", false, "start", 200, 500), 500);
    assert.equal(keyboardSize(300, "Home", false, "end", 200, 500), 200);
    assert.equal(keyboardSize(300, "End", false, "end", 200, 500), 500);
  });

  it("clamps steps at the limits", () => {
    assert.equal(keyboardSize(495, "ArrowRight", true, "start", 200, 500), 500);
    assert.equal(keyboardSize(205, "ArrowLeft", true, "start", 200, 500), 200);
  });

  it("ignores other keys", () => {
    assert.equal(keyboardSize(300, "ArrowUp", false, "start", 200, 500), null);
    assert.equal(keyboardSize(300, "Enter", false, "start", 200, 500), null);
  });
});

describe("resetSize", () => {
  it("returns the default inside the range", () => {
    assert.equal(resetSize(360, 200, 500), 360);
  });

  it("clamps a default outside the range", () => {
    assert.equal(resetSize(900, 200, 500), 500);
  });
});

describe("isStacked", () => {
  it("stacks below the breakpoint only", () => {
    assert.equal(isStacked(899, 900), true);
    assert.equal(isStacked(900, 900), false);
    assert.equal(isStacked(390, 900), true);
  });
});

describe("shared split bounds", () => {
  it("keeps each side at least 240 px on a wide container and lets the sized side take the rest", () => {
    assert.deepEqual(sharedSplitBounds(1400), { min: 240, max: 1159 });
    const right = clampSize(1000, sharedSplitBounds(1400).min, sharedSplitBounds(1400).max);
    assert.equal(right > 1400 - right, true);
  });

  it("drops the minimum to 20% of the container when 240 px each side does not fit", () => {
    assert.equal(splitSideMin(800), 160);
    assert.deepEqual(sharedSplitBounds(800), { min: 160, max: 639 });
    assert.equal(splitSideMin(2000), 240);
  });

  it("clamps a stored width outside the range instead of rejecting it", () => {
    const { min, max } = sharedSplitBounds(1000);
    assert.equal(clampSize(4000, min, max), max);
    assert.equal(clampSize(20, min, max), min);
    assert.equal(clampSize(Number.NaN, min, max), min);
  });

  it("uses a wide cap before the container is measured so a stored width is not cut on first paint", () => {
    assert.deepEqual(sharedSplitBounds(0), { min: SPLIT_SIDE_MIN, max: 4000 });
    assert.equal(clampSize(900, sharedSplitBounds(0).min, sharedSplitBounds(0).max), 900);
  });
});
