import type { WidgetEdge, WidgetPanel } from "../../delegation";
import type { SettingsTabProps } from "./types";

const WIDGET_EDGE_OPTIONS: { key: WidgetEdge; label: string }[] = [
  { key: "left", label: "Left" },
  { key: "right", label: "Right" },
  { key: "top", label: "Top" },
];

const WIDGET_PANEL_OPTIONS: { key: WidgetPanel; label: string }[] = [
  { key: "sessions", label: "Sessions" },
  { key: "usage", label: "Usage" },
];

export function WidgetTab({ enabled, settings, onSaveSettings }: SettingsTabProps) {
  return (
    <section className="settings__section" id="settings-widget">
      <h2>Widget</h2>
      <p className="hint">A small tab docked to a screen edge; click it to open the panel with your sessions and usage.</p>
      <div className="form">
        <div className="field">
          <span>Edge</span>
          <div className="seg" role="radiogroup" aria-label="Widget edge">
            {WIDGET_EDGE_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                role="radio"
                aria-checked={(settings?.widget?.edge ?? "right") === option.key}
                className="seg__opt"
                disabled={!enabled}
                onClick={() => void onSaveSettings({ widget: { edge: option.key } })}
              >
                {option.label}
              </button>
            ))}
          </div>
          <small>The bottom edge is not offered so the widget never sits over the taskbar.</small>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={settings?.widget?.autostart ?? true}
            disabled={!enabled}
            onChange={(event) => void onSaveSettings({ widget: { autostart: event.target.checked } })}
          />
          Show at startup
        </label>
        <div className="field">
          <span>Weekly rings on the tab</span>
          <label className="check">
            <input
              type="checkbox"
              checked={settings?.widget?.rings?.claude ?? false}
              disabled={!enabled}
              onChange={(event) => void onSaveSettings({ widget: { rings: { claude: event.target.checked } } })}
            />
            Claude
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings?.widget?.rings?.codex ?? false}
              disabled={!enabled}
              onChange={(event) => void onSaveSettings({ widget: { rings: { codex: event.target.checked } } })}
            />
            Codex
          </label>
          <small>Rings need Limits on with at least one provider.</small>
        </div>
        <div className="field">
          <span>Default panel</span>
          <div className="seg" role="radiogroup" aria-label="Default widget panel">
            {WIDGET_PANEL_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                role="radio"
                aria-checked={(settings?.widget?.panel ?? "sessions") === option.key}
                className="seg__opt"
                disabled={!enabled}
                onClick={() => void onSaveSettings({ widget: { panel: option.key } })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
