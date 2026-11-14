import { useEffect, useState } from "react";
import type { Autonomy, AutostartStatus } from "../../delegation";
import type { SettingsTabProps } from "./types";

interface Props extends SettingsTabProps {
  autostart: AutostartStatus | null;
  onAutostart: (enabled: boolean) => Promise<void>;
}

export function GeneralTab({ enabled, settings, onSaveSettings, autostart, onAutostart }: Props) {
  const [autoBusy, setAutoBusy] = useState(false);
  const [root, setRoot] = useState(settings?.workspacesRoot ?? "");
  const [editor, setEditor] = useState(settings?.editorCommand ?? "code");
  const [brain, setBrain] = useState(settings?.secondBrainRoot ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRoot(settings?.workspacesRoot ?? "");
    setEditor(settings?.editorCommand ?? "code");
    setBrain(settings?.secondBrainRoot ?? "");
  }, [settings]);

  const toggleAutostart = async (next: boolean) => {
    setAutoBusy(true);
    try {
      await onAutostart(next);
    } finally {
      setAutoBusy(false);
    }
  };

  const dirty =
    root.trim() !== (settings?.workspacesRoot ?? "") ||
    editor.trim() !== (settings?.editorCommand ?? "code") ||
    brain.trim() !== (settings?.secondBrainRoot ?? "");

  const savePaths = async () => {
    setBusy(true);
    try {
      await onSaveSettings({ workspacesRoot: root.trim() || null, editorCommand: editor.trim() || "code", secondBrainRoot: brain.trim() || null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="settings__section" id="settings-general">
        <h2>General</h2>
        <div className="form">
          <label className="check">
            <input type="checkbox" checked={autostart?.enabled ?? false} disabled={!autostart?.supported || autoBusy} onChange={(event) => void toggleAutostart(event.target.checked)} />
            Start with Windows
          </label>
          <small className="muted">
            {autostart === null
              ? "checking…"
              : autostart.error
                ? autostart.error
                : autostart.supported
                  ? `Adds the app to your user Run key (${autostart.exe}); the hub comes up in the tray when you log in.`
                  : "Available in the installed desktop app (the app tells the hub where its executable is)."}
          </small>
          <label className="field">
            <span>Delegated runs</span>
            <select className="in" value={settings?.autonomy ?? "full"} disabled={!enabled} onChange={(event) => void onSaveSettings({ autonomy: event.target.value as Autonomy })}>
              <option value="full">Autonomous: no permission prompts (Claude), no sandbox (Codex)</option>
              <option value="safe">Safe: edits only; a denied command ends the run in Needs you</option>
            </select>
            <small>Applies to what you and your own agents delegate. Shares follow their own trust level.</small>
          </label>
          <label className="field">
            <span>Run timeout (minutes)</span>
            <input
              className="in"
              type="number"
              min={5}
              max={720}
              value={settings?.runTimeoutMinutes ?? 60}
              disabled={!enabled}
              onChange={(event) => {
                const minutes = Number(event.target.value);
                if (Number.isFinite(minutes) && minutes >= 5 && minutes <= 720) void onSaveSettings({ runTimeoutMinutes: minutes });
              }}
            />
            <small>A delegated run is cancelled after this long; a warning lands in the log 5 minutes before. 5–720, default 60.</small>
          </label>
        </div>
      </section>

      <section className="settings__section" id="settings-paths">
        <h2>Paths</h2>
        <p className="hint">Where the hub reads and writes. Nothing here is required to track sessions; workspaces and delegation need the root.</p>
        {!enabled && (
          <p className="callout">
            The hub surface (workspaces, delegation, reports) is off on this server. The desktop app turns it on by itself; in dev start the server with <code>HUB_DELEGATION=1</code>.
          </p>
        )}
        <div className="form">
          <label className="field">
            <span>Workspaces root</span>
            <input className="in" placeholder="folder holding your .code-workspace files" value={root} onChange={(event) => setRoot(event.target.value)} disabled={!enabled} />
            <small>
              One <code>&lt;name&gt;.code-workspace</code> per workspace plus a sibling <code>&lt;name&gt;/</code> folder for its context. The <code>wk</code> alias reads the same folder.
            </small>
          </label>
          <label className="field">
            <span>Editor command</span>
            <input className="in" placeholder="code" value={editor} onChange={(event) => setEditor(event.target.value)} disabled={!enabled} />
            <small>
              Used by "Open" on a workspace. <code>code</code> and <code>cursor</code> are resolved even when they are not on the PATH.
            </small>
          </label>
          <label className="field">
            <span>Second brain (Obsidian vault)</span>
            <input className="in" placeholder="optional: vault root" value={brain} onChange={(event) => setBrain(event.target.value)} disabled={!enabled} />
            <small>
              When set, every delegation, finished run and report is appended to the day's Session trail file when that feature is on, otherwise to <code>fontes/hub/&lt;date&gt;.md</code> inside the vault,
              and <code>hub_brain_today</code> can read the day's diary. Leave empty to keep the hub away from your notes.
            </small>
          </label>
          <div className="actions">
            <button className="act act--focus" disabled={!enabled || busy || !dirty} onClick={() => void savePaths()}>
              Save paths
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
