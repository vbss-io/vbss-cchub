import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { applyUiPrefsPatch, emptyUiPrefs, normalizeUiPrefs } from "./plugins/ui-prefs";
import { parseSidebarHint, railItemTitle, resolveSidebarCollapsed, SHELL_PREFS_SCREEN, SIDEBAR_COLLAPSED_KEY, sidebarHintValue, sidebarToggleLabel, storedSidebarCollapsed, withSidebarCollapsed } from "./shell-sidebar";

describe("sidebar collapsed pref", () => {
  it("reads the collapsed flag from the shell layout screen", () => {
    assert.equal(storedSidebarCollapsed(undefined), null);
    assert.equal(storedSidebarCollapsed({}), null);
    assert.equal(storedSidebarCollapsed({ shell: {} }), null);
    assert.equal(storedSidebarCollapsed({ shell: { sidebarCollapsed: 1 } }), true);
    assert.equal(storedSidebarCollapsed({ shell: { sidebarCollapsed: 0 } }), false);
    assert.equal(storedSidebarCollapsed({ shell: { sidebarCollapsed: 7 } }), false);
  });

  it("writes a layout patch the server accepts, keeping other shell keys", () => {
    assert.deepEqual(withSidebarCollapsed(undefined, true), { layout: { shell: { sidebarCollapsed: 1 } } });
    assert.deepEqual(withSidebarCollapsed({ shell: { other: 3 }, today: { focus: 400 } }, false), { layout: { shell: { other: 3, sidebarCollapsed: 0 } } });
    assert.match(SHELL_PREFS_SCREEN, /^[a-z][a-z0-9-]{0,31}$/);
    assert.match(SIDEBAR_COLLAPSED_KEY, /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/);
  });

  it("toggles through the ui prefs patch and survives a server round trip", () => {
    const collapsed = applyUiPrefsPatch(emptyUiPrefs(), withSidebarCollapsed(emptyUiPrefs().layout, true));
    assert.equal(storedSidebarCollapsed(normalizeUiPrefs(JSON.parse(JSON.stringify(collapsed))).layout), true);
    const expanded = applyUiPrefsPatch(collapsed, withSidebarCollapsed(collapsed.layout, false));
    assert.equal(storedSidebarCollapsed(expanded.layout), false);
  });

  it("prefers the server value and falls back to the local hint", () => {
    assert.equal(resolveSidebarCollapsed({ shell: { sidebarCollapsed: 1 } }, false), true);
    assert.equal(resolveSidebarCollapsed({ shell: { sidebarCollapsed: 0 } }, true), false);
    assert.equal(resolveSidebarCollapsed({}, true), true);
    assert.equal(resolveSidebarCollapsed(undefined, false), false);
  });

  it("parses the local hint strictly", () => {
    assert.equal(parseSidebarHint("1"), true);
    assert.equal(parseSidebarHint("0"), false);
    assert.equal(parseSidebarHint("true"), false);
    assert.equal(parseSidebarHint(null), false);
    assert.equal(parseSidebarHint(sidebarHintValue(true)), true);
    assert.equal(parseSidebarHint(sidebarHintValue(false)), false);
  });
});

describe("sidebar rail labels", () => {
  it("names the toggle by the action it performs", () => {
    assert.equal(sidebarToggleLabel(false), "Collapse sidebar");
    assert.equal(sidebarToggleLabel(true), "Expand sidebar");
  });

  it("puts the badge count in the rail tooltip", () => {
    assert.equal(railItemTitle("Sessions", 3), "Sessions (3)");
    assert.equal(railItemTitle("Flow", 0), "Flow");
  });
});
