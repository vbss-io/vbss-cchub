import { useEffect, useRef, useState } from "react";
import type { DailyStreamEvent } from "../api";
import { carryOverFromYesterday, focusPreviewLines, parseMeetings, parseNewItems, type DailyFocusDraftItem } from "../daily-plan";
import { decideDailyEvent, generateWriteId, rememberWriteId } from "../daily-sync";
import {
  closeYesterday,
  composeDaily,
  DailyConflictError,
  DailyExistsError,
  generateDaily,
  getDaily,
  getDailyEntry,
  listDailySessions,
  prepareDaily,
  saveDailyEntry,
  type DailyEntry,
  type DailyOverview,
  type DailyPrepare,
  type DailySession,
  type DelegationSettings,
} from "../delegation";
import { countTasks, Markdown, renderInline, toggleTaskLine, type TaskFilter } from "../markdown";

interface Props {
  settings: DelegationSettings | null;
  onOpenSession: (sessionId: string) => void;
  onOpenTask: (taskId: string) => void;
  subscribeDaily: (listener: (event: DailyStreamEvent) => void) => () => void;
}

type Mode = "preview" | "edit";
type SaveStatus = "idle" | "saving" | "saved" | "unsaved";
type WizardStep = 1 | 2 | 3;

interface Conflict {
  content: string | null;
  updatedAt: number | null;
}

interface DailyPlanDraft {
  step: WizardStep;
  yesterdayDone: Record<number, boolean>;
  yesterdayCarry: Record<number, boolean>;
  yesterdayNotes: string;
  carriedItems: DailyFocusDraftItem[];
  newItemsText: string;
  meetingsText: string;
}

