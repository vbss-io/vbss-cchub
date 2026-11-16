import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../hub-request";
import { copyText } from "../memory-clipboard";
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
  STATUS_MARK,
  toReviewComments,
  totalsLine,
  unavailableText,
  upsertComment,
  type DraftComment,
  type LineAnchor,
  type ReviewOutcome,
} from "../review-model";
import { fetchDiff, isBusyError, sendReview, type ReviewSubject } from "../review-api";
import type { DiffFile, DiffResult } from "../types";
import { GhSection } from "./GhSection";
import "../review.css";

type Available = Extract<DiffResult, { available: true }>;

interface Props {
  subject: ReviewSubject;
  running: boolean;
  refreshKey: string;
  onOpenTask?: (taskId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onError: (text: string) => void;
}

interface Editing extends LineAnchor {
  file: string;
}

const sameAnchor = (editing: Editing | null, file: string, anchor: LineAnchor): boolean => editing !== null && editing.file === file && editing.line === anchor.line && editing.side === anchor.side;

interface FileViewProps {
  file: DiffFile;
  open: boolean;
  comments: readonly DraftComment[];
  editing: Editing | null;
  draftText: string;
  expanding: boolean;
  onToggle: () => void;
  onShowMore: () => void;
  onStartEdit: (file: string, anchor: LineAnchor) => void;
  onDraftText: (text: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onRemove: (key: string) => void;
}

function FileView({ file, open, comments, editing, draftText, expanding, onToggle, onShowMore, onStartEdit, onDraftText, onSaveEdit, onCancelEdit, onRemove }: FileViewProps) {
  const note = fileNote(file);
  const count = commentsInFile(comments, file.path);
  return (
    <section className="rv__file">
      <button type="button" className="rv__filehead" aria-expanded={open} onClick={onToggle}>
        <span className="rv__caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="rv__mark" title={file.status}>
          {STATUS_MARK[file.status]}
        </span>
        <span className="rv__path" title={fileLabel(file)}>
          {fileLabel(file)}
        </span>
        <span className="rv__delta">
          +{file.additions} -{file.deletions}
        </span>
        {count > 0 && <span className="rv__count">{count}</span>}
      </button>
      {open && (
        <div className="rv__body">
          {note !== null && <p className="rv__note">{note}</p>}
          {file.hunks.map((hunk, hunkIndex) => (
            <div key={`${hunk.header}-${hunkIndex}`} className="rv__hunk">
              <div className="rv__hunkhead">{hunk.header}</div>
              {hunk.lines.map((line, lineIndex) => {
                const anchor = lineAnchor(line);
                const existing = anchor ? findComment(comments, file.path, anchor.line, anchor.side) : undefined;
                const isEditing = anchor !== null && sameAnchor(editing, file.path, anchor);
                return (
                  <div key={`${hunkIndex}-${lineIndex}`} className="rv__item">
                    <button
                      type="button"
                      className={`rv__line rv__line--${line.kind} ${existing ? "rv__line--commented" : ""}`}
                      disabled={anchor === null}
                      aria-label={anchor ? `Comment on ${anchor.side === "old" ? "removed " : ""}line ${anchor.line}` : undefined}
                      onClick={() => anchor && onStartEdit(file.path, anchor)}
                    >
                      <span className="rv__no">{line.oldLine ?? ""}</span>
                      <span className="rv__no">{line.newLine ?? ""}</span>
                      <span className="rv__sign" aria-hidden="true">
                        {line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}
                      </span>
                      <span className="rv__text">{line.text}</span>
                    </button>
                    {existing && !isEditing && (
                      <div className="rv__comment">
                        <p className="rv__commenttext">{existing.text}</p>
                        <span className="rv__commentacts">
                          <button type="button" className="linklike" onClick={() => anchor && onStartEdit(file.path, anchor)}>
                            Edit
                          </button>
                          <button type="button" className="linklike" onClick={() => onRemove(commentKey(existing.file, existing.line, existing.side))}>
                            Remove
                          </button>
                        </span>
                      </div>
                    )}
                    {isEditing && (
                      <div className="rv__editor">
                        <textarea className="in area" autoFocus aria-label="Comment" value={draftText} placeholder="What should change here?" onChange={(event) => onDraftText(event.target.value)} />
                        <div className="actions">
                          <button type="button" className="act act--ghost" onClick={onCancelEdit}>
                            Cancel
                          </button>
                          <button type="button" className="act act--focus" disabled={draftText.trim().length === 0} onClick={onSaveEdit}>
                            {existing ? "Save comment" : "Add comment"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {canShowMore(file) && (
            <button type="button" className="act rv__more" disabled={expanding} onClick={onShowMore}>
              {expanding ? "Loading..." : "Show more"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function ReviewPanel({ subject, running, refreshKey, onOpenTask, onOpenSession, onError }: Props) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [comments, setComments] = useState<DraftComment[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draftText, setDraftText] = useState("");
  const [expanding, setExpanding] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null);
  const [reloads, setReloads] = useState(0);
  const lastLoaded = useRef<string | null>(null);
  const id = subject.id;
  const kind = subject.kind;
  const subjectKey = `${kind}:${id}`;

  useEffect(() => {
    setComments([]);
    setEditing(null);
    setOutcome(null);
    setPreview(false);
    lastLoaded.current = null;
  }, [subjectKey]);

  useEffect(() => {
    const controller = new AbortController();
    setProblem(null);
    fetchDiff({ kind, id }, {}, controller.signal)
      .then((next) => {
        setDiff(next);
        if (next.available && lastLoaded.current !== subjectKey) setOpen(new Set(initialOpenPaths(next.files)));
        lastLoaded.current = subjectKey;
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setProblem(errorText(err, "Could not load the diff."));
      });
    return () => controller.abort();
  }, [kind, id, subjectKey, refreshKey, reloads]);

  const available: Available | null = diff !== null && diff.available ? diff : null;
  const files = available?.files ?? [];
  const plan = sendPlan(kind === "task" ? { kind: "task", running } : { kind: "session" }, comments.length, busy);
  const previewText = useMemo(() => (preview ? composePreview(comments, files) : ""), [preview, comments, files]);

  const toggle = useCallback((path: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const startEdit = (file: string, anchor: LineAnchor) => {
    setEditing({ file, ...anchor });
    setDraftText(findComment(comments, file, anchor.line, anchor.side)?.text ?? "");
  };

  const saveEdit = () => {
    if (editing === null) return;
    setComments((current) => upsertComment(current, { file: editing.file, line: editing.line, side: editing.side, text: draftText }));
    setEditing(null);
    setDraftText("");
  };

  const showMore = async (path: string) => {
    setExpanding(path);
    try {
      const detail = await fetchDiff({ kind, id }, { file: path });
      if (!detail.available) return;
      const full = detail.files.find((file) => file.path === path);
      if (full) setDiff((current) => (current !== null && current.available ? { ...current, files: mergeFileDetail(current.files, full) } : current));
    } catch (err) {
      onError(errorText(err, "Could not load the whole file."));
    } finally {
      setExpanding(null);
    }
  };

  const send = async () => {
    setBusy(true);
    try {
      const result = await sendReview(subject, toReviewComments(comments));
      const next = reviewOutcome(result);
      if (next.copy !== null) {
        const copied = await copyText(next.copy);
        setOutcome(copied ? next : { ...next, text: "Could not copy automatically. Use Preview and copy the text." });
        if (!copied) setPreview(true);
      } else {
        setOutcome(next);
      }
      if (result.mode === "continue" || result.mode === "new-task") setComments([]);
    } catch (err) {
      onError(isBusyError(err) ? "The task is still running. Send the review when it finishes." : errorText(err, "Could not send the review."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rv">
      <GhSection subject={subject} />
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {diff === null && problem === null && <p className="hint">Loading the diff...</p>}
      {diff !== null && !diff.available && <p className="hint">{unavailableText(diff.reason)}</p>}
      {available !== null && (
        <>
          <div className="rv__bar">
            <span className="rv__base" title={available.root}>
              vs {available.base.label}
            </span>
            <span className="muted">{totalsLine(available.totals)}</span>
            <span className="spacer" />
            <button type="button" className="act" onClick={() => setReloads((value) => value + 1)}>
              Refresh
            </button>
          </div>
          {diffNotes(available).map((note) => (
            <p key={note} className="rv__note">
              {note}
            </p>
          ))}
          {files.length === 0 && <p className="hint">No changes to review.</p>}
          {files.map((file) => (
            <FileView
              key={file.path}
              file={file}
              open={open.has(file.path)}
              comments={comments}
              editing={editing}
              draftText={draftText}
              expanding={expanding === file.path}
              onToggle={() => toggle(file.path)}
              onShowMore={() => void showMore(file.path)}
              onStartEdit={startEdit}
              onDraftText={setDraftText}
              onSaveEdit={saveEdit}
              onCancelEdit={() => setEditing(null)}
              onRemove={(key) => setComments((current) => removeComment(current, key))}
            />
          ))}
          {files.length > 0 && (
            <div className="rv__send">
              <span className="rv__summary">{reviewSummary(comments)}</span>
              <span className="spacer" />
              <button type="button" className="act" disabled={comments.length === 0} aria-pressed={preview} onClick={() => setPreview((value) => !value)}>
                Preview
              </button>
              <button type="button" className="act act--focus" disabled={plan.disabled} title={plan.hint} onClick={() => void send()}>
                {plan.label}
              </button>
            </div>
          )}
          {preview && comments.length > 0 && <pre className="rv__preview">{previewText}</pre>}
          {outcome !== null && (
            <p className="rv__outcome" role="status">
              {outcome.text}{" "}
              {outcome.sessionId !== null && onOpenSession && (
                <button type="button" className="linklike" onClick={() => onOpenSession(outcome.sessionId ?? "")}>
                  Open session
                </button>
              )}
              {outcome.taskId !== null && kind === "task" && outcome.taskId !== id && onOpenTask && (
                <button type="button" className="linklike" onClick={() => onOpenTask(outcome.taskId ?? "")}>
                  Open task
                </button>
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
}
