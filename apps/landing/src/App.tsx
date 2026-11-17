import { useEffect, useState } from "react";
import { ParticleField } from "./ParticleField";
import { PluginIcon, type IconName } from "./PluginIcon";
import { DOWNLOAD_URL, fetchLatestRelease, type ReleaseState } from "./release";
import { WhatsNew } from "./WhatsNew";

const GITHUB_URL = "https://github.com/vbss-io/vbss-cchub";
const PORTFOLIO_URL = "https://vbss.io";
const COFFEE_URL = "https://www.buymeacoffee.com/vbss.io";
const SPONSORS_URL = "https://github.com/sponsors/vbss-io";
const GITHUB_PROFILE = "https://github.com/vbss-io";
const LINKEDIN_URL = "https://www.linkedin.com/in/vbss-io";

interface Feature {
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    title: "Every session, one place",
    body: "Claude Code in the terminal, VS Code and Claude Desktop, plus Codex, on Windows and inside WSL. Claude, Codex and delegated runs share one screen, with the sessions that need you on top.",
  },
  {
    title: "Approve without switching windows",
    body: "Allow or deny permission requests from the hub, a toast or the widget, with the full command in view. Questions with options and plan approvals are answered there too, and Open session jumps to the exact terminal or app.",
  },
  {
    title: "Pick up where you left off",
    body: "Search every past Claude and Codex session with Ctrl+K, from a local index with secrets redacted. Turn on context handoff and a new session in a workspace starts with a short recap of the last ones.",
  },
  {
    title: "Routines and review",
    body: "Schedule prompts for Claude or Codex and read the results in one inbox. When a run finishes, review its diff, comment on lines and send the review back to the agent.",
  },
  {
    title: "See the limit coming",
    body: "Tokens by day, project, session and model, the cost of every run, task and routine, and a forecast of when the current limit window runs out.",
  },
  {
    title: "Calm, healthy, safe",
    body: "Toasts stay only while something needs you. Settings › Health checks the setup with a fix button for each item, your data and notes are backed up before every write, and each release ships only after the full test suite passes.",
  },
];

interface Plugin {
  name: string;
  icon: IconName;
  purpose: string;
  points: string[];
  core?: boolean;
}

