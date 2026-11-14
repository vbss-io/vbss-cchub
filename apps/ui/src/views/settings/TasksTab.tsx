import { useEffect, useState } from "react";
import { formatList, parseList, validateTaskSettings } from "../../board-model";
import { Advanced } from "./Advanced";
import type { SettingsTabProps } from "./types";

export function TasksTab({ enabled, settings, onSaveSettings }: SettingsTabProps) {
  const [root, setRoot] = useState(settings?.tasks.root ?? "");
  const [section, setSection] = useState(settings?.tasks.section ?? "Open loops");
  const [blocked, setBlocked] = useState(formatList(settings?.tasks.prefixes.blocked ?? ["BLOCK", "BLOCKED"]));
  const [hold, setHold] = useState(formatList(settings?.tasks.prefixes.hold ?? ["HOLD"]));
  const [archived, setArchived] = useState(formatList(settings?.tasks.prefixes.archived ?? ["ARCHIVED"]));
  const [separator, setSeparator] = useState(settings?.tasks.separator ?? " - ");
  const [reasonSeparator, setReasonSeparator] = useState(settings?.tasks.reasonSeparator ?? " - ");
  const [doneSection, setDoneSection] = useState(settings?.tasks.doneSection ?? "");
  const [doneStamp, setDoneStamp] = useState(settings?.tasks.doneStamp ?? " ✅ {{date}}");
  const [exclude, setExclude] = useState(formatList(settings?.tasks.exclude ?? ["_*"]));
  const [workspaceKey, setWorkspaceKey] = useState(settings?.tasks.workspaceKey ?? "workspace");
  const [parentKey, setParentKey] = useState(settings?.tasks.parentKey ?? "parent");
  const [prompt, setPrompt] = useState(settings?.tasks.delegatePrompt ?? "");
  const [markDoing, setMarkDoing] = useState(settings?.tasks.markDoingOnDelegate ?? true);
  const [priorityTag, setPriorityTag] = useState(settings?.tasks.priorityTag ?? "p");
  const [priorityLevels, setPriorityLevels] = useState(String(settings?.tasks.priorityLevels ?? 4));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRoot(settings?.tasks.root ?? "");
    setSection(settings?.tasks.section ?? "Open loops");
    setBlocked(formatList(settings?.tasks.prefixes.blocked ?? ["BLOCK", "BLOCKED"]));
    setHold(formatList(settings?.tasks.prefixes.hold ?? ["HOLD"]));
    setArchived(formatList(settings?.tasks.prefixes.archived ?? ["ARCHIVED"]));
    setSeparator(settings?.tasks.separator ?? " - ");
    setReasonSeparator(settings?.tasks.reasonSeparator ?? " - ");
    setDoneSection(settings?.tasks.doneSection ?? "");
    setDoneStamp(settings?.tasks.doneStamp ?? " ✅ {{date}}");
    setExclude(formatList(settings?.tasks.exclude ?? ["_*"]));
    setWorkspaceKey(settings?.tasks.workspaceKey ?? "workspace");
    setParentKey(settings?.tasks.parentKey ?? "parent");
    setPrompt(settings?.tasks.delegatePrompt ?? "");
    setMarkDoing(settings?.tasks.markDoingOnDelegate ?? true);
    setPriorityTag(settings?.tasks.priorityTag ?? "p");
    setPriorityLevels(String(settings?.tasks.priorityLevels ?? 4));
  }, [settings]);

  const dirty =
    root.trim() !== (settings?.tasks.root ?? "") ||
    section.trim() !== (settings?.tasks.section ?? "Open loops") ||
    blocked !== formatList(settings?.tasks.prefixes.blocked ?? ["BLOCK", "BLOCKED"]) ||
    hold !== formatList(settings?.tasks.prefixes.hold ?? ["HOLD"]) ||
    archived !== formatList(settings?.tasks.prefixes.archived ?? ["ARCHIVED"]) ||
    separator !== (settings?.tasks.separator ?? " - ") ||
    reasonSeparator !== (settings?.tasks.reasonSeparator ?? " - ") ||
    doneSection.trim() !== (settings?.tasks.doneSection ?? "") ||
    doneStamp !== (settings?.tasks.doneStamp ?? " ✅ {{date}}") ||
    exclude !== formatList(settings?.tasks.exclude ?? ["_*"]) ||
    workspaceKey.trim() !== (settings?.tasks.workspaceKey ?? "workspace") ||
    parentKey.trim() !== (settings?.tasks.parentKey ?? "parent") ||
    prompt !== (settings?.tasks.delegatePrompt ?? "") ||
    markDoing !== (settings?.tasks.markDoingOnDelegate ?? true) ||
    priorityTag.trim() !== (settings?.tasks.priorityTag ?? "p") ||
    priorityLevels.trim() !== String(settings?.tasks.priorityLevels ?? 4);

  const prefixesEmpty = [blocked, hold, archived].some((value) => parseList(value).length === 0);

  const issues = validateTaskSettings({ reasonSeparator, doneSection, doneStamp, priorityTag, priorityLevels });
  const invalid = Object.values(issues).some((issue) => issue !== null);

  const save = async () => {
    setBusy(true);
    try {
      await onSaveSettings({
        tasks: {
          root: root.trim() || null,
          section: section.trim(),
          prefixes: { blocked: parseList(blocked), hold: parseList(hold), archived: parseList(archived) },
          separator,
          reasonSeparator,
          doneSection: doneSection.trim(),
          doneStamp,
          exclude: parseList(exclude),
          workspaceKey: workspaceKey.trim(),
          parentKey: parentKey.trim(),
          delegatePrompt: prompt.trim() ? prompt : null,
          markDoingOnDelegate: markDoing,
          priorityTag: priorityTag.trim(),
          priorityLevels: Number(priorityLevels.trim()),
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
      await onSaveSettings({ tasks: { delegatePrompt: null } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings__section" id="settings-tasks">
      <h2>Tasks</h2>
      <p className="hint">Every markdown file under the projects folder is a project; tasks are the checkbox lines in one section, and edits go both ways.</p>
      <div className="form">
        <label className="field">
          <span>Projects folder</span>
          <input
            className="in"
            placeholder={settings?.secondBrainRoot ? `${settings.secondBrainRoot}/projects` : "<second brain>/projects"}
            value={root}
            onChange={(event) => setRoot(event.target.value)}
            disabled={!enabled}
          />
          <small>Relative paths resolve inside the Second brain path. Every .md file below it is a project.</small>
        </label>
        <label className="field">
          <span>Section</span>
          <input className="in" placeholder="Open loops" value={section} onChange={(event) => setSection(event.target.value)} disabled={!enabled} />
          <small>Heading whose checkbox lines become tasks. Leave empty to read the whole document.</small>
        </label>
        <Advanced>
          <div className="field">
            <span>Status prefixes</span>
            <div className="frow frow--fields">
              <label className="field">
                <span>Blocked</span>
                <input className="in" placeholder="BLOCK, BLOCKED" value={blocked} onChange={(event) => setBlocked(event.target.value)} disabled={!enabled} />
              </label>
              <label className="field">
                <span>Hold</span>
                <input className="in" placeholder="HOLD" value={hold} onChange={(event) => setHold(event.target.value)} disabled={!enabled} />
              </label>
              <label className="field">
                <span>Archived</span>
                <input className="in" placeholder="ARCHIVED" value={archived} onChange={(event) => setArchived(event.target.value)} disabled={!enabled} />
              </label>
            </div>
            {prefixesEmpty && <small className="error">Each status needs at least one prefix word.</small>}
            <small>
              Comma separated, case sensitive. A task like <code>- [ ] HOLD - waiting for Ana</code> takes that status; the first word of each list is the one the hub writes.
            </small>
          </div>
          <label className="field">
            <span>Separator</span>
            <input className="in" placeholder=" - " value={separator} onChange={(event) => setSeparator(event.target.value)} disabled={!enabled} />
            <small>
              Written between a prefix and the title: a dash or colon surrounded by spaces, such as <code>{" - "}</code> or <code>{": "}</code>.
            </small>
          </label>
          <label className="field">
            <span>Reason separator</span>
            <input className="in" placeholder=" - " value={reasonSeparator} onChange={(event) => setReasonSeparator(event.target.value)} disabled={!enabled} />
            {issues.reasonSeparator && <small className="error">{issues.reasonSeparator}</small>}
            <small>
              Splits the reason off Blocked, Hold and Archived tasks at the last occurrence: with <code>{" | "}</code>, <code>- [ ] HOLD - Ana | waiting for the contract</code> shows "waiting for the
              contract" under "Ana".
            </small>
          </label>
          <div className="frow frow--fields">
            <label className="field">
              <span>Done section</span>
              <input className="in" placeholder="Done loops" value={doneSection} onChange={(event) => setDoneSection(event.target.value)} disabled={!enabled} />
              {issues.doneSection && <small className="error">{issues.doneSection}</small>}
              <small>Heading finished tasks move to, newest first. Leave empty to keep done tasks in place.</small>
            </label>
            <label className="field">
              <span>Done stamp</span>
              <input className="in" placeholder=" ✅ {{date}}" value={doneStamp} onChange={(event) => setDoneStamp(event.target.value)} disabled={!enabled} />
              {issues.doneStamp && <small className="error">{issues.doneStamp}</small>}
              <small>
                Appended to a task when it moves, with <code>{"{{date}}"}</code> as the local date.
              </small>
            </label>
          </div>
          <div className="frow frow--fields">
            <label className="field">
              <span>Priority tag</span>
              <input className="in" placeholder="p" value={priorityTag} onChange={(event) => setPriorityTag(event.target.value)} disabled={!enabled} />
              {issues.priorityTag && <small className="error">{issues.priorityTag}</small>}
              <small>
                Obsidian tag at the end of a task line: with <code>p</code>, <code>- [ ] Ship export #p1</code> has priority P1.
              </small>
            </label>
            <label className="field">
              <span>Priority levels</span>
              <input className="in" inputMode="numeric" placeholder="4" value={priorityLevels} onChange={(event) => setPriorityLevels(event.target.value)} disabled={!enabled} />
              {issues.priorityLevels && <small className="error">{issues.priorityLevels}</small>}
              <small>How many levels the board offers, from P0 up (1 to 10).</small>
            </label>
          </div>
          <label className="field">
            <span>Exclude</span>
            <input className="in" placeholder="_*" value={exclude} onChange={(event) => setExclude(event.target.value)} disabled={!enabled} />
            <small>Comma separated name patterns for files and folders to skip. Names starting with a dot are always skipped.</small>
          </label>
          <div className="frow frow--fields">
            <label className="field">
              <span>Workspace key</span>
              <input className="in" value={workspaceKey} onChange={(event) => setWorkspaceKey(event.target.value)} disabled={!enabled} />
              <small>Frontmatter key naming the CC Hub workspace of a project.</small>
            </label>
            <label className="field">
              <span>Parent key</span>
              <input className="in" value={parentKey} onChange={(event) => setParentKey(event.target.value)} disabled={!enabled} />
              <small>Frontmatter key that overrides the parent project.</small>
            </label>
          </div>
          <label className="field">
            <span>Delegate prompt</span>
            <textarea className="in area" rows={8} placeholder="Empty uses the default prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={!enabled} />
            <small>
              Placeholders: <code>{"{{project}}"}</code> <code>{"{{projectPath}}"}</code> <code>{"{{task}}"}</code> <code>{"{{subtasks}}"}</code> <code>{"{{notes}}"}</code>{" "}
              <code>{"{{status}}"}</code> <code>{"{{reason}}"}</code> <code>{"{{priority}}"}</code>
            </small>
          </label>
          <div className="actions actions--start">
            <button type="button" className="act" disabled={!enabled || busy} onClick={() => void resetPrompt()}>
              Reset to default
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={markDoing} onChange={(event) => setMarkDoing(event.target.checked)} disabled={!enabled} />
            Mark a To-Do task as Doing when it is delegated
          </label>
        </Advanced>
        <div className="actions">
          <button className="act act--focus" disabled={!enabled || busy || !dirty || prefixesEmpty || invalid} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </section>
  );
}
