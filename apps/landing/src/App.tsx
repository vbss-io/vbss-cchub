import { useEffect, useState } from "react";

const DOWNLOAD_URL =
  "https://github.com/vbss-io/vbss-cchub/releases/latest/download/VBSS-CCHUB-Setup.msi";
const RELEASE_API = "https://api.github.com/repos/vbss-io/vbss-cchub/releases/latest";
const GITHUB_URL = "https://github.com/vbss-io/vbss-cchub";
const PORTFOLIO_URL = "https://vbss.io";
const COFFEE_URL = "https://www.buymeacoffee.com/vbss.io";
const SPONSORS_URL = "https://github.com/sponsors/vbss-io";
const GITHUB_PROFILE = "https://github.com/vbss-io";
const LINKEDIN_URL = "https://www.linkedin.com/in/vbss-io";

interface Feature {
  title: string;
  body: string;
  tag?: string;
}

const FEATURES: Feature[] = [
  {
    title: "Every session, one board",
    body: "Claude Code in the terminal, VS Code and Claude Desktop, plus Codex CLI and the Codex app, on Windows and inside WSL. Status, model, context and running subagents at a glance, sorted by who needs you first.",
  },
  {
    title: "Never miss a nudge",
    body: "A desktop notification and a sound the moment a session asks for a decision, stalls, or finishes. One click brings the exact window it runs in to the front.",
  },
  {
    title: "Docked widget",
    body: "A small tab on the left, right or top edge of the screen with weekly-limit rings for Claude and Codex. Open it to see what needs you, what is running, and today's usage.",
  },
  {
    title: "Usage: what burns tokens",
    body: "Tokens per day, project, session and model, split into cache reads, fresh input and output, plus context per message so you know when to compact. Read from the transcripts already on your disk.",
    tag: "opt-in",
  },
  {
    title: "Plan limits",
    body: "Claude 5-hour, weekly and per-model limits (Fable, Opus) and Codex 5-hour and weekly windows. Account-wide, so usage from your other machines counts too. Read-only, polled at the interval you pick.",
    tag: "opt-in",
  },
  {
    title: "Delegate from any agent",
    body: "The cchub MCP server connects Claude Code, Claude Desktop and Codex. Any agent can hand a task to a workspace: the hub runs it, moves it to its own git worktree when the repo is busy, gives it its own port block, and reports back.",
  },
  {
    title: "Flow map",
    body: "Workspaces, sessions, subagents and delegated tasks as one live map. See who spawned what, what is still running, and what is waiting on you.",
  },
  {
    title: "Share a workspace",
    body: "A link, on the LAN or public through ngrok, that lets a teammate and their assistant ask your Claude about a workspace or delegate into it. Trust levels, a key per link, expiry, rate limits and a log of every answer.",
  },
  {
    title: "Tasks from your notes",
    body: "Kanban, Table and Timeline over the project notes in your vault. Status, priority, start and due dates and repeat rules live in the Markdown itself, edits flow both ways with Obsidian, and any task can be handed to an agent.",
    tag: "opt-in",
  },
  {
    title: "Daily note & session trail",
    body: "Point it at your Markdown or Obsidian vault for a guided daily note (close yesterday, plan today) that stays in sync with Tasks, and a trail that keeps the key points of every session, light, medium or high detail.",
    tag: "opt-in",
  },
];

interface TourItem {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  points: string[];
  image: string;
  alt: string;
}

