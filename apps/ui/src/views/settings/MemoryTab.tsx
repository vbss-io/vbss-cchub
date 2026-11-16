import { useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { clearHistoryIndex, rebuildHistoryIndex, runHistoryIndex } from "../../memory-api";
import { historyStats, indexStateLine, memorySettingsOf } from "../../memory-model";
import type { HistoryIndexStatus } from "../../types";
import { useHistoryStatus } from "../../use-history";
import type { SettingsTabProps } from "./types";
import "../../history.css";

interface Props extends SettingsTabProps {
  subscribeHistory: (listener: (status: HistoryIndexStatus) => void) => () => void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : "Something went wrong.");

export function MemoryTab({ enabled, settings, onSaveSettings, subscribeHistory }: Props) {
  const status = useHistoryStatus(subscribeHistory);
  const memory = memorySettingsOf(settings);
  const [heading, setHeading] = useState(memory.summaryHeading);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const indexOn = memory.historyIndex;
  const savedHeading = memory.summaryHeading;
  const headingDirty = heading.trim() !== savedHeading;

  useEffect(() => {
    setHeading(savedHeading);
  }, [savedHeading]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (err) {
      setProblem(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleIndex = (next: boolean) =>
    act(async () => {
      await onSaveSettings({ memory: { historyIndex: next } });
      if (next) await runHistoryIndex();
    });

  return (
    <>
      <section className="settings__section" id="settings-history">
        <h2>History search</h2>
        <p className="hint">
          Indexes what you and the assistants said in Claude Code and Codex so you can find it later from Ctrl+K or Sessions › Search. Only prompts and replies are kept, secrets are redacted, tool output is skipped, and
          everything stays on this machine.
        </p>
        <div className="form">
          <label className="check">
            <input type="checkbox" checked={indexOn} disabled={!enabled || busy} onChange={(event) => void toggleIndex(event.target.checked)} />
            Index session history
          </label>
          <p className="hs__note" role="status">
            {indexStateLine(status)}
          </p>
          {status !== null && status.enabled && (
            <dl className="mem__stats">
              {historyStats(status).map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="actions">
            <button type="button" className="act" disabled={!enabled || busy || !indexOn || status?.running === true} onClick={() => void act(rebuildHistoryIndex)}>
              Rebuild
            </button>
            <button type="button" className="act act--danger" disabled={!enabled || busy || status === null || status.rows === 0} onClick={() => setConfirmClear(true)}>
              Clear
            </button>
          </div>
          {problem !== null && (
            <p className="callout" role="alert">
              {problem}
            </p>
          )}
        </div>
      </section>

      <section className="settings__section" id="settings-day-summary">
        <h2>Day summary</h2>
        <p className="hint">The Day summary button in Today writes one block into the day's note under this heading. Writing again replaces only that block.</p>
        <div className="form">
          <label className="field">
            <span>Heading</span>
            <input className="in" value={heading} disabled={!enabled} maxLength={80} onChange={(event) => setHeading(event.target.value)} />
            <small>One line, up to 80 characters.</small>
          </label>
          <div className="actions">
            <button
              type="button"
              className="act act--focus"
              disabled={!enabled || busy || !headingDirty || heading.trim() === ""}
              onClick={() => void act(() => onSaveSettings({ memory: { summaryHeading: heading.trim() } }))}
            >
              Save heading
            </button>
          </div>
        </div>
      </section>

      {confirmClear && (
        <ConfirmDialog
          title="Clear the history index?"
          body="Removes the search index only. Your sessions are not touched, and the index builds again when you turn it on or press Rebuild."
          confirmLabel="Clear"
          danger
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            void act(clearHistoryIndex);
          }}
        />
      )}
    </>
  );
}
