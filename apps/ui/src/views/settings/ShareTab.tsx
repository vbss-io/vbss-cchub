import { useEffect, useState } from "react";
import type { TunnelStatus } from "../../delegation";
import type { SettingsTabProps } from "./types";

interface Props extends SettingsTabProps {
  tunnel: TunnelStatus | null;
  onTunnelSettings: (patch: { authtoken?: string | null; domain?: string | null }) => Promise<void>;
}

export function ShareTab({ settings, onSaveSettings, tunnel, onTunnelSettings }: Props) {
  const [ngrokToken, setNgrokToken] = useState("");
  const [ngrokDomain, setNgrokDomain] = useState(tunnel?.domain ?? "");
  const [ngrokBusy, setNgrokBusy] = useState(false);

  useEffect(() => {
    setNgrokDomain(tunnel?.domain ?? "");
  }, [tunnel?.domain]);

  const saveNgrok = async () => {
    setNgrokBusy(true);
    try {
      await onTunnelSettings({ authtoken: ngrokToken.trim() ? ngrokToken.trim() : undefined, domain: ngrokDomain.trim() || null });
      setNgrokToken("");
    } finally {
      setNgrokBusy(false);
    }
  };

  const clearNgrokToken = async () => {
    setNgrokBusy(true);
    try {
      await onTunnelSettings({ authtoken: null });
      setNgrokToken("");
    } finally {
      setNgrokBusy(false);
    }
  };

  return (
    <section className="settings__section" id="settings-sharing">
      <h2>Sharing</h2>
      <p className="hint">
        Share links let another person and their assistant ask your Claude (read-only) or delegate work inside one workspace. They are served on a separate port that exposes nothing else; every
        link carries its own key and can be paused or revoked in the Share view.
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
          {tunnel?.error && (
            <span className="error small">
              {tunnel.error.includes("ERR_NGROK_314") ? "ngrok refused the custom hostname: free accounts can only use their .ngrok-free.app domain. Clear the domain or upgrade the plan." : tunnel.error}
            </span>
          )}
        </dd>
      </dl>
      <h3>Identity</h3>
      <div className="form">
        <label className="field">
          <span>Your name (shown to askers)</span>
          <input
            className="in"
            defaultValue={settings?.ownerName ?? ""}
            onBlur={(event) => {
              if (event.target.value.trim() && event.target.value.trim() !== settings?.ownerName) void onSaveSettings({ ownerName: event.target.value.trim() });
            }}
          />
          <small>Appears in the handoff document ("Published by …") and in the suggested message, so the other assistant knows who the share belongs to.</small>
        </label>
      </div>
      <h3>ngrok account</h3>
      <p className="hint">
        Leave the authtoken empty to use the token already saved in your ngrok config. A free ngrok account includes one static domain ending in <code>.ngrok-free.app</code> (dashboard.ngrok.com › Domains):
        set it here so the public link stops looking random, which makes other assistants less suspicious of it. Custom hostnames (your own domain or a bare name) only work on paid ngrok plans; the tunnel
        fails with ERR_NGROK_314 otherwise. Changes apply the next time you start the tunnel.
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
  );
}
