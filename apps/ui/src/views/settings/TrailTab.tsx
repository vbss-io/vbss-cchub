import { useEffect, useState } from "react";
import { subscribe } from "../../api";
import { flushTrail, getTrail, type TrailDetail, type TrailStatus } from "../../delegation";
import { Advanced } from "./Advanced";
import type { SettingsTabProps } from "./types";

const TRAIL_LEVELS: { key: TrailDetail; label: string; hint: string }[] = [
  { key: "light", label: "Light", hint: "Key points only: outcomes, decisions, root causes; about 5 bullets per session per day." },
  { key: "medium", label: "Medium", hint: "1-3 bullets every 80 turns, no cap." },
  { key: "high", label: "High", hint: "3-6 bullets per window with files and commands touched." },
];

const TRAIL_REFRESH_MS = 30000;

export function TrailTab({ enabled, settings, onSaveSettings }: SettingsTabProps) {
  const [dir, setDir] = useState(settings?.trail?.dir ?? "");
  const [detail, setDetail] = useState<TrailDetail>(settings?.trail?.detail ?? "light");
  const [model, setModel] = useState(settings?.trail?.model ?? "");
  const [prompt, setPrompt] = useState(settings?.trail?.prompt ?? "");
  const [hubEvents, setHubEvents] = useState(settings?.trail?.hubEvents ?? true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<TrailStatus | null>(null);

  useEffect(() => {
    setDir(settings?.trail?.dir ?? "");
    setDetail(settings?.trail?.detail ?? "light");
    setModel(settings?.trail?.model ?? "");
    setPrompt(settings?.trail?.prompt ?? "");
    setHubEvents(settings?.trail?.hubEvents ?? true);
  }, [settings]);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      getTrail()
        .then((next) => {
          if (alive) setStatus(next);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, TRAIL_REFRESH_MS);
    const unsubscribe = subscribe({ onSession: () => undefined, onTrail: refresh });
    return () => {
      alive = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, []);

  const dirty =
    dir.trim() !== (settings?.trail?.dir ?? "") ||
    detail !== (settings?.trail?.detail ?? "light") ||
    model.trim() !== (settings?.trail?.model ?? "") ||
    prompt !== (settings?.trail?.prompt ?? "") ||
    hubEvents !== (settings?.trail?.hubEvents ?? true);

  const save = async () => {
    setBusy(true);
    try {
      await onSaveSettings({ trail: { dir: dir.trim() || null, detail, model: model.trim() || null, prompt: prompt.trim() || null, hubEvents } });
    } finally {
      setBusy(false);
    }
  };

  const resetPrompt = async () => {
    setBusy(true);
    try {
      setPrompt("");
      await onSaveSettings({ trail: { prompt: null } });
    } finally {
      setBusy(false);
    }
  };

  const summarizeNow = async () => {
    setBusy(true);
    try {
      await flushTrail();
      setStatus(await getTrail());
    } catch {
      return;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings__section" id="settings-trail">
      <h2>Session trail</h2>
      <p className="hint">Summarizes each Claude Code session into a per-day file in your second brain and keeps the hub's own trail there too; needs the Second brain path.</p>
      <div className="form">
        <label className="field">
          <span>Folder</span>
          <input
            className="in"
            placeholder={settings?.secondBrainRoot ? `${settings.secondBrainRoot}/trail` : "<second brain>/trail"}
            value={dir}
            onChange={(event) => setDir(event.target.value)}
            disabled={!enabled}
          />
        </label>
        <div className="field">
          <span>Detail</span>
          <div className="trail__levels" role="radiogroup" aria-label="Trail detail">
            {TRAIL_LEVELS.map((level) => (
              <label key={level.key} className={`trail__level ${detail === level.key ? "trail__level--on" : ""}`}>
                <span className="trail__level-name">
                  <input type="radio" name="trail-detail" checked={detail === level.key} disabled={!enabled} onChange={() => setDetail(level.key)} />
                  {level.label}
                </span>
                <span className="trail__level-desc">{level.hint}</span>
              </label>
            ))}
          </div>
          <small>Light is what most people want: about 5 key points per session per day.</small>
        </div>
        <div className="trail__status">
          {status ? (
            <>
              <span>
                Today: {status.today.sessions} sessions · {status.today.hubLines} hub lines · queue {status.queue}
              </span>
              {status.running && <span>Summarizing {status.running.sessionId.slice(0, 8)}…</span>}
              {status.lastError && <span className="trail__status-error">{status.lastError}</span>}
            </>
          ) : (
            <span>Status unavailable</span>
          )}
          <button className="act" disabled={!enabled || busy} onClick={() => void summarizeNow()}>
            Summarize now
          </button>
        </div>
        <Advanced>
          <label className="field">
            <span>Model</span>
            <input className="in" placeholder="haiku" value={model} onChange={(event) => setModel(event.target.value)} disabled={!enabled} />
          </label>
          <label className="check">
            <input type="checkbox" checked={hubEvents} onChange={(event) => setHubEvents(event.target.checked)} disabled={!enabled} />
            Hub events in the same file
          </label>
          <label className="field">
            <span>Prompt override</span>
            <textarea className="in area" rows={6} value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={!enabled} />
            <small>Replaces the built-in prompt for every level; leave empty to use the level defaults.</small>
          </label>
          <div className="actions actions--start">
            <button type="button" className="act" disabled={!enabled || busy} onClick={() => void resetPrompt()}>
              Reset to default
            </button>
          </div>
        </Advanced>
        <div className="actions">
          <button className="act act--focus" disabled={!enabled || busy || !dirty} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </section>
  );
}
