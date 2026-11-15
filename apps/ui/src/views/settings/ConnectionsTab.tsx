import { useState } from "react";
import type { HooksStatus } from "../../api";
import { HOOK_EVENTS_HINT, hooksView } from "../../hooks-status";
import type { ConnectStatus, McpClient, ShellKind } from "../../delegation";

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
}

export function ConnectionsTab({ enabled, hubUrl, connect, hooks, hooksBusy, onToggleHooks, onShell, onMcp }: Props) {
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

  return (
    <>
      <section className="settings__section" id="settings-hooks">
        <h2>Hooks</h2>
        <p className="hint">
          Claude Code hooks are how sessions reach the hub: {HOOK_EVENTS_HINT}. They post to <code>{hubUrl}</code> and never block Claude.
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
                      </span>
                      <span className="path muted">{item.error ?? item.path}</span>
                      {client === "claude-desktop" && item.installed && !item.inFile && (
                        <span className="muted small">Claude Desktop moved the entry into its own settings after reading it; that is normal.</span>
                      )}
                    </div>
                    {item.installed ? (
                      <button className="act" disabled={busy} onClick={() => void run(() => onMcp(client, "uninstall"))}>
                        Disconnect
                      </button>
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
