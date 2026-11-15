import assert from "node:assert/strict";
import test from "node:test";
import type { ClaudeLimitsSource, ClaudeStatuslineStatus } from "./delegation";
import { claudeSourceRow } from "./claude-source";

const source = (statusline: Partial<ClaudeStatuslineStatus>): ClaudeLimitsSource => ({
  statusline: { state: "not-installed", installed: false, outdated: false, settingsPath: "/home/me/.claude/settings.json", previousCommand: null, error: null, ...statusline },
  privateFallback: true,
  freshMinutes: 15,
  lastReportAt: null,
});

test("claudeSourceRow offers install, update plus remove, and remove by state", () => {
  assert.deepEqual(claudeSourceRow(null), { tag: "checking", tone: "muted", primary: null, secondary: null, detail: null });
  const fresh = claudeSourceRow(source({}));
  assert.equal(fresh.tag, "not installed");
  assert.deepEqual(fresh.primary, { label: "Install statusline", action: "install" });
  assert.equal(fresh.secondary, null);
  const outdated = claudeSourceRow(source({ state: "outdated", outdated: true, previousCommand: "~/.claude/statusline.sh" }));
  assert.equal(outdated.tag, "update available");
  assert.equal(outdated.tone, "warn");
  assert.deepEqual(outdated.primary, { label: "Update statusline", action: "install" });
  assert.deepEqual(outdated.secondary, { label: "Remove statusline", action: "uninstall" });
  assert.equal(outdated.detail, "chains ~/.claude/statusline.sh");
  const installed = claudeSourceRow(source({ state: "installed", installed: true }));
  assert.equal(installed.tone, "go");
  assert.deepEqual(installed.primary, { label: "Remove statusline", action: "uninstall" });
  assert.equal(installed.detail, null);
});

test("claudeSourceRow shows the settings error and no buttons", () => {
  const broken = claudeSourceRow(source({ error: "settings.json is not valid JSON (left untouched)" }));
  assert.equal(broken.primary, null);
  assert.equal(broken.secondary, null);
  assert.match(broken.detail ?? "", /not valid JSON/);
});
