import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { appendHubSource, brainToday, diaryPath, localDate } from "../src/second-brain.js";

const root = mkdtempSync(join(tmpdir(), "cch-brain-"));
const today = localDate();

describe("second brain link", () => {
  it("finds the diary in the root or in the archived month folder", () => {
    mkdirSync(join(root, "diario", "2026-01"), { recursive: true });
    writeFileSync(join(root, "diario", "2026-01", "2026-01-15.md"), "# old");
    writeFileSync(join(root, "diario", `${today}.md`), "# today\n\n## Foco de hoje\n- [ ] ship");
    assert.equal(diaryPath(root, "2026-01-15"), join(root, "diario", "2026-01", "2026-01-15.md"));
    assert.equal(diaryPath(root, today), join(root, "diario", `${today}.md`));
    assert.equal(diaryPath(root, "1999-01-01"), null);
  });

  it("appends hub events to a dated source file with frontmatter", () => {
    const path = appendHubSource(root, "task delegated · vbss · fix\nmultiline", new Date(2026, 8, 5, 9, 7));
    appendHubSource(root, "report result · done", new Date(2026, 8, 5, 9, 8));
    const text = readFileSync(path, "utf8");
    assert.match(text, /^---\ntype: fonte\n/);
    assert.match(text, /# Hub — 2026-09-05/);
    assert.match(text, /- 09:07 · task delegated · vbss · fix multiline\n- 09:08 · report result · done\n$/);
  });

  it("returns today's diary, hub source and session trail", () => {
    mkdirSync(join(root, "fontes", "sessions"), { recursive: true });
    writeFileSync(join(root, "fontes", "sessions", `${today}.md`), "# Sessions");
    appendHubSource(root, "hello");
    const brain = brainToday(root);
    assert.equal(brain.date, today);
    assert.match(brain.diary ?? "", /Foco de hoje/);
    assert.match(brain.hub ?? "", /hello/);
    assert.match(brain.sessions ?? "", /Sessions/);
    assert.ok(existsSync(brain.hubPath ?? ""));
  });
});

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
