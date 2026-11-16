import { useCallback, useEffect, useState } from "react";
import { generateWriteId } from "../daily-sync";
import { getDailyEntry } from "../delegation";
import { fetchDaySummary, MemoryApiError, writeDaySummary } from "../memory-api";
import { conflictUpdatedAt, summaryFailure, summaryPreviewView, writeOutcomeText, type SummaryFailure } from "../memory-model";
import { Markdown } from "../markdown";
import type { DaySummary } from "../types";
import "../history.css";

interface Props {
  date: string;
  onClose: () => void;
  onNotice: (text: string) => void;
}

interface Loaded {
  summary: DaySummary;
  dailyExists: boolean;
  baseUpdatedAt: number | null;
}

const failureOf = (err: unknown): SummaryFailure => (err instanceof MemoryApiError ? summaryFailure(err.status, err.message) : { kind: "other", text: err instanceof Error ? err.message : "Something went wrong." });

export function DaySummaryDialog({ date, onClose, onNotice }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<SummaryFailure | null>(null);
  const [writing, setWriting] = useState(false);

  const load = useCallback(async (keepFailure: boolean) => {
    if (!keepFailure) setFailure(null);
    try {
      const [summary, entry] = await Promise.all([fetchDaySummary(date), getDailyEntry(date).catch(() => null)]);
      setLoaded({ summary, dailyExists: entry?.exists ?? true, baseUpdatedAt: entry?.updatedAt ?? null });
    } catch (err) {
      setFailure(failureOf(err));
    }
  }, [date]);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const write = async () => {
    if (loaded === null) return;
    setWriting(true);
    setFailure(null);
    try {
      const result = await writeDaySummary(date, loaded.baseUpdatedAt, generateWriteId());
      onNotice(writeOutcomeText(result, result.summary.heading));
      onClose();
    } catch (err) {
      const next = failureOf(err);
      setFailure(next);
      if (next.kind === "conflict" && err instanceof MemoryApiError) {
        const updatedAt = conflictUpdatedAt(err.body);
        setLoaded((current) => (current === null ? current : { ...current, baseUpdatedAt: updatedAt ?? current.baseUpdatedAt }));
        await load(true);
      }
    } finally {
      setWriting(false);
    }
  };

  const view = loaded === null ? null : summaryPreviewView(loaded.summary, loaded.dailyExists);

  return (
    <div className="modal__overlay" onClick={onClose}>
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label="Day summary" onClick={(event) => event.stopPropagation()}>
        <header className="modal__header">
          <h2>Day summary</h2>
          <span className="muted small">{date}</span>
        </header>
        <div className="modal__body">
          {loaded === null && failure === null && <p className="muted small">Building the summary...</p>}
          {view !== null && view.note !== null && <p className="hint">{view.note}</p>}
          {view !== null && view.markdown !== "" && <Markdown text={view.markdown} />}
          {failure !== null && (
            <p className="callout" role="alert">
              {failure.text}
            </p>
          )}
        </div>
        <footer className="modal__footer">
          {failure?.kind === "conflict" && (
            <button type="button" className="act" disabled={writing} onClick={() => void load(false)}>
              Reload
            </button>
          )}
          <button type="button" className="act act--ghost" onClick={onClose}>
            Close
          </button>
          <button type="button" className="act act--focus" disabled={writing || view === null || !view.canWrite} onClick={() => void write()}>
            {writing ? "Writing..." : "Write to daily"}
          </button>
        </footer>
      </div>
    </div>
  );
}
