import { execFile, execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { TaskRecord } from "./delegation-types.js";
import { isReadOnlyGit } from "./worktrees.js";

export const DIFF_FILE_LINES = 400;
export const DIFF_FULL_FILE_LINES = 5000;
export const DIFF_MAX_FILES = 300;
export const DIFF_MAX_UNTRACKED = 200;
export const DIFF_UNTRACKED_MAX_BYTES = 1_048_576;
const DIFF_MAX_BUFFER = 32 * 1_048_576;
const GIT_TIMEOUT_MS = 15_000;
const HEAD_TIMEOUT_MS = 3_000;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const CONTEXT_MAX = 200;

export type DiffLineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  tooLarge: boolean;
  additions: number;
  deletions: number;
  totalLines: number;
  shownLines: number;
  truncated: boolean;
  hunks: DiffHunk[];
}

export type DiffBaseKind = "worktree" | "start-commit" | "head";

export interface DiffBase {
  kind: DiffBaseKind;
  ref: string;
  label: string;
}

export interface DiffReady {
  available: true;
  root: string;
  base: DiffBase;
  files: DiffFile[];
  filesTruncated: boolean;
  totals: { files: number; additions: number; deletions: number };
}

export interface DiffUnavailable {
  available: false;
  reason: string;
}

export type DiffResult = DiffReady | DiffUnavailable;

export interface DiffTarget {
  dir: string;
  baseRef: string | null;
  baseKind: DiffBaseKind;
  baseBranch: string | null;
}

export interface DiffOptions {
  file?: string | null;
  maxLines?: number;
}

class GitReadError extends Error {
  constructor(
    message: string,
    readonly tooLarge: boolean,
  ) {
    super(message);
    this.name = "GitReadError";
  }
}

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.quotepath",
  GIT_CONFIG_VALUE_0: "false",
});

