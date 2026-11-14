import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { makeSandbox, startServer, type RunningServer } from "./helpers.js";

const box = makeSandbox("cch-ui-prefs-");
let hub: RunningServer;

interface Prefs {
  sidebar: { order: string[]; pinned: string[] } | null;
  layout: Record<string, Record<string, number>>;
}

before(async () => {
  hub = await startServer(box, { HUB_DELEGATION: "1" });
});

after(() => {
  hub.child.kill();
});

async function call(method: string, body?: unknown, origin?: string): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  const res = await fetch(`${hub.base}/delegation/ui-prefs`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
}

const get = async (): Promise<Prefs> => (await call("GET")).json as Prefs;

describe("ui prefs", () => {
  it("starts empty", async () => {
    assert.deepEqual(await get(), { sidebar: null, layout: {} });
  });

  it("round-trips the sidebar and layout in the shape of GET", async () => {
    const sidebar = { order: ["sessions", "today", "board", "flow", "usage"], pinned: ["sessions", "today"] };
    const put = await call("PUT", { sidebar, layout: { today: { focus: 620 }, drawer: { session: 480.5 } } });
    assert.equal(put.status, 200);
    const expected = { sidebar, layout: { today: { focus: 620 }, drawer: { session: 480.5 } } };
    assert.deepEqual(put.json, expected);
    assert.deepEqual(await get(), expected);
  });

  it("merges layout per screen and leaves the sidebar alone when it is absent", async () => {
    const put = await call("PUT", { layout: { today: { backlog: 340 }, note: { editor: 700 } } });
    assert.equal(put.status, 200);
    const prefs = put.json as Prefs;
    assert.deepEqual(prefs.layout.today, { focus: 620, backlog: 340 });
    assert.deepEqual(prefs.layout.note, { editor: 700 });
    assert.deepEqual(prefs.layout.drawer, { session: 480.5 });
    assert.deepEqual(prefs.sidebar?.pinned, ["sessions", "today"]);
  });

  it("overwrites a width already stored for the same screen key", async () => {
    const prefs = (await call("PUT", { layout: { today: { focus: 500 } } })).json as Prefs;
    assert.deepEqual(prefs.layout.today, { focus: 500, backlog: 340 });
  });

  it("resets the sidebar with null and keeps the layout", async () => {
    const put = await call("PUT", { sidebar: null });
    assert.equal(put.status, 200);
    const prefs = put.json as Prefs;
    assert.equal(prefs.sidebar, null);
    assert.ok(Object.keys(prefs.layout).length > 0);
    assert.equal((await get()).sidebar, null);
  });

  it("answers an empty patch with the current prefs", async () => {
    const before = await get();
    const put = await call("PUT", {});
    assert.equal(put.status, 200);
    assert.deepEqual(put.json, before);
  });

  it("rejects invalid payloads with 400 and stores nothing", async () => {
    const snapshot = await get();
    const letter = (index: number): string => String.fromCharCode(97 + index);
    const tooMany = Array.from({ length: 41 }, (_, index) => `v${letter(index % 26)}${letter(Math.floor(index / 26))}`);
    const elevenKeys = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`k${letter(index)}`, 1]));
    const invalid: unknown[] = [
      "text",
      [],
      { sidebar: "x" },
      { sidebar: [] },
      { sidebar: { order: ["a"] } },
      { sidebar: { order: "a", pinned: ["a"] } },
      { sidebar: { order: ["a"], pinned: [] } },
      { sidebar: { order: [], pinned: [] } },
      { sidebar: { order: ["Bad"], pinned: ["a"] } },
      { sidebar: { order: ["1bad"], pinned: ["a"] } },
      { sidebar: { order: ["a".repeat(33)], pinned: ["a"] } },
      { sidebar: { order: [1], pinned: ["a"] } },
      { sidebar: { order: ["ok"], pinned: ["has space"] } },
      { sidebar: { order: tooMany, pinned: ["a"] } },
      { layout: "x" },
      { layout: [] },
      { layout: { Today: { focus: 1 } } },
      { layout: { "1today": { focus: 1 } } },
      { layout: { today: 5 } },
      { layout: { today: { focus: "100" } } },
      { layout: { today: { focus: -1 } } },
      { layout: { today: { focus: 4001 } } },
      { layout: { today: { focus: null } } },
      { layout: { today: { "bad key": 1 } } },
      { layout: { today: elevenKeys } },
    ];
    for (const body of invalid) assert.equal((await call("PUT", body)).status, 400, JSON.stringify(body));
    assert.deepEqual(await get(), snapshot);
  });

  it("rejects non-finite widths that arrive as raw JSON", async () => {
    const res = await fetch(`${hub.base}/delegation/ui-prefs`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: `{"layout":{"today":{"focus":1e999}}}`,
    });
    assert.equal(res.status, 400);
  });

  it("rejects a merge that would push a screen over ten keys", async () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const fill = await call("PUT", { layout: { wide: Object.fromEntries(names.map((name) => [name, 1])) } });
    assert.equal(fill.status, 200);
    assert.equal((await call("PUT", { layout: { wide: { k: 1 } } })).status, 400);
    assert.equal((await call("PUT", { layout: { wide: { a: 2 } } })).status, 200);
  });

  it("answers malformed JSON with a JSON 400", async () => {
    const res = await fetch(`${hub.base}/delegation/ui-prefs`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{bad" });
    assert.equal(res.status, 400);
  });

  it("applies the delegation guard: untrusted origins get 403, the desktop app origin passes", async () => {
    assert.equal((await call("GET", undefined, "https://evil.example.com")).status, 403);
    assert.equal((await call("PUT", { sidebar: null }, "https://evil.example.com")).status, 403);
    assert.equal((await call("GET", undefined, "http://localhost:3000")).status, 403);
    assert.equal((await call("GET", undefined, "http://tauri.localhost")).status, 200);
  });

  it("broadcasts the new value on the ui-prefs event stream", async () => {
    const controller = new AbortController();
    const res = await fetch(`${hub.base}/api/events`, { signal: controller.signal });
    assert.ok(res.body);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const done = (async () => {
      for (;;) {
        const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));
        if (chunk.done) return null;
        received += decoder.decode(chunk.value);
        const match = /event: ui-prefs\ndata: (.*)\n\n/.exec(received);
        if (match) return JSON.parse(match[1] as string) as Prefs;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const put = await call("PUT", { sidebar: { order: ["sessions"], pinned: ["sessions"] } });
    const event = await Promise.race([done, new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))]);
    controller.abort();
    assert.deepEqual(event, put.json);
  });
});

describe("ui prefs without delegation", () => {
  it("is 404 on a hub started without HUB_DELEGATION=1", async () => {
    const other = await startServer(box, {});
    const res = await fetch(`${other.base}/delegation/ui-prefs`);
    assert.equal(res.status, 404);
    other.child.kill();
  });
});
