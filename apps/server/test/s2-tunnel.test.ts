import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { s2Until, s2Zip } from "./helpers/s2-env.js";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, describe, it } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "cch-s2-tunnel-"));
const dataDir = join(tmp, "data");
function holdsNgrok(dir: string): boolean {
  for (const name of ["ngrok.exe", "ngrok"]) {
    try {
      lstatSync(join(dir, name));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

process.env.HUB_DATA_DIR = dataDir;
process.env.HUB_SHARE_PORT = "4447";
process.env.LOCALAPPDATA = join(tmp, "localappdata");
delete process.env.HUB_NGROK_BIN;
delete process.env.HUB_NGROK_ARGS_PREFIX;
delete process.env.HUB_RESOURCE_DIR;
delete process.env.FAKE_NGROK_MODE;
process.env.PATH = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((dir) => dir.length > 0 && !holdsNgrok(dir))
  .join(delimiter);
const fakeNgrok = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-ngrok.mjs");

type Tunnel = typeof import("../src/tunnel.js");
let tunnel: Tunnel;
let configModule: typeof import("../src/config.js");
const realFetch = globalThis.fetch;
const children = new Set<ChildProcess>();

before(async () => {
  tunnel = await import("../src/tunnel.js");
  configModule = await import("../src/config.js");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  tunnel.overrideTunnelRunner(null);
  tunnel.resetNgrokBinaryCache();
});

after(async () => {
  for (const child of children) child.kill();
  tunnel.stopTunnel();
  const { db } = await import("../src/db.js");
  if (db.open) db.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const win = process.platform === "win32";

const useConfigured = (): void => {
  const target = configModule.config as { ngrokBin: string | null; ngrokArgsPrefix: string[] };
  target.ngrokBin = process.execPath;
  target.ngrokArgsPrefix = [fakeNgrok];
  tunnel.resetNgrokBinaryCache();
};

const useNothing = (): void => {
  const target = configModule.config as { ngrokBin: string | null; ngrokArgsPrefix: string[] };
  target.ngrokBin = null;
  target.ngrokArgsPrefix = [];
  tunnel.resetNgrokBinaryCache();
};

const zipOf = (entries: Record<string, string>): Buffer => s2Zip(tmp, entries);

const stubDownload = (answer: () => Response): void => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.includes("bin.equinox.io") ? Promise.resolve(answer()) : realFetch(input, init);
  }) as typeof fetch;
};

describe("ngrok install", { skip: !win }, () => {
  it("reports a failed download and an archive without an executable", async () => {
    useNothing();
    stubDownload(() => new Response("nope", { status: 503 }));
    await assert.rejects(() => tunnel.installNgrok(), /ngrok download failed \(503\)/);
    stubDownload(() => new Response(new Uint8Array(zipOf({ "readme.txt": "nothing here" }))));
    await assert.rejects(() => tunnel.installNgrok(), /extracted but no executable found/);
  });

  it("fails the tunnel start when the install fails and no binary exists", async () => {
    useNothing();
    stubDownload(() => new Response("nope", { status: 500 }));
    const status = await tunnel.startTunnel();
    assert.equal(status.state, "error");
    assert.match(status.error ?? "", /ngrok download failed \(500\)/);
    tunnel.stopTunnel();
  });

  it("installs a downloaded archive once for concurrent callers and returns the managed binary", async () => {
    useNothing();
    const bundle = zipOf({ "ngrok.exe": "MZ fake" });
    stubDownload(() => new Response(new Uint8Array(bundle)));
    const [first, second] = await Promise.all([tunnel.installNgrok(), tunnel.installNgrok()]);
    assert.equal(first, second);
    assert.ok(existsSync(first));
    assert.ok(first.startsWith(configModule.config.binDir));
    assert.equal(readFileSync(first, "utf8"), "MZ fake");
  });

  it("accepts an extracted executable with a different name", async () => {
    useNothing();
    rmSync(join(configModule.config.binDir, "ngrok.exe"), { force: true });
    stubDownload(() => new Response(new Uint8Array(zipOf({ "ngrok-v3.exe": "MZ other" }))));
    const binary = await tunnel.installNgrok();
    assert.match(binary, /ngrok-v3\.exe$/);
  });
});

describe("process bookkeeping with an injected runner", () => {
  function sleeper(): ChildProcess {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    children.add(child);
    return child;
  }

  const pidFile = (): string => join(dataDir, "pids", "ngrok.pid");

  it("drops a stale pid file and leaves unrelated processes alone", async () => {
    useConfigured();
    mkdirSync(join(dataDir, "pids"), { recursive: true });
    writeFileSync(pidFile(), "not-a-pid");
    assert.equal(await tunnel.reapLeftoverNgrok(), null);
    writeFileSync(pidFile(), "2147480000");
    assert.equal(await tunnel.reapLeftoverNgrok(), null);
    assert.equal(existsSync(pidFile()), false);
    const other = sleeper();
    writeFileSync(pidFile(), String(other.pid));
    tunnel.overrideTunnelRunner((async () => ({ stdout: "C:\\Windows\\notepad.exe\r\n", stderr: "" })) as never);
    assert.equal(await tunnel.reapLeftoverNgrok(), null);
    assert.equal(existsSync(pidFile()), false);
    assert.equal(other.exitCode, null);
    other.kill();
  });

  it("closes a leftover ngrok whose executable matches", async () => {
    useConfigured();
    const victim = sleeper();
    writeFileSync(pidFile(), String(victim.pid));
    const calls: string[] = [];
    tunnel.overrideTunnelRunner((async (file: string, args: string[]) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "taskkill") {
        victim.kill();
        return { stdout: "", stderr: "" };
      }
      return { stdout: `${process.env.HUB_NGROK_BIN ?? "ngrok.exe"}\r\n`, stderr: "" };
    }) as never);
    const closed = await tunnel.reapLeftoverNgrok();
    assert.equal(closed, victim.pid);
    assert.ok(calls.some((entry) => entry.startsWith("taskkill")));
    assert.equal(existsSync(pidFile()), false);
  });

  it("recognises a leftover ngrok by its executable name even when it is another copy", async () => {
    const victim = sleeper();
    writeFileSync(pidFile(), String(victim.pid));
    tunnel.overrideTunnelRunner((async (file: string) => {
      if (file === "taskkill") {
        victim.kill();
        return { stdout: "", stderr: "" };
      }
      return { stdout: "D:\\tools\\ngrok.exe\r\n", stderr: "" };
    }) as never);
    assert.equal(await tunnel.reapLeftoverNgrok(), victim.pid);
  });

  it("survives a failing process query and a failing kill", async () => {
    const victim = sleeper();
    writeFileSync(pidFile(), String(victim.pid));
    tunnel.overrideTunnelRunner((async () => {
      throw new Error("powershell is gone");
    }) as never);
    assert.equal(await tunnel.reapLeftoverNgrok(), null);
    victim.kill();
  });

  it("kills a running ngrok found by the process list before starting a new tunnel", async () => {
    useConfigured();
    const victim = sleeper();
    const rival = sleeper();
    writeFileSync(pidFile(), String(rival.pid));
    tunnel.overrideTunnelRunner((async (file: string, args: string[]) => {
      if (file === "taskkill") {
        victim.kill();
        rival.kill();
        return { stdout: "", stderr: "" };
      }
      const command = args.join(" ");
      if (command.includes("Name='ngrok.exe'")) return { stdout: JSON.stringify([{ ProcessId: victim.pid, ExecutablePath: process.execPath }, { ProcessId: 0, ExecutablePath: "" }]), stderr: "" };
      return { stdout: `${process.execPath}

`, stderr: "" };
    }) as never);
    const status = await tunnel.startTunnel();
    assert.equal(status.state, "running");
    assert.match(status.notice ?? "", /closed an ngrok that was already running/);
    tunnel.stopTunnel();
  });

  it("lists a single process object and an empty answer", async () => {
    useConfigured();
    const victim = sleeper();
    let phase = 0;
    tunnel.overrideTunnelRunner((async (file: string, args: string[]) => {
      if (file === "taskkill") {
        victim.kill();
        return { stdout: "", stderr: "" };
      }
      if (args.join(" ").includes("Name='ngrok.exe'")) {
        phase += 1;
        return { stdout: phase === 1 ? "" : JSON.stringify({ ProcessId: victim.pid, ExecutablePath: process.execPath }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }) as never);
    const first = await tunnel.startTunnel();
    assert.equal(first.notice, null);
    tunnel.stopTunnel();
    const second = await tunnel.startTunnel();
    assert.match(second.notice ?? "", /closed an ngrok/);
    tunnel.stopTunnel();
  });
});

describe("tunnel start validation", () => {
  it("refuses a malformed static domain", async () => {
    useConfigured();
    tunnel.updateTunnelSettings({ domain: "not a domain!" });
    tunnel.overrideTunnelRunner((async () => ({ stdout: "", stderr: "" })) as never);
    const status = await tunnel.startTunnel();
    assert.equal(status.state, "error");
    assert.match(status.error ?? "", /not a valid host name/);
    tunnel.updateTunnelSettings({ domain: null });
    tunnel.stopTunnel();
  });

  it("ignores a second start while one is already starting", async () => {
    useConfigured();
    tunnel.overrideTunnelRunner((async () => ({ stdout: "", stderr: "" })) as never);
    const first = tunnel.startTunnel();
    await s2Until(() => (tunnel.tunnelStatus().state === "starting" ? true : null), 10_000);
    const second = await tunnel.startTunnel();
    assert.equal(second.state, "starting");
    const done = await first;
    assert.equal(done.state, "running");
    tunnel.stopTunnel();
  });
});

describe("firewall helper", () => {
  it("reports allowed, not allowed and a failed query, using a cache until forced", async () => {
    const answers: (() => { stdout: string })[] = [() => ({ stdout: "1\r\n" }), () => ({ stdout: "0\r\n" }), () => {
      throw new Error("query exploded");
    }];
    let calls = 0;
    tunnel.overrideTunnelRunner((async () => {
      const answer = answers[Math.min(calls, answers.length - 1)] as () => { stdout: string };
      calls += 1;
      return { ...answer(), stderr: "" };
    }) as never);
    const first = await tunnel.firewallStatus(true);
    const cached = await tunnel.firewallStatus();
    const second = await tunnel.firewallStatus(true);
    const third = await tunnel.firewallStatus(true);
    if (win) {
      assert.equal(first.supported, true);
      assert.equal(first.allowed, true);
      assert.equal(cached, first);
      assert.equal(second.allowed, false);
      assert.equal(third.allowed, null);
      assert.match(third.error ?? "", /query exploded/);
      assert.equal(calls, 3);
    } else {
      assert.equal(first.supported, false);
      assert.equal(first.allowed, null);
    }
  });

  it("asks Windows to add the rule and reports the cancelled prompt", async () => {
    const seen: string[] = [];
    let granted = false;
    tunnel.overrideTunnelRunner((async (_file: string, args: string[]) => {
      const command = args.join(" ");
      seen.push(command);
      if (command.includes("Start-Process")) {
        if (!granted) throw new Error("the operation was canceled by the user");
        return { stdout: "", stderr: "" };
      }
      return { stdout: granted ? "1\r\n" : "0\r\n", stderr: "" };
    }) as never);
    const cancelled = await tunnel.allowFirewall();
    if (!win) {
      assert.equal(cancelled.supported, false);
      return;
    }
    assert.equal(cancelled.allowed, false);
    assert.match(cancelled.error ?? "", /canceled by the user/);
    assert.ok(seen.some((entry) => entry.includes("localport=4447")));
    granted = true;
    const allowed = await tunnel.allowFirewall();
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.error, null);
  });

  it("treats an add-rule failure as success when the rule ends up allowed", async () => {
    if (!win) return;
    tunnel.overrideTunnelRunner((async (_file: string, args: string[]) => {
      if (args.join(" ").includes("Start-Process")) throw new Error("exit code 1");
      return { stdout: "2\r\n", stderr: "" };
    }) as never);
    const status = await tunnel.allowFirewall();
    assert.equal(status.allowed, true);
    assert.equal(status.error, null);
  });
});
