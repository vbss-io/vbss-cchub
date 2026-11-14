import type { DelegationSettings } from "../../delegation";
import { SidebarSettings } from "./SidebarSettings";

export type ThemeName = "dracula" | "midnight";

interface Props {
  settings: DelegationSettings | null;
  theme: ThemeName;
  onTheme: (theme: ThemeName) => void;
}

export function AppearanceTab({ settings, theme, onTheme }: Props) {
  return (
    <section className="settings__section" id="settings-appearance">
      <h2>Appearance</h2>
      <label className="field">
        <span>Theme</span>
        <select className="in" value={theme} onChange={(event) => onTheme(event.target.value as ThemeName)}>
          <option value="dracula">Dracula (VS Code / Obsidian)</option>
          <option value="midnight">Midnight (previous look)</option>
        </select>
        <small>Colors and surfaces only; the logo does not change.</small>
      </label>
      <SidebarSettings settings={settings} />
    </section>
  );
}
