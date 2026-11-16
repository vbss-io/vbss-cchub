import { useMemo, useState, type MouseEvent } from "react";
import { openSession } from "../api";
import { useApprovals } from "../approvals-context";
import { approvalKind, approvalView, askQuestions, buildAnswers, countdown, countdownFraction, planOf, type ApprovalItem, type ApprovalKind, type QuestionDraft } from "../approvals-model";
import type { PermissionRequestRecord } from "../types";
import { shortFolder } from "../wsmatch";
import { ApprovalPlan } from "./ApprovalPlan";
import { ApprovalQuestions } from "./ApprovalQuestions";
import { ClampText } from "./ShowMore";
import "../approvals.css";

interface Props {
  request: ApprovalItem;
  compact?: boolean;
  showTitle?: boolean;
  reasonField?: boolean;
  lines?: number;
  onOpenSession?: (request: PermissionRequestRecord) => void;
  onTextFocus?: (element: HTMLElement) => void;
}

interface KindText {
  head: (tool: string) => string;
  deny: string;
  sendDeny: string;
  allow: string;
  reason: string;
}

const KIND_TEXT: Readonly<Record<ApprovalKind, KindText>> = {
  tool: { head: (tool) => tool, deny: "Deny", sendDeny: "Send deny", allow: "Allow", reason: "Reason for the agent (optional)" },
  plan: { head: () => "Plan", deny: "Keep planning", sendDeny: "Keep planning", allow: "Approve plan", reason: "What to change in the plan (optional)" },
  question: { head: () => "Question", deny: "Answer in session", sendDeny: "Answer in session", allow: "Answer", reason: "" },
};

const defaultOpen = (request: PermissionRequestRecord): void => {
  void openSession(request.sessionId).catch(() => undefined);
};

export function ApprovalRequest({ request, compact = false, showTitle = false, reasonField = true, lines = compact ? 3 : 6, onOpenSession = defaultOpen, onTextFocus }: Props) {
  const { now, decide, answer, release } = useApprovals();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, QuestionDraft>>>({});
  const kind = approvalKind(request);
  const text = KIND_TEXT[kind];
  const view = approvalView(request);
  const questions = useMemo(() => (kind === "question" ? askQuestions(request.toolInput) : []), [kind, request.toolInput]);
  const plan = useMemo(() => (kind === "plan" ? planOf(request.toolInput) : null), [kind, request.toolInput]);
  const built = buildAnswers(questions, drafts);
  const left = countdown(request.expiresAt, now);
  const fraction = countdownFraction(request, now);
  const loading = request.pendingDetails === true;
  const head = text.head(view.tool);
  const stop = (event: MouseEvent) => event.stopPropagation();

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The decision was not sent.");
      setBusy(false);
    }
  };

  const send = (behavior: "allow" | "deny") => run(() => decide(request.id, behavior, reason));

  const sendAnswers = () => run(() => answer(request.id, built.answers));

  const answerInSession = () =>
    run(async () => {
      await release(request.id);
      onOpenSession(request);
    });

  const cancelDeny = () => {
    setDenying(false);
    setReason("");
  };

  const startDeny = () => {
    if (kind === "question") void answerInSession();
    else if (reasonField) setDenying(true);
    else void send("deny");
  };

  const allow = () => {
    if (kind === "question") void sendAnswers();
    else void send("allow");
  };

  const allowBlocked = loading || (kind === "question" && !built.complete);
  const allowTitle = loading ? "Wait until the request is shown" : kind === "question" && !built.complete ? "Answer every question first" : undefined;
  const changeDraft = (question: string, draft: QuestionDraft) => setDrafts((prev) => ({ ...prev, [question]: draft }));

  return (
    <div className={`approval ${compact ? "approval--compact" : ""}`} onClick={stop} onMouseDown={stop} role="group" aria-label={`${kind === "tool" ? "Permission request" : head} for ${view.tool}`}>
      <div className="approval__head">
        {showTitle && (
          <span className="approval__title" title={view.title}>
            {view.title}
          </span>
        )}
        <span className="approval__tool" title={`${view.agentLabel} asks to run ${view.tool}${view.subagent ? " in a subagent" : ""}`}>
          {head}
          {view.subagent ? " · subagent" : ""}
        </span>
        <span className={`approval__left ${left.urgent ? "approval__left--urgent" : ""}`} title="After this the prompt stays in the terminal or app as usual">
          {left.text}
        </span>
      </div>
      <div className="approval__bar" aria-hidden="true">
        <span className="approval__fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>
      {loading && <span className="approval__cwd">Loading the request...</span>}
      {kind === "tool" && view.input.length > 0 && (
        <ClampText className="approval__input" lines={lines}>
          {view.input}
        </ClampText>
      )}
      {kind === "question" && !loading && questions.length > 0 && <ApprovalQuestions questions={questions} drafts={drafts} disabled={busy} onChange={changeDraft} onTextFocus={onTextFocus} />}
      {kind === "question" && !loading && questions.length === 0 && <span className="approval__cwd">The questions did not come with the request. Answer them in the session.</span>}
      {plan && !loading && <ApprovalPlan plan={plan} lines={lines} />}
      {view.cwd && (
        <span className="approval__cwd" title={view.cwd}>
          {shortFolder(view.cwd)}
        </span>
      )}
      {denying && (
        <input
          className="in approval__reason"
          autoFocus
          value={reason}
          maxLength={2000}
          placeholder={text.reason}
          aria-label={text.reason}
          disabled={busy}
          onFocus={(event) => onTextFocus?.(event.currentTarget)}
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) void send("deny");
            if (event.key === "Escape") {
              event.stopPropagation();
              cancelDeny();
            }
          }}
        />
      )}
      {error && <span className="approval__error">{error}</span>}
      <div className="approval__acts">
        {denying ? (
          <>
            <button type="button" className="act act--ghost" disabled={busy} onClick={cancelDeny}>
              Cancel
            </button>
            <button type="button" className="act" disabled={busy} onClick={() => void send("deny")}>
              {busy ? "Sending..." : text.sendDeny}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="act" disabled={busy} title={kind === "question" ? "Leave the question to the terminal or app and open the session" : undefined} onClick={startDeny}>
              {text.deny}
            </button>
            {(kind !== "question" || questions.length > 0) && (
              <button type="button" className="act act--focus" disabled={busy || allowBlocked} title={allowTitle} onClick={allow}>
                {busy ? "Sending..." : text.allow}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface ListProps {
  requests: readonly ApprovalItem[];
  compact?: boolean;
  showTitle?: boolean;
  reasonField?: boolean;
}

export function ApprovalList({ requests, compact = false, showTitle = false, reasonField = true }: ListProps) {
  if (requests.length === 0) return null;
  return (
    <div className="approvals">
      {requests.map((request) => (
        <ApprovalRequest key={request.id} request={request} compact={compact} showTitle={showTitle} reasonField={reasonField} />
      ))}
    </div>
  );
}
