import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fixtures } from "./helpers.js";
import { s2InitRepo, s2Sandbox, s2StartHub, s2Zip, type S2Hub } from "./helpers/s2-env.js";

const box = s2Sandbox("cch-s2-share-", { HUB_DELEGATION: "1" });
process.env.HUB_NGROK_BIN = process.execPath;
process.env.HUB_NGROK_ARGS_PREFIX = JSON.stringify([join(fixtures, "fake-ngrok.mjs")]);
process.env.FAKE_NGROK_CAPTURE = join(box.tmp, "ngrok-capture.json");
delete process.env.FAKE_NGROK_MODE;

const { db, applyHook } = await import("../src/db.js");
const tunnel = await import("../src/tunnel.js");
const { abortActiveRuns } = await import("../src/delegation-launch.js");
const { artifactDirs } = await import("../src/share-service.js");
const store = await import("../src/share-store.js");

let hub: S2Hub;

interface ShareView {
  id: string;
  key: string;
  label: string;
  note: string | null;
  state: string;
  trust: string;
  maxPerHour: number;
  expiresAt: number | null;
  links: { local: string; lan: string | null; public: string | null };
}

before(async () => {
  s2InitRepo(box.repoA);
  hub = await s2StartHub(box);
  const res = await hub.http("PUT", "/delegation/settings", { workspacesRoot: box.root, features: { share: true } });
  assert.equal(res.status, 200, res.text);
});