const PLUGINS: Plugin[] = [
  {
    name: "Sessions",
    icon: "sessions",
    purpose: "Every Claude Code session, Codex thread and delegated run on this machine.",
    points: [
      "List, Flow, Search and Routines modes, Needs you on top",
      "Approve or deny requests with the full command visible",
      "Answer questions and plan approvals from the hub",
      "Open session jumps to its terminal or app",
    ],
    core: true,
  },
  {
    name: "Today",
    icon: "today",
    purpose: "Your daily note as the plan for the day: focus, backlog, meetings and captures.",
    points: [
      "The note is the source of truth: add a line to schedule, remove it to unschedule",
      "Plan subtasks brings in only the steps you pick",
      "Close yesterday: ticked items complete with yesterday's date",
      "Day summary writes sessions, tasks and commits into the note",
    ],
  },
  {
    name: "Tasks",
    icon: "tasks",
    purpose: "Tasks from the project notes in your vault, as a board, a table or a timeline.",
    points: [
      "Kanban, Table and Timeline over plain Markdown",
      "Edits flow both ways with Obsidian, dates in the Obsidian Tasks format",
      "Blocked, Hold and Archived with a reason, priorities and repeat rules",
      "Hand any task to an agent",
    ],
  },
  {
    name: "Flow",
    icon: "flow",
    purpose: "A live map of workspaces, sessions, subagents and delegated tasks.",
    points: ["See who spawned what and what is still running", "Spot what is waiting on you at a glance"],
  },
  {
    name: "Delegated",
    icon: "delegated",
    purpose: "Work handed to the hub by agents: follow, steer, cancel.",
    points: [
      "Any agent delegates to Claude or Codex through the cchub MCP server",
      "A busy repo gets its own git worktree and branch",
      "Routines, diff review and cost per run",
      "PR and CI status through gh, read only",
    ],
  },
  {
    name: "Usage",
    icon: "usage",
    purpose: "What burns your tokens on this machine, for Claude and Codex.",
    points: [
      "Tokens per day, project, session and model",
      "Cache reads, fresh input and output split out",
      "Context per message, with a nudge to compact",
    ],
  },
  {
    name: "Limits",
    icon: "limits",
    purpose: "Your 5-hour and weekly plan limits in the status bar and the widget.",
    points: [
      "Claude 5-hour, weekly and per-model limits, Codex 5-hour and weekly",
      "A forecast of when the current window runs out",
      "Account-wide and read-only, polled at the interval you pick",
    ],
  },
  {
    name: "Workspaces",
    icon: "workspaces",
    purpose: "Your .code-workspace folder as a registry the hub and your agents share.",
    points: [
      "Create, open and delete workspaces from the hub or from any agent",
      "Each workspace keeps its own context: CLAUDE.md, skills",
      "Opt-in context handoff for new Claude sessions",
    ],
  },
  {
    name: "Reports",
    icon: "reports",
    purpose: "What agents reported back to the hub, in one feed.",
    points: ["Progress notes and results from delegated work", "Part of the Day summary in your daily note"],
  },
  {
    name: "Share",
    icon: "share",
    purpose: "Links so other people and their assistants can ask your Claude about a workspace.",
    points: [
      "On the LAN or public through ngrok",
      "Trust levels, a key per link, expiry and rate limits",
      "A log of every answer",
    ],
  },
  {
    name: "Session trail",
    icon: "trail",
    purpose: "Each Claude Code session summarized into a per-day file in your second brain.",
    points: ["Light, medium or high detail", "Feeds the recap that context handoff gives the next session"],
  },
  {
    name: "Widget",
    icon: "widget",
    purpose: "A small tab docked to a screen edge with your sessions and usage.",
    points: [
      "Weekly-limit rings for Claude and Codex",
      "What needs you, with requests to approve right there",
      "Today's usage and the limit forecast",
    ],
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
    body: "Long sessions re-read their whole context on every message. CCHUB shows where the tokens go, what each run costs and when the current limit window will run out.",
    points: [
      "Claude and Codex in the same chart, per day",
      "Breakdown by project, session and model",
      "Context per message (p50 · p90 · max) with a nudge to compact",
      "5-hour, weekly and per-model limits with a forecast of when they run out",
    ],
    image: "/shot-usage.png",
    alt: "CCHUB usage view with Claude and Codex plan limits, a forecast of when the 5-hour window runs out and tokens per day",
  },
  {
    id: "flow",
    eyebrow: "Sessions & delegation",
    title: "Hand work off, keep it in view.",
    body: "Agents delegate through the cchub MCP server. Every task, session and subagent lands on the same map, and Sessions switches between List, Flow, Search and Routines.",
    points: [
      "Delegate from Claude Code, Claude Desktop or Codex",
      "Busy repo? The task gets its own worktree and branch",
      "Review the diff and send comments back to the agent",
      "Follow, steer or cancel any run from the hub",
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
      "Add a task to today's note in one click, subtasks included",
    ],
    image: "/shot-timeline.png",
    alt: "CCHUB Timeline view with start-to-due bars grouped by project and a line marking today",
  },
  {
    id: "daily",
    eyebrow: "Today",
    title: "Your day, written where you already keep notes.",
    body: "Turn on Today and the daily note in your vault becomes the plan for the day. Add a line and the task is scheduled; remove it and it is not. Actions in the hub write the note first.",
    points: [
      "Close yesterday: tick what got done and it completes with yesterday's date",
      "Plan subtasks brings in only the steps you pick for today",
      "Day summary adds sessions, finished tasks, reports and commits, with no tokens spent",
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
    title: "Connect your agents",
    body: "Settings › Connections installs the hooks and adds the cchub MCP server to Claude Code, Claude Desktop and Codex. Every session on the machine shows up from then on.",
  },
  {
    title: "Pick your plugins",
    body: "Settings › Plugins turns on Today, Tasks, Usage, Limits and the rest. Settings › Health checks the setup and fixes what is off.",
  },
];

const SLOGANS = ["Run many. Forget none.", "Approve from anywhere.", "Make every token count.", "Delegate, don't babysit."];

export function App() {
  const [releaseState, setReleaseState] = useState<ReleaseState>({ status: "loading" });

  useEffect(() => {
    void fetchLatestRelease().then((release) => setReleaseState(release ? { status: "ready", release } : { status: "failed" }));
  }, []);

  const release = releaseState.status === "ready" ? releaseState.release : null;
  const downloadUrl = release?.downloadUrl ?? DOWNLOAD_URL;
  const versionSuffix = release ? ` · v${release.version}` : "";

  return (
    <div className="page">
      <ParticleField />
      <header className="nav">
        <a className="brand" href="#top">
          <img src="/logo.svg" alt="VBSS CCHUB" width={30} height={30} />
          <span>
            <span className="vsplit">V</span>BSS <b>CCHUB</b>
          </span>
        </a>
        <nav className="nav__links">
          <a href="#features">Features</a>
          <a href="#plugins">Plugins</a>
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
            VBSS CCHUB is a local hub for Claude Code and Codex. Every session in one place, permission
            requests you answer without switching windows, a day planned in your own notes, and plugins
            you turn on only when you need them.
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

          <WhatsNew state={releaseState} />

          <div className="shot">
            <img className="shot__app" src="/shot-app.png" alt="CCHUB Sessions list with the sessions that need you on top and a permission request to allow or deny" width={1440} height={900} />
            <img className="shot__widget" src="/shot-widget.png" alt="CCHUB widget with a permission request, the sessions that need you, running and recently done" width={440} height={620} />
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
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="plugins" className="section">
          <h2>Turn on only what you use</h2>
          <p className="section__sub">
            Every area of the hub is a plugin. Switch each one on or off in Settings › Plugins, then arrange,
            collapse and resize the sidebar the way you work. Sessions is always on.
          </p>
          <ul className="plugins">
            {PLUGINS.map((plugin) => (
              <li key={plugin.name} className="plugin">
                <div className="plugin__head">
                  <span className="plugin__icon">
                    <PluginIcon name={plugin.icon} />
                  </span>
                  <h3>{plugin.name}</h3>
                  {plugin.core && <span className="plugin__tag">Always on</span>}
                </div>
                <p>{plugin.purpose}</p>
                <ul className="plugin__points">
                  {plugin.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>

        <section id="tour" className="section tour">
          <h2>A closer look</h2>
          <p className="section__sub">Real screens from v2.0, with demo data.</p>
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
                the weekly limit each provider has used; a badge counts the sessions waiting on you,
                and their requests can be answered right there.
              </p>
              <ul>
                <li>Left, right or top edge, drag it along the side</li>
                <li>Rings for Claude and Codex, turn each on or off</li>
                <li>Sessions tab: needs you, running, idle, delegated</li>
                <li>Usage tab: today, last 7 days, plan limits and forecast</li>
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
          <p className="section__sub">
            No account, no config file to write. Optional plugins like Today, Tasks, Usage and Limits stay
            off until you turn them on.
          </p>
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
