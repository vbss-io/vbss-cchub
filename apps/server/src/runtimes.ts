import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const CACHE_MS = 8_000;

export interface ProcessRow {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
  executablePath: string;
}

export interface RuntimeGroup {
  running: boolean;
  count: number;
  pids: number[];
}

export interface RuntimeSnapshot {
  claudeCode: RuntimeGroup & { headless: number };
  claudeDesktop: RuntimeGroup;
  codexApp: RuntimeGroup;
  codexCli: RuntimeGroup;
  scannedAt: number;
  error: string | null;
}

const group = (pids: number[]): RuntimeGroup => ({ running: pids.length > 0, count: pids.length, pids });

const isElectronChild = (commandLine: string): boolean => /--type=/.test(commandLine);

export function classify(rows: ProcessRow[], scannedAt: number): RuntimeSnapshot {
  const claudeCode: number[] = [];
  const claudeDesktop: number[] = [];
  const codexApp: number[] = [];
  const codexCli: number[] = [];
  let headless = 0;
  for (const row of rows) {
    const name = row.name.toLowerCase();
    const cmd = row.commandLine ?? "";
    const exe = (row.executablePath ?? "").toLowerCase();
    if (name === "claude.exe" || name === "claude") {
      const desktop = exe.includes("windowsapps\\claude_") || exe.includes("claude.app/") || cmd.includes("--user-data-dir");
      if (desktop) {
        if (!isElectronChild(cmd)) claudeDesktop.push(row.pid);
        continue;
      }
      claudeCode.push(row.pid);
      if (/\s(-p|--print)(\s|$)/.test(cmd)) headless += 1;
      continue;
    }
    if (name === "codex.exe" || name === "codex") {
      if (/\sapp-server(\s|$)/.test(cmd)) codexApp.push(row.pid);
      else if (!/\smcp-server(\s|$)/.test(cmd)) codexCli.push(row.pid);
    }
  }
  return {
    claudeCode: { ...group(claudeCode), headless },
    claudeDesktop: group(claudeDesktop),
    codexApp: group(codexApp),
    codexCli: group(codexCli),
    scannedAt,
    error: null,
  };
}

interface CimRow {
  ProcessId?: number;
  ParentProcessId?: number;
  Name?: string;
  CommandLine?: string | null;
  ExecutablePath?: string | null;
}

async function scanWindows(): Promise<ProcessRow[]> {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name LIKE 'claude%' OR Name LIKE 'codex%'\" | " +
    "Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress";
  const { stdout } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 10_000,
    windowsHide: true,
  });
  const text = stdout.trim();
  if (text.length === 0) return [];
  const parsed: unknown = JSON.parse(text);
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as CimRow[];
  return rows.map((row) => ({
    pid: Number(row.ProcessId ?? 0),
    parentPid: Number(row.ParentProcessId ?? 0),
    name: row.Name ?? "",
    commandLine: row.CommandLine ?? "",
    executablePath: row.ExecutablePath ?? "",
  }));
}

async function scanPosix(): Promise<ProcessRow[]> {
  const { stdout } = await run("ps", ["-eo", "pid=,ppid=,comm=,args="], { timeout: 10_000 });
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const comm = match[3] ?? "";
    const base = comm.split("/").pop() ?? comm;
    if (!/^(claude|codex)$/i.test(base)) continue;
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      name: base,
      commandLine: match[4] ?? "",
      executablePath: comm,
    });
  }
  return rows;
}

let cached: RuntimeSnapshot | null = null;
let inFlight: Promise<RuntimeSnapshot> | null = null;

export async function runtimeSnapshot(): Promise<RuntimeSnapshot> {
  const now = Date.now();
  if (cached && now - cached.scannedAt < CACHE_MS) return cached;
  if (inFlight) return inFlight;
  inFlight = (process.platform === "win32" ? scanWindows() : scanPosix())
    .then((rows) => classify(rows, Date.now()))
    .catch((err: unknown) => ({
      ...classify([], Date.now()),
      error: err instanceof Error ? err.message : "process scan failed",
    }))
    .then((snapshot) => {
      cached = snapshot;
      inFlight = null;
      return snapshot;
    });
  return inFlight;
}
