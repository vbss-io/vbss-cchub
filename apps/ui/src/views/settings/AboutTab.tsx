import { COFFEE_URL, GITHUB_URL, SPONSORS_URL, openExternal } from "../../notify";
import { BackupsPanel } from "./BackupsPanel";

interface Props {
  hubUrl: string;
  version: string;
  onWhatsNew: () => void;
}

export function AboutTab({ hubUrl, version, onWhatsNew }: Props) {
  return (
    <>
      <section className="settings__section" id="settings-about">
        <h2>About</h2>
        <dl className="details">
          <dt>Version</dt>
          <dd>
            v{version}{" "}
            <button className="act act--ghost" onClick={onWhatsNew}>
              What's new
            </button>
          </dd>
          <dt>Hub</dt>
          <dd>
            <code>{hubUrl}</code>
          </dd>
        </dl>
        <BackupsPanel />
      </section>

      <section className="settings__section" id="settings-support">
        <h2>Support</h2>
        <p className="hint">CC Hub is free and open source. Star the repo, open an issue, or sponsor it to keep it going.</p>
        <div className="frow">
          <button className="act" onClick={() => void openExternal(GITHUB_URL)}>
            GitHub
          </button>
          <button className="act" onClick={() => void openExternal(COFFEE_URL)}>
            Buy me a coffee
          </button>
          <button className="act" onClick={() => void openExternal(SPONSORS_URL)}>
            GitHub Sponsors
          </button>
          <button className="act act--ghost" onClick={onWhatsNew}>
            What's new
          </button>
        </div>
      </section>
    </>
  );
}
