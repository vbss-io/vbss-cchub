import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  canShowMore,
  commentKey,
  commentsInFile,
  composePreview,
  diffNotes,
  fileLabel,
  fileNote,
  findComment,
  initialOpenPaths,
  lineAnchor,
  mergeFileDetail,
  removeComment,
  reviewOutcome,
  reviewSummary,
  sendPlan,
  toReviewComments,
  totalsLine,
  unavailableText,
  upsertComment,
  type DraftComment,
} from "./review-model";
import type { DiffFile, DiffLine, DiffResult } from "./types";

const line = (patch: Partial<DiffLine>): DiffLine => ({ kind: "ctx", oldLine: null, newLine: null, text: "", ...patch });

const file = (patch: Partial<DiffFile> = {}): DiffFile => ({
  path: "src/a.ts",
  oldPath: null,
  status: "modified",
  binary: false,
  tooLarge: false,
  additions: 1,
  deletions: 1,
  totalLines: 4,
  shownLines: 4,
  truncated: false,
  hunks: [
    {
      header: "@@ -1,3 +1,3 @@",
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [
        line({ kind: "ctx", oldLine: 1, newLine: 1, text: "const a = 1;" }),
        line({ kind: "del", oldLine: 2, text: "const b = 2;" }),
        line({ kind: "add", newLine: 2, text: "  const b = 3;  " }),
        line({ kind: "ctx", oldLine: 3, newLine: 3, text: "export { a, b };" }),
      ],
    },
  ],
  ...patch,
});

const draft = (patch: Partial<DraftComment> = {}): DraftComment => ({ file: "src/a.ts", line: 2, side: "new", text: "Use a named constant", ...patch });

const HEADER_ONE = "Review of your changes (1 comment). Address each one, then summarize what you changed.";

describe("lineAnchor", () => {
  it("anchors added and context lines on the new side and removed lines on the old side", () => {
    assert.deepEqual(lineAnchor(line({ kind: "add", newLine: 7 })), { line: 7, side: "new" });
    assert.deepEqual(lineAnchor(line({ kind: "ctx", oldLine: 6, newLine: 7 })), { line: 7, side: "new" });
    assert.deepEqual(lineAnchor(line({ kind: "del", oldLine: 4 })), { line: 4, side: "old" });
  });

  it("returns nothing for a line without a number", () => {
    assert.equal(lineAnchor(line({ kind: "add", newLine: null })), null);
    assert.equal(lineAnchor(line({ kind: "del", oldLine: null })), null);
  });
});

describe("comment list", () => {
  it("adds a comment and replaces the one on the same line and side", () => {
    const first = upsertComment([], draft());
    assert.equal(first.length, 1);
    const edited = upsertComment(first, draft({ text: "Changed my mind" }));
    assert.equal(edited.length, 1);
    assert.equal(edited[0]?.text, "Changed my mind");
  });

  it("keeps the old and new side of the same number apart", () => {
    const list = upsertComment(upsertComment([], draft()), draft({ side: "old", text: "Why was this removed" }));
    assert.equal(list.length, 2);
    assert.equal(findComment(list, "src/a.ts", 2, "old")?.text, "Why was this removed");
  });

  it("trims the text and drops the comment when it becomes empty", () => {
    const list = upsertComment([], draft({ text: "  hello  " }));
    assert.equal(list[0]?.text, "hello");
    assert.deepEqual(upsertComment(list, draft({ text: "   " })), []);
  });

  it("removes a comment by key and counts by file", () => {
    const list = upsertComment(upsertComment([], draft()), draft({ file: "src/b.ts", line: 9 }));
    assert.equal(commentsInFile(list, "src/a.ts"), 1);
    const left = removeComment(list, commentKey("src/a.ts", 2, "new"));
    assert.deepEqual(left.map((item) => item.file), ["src/b.ts"]);
  });

  it("builds the request payload without extra fields", () => {
    assert.deepEqual(toReviewComments([draft()]), [{ file: "src/a.ts", line: 2, side: "new", text: "Use a named constant" }]);
  });

  it("summarises the review", () => {
    assert.equal(reviewSummary([]), "No comments yet");
    assert.equal(reviewSummary([draft()]), "1 comment in 1 file");
    assert.equal(reviewSummary([draft(), draft({ line: 3 }), draft({ file: "b" })]), "3 comments in 2 files");
  });

  it("stops adding new comments at the server limit but still edits existing ones", () => {
    const full = Array.from({ length: 200 }, (_, index) => draft({ line: index + 1 }));
    assert.equal(upsertComment(full, draft({ line: 500 })).length, 200);
    assert.equal(upsertComment(full, draft({ line: 1, text: "edited" })).find((item) => item.line === 1)?.text, "edited");
  });
});

