import { useEffect, useState } from "react";
import { DailyProjectOrder } from "../../components/DailyProjectOrder";
import { getTasksBoard, type BoardProject, type Runner } from "../../delegation";
import { Advanced } from "./Advanced";
import type { SettingsTabProps } from "./types";

export function TodayTab({ enabled, settings, onSaveSettings }: SettingsTabProps) {
  const [dir, setDir] = useState(settings?.daily.dir ?? "");
  const [template, setTemplate] = useState(settings?.daily.template ?? "");
  const [prompt, setPrompt] = useState(settings?.daily.prompt ?? "");
  const [runner, setRunner] = useState<Runner>(settings?.daily.runner ?? "claude");
  const [headingFocus, setHeadingFocus] = useState(settings?.daily.headings.focus ?? "Focus");
  const [headingMeetings, setHeadingMeetings] = useState(settings?.daily.headings.meetings ?? "Meetings");
  const [headingSessions, setHeadingSessions] = useState(settings?.daily.headings.sessions ?? "Sessions");
  const [closedKey, setClosedKey] = useState(settings?.daily.closedKey ?? "closed");
  const [wikilinks, setWikilinks] = useState(settings?.daily.wikilinks ?? false);
  const [projectOrder, setProjectOrder] = useState<string[]>(settings?.daily.projectOrder ?? []);
  const [orderProjects, setOrderProjects] = useState<BoardProject[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDir(settings?.daily.dir ?? "");
    setTemplate(settings?.daily.template ?? "");
    setPrompt(settings?.daily.prompt ?? "");
    setRunner(settings?.daily.runner ?? "claude");
    setHeadingFocus(settings?.daily.headings.focus ?? "Focus");
    setHeadingMeetings(settings?.daily.headings.meetings ?? "Meetings");
    setHeadingSessions(settings?.daily.headings.sessions ?? "Sessions");
    setClosedKey(settings?.daily.closedKey ?? "closed");
    setWikilinks(settings?.daily.wikilinks ?? false);
    setProjectOrder(settings?.daily.projectOrder ?? []);
  }, [settings]);

  useEffect(() => {
    let alive = true;
    getTasksBoard()
      .then((board) => {
        if (alive) setOrderProjects(board.projects);
      })
      .catch(() => {
        if (alive) setOrderProjects([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const dirty =
    dir.trim() !== (settings?.daily.dir ?? "") ||
    template.trim() !== (settings?.daily.template ?? "") ||
    prompt !== (settings?.daily.prompt ?? "") ||
    runner !== (settings?.daily.runner ?? "claude") ||
    headingFocus.trim() !== (settings?.daily.headings.focus ?? "Focus") ||
    headingMeetings.trim() !== (settings?.daily.headings.meetings ?? "Meetings") ||
    headingSessions.trim() !== (settings?.daily.headings.sessions ?? "Sessions") ||
    closedKey.trim() !== (settings?.daily.closedKey ?? "closed") ||
    wikilinks !== (settings?.daily.wikilinks ?? false) ||
    JSON.stringify(projectOrder) !== JSON.stringify(settings?.daily.projectOrder ?? []);

  const save = async () => {
    setBusy(true);
    try {
      await onSaveSettings({
        daily: {
          dir: dir.trim() || null,
          template: template.trim() || null,
          prompt: prompt.trim() || null,
          runner,
          headings: { focus: headingFocus.trim() || "Focus", meetings: headingMeetings.trim() || "Meetings", sessions: headingSessions.trim() || "Sessions" },
          closedKey: closedKey.trim() || "closed",
          wikilinks,
          projectOrder,
        },
      });
    } finally {
      setBusy(false);
    }
  };

  const resetPrompt = async () => {
    setBusy(true);
    try {
      setPrompt("");
      await onSaveSettings({ daily: { prompt: null } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings__section" id="settings-today">
      <h2>Today</h2>
      <p className="hint">Generates and edits the day's diary in your second brain; needs the Second brain path.</p>
      <div className="form">
        <label className="field">
          <span>Folder</span>
          <input
            className="in"
            placeholder={settings?.secondBrainRoot ? `${settings.secondBrainRoot}/daily` : "<second brain>/daily"}
            value={dir}
            onChange={(event) => setDir(event.target.value)}
            disabled={!enabled}
          />
        </label>
        <label className="field">
          <span>Template</span>
          <input className="in" placeholder="_templates/daily.md" value={template} onChange={(event) => setTemplate(event.target.value)} disabled={!enabled} />
        </label>
        <Advanced>
          <label className="field">
            <span>Runner</span>
            <select className="in" value={runner} onChange={(event) => setRunner(event.target.value as Runner)} disabled={!enabled}>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label className="field">
            <span>Prompt</span>
            <textarea
              className="in area"
              rows={8}
              placeholder="{{date}} {{file}} {{root}} {{template}} {{focus}} {{sessions}} {{yesterday}}"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={!enabled}
            />
            <small>
              Placeholders: <code>{"{{date}}"}</code> <code>{"{{file}}"}</code> <code>{"{{root}}"}</code> <code>{"{{template}}"}</code> <code>{"{{focus}}"}</code> <code>{"{{sessions}}"}</code>{" "}
              <code>{"{{yesterday}}"}</code>
            </small>
          </label>
          <div className="actions actions--start">
            <button type="button" className="act" disabled={!enabled || busy} onClick={() => void resetPrompt()}>
              Reset to default
            </button>
          </div>
          <div className="field">
            <span>Headings</span>
            <div className="frow frow--fields">
              <label className="field">
                <span>Focus</span>
                <input className="in" value={headingFocus} onChange={(event) => setHeadingFocus(event.target.value)} disabled={!enabled} />
              </label>
              <label className="field">
                <span>Meetings</span>
                <input className="in" value={headingMeetings} onChange={(event) => setHeadingMeetings(event.target.value)} disabled={!enabled} />
              </label>
              <label className="field">
                <span>Sessions</span>
                <input className="in" value={headingSessions} onChange={(event) => setHeadingSessions(event.target.value)} disabled={!enabled} />
              </label>
            </div>
            <small>Exact text after ## in your template.</small>
          </div>
          <label className="field">
            <span>Closed key</span>
            <input className="in" value={closedKey} onChange={(event) => setClosedKey(event.target.value)} disabled={!enabled} />
            <small>Frontmatter key written when yesterday is closed.</small>
          </label>
          <label className="check">
            <input type="checkbox" checked={wikilinks} onChange={(event) => setWikilinks(event.target.checked)} disabled={!enabled} />
            Link projects as [[Project]] in focus items
          </label>
          <DailyProjectOrder projects={orderProjects} order={projectOrder} disabled={!enabled} onChange={setProjectOrder} />
        </Advanced>
        <div className="actions">
          <button className="act act--focus" disabled={!enabled || busy || !dirty} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </section>
  );
}
