const DOWNLOAD_URL = "https://cdn.vbss.io/vbss-cchub/releases/VBSS-CCHUB-Setup.msi";
const GITHUB_URL = "https://github.com/vbss-io/vbss-cchub";
const PORTFOLIO_URL = "https://vbss.io";
const COFFEE_URL = "https://www.buymeacoffee.com/vbss.io";
const GITHUB_PROFILE = "https://github.com/vbss-io";
const LINKEDIN_URL = "https://www.linkedin.com/in/vbss-io";

interface Feature {
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    title: "Live session board",
    body: "Every Claude Code session on one screen — what's running, what's idle, and what's waiting on you. Colour-coded, sorted by who needs you first.",
  },
  {
    title: "Never miss a nudge",
    body: "A desktop notification and a sound the moment a session asks for a decision, stalls, or finishes. Light for a decision, sharper for a finish.",
  },
  {
    title: "Always-on-top widget",
    body: "A tiny bar that floats over everything and collapses to a single line. Glance at what needs you without alt-tabbing through a dozen terminals.",
  },
  {
    title: "Jump to the right window",
    body: "Click a session to bring the exact VS Code window it runs in to the front — even when five of them share one process.",
  },
  {
    title: "WSL & multi-environment",
    body: "Track Claudes running on Windows and inside WSL distros at once, each tagged by its source. One hub, every environment.",
  },
  {
    title: "Groups, filters, rename",
    body: "Group sessions by workspace, filter by status, rename the ones with cryptic ids, and archive the noise. It stays tidy at scale.",
  },
];

const SLOGANS = ["Run many. Forget none.", "Make every token count.", "Never lose a session again."];

export function App() {
  return (
    <div className="page">
      <header className="nav">
        <a className="brand" href="#top">
          <img src="/logo.svg" alt="VBSS CCHUB" width={30} height={30} />
          <span>
            <span className="vsplit">V</span>BSS <b>CCHUB</b>
          </span>
        </a>
        <nav className="nav__links">
          <a href="#features">Features</a>
          <a href="#why">Why</a>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a className="btn btn--sm" href={DOWNLOAD_URL}>
            Download
          </a>
        </nav>
      </header>

      <main id="top">
        <section className="hero">
          <span className="eyebrow">Open source · Windows · Local</span>
          <h1>
            Never lose a Claude Code
            <br />
            session again.
          </h1>
          <p className="lead">
            VBSS CCHUB is a tiny local hub that watches all your parallel Claude Code sessions and
            pings you the second one needs a decision, stalls, or wraps up. Run many, forget none,
            and make every token count.
          </p>
          <div className="hero__cta">
            <a className="btn btn--lg" href={DOWNLOAD_URL}>
              Download for Windows
            </a>
            <a className="btn btn--ghost btn--lg" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
              View on GitHub
            </a>
          </div>
          <p className="hero__note">Free · No account · Your sessions never leave your machine</p>

          <div className="shot">
            <img className="shot__app" src="/shot-app.png" alt="VBSS CCHUB session board" />
            <img className="shot__widget" src="/shot-widget.png" alt="VBSS CCHUB widget" />
          </div>
        </section>

        <section className="marquee">
          {SLOGANS.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </section>

        <section id="features" className="section">
          <h2>Built for running Claudes in parallel</h2>
          <p className="section__sub">
            Five, ten, twenty sessions at once — CCHUB keeps them all in view so none sits idle
            burning your clock while it waits.
          </p>
          <div className="features">
            {FEATURES.map((f) => (
              <article key={f.title} className="feature">
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="why" className="section why">
          <div className="why__text">
            <h2>Why it exists</h2>
            <p>
              Running a handful of Claude Code sessions at once, it's easy to leave one paused for
              an hour — waiting on a yes/no while you're heads-down somewhere else. That's wasted
              time and wasted tokens.
            </p>
            <p>
              CCHUB is a small open-source tool built to keep an eye on all of them. It hooks into
              Claude Code, tracks every session, and nudges you the moment one needs you. It runs
              entirely on your machine — no account, no cloud, no telemetry.
            </p>
            <a className="btn" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
              Read the code
            </a>
          </div>
          <img className="why__shot" src="/shot-widget.png" alt="VBSS CCHUB widget close-up" />
        </section>

        <section className="cta">
          <h2>Stop babysitting terminals.</h2>
          <p>Install it once. Let it watch. Get back to building.</p>
          <a className="btn btn--lg" href={DOWNLOAD_URL}>
            Download for Windows
          </a>
          <a className="coffee-link" href={COFFEE_URL} target="_blank" rel="noopener noreferrer">
            ☕ Like it? Buy me a coffee
          </a>
        </section>
      </main>

      <footer className="footer">
        <div className="footer__brand">
          <img src="/logo.svg" alt="" width={22} height={22} />
          <span>
            VBSS CCHUB. A{" "}
            <a href={PORTFOLIO_URL} target="_blank" rel="noopener noreferrer">
              vbss.io
            </a>{" "}
            project.
          </span>
        </div>
        <div className="footer__links">
          <a href={GITHUB_PROFILE} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a href={LINKEDIN_URL} target="_blank" rel="noopener noreferrer">
            LinkedIn
          </a>
          <a href={COFFEE_URL} target="_blank" rel="noopener noreferrer">
            Buy me a coffee
          </a>
        </div>
      </footer>
    </div>
  );
}
