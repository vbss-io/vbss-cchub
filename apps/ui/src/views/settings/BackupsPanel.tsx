import { useCallback, useEffect, useState } from "react";
import { BackupsUnavailableError, createBackup, getBackups } from "../../delegation";
import type { BackupReason, BackupsOverview } from "../../delegation";

const REASON_LABEL: Record<BackupReason, string> = {
  upgrade: "Upgrade",
  daily: "Daily",
  manual: "Manual",
  "pre-restore": "Before restore",
};

const SIZE_UNITS = ["B", "KB", "MB", "GB"];

export function formatBackupSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${SIZE_UNITS[unit]}`;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : "request failed");

type Load = { state: "loading" } | { state: "unavailable" } | { state: "failed"; message: string } | { state: "ready"; overview: BackupsOverview };

export function BackupsPanel() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<Load> => {
    try {
      return { state: "ready", overview: await getBackups() };
    } catch (error) {
      if (error instanceof BackupsUnavailableError) return { state: "unavailable" };
      return { state: "failed", message: errorMessage(error) };
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void refresh().then((next) => {
      if (!cancelled) setLoad(next);
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const backUpNow = async () => {
    setRunning(true);
    setRunError(null);
    try {
      await createBackup();
      setLoad(await refresh());
    } catch (error) {
      setRunError(errorMessage(error));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="backups">
      <h3>Data and backups</h3>
      {load.state === "loading" && <p className="hint">Loading backups…</p>}
      {load.state === "unavailable" && <p className="hint">Backups are not available on this hub version.</p>}
      {load.state === "failed" && <p className="error">{load.message}</p>}
      {load.state === "ready" && (
        <>
          <p className="hint">
            The hub backs up its database before an upgrade and once a day, and keeps a copy of each vault file as it was before its first change of the day.
          </p>
          <div className="backups__bar">
            <button className="act act--focus" disabled={running} onClick={() => void backUpNow()}>
              {running ? "Backing up…" : "Back up now"}
            </button>
            {runError && <span className="error small">{runError}</span>}
          </div>
          {load.overview.lastError && (
            <p className="error backups__failure">
              Last backup failed on {new Date(load.overview.lastError.at).toLocaleString()}: {load.overview.lastError.message}
            </p>
          )}
          {load.overview.backups.length === 0 ? (
            <p className="hint">No backups yet.</p>
          ) : (
            <ul className="backups__list">
              {load.overview.backups.map((backup) => (
                <li key={backup.file} className="backups__row">
                  <span className="backups__when">{new Date(backup.createdAt).toLocaleString()}</span>
                  <span className="tag tag--muted">{REASON_LABEL[backup.reason]}</span>
                  <span className="muted small backups__size">{formatBackupSize(backup.size)}</span>
                </li>
              ))}
            </ul>
          )}
          <dl className="details backups__paths">
            <dt>Backups</dt>
            <dd>
              <span className="path backups__path">{load.overview.backupsDir}</span>
            </dd>
            <dt>Vault snapshots</dt>
            <dd>
              <span className="path backups__path">{load.overview.snapshotsDir}</span>
              <span className="muted small">{load.overview.snapshotDays} {load.overview.snapshotDays === 1 ? "day" : "days"} of vault snapshots</span>
            </dd>
          </dl>
        </>
      )}
    </div>
  );
}