const TOUR: TourItem[] = [
  {
    id: "usage",
    eyebrow: "Usage & limits",
    title: "Know what is left before you hit the wall.",
    body: "Long sessions re-read their whole context on every message. CCHUB shows where the tokens go and how much of your plan remains, side by side.",
    points: [
      "Claude and Codex in the same chart, per day",
      "Breakdown by project, session and model",
      "Context per message (p50 · p90 · max) with a nudge to compact",
      "5-hour, weekly and per-model limits with reset countdowns",
    ],
    image: "/shot-usage.png",
    alt: "CCHUB usage view with plan limits for Claude and Codex and tokens per day",
  },
  {
    id: "flow",
    eyebrow: "Delegation",
    title: "Hand work off, keep it in view.",
    body: "Agents delegate through the cchub MCP server. Every task, session and subagent lands on the same map, so nothing runs where you cannot see it.",
    points: [
      "Delegate from Claude Code, Claude Desktop or Codex",
      "Workspaces come from your .code-workspace folder",
      "Busy repo? The task gets its own worktree and branch",
      "Follow, steer or cancel any task from the hub",
    ],
    image: "/shot-flow.png",
    alt: "CCHUB flow map with workspaces, sessions, subagents and delegated tasks",
  },
  {
    id: "tasks",
    eyebrow: "Tasks",
    title: "Your project notes, as a board.",
    body: "Every note in your projects folder is a project, and its checkboxes are the tasks. Move a card and the line in the note changes; edit the note in Obsidian and the board follows.",
    points: [
      "To-do, doing and done checkboxes, plus Blocked, Hold and Archived with a reason",
      "Priorities, subtasks and notes, filtered by project, status and priority",
      "Finished tasks move to a Done section with the date they closed",
      "Delegate a task to a workspace with a prompt built from it",
    ],
    image: "/shot-tasks.png",
    alt: "CCHUB Tasks board with Blocked, Hold, To-Do, Doing and Done columns built from Markdown project notes",
  },
  {
    id: "timeline",
    eyebrow: "Timeline",
    title: "See what lands this week, and what slipped.",
    body: "Give a task a start and a due date and it shows up on the Timeline, grouped by project, next to today. Dates use the Obsidian Tasks format, so your other tools read them too.",
    points: [
      "Start, scheduled and due dates, with overdue work in red",
      "Repeat rules: finishing a recurring task logs it and schedules the next one",
      "Week, month and quarter zoom",
      "Add a task to today's daily note in one click, subtasks included",
    ],
    image: "/shot-timeline.png",
    alt: "CCHUB Timeline view with start-to-due bars grouped by project and a line marking today",
  },
  {
    id: "daily",
    eyebrow: "Second brain",
    title: "Your day, written where you already keep notes.",
    body: "Turn on Daily and the hub reads and writes the daily note in your vault. Edit it in the hub or in Obsidian and the other side follows.",
    points: [
      "Confirm what got done yesterday, pick today's focus, then generate",
      "Task filters that respect the note's own indentation",
      "Today's sessions next to the note",
      "Your template, your headings, your folders",
    ],
    image: "/shot-daily.png",
    alt: "CCHUB daily view rendering a Markdown daily note with focus items and today's sessions",
  },
];

const STEPS: { title: string; body: string }[] = [
  {
    title: "Install",
    body: "Download the installer and run it. The hub starts in the tray and can launch with Windows.",
  },
  {
    title: "Install the hooks",
    body: "Settings › Hooks › Install hooks. Every Claude Code session on the machine shows up from then on. Codex sessions are picked up on their own.",
  },
  {
    title: "Connect your agents",
    body: "Settings › Connections adds the cchub MCP server to Claude Code, Claude Desktop and Codex, so they can see each other and delegate.",
  },
];

const SLOGANS = ["Run many. Forget none.", "Make every token count.", "Delegate, don't babysit."];

interface LatestRelease {
  version: string;
  highlights: string[];
  downloadUrl: string;
}

interface ReleaseResponse {
  tag_name?: string;
  body?: string;
  assets?: { name: string; browser_download_url: string }[];
}

async function fetchLatestRelease(): Promise<LatestRelease | null> {
  try {
    const response = await fetch(RELEASE_API);
    if (!response.ok) return null;
    const data = (await response.json()) as ReleaseResponse;
    const version = data.tag_name?.replace(/^v/, "");
    if (!version) return null;
    const highlights = (data.body ?? "")
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim());
    const versioned = data.assets?.find((asset) => asset.name === `VBSS-CCHUB-Setup-v${version}.msi`);
    return { version, highlights, downloadUrl: versioned?.browser_download_url ?? DOWNLOAD_URL };
  } catch {
    return null;
  }
}

