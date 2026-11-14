import type { SettingsTabProps } from "./types";

interface Props extends SettingsTabProps {
  usageOn: boolean;
  limitsOn: boolean;
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
              Claude (reads the local Claude Code login token to ask Anthropic how much of your plan is used; never stored)
            </label>
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
