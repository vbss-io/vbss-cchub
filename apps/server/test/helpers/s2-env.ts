import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Sandbox } from "../helpers.js";
import { s1Listen, s1Request, s1Sandbox, s1Wait, type S1Listening, type S1Response } from "./s1-env.js";

export type S2Response = S1Response;

export const s2Sandbox = s1Sandbox;
export const s2Wait = s1Wait;

export function s2Git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

export function s2InitRepo(dir: string, files: Record<string, string> = { "README.md": "hello\n" }): void {
  mkdirSync(dir, { recursive: true });
  s2Git(dir, "init", "-q", "-b", "main");
  s2Git(dir, "config", "user.email", "s2@example.test");
  s2Git(dir, "config", "user.name", "S2 Test");
  s2Git(dir, "config", "commit.gpgsign", "false");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  s2Git(dir, "add", "-A");
  s2Git(dir, "commit", "-q", "-m", "initial");
}

export interface S2Hub {
  web: S1Listening;
  box: Sandbox;
  http: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<S2Response>;
  close: () => Promise<void>;
}

export async function s2StartHub(box: Sandbox): Promise<S2Hub> {
  mkdirSync(box.dataDir, { recursive: true });
  const { createApp, defaultAppDeps } = await import("../../src/app.js");
  const web = await s1Listen(createApp({ dataDir: box.dataDir, staticDir: null, previewMode: false, devSeed: false }, defaultAppDeps));
  return {
    web,
    box,
    http: (method, path, body, headers) => s1Request(web.base, method, path, body, headers),
    close: () => web.close(),
  };
}

export async function s2Until<T>(fn: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("s2Until timed out");
    await s1Wait(40);
  }
}

export function s2Today(offset = 0): string {
  const at = new Date();
  at.setDate(at.getDate() + offset);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

export const S2_DAILY_TEMPLATE = ["---", "type: daily", "created: {{date}}", "---", "", "# {{date}}", "", "## Focus", "", "- [ ]", "", "## Meetings", "", "-", "", "## Captures", "", "-", "", "## Sessions", "", "-", ""].join("\n");

export function s2WriteFile(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export async function s2ConfigureVault(hub: S2Hub, box: Sandbox, extra: Record<string, unknown> = {}): Promise<void> {
  const res = await hub.http("PUT", "/delegation/settings", {
    workspacesRoot: box.root,
    autonomy: "full",
    secondBrainRoot: box.brain,
    features: { daily: true, tasks: true, trail: false, usage: false, limits: false },
    tasks: { root: "projects", doneSection: "Done loops" },
    daily: { dir: "daily", template: "_templates/daily.md", wikilinks: true, focusSource: "scheduled", headings: { focus: "Focus", meetings: "Meetings", sessions: "Sessions", captures: "Captures" } },
    ...extra,
  });
  if (res.status !== 200) throw new Error(`vault settings refused: ${res.text}`);
}

export function s2Zip(workDir: string, entries: Record<string, string>): Buffer {
  const source = mkdtempSync(join(workDir, "zip-src-"));
  const files: string[] = [];
  for (const [name, content] of Object.entries(entries)) {
    writeFileSync(join(source, name), content);
    files.push(join(source, name));
  }
  const target = join(workDir, `bundle-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);
  const list = files.map((file) => `'${file.replace(/'/g, "''")}'`).join(",");
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -LiteralPath ${list} -DestinationPath '${target}' -Force`], { windowsHide: true });
  if (result.status !== 0) throw new Error(`zip failed: ${String(result.stderr)}`);
  return readFileSync(target);
}
