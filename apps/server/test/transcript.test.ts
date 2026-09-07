import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { guessTranscriptPath } from "../src/live.js";
import { readTranscript, readTranscriptTail, readTranscriptTailAsync } from "../src/transcript.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("transcript tail", () => {
  it("turns the JSONL into a readable timeline of prompts, answers, tool calls and results", () => {
    const entries = readTranscriptTail(join(fixtures, "transcript-sample.jsonl"));
    assert.deepEqual(
      entries.map((entry) => [entry.role, entry.tool, entry.text]),
      [
        ["user", null, "Fix the flaky test"],
        ["assistant", null, "Looking at the test."],
        ["tool", "Grep", "flaky"],
        ["result", null, "3 matches"],
        ["assistant", null, "Done: patched the retry."],
      ],
    );
    assert.equal(entries[0]?.at, Date.parse("2026-09-05T10:00:00.000Z"));
  });

  it("honours the limit and tolerates missing files", () => {
    assert.equal(readTranscriptTail(join(fixtures, "transcript-sample.jsonl"), 2).length, 2);
    assert.deepEqual(readTranscriptTail(join(fixtures, "nope.jsonl")), []);
    assert.deepEqual(readTranscriptTail(null), []);
  });

  it("reads the same tail without blocking the event loop", async () => {
    const sync = readTranscriptTail(join(fixtures, "transcript-sample.jsonl"), 3);
    assert.deepEqual(await readTranscriptTailAsync(join(fixtures, "transcript-sample.jsonl"), 3), sync);
    assert.deepEqual(await readTranscriptTailAsync(join(fixtures, "nope.jsonl")), []);
    assert.deepEqual(await readTranscriptTailAsync(null), []);
  });

  it("reads subagent transcripts the same way", () => {
    const entries = readTranscriptTail(join(fixtures, "agent-sample.jsonl"));
    assert.deepEqual(
      entries.map((entry) => [entry.role, entry.tool ?? entry.text]),
      [
        ["user", "Count the .cjs files"],
        ["tool", "Glob"],
        ["assistant", "8"],
      ],
    );
  });
});

describe("transcript title", () => {
  it("prefers a /rename custom-title over the ai-title", () => {
    const info = readTranscript(join(fixtures, "transcript-title-sample.jsonl"));
    assert.equal(info.title, "User renamed this");
    assert.equal(info.model, "claude-x");
  });

  it("falls back to the ai-title when there is no custom-title", () => {
    const dir = mkdtempSync(join(tmpdir(), "cch-title-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "ai-title", aiTitle: "Only AI" })}\n`);
    assert.equal(readTranscript(file).title, "Only AI");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("transcript path fallback", () => {
  it("finds the Claude Code transcript from the cwd when the hook never sent a path", () => {
    const home = mkdtempSync(join(tmpdir(), "cch-tp-"));
    const dir = join(home, ".claude", "projects", "C--Users-me-Projetos--workspaces-vbss");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "abc.jsonl"), "");
    assert.equal(guessTranscriptPath(home, "C:\\Users\\me\\Projetos\\.workspaces\\vbss", "abc"), join(dir, "abc.jsonl"));
    assert.equal(guessTranscriptPath(home, "C:\\Users\\me\\Other", "abc"), null);
    assert.equal(guessTranscriptPath(home, null, "abc"), null);
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});
