import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import express from "express";
import { s1Listen, s1Request, type S1Listening } from "./helpers/s1-env.js";
import { s2Sandbox, s2Until } from "./helpers/s2-env.js";

const box = s2Sandbox("cch-s2-usage-fail-", { HUB_DELEGATION: "1" });
const claudeDir = join(box.tmp, "claude-projects");
process.env.HUB_CLAUDE_PROJECTS_DIR = claudeDir;

const { db } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const usage = await import("../src/usage.js");
const routes = await import("../src/usage-routes.js");

let web: S1Listening;

const line = (sessionId: string): string =>
  JSON.stringify({ type: "assistant", isSidechain: false, timestamp: new Date().toISOString(), cwd: box.repoA, sessionId, message: { id: `m-${sessionId}`, model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 5 } } });

before(async () => {
  mkdirSync(join(claudeDir, "proj"), { recursive: true });
  writeFileSync(join(claudeDir, "proj", "fail-1.jsonl"), `${line("fail-session")}\n`);
  usage.setUsageCachePath(null);
  const app = express();
  app.use("/usage", routes.usageRouter());
  web = await s1Listen(app);
});

after(async () => {
  await web.close();
  if (db.open) db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const http = (method: string, path: string) => s1Request(web.base, method, path);
const errorOf = (json: unknown): string => (json as { error: string }).error;

describe("usage routes when the scan itself fails", () => {
  const original = Object.getOwnPropertyDescriptor(config, "claudeProjectsDir") as PropertyDescriptor;

  const breakScan = (): void => {
    Object.defineProperty(config, "claudeProjectsDir", {
      configurable: true,
      get() {
        throw new Error("sources unreadable");
      },
    });
  };

  const repairScan = (): void => {
    Object.defineProperty(config, "claudeProjectsDir", original);
  };

  it("serves the data while the sources are readable", async () => {
    const ok = await http("GET", "/usage?fresh=1");
    assert.equal(ok.status, 200, ok.text);
  });

  it("reports a failed scan as 500 and remembers a background failure for the next request", async () => {
    breakScan();
    try {
      usage.resetUsageCache();
      const direct = await http("GET", "/usage?days=2&fresh=1");
      assert.equal(direct.status, 500, direct.text);
      assert.equal(errorOf(direct.json), "sources unreadable");
      const directSummary = await http("GET", "/usage/summary?fresh=1");
      assert.equal(directSummary.status, 500, directSummary.text);

      routes.warmUsage();
      const failed = await s2Until(async () => {
        const res = await http("GET", "/usage?days=7");
        return res.status === 500 ? res : null;
      }, 20_000);
      assert.equal(errorOf(failed.json), "sources unreadable");

      routes.warmUsage();
      const summaryFailed = await s2Until(async () => {
        const res = await http("GET", "/usage/summary");
        return res.status === 500 ? res : null;
      }, 20_000);
      assert.equal(errorOf(summaryFailed.json), "sources unreadable");

      const rescan = await http("POST", "/usage/rescan");
      assert.equal(rescan.status, 500, rescan.text);
      assert.equal(errorOf(rescan.json), "sources unreadable");
    } finally {
      repairScan();
    }
  });

  it("recovers once the sources are readable again", async () => {
    const res = await s2Until(async () => {
      const answer = await http("GET", "/usage?days=7");
      return answer.status === 200 ? answer : null;
    }, 20_000);
    assert.equal(res.status, 200);
  });
});
