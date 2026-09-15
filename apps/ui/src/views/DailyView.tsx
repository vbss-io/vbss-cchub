import { useEffect, useState } from "react";
import type { DailyStreamEvent } from "../api";
import {
  DailyConflictError,
  generateDaily,
  getDaily,
  getDailyEntry,
  listDailySessions,
  saveDailyEntry,
  type DailyEntry,
  type DailyOverview,
  type DailySession,
  type DelegationSettings,
} from "../delegation";
import { Markdown, toggleTaskLine } from "../markdown";

interface Props {
  settings: DelegationSettings | null;
  onOpenSession: (sessionId: string) => void;
  onOpenTask: (taskId: string) => void;
  subscribeDaily: (listener: (event: DailyStreamEvent) => void) => () => void;
}

type Mode = "preview" | "edit";
type SaveStatus = "idle" | "saving" | "saved" | "unsaved";

interface Conflict {
  content: string | null;
  updatedAt: number | null;
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
  return ["---", "type: diario", `date: ${date}`, "---", `# ${date}`, "", "## Briefing", "", "## Focus", "", "## Meetings", "", "## Sessions", ""].join(
    "\n",
  );
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
  const [showGenerate, setShowGenerate] = useState(false);
  const [focusText, setFocusText] = useState("");
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generateBusy, setGenerateBusy] = useState(false);

  const enabled = settings?.features.daily === true;
  const dirty = text !== savedText;

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

  useEffect(() => {
    if (!enabled || !date) return;
    void loadEntry(date);
    void listDailySessions(date)
      .then(setSessions)
      .catch(() => setSessions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, date]);

  useEffect(() => {
    if (!enabled || !date) return;
    const id = window.setInterval(() => {
      void listDailySessions(date)
        .then(setSessions)
        .catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(id);
  }, [enabled, date]);

  const save = async (next: string) => {
    if (!date) return;
    setSaveStatus("saving");
    try {
      const result = await saveDailyEntry(date, next, baseUpdatedAt);
      setSavedText(next);
      setBaseUpdatedAt(result.updatedAt);
      setEntry((current) => (current ? { ...current, exists: true, content: next, updatedAt: result.updatedAt, path: result.path } : current));
      setSaveStatus("saved");
      setSavedAt(Date.now());
    } catch (err) {
      if (err instanceof DailyConflictError) {
        setConflict({ content: err.content, updatedAt: err.updatedAt });
        setSaveStatus("unsaved");
        return;
      }
      setSaveStatus("unsaved");
    }
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
      if (event.date !== date) return;
      if (!dirty) {
        void loadEntry(event.date);
        return;
      }
      setConflict({ content: null, updatedAt: event.updatedAt });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, date, dirty]);

  const reload = () => {
    if (!date) return;
    if (conflict?.content != null) {
      applyLoaded({ date, path: entry?.path ?? "", exists: true, content: conflict.content, updatedAt: conflict.updatedAt });
      return;
    }
    void loadEntry(date);
  };

  const keepMine = () => {
    if (conflict) setBaseUpdatedAt(conflict.updatedAt);
    setConflict(null);
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

  const runGenerate = async () => {
    if (!date) return;
    setGenerateBusy(true);
    setGenerateError(null);
    try {
      await generateDaily(date, focusText);
      setShowGenerate(false);
      setFocusText("");
      loadOverview();
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "could not start generation");
    } finally {
      setGenerateBusy(false);
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

  if (overviewFailed === "error" || !overview || !date) {
    return (
      <div className="view">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const running = overview.running && overview.running.date === date ? overview.running : null;
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
        <button className="act act--focus" onClick={() => setShowGenerate((v) => !v)}>
          Generate
        </button>
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

      {showGenerate && (
        <div className="panel">
          <label className="field">
            <span>What are you working on today? (optional)</span>
            <textarea className="in area" rows={2} value={focusText} onChange={(event) => setFocusText(event.target.value)} />
          </label>
          <div className="actions">
            {generateError && <span className="error small">{generateError}</span>}
            <button className="act act--focus" disabled={generateBusy} onClick={() => void runGenerate()}>
              {generateBusy ? "Starting…" : "Run"}
            </button>
          </div>
        </div>
      )}

      <div className="daily">
        <div className="panel daily__main">
          {conflict && (
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
          {entryLoading && !entry && <p className="muted">Loading…</p>}
          {entry && !entry.exists && (
            <div className="daily__empty">
              <p className="hint">No entry yet for {date}.</p>
              <div className="frow">
                <button className="act act--focus" onClick={createFromTemplate}>
                  Create from template
                </button>
                <button className="act" onClick={() => setShowGenerate(true)}>
                  Generate
                </button>
              </div>
            </div>
          )}
          {entry && entry.exists && mode === "preview" && (
            <>
              <Markdown text={text} frontmatter="chip" onToggleTask={handleToggle} />
              <span className="daily__status muted small">{statusLabel}</span>
            </>
          )}
          {entry && entry.exists && mode === "edit" && (
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
              {sessions.map((session) => (
                <li key={session.sessionId}>
                  <button className="linklike" onClick={() => onOpenSession(session.sessionId)}>
                    {session.title ?? session.sessionId.slice(0, 8)}
                  </button>{" "}
                  {session.client && <span className="chip">{session.client}</span>} <span className="chip">{session.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
