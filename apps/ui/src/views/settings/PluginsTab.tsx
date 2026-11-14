import { featureOn, isPluginEnabled, PLUGINS } from "../../plugins/registry";
import type { FeatureKey } from "../../plugins/types";
import { pluginHints } from "../../settings-model";
import type { SettingsTabProps } from "./types";

export function PluginsTab({ enabled, settings, onSaveSettings }: SettingsTabProps) {
  const features = settings?.features ?? null;
  const hasVault = Boolean(settings?.secondBrainRoot?.trim());
  const toggle = (key: FeatureKey, value: boolean) => void onSaveSettings({ features: { [key]: value } });

  return (
    <section className="settings__section" id="settings-plugins">
      <h2>Plugins</h2>
      <p className="hint">Turn parts of CC Hub on or off. A plugin that is off disappears from the sidebar, the search and its route; its settings tab appears here once it is on.</p>
      <ul className="plugin-list">
        {PLUGINS.map((plugin) => {
          const key = plugin.featureKey;
          const hints = key === null ? [] : pluginHints(plugin, (id) => isPluginEnabled(id, features), hasVault);
          return (
            <li key={plugin.id} className="plugin-row" data-plugin={plugin.id}>
              <div className="plugin-row__info">
                <span className="plugin-row__name">{plugin.name}</span>
                <span className="plugin-row__desc">{plugin.description}</span>
                {hints.length > 0 && <span className="plugin-row__hint">{hints.join(" · ")}</span>}
              </div>
              {key === null ? (
                <span className="tag tag--muted">Core</span>
              ) : (
                <label className="switch" title={`${featureOn(features, key) ? "Turn off" : "Turn on"} ${plugin.name}`}>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={featureOn(features, key)}
                    disabled={!enabled}
                    aria-label={plugin.name}
                    onChange={(event) => toggle(key, event.target.checked)}
                  />
                  <span className="switch__track" aria-hidden="true" />
                </label>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
