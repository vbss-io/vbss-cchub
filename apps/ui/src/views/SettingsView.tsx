import { useEffect, useState } from "react";
import { getDesktopNotifyStatus, sendToast, type DesktopNotifyStatus, type HooksStatus } from "../api";
import { GroupManager } from "../components/GroupManager";
import type { ConnectStatus, DelegationSettings, McpClient, ShellKind } from "../delegation";
import { COFFEE_URL, GITHUB_URL, notify, openExternal, playSound } from "../notify";
import type { SessionClient } from "../types";
import type { Autonomy, AutostartStatus, TunnelStatus } from "../delegation";
import { claudeClient } from "../clients";
import type { GroupRecord } from "../types";
import { NOTIF_EVENT_META, type NotifEventKind, type NotifStyle } from "../notifications";

export interface NotifSettings {
  enabled: boolean;
  desktop: boolean;
  sound: boolean;
  style: NotifStyle;
  events: Record<NotifEventKind, boolean>;
  clients: Record<SessionClient, boolean>;
}

const NOTIF_STYLE_META: { key: NotifStyle; label: string; hint: string }[] = [
  { key: "cchub", label: "CC Hub window", hint: "Our own popup bottom-right, independent of Windows settings." },
  { key: "windows", label: "Windows", hint: "System toasts, need Windows notifications on." },
  { key: "both", label: "Both", hint: "Our popup and a Windows toast." },
];

export const NOTIF_CLIENTS: SessionClient[] = ["terminal", "vscode", "wsl", "claude-desktop", "headless", "hub", "share"];

export type SettingsSection = "support" | "general" | "appearance" | "paths" | "hooks" | "connect" | "sharing" | "notifications" | "groups" | "about";

export type ThemeName = "dracula" | "midnight";

const SECTIONS: { key: SettingsSection; label: string }[] = [
  { key: "support", label: "Support" },
  { key: "general", label: "General" },
  { key: "appearance", label: "Appearance" },
  { key: "paths", label: "Paths" },
  { key: "hooks", label: "Hooks" },
  { key: "connect", label: "Connections" },
  { key: "sharing", label: "Sharing" },
  { key: "notifications", label: "Notifications" },
  { key: "groups", label: "Groups" },
  { key: "about", label: "About" },
];

const MCP_LABEL: Record<McpClient, string> = {
  "claude-code": "Claude Code (CLI, VS Code, terminal)",
  "claude-desktop": "Claude Desktop",
  codex: "Codex CLI and Codex app",
};

const SHELL_LABEL: Record<ShellKind, string> = { bash: "bash (~/.bashrc)", powershell: "PowerShell profile" };

interface Props {
  enabled: boolean;
  hubUrl: string;
  version: string;
  section: SettingsSection | null;
  settings: DelegationSettings | null;
  connect: ConnectStatus | null;
  hooks: HooksStatus | null;
  hooksBusy: boolean;
  notif: NotifSettings;
  groups: GroupRecord[];
  onToggleHooks: () => void;
  onSaveSettings: (patch: Partial<DelegationSettings>) => Promise<void>;
  onShell: (kind: ShellKind, action: "install" | "uninstall") => Promise<void>;
  onMcp: (client: McpClient, action: "install" | "uninstall") => Promise<void>;
  tunnel: TunnelStatus | null;
  onTunnelSettings: (patch: { authtoken?: string | null; domain?: string | null }) => Promise<void>;
  autostart: AutostartStatus | null;
  onAutostart: (enabled: boolean) => Promise<void>;
  theme: ThemeName;
  onTheme: (theme: ThemeName) => void;
  onNotif: (next: NotifSettings) => void;
  onWhatsNew: () => void;
  onCreateGroup: (name: string, match: string) => void;
  onUpdateGroup: (id: string, fields: { name?: string; match?: string }) => void;
  onDeleteGroup: (id: string) => void;
  onMoveGroup: (id: string, direction: -1 | 1) => void;
}

