import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { gitRead } from "./review-diff.js";

const GH_TIMEOUT_MS = 12_000;
const GH_MAX_BUFFER = 4 * 1_048_576;
export const GH_CACHE_MS = 60_000;
const RUN_LIMIT = 5;

const PR_FIELDS = "number,title,state,url,statusCheckRollup,headRefName,isDraft";
const RUN_FIELDS = "databaseId,displayTitle,status,conclusion,workflowName,url,createdAt,headBranch,event";

export type CheckState = "passing" | "failing" | "pending" | "none";

export interface GhChecks {
  total: number;
  passing: number;
  failing: number;
  pending: number;
  state: CheckState;
}

export interface GhPullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
  headRefName: string;
  isDraft: boolean;
  checks: GhChecks;
}

export interface GhRun {
  id: number | null;
  title: string;
  workflow: string | null;
  status: string | null;
  conclusion: string | null;
  url: string | null;
  createdAt: string | null;
  branch: string | null;
  event: string | null;
}

export interface GhAvailable {
  available: true;
  branch: string;
  pr: GhPullRequest | null;
  runs: GhRun[];
  fetchedAt: number;
}

export interface GhUnavailable {
  available: false;
  reason: string;
}

export type GhStatus = GhAvailable | GhUnavailable;

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export function isReadOnlyGh(args: readonly string[]): boolean {
  const [command, sub] = args;
  if (command === "--version") return args.length === 1;
  if (command === "auth") return sub === "status";
  if (command === "pr") return sub === "view";
  if (command === "run") return sub === "list" || sub === "view";
  return false;
}

interface GhOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  missing: boolean;
}

function ghCommand(): { bin: string; prefix: string[] } {
  const bin = process.env.HUB_GH_BIN?.trim() || "gh";
  let prefix: string[] = [];
  try {
    const parsed: unknown = JSON.parse(process.env.HUB_GH_ARGS_PREFIX ?? "[]");
    prefix = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    prefix = [];
  }
  return { bin, prefix };
}

export function runGh(args: string[], cwd: string | undefined = undefined): Promise<GhOutcome> {
  if (!isReadOnlyGh(args)) return Promise.reject(new Error(`gh ${args.join(" ")} is not a read-only command`));
  const command = ghCommand();
  return new Promise((resolvePromise) => {
    execFile(
      command.bin,
      [...command.prefix, ...args],
      { cwd, encoding: "utf8", windowsHide: true, timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } },
      (err, stdout, stderr) => {
        const code = err ? (err as NodeJS.ErrnoException).code : undefined;
        resolvePromise({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "", missing: code === "ENOENT" });
      },
    );
  });
}

export function summarizeChecks(rollup: unknown): GhChecks {
  const items = Array.isArray(rollup) ? rollup.map(asObject).filter((item): item is Json => item !== null) : [];
  let passing = 0;
  let failing = 0;
  let pending = 0;
  for (const item of items) {
    const conclusion = (str(item.conclusion) ?? str(item.state) ?? "").toUpperCase();
    const status = (str(item.status) ?? "").toUpperCase();
    if (status && status !== "COMPLETED") pending += 1;
    else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) passing += 1;
    else if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", ""].includes(conclusion)) pending += 1;
    else failing += 1;
  }
  const state: CheckState = items.length === 0 ? "none" : failing > 0 ? "failing" : pending > 0 ? "pending" : "passing";
  return { total: items.length, passing, failing, pending, state };
}

export function parsePullRequest(raw: unknown): GhPullRequest | null {
  const obj = asObject(raw);
  if (!obj || typeof obj.number !== "number") return null;
  return {
    number: obj.number,
    title: str(obj.title) ?? "",
    state: str(obj.state) ?? "UNKNOWN",
    url: str(obj.url) ?? "",
    headRefName: str(obj.headRefName) ?? "",
    isDraft: obj.isDraft === true,
    checks: summarizeChecks(obj.statusCheckRollup),
  };
}

export function parseRuns(raw: unknown): GhRun[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(asObject)
    .filter((item): item is Json => item !== null)
    .slice(0, RUN_LIMIT)
    .map((item) => ({
      id: typeof item.databaseId === "number" ? item.databaseId : null,
      title: str(item.displayTitle) ?? "",
      workflow: str(item.workflowName),
      status: str(item.status),
      conclusion: str(item.conclusion),
      url: str(item.url),
      createdAt: str(item.createdAt),
      branch: str(item.headBranch),
      event: str(item.event),
    }));
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

interface GhPresence {
  at: number;
  reason: string | null;
}

let presence: GhPresence | null = null;
const cache = new Map<string, { at: number; value: GhStatus }>();

export function resetGhCache(): void {
  presence = null;
  cache.clear();
}

async function ghReady(now: number): Promise<string | null> {
  if (presence && now - presence.at < GH_CACHE_MS) return presence.reason;
  const version = await runGh(["--version"]);
  let reason: string | null = null;
  if (!version.ok) reason = version.missing ? "gh is not installed" : "gh could not run";
  else {
    const auth = await runGh(["auth", "status"]);
    if (!auth.ok) reason = "gh is not logged in";
  }
  presence = { at: now, reason };
  return reason;
}

async function currentBranch(dir: string): Promise<string | null> {
  try {
    const branch = (await gitRead(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

export async function ghStatus(dir: string | null, branchHint: string | null = null, now: number = Date.now()): Promise<GhStatus> {
  if (!dir || !existsSync(dir)) return { available: false, reason: "no working directory" };
  const missing = await ghReady(now);
  if (missing) return { available: false, reason: missing };
  const branch = branchHint ?? (await currentBranch(dir));
  if (!branch) return { available: false, reason: "not on a git branch" };
  const key = `${dir}\0${branch}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < GH_CACHE_MS) return hit.value;
  const [pr, runs] = await Promise.all([
    runGh(["pr", "view", branch, "--json", PR_FIELDS], dir),
    runGh(["run", "list", "--branch", branch, "--limit", String(RUN_LIMIT), "--json", RUN_FIELDS], dir),
  ]);
  const value: GhStatus = {
    available: true,
    branch,
    pr: pr.ok ? parsePullRequest(parseJson(pr.stdout)) : null,
    runs: runs.ok ? parseRuns(parseJson(runs.stdout)) : [],
    fetchedAt: now,
  };
  cache.set(key, { at: now, value });
  return value;
}
