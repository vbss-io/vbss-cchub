import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";

const dataDir = mkdtempSync(join(tmpdir(), "cchub-g1-guard-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;

const { permissionGuard } = await import("../src/permissions-routes.js");
const permissions = await import("../src/permissions.js");
const { db } = await import("../src/db.js");

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
    const record = permissions.openPermissionRequest(base, 10_000);
    assert.ok(record);
    let got: unknown = "unset";
    permissions.waitForDecision(record.id, (decision) => {
      got = decision;
    });
    assert.equal(permissions.decidePermission("other-id", { behavior: "allow", message: null }), null);
    assert.ok(permissions.decidePermission(record.id, { behavior: "deny", message: "no" }));
    assert.deepEqual(got, { behavior: "deny", message: "no" });
    assert.equal(permissions.decidePermission(record.id, { behavior: "allow", message: null }), null);
  });

  it("drops the allow message and opens nothing for a zero window", () => {
    assert.equal(permissions.openPermissionRequest(base, 0), null);
    const record = permissions.openPermissionRequest(base, 10_000);
    assert.ok(record);
    let got: unknown = null;
    permissions.waitForDecision(record.id, (decision) => {
      got = decision;
    });
    permissions.decidePermission(record.id, { behavior: "allow", message: "ignored" });
    assert.deepEqual(got, { behavior: "allow", message: null });
  });

  it("a parallel tool with the same name but another input does not clear the request", () => {
    const record = permissions.openPermissionRequest(base, 10_000);
    assert.ok(record);
    permissions.clearForSessionMove({ agent: "claude", sessionId: "s1", agentId: null, scope: "tool", toolName: "Bash", toolInput: { command: "pwd" } });
    assert.ok(permissions.getPermissionRequest(record.id));
    permissions.clearForSessionMove({ agent: "claude", sessionId: "s1", agentId: null, scope: "tool", toolName: "Bash", toolInput: { command: "ls" } });
    assert.equal(permissions.getPermissionRequest(record.id), null);
  });

  it("Stop of the main thread keeps a subagent's request, SessionEnd clears it", () => {
    const sub = permissions.openPermissionRequest({ ...base, agentId: "a1" }, 10_000);
    assert.ok(sub);
    permissions.clearForSessionMove({ agent: "claude", sessionId: "s1", agentId: null, scope: "turn", toolName: null, toolInput: undefined });
    assert.ok(permissions.getPermissionRequest(sub.id));
    permissions.clearForSessionMove({ agent: "claude", sessionId: "s1", agentId: null, scope: "session", toolName: null, toolInput: undefined });
    assert.equal(permissions.getPermissionRequest(sub.id), null);
  });

  it("caps the window for subagents only", () => {
    assert.equal(permissions.windowMsFor(300, null), 300_000);
    assert.equal(permissions.windowMsFor(300, "a1"), 20_000);
    assert.equal(permissions.windowMsFor(5, "a1"), 5_000);
    assert.equal(permissions.windowMsFor(0, null), 0);
  });
});
