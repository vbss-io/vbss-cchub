import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { HookPayload } from "../src/types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-claims-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;

type Db = typeof import("../src/db.js");
let db: Db;

const sessionPayload = (sessionId: string, title: string): HookPayload => ({
  kind: "session_start",
  sessionId,
  cwd: "C:\\work\\repo-a",
  source: "host",
  hostPid: null,
  shellPid: null,
  title,
  message: null,
  notificationType: null,
  model: null,
  tokensIn: null,
  tokensOut: null,
  contextTokens: null,
  agentId: null,
  agentType: null,
  client: null,
  claudePid: null,
  transcriptPath: null,
  agentMessage: null,
  shareLabel: null,
});

before(async () => {
  db = await import("../src/db.js");
});

describe("claims", () => {
  it("creates a claim with the default TTL and resolves the session title at read time", () => {
    db.applyHook(sessionPayload("sess-a", "editing the parser"));
    const claim = db.createClaim({ sessionId: "sess-a", repoPath: "C:\\work\\repo-a", paths: [" src/a.ts ", "src/b.ts"], note: " careful here " });
    assert.equal(claim.sessionTitle, "editing the parser");
    assert.deepEqual(claim.paths, ["src/a.ts", "src/b.ts"]);
    assert.equal(claim.note, "careful here");
    assert.equal(claim.expiresAt - claim.createdAt, 4 * 3_600_000);
  });

  it("dedupes and caps paths at 50", () => {
    const paths = [...Array(60).keys()].map((i) => `src/file-${i % 40}.ts`);
    const claim = db.createClaim({ sessionId: null, repoPath: "C:\\work\\repo-a", paths, ttlMs: 60_000 });
    assert.equal(claim.paths.length, 40);
    assert.equal(new Set(claim.paths).size, 40);
  });

  it("clamps the requested TTL to the 24h max and ignores a non-positive TTL", () => {
    const tooLong = db.createClaim({ sessionId: null, repoPath: "C:\\work\\repo-a", paths: ["src/x.ts"], ttlMs: 999 * 3_600_000 });
    assert.equal(tooLong.expiresAt - tooLong.createdAt, 24 * 3_600_000);
    const zero = db.createClaim({ sessionId: null, repoPath: "C:\\work\\repo-a", paths: ["src/y.ts"], ttlMs: 0 });
    assert.equal(zero.expiresAt - zero.createdAt, 4 * 3_600_000);
  });

  it("lists only active claims, optionally filtered by repo, and excludes expired ones", () => {
    const now = Date.now();
    const active = db.createClaim({ sessionId: null, repoPath: "C:\\work\\repo-b", paths: ["c.ts"], ttlMs: 60_000 });
    const expired = db.createClaim({ sessionId: null, repoPath: "C:\\work\\repo-b", paths: ["d.ts"], ttlMs: 60_000 });
    const listed = db.listClaims({ repoPath: "C:\\work\\repo-b", now });
    assert.ok(listed.some((claim) => claim.id === active.id));
    const excluded = db.listClaims({ repoPath: "C:\\work\\repo-b", now: expired.expiresAt + 1 });
    assert.ok(!excluded.some((claim) => claim.id === expired.id));
    assert.ok(!db.listClaims({ repoPath: "C:\\work\\other", now }).some((claim) => claim.id === active.id));
  });

  it("releases a claim by id and reports whether one was removed", () => {
    const claim = db.createClaim({ sessionId: null, repoPath: "C:\\work\\repo-c", paths: ["e.ts"], ttlMs: 60_000 });
    assert.equal(db.releaseClaim(claim.id), true);
    assert.equal(db.getClaim(claim.id), null);
    assert.equal(db.releaseClaim(claim.id), false);
  });

  it("releases every claim of a session", () => {
    db.applyHook(sessionPayload("sess-b", "batch session"));
    db.createClaim({ sessionId: "sess-b", repoPath: "C:\\work\\repo-d", paths: ["f.ts"], ttlMs: 60_000 });
    db.createClaim({ sessionId: "sess-b", repoPath: "C:\\work\\repo-e", paths: ["g.ts"], ttlMs: 60_000 });
    const removed = db.releaseClaimsOfSession("sess-b");
    assert.equal(removed, 2);
    assert.equal(db.listClaims({ repoPath: "C:\\work\\repo-d" }).length, 0);
  });

  it("purges expired claims and reports at least one removed", () => {
    const claim = db.createClaim({ sessionId: null, repoPath: "C:\\work\\repo-f", paths: ["h.ts"], ttlMs: 60_000 });
    assert.notEqual(db.getClaim(claim.id), null);
    const removed = db.purgeExpiredClaims(claim.expiresAt + 1);
    assert.ok(removed >= 1);
    assert.equal(db.getClaim(claim.id), null);
  });
});

after(() => {
  db.db.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