export function App() {
  const [release, setRelease] = useState<LatestRelease | null>(null);

  useEffect(() => {
    void fetchLatestRelease().then(setRelease);
  }, []);

  const downloadUrl = release?.downloadUrl ?? DOWNLOAD_URL;
  const versionSuffix = release ? ` · v${release.version}` : "";

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
          <a href="#tour">Tour</a>
          <a href="#start">Get started</a>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a className="btn btn--sm" href={downloadUrl}>
            Download{versionSuffix}
          </a>
        </nav>
      </header>

      <main id="top">
        <section className="hero">
          <span className="eyebrow">Open source · Windows · Runs locally</span>
          <h1>
            Run many agents.
            <br />
            Forget none.
          </h1>
          <p className="lead">
            VBSS CCHUB is a local hub for Claude Code and Codex. Every session on one board, a docked
            widget that shows who needs you and how much of your plan is left, and an MCP server that
            lets any agent hand work to your workspaces.
          </p>
          <div className="hero__cta">
            <a className="btn btn--lg" href={downloadUrl}>
              Download for Windows{versionSuffix}
            </a>
            <a className="btn btn--ghost btn--lg" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
              View on GitHub
            </a>
          </div>
          <p className="hero__note">Free · No account · Your sessions never leave your machine</p>

          {release && release.highlights.length > 0 && (
            <details className="whatsnew">
              <summary className="whatsnew__title">What's new in v{release.version}</summary>
              <ul>
                {release.highlights.map((highlight) => (
                  <li key={highlight}>{highlight}</li>
                ))}
              </ul>
            </details>
          )}

          <div className="shot">
            <img className="shot__app" src="/shot-app.png" alt="CCHUB sessions board with Claude Code and Codex sessions" width={1440} height={900} />
            <img className="shot__widget" src="/shot-widget.png" alt="CCHUB widget panel listing sessions that need you, running and delegated" width={440} height={620} />
          </div>
        </section>

        <section className="marquee">
          {SLOGANS.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </section>

        <section id="features" className="section">
          <h2>Built for running agents in parallel</h2>
          <p className="section__sub">
            Five, ten, twenty sessions at once, across Claude and Codex. CCHUB keeps them all in view,
            so none sits idle waiting on you and none burns your plan unnoticed.
          </p>
          <div className="features">
            {FEATURES.map((f) => (
              <article key={f.title} className="feature">
                <h3>
                  {f.title}
                  {f.tag && <span className="feature__tag">{f.tag}</span>}
                </h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="tour" className="section tour">
          <h2>A closer look</h2>
          <p className="section__sub">Real screens from v1.2 and v1.4, with demo data.</p>
          {TOUR.map((item, index) => (
            <article key={item.id} id={item.id} className={`tour__row${index % 2 === 1 ? " tour__row--flip" : ""}`}>
              <div className="tour__text">
                <span className="eyebrow">{item.eyebrow}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                <ul>
                  {item.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
              <img className="tour__shot" src={item.image} alt={item.alt} loading="lazy" />
            </article>
          ))}

          <article id="widget" className="tour__row">
            <div className="tour__text">
              <span className="eyebrow">Widget</span>
              <h3>Out of the way until it matters.</h3>
              <p>
                The widget docks to the edge of the screen as a small tab. The rings show how much of
                the weekly limit each provider has used; a badge counts the sessions waiting on you.
              </p>
              <ul>
                <li>Left, right or top edge, drag it along the side</li>
                <li>Rings for Claude and Codex, turn each on or off</li>
                <li>Sessions tab: needs you, running, idle, delegated</li>
                <li>Usage tab: today, last 7 days and plan limits</li>
              </ul>
            </div>
            <div className="widget-trio">
              <img className="widget-trio__tab" src="/shot-widget-tab.png" alt="Collapsed CCHUB widget tab with a badge and weekly-limit rings for Claude and Codex" width={56} height={162} loading="lazy" />
              <img className="widget-trio__panel" src="/shot-widget.png" alt="CCHUB widget sessions tab" width={440} height={620} loading="lazy" />
              <img className="widget-trio__panel" src="/shot-widget-usage.png" alt="CCHUB widget usage tab with Claude and Codex limits" width={440} height={620} loading="lazy" />
            </div>
          </article>
        </section>

        <section id="start" className="section">
          <h2>Up and running in a minute</h2>
          <p className="section__sub">No account, no config file to write. Optional features stay off until you turn them on in Settings › Features.</p>
          <ol className="steps">
            {STEPS.map((step, index) => (
              <li key={step.title} className="step">
                <span className="step__n">{index + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="why" className="section why">
          <div className="why__text">
            <h2>Why it exists</h2>
            <p>
              With a handful of agents running at once, it is easy to leave one waiting on a yes/no
              for an hour, burn through the weekly limit without noticing, or lose track of work you
              handed off. That is wasted time and wasted tokens.
            </p>
            <p>
              CCHUB is a small open-source tool built to keep an eye on all of it. It runs entirely on
              your machine: no account, no cloud, no telemetry. It only reaches the internet for
              features you switch on, like the read-only plan-limits check with your existing Claude
              login, or ngrok for a public share link.
            </p>
            <a className="btn" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
              Read the code
            </a>
          </div>
        </section>

        <section className="cta">
          <h2>Stop babysitting terminals.</h2>
          <p>Install it once. Let it watch. Get back to building.</p>
          <a className="btn btn--lg" href={downloadUrl}>
            Download for Windows{versionSuffix}
          </a>
          <div className="coffee-link">
            ☕ Like it?{" "}
            <a href={COFFEE_URL} target="_blank" rel="noopener noreferrer">
              Buy me a coffee
            </a>{" "}
            or{" "}
            <a href={SPONSORS_URL} target="_blank" rel="noopener noreferrer">
              sponsor on GitHub
            </a>
          </div>
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
          <a href={SPONSORS_URL} target="_blank" rel="noopener noreferrer">
            GitHub Sponsors
          </a>
        </div>
      </footer>
    </div>
  );
}
