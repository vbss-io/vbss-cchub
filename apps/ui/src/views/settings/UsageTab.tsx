import { useEffect, useState } from "react";
import { Toggletip } from "../../components/Toggletip";
import { changeClaudeStatusline, fetchClaudeLimitsSource, saveClaudeLimitsSource, type ClaudeLimitsSource } from "../../delegation";
import { timeAgo } from "../../usage-format";
import { FALLBACK_HELP, STATUSLINE_HELP, claudeSourceRow, type StatuslineButton } from "../../claude-source";
import type { SettingsTabProps } from "./types";

interface Props extends SettingsTabProps {
  usageOn: boolean;
  limitsOn: boolean;
}

function ClaudeSourceRow({ enabled }: { enabled: boolean }) {
  const [source, setSource] = useState<ClaudeLimitsSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void fetchClaudeLimitsSource().then((value) => {
      if (alive) setSource(value);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);

  const act = async (work: () => Promise<ClaudeLimitsSource>) => {
    setBusy(true);
    setError(null);
    try {
      setSource(await work());
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    } finally {
      setBusy(false);
    }
  };

  const row = claudeSourceRow(source);
  const button = (item: StatuslineButton, focus: boolean) => (
    <button key={item.label} className={`act ${focus ? "act--focus" : ""}`} disabled={!enabled || busy || !source} onClick={() => void act(() => changeClaudeStatusline(item.action))}>
      {busy ? "Working…" : item.label}
    </button>
  );

  return (
    <div className="field">
      <span>
        Claude limits source{" "}
        <Toggletip label="About the Claude limits source">{STATUSLINE_HELP}</Toggletip>
      </span>
      <div className="statusrow">
        <span className={`tag tag--${row.tone}`}>{row.tag}</span>
        {row.detail && <span className="muted">{row.detail}</span>}
        {source?.lastReportAt != null && <span className="muted">last report {timeAgo(source.lastReportAt, Date.now())}</span>}
        {source?.statusline.settingsPath && <span className="path muted">{source.statusline.settingsPath}</span>}
        <span className="spacer" />
        {row.secondary && button(row.secondary, false)}
        {row.primary && button(row.primary, row.primary.action === "install")}
      </div>
      {error && <small className="error">{error}</small>}
      <label className="check">
        <input
          type="checkbox"
          checked={source?.privateFallback ?? true}
          disabled={!enabled || busy || !source}
          onChange={(event) => {
            const privateFallback = event.target.checked;
            void act(() => saveClaudeLimitsSource({ privateFallback }));
          }}
        />
        Fall back to the private usage endpoint when the status line has not reported for {source?.freshMinutes ?? 15} minutes{" "}
        <Toggletip label="About the private fallback">{FALLBACK_HELP}</Toggletip>
      </label>
    </div>
  );
}

export function UsageTab({ enabled, settings, onSaveSettings, usageOn, limitsOn }: Props) {
  return (
    <>
      {usageOn && (
        <section className="settings__section" id="settings-usage">
          <h2>Usage</h2>
          <p className="hint">Token usage per Claude and Codex, shown in the widget Usage tab and the Usage view.</p>
          <div className="form">
            <label className="field">
              <span>Window: {settings?.usage?.days ?? 7} days</span>
              <input
                className="in"
                type="number"
                min={1}
                max={30}
                value={settings?.usage?.days ?? 7}
                disabled={!enabled}
                onChange={(event) => {
                  const days = Number(event.target.value);
                  if (Number.isInteger(days) && days >= 1 && days <= 30) void onSaveSettings({ usage: { days } });
                }}
              />
              <small>How many days the Usage summaries cover. 1-30, default 7.</small>
            </label>
          </div>
        </section>
      )}
      {limitsOn && (
        <section className="settings__section" id="settings-limits">
          <h2>Limits</h2>
          <p className="hint">Quota windows (5 h and 7 d) for Claude and Codex, and the weekly rings on the widget.</p>
          <div className="form">
            <label className="check">
              <input type="checkbox" checked={settings?.limits?.claude ?? false} disabled={!enabled} onChange={(event) => void onSaveSettings({ limits: { claude: event.target.checked } })} />
              Claude (from the Claude Code status line once its wrapper is installed below; otherwise reads the local Claude Code login token to ask Anthropic, never stored)
            </label>
            {(settings?.limits?.claude ?? false) && <ClaudeSourceRow enabled={enabled} />}
            <label className="check">
              <input type="checkbox" checked={settings?.limits?.codex ?? false} disabled={!enabled} onChange={(event) => void onSaveSettings({ limits: { codex: event.target.checked } })} />
              Codex (from the local Codex session files)
            </label>
            <label className="check">
              <input type="checkbox" checked={settings?.limits?.codexLive ?? false} disabled={!enabled} onChange={(event) => void onSaveSettings({ limits: { codexLive: event.target.checked } })} />
              Codex live (asks the Codex app-server for the account-wide numbers; otherwise the last local session snapshot)
            </label>
            <label className="field">
              <span>Refresh every {settings?.limits?.refreshMinutes ?? 5} minutes</span>
              <input
                className="in"
                type="number"
                min={1}
                max={60}
                value={settings?.limits?.refreshMinutes ?? 5}
                disabled={!enabled}
                onChange={(event) => {
                  const minutes = Number(event.target.value);
                  if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 60) void onSaveSettings({ limits: { refreshMinutes: minutes } });
                }}
              />
              <small>1-60, default 5.</small>
            </label>
          </div>
        </section>
      )}
    </>
  );
}