export function SettingsView(props: Props) {
  const { enabled, hubUrl, version, section, settings, connect, hooks, hooksBusy, notif, groups, tunnel } = props;
  const [desktopStatus, setDesktopStatus] = useState<DesktopNotifyStatus | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  useEffect(() => {
    void getDesktopNotifyStatus().then(setDesktopStatus).catch(() => setDesktopStatus(null));
  }, []);
  const styleWindows = notif.style === "windows" || notif.style === "both";
  const styleCchub = notif.style === "cchub" || notif.style === "both";
  const windowsBlocked = styleWindows && desktopStatus?.supported === true && (desktopStatus.toastsEnabled === false || desktopStatus.appEnabled === false);
  const sendTest = async () => {
    if (styleCchub) await sendToast({ kind: "taskCompleted", id: `test-${Date.now()}`, title: "Test notification", body: "This is a CC Hub toast." });
    if (!styleWindows) {
      setTestResult("Sent to the CC Hub toast window (bottom-right).");
      return;
    }
    const outcome = await notify("VBSS CCHUB", "Test notification — this is what an alert looks like.");
    const fresh = await getDesktopNotifyStatus(true).catch(() => null);
    if (fresh) setDesktopStatus(fresh);
    if (outcome === "none") {
      setTestResult("Could not send: the hub did not accept the toast and the desktop plugin is not available.");
      return;
    }
    const blocked = fresh?.supported === true && (fresh.toastsEnabled === false || fresh.appEnabled === false);
    setTestResult(
      blocked
        ? `Sent to Windows via ${outcome === "hub" ? "the hub" : "the desktop plugin"}, but Windows is dropping notifications for this account or app (see the warning above).`
        : `Sent to Windows via ${outcome === "hub" ? "the hub (io.vbss.cchub)" : "the desktop plugin"}. It shows bottom-right unless Focus Assist is on.`,
    );
  };
  const [ngrokToken, setNgrokToken] = useState("");
  const [ngrokDomain, setNgrokDomain] = useState(tunnel?.domain ?? "");
  const [ngrokBusy, setNgrokBusy] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const toggleAutostart = async (next: boolean) => {
    setAutoBusy(true);
    try {
      await props.onAutostart(next);
    } finally {
      setAutoBusy(false);
    }
  };
  useEffect(() => {
    setNgrokDomain(tunnel?.domain ?? "");
  }, [tunnel?.domain]);
  const saveNgrok = async () => {
    setNgrokBusy(true);
    try {
      await props.onTunnelSettings({ authtoken: ngrokToken.trim() ? ngrokToken.trim() : undefined, domain: ngrokDomain.trim() || null });
      setNgrokToken("");
    } finally {
      setNgrokBusy(false);
    }
  };
  const clearNgrokToken = async () => {
    setNgrokBusy(true);
    try {
      await props.onTunnelSettings({ authtoken: null });
      setNgrokToken("");
    } finally {
      setNgrokBusy(false);
    }
  };
  const [root, setRoot] = useState(settings?.workspacesRoot ?? "");
  const [editor, setEditor] = useState(settings?.editorCommand ?? "code");
  const [brain, setBrain] = useState(settings?.secondBrainRoot ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRoot(settings?.workspacesRoot ?? "");
    setEditor(settings?.editorCommand ?? "code");
    setBrain(settings?.secondBrainRoot ?? "");
  }, [settings]);

  useEffect(() => {
    if (!section) return;
    document.getElementById(`settings-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [section]);

  const dirty =
    root.trim() !== (settings?.workspacesRoot ?? "") ||
    editor.trim() !== (settings?.editorCommand ?? "code") ||
    brain.trim() !== (settings?.secondBrainRoot ?? "");

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const wslInstalled = hooks?.wsl?.filter((item) => item.installed).length ?? 0;

  return (
    <div className="view view--settings">
      <nav className="subnav">
        {SECTIONS.map((item) => (
          <a key={item.key} className={`pill ${section === item.key ? "pill--on" : ""}`} href={`#/settings/${item.key}`}>
            {item.label}
          </a>
        ))}
      </nav>

      <section className="settings__section" id="settings-support">
        <h2>Support</h2>
        <p className="hint">CC Hub is free and open source. Star the repo, open an issue, or buy a coffee to keep it going.</p>
        <div className="frow">
          <button className="act" onClick={() => void openExternal(GITHUB_URL)}>
            GitHub
          </button>
          <button className="act" onClick={() => void openExternal(COFFEE_URL)}>
            Buy me a coffee
          </button>
          <button className="act act--ghost" onClick={props.onWhatsNew}>
            What's new
          </button>
        </div>
      </section>

      <section className="settings__section" id="settings-general">
        <h2>General</h2>
        <div className="form">
          <label className="check">
            <input
              type="checkbox"
              checked={props.autostart?.enabled ?? false}
              disabled={!props.autostart?.supported || autoBusy}
              onChange={(event) => void toggleAutostart(event.target.checked)}
            />
            Start with Windows
          </label>
          <small className="muted">
            {props.autostart === null
              ? "checking…"
              : props.autostart.error
                ? props.autostart.error
                : props.autostart.supported
                  ? `Adds the app to your user Run key (${props.autostart.exe}); the hub comes up in the tray when you log in.`
                  : "Available in the installed desktop app (the app tells the hub where its executable is)."}
          </small>
          <label className="field">
            <span>Delegated runs</span>
            <select className="in" value={settings?.autonomy ?? "full"} disabled={!enabled} onChange={(event) => void props.onSaveSettings({ autonomy: event.target.value as Autonomy })}>
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
                if (Number.isFinite(minutes) && minutes >= 5 && minutes <= 720) void props.onSaveSettings({ runTimeoutMinutes: minutes });
              }}
            />
            <small>A delegated run is cancelled after this long; a warning lands in the log 5 minutes before. 5–720, default 60.</small>
          </label>
        </div>
      </section>

      <section className="settings__section" id="settings-appearance">
        <h2>Appearance</h2>
        <label className="field">
          <span>Theme</span>
          <select className="in" value={props.theme} onChange={(event) => props.onTheme(event.target.value as ThemeName)}>
            <option value="dracula">Dracula (VS Code / Obsidian)</option>
            <option value="midnight">Midnight (previous look)</option>
          </select>
          <small>Colors and surfaces only; the logo does not change.</small>
        </label>
      </section>

      <section className="settings__section" id="settings-paths">
        <h2>Paths</h2>
        <p className="hint">
          Where the hub reads and writes. Nothing here is required to track sessions; workspaces and delegation need the root.
        </p>
        {!enabled && (
          <p className="callout">
            The hub surface (workspaces, delegation, reports) is off on this server. The desktop app turns it on by itself; in dev start the server with{" "}
            <code>HUB_DELEGATION=1</code>.
          </p>
        )}
        <div className="form">
          <label className="field">
            <span>Workspaces root</span>
            <input className="in" placeholder="folder holding your .code-workspace files" value={root} onChange={(event) => setRoot(event.target.value)} disabled={!enabled} />
            <small>
              One <code>&lt;name&gt;.code-workspace</code> per workspace plus a sibling <code>&lt;name&gt;/</code> folder for its context. The <code>wk</code>{" "}
              alias reads the same folder.
            </small>
          </label>
          <label className="field">
            <span>Editor command</span>
            <input className="in" placeholder="code" value={editor} onChange={(event) => setEditor(event.target.value)} disabled={!enabled} />
            <small>Used by "Open" on a workspace. <code>code</code> and <code>cursor</code> are resolved even when they are not on the PATH.</small>
          </label>
          <label className="field">
            <span>Second brain (Obsidian vault)</span>
            <input className="in" placeholder="optional: vault root" value={brain} onChange={(event) => setBrain(event.target.value)} disabled={!enabled} />
            <small>
              When set, every delegation, finished run and report is appended to <code>fontes/hub/&lt;date&gt;.md</code> inside the vault, and{" "}
              <code>hub_brain_today</code> can read the day's diary. Leave empty to keep the hub away from your notes.
            </small>
          </label>
          <div className="actions">
            <button
              className="act act--focus"
              disabled={!enabled || busy || !dirty}
              onClick={() =>
                void run(() =>
                  props.onSaveSettings({
                    workspacesRoot: root.trim() || null,
                    editorCommand: editor.trim() || "code",
                    secondBrainRoot: brain.trim() || null,
                  }),
                )
              }
            >
              Save paths
            </button>
          </div>
        </div>
      </section>

      <section className="settings__section" id="settings-hooks">
        <h2>Hooks</h2>
        <p className="hint">
          Claude Code hooks are how sessions reach the hub: session start, prompts, notifications, stops, subagent start and stop, session end. They
          post to <code>{hubUrl}</code> and never block Claude.
        </p>
        <div className="statusrow">
          <span className={`tag tag--${hooks?.installed ? "go" : "muted"}`}>
            {!hooks ? "checking" : hooks.installed ? "installed" : "not installed"}
          </span>
          {hooks?.installed && <span className="muted">{hooks.events.length} events{wslInstalled > 0 ? ` · ${wslInstalled} WSL distro${wslInstalled === 1 ? "" : "s"}` : ""}</span>}
          {hooks?.settingsPath && <span className="path muted">{hooks.settingsPath}</span>}
          <span className="spacer" />
          <button className={`act ${hooks?.installed ? "" : "act--focus"}`} disabled={hooksBusy || !hooks} onClick={props.onToggleHooks}>
            {hooksBusy ? "Working…" : hooks?.installed ? "Remove hooks" : "Install hooks"}
          </button>
        </div>
        {hooks?.wsl && hooks.wsl.length > 0 && (
          <ul className="plainlist">
            {hooks.wsl.map((item) => (
              <li key={item.distro}>
                <span className="muted">WSL {item.distro}:</span> {item.error ?? (item.installed ? "installed" : "not installed")}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings__section" id="settings-connect">
        <h2>Connections</h2>
        <p className="hint">
          Agents talk to the hub through the <code>cchub</code> MCP server. Once a client is connected it gets <code>hub_overview</code>,{" "}
          <code>hub_workspaces</code>, <code>hub_delegate</code>, <code>hub_task</code>, <code>hub_report</code> and the other tools. Restart the client
          after connecting.
        </p>
        {!enabled && <p className="callout">Available once the hub surface is on.</p>}
        {enabled && !connect && <p className="muted">Loading…</p>}
        {connect && !connect.mcpEntryExists && (
          <p className="error">MCP entry missing at {connect.mcpEntry}. Build the server (npm run build) or use the installed app.</p>
        )}
        {connect && (
          <>
            <ul className="connectlist">
              {(Object.keys(MCP_LABEL) as McpClient[]).map((client) => {
                const item = connect.mcp[client];
                return (
                  <li key={client} className="connectrow">
                    <div className="connectrow__info">
                      <span className="connectrow__name">
                        {MCP_LABEL[client]}{" "}
                        <span className={`tag tag--${item.installed ? "go" : "muted"}`}>
                          {item.installed ? (item.inFile ? "connected" : "connected · imported by the app") : "not connected"}
                        </span>
                      </span>
                      <span className="path muted">{item.error ?? item.path}</span>
                      {client === "claude-desktop" && item.installed && !item.inFile && (
                        <span className="muted small">Claude Desktop moved the entry into its own settings after reading it; that is normal.</span>
                      )}
                    </div>
                    {item.installed ? (
                      <button className="act" disabled={busy} onClick={() => void run(() => props.onMcp(client, "uninstall"))}>
                        Disconnect
                      </button>
                    ) : (
                      <button className="act act--focus" disabled={busy || !!item.error || !connect.mcpEntryExists} onClick={() => void run(() => props.onMcp(client, "install"))}>
                        Connect
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            <h3>Shell alias</h3>
            <p className="hint">
              <code>wk</code> lists your workspaces and <code>wk &lt;name&gt;</code> opens one in the editor, from the same root as the hub. Reopen the terminal after installing.
            </p>
            <ul className="connectlist">
              {(Object.keys(SHELL_LABEL) as ShellKind[]).map((shell) => {
                const item = connect.shell[shell];
                const label = item.installed ? "installed" : item.external ? "you already define wk" : "not installed";
                return (
                  <li key={shell} className="connectrow">
                    <div className="connectrow__info">
                      <span className="connectrow__name">
                        {SHELL_LABEL[shell]} <span className={`tag tag--${item.installed ? "go" : item.external ? "pend" : "muted"}`}>{label}</span>
                      </span>
                      <span className="path muted">{item.path}</span>
                    </div>
                    {item.installed ? (
                      <button className="act" disabled={busy} onClick={() => void run(() => props.onShell(shell, "uninstall"))}>
                        Remove
                      </button>
                    ) : (
                      <button className="act act--focus" disabled={busy || item.external} onClick={() => void run(() => props.onShell(shell, "install"))}>
                        Install
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            <h3>Manual entry</h3>
            <p className="hint">For any other MCP client, register this stdio server:</p>
            <pre className="snippet">{JSON.stringify({ mcpServers: { cchub: connect.server } }, null, 2)}</pre>
          </>
        )}
      </section>

      <section className="settings__section" id="settings-sharing">
        <h2>Sharing</h2>
        <p className="hint">
          Share links let another person and their assistant ask your Claude (read-only) or delegate work inside one workspace. They are served
          on a separate port that exposes nothing else; every link carries its own key and can be paused or revoked in the Share view.
        </p>
        <dl className="details">
          <dt>Share endpoint</dt>
          <dd className="path">{tunnel?.localUrl ?? "—"}</dd>
          <dt>LAN address</dt>
          <dd className="path">{tunnel?.lanUrl ?? "no LAN address found"}</dd>
          <dt>ngrok</dt>
          <dd className="path">{tunnel?.installed ? tunnel.binary : "not installed yet; Start tunnel downloads it into the hub data folder"}</dd>
          <dt>Tunnel</dt>
          <dd>
            <span className={`tag ${tunnel?.state === "running" ? "tag--go" : tunnel?.state === "error" ? "tag--hold" : "tag--muted"}`}>{tunnel?.state ?? "unknown"}</span>{" "}
            {tunnel?.publicUrl && <span className="path">{tunnel.publicUrl}</span>}
            {tunnel?.error && <span className="error small">{tunnel.error.includes("ERR_NGROK_314") ? "ngrok refused the custom hostname: free accounts can only use their .ngrok-free.app domain. Clear the domain or upgrade the plan." : tunnel.error}</span>}
          </dd>
        </dl>
        <h3>Identity</h3>
        <div className="form">
          <label className="field">
            <span>Your name (shown to askers)</span>
            <input className="in" defaultValue={settings?.ownerName ?? ""} onBlur={(event) => { if (event.target.value.trim() && event.target.value.trim() !== settings?.ownerName) void props.onSaveSettings({ ownerName: event.target.value.trim() }); }} />
            <small>Appears in the handoff document ("Published by …") and in the suggested message, so the other assistant knows who the share belongs to.</small>
          </label>
        </div>
        <h3>ngrok account</h3>
        <p className="hint">
          Leave the authtoken empty to use the token already saved in your ngrok config. A free ngrok account includes one static domain
          ending in <code>.ngrok-free.app</code> (dashboard.ngrok.com › Domains): set it here so the public link stops looking random, which
          makes other assistants less suspicious of it. Custom hostnames (your own domain or a bare name) only work on paid ngrok plans; the
          tunnel fails with ERR_NGROK_314 otherwise. Changes apply the next time you start the tunnel.
        </p>
        <div className="form">
          <div className="frow frow--fields">
            <label className="field">
              <span>Authtoken {tunnel?.authtokenSet ? "(saved in the hub)" : "(using ngrok config)"}</span>
              <input className="in" type="password" autoComplete="off" placeholder="paste to replace" value={ngrokToken} onChange={(event) => setNgrokToken(event.target.value)} />
            </label>
            <label className="field">
              <span>Static domain (optional · custom hostnames need a paid plan)</span>
              <input className="in" placeholder="your-name.ngrok-free.app" value={ngrokDomain} onChange={(event) => setNgrokDomain(event.target.value)} />
            </label>
          </div>
          <div className="frow frow--end">
            {tunnel?.authtokenSet && (
              <button className="act" disabled={ngrokBusy} onClick={() => void clearNgrokToken()}>
                Forget saved authtoken
              </button>
            )}
            <button className="act act--focus" disabled={ngrokBusy} onClick={() => void saveNgrok()}>
              Save
            </button>
          </div>
        </div>
      </section>

      <section className="settings__section" id="settings-notifications">
        <h2>Notifications</h2>
        <p className="hint">A popup bottom-right like Teams, independent of Windows settings, plus sounds, when something wants your attention.</p>
        <label className="notif-master">
          <input type="checkbox" checked={notif.enabled} onChange={(event) => props.onNotif({ ...notif, enabled: event.target.checked })} />
          <span>Notifications on</span>
        </label>
        <div className="notif-style" role="radiogroup" aria-label="Notification style">
          {NOTIF_STYLE_META.map((item) => (
            <label key={item.key} className={`notif-style__row ${notif.style === item.key ? "notif-style__row--on" : ""}`}>
              <input
                type="radio"
                name="notif-style"
                checked={notif.style === item.key}
                disabled={!notif.enabled}
                onChange={() => props.onNotif({ ...notif, style: item.key })}
              />
              <span className="notif-style__name">{item.label}</span>
              <span className="notif-style__hint">{item.hint}</span>
            </label>
          ))}
        </div>
        {windowsBlocked && (
          <p className="callout callout--warn">
            {desktopStatus?.toastsEnabled === false
              ? "Windows notifications are turned off for your account: open Windows Settings › System › Notifications and switch Notifications on. The hub sends toasts, Windows drops them."
              : "Windows has notifications disabled for VBSS CCHUB: open Windows Settings › System › Notifications and enable the app."}
          </p>
        )}
        <div className="frow">
          <button className="act" onClick={() => void sendTest()}>
            Send test notification
          </button>
          {testResult && <span className="muted small">{testResult}</span>}
        </div>
        <h3>What to notify about</h3>
        <ul className="notif-events">
          {NOTIF_EVENT_META.map((meta) => (
            <li key={meta.kind} className="notif-events__row">
              <label className="notif-events__label">
                <input
                  type="checkbox"
                  checked={notif.events[meta.kind]}
                  disabled={!notif.enabled}
                  onChange={(event) => props.onNotif({ ...notif, events: { ...notif.events, [meta.kind]: event.target.checked } })}
                />
                <span className="notif-events__name">{meta.label}</span>
              </label>
              <span className="notif-events__desc">{meta.description}</span>
            </li>
          ))}
        </ul>
        <h3>Which sessions notify</h3>
        <p className="hint">
          Claude Desktop starts a short Claude Code session behind each chat step; those appear and end within seconds, so they are silent by
          default. Headless runs and hub delegations report through the Delegated view instead.
        </p>
        <div className="notifcfg">
          {NOTIF_CLIENTS.map((client) => (
            <label key={client} className="notifcfg__item">
              <input
                type="checkbox"
                checked={notif.clients[client]}
                onChange={(event) => props.onNotif({ ...notif, clients: { ...notif.clients, [client]: event.target.checked } })}
              />
              {claudeClient(client).label}
            </label>
          ))}
        </div>
        <h3>Channels</h3>
        <div className="notifcfg">
          <label className="notifcfg__item">
            <input type="checkbox" checked={notif.desktop} onChange={(event) => props.onNotif({ ...notif, desktop: event.target.checked })} />
            Desktop notification
          </label>
          <label className="notifcfg__item">
            <input type="checkbox" checked={notif.sound} onChange={(event) => props.onNotif({ ...notif, sound: event.target.checked })} />
            Sound
          </label>
          <span className="spacer" />
          <button className="act" onClick={() => void playSound("attention")}>
            Test decision
          </button>
          <button className="act" onClick={() => void playSound("idle")}>
            Test idle
          </button>
          <button className="act" onClick={() => void playSound("finished")}>
            Test finish
          </button>
        </div>
      </section>

      <section className="settings__section" id="settings-groups">
        <h2>Groups</h2>
        <p className="hint">
          Sessions are grouped by workspace automatically. Add a group to override that with a path fragment (matched against the session folder); order
          decides priority.
        </p>
        <GroupManager groups={groups} onCreate={props.onCreateGroup} onUpdate={props.onUpdateGroup} onDelete={props.onDeleteGroup} onMove={props.onMoveGroup} />
      </section>

      <section className="settings__section" id="settings-about">
        <h2>About</h2>
        <dl className="details">
          <dt>Version</dt>
          <dd>
            v{version}{" "}
            <button className="act act--ghost" onClick={props.onWhatsNew}>
              What's new
            </button>
          </dd>
          <dt>Hub</dt>
          <dd>
            <code>{hubUrl}</code>
          </dd>
        </dl>
      </section>
    </div>
  );
}
