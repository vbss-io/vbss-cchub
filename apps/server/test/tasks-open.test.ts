import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeSandbox, startServer, type RunningServer, type Sandbox } from "./helpers.js";

describe("open a board project in the editor", () => {
  const box: Sandbox = makeSandbox("cch-tasks-open-");
  const vault = join(box.tmp, "vault");
  let hub: RunningServer;

  async function http(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${hub.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  before(async () => {
    mkdirSync(join(vault, "acme"), { recursive: true });
    writeFileSync(join(vault, "acme", "acme.md"), "# Acme\n\n## Open loops\n\n- [ ] Renew contract\n");
    hub = await startServer(box, { HUB_DELEGATION: "1" });
    const res = await http("PUT", "/delegation/settings", {
      workspacesRoot: box.root,
      secondBrainRoot: box.brain,
      tasks: { root: vault },
    });
    assert.equal(res.status, 200);
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("refuses while the tasks feature is off", async () => {
    const res = await http("POST", "/delegation/tasks-board/open", { projectId: "acme/acme" });
    assert.equal(res.status, 400);
  });

  it("returns 404 for an unknown or traversing project id", async () => {
    assert.equal((await http("PUT", "/delegation/settings", { features: { tasks: true } })).status, 200);
    assert.equal((await http("POST", "/delegation/tasks-board/open", { projectId: "acme/ghost" })).status, 404);
    assert.equal((await http("POST", "/delegation/tasks-board/open", { projectId: "../acme/acme" })).status, 404);
    assert.equal((await http("POST", "/delegation/tasks-board/open", {})).status, 404);
  });
});
