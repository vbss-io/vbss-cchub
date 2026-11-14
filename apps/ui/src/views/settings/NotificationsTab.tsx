import { useEffect, useState } from "react";
import { getDesktopNotifyStatus, sendToast, type DesktopNotifyStatus } from "../../api";
import { claudeClient } from "../../clients";
import { NOTIF_EVENT_META, type NotifEventKind, type NotifStyle } from "../../notifications";
import { notify, playSound } from "../../notify";
import type { SessionClient } from "../../types";

export interface NotifSettings {
  version: number;
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

interface Props {
  notif: NotifSettings;
  onNotif: (next: NotifSettings) => void;
}

export function NotificationsTab({ notif, onNotif }: Props) {
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

  return (
    <section className="settings__section" id="settings-notifications">
      <h2>Notifications</h2>
      <p className="hint">A popup bottom-right like Teams, independent of Windows settings, plus sounds, when something wants your attention.</p>
      <label className="notif-master">
        <input type="checkbox" checked={notif.enabled} onChange={(event) => onNotif({ ...notif, enabled: event.target.checked })} />
        <span>Notifications on</span>
      </label>
      <div className="notif-style" role="radiogroup" aria-label="Notification style">
        {NOTIF_STYLE_META.map((item) => (
          <label key={item.key} className={`notif-style__row ${notif.style === item.key ? "notif-style__row--on" : ""}`}>
            <input type="radio" name="notif-style" checked={notif.style === item.key} disabled={!notif.enabled} onChange={() => onNotif({ ...notif, style: item.key })} />
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
                onChange={(event) => onNotif({ ...notif, events: { ...notif.events, [meta.kind]: event.target.checked } })}
              />
              <span className="notif-events__name">{meta.label}</span>
            </label>
            <span className="notif-events__desc">{meta.description}</span>
          </li>
        ))}
      </ul>
      <h3>Which sessions notify</h3>
      <p className="hint">
        Claude Desktop starts a short Claude Code session behind each chat step; those appear and end within seconds, so they are silent by default. Headless runs and hub delegations report through the
        Delegated view instead.
      </p>
      <div className="notifcfg">
        {NOTIF_CLIENTS.map((client) => (
          <label key={client} className="notifcfg__item">
            <input type="checkbox" checked={notif.clients[client]} onChange={(event) => onNotif({ ...notif, clients: { ...notif.clients, [client]: event.target.checked } })} />
            {claudeClient(client).label}
          </label>
        ))}
      </div>
      <h3>Channels</h3>
      <div className="notifcfg">
        <label className="notifcfg__item">
          <input type="checkbox" checked={notif.desktop} onChange={(event) => onNotif({ ...notif, desktop: event.target.checked })} />
          Desktop notification
        </label>
        <label className="notifcfg__item">
          <input type="checkbox" checked={notif.sound} onChange={(event) => onNotif({ ...notif, sound: event.target.checked })} />
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
  );
}
