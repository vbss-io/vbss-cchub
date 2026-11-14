import { useEffect, useRef } from "react";
import { IconSettings } from "../../icons";
import { featureOn, isPluginEnabled, PLUGINS } from "../../plugins/registry";
import type { FeatureKey, PluginId } from "../../plugins/types";
import { hasPluginSettings, pluginHints, pluginPageKey } from "../../settings-model";
import type { SettingsTabProps } from "./types";

interface Props extends SettingsTabProps {
  restoreFocus: PluginId | null;
  onFocusRestored: () => void;
}

const openPluginSettings = (id: PluginId) => {
  window.location.hash = `#/settings/${pluginPageKey(id)}`;
};

export function PluginsTab({ enabled, settings, onSaveSettings, restoreFocus, onFocusRestored }: Props) {
  const features = settings?.features ?? null;
  const loaded = settings !== null;
  const hasVault = Boolean(settings?.secondBrainRoot?.trim());
  const listRef = useRef<HTMLUListElement>(null);
  const toggle = (key: FeatureKey, value: boolean) => void onSaveSettings({ features: { [key]: value } });

  useEffect(() => {
    if (restoreFocus === null) return;
    listRef.current?.querySelector<HTMLButtonElement>(`[data-plugin="${restoreFocus}"] .plugin-row__gear`)?.focus();
    onFocusRestored();
  }, [restoreFocus, onFocusRestored]);

  return (
    <section className="settings__section" id="settings-plugins">
      <h2>Plugins</h2>
      {enabled && !loaded && <p className="hint" role="status">Loading your plugin settings...</p>}
      <p className="hint">Turn parts of CC Hub on or off. A plugin that is off disappears from the sidebar, the search and its route; use the gear on a plugin that is on to open its settings.</p>
      <ul className="plugin-list" aria-busy={!loaded} ref={listRef}>
        {PLUGINS.map((plugin) => {
          const key = plugin.featureKey;
          const hints = key === null ? [] : pluginHints(plugin, (id) => isPluginEnabled(id, features), hasVault);
          const hintText = loaded ? hints.join(" · ") : "";
          const configurable = hasPluginSettings(plugin);
          const on = loaded && isPluginEnabled(plugin.id, features);
          return (
            <li key={plugin.id} className="plugin-row" data-plugin={plugin.id}>
              <div className="plugin-row__info">
                <span className="plugin-row__name">{plugin.name}</span>
                <span className="plugin-row__desc">{plugin.description}</span>
                {hintText && <span className="plugin-row__hint">{hintText}</span>}
              </div>
              <div className="plugin-row__controls">
                {configurable && (
                  <span className="plugin-row__gear-wrap" title={on ? `${plugin.name} settings` : "Turn it on to configure"}>
                    <button
                      type="button"
                      className="act plugin-row__gear"
                      aria-label={`${plugin.name} settings`}
                      disabled={!on}
                      onClick={() => openPluginSettings(plugin.id)}
                    >
                      <IconSettings size={14} />
                      <span className="plugin-row__gear-text">Options</span>
                    </button>
                  </span>
                )}
                {key === null ? (
                  <span className="tag tag--muted">Core</span>
                ) : (
                  <label className="switch" title={`${featureOn(features, key) ? "Turn off" : "Turn on"} ${plugin.name}`}>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={loaded && featureOn(features, key)}
                      disabled={!enabled || !loaded}
                      aria-label={plugin.name}
                      onChange={(event) => toggle(key, event.target.checked)}
                    />
                    <span className="switch__track" aria-hidden="true" />
                  </label>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
