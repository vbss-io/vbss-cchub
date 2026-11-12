import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import { makeSandbox, startServer, type RunningServer } from "./helpers.js";

interface Unread {
  sessionId: string;
  status: string;
  unread: boolean;
  seenAt: number | null;
  archivedAt: number | null;
}

const box = makeSandbox("cch-unread-");
let hub: RunningServer;
const children: ChildProcess[] = [];

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${hub.base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
}

const send = (kind: string, sessionId: string, extra: Record<string, unknown> = {}) =>
  call("POST", "/hook", { kind, sessionId, ...extra });

const fetchSession = async (sessionId: string): Promise<Unread> => {
  const list = (await call("GET", "/api/sessions")).json as Unread[];
  const found = list.find((s) => s.sessionId === sessionId);
  assert.ok(found, `session ${sessionId} listed`);
  return found;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const worked = { model: "claude-test", contextTokens: 100 };

before(async () => {
  hub = await startServer(box, {});
  children.push(hub.child);
});

after(async () => {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode != null || child.signalCode != null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          child.kill();
        }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

describe("session unread state", () => {
  it("exposes unread and seenAt on every session", async () => {
    await send("session_start", "u-shape");
    const session = await fetchSession("u-shape");
    assert.equal(session.unread, false);
    assert.equal(typeof session.seenAt, "number");
  });

  it("a Stop makes the session unread", async () => {
    await send("user_prompt", "u-stop", worked);
    assert.equal((await fetchSession("u-stop")).unread, false);
    await tick();
    const res = await send("stop", "u-stop", worked);
    assert.equal((res.json as Unread).unread, true);
    const session = await fetchSession("u-stop");
    assert.equal(session.status, "idle");
    assert.equal(session.unread, true);
  });

  it("an idle_prompt notification makes the session unread", async () => {
    await send("user_prompt", "u-idle", worked);
    await tick();
    await send("notification", "u-idle", { ...worked, notificationType: "idle_prompt" });
    const session = await fetchSession("u-idle");
    assert.equal(session.status, "idle");
    assert.equal(session.unread, true);
  });

  it("a permission notification is waiting, not unread", async () => {
    await send("user_prompt", "u-wait", worked);
    await tick();
    await send("notification", "u-wait", { ...worked, notificationType: "permission_prompt" });
    const session = await fetchSession("u-wait");
    assert.equal(session.status, "waiting");
    assert.equal(session.unread, false);
  });

  it("the focus route clears unread and keeps its response shape", async () => {
    await send("user_prompt", "u-focus", worked);
    await tick();
    await send("stop", "u-focus", worked);
    assert.equal((await fetchSession("u-focus")).unread, true);
    const res = await call("POST", "/api/sessions/u-focus/focus");
    assert.equal(res.status, 200);
    assert.equal(typeof (res.json as { ok: boolean }).ok, "boolean");
    assert.equal((await fetchSession("u-focus")).unread, false);
    assert.equal((await call("POST", "/api/sessions/ghost/focus")).status, 404);
  });

  it("the seen route clears unread and returns the session", async () => {
    await send("user_prompt", "u-seen", worked);
    await tick();
    await send("stop", "u-seen", worked);
    const res = await call("POST", "/api/sessions/u-seen/seen");
    assert.equal(res.status, 200);
    const body = res.json as { ok: boolean; session: Unread };
    assert.equal(body.ok, true);
    assert.equal(body.session.sessionId, "u-seen");
    assert.equal(body.session.unread, false);
    assert.equal(typeof body.session.seenAt, "number");
    assert.equal((await fetchSession("u-seen")).unread, false);
    assert.equal((await call("POST", "/api/sessions/ghost/seen")).status, 404);
  });

  it("a new prompt clears unread", async () => {
    await send("user_prompt", "u-prompt", worked);
    await tick();
    await send("stop", "u-prompt", worked);
    assert.equal((await fetchSession("u-prompt")).unread, true);
    await tick();
    await send("user_prompt", "u-prompt", worked);
    const session = await fetchSession("u-prompt");
    assert.equal(session.status, "active");
    assert.equal(session.unread, false);
  });

  it("a session start marks the session seen", async () => {
    await send("user_prompt", "u-resume", worked);
    await tick();
    await send("stop", "u-resume", worked);
    await tick();
    await send("session_start", "u-resume", worked);
    assert.equal((await fetchSession("u-resume")).unread, false);
  });

  it("a later Stop after seen makes it unread again", async () => {
    await send("user_prompt", "u-again", worked);
    await tick();
    await send("stop", "u-again", worked);
    await tick();
    await call("POST", "/api/sessions/u-again/seen");
    assert.equal((await fetchSession("u-again")).unread, false);
    await tick();
    await send("user_prompt", "u-again", worked);
    await tick();
    await send("stop", "u-again", worked);
    assert.equal((await fetchSession("u-again")).unread, true);
  });

  it("an idle_prompt after a seen Stop does not make it unread again", async () => {
    await send("user_prompt", "u-late", worked);
    await tick();
    await send("stop", "u-late", worked);
    await tick();
    await call("POST", "/api/sessions/u-late/seen");
    await tick();
    await send("notification", "u-late", { ...worked, notificationType: "idle_prompt" });
    assert.equal((await fetchSession("u-late")).unread, false);
  });

  it("an archived session is never unread", async () => {
    await send("user_prompt", "u-arch", worked);
    await tick();
    await send("stop", "u-arch", worked);
    assert.equal((await fetchSession("u-arch")).unread, true);
    await call("POST", "/api/sessions/u-arch/archive");
    const session = await fetchSession("u-arch");
    assert.notEqual(session.archivedAt, null);
    assert.equal(session.unread, false);
  });

  it("an ended session is never unread", async () => {
    await send("user_prompt", "u-end", worked);
    await tick();
    await send("stop", "u-end", worked);
    await send("session_end", "u-end", worked);
    const session = await fetchSession("u-end");
    assert.equal(session.status, "ended");
    assert.equal(session.unread, false);
  });

  it("an empty session that never produced a turn is never unread", async () => {
    await send("user_prompt", "u-empty");
    await tick();
    await send("stop", "u-empty");
    const session = await fetchSession("u-empty");
    assert.equal(session.status, "idle");
    assert.equal(session.unread, false);
  });
});
