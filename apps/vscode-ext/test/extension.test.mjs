import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const extensionPath = require.resolve("../extension.js");
const HUB_URL = "http://127.0.0.1:4317/api/events";

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createTerminal(name, processId) {
  const shown = [];
  return {
    name,
    processId,
    shown,
    show(preserveFocus) {
      shown.push(preserveFocus);
    },
  };
}

function createVscode(terminals = []) {
  const state = {
    terminals,
    uriHandler: null,
    commands: new Map(),
    messages: [],
  };
  const api = {
    window: {
      get terminals() {
        return state.terminals;
      },
      registerUriHandler(handler) {
        state.uriHandler = handler;
        return { dispose() {}, kind: "uri-handler" };
      },
      async showInformationMessage(...args) {
        state.messages.push(args);
      },
    },
    commands: {
      registerCommand(name, callback) {
        state.commands.set(name, callback);
        return { dispose() {}, kind: "command", name };
      },
    },
  };
  return { api, state };
}

function createHttp() {
  const state = { requests: [], responses: [] };
  const api = {
    get(url, callback) {
      const request = new EventEmitter();
      request.url = url;
      request.destroyed = false;
      request.destroy = () => {
        request.destroyed = true;
      };
      request.respond = () => {
        const response = new EventEmitter();
        state.responses.push(response);
        callback(response);
        return response;
      };
      state.requests.push(request);
      return request;
    },
  };
  return { api, state };
}

function loadExtension({ vscode, http, homedir }) {
  const original = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === "vscode") return vscode;
    if (request === "http") return http;
    if (request === "os") return { ...os, homedir: () => homedir };
    return original.call(this, request, parent, isMain);
  };
  delete require.cache[extensionPath];
  try {
    return require(extensionPath);
  } finally {
    Module._load = original;
    delete require.cache[extensionPath];
  }
}

