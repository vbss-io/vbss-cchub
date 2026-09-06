import { spawn, spawnSync, execFile, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { networkInterfaces, platform, arch } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
import { getSetting, setSetting } from "./delegation-store.js";
import { broadcast } from "./sse.js";

const run = promisify(execFile);

export type TunnelState = "stopped" | "installing" | "starting" | "running" | "error";

export interface TunnelStatus {
  state: TunnelState;
  publicUrl: string | null;
  error: string | null;
  startedAt: number | null;
  binary: string | null;
  installed: boolean;
  authtokenSet: boolean;
  domain: string | null;
  lanUrl: string | null;
  localUrl: string;
  sharePort: number;
  endpointError: string | null;
}

export interface NgrokEvent {
  url: string | null;
  error: string | null;
}

interface InterfaceInfo {
  name: string;
  address: string;
  internal: boolean;
  family: string;
}

const VIRTUAL_INTERFACE = /vethernet|vpn|tailscale|hyper-v|wsl|virtualbox|vmware|docker|loopback|wg|zerotier|hamachi|bluetooth/i;
const PRIVATE_ADDRESS = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function pickLanAddress(interfaces: InterfaceInfo[]): string | null {
  const candidates = interfaces.filter((item) => item.family === "IPv4" && !item.internal);
  const physicalPrivate = candidates.find((item) => !VIRTUAL_INTERFACE.test(item.name) && PRIVATE_ADDRESS.test(item.address));
  const anyPrivate = candidates.find((item) => PRIVATE_ADDRESS.test(item.address));
  return (physicalPrivate ?? anyPrivate ?? candidates[0])?.address ?? null;
}

export function lanAddress(): string | null {
  const list: InterfaceInfo[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) list.push({ name, address: entry.address, internal: entry.internal, family: String(entry.family) });
  }
  return pickLanAddress(list);
}

const AUTH_HELP = "ngrok needs an authtoken: create a free account at ngrok.com and paste the token in Settings › Sharing";

export function friendlyNgrokError(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (/ERR_NGROK_4018|authtoken|authentication failed/i.test(text)) return AUTH_HELP;
  if (/ERR_NGROK_108|limited to 1 simultaneous|agent session limit/i.test(text)) return "ngrok says another agent is already running on this account; close it (or wait a minute) and start again";
  if (/ERR_NGROK_334|domain .* not (found|reserved)|not reserved/i.test(text)) return "the static domain in Settings › Sharing is not reserved on your ngrok account";
  return text.slice(0, 300);
}

export function parseNgrokLine(line: string): NgrokEvent {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.msg === "started tunnel" && typeof event.url === "string") return { url: event.url, error: null };
    if (event.lvl === "eror" || event.lvl === "crit") {
      const detail = typeof event.err === "string" ? event.err : typeof event.msg === "string" ? event.msg : "ngrok error";
      return { url: null, error: friendlyNgrokError(detail) };
    }
  } catch {
    const plain = line.trim();
    const bare = /^ERROR:?\s*$/i.test(plain);
    if (!bare && /ERR_NGROK|authtoken|error/i.test(plain)) return { url: null, error: friendlyNgrokError(plain) };
  }
  return { url: null, error: null };
}

const NGROK_DOWNLOADS: Record<string, string> = {
  "win32-x64": "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip",
  "win32-arm64": "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-arm64.zip",
  "darwin-x64": "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-darwin-amd64.zip",
  "darwin-arm64": "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-darwin-arm64.zip",
  "linux-x64": "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz",
  "linux-arm64": "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm64.tgz",
};

const exeName = platform() === "win32" ? "ngrok.exe" : "ngrok";
const managedBinary = (): string => join(config.binDir, exeName);

function runnable(candidate: string): boolean {
  try {
    if (statSync(candidate).isFile()) return true;
  } catch {
    if (config.ngrokArgsPrefix.length > 0) return false;
    const probe = spawnSync(candidate, ["version"], { timeout: 8_000, windowsHide: true, stdio: "ignore" });
    return probe.status === 0;
  }
  return false;
}

export function findNgrokBinary(): string | null {
  const candidates: (string | null)[] = [config.ngrokBin, managedBinary()];
  if (platform() === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(config.homeDir, "AppData", "Local");
    candidates.push(join(local, "Microsoft", "WindowsApps", "ngrok.exe"));
    for (const dir of (process.env.PATH ?? "").split(";")) if (dir) candidates.push(join(dir, "ngrok.exe"));
  } else {
    for (const dir of (process.env.PATH ?? "").split(":")) if (dir) candidates.push(join(dir, "ngrok"));
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (runnable(candidate)) return candidate;
  }
  return null;
}

const psLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

async function extract(archive: string, targetDir: string): Promise<void> {
  if (archive.endsWith(".zip")) {
    if (platform() === "win32") {
      await run(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${psLiteral(archive)} -DestinationPath ${psLiteral(targetDir)} -Force`],
        { timeout: 120_000, windowsHide: true },
      );
    } else {
      await run("unzip", ["-o", archive, "-d", targetDir], { timeout: 120_000 });
    }
    return;
  }
  await run("tar", ["-xzf", archive, "-C", targetDir], { timeout: 120_000 });
}

let installing: Promise<string> | null = null;

export function installNgrok(): Promise<string> {
  if (installing) return installing;
  installing = (async () => {
    const key = `${platform()}-${arch()}`;
    const url = NGROK_DOWNLOADS[key];
    if (!url) throw new Error(`no ngrok download for ${key}; install ngrok manually and set HUB_NGROK_BIN`);
    mkdirSync(config.binDir, { recursive: true });
    const archive = join(config.binDir, url.split("/").pop() ?? "ngrok-download");
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok || !res.body) throw new Error(`ngrok download failed (${res.status})`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(archive));
    await extract(archive, config.binDir);
    const binary = managedBinary();
    if (!existsSync(binary)) {
      const found = readdirSync(config.binDir).find((name) => name.toLowerCase().startsWith("ngrok") && !name.endsWith(".zip") && !name.endsWith(".tgz"));
      if (!found) throw new Error("ngrok archive extracted but no executable found");
      return join(config.binDir, found);
    }
    return binary;
  })().finally(() => {
    installing = null;
  });
  return installing;
}

interface TunnelRuntime {
  state: TunnelState;
  publicUrl: string | null;
  error: string | null;
  lastError: string | null;
  startedAt: number | null;
  child: ChildProcess | null;
  generation: number;
}

const runtime: TunnelRuntime = { state: "stopped", publicUrl: null, error: null, lastError: null, startedAt: null, child: null, generation: 0 };
const stateNow = (): TunnelState => runtime.state;
let endpointError: string | null = null;

export function markShareEndpoint(error: string | null): void {
  endpointError = error;
  publish();
}

export const tunnelSettings = (): { authtoken: string | null; domain: string | null } => ({
  authtoken: getSetting("ngrokAuthtoken"),
  domain: getSetting("ngrokDomain"),
});

export function updateTunnelSettings(patch: { authtoken?: string | null; domain?: string | null }): void {
  if (patch.authtoken !== undefined) setSetting("ngrokAuthtoken", patch.authtoken && patch.authtoken.trim().length > 0 ? patch.authtoken.trim() : null);
  if (patch.domain !== undefined) setSetting("ngrokDomain", patch.domain && patch.domain.trim().length > 0 ? patch.domain.trim() : null);
}

export function tunnelStatus(): TunnelStatus {
  const binary = findNgrokBinary();
  const lan = lanAddress();
  const settings = tunnelSettings();
  return {
    state: runtime.state,
    publicUrl: runtime.publicUrl,
    error: runtime.error,
    startedAt: runtime.startedAt,
    binary,
    installed: binary !== null,
    authtokenSet: settings.authtoken !== null,
    domain: settings.domain,
    lanUrl: lan ? `http://${lan}:${config.sharePort}` : null,
    localUrl: `http://127.0.0.1:${config.sharePort}`,
    sharePort: config.sharePort,
    endpointError,
  };
}

function publish(): void {
  broadcast("tunnel", tunnelStatus());
}

function setState(patch: Partial<TunnelRuntime>): void {
  Object.assign(runtime, patch);
  publish();
}

const validDomain = (domain: string): boolean => /^[a-z0-9.-]+$/i.test(domain);

export async function startTunnel(): Promise<TunnelStatus> {
  if (runtime.state === "running" || runtime.state === "starting" || runtime.state === "installing") return tunnelStatus();
  const generation = runtime.generation + 1;
  runtime.generation = generation;
  let binary = findNgrokBinary();
  if (!binary) {
    setState({ state: "installing", error: null });
    try {
      binary = await installNgrok();
    } catch (err) {
      if (runtime.generation === generation) setState({ state: "error", error: err instanceof Error ? err.message : "ngrok install failed" });
      return tunnelStatus();
    }
    if (runtime.generation !== generation || stateNow() !== "installing") return tunnelStatus();
  }
  const settings = tunnelSettings();
  const args = [...config.ngrokArgsPrefix, "http", String(config.sharePort), "--log", "stdout", "--log-format", "json"];
  if (settings.domain) {
    if (!validDomain(settings.domain)) {
      setState({ state: "error", error: "the static domain in Settings › Sharing is not a valid host name" });
      return tunnelStatus();
    }
    args.push("--domain", settings.domain);
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (settings.authtoken) env.NGROK_AUTHTOKEN = settings.authtoken;
  setState({ state: "starting", error: null, lastError: null, publicUrl: null, startedAt: Date.now() });
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env });
  runtime.child = child;
  let buffer = "";
  const onLine = (line: string): void => {
    if (runtime.child !== child) return;
    const event = parseNgrokLine(line);
    if (event.url) setState({ state: "running", publicUrl: event.url, error: null });
    if (event.error) {
      runtime.lastError = runtime.lastError ?? event.error;
      if (stateNow() !== "running" && !runtime.error) setState({ error: event.error });
    }
  };
  const consume = (chunk: Buffer): void => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", consume);
  child.on("error", (err) => {
    if (runtime.child !== child) return;
    setState({ state: "error", error: err.message, publicUrl: null, child: null });
  });
  child.on("exit", (code) => {
    if (runtime.child !== child) return;
    const stopped = stateNow() === "stopped";
    setState({
      state: stopped ? "stopped" : "error",
      error: stopped ? null : (runtime.error ?? runtime.lastError ?? `ngrok exited with code ${code ?? "?"}`),
      publicUrl: null,
      child: null,
    });
  });
  await new Promise<void>((resolve) => {
    const deadline = setTimeout(resolve, 15_000);
    const poll = setInterval(() => {
      if (stateNow() !== "starting" || runtime.child !== child) {
        clearTimeout(deadline);
        clearInterval(poll);
        resolve();
      }
    }, 100);
  });
  if (stateNow() === "starting" && runtime.child === child) {
    setState({ state: "error", error: runtime.error ?? runtime.lastError ?? "ngrok did not report a public url in 15 s" });
    child.kill();
  }
  return tunnelStatus();
}

export function stopTunnel(): TunnelStatus {
  const child = runtime.child;
  runtime.generation += 1;
  runtime.state = "stopped";
  runtime.publicUrl = null;
  runtime.error = null;
  runtime.lastError = null;
  runtime.startedAt = null;
  runtime.child = null;
  if (child) child.kill();
  publish();
  return tunnelStatus();
}

process.on("exit", () => {
  runtime.child?.kill();
});

export interface FirewallStatus {
  supported: boolean;
  allowed: boolean | null;
  ruleName: string;
  port: number;
  error: string | null;
}

const FIREWALL_RULE = "VBSS CCHUB share";
let firewallCache: { at: number; status: FirewallStatus } | null = null;

const powershell = (command: string, timeout: number): Promise<{ stdout: string }> =>
  run("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout, windowsHide: true });

export async function firewallStatus(force = false): Promise<FirewallStatus> {
  const base = { supported: platform() === "win32", allowed: null, ruleName: FIREWALL_RULE, port: config.sharePort, error: null };
  if (!base.supported) return base;
  if (!force && firewallCache && Date.now() - firewallCache.at < 30_000) return firewallCache.status;
  let status: FirewallStatus;
  try {
    const { stdout } = await powershell(
      `(Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } | Measure-Object).Count`,
      15_000,
    );
    status = { ...base, allowed: Number(stdout.trim()) > 0 };
  } catch (err) {
    status = { ...base, error: err instanceof Error ? err.message : "firewall check failed" };
  }
  firewallCache = { at: Date.now(), status };
  return status;
}

export async function allowFirewall(): Promise<FirewallStatus> {
  if (platform() !== "win32") return firewallStatus(true);
  const rule = `advfirewall firewall add rule name="${FIREWALL_RULE}" dir=in action=allow protocol=TCP localport=${config.sharePort} profile=any`;
  try {
    await powershell(`Start-Process -FilePath netsh -ArgumentList '${rule}' -Verb RunAs -Wait`, 180_000);
  } catch (err) {
    firewallCache = null;
    const status = await firewallStatus(true);
    return { ...status, error: status.allowed ? null : err instanceof Error ? err.message : "the Windows prompt was cancelled" };
  }
  firewallCache = null;
  return firewallStatus(true);
}