export function gitRead(dir: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  if (!isReadOnlyGit(args)) return Promise.reject(new GitReadError(`git ${args[0] ?? ""} is not a read-only command`, false));
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: DIFF_MAX_BUFFER, env: gitEnv() }, (err, stdout) => {
      if (err) {
        const tooLarge = (err as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        reject(new GitReadError(tooLarge ? "the diff is too large to show" : err.message, tooLarge));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

export function headCommit(dir: string | null): string | null {
  if (!dir || !existsSync(dir)) return null;
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: HEAD_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    }).trim();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

export function taskGitDir(task: TaskRecord, repoPath: string | null): string {
  if (task.isolation === "worktree" && task.worktreePath && existsSync(task.worktreePath)) return task.worktreePath;
  return repoPath ?? task.cwd;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const GIT_HEADER_RE = /^diff --git a\/(.*) b\/(.*)$/;

const stripCr = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line);

const newFile = (path: string): DiffFile => ({
  path,
  oldPath: null,
  status: "modified",
  binary: false,
  tooLarge: false,
  additions: 0,
  deletions: 0,
  totalLines: 0,
  shownLines: 0,
  truncated: false,
  hunks: [],
});

const unprefix = (value: string, prefix: string): string | null => (value === "/dev/null" ? null : value.startsWith(prefix) ? value.slice(prefix.length) : value);

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of text.split("\n")) {
    const line = stripCr(raw);
    if (hunk && file && (oldLeft > 0 || newLeft > 0)) {
      const mark = line.charAt(0);
      if (mark === "\\") continue;
      if (mark === "+") {
        hunk.lines.push({ kind: "add", oldLine: null, newLine: newNo, text: line.slice(1) });
        newNo += 1;
        newLeft -= 1;
        file.additions += 1;
        continue;
      }
      if (mark === "-") {
        hunk.lines.push({ kind: "del", oldLine: oldNo, newLine: null, text: line.slice(1) });
        oldNo += 1;
        oldLeft -= 1;
        file.deletions += 1;
        continue;
      }
      if (mark === " " || line === "") {
        hunk.lines.push({ kind: "ctx", oldLine: oldNo, newLine: newNo, text: line.slice(1) });
        oldNo += 1;
        newNo += 1;
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
    }
    if (line.startsWith("diff --git ")) {
      const match = GIT_HEADER_RE.exec(line);
      file = newFile(match?.[2] ?? line.slice("diff --git ".length));
      if (match?.[1] && match[1] !== match[2]) file.oldPath = match[1];
      files.push(file);
      hunk = null;
      oldLeft = 0;
      newLeft = 0;
      continue;
    }
    if (!file) continue;
    if (line.charAt(0) === "\\") continue;
    const header = HUNK_RE.exec(line);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[3]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      hunk = { header: line, oldStart: oldNo, oldLines: oldLeft, newStart: newNo, newLines: newLeft, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.path = line.slice("rename to ".length);
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
    else if (line.startsWith("--- ")) {
      const old = unprefix(line.slice(4), "a/");
      if (old === null) file.status = "added";
      else if (old !== file.path) file.oldPath = old;
    } else if (line.startsWith("+++ ")) {
      const next = unprefix(line.slice(4), "b/");
      if (next === null) {
        file.status = "deleted";
        if (file.oldPath) file.path = file.oldPath;
      } else file.path = next;
    }
  }
  for (const item of files) {
    if (item.status === "deleted" || item.status === "added") item.oldPath = null;
    item.totalLines = item.hunks.reduce((sum, part) => sum + part.lines.length, 0);
    item.shownLines = item.totalLines;
  }
  return files;
}

export function capFile(file: DiffFile, maxLines: number): DiffFile {
  if (file.totalLines <= maxLines) return file;
  const hunks: DiffHunk[] = [];
  let left = maxLines;
  for (const hunk of file.hunks) {
    if (left <= 0) break;
    const lines = hunk.lines.slice(0, left);
    hunks.push({ ...hunk, lines });
    left -= lines.length;
  }
  return { ...file, hunks, shownLines: maxLines, truncated: true };
}

function untrackedFile(root: string, rel: string): DiffFile {
  const file: DiffFile = { ...newFile(rel), status: "untracked" };
  const full = resolve(root, rel);
  if (!full.startsWith(resolve(root) + sep)) return { ...file, tooLarge: true };
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return file;
  }
  if (!stat.isFile()) return { ...file, binary: true };
  if (stat.size > DIFF_UNTRACKED_MAX_BYTES) return { ...file, tooLarge: true };
  const buffer = readFileSync(full);
  if (buffer.includes(0)) return { ...file, binary: true };
  const text = buffer.toString("utf8");
  const lines = text.split("\n").map(stripCr);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return file;
  const hunk: DiffHunk = {
    header: `@@ -0,0 +1,${lines.length} @@`,
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines: lines.map((value, index) => ({ kind: "add", oldLine: null, newLine: index + 1, text: value })),
  };
  return { ...file, additions: lines.length, totalLines: lines.length, shownLines: lines.length, hunks: [hunk] };
}

async function resolveBase(root: string, target: DiffTarget): Promise<DiffBase> {
  const verified = async (ref: string): Promise<string | null> => {
    try {
      return (await gitRead(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim() || null;
    } catch {
      return null;
    }
  };
  if (target.baseKind === "worktree" && target.baseBranch) {
    try {
      const mergeBase = (await gitRead(root, ["merge-base", target.baseBranch, "HEAD"])).trim();
      if (mergeBase) return { kind: "worktree", ref: mergeBase, label: `${target.baseBranch} (merge base ${mergeBase.slice(0, 7)})` };
    } catch {
      void 0;
    }
  }
  if (target.baseRef) {
    const sha = await verified(target.baseRef);
    if (sha) return { kind: "start-commit", ref: sha, label: `starting commit ${sha.slice(0, 7)}` };
  }
  const head = await verified("HEAD");
  if (head) return { kind: "head", ref: head, label: `HEAD ${head.slice(0, 7)}` };
  return { kind: "head", ref: EMPTY_TREE, label: "empty repository" };
}

export async function computeDiff(target: DiffTarget, options: DiffOptions = {}): Promise<DiffResult> {
  if (!target.dir || !existsSync(target.dir)) return { available: false, reason: "the working directory no longer exists" };
  let root: string;
  try {
    root = (await gitRead(target.dir, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return { available: false, reason: "not a git repository" };
  }
  if (!root) return { available: false, reason: "not a git repository" };
  const base = await resolveBase(root, target);
  let tracked: DiffFile[];
  let untrackedPaths: string[];
  try {
    tracked = parseUnifiedDiff(await gitRead(root, ["diff", "--no-color", "--no-ext-diff", "-M", base.ref]));
    untrackedPaths = (await gitRead(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter((path) => path.length > 0);
  } catch (err) {
    return { available: false, reason: err instanceof GitReadError && err.tooLarge ? err.message : `git diff failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const untracked = untrackedPaths.slice(0, DIFF_MAX_UNTRACKED).map((path) => untrackedFile(root, path));
  let all = [...tracked, ...untracked];
  const extraUntracked = untrackedPaths.length > DIFF_MAX_UNTRACKED;
  if (options.file) all = all.filter((file) => file.path === options.file || file.oldPath === options.file);
  const maxLines = options.maxLines ?? (options.file ? DIFF_FULL_FILE_LINES : DIFF_FILE_LINES);
  const totals = {
    files: all.length,
    additions: all.reduce((sum, file) => sum + file.additions, 0),
    deletions: all.reduce((sum, file) => sum + file.deletions, 0),
  };
  const shown = all.slice(0, DIFF_MAX_FILES).map((file) => capFile(file, maxLines));
  return { available: true, root, base, files: shown, filesTruncated: all.length > DIFF_MAX_FILES || (!options.file && extraUntracked), totals };
}

export type ReviewSide = "new" | "old";

export interface ReviewComment {
  file: string;
  line: number;
  side: ReviewSide;
  text: string;
}

export const REVIEW_MAX_COMMENTS = 200;
export const REVIEW_MAX_TEXT = 4000;

export function parseReviewComments(raw: unknown): ReviewComment[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "comments must be a non-empty array";
  if (raw.length > REVIEW_MAX_COMMENTS) return `at most ${REVIEW_MAX_COMMENTS} comments`;
  const out: ReviewComment[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return "each comment must be an object";
    const { file, line, side, text } = item as Record<string, unknown>;
    if (typeof file !== "string" || file.trim() === "" || /[\r\n]/.test(file)) return "comment.file must be a single-line path";
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return "comment.line must be a positive integer";
    if (side !== undefined && side !== "new" && side !== "old") return "comment.side must be new or old";
    if (typeof text !== "string" || text.trim() === "") return "comment.text required";
    out.push({ file: file.trim(), line, side: side === "old" ? "old" : "new", text: text.trim().slice(0, REVIEW_MAX_TEXT) });
  }
  return out;
}

function contextLine(files: readonly DiffFile[], comment: ReviewComment): string | null {
  const file = files.find((item) => item.path === comment.file) ?? files.find((item) => item.oldPath === comment.file);
  if (!file) return null;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const hit = comment.side === "old" ? line.oldLine === comment.line && line.kind !== "add" : line.newLine === comment.line && line.kind !== "del";
      if (hit) {
        const text = line.text.trim();
        return text.length > CONTEXT_MAX ? `${text.slice(0, CONTEXT_MAX)}…` : text;
      }
    }
  }
  return null;
}

export function composeReview(comments: readonly ReviewComment[], files: readonly DiffFile[] = []): string {
  const order = new Map<string, number>();
  files.forEach((file, index) => order.set(file.path, index));
  const groups = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const list = groups.get(comment.file) ?? [];
    list.push(comment);
    groups.set(comment.file, list);
  }
  const fileNames = [...groups.keys()].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
  const total = comments.length;
  const lines = [`Review of your changes (${total} comment${total === 1 ? "" : "s"}). Address each one, then summarize what you changed.`];
  for (const name of fileNames) {
    const list = [...(groups.get(name) ?? [])].sort((a, b) => a.line - b.line || (a.side === b.side ? 0 : a.side === "new" ? -1 : 1));
    lines.push("", name);
    for (const comment of list) {
      const removed = comment.side === "old" ? " (removed line)" : "";
      lines.push(`- ${name}:${comment.line}${removed}`);
      const context = contextLine(files, comment);
      if (context) lines.push(`  > ${context}`);
      for (const textLine of comment.text.split(/\r?\n/)) lines.push(`  ${textLine}`);
    }
  }
  return lines.join("\n");
}