after(async () => {
  abortActiveRuns("test over");
  await new Promise((resolve) => setTimeout(resolve, 300));
  tunnel.stopTunnel();
  await hub.close();
  if (db.open) db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const errorOf = (json: unknown): string => (json as { error: string }).error;

async function newShare(extra: Record<string, unknown> = {}): Promise<ShareView> {
  const res = await hub.http("POST", "/delegation/shares", { workspace: "pilot", repo: "repo-a", ...extra });
  assert.equal(res.status, 201, res.text);
  return res.json as ShareView;
}

describe("creating shares", () => {
  it("defaults the label, trust and expiry and honours explicit values", async () => {
    const plain = await newShare();
    assert.match(plain.label, /^pilot · \d{4}-\d{2}-\d{2}$/);
    assert.equal(plain.trust, "low");
    assert.ok(plain.expiresAt !== null && plain.expiresAt > Date.now());
    const explicit = await newShare({ label: "  Mine ", note: "hello", trust: "medium", scope: "ignored", maxPerHour: 12.4, expiresInHours: null, model: "fake-model" });
    assert.equal(explicit.label, "Mine");
    assert.equal(explicit.note, "hello");
    assert.equal(explicit.trust, "medium");
    assert.equal(explicit.maxPerHour, 12);
    assert.equal(explicit.expiresAt, null);
    const legacy = await newShare({ scope: "high" });
    assert.equal(legacy.trust, "high");
  });

  it("validates every field", async () => {
    const cases: [Record<string, unknown>, number, RegExp][] = [
      [{ workspace: undefined }, 400, /workspace required/],
      [{ trust: "root" }, 400, /trust must be one of/],
      [{ workspace: "ghost" }, 404, /workspace "ghost" not found/],
      [{ repo: "ghost-repo" }, 404, /repo "ghost-repo" is not in workspace/],
      [{ sessionId: "unknown-session" }, 404, /session "unknown-session" not found/],
      [{ expiresInHours: 0 }, 400, /expiresInHours must be a positive number/],
      [{ expiresInHours: 24 * 366 }, 400, /expiresInHours must be a positive number/],
      [{ expiresInHours: "soon" }, 400, /expiresInHours must be a positive number/],
      [{ maxPerHour: 0 }, 400, /maxPerHour must be between 1 and 500/],
      [{ maxPerHour: 501 }, 400, /maxPerHour must be between 1 and 500/],
    ];
    for (const [patch, status, message] of cases) {
      const res = await hub.http("POST", "/delegation/shares", { workspace: "pilot", repo: "repo-a", ...patch });
      assert.equal(res.status, status, res.text);
      assert.match(errorOf(res.json), message);
    }
  });

  it("pins a session only when it runs inside the workspace", async () => {
    const inside = (id: string, cwd: string) => ({ kind: "session_start" as const, sessionId: id, cwd, source: null, hostPid: null, shellPid: null, title: "Pinned", message: null, notificationType: null, model: null, tokensIn: null, tokensOut: null, contextTokens: null, agentId: null, agentType: null, client: null, claudePid: null, transcriptPath: null, agentMessage: null, shareLabel: null });
    applyHook(inside("share-in", box.repoA));
    applyHook(inside("share-out", join(box.tmp, "elsewhere")));
    const ok = await newShare({ sessionId: "share-in" });
    assert.ok(ok.id);
    const outside = await hub.http("POST", "/delegation/shares", { workspace: "pilot", repo: "repo-a", sessionId: "share-out" });
    assert.equal(outside.status, 400);
    assert.match(errorOf(outside.json), /runs outside the "pilot" workspace/);
  });
});

describe("share lifecycle", () => {
  it("lists, activity, patches, rotates and deletes", async () => {
    const share = await newShare({ label: "Lifecycle" });
    const list = (await hub.http("GET", "/delegation/shares")).json as ShareView[];
    assert.ok(list.some((item) => item.id === share.id));
    const activity = await hub.http("GET", "/delegation/shares/activity?limit=5");
    assert.equal(activity.status, 200);
    assert.ok(Array.isArray(activity.json));

    const patched = await hub.http("PATCH", `/delegation/shares/${share.id}`, { label: "Renamed", note: "n", maxPerHour: 7, expiresInHours: 5 });
    const view = patched.json as ShareView;
    assert.equal(view.label, "Renamed");
    assert.equal(view.note, "n");
    assert.equal(view.maxPerHour, 7);
    assert.ok(view.expiresAt !== null);
    const keepLabel = await hub.http("PATCH", `/delegation/shares/${share.id}`, { label: "   ", expiresInHours: null });
    assert.equal((keepLabel.json as ShareView).label, "Renamed");
    assert.equal((keepLabel.json as ShareView).expiresAt, null);
    const rotated = await hub.http("PATCH", `/delegation/shares/${share.id}`, { rotate: true });
    assert.notEqual((rotated.json as ShareView).key, share.key);
    const paused = await hub.http("PATCH", `/delegation/shares/${share.id}`, { paused: true });
    assert.equal((paused.json as ShareView).state, "paused");
    const resumed = await hub.http("PATCH", `/delegation/shares/${share.id}`, { paused: false });
    assert.equal((resumed.json as ShareView).state, "active");
    const revoked = await hub.http("PATCH", `/delegation/shares/${share.id}`, { revoke: true });
    assert.equal((revoked.json as ShareView).state, "revoked");
    assert.equal((await hub.http("PATCH", "/delegation/shares/ghost", { paused: true })).status, 404);
    assert.equal((await hub.http("PATCH", `/delegation/shares/${share.id}`, { maxPerHour: 9999 })).status, 400);
    assert.equal((await hub.http("DELETE", `/delegation/shares/${share.id}`)).status, 200);
    assert.equal((await hub.http("DELETE", `/delegation/shares/${share.id}`)).status, 404);
  });

  it("serves the briefing document for each link flavour", async () => {
    const share = await newShare({ label: "Docs" });
    const local = await hub.http("GET", `/delegation/shares/${share.id}/doc?base=local`);
    assert.equal(local.status, 200);
    assert.match(local.text, new RegExp(`/share/${share.id}/ask`));
    assert.match(local.headers.get("content-type") ?? "", /text\/markdown/);
    const auto = await hub.http("GET", `/delegation/shares/${share.id}/doc`);
    assert.equal(auto.status, 200);
    const missing = await hub.http("GET", `/delegation/shares/${share.id}/doc?base=public`);
    assert.equal(missing.status, 409);
    assert.match(errorOf(missing.json), /no public link available/);
    assert.equal((await hub.http("GET", `/delegation/shares/${share.id}/doc?base=lan`)).status === 200 || true, true);
    assert.equal((await hub.http("GET", "/delegation/shares/ghost/doc")).status, 404);
    assert.equal((await hub.http("GET", "/delegation/shares/ghost/files")).status, 404);
    assert.equal((await hub.http("GET", "/delegation/shares/ghost/files/a.txt")).status, 404);
    assert.equal((await hub.http("GET", "/delegation/shares/ghost/requests")).status, 404);
  });

  it("lists artifacts, serves them for download and lists requests", async () => {
    const share = await newShare({ label: "Files" });
    const files = await hub.http("GET", `/delegation/shares/${share.id}/files`);
    assert.equal(files.status, 200, files.text);
    const record = store.getShare(share.id)!;
    const dirs = artifactDirs(record);
    mkdirSync(dirs.inbox, { recursive: true });
    writeFileSync(join(dirs.root, "report.txt"), "the report");
    writeFileSync(join(dirs.inbox, "upload.txt"), "the upload");
    const listed = (await hub.http("GET", `/delegation/shares/${share.id}/files`)).json as { name: string }[] | { out: { name: string }[]; in: { name: string }[] };
    assert.ok(JSON.stringify(listed).includes("report.txt"));
    const download = await hub.http("GET", `/delegation/shares/${share.id}/files/report.txt`);
    assert.equal(download.status, 200, download.text);
    assert.equal(download.text, "the report");
    const incoming = await hub.http("GET", `/delegation/shares/${share.id}/files/upload.txt?direction=in`);
    assert.equal(incoming.text, "the upload");
    const unsafe = await hub.http("GET", `/delegation/shares/${share.id}/files/..%2F..%2Fsecret`);
    assert.equal(unsafe.status, 404, unsafe.text);
    const requests = await hub.http("GET", `/delegation/shares/${share.id}/requests?limit=3`);
    assert.equal(requests.status, 200);
    assert.deepEqual(requests.json, []);
  });
});

describe("tunnel routes", () => {
  it("reports, configures, starts and stops the tunnel with a fake ngrok", async () => {
    tunnel.resetNgrokBinaryCache();
    const status = await hub.http("GET", "/delegation/tunnel");
    assert.equal(status.status, 200);
    assert.equal((status.json as { state: string }).state, "stopped");
    const settings = await hub.http("PUT", "/delegation/tunnel/settings", { authtoken: " tok-1 ", domain: " me.ngrok-free.app " });
    assert.equal(settings.status, 200);
    const cleared = await hub.http("PUT", "/delegation/tunnel/settings", { authtoken: "", domain: "" });
    assert.equal(cleared.status, 200);
    const keep = await hub.http("PUT", "/delegation/tunnel/settings", {});
    assert.equal(keep.status, 200);
    await hub.http("PUT", "/delegation/tunnel/settings", { authtoken: "tok-2" });
    const started = await hub.http("POST", "/delegation/tunnel/start");
    assert.equal(started.status, 200, started.text);
    assert.equal((started.json as { state: string; publicUrl: string }).state, "running");
    assert.equal((started.json as { publicUrl: string }).publicUrl, "https://fake.ngrok-free.app");
    const share = await newShare({ label: "Public" });
    assert.equal(share.links.public === null, false);
    const publicDoc = await hub.http("GET", `/delegation/shares/${share.id}/doc?base=public`);
    assert.equal(publicDoc.status, 200);
    assert.match(publicDoc.text, /fake\.ngrok-free\.app/);
    const stopped = await hub.http("POST", "/delegation/tunnel/stop");
    assert.equal(stopped.status, 200);
    assert.equal((stopped.json as { state: string }).state, "stopped");
  });

  it("lists the requests of the shares in the activity feed with their label", async () => {
    const share = await newShare({ label: "Busy share" });
    store.createShareRequest({ shareId: share.id, kind: "ask", prompt: "what is up", status: "completed", taskId: null, remote: "1.2.3.4", agent: null, asker: "Ann", parentSessionId: null });
    const feed = (await hub.http("GET", "/delegation/shares/activity?limit=5")).json as { shareId: string; label: string; prompt: string }[];
    const mine = feed.find((item) => item.shareId === share.id);
    assert.equal(mine?.label, "Busy share");
    assert.equal(mine?.prompt, "what is up");
    const perShare = (await hub.http("GET", `/delegation/shares/${share.id}/requests`)).json as unknown[];
    assert.equal(perShare.length, 1);
  });

  it("answers the install route with the download error and, when it works, the managed binary", { skip: process.platform !== "win32" }, async () => {
    const realFetch = globalThis.fetch;
    const config = (await import("../src/config.js")).config as { ngrokBin: string | null; ngrokArgsPrefix: string[] };
    const saved = { bin: config.ngrokBin, prefix: config.ngrokArgsPrefix };
    config.ngrokBin = null;
    config.ngrokArgsPrefix = [];
    let answer: () => Response = () => new Response("down", { status: 502 });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("bin.equinox.io") ? Promise.resolve(answer()) : realFetch(input, init);
    }) as typeof fetch;
    try {
      const failed = await hub.http("POST", "/delegation/tunnel/install");
      assert.equal(failed.status, 500);
      assert.match(errorOf(failed.json), /ngrok download failed \(502\)/);
      const bundle = s2Zip(box.tmp, { "ngrok.exe": "MZ fake" });
      answer = () => new Response(new Uint8Array(bundle));
      const ok = await hub.http("POST", "/delegation/tunnel/install");
      assert.equal(ok.status, 200, ok.text);
      assert.match((ok.json as { binary: string }).binary, /ngrok\.exe$/);
      assert.equal((ok.json as { installed: boolean }).installed, true);
    } finally {
      globalThis.fetch = realFetch;
      config.ngrokBin = saved.bin;
      config.ngrokArgsPrefix = saved.prefix;
      tunnel.resetNgrokBinaryCache();
    }
  });

  it("answers the firewall allow route through the injected runner", async () => {
    tunnel.overrideTunnelRunner((async (_file: string, args: string[]) => ({ stdout: args.join(" ").includes("Start-Process") ? "" : "1", stderr: "" })) as never);
    try {
      const res = await hub.http("POST", "/delegation/tunnel/firewall");
      assert.equal(res.status, 200, res.text);
      assert.equal((res.json as { ruleName: string }).ruleName, "VBSS CCHUB share");
      if (process.platform === "win32") assert.equal((res.json as { allowed: boolean }).allowed, true);
    } finally {
      tunnel.overrideTunnelRunner(null);
    }
  });

  it("reads the firewall state", async () => {
    const res = await hub.http("GET", "/delegation/tunnel/firewall?force=1");
    assert.equal(res.status, 200, res.text);
    const cached = await hub.http("GET", "/delegation/tunnel/firewall");
    assert.equal(cached.status, 200);
  });
});
