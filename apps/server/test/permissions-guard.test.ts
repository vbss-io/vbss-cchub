import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it, mock } from "node:test";
import type { NextFunction, Request, Response } from "express";

const dataDir = mkdtempSync(join(tmpdir(), "cchub-g1-guard-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;

const { permissionGuard } = await import("../src/permissions-routes.js");
const permissions = await import("../src/permissions.js");
const { db } = await import("../src/db.js");
const { onBroadcast } = await import("../src/sse.js");

interface Captured {
  status: number | null;
  body: unknown;
  passed: boolean;
}

function call(remoteAddress: string, origin?: string): Captured {
  const captured: Captured = { status: null, body: null, passed: false };
  const req = { socket: { remoteAddress }, header: (name: string) => (name.toLowerCase() === "origin" ? origin : undefined) } as unknown as Request;
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  const next: NextFunction = () => {
    captured.passed = true;
  };
  permissionGuard(req, res, next);
  return captured;
}

after(() => {
  permissions.clearAllPermissions();
  db.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("permission guard", () => {
  it("refuses a LAN caller with 403", () => {
    for (const address of ["192.168.0.20", "10.0.0.5", "::ffff:192.168.0.20", "172.20.0.1"]) {
      const out = call(address);
      assert.equal(out.status, 403, address);
      assert.equal(out.passed, false, address);
    }
  });

  it("lets loopback callers through and refuses an untrusted browser origin", () => {
    assert.equal(call("127.0.0.1").passed, true);
    assert.equal(call("::1").passed, true);
    assert.equal(call("::ffff:127.0.0.1", "http://tauri.localhost").passed, true);
    assert.equal(call("127.0.0.1", "https://evil.example.com").status, 403);
  });
});

describe("pending permission store", () => {
  const base = { agent: "claude" as const, sessionId: "s1", agentId: null, toolName: "Bash", toolInput: { command: "ls" }, cwd: null, turnId: null, title: null };

  it("only the pending id can be decided, once", () => {
    const opened = permissions.openPermissionRequest(base, 10_000);
    assert.ok(opened);
    const { record } = opened;
    let got: unknown = "unset";
    permissions.waitForDecision(record.id, opened.waitToken, (decision) => {
      got = decision;
    });
    assert.equal(permissions.decidePermission("other-id", { behavior: "allow", message: null }), null);
    assert.ok(permissions.decidePermission(record.id, { behavior: "deny", message: "no" }));
    assert.deepEqual(got, { behavior: "deny", message: "no" });
    assert.equal(permissions.decidePermission(record.id, { behavior: "allow", message: null }), null);
  });

  it("drops the allow message and opens nothing for a zero window", () => {
    assert.equal(permissions.openPermissionRequest(base, 0), null);
    const opened = permissions.openPermissionRequest(base, 10_000);
    assert.ok(opened);
    const { record } = opened;
    let got: unknown = null;
    permissions.waitForDecision(record.id, opened.waitToken, (decision) => {
      got = decision;
    });
    permissions.decidePermission(record.id, { behavior: "allow", message: "ignored" });
    assert.deepEqual(got, { behavior: "allow", message: null });
  });

  it("a parallel tool with the same name but another input does not clear the request", () => {
    const record = permissions.openPermissionRequest(base, 10_000)?.record;
    assert.ok(record);
    permissions.clearForSessionMove({ agent: "claude", sessionId: "s1", agentId: null, scope: "tool", toolName: "Bash", toolInput: { command: "pwd" } });
    assert.ok(permissions.getPermissionRequest(record.id));
    permissions.clearForSessionMove({ agent: "claude", sessionId: "s1", agentId: null, scope: "tool", toolName: "Bash", toolInput: { command: "ls" } });
    assert.equal(permissions.getPermissionRequest(record.id), null);
  });

  it("Stop of the main thread keeps a subagent's request, SessionEnd clears it", () => {
    const sub = permissions.openPermissionRequest({ ...base, agentId: "a1" }, 10_000)?.record;
    assert.ok(sub);
    permissions.clearForSessionMove({ agent: "claude", sessionId: "s1", agentId: null, scope: "turn", toolName: null, toolInput: undefined });
    assert.ok(permissions.getPermissionRequest(sub.id));
    permissions.clearForSessionMove({ agent: "claude", sessionId: "s1", agentId: null, scope: "session", toolName: null, toolInput: undefined });
    assert.equal(permissions.getPermissionRequest(sub.id), null);
  });

  it("withdraws a request when no hook starts waiting within the grace period", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const opened = permissions.openPermissionRequest({ ...base, sessionId: "grace-none" }, 60_000);
      assert.ok(opened);
      mock.timers.tick(permissions.WAITER_GRACE_MS - 1);
      assert.ok(permissions.getPermissionRequest(opened.record.id));
      mock.timers.tick(1);
      assert.equal(permissions.getPermissionRequest(opened.record.id), null);
    } finally {
      mock.timers.reset();
    }
  });

  it("a waiter attached in time cancels the grace withdrawal", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const opened = permissions.openPermissionRequest({ ...base, sessionId: "grace-waiter" }, 60_000);
      assert.ok(opened);
      mock.timers.tick(permissions.WAITER_GRACE_MS - 1);
      const attached = permissions.waitForDecision(opened.record.id, opened.waitToken, () => undefined);
      assert.equal(attached.status, "waiting");
      mock.timers.tick(permissions.WAITER_GRACE_MS * 3);
      assert.ok(permissions.getPermissionRequest(opened.record.id));
      permissions.withdrawPermission(opened.record.id);
    } finally {
      mock.timers.reset();
    }
  });

  it("a waiter that arrives right after the user decided still gets the decision, only with its token and only once", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const opened = permissions.openPermissionRequest({ ...base, sessionId: "late-waiter" }, 60_000);
      assert.ok(opened);
      permissions.decidePermission(opened.record.id, { behavior: "allow", message: null });
      assert.equal(permissions.waitForDecision(opened.record.id, "wrong", () => undefined).status, "forbidden");
      const got: unknown[] = [];
      assert.equal(permissions.waitForDecision(opened.record.id, opened.waitToken, (decision) => got.push(decision)).status, "waiting");
      assert.deepEqual(got, [{ behavior: "allow", message: null }]);
      assert.equal(permissions.waitForDecision(opened.record.id, opened.waitToken, () => undefined).status, "gone");
      const other = permissions.openPermissionRequest({ ...base, sessionId: "late-expired" }, 60_000);
      assert.ok(other);
      permissions.decidePermission(other.record.id, { behavior: "deny", message: null });
      mock.timers.tick(permissions.LATE_WAITER_MS);
      assert.equal(permissions.waitForDecision(other.record.id, other.waitToken, () => undefined).status, "gone");
    } finally {
      mock.timers.reset();
    }
  });

  it("refuses a waiter without the right token and keeps the request pending", () => {
    const opened = permissions.openPermissionRequest({ ...base, sessionId: "token" }, 10_000);
    assert.ok(opened);
    assert.equal(permissions.waitForDecision(opened.record.id, null, () => undefined).status, "forbidden");
    assert.equal(permissions.waitForDecision(opened.record.id, `${opened.waitToken}x`, () => undefined).status, "forbidden");
    assert.equal(permissions.waitForDecision(opened.record.id, "short", () => undefined).status, "forbidden");
    assert.ok(permissions.getPermissionRequest(opened.record.id));
    assert.equal(permissions.waitForDecision("not-pending", opened.waitToken, () => undefined).status, "gone");
    permissions.withdrawPermission(opened.record.id);
  });

  it("broadcasts the request without tool input, cwd, turn or wait token", () => {
    const seen: unknown[] = [];
    const off = onBroadcast((event, data) => {
      if (event === "permission-request") seen.push(data);
    });
    const opened = permissions.openPermissionRequest({ ...base, sessionId: "sse", cwd: "C:/secret/repo", turnId: "turn-9", toolInput: { command: "cat ~/.ssh/id_rsa" } }, 10_000);
    off();
    assert.ok(opened);
    assert.equal(seen.length, 1);
    const sent = seen[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(sent).sort(), ["agent", "agentId", "createdAt", "expiresAt", "id", "sessionId", "title", "toolName", "windowMs"]);
    assert.ok(!JSON.stringify(sent).includes("id_rsa"));
    assert.ok(!JSON.stringify(sent).includes(opened.waitToken));
    assert.deepEqual(permissions.getPermissionRequest(opened.record.id)?.toolInput, { command: "cat ~/.ssh/id_rsa" });
    permissions.withdrawPermission(opened.record.id);
  });

  it("caps the window for subagents only", () => {
    assert.equal(permissions.windowMsFor(300, null), 300_000);
    assert.equal(permissions.windowMsFor(300, "a1"), 20_000);
    assert.equal(permissions.windowMsFor(5, "a1"), 5_000);
    assert.equal(permissions.windowMsFor(0, null), 0);
  });
});
