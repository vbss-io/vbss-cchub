import { needsYouOnTop, withNeedsYouOnTop } from "../../runs-model";
import { useUiPrefs } from "../../ui-prefs-context";

export function SessionsTab() {
  const { uiPrefs, loaded, updateUiPrefs } = useUiPrefs();
  const on = needsYouOnTop(uiPrefs.layout);
  return (
    <section className="settings__section" id="settings-sessions">
      <h2>Sessions</h2>
      <div className="form">
        <label className="check">
          <input
            type="checkbox"
            checked={on}
            disabled={!loaded}
            onChange={(event) => void updateUiPrefs(withNeedsYouOnTop(uiPrefs.layout, event.target.checked))}
          />
          Needs you on top
        </label>
        <small className="hint">In the All list, what needs you (waiting, finished and unread, delegated tasks that stopped) shows first in its own band instead of inside its workspace group.</small>
      </div>
    </section>
  );
}
