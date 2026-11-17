import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { redactBuffer, redactSecrets, resetSecretCache, secretValues } from "../src/secrets.js";
import { readSessionName, readTranscript, readTranscriptTail, readTranscriptTailAsync } from "../src/transcript.js";

const tmp = mkdtempSync(join(tmpdir(), "cch-s2-units-"));

after(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const line = (value: unknown): string => JSON.stringify(value);

describe("secrets", () => {
  it("collects long values of secret-looking variables, longest first, once each", () => {
    const values = secretValues({
      ANTHROPIC_API_KEY: "sk-ant-aaaaaaaaaaaaaaaa",
      GITHUB_TOKEN: "ghp_bbbbbbbbbbbb",
      DB_PASSWORD: "ghp_bbbbbbbbbbbb",
      SHORT_SECRET: "tiny",
      EMPTY_TOKEN: "",
      HUB_AUTH_URL: "https://example.com/very/long/url",
      CLAUDE_CONFIG_DIR: "C:/very/long/auth/path/here",
      PLAIN_VARIABLE: "just a long ordinary value",
      MISSING_KEY: undefined,
    });
    assert.deepEqual(values, ["sk-ant-aaaaaaaaaaaaaaaa", "ghp_bbbbbbbbbbbb"]);
  });

  it("redacts every known value from text and forgets them when reset", () => {
    const previous = process.env.S2_TEST_SECRET_TOKEN;
    process.env.S2_TEST_SECRET_TOKEN = "s2-very-secret-token-value";
    try {
      resetSecretCache();
      assert.equal(redactSecrets("a s2-very-secret-token-value b s2-very-secret-token-value c"), "a [redacted] b [redacted] c");
      assert.equal(redactSecrets("nothing to hide"), "nothing to hide");
      process.env.S2_TEST_SECRET_TOKEN = "changed-secret-token-value";
      assert.equal(redactSecrets("s2-very-secret-token-value"), "[redacted]");
      resetSecretCache();
      assert.equal(redactSecrets("s2-very-secret-token-value"), "s2-very-secret-token-value");
      assert.equal(redactSecrets("changed-secret-token-value"), "[redacted]");
      const clean = Buffer.from("nothing secret here");
      assert.equal(redactBuffer(clean), clean);
      assert.equal(redactBuffer(Buffer.from("token changed-secret-token-value inside")).toString("utf8"), "token [redacted] inside");
    } finally {
      if (previous === undefined) delete process.env.S2_TEST_SECRET_TOKEN;
      else process.env.S2_TEST_SECRET_TOKEN = previous;
      resetSecretCache();
    }
  });
});

describe("session names", () => {
  it("picks the newest file of the session and ignores unreadable ones", () => {
    const dir = join(tmp, "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.json"), line({ sessionId: "s", name: "Old", nameSource: "user", updatedAt: 1 }));
    writeFileSync(join(dir, "b.json"), line({ sessionId: "s", name: "New", nameSource: "derived", updatedAt: 9 }));
    writeFileSync(join(dir, "c.json"), line({ sessionId: "s", name: "No date" }));
    writeFileSync(join(dir, "d.json"), line({ sessionId: "other", name: "Other", updatedAt: 99 }));
    writeFileSync(join(dir, "e.json"), "{ nope");
    writeFileSync(join(dir, "f.txt"), "ignored");
    assert.deepEqual(readSessionName(dir, "s"), { name: "New", nameSource: "derived" });
    assert.deepEqual(readSessionName(dir, "missing"), { name: null, nameSource: null });
    assert.deepEqual(readSessionName(join(tmp, "no-such-dir"), "s"), { name: null, nameSource: null });
    writeFileSync(join(dir, "g.json"), line({ sessionId: "late", name: "First" }));
    writeFileSync(join(dir, "h.json"), line({ sessionId: "late", name: "Second", updatedAt: 3 }));
    assert.equal(readSessionName(dir, "late").name, "Second");
  });
});

describe("transcript summary", () => {
  it("sums token usage, keeps the last context and prefers a custom title", () => {
    const file = join(tmp, "summary.jsonl");
    writeFileSync(
      file,
      [
        line({ type: "ai-title", aiTitle: "Auto" }),
        "{ broken",
        line({ type: "assistant", message: { model: "m1", usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 20 } } }),
        line({ type: "assistant", message: { model: 5, usage: { output_tokens: 3 } } }),
        line({ type: "assistant", message: { content: "no usage" } }),
        line({ type: "assistant" }),
        line({ type: "custom-title", customTitle: "Mine" }),
        line({ type: "custom-title", customTitle: 5 }),
        line({ type: "ai-title", aiTitle: 7 }),
      ].join("\n"),
    );
    assert.deepEqual(readTranscript(file), { title: "Mine", model: "m1", tokensIn: 15, tokensOut: 23, contextTokens: 0 });
    const auto = join(tmp, "auto.jsonl");
    writeFileSync(auto, line({ type: "ai-title", aiTitle: "Only auto" }));
    assert.deepEqual(readTranscript(auto), { title: "Only auto", model: null, tokensIn: null, tokensOut: null, contextTokens: null });
    assert.equal(readTranscript(null).title, null);
    assert.equal(readTranscript(join(tmp, "missing.jsonl")).model, null);
  });
});

describe("transcript tail of a large file", () => {
  it("drops the partial first line of a tail that starts mid-file, synchronously and asynchronously", async () => {
    const file = join(tmp, "big.jsonl");
    const filler = line({ type: "user", timestamp: "2026-11-01T10:00:00.000Z", message: { role: "user", content: "x".repeat(600) } });
    const rows = Array.from({ length: 1200 }, () => filler);
    rows.push(line({ type: "user", timestamp: "2026-11-01T10:01:00.000Z", message: { role: "user", content: "the last prompt" } }));
    writeFileSync(file, rows.join("\n"));
    const sync = readTranscriptTail(file, 3);
    assert.equal(sync[sync.length - 1]?.text, "the last prompt");
    assert.equal(sync.length, 3);
    const asyncEntries = await readTranscriptTailAsync(file, 3);
    assert.deepEqual(asyncEntries, sync);
    const noBreak = join(tmp, "one-line.jsonl");
    writeFileSync(noBreak, "y".repeat(600_000));
    assert.deepEqual(readTranscriptTail(noBreak), []);
    assert.deepEqual(await readTranscriptTailAsync(noBreak), []);
  });
});