function readMissLog(home) {
  const file = path.join(home, ".vbss-cchub", "ext-focus.log");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("cch-focus extension", () => {
  let home;
  let vscodeFake;
  let httpFake;
  let extension;
  let context;

  function boot(terminals = []) {
    vscodeFake = createVscode(terminals);
    httpFake = createHttp();
    extension = loadExtension({ vscode: vscodeFake.api, http: httpFake.api, homedir: home });
    context = { subscriptions: [] };
  }

  function openStream() {
    return httpFake.state.requests.at(-1).respond();
  }

  function feed(response, text) {
    response.emit("data", Buffer.from(text));
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cch-focus-"));
    boot();
  });

  afterEach(() => {
    extension.deactivate();
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe("activate", () => {
    it("connects to the hub event stream and registers the uri handler and command", () => {
      extension.activate(context);
      assert.equal(httpFake.state.requests.length, 1);
      assert.equal(httpFake.state.requests[0].url, HUB_URL);
      assert.equal(context.subscriptions.length, 2);
      assert.deepEqual(
        context.subscriptions.map((item) => item.kind),
        ["uri-handler", "command"],
      );
      assert.equal(typeof vscodeFake.state.uriHandler.handleUri, "function");
      assert.deepEqual([...vscodeFake.state.commands.keys()], ["cchFocus.listTerminals"]);
    });

    it("exposes activate and deactivate only", () => {
      assert.deepEqual(Object.keys(extension).sort(), ["activate", "deactivate"]);
    });
  });

  describe("uri handler", () => {
    it("focuses the terminal whose process id matches the pid query", async () => {
      const other = createTerminal("other", Promise.resolve(10));
      const target = createTerminal("claude", Promise.resolve(4242));
      boot([other, target]);
      extension.activate(context);
      await vscodeFake.state.uriHandler.handleUri({ query: "pid=4242" });
      assert.deepEqual(target.shown, [false]);
      assert.deepEqual(other.shown, []);
      assert.deepEqual(readMissLog(home), []);
    });

    it("matches terminals whose processId is a plain value", async () => {
      const target = createTerminal("plain", 77);
      boot([target]);
      extension.activate(context);
      await vscodeFake.state.uriHandler.handleUri({ query: "pid=77&x=1" });
      assert.deepEqual(target.shown, [false]);
    });

    it("logs a miss with the terminal snapshot when no terminal matches", async () => {
      const first = createTerminal("one", Promise.resolve(1));
      const second = createTerminal("two", Promise.resolve(undefined));
      boot([first, second]);
      extension.activate(context);
      await vscodeFake.state.uriHandler.handleUri({ query: "pid=999" });
      assert.deepEqual(first.shown, []);
      assert.deepEqual(second.shown, []);
      const entries = readMissLog(home);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].pid, 999);
      assert.deepEqual(entries[0].terminals, [{ name: "one", pid: 1 }, { name: "two" }]);
      assert.ok(!Number.isNaN(Date.parse(entries[0].t)));
    });

    it("appends one log line per miss", async () => {
      extension.activate(context);
      await vscodeFake.state.uriHandler.handleUri({ query: "pid=5" });
      await vscodeFake.state.uriHandler.handleUri({ query: "pid=6" });
      assert.deepEqual(
        readMissLog(home).map((entry) => entry.pid),
        [5, 6],
      );
    });

    for (const query of ["", "pid=abc", "pid=0", "pid=-3", "pid=1.5", "other=1"]) {
      it(`ignores an invalid pid (${JSON.stringify(query)})`, async () => {
        const terminal = createTerminal("t", Promise.resolve(0));
        boot([terminal]);
        extension.activate(context);
        await vscodeFake.state.uriHandler.handleUri({ query });
        assert.deepEqual(terminal.shown, []);
        assert.deepEqual(readMissLog(home), []);
      });
    }

    it("does not throw when the miss log cannot be written", async () => {
      const blocker = path.join(home, "blocked");
      fs.writeFileSync(blocker, "file");
      vscodeFake = createVscode([]);
      httpFake = createHttp();
      extension = loadExtension({ vscode: vscodeFake.api, http: httpFake.api, homedir: blocker });
      extension.activate(context);
      await vscodeFake.state.uriHandler.handleUri({ query: "pid=12" });
      assert.deepEqual(readMissLog(home), []);
      assert.equal(fs.statSync(blocker).isFile(), true);
    });
  });

  describe("listTerminals command", () => {
    it("shows every terminal with its pid", async () => {
      boot([createTerminal("zsh", Promise.resolve(11)), createTerminal("claude", 22)]);
      extension.activate(context);
      await vscodeFake.state.commands.get("cchFocus.listTerminals")();
      assert.deepEqual(vscodeFake.state.messages, [
        ["zsh → pid 11   |   claude → pid 22", { modal: false }],
      ]);
    });

    it("says so when there are no terminals", async () => {
      extension.activate(context);
      await vscodeFake.state.commands.get("cchFocus.listTerminals")();
      assert.deepEqual(vscodeFake.state.messages, [["No terminals open", { modal: false }]]);
    });
  });

  describe("event stream", () => {
    it("focuses the terminal named by a focus-terminal event", async () => {
      const target = createTerminal("claude", Promise.resolve(321));
      boot([target]);
      extension.activate(context);
      const response = openStream();
      feed(response, 'event: focus-terminal\ndata: {"shellPid":321}\n\n');
      await settle();
      assert.deepEqual(target.shown, [false]);
    });

    it("logs a miss for a focus-terminal event that matches nothing", async () => {
      boot([createTerminal("claude", Promise.resolve(1))]);
      extension.activate(context);
      feed(openStream(), 'event: focus-terminal\ndata: {"shellPid":2}\n');
      await settle();
      const entries = readMissLog(home);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].pid, 2);
    });

    it("reassembles lines split across chunks and accepts CRLF", async () => {
      const target = createTerminal("claude", Promise.resolve(55));
      boot([target]);
      extension.activate(context);
      const response = openStream();
      feed(response, "event: focus-ter");
      feed(response, 'minal\r\ndata: {"shell');
      feed(response, 'Pid":55}\r\n\r\n');
      await settle();
      assert.deepEqual(target.shown, [false]);
    });

    it("handles several events in one chunk", async () => {
      const a = createTerminal("a", Promise.resolve(1));
      const b = createTerminal("b", Promise.resolve(2));
      boot([a, b]);
      extension.activate(context);
      feed(
        openStream(),
        'event: focus-terminal\ndata: {"shellPid":1}\n\nevent: focus-terminal\ndata: {"shellPid":2}\n\n',
      );
      await settle();
      assert.deepEqual(a.shown, [false]);
      assert.deepEqual(b.shown, [false]);
    });

    it("ignores events of other types and data without an event", async () => {
      const target = createTerminal("claude", Promise.resolve(8));
      boot([target]);
      extension.activate(context);
      const response = openStream();
      feed(response, 'event: ping\ndata: {"shellPid":8}\n\n');
      feed(response, 'data: {"shellPid":8}\n\n');
      feed(response, ": comment line\n\n");
      await settle();
      assert.deepEqual(target.shown, []);
      assert.deepEqual(readMissLog(home), []);
    });

    it("resets the event name after each data line", async () => {
      const target = createTerminal("claude", Promise.resolve(8));
      boot([target]);
      extension.activate(context);
      const response = openStream();
      feed(response, 'event: focus-terminal\ndata: {"shellPid":8}\n');
      feed(response, 'data: {"shellPid":8}\n');
      await settle();
      assert.deepEqual(target.shown, [false]);
    });

    it("survives malformed event data", async () => {
      const target = createTerminal("claude", Promise.resolve(8));
      boot([target]);
      extension.activate(context);
      const response = openStream();
      feed(response, "event: focus-terminal\ndata: {not json\n");
      feed(response, 'event: focus-terminal\ndata: {"shellPid":8}\n');
      await settle();
      assert.deepEqual(target.shown, [false]);
    });

    it("ignores events whose shellPid is not a positive integer", async () => {
      const target = createTerminal("claude", Promise.resolve(8));
      boot([target]);
      extension.activate(context);
      const response = openStream();
      feed(response, 'event: focus-terminal\ndata: {"shellPid":"8"}\n');
      feed(response, 'event: focus-terminal\ndata: {"shellPid":0}\n');
      feed(response, "event: focus-terminal\ndata: {}\n");
      await settle();
      assert.deepEqual(target.shown, []);
      assert.deepEqual(readMissLog(home), []);
    });
  });

  describe("reconnect", () => {
    it("reconnects five seconds after the stream ends", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      extension.activate(context);
      openStream().emit("end");
      assert.equal(httpFake.state.requests.length, 1);
      t.mock.timers.tick(4999);
      assert.equal(httpFake.state.requests.length, 1);
      t.mock.timers.tick(1);
      assert.equal(httpFake.state.requests.length, 2);
      assert.equal(httpFake.state.requests[1].url, HUB_URL);
    });

    it("reconnects after a response error", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      extension.activate(context);
      openStream().emit("error", new Error("reset"));
      t.mock.timers.tick(5000);
      assert.equal(httpFake.state.requests.length, 2);
    });

    it("reconnects after a request error", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      extension.activate(context);
      httpFake.state.requests[0].emit("error", new Error("ECONNREFUSED"));
      t.mock.timers.tick(5000);
      assert.equal(httpFake.state.requests.length, 2);
    });

    it("schedules a single retry when several failures arrive together", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      extension.activate(context);
      const response = openStream();
      response.emit("error", new Error("reset"));
      response.emit("end");
      httpFake.state.requests[0].emit("error", new Error("again"));
      t.mock.timers.tick(5000);
      assert.equal(httpFake.state.requests.length, 2);
      t.mock.timers.tick(5000);
      assert.equal(httpFake.state.requests.length, 2);
    });

    it("keeps retrying while the hub stays down", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      extension.activate(context);
      httpFake.state.requests[0].emit("error", new Error("down"));
      t.mock.timers.tick(5000);
      httpFake.state.requests[1].emit("error", new Error("still down"));
      t.mock.timers.tick(5000);
      assert.equal(httpFake.state.requests.length, 3);
    });
  });

  describe("deactivate", () => {
    it("destroys the open request and stops reconnecting", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      extension.activate(context);
      const request = httpFake.state.requests[0];
      extension.deactivate();
      assert.equal(request.destroyed, true);
      request.emit("error", new Error("aborted"));
      t.mock.timers.tick(10_000);
      assert.equal(httpFake.state.requests.length, 1);
    });

    it("cancels a pending reconnect timer", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      extension.activate(context);
      openStream().emit("end");
      extension.deactivate();
      t.mock.timers.tick(10_000);
      assert.equal(httpFake.state.requests.length, 1);
    });

    it("is safe before activation", () => {
      assert.doesNotThrow(() => extension.deactivate());
      assert.equal(httpFake.state.requests.length, 0);
    });
  });
});
