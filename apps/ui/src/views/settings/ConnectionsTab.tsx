import { useEffect, useState } from "react";
import type { HooksStatus } from "../../api";
import { APPROVAL_WINDOW_MAX, APPROVAL_WINDOW_MIN, backupNote, codexHooksView, parseWindow, windowHint } from "../../act-model";
import { HOOK_EVENTS_HINT, hooksView } from "../../hooks-status";
import type { ConnectStatus, DelegationSettings, McpClient, SettingsPatch, ShellKind } from "../../delegation";

const MCP_LABEL: Record<McpClient, string> = {
  "claude-code": "Claude Code (CLI, VS Code, terminal)",
  "claude-desktop": "Claude Desktop",
  codex: "Codex CLI and Codex app",
};

const SHELL_LABEL: Record<ShellKind, string> = { bash: "bash (~/.bashrc)", powershell: "PowerShell profile" };

interface Props {
  enabled: boolean;
  hubUrl: string;
  connect: ConnectStatus | null;
  hooks: HooksStatus | null;
  hooksBusy: boolean;
  onToggleHooks: () => void;
  onShell: (kind: ShellKind, action: "install" | "uninstall") => Promise<void>;
  onMcp: (client: McpClient, action: "install" | "uninstall") => Promise<void>;
  settings: DelegationSettings | null;
  onSaveSettings: (patch: SettingsPatch) => Promise<void>;
  onCodexHooks: (action: "install" | "uninstall") => Promise<void>;
}

interface WindowFieldProps {
  id: string;
  label: string;
  value: number;
  disabled: boolean;
  onCommit: (seconds: number) => void;
}

function WindowField({ id, label, value, disabled, onCommit }: WindowFieldProps) {
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(String(value));
    setInvalid(false);
  }, [value]);
  const commit = () => {
    const seconds = parseWindow(draft);
    if (seconds === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (seconds !== value) onCommit(seconds);
  };
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        className="in"
        type="number"
        inputMode="numeric"
        min={APPROVAL_WINDOW_MIN}
        max={APPROVAL_WINDOW_MAX}
        value={draft}
        disabled={disabled}
        aria-invalid={invalid}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      <small className={invalid ? "error" : "hint"}>{invalid ? `Use a whole number from ${APPROVAL_WINDOW_MIN} to ${APPROVAL_WINDOW_MAX}.` : windowHint(value)}</small>
    </label>
  );
}

