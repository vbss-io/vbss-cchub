import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  APPROVAL_GRACE_MS,
  EMPTY_DRAFT,
  answerBody,
  answerOf,
  approvalKind,
  approvalView,
  askQuestions,
  buildAnswers,
  pickOption,
  reduceApprovals,
  planOf,
  setOtherText,
  toggleOther,
  toastQueue,
  type AskQuestion,
} from "./approvals-model";
import type { PermissionRequestRecord } from "./types";

const single: AskQuestion = {
  question: "Which database?",
  header: "DB",
  options: [
    { label: "Postgres", description: "Relational" },
    { label: "Mongo", description: "Documents" },
  ],
  multiSelect: false,
};

const multi: AskQuestion = {
  question: "Which checks?",
  header: "Checks",
  options: [
    { label: "Lint", description: "" },
    { label: "Tests", description: "" },
    { label: "Build", description: "" },
  ],
  multiSelect: true,
};

const record = (toolName: string, toolInput: unknown, agent: "claude" | "codex" = "claude"): PermissionRequestRecord => ({
  id: "r1",
  agent,
  sessionId: "s1",
  agentId: null,
  toolName,
  toolInput,
  cwd: null,
  turnId: null,
  title: "Plan work",
  windowMs: 300_000,
  createdAt: 0,
  expiresAt: 300_000,
});

describe("approvalKind", () => {
  it("routes the two input tools of Claude and leaves the rest as tools", () => {
    assert.equal(approvalKind(record("AskUserQuestion", {})), "question");
    assert.equal(approvalKind(record("ExitPlanMode", {})), "plan");
    assert.equal(approvalKind(record("Bash", {})), "tool");
    assert.equal(approvalKind(record("AskUserQuestion", {}, "codex")), "tool");
  });
});

describe("askQuestions and planOf", () => {
  it("reads questions, defaults header, description and multiSelect, and drops malformed ones", () => {
    const parsed = askQuestions({ questions: [{ question: "Pick", options: [{ label: "A" }, { nope: 1 }] }, { header: "no question" }, "junk"] });
    assert.deepEqual(parsed, [{ question: "Pick", header: "", options: [{ label: "A", description: "" }], multiSelect: false }]);
    assert.deepEqual(askQuestions(null), []);
  });

  it("reads the plan and its file path", () => {
    assert.deepEqual(planOf({ plan: "# Plan", planFilePath: "C:/p.md" }), { plan: "# Plan", path: "C:/p.md" });
    assert.deepEqual(planOf({}), { plan: "", path: null });
  });

  it("never shows raw JSON for questions or plans", () => {
    const ask = approvalView(record("AskUserQuestion", { questions: [single, multi] }));
    assert.equal(ask.input, "Which database?\nWhich checks?");
    const plan = approvalView(record("ExitPlanMode", { plan: "# Plan\n\n1. Do it", planFilePath: "x" }));
    assert.equal(plan.input, "# Plan\n\n1. Do it");
    assert.ok(!ask.input.includes("{") && !plan.input.includes("{"));
  });
});

describe("question drafts", () => {
  it("keeps one label for a single choice and lets Other replace it", () => {
    const picked = pickOption(pickOption(EMPTY_DRAFT, "Postgres", false), "Mongo", false);
    assert.equal(answerOf(single, picked), "Mongo");
    const other = setOtherText(toggleOther(picked, false), "  SQLite  ");
    assert.deepEqual(other.selected, []);
    assert.equal(answerOf(single, other), "SQLite");
    assert.equal(answerOf(single, pickOption(other, "Postgres", false)), "Postgres");
  });

  it("joins multi-select labels with a comma in option order and appends Other", () => {
    const draft = pickOption(pickOption(pickOption(EMPTY_DRAFT, "Build", true), "Lint", true), "Tests", true);
    assert.equal(answerOf(multi, draft), "Lint, Tests, Build");
    const less = pickOption(draft, "Tests", true);
    assert.equal(answerOf(multi, less), "Lint, Build");
    assert.equal(answerOf(multi, setOtherText(less, "Typecheck")), "Lint, Build, Typecheck");
    assert.equal(answerOf(multi, toggleOther(setOtherText(less, "Typecheck"), true)), "Lint, Build");
  });

  it("has no answer while nothing is chosen or Other is blank", () => {
    assert.equal(answerOf(single, EMPTY_DRAFT), null);
    assert.equal(answerOf(single, toggleOther(EMPTY_DRAFT, false)), null);
    assert.equal(answerOf(multi, setOtherText(EMPTY_DRAFT, "   ")), null);
  });

  it("builds answers keyed by question text and reports when one is missing", () => {
    const drafts = { "Which database?": pickOption(EMPTY_DRAFT, "Mongo", false) };
    assert.deepEqual(buildAnswers([single, multi], drafts), { answers: { "Which database?": "Mongo" }, complete: false });
    const full = { ...drafts, "Which checks?": pickOption(EMPTY_DRAFT, "Lint", true) };
    assert.deepEqual(buildAnswers([single, multi], full), { answers: { "Which database?": "Mongo", "Which checks?": "Lint" }, complete: true });
    assert.deepEqual(buildAnswers([], {}), { answers: {}, complete: false });
  });

  it("sends only allow and the answers", () => {
    assert.deepEqual(answerBody({ "Which database?": "Mongo" }), { behavior: "allow", answers: { "Which database?": "Mongo" } });
  });
});

describe("approval toasts leave once decided anywhere", () => {
  it("drops the toast on every resolved outcome and after the window ran out, never before", () => {
    const open = [record("AskUserQuestion", { questions: [single] }), { ...record("Bash", { command: "ls" }), id: "r2", sessionId: "s2" }];
    for (const outcome of ["allow", "deny", "expired", "superseded", "withdrawn"]) {
      const left = reduceApprovals(open, { type: "resolved", id: "r1" });
      assert.deepEqual(toastQueue(left, new Set()).map((item) => item.id), ["r2"], outcome);
    }
    assert.equal(reduceApprovals(open, { type: "prune", now: 300_000 }), open);
    assert.deepEqual(reduceApprovals(open, { type: "prune", now: 300_000 + APPROVAL_GRACE_MS }), []);
  });
});
