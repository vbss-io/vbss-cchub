import { useEffect, useState } from "react";
import { fetchHandoffPreview, setHandoffWorkspace } from "../memory-api";
import { HANDOFF_EXPLAIN, handoffView } from "../memory-model";
import type { HandoffPreview } from "../types";
import "../history.css";

interface Props {
  name: string;
  enabled: boolean;
  onChanged: (enabled: boolean) => void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : "Something went wrong.");

export function WorkspaceContext({ name, enabled, onChanged }: Props) {
  const [preview, setPreview] = useState<HandoffPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    fetchHandoffPreview(name)
      .then((value) => {
        if (alive) setPreview(value);
      })
      .catch((err: unknown) => {
        if (alive) setProblem(messageOf(err));
      });
    return () => {
      alive = false;
    };
  }, [name]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setProblem(null);
    try {
      const memory = await setHandoffWorkspace(name, next);
      onChanged(memory.handoffWorkspaces.includes(name));
    } catch (err) {
      setProblem(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const view = preview === null ? null : handoffView(preview);

  return (
    <div className="wsrow__detail">
      <label className="check">
        <input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => void toggle(event.target.checked)} />
        Context for new sessions
      </label>
      <p className="muted small">{HANDOFF_EXPLAIN}</p>
      {problem !== null && (
        <p className="callout" role="alert">
          {problem}
        </p>
      )}
      {view === null && problem === null && <p className="muted small">Loading the preview...</p>}
      {view !== null && (
        <>
          <p className="muted small">{view.kind === "text" ? `Preview of what a new session would receive (${view.size})` : "Preview"}</p>
          {view.kind === "text" ? <pre className="mem__preview">{view.text}</pre> : <p className="muted small">{view.text}</p>}
        </>
      )}
    </div>
  );
}
