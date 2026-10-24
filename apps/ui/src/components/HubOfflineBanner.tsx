import { useEffect, useRef, useState } from "react";
import { inTauri, restartHub } from "../sidecar";

const RETRY_AFTER_MS = 8000;

export function HubOfflineBanner() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const restart = () => {
    setBusy(true);
    setError(null);
    restartHub()
      .then(() => {
        timer.current = window.setTimeout(() => setBusy(false), RETRY_AFTER_MS);
      })
      .catch((err: unknown) => {
        setError(typeof err === "string" ? err : err instanceof Error ? err.message : "could not restart the hub");
        setBusy(false);
      });
  };

  return (
    <div className="offline-banner" role="status" aria-live="polite">
      <span className="offline-banner__text">Hub offline - reconnecting...</span>
      {inTauri() && (
        <button className="act offline-banner__btn" disabled={busy} onClick={restart}>
          {busy ? "Restarting..." : "Restart hub"}
        </button>
      )}
      {error && <span className="offline-banner__error">{error}</span>}
    </div>
  );
}