describe("composePreview", () => {
  it("turns comments into file:line text with the context line", () => {
    assert.equal(composePreview([draft()], [file()]), [HEADER_ONE, "", "src/a.ts", "- src/a.ts:2", "  > const b = 3;", "  Use a named constant"].join("\n"));
  });

  it("marks removed lines and quotes the old line", () => {
    assert.match(composePreview([draft({ side: "old", text: "Keep this" })], [file()]), /- src\/a\.ts:2 \(removed line\)\n {2}> const b = 2;/);
  });

  it("orders files like the diff and lines ascending, new before old", () => {
    const files = [file({ path: "src/a.ts" }), file({ path: "src/b.ts", hunks: [] })];
    const text = composePreview(
      [draft({ file: "src/b.ts", line: 5, text: "B" }), draft({ line: 3, text: "late" }), draft({ line: 1, text: "early" }), draft({ line: 1, side: "old", text: "old one" })],
      files,
    );
    const order = text.split("\n").filter((row) => row.startsWith("- "));
    assert.deepEqual(order, ["- src/a.ts:1", "- src/a.ts:1 (removed line)", "- src/a.ts:3", "- src/b.ts:5"]);
  });

  it("splits a multi line comment and omits the context when the line is unknown", () => {
    assert.equal(composePreview([draft({ file: "x.ts", line: 40, text: "first\nsecond" })], []), [HEADER_ONE, "", "x.ts", "- x.ts:40", "  first", "  second"].join("\n"));
  });

  it("pluralises the header", () => {
    assert.match(composePreview([draft(), draft({ line: 3 })], [file()]), /^Review of your changes \(2 comments\)/);
  });
});

describe("file labels and notes", () => {
  it("names a rename with both paths", () => {
    assert.equal(fileLabel(file({ status: "renamed", oldPath: "old.ts", path: "new.ts" })), "old.ts to new.ts");
    assert.equal(fileLabel(file()), "src/a.ts");
  });

  it("shows the truncated flag, binary and too large notes", () => {
    assert.equal(fileNote(file({ truncated: true, shownLines: 400, totalLines: 1200 })), "Showing 400 of 1,200 lines");
    assert.equal(fileNote(file({ binary: true })), "Binary file, no text diff");
    assert.equal(fileNote(file({ tooLarge: true })), "File too large to show");
    assert.equal(fileNote(file()), null);
  });

  it("offers Show more only for truncated text files", () => {
    assert.equal(canShowMore(file({ truncated: true })), true);
    assert.equal(canShowMore(file({ truncated: true, tooLarge: true })), false);
    assert.equal(canShowMore(file({ truncated: true, binary: true })), false);
    assert.equal(canShowMore(file()), false);
  });

  it("swaps a file for its expanded version", () => {
    const merged = mergeFileDetail([file({ path: "a" }), file({ path: "b", shownLines: 400, truncated: true })], file({ path: "b", shownLines: 900, truncated: false }));
    assert.deepEqual(merged.map((item) => [item.path, item.shownLines, item.truncated]), [["a", 4, false], ["b", 900, false]]);
  });

  it("opens every file for a small diff and none for a big one", () => {
    assert.deepEqual(initialOpenPaths([file({ path: "a" }), file({ path: "b" })]), ["a", "b"]);
    assert.deepEqual(initialOpenPaths([file({ path: "a" }), file({ path: "b" }), file({ path: "c" }), file({ path: "d" })]), []);
  });

  it("writes the totals line", () => {
    assert.equal(totalsLine({ files: 1, additions: 3, deletions: 0 }), "1 file · +3 -0");
    assert.equal(totalsLine({ files: 4, additions: 30, deletions: 12 }), "4 files · +30 -12");
  });

  it("explains why there is no diff", () => {
    assert.equal(unavailableText("not a git repository"), "No diff to review: not a git repository.");
    assert.equal(unavailableText(""), "No diff to review.");
  });
});

describe("diffNotes", () => {
  const base = { available: true as const, root: "r", base: { kind: "head" as const, ref: "HEAD", label: "HEAD" }, totals: { files: 1, additions: 1, deletions: 1 } };
  const result = (files: DiffFile[], filesTruncated: boolean): Extract<DiffResult, { available: true }> => ({ ...base, files, filesTruncated });

  it("flags a cut file list and cut files", () => {
    assert.equal(diffNotes(result([file({ truncated: true })], true)).length, 2);
    assert.deepEqual(diffNotes(result([file()], false)), []);
  });
});

describe("sendPlan", () => {
  it("is disabled until there is a comment", () => {
    assert.equal(sendPlan({ kind: "task", running: false }, 0, false).disabled, true);
    assert.equal(sendPlan({ kind: "session" }, 0, false).disabled, true);
  });

  it("waits for a running task and while sending", () => {
    assert.equal(sendPlan({ kind: "task", running: true }, 2, false).disabled, true);
    assert.equal(sendPlan({ kind: "task", running: false }, 2, true).disabled, true);
  });

  it("sends a follow-up for a finished task and copies for a session", () => {
    const task = sendPlan({ kind: "task", running: false }, 1, false);
    assert.equal(task.disabled, false);
    assert.match(task.hint, /follow-up/);
    const session = sendPlan({ kind: "session" }, 1, false);
    assert.equal(session.disabled, false);
    assert.match(session.hint, /Copies/);
  });
});

describe("reviewOutcome", () => {
  it("explains each server mode", () => {
    assert.deepEqual(reviewOutcome({ mode: "continue", taskId: "t", text: "x", task: null }), { text: "Review sent as a follow-up on this task.", taskId: "t", sessionId: null, copy: null });
    assert.equal(reviewOutcome({ mode: "new-task", taskId: "t2", text: "x", task: null }).taskId, "t2");
    assert.deepEqual(reviewOutcome({ mode: "copy", sessionId: "s", text: "body" }), { text: "Review copied. Paste it into the session.", taskId: null, sessionId: "s", copy: "body" });
    assert.equal(reviewOutcome({ mode: "preview", taskId: "t", text: "x" }).copy, null);
  });
});
