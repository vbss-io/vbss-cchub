import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { before, describe, it } from "node:test";

process.env.HUB_DELEGATION = "1";
process.env.HUB_PORT = "4317";
process.env.HUB_TRUSTED_ORIGINS = "http://127.0.0.1:15173, http://localhost:5173";
delete process.env.HUB_RESOURCE_DIR;

type Security = typeof import("../src/delegation-security.js");
let security: Security;

before(async () => {
  security = await import("../src/delegation-security.js");
});

interface FakeResponse {
  code: number | null;
  body: unknown;
}

function guard(remoteAddress: string | undefined, headers: Record<string, string>): { res: FakeResponse; passed: boolean } {
  const res: FakeResponse & Partial<Response> = { code: null, body: null };
  res.status = ((code: number) => {
    res.code = code;
    return res as Response;
  }) as Response["status"];
  res.json = ((body: unknown) => {
    res.body = body;
    return res as Response;
  }) as Response["json"];
  const req = {
    socket: { remoteAddress },
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  let passed = false;
  const next: NextFunction = () => {
    passed = true;
  };
  security.delegationGuard(req, res as Response, next);
  return { res, passed };
}

describe("loopback and origin rules", () => {
  it("recognizes loopback remote addresses only", () => {
    assert.equal(security.isLoopbackAddress("127.0.0.1"), true);
    assert.equal(security.isLoopbackAddress("::1"), true);
    assert.equal(security.isLoopbackAddress("::ffff:127.0.0.1"), true);
    assert.equal(security.isLoopbackAddress("192.168.0.10"), false);
    assert.equal(security.isLoopbackAddress(undefined), false);
  });

  it("trusts absent origin, the hub's own origins, the desktop app and configured dev origins", () => {
    assert.equal(security.isTrustedOrigin(undefined), true);
    assert.equal(security.isTrustedOrigin("http://127.0.0.1:4317"), true);
    assert.equal(security.isTrustedOrigin("http://localhost:4317"), true);
    assert.equal(security.isTrustedOrigin("http://tauri.localhost"), true);
    assert.equal(security.isTrustedOrigin("HTTP://TAURI.LOCALHOST"), true);
    assert.equal(security.isTrustedOrigin("http://127.0.0.1:15173"), true);
    assert.equal(security.isTrustedOrigin("http://localhost:5173"), true);
  });

  it("rejects every other origin, including other loopback ports and the null origin", () => {
    assert.equal(security.isTrustedOrigin("http://localhost:3000"), false);
    assert.equal(security.isTrustedOrigin("http://127.0.0.1:8080"), false);
    assert.equal(security.isTrustedOrigin("https://evil.example.com"), false);
    assert.equal(security.isTrustedOrigin("null"), false);
  });
});

describe("delegationGuard", () => {
  it("refuses non-loopback connections regardless of headers", () => {
    const { res, passed } = guard("10.0.0.5", {});
    assert.equal(passed, false);
    assert.equal(res.code, 403);
  });

  it("refuses untrusted browser origins from loopback", () => {
    const { res, passed } = guard("127.0.0.1", { origin: "https://evil.example.com" });
    assert.equal(passed, false);
    assert.equal(res.code, 403);
  });

  it("lets loopback callers through with no origin or a trusted one", () => {
    assert.equal(guard("127.0.0.1", {}).passed, true);
    assert.equal(guard("::1", { origin: "http://tauri.localhost" }).passed, true);
    assert.equal(guard("::ffff:127.0.0.1", { origin: "http://127.0.0.1:4317" }).passed, true);
  });
});
