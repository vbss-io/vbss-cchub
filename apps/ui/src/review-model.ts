import type { DiffFile, DiffLine, DiffResult, ReviewComment, ReviewSendResult } from "./types";

export type ReviewSide = "new" | "old";

export interface DraftComment {
  file: string;
  line: number;
  side: ReviewSide;
  text: string;
}

export interface LineAnchor {
  line: number;
  side: ReviewSide;
}

export const COMMENT_TEXT_MAX = 4000;

export const COMMENTS_MAX = 200;

const CONTEXT_MAX = 200;

export const commentKey = (file: string, line: number, side: ReviewSide): string => `${file}::${side}:${line}`;

export const keyOf = (comment: DraftComment): string => commentKey(comment.file, comment.line, comment.side);

export function lineAnchor(line: DiffLine): LineAnchor | null {
  if (line.kind === "del") return line.oldLine === null ? null : { line: line.oldLine, side: "old" };
  return line.newLine === null ? null : { line: line.newLine, side: "new" };
}

export function upsertComment(list: readonly DraftComment[], comment: DraftComment): DraftComment[] {
  const key = keyOf(comment);
  const text = comment.text.trim().slice(0, COMMENT_TEXT_MAX);
  const index = list.findIndex((item) => keyOf(item) === key);
  if (text.length === 0) return list.filter((item) => keyOf(item) !== key);
  if (index < 0 && list.length >= COMMENTS_MAX) return [...list];
  const next = { ...comment, text };
  if (index < 0) return [...list, next];
  const copy = [...list];
  copy[index] = next;
  return copy;
}

export const removeComment = (list: readonly DraftComment[], key: string): DraftComment[] => list.filter((item) => keyOf(item) !== key);

export const findComment = (list: readonly DraftComment[], file: string, line: number, side: ReviewSide): DraftComment | undefined =>
  list.find((item) => item.file === file && item.line === line && item.side === side);

export const commentsInFile = (list: readonly DraftComment[], file: string): number => list.filter((item) => item.file === file).length;

export const toReviewComments = (list: readonly DraftComment[]): ReviewComment[] => list.map(({ file, line, side, text }) => ({ file, line, side, text }));

const contextFor = (files: readonly DiffFile[], comment: DraftComment): string | null => {
  const file = files.find((item) => item.path === comment.file) ?? files.find((item) => item.oldPath === comment.file);
  if (!file) return null;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const hit = comment.side === "old" ? line.oldLine === comment.line && line.kind !== "add" : line.newLine === comment.line && line.kind !== "del";
      if (!hit) continue;
      const text = line.text.trim();
      return text.length > CONTEXT_MAX ? `${text.slice(0, CONTEXT_MAX)}…` : text;
    }
  }
  return null;
};

export function composePreview(comments: readonly DraftComment[], files: readonly DiffFile[] = []): string {
  const order = new Map<string, number>();
  files.forEach((file, index) => order.set(file.path, index));
  const groups = new Map<string, DraftComment[]>();
  for (const comment of comments) groups.set(comment.file, [...(groups.get(comment.file) ?? []), comment]);
  const names = [...groups.keys()].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
  const total = comments.length;
  const lines = [`Review of your changes (${total} comment${total === 1 ? "" : "s"}). Address each one, then summarize what you changed.`];
  for (const name of names) {
    const list = [...(groups.get(name) ?? [])].sort((a, b) => a.line - b.line || (a.side === b.side ? 0 : a.side === "new" ? -1 : 1));
    lines.push("", name);
    for (const comment of list) {
      lines.push(`- ${name}:${comment.line}${comment.side === "old" ? " (removed line)" : ""}`);
      const context = contextFor(files, comment);
      if (context) lines.push(`  > ${context}`);
      for (const text of comment.text.split(/\r?\n/)) lines.push(`  ${text}`);
    }
  }
  return lines.join("\n");
}

export function reviewSummary(list: readonly DraftComment[]): string {
  if (list.length === 0) return "No comments yet";
  const files = new Set(list.map((item) => item.file)).size;
  return `${list.length} comment${list.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`;
}

export const mergeFileDetail = (files: readonly DiffFile[], detail: DiffFile): DiffFile[] => files.map((file) => (file.path === detail.path ? detail : file));

export const fileLabel = (file: Pick<DiffFile, "path" | "oldPath" | "status">): string =>
  file.status === "renamed" && file.oldPath !== null ? `${file.oldPath} to ${file.path}` : file.path;

export function totalsLine(totals: { files: number; additions: number; deletions: number }): string {
  return `${totals.files} file${totals.files === 1 ? "" : "s"} · +${totals.additions} -${totals.deletions}`;
}

export function fileNote(file: Pick<DiffFile, "binary" | "tooLarge" | "truncated" | "shownLines" | "totalLines">): string | null {
  if (file.binary) return "Binary file, no text diff";
  if (file.tooLarge) return "File too large to show";
  if (file.truncated) return `Showing ${file.shownLines.toLocaleString("en-US")} of ${file.totalLines.toLocaleString("en-US")} lines`;
  return null;
}

export const canShowMore = (file: Pick<DiffFile, "binary" | "tooLarge" | "truncated">): boolean => file.truncated && !file.binary && !file.tooLarge;

export function diffNotes(diff: Extract<DiffResult, { available: true }>): string[] {
  const notes: string[] = [];
  if (diff.filesTruncated) notes.push("The list is cut off: only the first files are shown");
  if (diff.files.some((file) => file.truncated)) notes.push("Long files are cut off: use Show more inside the file");
  return notes;
}

export const initialOpenPaths = (files: readonly DiffFile[]): string[] => (files.length <= 3 ? files.map((file) => file.path) : []);

export const STATUS_MARK: Readonly<Record<DiffFile["status"], string>> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

export type ReviewTarget = { kind: "task"; running: boolean } | { kind: "session" };

export interface SendPlan {
  label: string;
  disabled: boolean;
  hint: string;
}

export function sendPlan(target: ReviewTarget, comments: number, busy: boolean): SendPlan {
  const label = "Send review";
  if (comments === 0) return { label, disabled: true, hint: "Click a line to add a comment first" };
  if (busy) return { label, disabled: true, hint: "Sending" };
  if (target.kind === "task") {
    return target.running
      ? { label, disabled: true, hint: "Wait for the run to finish" }
      : { label, disabled: false, hint: "Sends the comments to the agent as a follow-up on this task" };
  }
  return { label, disabled: false, hint: "Copies the comments so you can paste them into the session" };
}

export interface ReviewOutcome {
  text: string;
  taskId: string | null;
  sessionId: string | null;
  copy: string | null;
}

export function reviewOutcome(result: ReviewSendResult): ReviewOutcome {
  if (result.mode === "continue") return { text: "Review sent as a follow-up on this task.", taskId: result.taskId, sessionId: null, copy: null };
  if (result.mode === "new-task") return { text: "This task cannot be resumed, so the review started a new task.", taskId: result.taskId, sessionId: null, copy: null };
  if (result.mode === "copy") return { text: "Review copied. Paste it into the session.", taskId: null, sessionId: result.sessionId, copy: result.text };
  return { text: "Preview only, nothing was sent.", taskId: null, sessionId: null, copy: null };
}

export const unavailableText = (reason: string): string => (reason.length > 0 ? `No diff to review: ${reason}.` : "No diff to review.");