export function ConnectionsTab({ enabled, hubUrl, connect, hooks, hooksBusy, onToggleHooks, onShell, onMcp, settings, onSaveSettings, onCodexHooks }: Props) {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const wslInstalled = hooks?.wsl?.filter((item) => item.installed).length ?? 0;
  const view = hooksView(hooks);
  const codexView = codexHooksView(connect?.codexHooks ?? null);
  const codexHooks = connect?.codexHooks ?? null;
  const approvals = settings?.approvals ?? null;

  return (
    <>
      <section className="settings__section" id="settings-hooks">
        <h2>Hooks</h2>
        <p className="hint">
          Claude Code hooks are how sessions reach the hub: {HOOK_EVENTS_HINT}. They post to <code>{hubUrl}</code> and never block Claude; only a permission request waits for your answer, for the window set under Approvals.
        </p>
        <div className="statusrow">
          <span className={`tag tag--${view.tone}`}>{view.tag}</span>
          {view.detail && <span className="muted">{view.detail}{hooks?.installed && wslInstalled > 0 ? ` · ${wslInstalled} WSL distro${wslInstalled === 1 ? "" : "s"}` : ""}</span>}
          {hooks?.settingsPath && <span className="path muted">{hooks.settingsPath}</span>}
          <span className="spacer" />
          <button className={`act ${hooks?.installed ? "" : "act--focus"}`} disabled={hooksBusy || !hooks} onClick={onToggleHooks}>
            {hooksBusy ? "Working…" : view.action}
          </button>
        </div>
        {hooks?.wsl && hooks.wsl.length > 0 && (
          <ul className="plainlist">
            {hooks.wsl.map((item) => (
              <li key={item.distro}>
                <span className="muted">WSL {item.distro}:</span> {item.error ?? (item.installed ? "installed" : item.outdated ? "update available" : "not installed")}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings__section" id="settings-approvals">
        <h2>Approvals from the hub</h2>
        <p className="hint">
          When a session asks for permission, the hub can show it with Allow and Deny. Your answer is a one-time decision for that request only; it never grants "always allow" and never changes the mode. If you do not answer in time, the
          prompt stays in the terminal or app exactly as it was. Set a window to 0 to only observe.
        </p>
        {!enabled && <p className="callout">Available once the hub surface is on.</p>}
        {enabled && !approvals && <p className="muted">Loading…</p>}
        {approvals && (
          <div className="form">
            <WindowField id="approvals-claude" label="Claude Code window (seconds)" value={approvals.claudeWindowSec} disabled={!enabled} onCommit={(seconds) => void onSaveSettings({ approvals: { claudeWindowSec: seconds } })} />
            <WindowField id="approvals-codex" label="Codex window (seconds)" value={approvals.codexWindowSec} disabled={!enabled} onCommit={(seconds) => void onSaveSettings({ approvals: { codexWindowSec: seconds } })} />
          </div>
        )}
        <p className="hint">
          The window is also written into the hook timeout, so after changing it use <strong>Update hooks</strong> above for Claude Code
          {hooks?.permissionTimeout ? ` (hook timeout ${hooks.permissionTimeout} s)` : ""} and the Codex hooks below.
        </p>
      </section>

      <section className="settings__section" id="settings-codex-hooks">
        <h2>Codex hooks</h2>
        <p className="hint">
          Codex hooks make Codex sessions live in the hub (running, needs you, idle, ended) and let you approve a permission request from here. They are added to <code>~/.codex/hooks.json</code> next to yours, a copy is kept, and
          Remove puts the file back as it was.
        </p>
        {!enabled && <p className="callout">Available once the hub surface is on.</p>}
        {enabled && !codexHooks && <p className="muted">Loading…</p>}
        {codexHooks && (
          <>
            <div className="statusrow">
              <span className={`tag tag--${codexView.tone}`}>{codexView.tag}</span>
              {codexView.detail && <span className="muted">{codexView.detail}</span>}
              <span className="path muted">{codexHooks.path}</span>
              <span className="spacer" />
              {codexView.canRemove && (
                <button className="act" disabled={busy} onClick={() => void run(() => onCodexHooks("uninstall"))}>
                  Remove hooks
                </button>
              )}
              {codexView.canInstall && (
                <button className="act act--focus" disabled={busy} onClick={() => void run(() => onCodexHooks("install"))}>
                  {codexView.installLabel}
                </button>
              )}
            </div>
            <p className="callout">{codexHooks.trustNote}</p>
            {backupNote(codexHooks) && <p className="hint">{backupNote(codexHooks)}</p>}
          </>
        )}
      </section>

      <section className="settings__section" id="settings-connect">
        <h2>MCP connections</h2>
        <p className="hint">
          Agents talk to the hub through the <code>cchub</code> MCP server. Once a client is connected it gets <code>hub_overview</code>, <code>hub_workspaces</code>, <code>hub_delegate</code>,{" "}
          <code>hub_task</code>, <code>hub_report</code> and the other tools. Restart the client after connecting.
        </p>
        {!enabled && <p className="callout">Available once the hub surface is on.</p>}
        {enabled && !connect && <p className="muted">Loading…</p>}
        {connect && !connect.mcpEntryExists && <p className="error">MCP entry missing at {connect.mcpEntry}. Build the server (npm run build) or use the installed app.</p>}
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
                        <span className={`tag tag--${item.installed ? "go" : "muted"}`}>{item.installed ? (item.inFile ? "connected" : "connected · imported by the app") : "not connected"}</span>
                        {item.updateAvailable && <span className="tag tag--pend">update available</span>}
                      </span>
                      <span className="path muted">{item.error ?? item.path}</span>
                      {item.updateAvailable && <span className="muted small">The registered cchub entry differs from this hub. Update re-registers it{item.cli ? ` with ${item.cli}` : ""}; restart the client after.</span>}
                      {client === "claude-desktop" && item.installed && !item.inFile && (
                        <span className="muted small">Claude Desktop moved the entry into its own settings after reading it; that is normal.</span>
                      )}
                    </div>
                    {item.installed ? (
                      <>
                        {item.updateAvailable && (
                          <button className="act act--focus" disabled={busy || !connect.mcpEntryExists} onClick={() => void run(() => onMcp(client, "install"))}>
                            Update
                          </button>
                        )}
                        <button className="act" disabled={busy} onClick={() => void run(() => onMcp(client, "uninstall"))}>
                          Disconnect
                        </button>
                      </>
                    ) : (
                      <button className="act act--focus" disabled={busy || !!item.error || !connect.mcpEntryExists} onClick={() => void run(() => onMcp(client, "install"))}>
                        Connect
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

      <section className="settings__section" id="settings-shell">
        <h2>Shell alias</h2>
        <p className="hint">
          <code>wk</code> lists your workspaces and <code>wk &lt;name&gt;</code> opens one in the editor, from the same root as the hub. Reopen the terminal after installing.
        </p>
        {!connect && <p className="muted">{enabled ? "Loading…" : "Available once the hub surface is on."}</p>}
        {connect && (
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
                    <button className="act" disabled={busy} onClick={() => void run(() => onShell(shell, "uninstall"))}>
                      Remove
                    </button>
                  ) : (
                    <button className="act act--focus" disabled={busy || item.external} onClick={() => void run(() => onShell(shell, "install"))}>
                      Install
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