function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map((part) => Number(part));
  const base = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function buildTemplate(date: string): string {
  return ["---", "type: daily", `date: ${date}`, "---", `# ${date}`, "", "## Briefing", "", "## Focus", "", "## Meetings", "", "## Sessions", ""].join(
    "\n",
  );
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSection(content: string, heading: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const headingRe = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`);
  const start = lines.findIndex((line) => headingRe.test(line.trim()));
  if (start === -1) return "";
  const collected: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s+/.test(lines[i]!)) break;
    collected.push(lines[i]!);
  }
  return collected.join("\n").trim();
}

const TASK_FILTER_KEY = "hub.daily.taskFilter";

function readStoredTaskFilter(): TaskFilter {
  try {
    const stored = window.localStorage.getItem(TASK_FILTER_KEY);
    if (stored === "all" || stored === "open" || stored === "done") return stored;
  } catch {}
  return "all";
}

function draftKey(date: string): string {
  return `hub.daily.plan.${date}`;
}

function readDraft(date: string): DailyPlanDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(date));
    if (!raw) return null;
    return JSON.parse(raw) as DailyPlanDraft;
  } catch {
    return null;
  }
}

function writeDraft(date: string, draft: DailyPlanDraft): void {
  try {
    window.localStorage.setItem(draftKey(date), JSON.stringify(draft));
  } catch {}
}

function clearDraft(date: string): void {
  try {
    window.localStorage.removeItem(draftKey(date));
  } catch {}
}

interface DailyWizardProps {
  date: string;
  step: WizardStep;
  onStepChange: (step: WizardStep) => void;
  prepare: DailyPrepare | null;
  prepareLoading: boolean;
  prepareError: string | null;
  onRetryPrepare: () => void;
  onClose: () => void;
  yesterdayDone: Record<number, boolean>;
  yesterdayCarry: Record<number, boolean>;
  onToggleDone: (line: number, value: boolean) => void;
  onToggleCarry: (line: number, value: boolean) => void;
  yesterdayNotes: string;
  onYesterdayNotesChange: (value: string) => void;
  onSkipYesterday: () => void;
  onCloseYesterday: () => void;
  closeBusy: boolean;
  closeError: string | null;
  carriedItems: DailyFocusDraftItem[];
  onCarriedItemsChange: (items: DailyFocusDraftItem[]) => void;
  newItemsText: string;
  onNewItemsTextChange: (value: string) => void;
  meetingsText: string;
  onMeetingsTextChange: (value: string) => void;
  onCreateDiary: () => void;
  composeBusy: boolean;
  composeError: string | null;
  existsConflict: { updatedAt: number | null } | null;
  onOverwrite: () => void;
  onCancelOverwrite: () => void;
}

function DailyWizard(props: DailyWizardProps) {
  const {
    date,
    step,
    onStepChange,
    prepare,
    prepareLoading,
    prepareError,
    onRetryPrepare,
    onClose,
    yesterdayDone,
    yesterdayCarry,
    onToggleDone,
    onToggleCarry,
    yesterdayNotes,
    onYesterdayNotesChange,
    onSkipYesterday,
    onCloseYesterday,
    closeBusy,
    closeError,
    carriedItems,
    onCarriedItemsChange,
    newItemsText,
    onNewItemsTextChange,
    meetingsText,
    onMeetingsTextChange,
    onCreateDiary,
    composeBusy,
    composeError,
    existsConflict,
    onOverwrite,
    onCancelOverwrite,
  } = props;

  const wikilinks = prepare?.wikilinks ?? false;
  const newItems = parseNewItems(newItemsText);
  const meetings = parseMeetings(meetingsText);
  const previewLines = focusPreviewLines([...carriedItems, ...newItems], wikilinks);

  return (
    <div className="daily__wizard">
      <div className="daily__wizard-head">
        <h3>Plan today · {date}</h3>
        <button className="act act--icon" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="daily__steps">
        <span className={`daily__step ${step === 1 ? "daily__step--on" : ""}`}>1 Yesterday</span>
        <span className="daily__step-sep">·</span>
        <span className={`daily__step ${step === 2 ? "daily__step--on" : ""}`}>2 Today</span>
        <span className="daily__step-sep">·</span>
        <span className={`daily__step ${step === 3 ? "daily__step--on" : ""}`}>3 Create</span>
      </div>

      {prepareLoading && <p className="muted">Loading…</p>}
      {prepareError && (
        <div className="daily__banner">
          <span>{prepareError}</span>
          <button className="act" onClick={onRetryPrepare}>
            Retry
          </button>
        </div>
      )}

      {!prepareLoading && !prepareError && prepare && step === 1 && (
        <div className="daily__wizard-step">
          {!prepare.yesterday && <p className="hint">No previous diary found.</p>}
          {prepare.yesterday && (
            <>
              <h4>Yesterday · {prepare.yesterday.date}</h4>
              {prepare.yesterday.closed && <p className="muted small">already closed on {prepare.yesterday.date}</p>}
              {prepare.yesterday.tasks.length === 0 && <p className="muted small">No tasks yesterday.</p>}
              {prepare.yesterday.tasks.length > 0 && (
                <div className="daily__yesterday">
                  <div className="daily__yesterday-row daily__yesterday-row--head">
                    <span>Task</span>
                    <span>Done</span>
                    <span>Carry</span>
                  </div>
                  {prepare.yesterday.tasks.map((task) => (
                    <div className="daily__yesterday-row" key={task.line}>
                      <span className="daily__yesterday-text">{renderInline(task.text, `y-${task.line}`)}</span>
                      <input
                        type="checkbox"
                        checked={yesterdayDone[task.line] ?? task.checked}
                        onChange={(event) => onToggleDone(task.line, event.target.checked)}
                      />
                      <input
                        type="checkbox"
                        checked={yesterdayCarry[task.line] ?? !task.checked}
                        onChange={(event) => onToggleCarry(task.line, event.target.checked)}
                      />
                    </div>
                  ))}
                </div>
              )}
              <label className="field">
                <span>What happened yesterday (optional, 2-3 lines)</span>
                <textarea
                  className="in daily__wizard-textarea"
                  rows={3}
                  value={yesterdayNotes}
                  onChange={(event) => onYesterdayNotesChange(event.target.value)}
                />
              </label>
              {closeError && <span className="error small">{closeError}</span>}
            </>
          )}
          <div className="frow frow--end">
            <button className="act" onClick={onSkipYesterday}>
              Skip
            </button>
            {prepare.yesterday && (
              <button className="act act--focus" disabled={closeBusy} onClick={onCloseYesterday}>
                {closeBusy ? "Closing…" : "Close yesterday"}
              </button>
            )}
          </div>
        </div>
      )}

      {!prepareLoading && !prepareError && prepare && step === 2 && (
        <div className="daily__wizard-step">
          <h4>Carried over</h4>
          {carriedItems.length === 0 && <p className="muted small">Nothing carried over.</p>}
          {carriedItems.length > 0 && (
            <div className="daily__list">
              {carriedItems.map((item, index) => (
                <div className="daily__list-row" key={index}>
                  <input
                    className="in"
                    value={item.text}
                    onChange={(event) => {
                      const nextText = event.target.value;
                      onCarriedItemsChange(carriedItems.map((entryItem, i) => (i === index ? { ...entryItem, text: nextText } : entryItem)));
                    }}
                  />
                  <button className="act act--icon" onClick={() => onCarriedItemsChange(carriedItems.filter((_, i) => i !== index))}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <label className="field">
            <span>New items (one per line, "Project - item")</span>
            <textarea className="in daily__wizard-textarea" value={newItemsText} onChange={(event) => onNewItemsTextChange(event.target.value)} />
          </label>
          <label className="field">
            <span>Meetings (one per line)</span>
            <textarea className="in daily__wizard-textarea" value={meetingsText} onChange={(event) => onMeetingsTextChange(event.target.value)} />
          </label>
          <div className="frow frow--end">
            <button className="act" onClick={() => onStepChange(1)}>
              Back
            </button>
            <button className="act act--focus" onClick={() => onStepChange(3)}>
              Next
            </button>
          </div>
        </div>
      )}

      {!prepareLoading && !prepareError && prepare && step === 3 && (
        <div className="daily__wizard-step">
          <h4>Create diary · {date}</h4>
          <p className="muted small">
            {carriedItems.length} carried · {newItems.length} new · {meetings.length} meetings · briefing{" "}
            {yesterdayNotes.trim() ? "yes" : "no"}
          </p>
          <div className="daily__preview">
            {previewLines.length === 0 && <p className="muted small">No focus items yet.</p>}
            {previewLines.map((line, index) => (
              <div key={index} className="daily__preview-line">
                {line}
              </div>
            ))}
          </div>
          {composeError && <span className="error small">{composeError}</span>}
          {existsConflict && (
            <div className="daily__banner">
              <span>A diary for {date} already exists. Overwrite?</span>
              <div className="row">
                <button className="act act--danger" onClick={onOverwrite}>
                  Overwrite
                </button>
                <button className="act" onClick={onCancelOverwrite}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <div className="frow frow--end">
            <button className="act" onClick={() => onStepChange(2)}>
              Back
            </button>
            <button className="act act--focus" disabled={composeBusy} onClick={onCreateDiary}>
              {composeBusy ? "Creating…" : "Create diary"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function DailyView({ settings, onOpenSession, onOpenTask, subscribeDaily }: Props) {
  const [overview, setOverview] = useState<DailyOverview | null>(null);
  const [overviewFailed, setOverviewFailed] = useState<"stale-hub" | "error" | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [entry, setEntry] = useState<DailyEntry | null>(null);
  const [entryLoading, setEntryLoading] = useState(false);
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [baseUpdatedAt, setBaseUpdatedAt] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("preview");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [sessions, setSessions] = useState<DailySession[]>([]);
  const [showRefine, setShowRefine] = useState(false);
  const [focusText, setFocusText] = useState("");
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>(readStoredTaskFilter);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [prepare, setPrepare] = useState<DailyPrepare | null>(null);
  const [prepareLoading, setPrepareLoading] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [yesterdayDone, setYesterdayDone] = useState<Record<number, boolean>>({});
  const [yesterdayCarry, setYesterdayCarry] = useState<Record<number, boolean>>({});
  const [yesterdayNotes, setYesterdayNotes] = useState("");
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [carriedItems, setCarriedItems] = useState<DailyFocusDraftItem[]>([]);
  const [newItemsText, setNewItemsText] = useState("");
  const [meetingsText, setMeetingsText] = useState("");
  const [composeBusy, setComposeBusy] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [existsConflict, setExistsConflict] = useState<{ updatedAt: number | null } | null>(null);

  const ownWriteIdsRef = useRef<Set<string>>(new Set());
  const ownWriteOrderRef = useRef<string[]>([]);
  const pendingEventRef = useRef<DailyStreamEvent | null>(null);
  const textRef = useRef(text);

  const enabled = settings?.features.daily === true;
  const dirty = text !== savedText;

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TASK_FILTER_KEY, taskFilter);
    } catch {}
  }, [taskFilter]);

  const loadOverview = () => {
    getDaily()
      .then((next) => {
        setOverview(next);
        setOverviewFailed(null);
        setDate((current) => current ?? next.today);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "";
        setOverviewFailed(message.includes("404") ? "stale-hub" : "error");
      });
  };

  useEffect(() => {
    if (!enabled) return;
    loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const applyLoaded = (nextEntry: DailyEntry) => {
    setEntry(nextEntry);
    setText(nextEntry.content);
    setSavedText(nextEntry.content);
    setBaseUpdatedAt(nextEntry.updatedAt);
    setSaveStatus("idle");
    setConflict(null);
  };

  const loadEntry = (target: string) => {
    setEntryLoading(true);
    return getDailyEntry(target)
      .then((next) => {
        applyLoaded(next);
      })
      .finally(() => setEntryLoading(false));
  };

  const refreshSessions = (target: string) => {
    void listDailySessions(target)
      .then(setSessions)
      .catch(() => undefined);
  };

  useEffect(() => {
    if (!enabled || !date) return;
    void loadEntry(date);
    void listDailySessions(date)
      .then(setSessions)
      .catch(() => setSessions([]));
    setWizardOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, date]);

  useEffect(() => {
    if (!enabled || !date) return;
    const id = window.setInterval(() => refreshSessions(date), 30_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, date]);

  useEffect(() => {
    if (!enabled || !date) return;
    const onFocusChange = () => {
      if (document.visibilityState === "visible") refreshSessions(date);
    };
    window.addEventListener("focus", onFocusChange);
    document.addEventListener("visibilitychange", onFocusChange);
    return () => {
      window.removeEventListener("focus", onFocusChange);
      document.removeEventListener("visibilitychange", onFocusChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, date]);

  const resolvePendingEvent = (settledText: string) => {
    const pending = pendingEventRef.current;
    if (!pending) return;
    pendingEventRef.current = null;
    applyDailyDecision(
      pending,
      decideDailyEvent(pending, { ownWriteIds: ownWriteIdsRef.current, dirty: textRef.current !== settledText, saving: false }),
    );
  };

  const applyDailyDecision = (event: DailyStreamEvent, decision: ReturnType<typeof decideDailyEvent>) => {
    if (decision === "ignore") {
      if (event.updatedAt !== null) setBaseUpdatedAt(event.updatedAt);
      return;
    }
    if (decision === "defer") {
      pendingEventRef.current = event;
      return;
    }
    if (decision === "reload") {
      void loadEntry(event.date);
      return;
    }
    setConflict({ content: null, updatedAt: event.updatedAt });
  };

  const save = async (next: string, overrideBase?: number | null) => {
    if (!date) return;
    const base = overrideBase !== undefined ? overrideBase : baseUpdatedAt;
    const writeId = generateWriteId();
    rememberWriteId(ownWriteIdsRef.current, ownWriteOrderRef.current, writeId);
    setSaveStatus("saving");
    try {
      const result = await saveDailyEntry(date, next, base, writeId);
      setSavedText(next);
      setBaseUpdatedAt(result.updatedAt);
      setEntry((current) => (current ? { ...current, exists: true, content: next, updatedAt: result.updatedAt, path: result.path } : current));
      setSaveStatus("saved");
      setSavedAt(Date.now());
    } catch (err) {
      if (err instanceof DailyConflictError) {
        setConflict({ content: err.content, updatedAt: err.updatedAt });
        setSaveStatus("unsaved");
        pendingEventRef.current = null;
        return;
      }
      setSaveStatus("unsaved");
      resolvePendingEvent(next);
      return;
    }
    resolvePendingEvent(next);
  };

  useEffect(() => {
    if (mode !== "edit" || !dirty || conflict) return;
    const id = window.setTimeout(() => void save(text), 800);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, mode, dirty, conflict]);

  useEffect(() => {
    if (!enabled) return;
    return subscribeDaily((event) => {
      loadOverview();
      if (event.date === date) refreshSessions(event.date);
      if (event.date !== date) return;
      const decision = decideDailyEvent(event, {
        ownWriteIds: ownWriteIdsRef.current,
        dirty,
        saving: saveStatus === "saving",
      });
      applyDailyDecision(event, decision);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, date, dirty, saveStatus]);

  useEffect(() => {
    if (!wizardOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWizardOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wizardOpen]);

  useEffect(() => {
    if (!wizardOpen || !date) return;
    writeDraft(date, { step: wizardStep, yesterdayDone, yesterdayCarry, yesterdayNotes, carriedItems, newItemsText, meetingsText });
  }, [wizardOpen, date, wizardStep, yesterdayDone, yesterdayCarry, yesterdayNotes, carriedItems, newItemsText, meetingsText]);

  const reload = () => {
    if (!date) return;
    if (conflict?.content != null) {
      applyLoaded({ date, path: entry?.path ?? "", exists: true, content: conflict.content, updatedAt: conflict.updatedAt });
      return;
    }
    void loadEntry(date);
  };

  const keepMine = () => {
    if (!conflict) return;
    const freshBase = conflict.updatedAt;
    setConflict(null);
    void save(text, freshBase);
  };

  const handleToggle = (lineIndex: number, checked: boolean) => {
    const next = toggleTaskLine(text, lineIndex, checked);
    if (next === text) return;
    setText(next);
    void save(next);
  };

  const createFromTemplate = () => {
    if (!date) return;
    const template = buildTemplate(date);
    setText(template);
    void save(template);
  };

  const runRefine = async () => {
    if (!date) return;
    setGenerateBusy(true);
    setGenerateError(null);
    try {
      const heading = settings?.daily.headings.focus ?? prepare?.headings.focus ?? "Focus";
      const context = extractSection(text, heading);
      await generateDaily(date, focusText, context);
      setShowRefine(false);
      setFocusText("");
      loadOverview();
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "could not start generation");
    } finally {
      setGenerateBusy(false);
    }
  };

  const openWizard = () => {
    if (!date) return;
    setShowRefine(false);
    setWizardOpen(true);
    setPrepareError(null);
    setExistsConflict(null);
    setComposeError(null);
    setCloseError(null);
    setPrepareLoading(true);
    prepareDaily(date)
      .then((next) => {
        setPrepare(next);
        const draft = readDraft(date);
        const initialDone: Record<number, boolean> = {};
        const initialCarry: Record<number, boolean> = {};
        for (const task of next.yesterday?.tasks ?? []) {
          initialDone[task.line] = task.checked;
          initialCarry[task.line] = !task.checked;
        }
        setYesterdayDone(draft?.yesterdayDone ?? initialDone);
        setYesterdayCarry(draft?.yesterdayCarry ?? initialCarry);
        setYesterdayNotes(draft?.yesterdayNotes ?? "");
        setCarriedItems(draft?.carriedItems ?? []);
        setNewItemsText(draft?.newItemsText ?? "");
        setMeetingsText(draft?.meetingsText ?? "");
        setWizardStep(draft?.step ?? (next.yesterday ? 1 : 2));
      })
      .catch((err: unknown) => setPrepareError(err instanceof Error ? err.message : "could not load prepare"))
      .finally(() => setPrepareLoading(false));
  };

  const computeCarriedItems = (): DailyFocusDraftItem[] => {
    const tasks = prepare?.yesterday?.tasks ?? [];
    const doneStatesForCarry: Record<number, boolean> = {};
    for (const task of tasks) {
      if (task.line in yesterdayCarry) doneStatesForCarry[task.line] = !yesterdayCarry[task.line];
    }
    return carryOverFromYesterday(tasks, doneStatesForCarry);
  };

  const skipYesterday = () => {
    setCarriedItems(computeCarriedItems());
    setWizardStep(2);
  };

  const closeYesterdayAndAdvance = async () => {
    if (!date || !prepare?.yesterday) return;
    setCloseBusy(true);
    setCloseError(null);
    try {
      const tasks = prepare.yesterday.tasks.map((task) => ({ line: task.line, checked: yesterdayDone[task.line] ?? task.checked }));
      await closeYesterday(date, { yesterday: prepare.yesterday.date, tasks });
      setCarriedItems(computeCarriedItems());
      setWizardStep(2);
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : "could not close yesterday");
    } finally {
      setCloseBusy(false);
    }
  };

  const createDiary = async (overwrite: boolean) => {
    if (!date) return;
    setComposeBusy(true);
    setComposeError(null);
    try {
      const focus = [...carriedItems, ...parseNewItems(newItemsText)];
      const meetings = parseMeetings(meetingsText);
      const nextEntry = await composeDaily(date, {
        focus,
        meetings,
        ...(yesterdayNotes.trim() ? { briefing: yesterdayNotes.trim() } : {}),
        ...(overwrite ? { overwrite: true } : {}),
      });
      applyLoaded(nextEntry);
      setMode("preview");
      setWizardOpen(false);
      setExistsConflict(null);
      clearDraft(date);
      loadOverview();
    } catch (err) {
      if (err instanceof DailyExistsError) {
        setExistsConflict({ updatedAt: err.updatedAt });
        return;
      }
      setComposeError(err instanceof Error ? err.message : "could not create diary");
    } finally {
      setComposeBusy(false);
    }
  };

  if (!enabled) {
    return (
      <div className="view">
        <p className="hint">Daily is off. Turn it on in Settings › Features to keep a diary entry for each day in your second brain.</p>
      </div>
    );
  }

  if (overviewFailed === "stale-hub") {
    return (
      <div className="view">
        <p className="callout">Daily needs a newer hub. Update the desktop app or the dev server to pick up the new routes.</p>
      </div>
    );
  }

  if (overviewFailed === "error") {
    return (
      <div className="view">
        <div className="daily__banner">
          <span>Could not load Daily.</span>
          <button className="act" onClick={loadOverview}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!overview || !date) {
    return (
      <div className="view">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const running = overview.running && overview.running.date === date ? overview.running : null;
  const taskCounts = countTasks(text);
  const statusLabel = saveStatus === "saving" ? "Saving…" : saveStatus === "saved" && savedAt ? `Saved ${formatClock(savedAt)}` : dirty ? "Unsaved" : "";
  const obsidianHref = entry?.exists && entry.path ? `obsidian://open?path=${encodeURIComponent(entry.path)}` : null;

  return (
    <div className="view">
      <div className="daily__toolbar">
        <button className="act" onClick={() => setDate(shiftDate(date, -1))}>
          ‹ Previous
        </button>
        <button className="act" onClick={() => setDate(overview.today)}>
          Today
        </button>
        <button className="act" onClick={() => setDate(shiftDate(date, 1))}>
          Next ›
        </button>
        <input className="in" style={{ maxWidth: 170 }} type="date" value={date} onChange={(event) => event.target.value && setDate(event.target.value)} />
        <span className="spacer" />
        {running && (
          <button className="chip chip--agents-on" onClick={() => onOpenTask(running.taskId)}>
            generating… (open task)
          </button>
        )}
        <button className="act act--focus" onClick={openWizard}>
          Plan today
        </button>
        {entry?.exists && (
          <button className="act" onClick={() => setShowRefine((v) => !v)}>
            Refine with assistant
          </button>
        )}
        {obsidianHref && (
          <a className="act" href={obsidianHref}>
            Open in Obsidian
          </a>
        )}
        <div className="row" role="tablist" aria-label="Daily view mode">
          <button className={`pill ${mode === "preview" ? "pill--on" : ""}`} onClick={() => setMode("preview")}>
            Preview
          </button>
          <button className={`pill ${mode === "edit" ? "pill--on" : ""}`} onClick={() => setMode("edit")}>
            Edit
          </button>
        </div>
      </div>

      {showRefine && (
        <div className="panel">
          <label className="field">
            <span>What are you working on today? (optional)</span>
            <textarea className="in area" rows={2} value={focusText} onChange={(event) => setFocusText(event.target.value)} />
          </label>
          <small className="muted">Runs your prompt with today's items as input.</small>
          <div className="actions">
            {generateError && <span className="error small">{generateError}</span>}
            <button className="act act--focus" disabled={generateBusy} onClick={() => void runRefine()}>
              {generateBusy ? "Starting…" : "Run"}
            </button>
          </div>
        </div>
      )}

      <div className="daily">
        <div className="panel daily__main">
          {!wizardOpen && conflict && (
            <div className="daily__banner">
              <span>Changed in Obsidian</span>
              <div className="row">
                <button className="act act--focus" onClick={reload}>
                  Reload
                </button>
                <button className="act" onClick={keepMine}>
                  Keep mine
                </button>
              </div>
            </div>
          )}
          {wizardOpen && (
            <DailyWizard
              date={date}
              step={wizardStep}
              onStepChange={setWizardStep}
              prepare={prepare}
              prepareLoading={prepareLoading}
              prepareError={prepareError}
              onRetryPrepare={openWizard}
              onClose={() => setWizardOpen(false)}
              yesterdayDone={yesterdayDone}
              yesterdayCarry={yesterdayCarry}
              onToggleDone={(line, value) => setYesterdayDone((prev) => ({ ...prev, [line]: value }))}
              onToggleCarry={(line, value) => setYesterdayCarry((prev) => ({ ...prev, [line]: value }))}
              yesterdayNotes={yesterdayNotes}
              onYesterdayNotesChange={setYesterdayNotes}
              onSkipYesterday={skipYesterday}
              onCloseYesterday={() => void closeYesterdayAndAdvance()}
              closeBusy={closeBusy}
              closeError={closeError}
              carriedItems={carriedItems}
              onCarriedItemsChange={setCarriedItems}
              newItemsText={newItemsText}
              onNewItemsTextChange={setNewItemsText}
              meetingsText={meetingsText}
              onMeetingsTextChange={setMeetingsText}
              onCreateDiary={() => void createDiary(false)}
              composeBusy={composeBusy}
              composeError={composeError}
              existsConflict={existsConflict}
              onOverwrite={() => void createDiary(true)}
              onCancelOverwrite={() => setExistsConflict(null)}
            />
          )}
          {!wizardOpen && entryLoading && !entry && <p className="muted">Loading…</p>}
          {!wizardOpen && entry && !entry.exists && (
            <div className="daily__empty">
              <p className="hint">No entry yet for {date}.</p>
              <div className="frow">
                <button className="act act--focus" onClick={createFromTemplate}>
                  Create from template
                </button>
                <button className="act" onClick={openWizard}>
                  Plan today
                </button>
              </div>
            </div>
          )}
          {!wizardOpen && entry && entry.exists && mode === "preview" && (
            <>
              <div className="row daily__taskfilter" aria-label="Task filter">
                <button
                  className={`pill ${taskFilter === "all" ? "pill--on" : ""}`}
                  aria-pressed={taskFilter === "all"}
                  onClick={() => setTaskFilter("all")}
                >
                  All
                </button>
                <button
                  className={`pill ${taskFilter === "open" ? "pill--on" : ""}`}
                  aria-pressed={taskFilter === "open"}
                  onClick={() => setTaskFilter("open")}
                >
                  Open <span className="pill__count">{taskCounts.open}</span>
                </button>
                <button
                  className={`pill ${taskFilter === "done" ? "pill--on" : ""}`}
                  aria-pressed={taskFilter === "done"}
                  onClick={() => setTaskFilter("done")}
                >
                  Done <span className="pill__count">{taskCounts.done}</span>
                </button>
              </div>
              <Markdown text={text} frontmatter="chip" taskFilter={taskFilter} onToggleTask={handleToggle} />
              <span className="daily__status muted small">{statusLabel}</span>
            </>
          )}
          {!wizardOpen && entry && entry.exists && mode === "edit" && (
            <>
              <textarea
                className="in daily__editor"
                spellCheck={false}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onBlur={() => {
                  if (dirty && !conflict) void save(text);
                }}
              />
              <span className="daily__status muted small">{statusLabel}</span>
            </>
          )}
        </div>
        <div className="panel daily__side">
          <h3>Sessions today</h3>
          {sessions.length === 0 && <p className="muted small">none yet</p>}
          {sessions.length > 0 && (
            <ul className="plainlist">
              {sessions.map((session) => {
                const title = session.title ?? session.sessionId.slice(0, 8);
                return (
                  <li key={session.sessionId} className="daily__session-row">
                    <button className="linklike daily__session-title" title={title} onClick={() => onOpenSession(session.sessionId)}>
                      {title}
                    </button>
                    <span className="daily__session-chips">
                      {session.client && <span className="chip">{session.client}</span>}
                      <span className="chip">{session.status}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
