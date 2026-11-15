import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import "../today.css";
import type { DailyStreamEvent, TasksBoardStreamEvent } from "../api";
import { BacklogPanel } from "../components/BacklogPanel";
import { BoardActionsMenu, type BoardMenuItem } from "../components/BoardActionsMenu";
import { BoardDelegateDialog, type BoardDelegateRequest } from "../components/BoardDelegateDialog";
import { BoardDrawer, type BoardOrganizeActions } from "../components/BoardDrawer";
import { BoardNewTaskDialog } from "../components/BoardNewTaskDialog";
import { BoardMoveProjectDialog, BoardParentPickerDialog } from "../components/BoardOrganizeDialogs";
import type { BoardNoteActions, BoardTodayControls } from "../components/BoardParts";
import { FocusOutliner, type OutlineFields } from "../components/FocusOutliner";
import { ResizableSplit } from "../components/ResizableSplit";
import { StartDayPanel } from "../components/StartDayPanel";
import { Toggletip } from "../components/Toggletip";
import {
  collapseAllFocus,
  expandAllFocus,
  FOCUS_COLLAPSE_KEY,
  isAllCollapsed,
  isAllExpanded,
  parseFocusCollapse,
  serializeFocusCollapse,
  type FocusCollapse,
} from "../focus-collapse";
import { useLayoutSize } from "../use-layout-size";
import {
  countedProjectOptions,
  effectiveProjectOrder,
  findBoardTask,
  findTaskAfterRefetch,
  formatDayMonth,
  moveTargetProjects,
  obsidianUrl,
  organizeFocus,
  parentCandidates,
  projectOptions,
  recurrenceNotice,
  remapTaskId,
  validateNoteText,
} from "../board-model";
import {
  addBoardNote,
  addCapture,
  addMeeting,
  BoardConflictError,
  clearToday,
  createBoardItem,
  createTodayNote,
  delegateBoardTask,
  deleteBoardNote,
  editBoardNote,
  getTasksBoard,
  getToday,
  linkTick,
  moveBoardItem,
  moveBoardTaskToProject,
  openBoardProjectInEditor,
  patchBoardItem,
  promoteCapture,
  reorderFocus,
  reparentBoardTask,
  scheduleTask,
  TodayUnavailableError,
  undoClearToday,
  type BoardChange,
  type BoardCreateInput,
  type BoardPayload,
  type BoardProject,
  type BoardTarget,
  type BoardTask,
  type DelegationSettings,
  type TodayAmbiguous,
  type TodayCapture,
  type TodayData,
  type TodayEntry,
  type TodayOutOfSync,
  type TodayUnmatched,
  type WorkspaceRecord,
} from "../delegation";
import { IconClose } from "../icons";
import { InlineText, Markdown } from "../markdown";
import { openExternal } from "../notify";
import { addDays, doingTarget, previousSibling, nextSibling, type OutlineGroup, type OutlineNode } from "../outliner-model";
import {
  canCreateFromNoMatch,
  canLinkNoMatch,
  createTitleOf,
  isFocusable,
  lineCheckbox,
  lineContent,
  noteSections,
  planFocusAdd,
  splitNoteLine,
  type LinkedNoteItem,
  type NoMatchItem,
} from "../today-note";
import {
  ambiguityHint,
  canAddToFocus,
  decodeDragTarget,
  describeDay,
  entryTaskIds,
  flattenBoardTasks,
  insertAnchorOf,
  keepDismissed,
  linkTargetOfTask,
  linkTickInput,
  localDay,
  moveSteps,
  nextDay,
  outlineGroupsOf,
  outOfSyncKey,
  parentOfTask,
  parseDismissedOutOfSync,
  pickerTasks,
  recentlyDoneTasks,
  rootNodeOf,
  scheduledElsewhere,
  START_DAY_EVENT,
  startPanelAuto,
  targetOfTask,
  taskOfOutOfSync,
  TODAY_DRAG_MIME,
  visibleOutOfSync,
  CLEAR_UNDO_MS,
  clearedNotice,
  movesInNote,
  type LinkTarget,
  type PickerTask,
} from "../today-model";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DAILY_ORGANIZE_EVENT, DAILY_REFINE_EVENT, DailyView, useDailySessions, type DailyEntryInfo } from "./DailyView";

interface ClearUndo {
  date: string;
  token: string;
  text: string;
}

interface Props {
  settings: DelegationSettings | null;
  workspaces: WorkspaceRecord[];
  onOpenSession: (sessionId: string) => void;
  onOpenTask: (taskId: string) => void;
  subscribeDaily: (listener: (event: DailyStreamEvent) => void) => () => void;
  subscribeBoard: (listener: (event: TasksBoardStreamEvent) => void) => () => void;
  onDelegated: (taskId: string, title: string) => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}

type Tab = "today" | "backlog" | "note";

type LoadFailure = { kind: "unavailable" | "error"; message: string };

interface QuickAddState {
  projectId: string;
  text: string;
  busy: boolean;
  error: string | null;
}

const REFRESH_DELAY_MS = 250;
const TYPING_RETRY_MS = 600;
const NARROW_QUERY = "(max-width: 899px)";
const QUICK_PROJECT_KEY = "hub.today.quickProject";
const PROMOTE_PROJECT_KEY = "hub.today.promoteProject";
const TAB_KEY = "hub.today.tab";
const KEPT_TASKS_KEY = "hub.today.keptTasks";
const CONFLICT_NOTICE = "This task changed on disk, so Today was refreshed. Try again.";

const messageOf = (error: unknown, fallback = "Something went wrong"): string => (error instanceof Error && error.message !== "" ? error.message : fallback);

const readStored = (key: string): string => {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};

const writeStored = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
};

function readTab(): Tab {
  const stored = readStored(TAB_KEY);
  return stored === "note" ? "note" : "today";
}

const BACKLOG_WIDTH = { default: 360 } as const;

function TodayColumns({ split, main, side }: { split: boolean; main: ReactNode; side: ReactNode }) {
  const [width, setWidth] = useLayoutSize("today", "backlog", BACKLOG_WIDTH.default);
  if (!split) {
    return (
      <div className="today__grid">
        {main}
        {side}
      </div>
    );
  }
  return (
    <ResizableSplit
      id="today-backlog"
      className="today__split"
      side="end"
      defaultSize={BACKLOG_WIDTH.default}
      size={width}
      onSizeChange={setWidth}
      ariaLabel="Resize backlog panel"
    >
      {[main, side]}
    </ResizableSplit>
  );
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    onChange();
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

function ProjectSelect({ projects, value, label, onChange }: { projects: BoardProject[]; value: string; label: string; onChange: (id: string) => void }) {
  return (
    <select className="in today__select" value={value} aria-label={label} onChange={(event) => onChange(event.target.value)}>
      {projectOptions(projects).map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

const OTHER_TASK = "other";

const CHECKBOX_LABEL: Record<TodayUnmatched["checkbox"], string> = { todo: "To-do", doing: "Doing", done: "Done" };

interface PickerGroupProps {
  heading: string;
  label: string;
  items: PickerTask[];
  total: number;
  busy: boolean;
  showDone?: boolean;
  onPick: (task: BoardTask) => void;
}

function PickerGroup({ heading, label, items, total, busy, showDone = false, onPick }: PickerGroupProps) {
  if (items.length === 0) return null;
  return (
    <>
      <h4 className="today__picker-group">{heading}</h4>
      <ul className="today__plain today__picker-list" aria-label={label}>
        {items.map(({ task, projectTitle }) => (
          <li key={task.id}>
            <button type="button" className="today__picker-item" disabled={busy} onClick={() => onPick(task)}>
              <span>{task.title}</span>
              <span className="muted small">{showDone && task.doneAt ? `${projectTitle} - done ${task.doneAt}` : projectTitle}</span>
            </button>
          </li>
        ))}
      </ul>
      {total > items.length && (
        <p className="hint">
          Showing {items.length} of {total}. Type to narrow the list.
        </p>
      )}
    </>
  );
}

function CountedProjectSelect({ projects, tasks, value, label, onChange }: { projects: BoardProject[]; tasks: readonly BoardTask[]; value: string; label: string; onChange: (id: string) => void }) {
  const counted = useMemo(() => countedProjectOptions(projects, tasks, false), [projects, tasks]);
  return (
    <select className="in today__select" value={value} aria-label={label} onChange={(event) => onChange(event.target.value)}>
      {counted.options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

interface NoMatchProps {
  items: NoMatchItem[];
  leftovers: TodayAmbiguous[];
  tasks: BoardTask[];
  openTasks: readonly BoardTask[];
  projects: BoardProject[];
  busyKeys: ReadonlySet<string>;
  actions: boolean;
  onLink: (item: NoMatchItem, target: LinkTarget | null) => void;
  onCreate: (item: NoMatchItem, projectId: string) => Promise<void>;
}

function NoMatchSection({ items, leftovers, tasks, openTasks, projects, busyKeys, actions, onLink, onCreate }: NoMatchProps) {
  const [picking, setPicking] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState<{ key: string; projectId: string } | null>(null);
  const titles = useMemo(() => new Map(projects.map((project) => [project.id, project.title])), [projects]);
  const found = useMemo(() => (picking === null ? null : pickerTasks(tasks, projects, query)), [picking, tasks, projects, query]);
  const finished = useMemo(() => (picking === null ? null : recentlyDoneTasks(tasks, projects, query, localDay())), [picking, tasks, projects, query]);

  const onSelect = (item: NoMatchItem, value: string) => {
    if (value === OTHER_TASK) {
      setPicking(item.key);
      setCreating(null);
      setQuery("");
      return;
    }
    const candidate = item.candidates[Number(value)];
    if (candidate === undefined) return;
    setPicking(null);
    onLink(item, { projectId: candidate.projectId, line: candidate.line, raw: candidate.raw });
  };

  const startCreate = (item: NoMatchItem) => {
    if (item.projectId !== null) {
      void onCreate(item, item.projectId);
      return;
    }
    const stored = readStored(QUICK_PROJECT_KEY);
    setPicking(null);
    setCreating({ key: item.key, projectId: projects.some((project) => project.id === stored) ? stored : (projects[0]?.id ?? "") });
  };

  const confirmCreate = (item: NoMatchItem) => {
    if (creating === null || creating.projectId === "") return;
    const projectId = creating.projectId;
    setCreating(null);
    void onCreate(item, projectId);
  };

  return (
    <section className="today__section" aria-label="In the note, no matching task">
      <header className="today__section-head">
        <h3>
          In the note, no matching task <span className="today__count">{items.length + leftovers.length}</span>
        </h3>
        <Toggletip label="About lines with no matching task" align="end">
          Lines of the note that no project task matches. Link one to an existing task, or create a task from it: the task is scheduled for this day and the same line then links to it. The note is never rewritten.
        </Toggletip>
      </header>
      <ul className="today__plain">
        {items.map((item) => {
          const busy = busyKeys.has(item.key);
          const linkable = item.tick !== null || (actions && canLinkNoMatch(item));
          const creatable = actions && canCreateFromNoMatch(item);
          const projectTitle = item.projectId === null ? null : (titles.get(item.projectId) ?? item.projectId);
          return (
            <li key={item.key} className={`today__unmatched ${busy ? "today__row--busy" : ""}`} aria-busy={busy}>
              <div className="today__row">
                <span className="today__text">
                  {item.checkbox !== null && <span className={`today__box today__box--${item.checkbox}`} role="img" aria-label={CHECKBOX_LABEL[item.checkbox]} title={CHECKBOX_LABEL[item.checkbox]} />}
                  {projectTitle !== null && <span className="today__label">{projectTitle}</span>}
                  <InlineText text={item.text} />
                  {item.section !== null && item.section !== "" && <span className="muted small"> - {item.section}</span>}
                  {item.hint !== null && <span className="muted small today__hint"> {item.hint}</span>}
                </span>
                <span className="today__actions">
                  {creatable && (
                    <button
                      type="button"
                      className="act"
                      disabled={busy}
                      title={projectTitle !== null ? `Create the task in ${projectTitle}, scheduled for this day` : "Choose a project, then create the task scheduled for this day"}
                      onClick={() => startCreate(item)}
                    >
                      Create task
                    </button>
                  )}
                  {linkable && (
                    <select className="in today__select" value="" disabled={busy} aria-label={`Link "${item.text}" to a task`} onChange={(event) => onSelect(item, event.target.value)}>
                      <option value="">Link to task…</option>
                      {item.candidates.map((candidate, index) => (
                        <option key={`${candidate.projectId}:${candidate.line}`} value={String(index)}>
                          {candidate.title} - {titles.get(candidate.projectId) ?? candidate.projectId}
                        </option>
                      ))}
                      <option value={OTHER_TASK}>Choose another…</option>
                    </select>
                  )}
                  {item.tick !== null && (
                    <button type="button" className="act" disabled={busy} onClick={() => onLink(item, null)}>
                      Ignore
                    </button>
                  )}
                </span>
              </div>
              {item.children.length > 0 && (
                <ul className="today__children">
                  {item.children.map((child, index) => (
                    <li key={`${index}:${child}`}>
                      <InlineText text={lineContent(child)} />
                    </li>
                  ))}
                </ul>
              )}
              {creating !== null && creating.key === item.key && (
                <div className="today__promote">
                  <CountedProjectSelect projects={projects} tasks={openTasks} value={creating.projectId} label="Project for the new task" onChange={(projectId) => setCreating({ key: item.key, projectId })} />
                  <button type="button" className="act act--focus" disabled={busy || creating.projectId === ""} onClick={() => confirmCreate(item)}>
                    Create
                  </button>
                  <button type="button" className="act" onClick={() => setCreating(null)}>
                    Cancel
                  </button>
                </div>
              )}
              {picking === item.key && found !== null && (
                <div className="today__picker">
                  <input
                    className="in today__picker-search"
                    type="search"
                    value={query}
                    placeholder="Search tasks"
                    aria-label="Search tasks to link"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setPicking(null);
                      }
                    }}
                  />
                  <button type="button" className="act" onClick={() => setPicking(null)}>
                    Cancel
                  </button>
                  {found.items.length === 0 && (finished === null || finished.items.length === 0) && <p className="hint today__picker-empty">No task matches.</p>}
                  <PickerGroup
                    heading="Open"
                    label="Open tasks"
                    items={found.items}
                    total={found.total}
                    busy={busy}
                    onPick={(task) => {
                      setPicking(null);
                      onLink(item, linkTargetOfTask(task));
                    }}
                  />
                  {finished !== null && (
                    <PickerGroup
                      heading="Recently done"
                      label="Recently done tasks"
                      items={finished.items}
                      total={finished.total}
                      busy={busy}
                      showDone
                      onPick={(task) => {
                        setPicking(null);
                        onLink(item, linkTargetOfTask(task));
                      }}
                    />
                  )}
                </div>
              )}
            </li>
          );
        })}
        {leftovers.map((item, index) => (
          <li key={`${index}:${item.kind}:${item.text}`} className="today__row">
            <span className="today__text">
              <InlineText text={lineContent(item.text)} /> <span className="muted small">{ambiguityHint(item)}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface AlsoInNoteProps {
  items: LinkedNoteItem[];
  projects: BoardProject[];
  date: string;
  actions: boolean;
  busyIds: ReadonlySet<string>;
  onAdd: (tasks: readonly BoardTask[]) => void;
}

function AlsoInNote({ items, projects, date, actions, busyIds, onAdd }: AlsoInNoteProps) {
  const titles = new Map(projects.map((project) => [project.id, project.title]));
  const addable = actions ? [...new Map(items.filter((item) => canAddToFocus(item.task)).map((item) => [item.task.id, item.task])).values()] : [];
  return (
    <details className="today__disclosure">
      <summary className="today__disclosure-head">
        <span>Also in the note ({items.length})</span>
        <span className="today__tip" onClick={(event) => event.preventDefault()}>
          <Toggletip label="About lines also in the note">
            Lines of the note linked to a task that is not in this day's focus. The hub never removes or rewrites them; edit them in the Note tab.
          </Toggletip>
        </span>
        {addable.length > 0 && (
          <button
            type="button"
            className="act"
            disabled={addable.some((task) => busyIds.has(task.id))}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onAdd(addable);
            }}
          >
            Add all ({addable.length})
          </button>
        )}
      </summary>
      <ul className="today__plain">
        {items.map(({ key, block, task }) => {
          const split = splitNoteLine(block.line, projects);
          const planned = actions ? scheduledElsewhere(task, date) : null;
          const action = actions && planned === null && canAddToFocus(task);
          const busy = busyIds.has(task.id);
          return (
            <li key={key} className={`today__note-line ${busy ? "today__row--busy" : ""}`} aria-busy={busy}>
              <div className="today__row">
                <span className="today__text today__note-text">
                  {lineContentBox(block.line)}
                  {split.projectId !== null && <span className="today__label">{titles.get(split.projectId) ?? split.projectId}</span>}
                  <InlineText text={split.text} />
                </span>
                {planned !== null && <span className="hint">{planned}</span>}
                {action && (
                  <span className="today__actions">
                    <button type="button" className="act" disabled={busy} aria-label={`Add "${task.title}" to focus`} onClick={() => onAdd([task])}>
                      Add to focus
                    </button>
                  </span>
                )}
              </div>
              {block.children.length > 0 && (
                <ul className="today__children">
                  {block.children.map((child, index) => (
                    <li key={`${index}:${child}`}>
                      <InlineText text={lineContent(child)} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function lineContentBox(line: string): ReactNode {
  const box = lineCheckbox(line);
  return box === null ? null : <span className={`today__box today__box--${box}`} role="img" aria-label={CHECKBOX_LABEL[box]} title={CHECKBOX_LABEL[box]} />;
}

function InlineAdd({ placeholder, label, onSubmit }: { placeholder: string; label: string; onSubmit: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const value = text.trim();
    if (value === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
      setText("");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape") {
      setText("");
      setError(null);
    }
  };

  return (
    <div className="today__inline">
      <input
        className="in today__inline-input"
        type="text"
        value={text}
        placeholder={placeholder}
        aria-label={label}
        readOnly={busy}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {error !== null && (
        <span className="error small" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function CaptureItem({
  capture,
  projects,
  isToday,
  onPromote,
}: {
  capture: TodayCapture;
  projects: BoardProject[];
  isToday: boolean;
  onPromote: (capture: TodayCapture, projectId: string, schedule: boolean) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [schedule, setSchedule] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = projects.some((project) => project.id === projectId) ? projectId : (projects[0]?.id ?? "");

  const openForm = () => {
    const stored = readStored(PROMOTE_PROJECT_KEY);
    setProjectId(projects.some((project) => project.id === stored) ? stored : (projects[0]?.id ?? ""));
    setError(null);
    setOpen(true);
  };

  const submit = async () => {
    if (chosen === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onPromote(capture, chosen, schedule);
      writeStored(PROMOTE_PROJECT_KEY, chosen);
      setOpen(false);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="today__capture">
      <div className="today__row">
        <span className="today__text">
          <InlineText text={capture.text} />
        </span>
        {capture.promotedTo !== null ? (
          <span className="chip" title="Promoted to a task">
            → {capture.promotedTo}
          </span>
        ) : (
          !open && (
            <button type="button" className="act today__ghost" disabled={projects.length === 0} onClick={openForm}>
              Promote to task
            </button>
          )
        )}
      </div>
      {open && (
        <div className="today__promote">
          <ProjectSelect projects={projects} value={chosen} label="Project for the new task" onChange={setProjectId} />
          <label className="today__check">
            <input type="checkbox" checked={schedule} onChange={(event) => setSchedule(event.target.checked)} />
            Schedule for {isToday ? "today" : "this day"}
          </label>
          <button type="button" className="act act--focus" disabled={busy} onClick={() => void submit()}>
            {busy ? "Promoting…" : "Promote"}
          </button>
          <button type="button" className="act" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
          {error !== null && (
            <span className="error small" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function CarriedStrip({
  entries,
  date,
  isToday,
  busyIds,
  onBring,
  onTomorrow,
  onDrop,
  onBringAll,
  onOpen,
}: {
  entries: TodayEntry[];
  date: string;
  isToday: boolean;
  busyIds: ReadonlySet<string>;
  onBring: (task: BoardTask) => void;
  onTomorrow: (task: BoardTask) => void;
  onDrop: (task: BoardTask) => void;
  onBringAll: () => void;
  onOpen: (task: BoardTask) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="today__carried" aria-label="Carried over">
      <header className="today__section-head">
        <h3>
          Carried over <span className="today__count">{entries.length}</span>
        </h3>
        <button type="button" className="act" onClick={onBringAll} disabled={entries.some((entry) => busyIds.has(entry.task.id))}>
          Bring all
        </button>
      </header>
      <ul className="today__list">
        {entries.map((entry) => {
          const busy = busyIds.has(entry.task.id);
          const from = formatDayMonth(entry.task.scheduled ?? null);
          return (
            <li key={entry.task.id} className={`today__row today__carried-row ${busy ? "today__row--busy" : ""}`}>
              <div className="today__carried-main">
                <span className="today__carried-project">{entry.project.title}</span>
                <span className="today__carried-line">
                  {entry.task.status === "doing" && <span className="statusmark statusmark--doing" role="img" aria-label="In progress" title="In progress" />}
                  <button type="button" className="linklike today__carried-title" onClick={() => onOpen(entry.task)}>
                    <InlineText text={entry.task.title} />
                  </button>
                </span>
              </div>
              {from !== "" && (
                <span className="chip" title={`Scheduled for ${entry.task.scheduled}`}>
                  {from}
                </span>
              )}
              <span className="today__actions">
                <button type="button" className="act" disabled={busy} title={`Schedule for ${date}`} onClick={() => onBring(entry.task)}>
                  {isToday ? "Bring to today" : "Bring here"}
                </button>
                <button type="button" className="act" disabled={busy} onClick={() => onTomorrow(entry.task)}>
                  Tomorrow
                </button>
                <button type="button" className="act" disabled={busy} title="Remove the schedule; the task stays in its project" onClick={() => onDrop(entry.task)}>
                  Drop
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface DrawerHostProps {
  board: BoardPayload;
  task: BoardTask;
  settings: DelegationSettings | null;
  workspaces: WorkspaceRecord[];
  date: string;
  focusIds: ReadonlySet<string>;
  hold: MutableRefObject<boolean>;
  refresh: () => Promise<BoardPayload | null>;
  onFollow: (id: string | null) => void;
  onClose: () => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
  onDelegated: (taskId: string, title: string) => void;
}

type Picker = { kind: "parent" | "project"; taskId: string };

function TaskDrawerHost({ board, task, settings, workspaces, date, focusIds, hold, refresh, onFollow, onClose, onNotice, onError, onDelegated }: DrawerHostProps) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [organizing, setOrganizing] = useState(false);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [creating, setCreating] = useState<{ parent: BoardTask } | null>(null);
  const [delegating, setDelegating] = useState<BoardTask | null>(null);
  const [delegateNotice, setDelegateNotice] = useState<string | null>(null);
  const [delegateMissing, setDelegateMissing] = useState(false);
  const allTasks = board.tasks;
  const projects = board.projects;
  const levels = settings?.tasks.priorityLevels;
  const pickerTask = picker === null ? null : findBoardTask(allTasks, picker.taskId);
  const project = projects.find((item) => item.id === task.projectId) ?? null;
  const breadcrumbs = useMemo(() => new Map(projects.map((item) => [item.id, item.title])), [projects]);

  useEffect(() => {
    if (picker !== null && pickerTask === null) setPicker(null);
  }, [picker, pickerTask]);

  const markPending = (id: string, on: boolean) =>
    setPending((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const handleConflict = async () => {
    onError("This task changed on disk, so the board was refreshed. Try again.");
    await refresh();
  };

  const write = async (target: BoardTask, change: BoardChange) => {
    markPending(target.id, true);
    hold.current = true;
    try {
      const result = await patchBoardItem(targetOfTask(target), change);
      if (result.recurred === true) onNotice(recurrenceNotice(result.task));
      const fresh = await refresh();
      if (fresh) onFollow(findTaskAfterRefetch(fresh.tasks, result.task)?.id ?? null);
    } catch (err) {
      if (err instanceof BoardConflictError) await handleConflict();
      else onError(messageOf(err, "could not update the task"));
    } finally {
      hold.current = false;
      markPending(target.id, false);
    }
  };

  const runNote = async (target: BoardTask, action: () => Promise<unknown>): Promise<boolean> => {
    markPending(target.id, true);
    try {
      await action();
      await refresh();
      return true;
    } catch (err) {
      if (err instanceof BoardConflictError) await handleConflict();
      else onError(messageOf(err, "could not update the note"));
      return false;
    } finally {
      markPending(target.id, false);
    }
  };

  const noteActions: BoardNoteActions = {
    onAdd: (owner, text) => {
      const problem = validateNoteText(text);
      if (problem !== null) {
        onError(problem);
        return Promise.resolve(false);
      }
      return runNote(owner, () => addBoardNote(targetOfTask(owner), text.trim()));
    },
    onEdit: (owner, note, text) => {
      const problem = validateNoteText(text);
      if (problem !== null) onError(problem);
      else void runNote(owner, () => editBoardNote({ projectId: owner.projectId, line: note.line, raw: note.raw }, text.trim()));
    },
    onDelete: (owner, note) => {
      void runNote(owner, () => deleteBoardNote({ projectId: owner.projectId, line: note.line, raw: note.raw }));
    },
  };

  const runOrganize = async (target: BoardTask, action: () => Promise<{ task: BoardTask }>, notice?: string): Promise<void> => {
    setOrganizing(true);
    hold.current = true;
    try {
      const result = await action();
      const fresh = await refresh();
      if (fresh) {
        const found = findTaskAfterRefetch(fresh.tasks, organizeFocus(task, target, result.task));
        onFollow(found ? found.id : null);
        if (!found) onError("The change was saved, but the task could not be found again");
      }
      if (notice) onNotice(notice);
    } catch (err) {
      if (err instanceof BoardConflictError) await handleConflict();
      else onError(messageOf(err, "could not organize the task"));
    } finally {
      hold.current = false;
      setOrganizing(false);
      setPicker(null);
    }
  };

  const organize: BoardOrganizeActions = {
    onMove: (target, direction) => void runOrganize(target, () => moveBoardItem(targetOfTask(target), direction)),
    onMoveNote: (owner, note, direction) => void runOrganize(owner, () => moveBoardItem({ projectId: owner.projectId, line: note.line, raw: note.raw }, direction)),
    onPromote: (target) => void runOrganize(target, () => reparentBoardTask(targetOfTask(target), null), `Promoted "${target.title}" to a task`),
    onMakeSubtask: (target) => setPicker({ kind: "parent", taskId: target.id }),
    onMoveToProject: (target) => setPicker({ kind: "project", taskId: target.id }),
  };

  const todayControls: BoardTodayControls = {
    isLinked: (id) => focusIds.has(id),
    isOutOfSync: () => false,
    dailyState: () => null,
    addState: { visible: true, allowed: true, hint: `Schedule for ${date}` },
    onAdd: (target) => void scheduleHere(target),
  };

  const scheduleHere = async (target: BoardTask) => {
    markPending(target.id, true);
    try {
      await scheduleTask(date, { ...targetOfTask(target), date });
      await refresh();
    } catch (err) {
      onError(messageOf(err, "could not schedule the task"));
    } finally {
      markPending(target.id, false);
    }
  };

  const openInEditor = (item: BoardProject) => {
    openBoardProjectInEditor(item.id)
      .then((outcome) => {
        if (!outcome.ok) onError(`Could not open the editor: ${outcome.error ?? outcome.command}`);
      })
      .catch((err: unknown) => onError(`Could not open the editor: ${messageOf(err)}`));
  };

  const openInObsidian = (item: BoardProject) => {
    openExternal(obsidianUrl(item.path)).catch((err: unknown) => onError(`Could not open Obsidian: ${messageOf(err)}`));
  };

  const submitCreate = async (body: BoardCreateInput) => {
    try {
      await createBoardItem(body);
    } catch (err) {
      if (err instanceof BoardConflictError) await refresh();
      throw err;
    }
    setCreating(null);
    onNotice(`Created "${body.title}"`);
    await refresh();
  };

  const submitDelegate = async (request: BoardDelegateRequest) => {
    if (!delegating) return;
    const target = delegating;
    setDelegateNotice(null);
    try {
      const result = await delegateBoardTask({
        ...targetOfTask(target),
        workspace: request.workspace,
        prompt: request.prompt,
        runner: request.runner,
        ...(request.repo ? { repo: request.repo } : {}),
      });
      setDelegating(null);
      await refresh();
      onDelegated(result.taskId, result.task.title);
      if (result.warning) onError(`Delegated, but ${result.warning}`);
    } catch (err) {
      if (err instanceof BoardConflictError) {
        const fresh = await refresh();
        const rebound = fresh ? findTaskAfterRefetch(fresh.tasks, target) : null;
        if (rebound) setDelegating(rebound);
        setDelegateMissing(rebound === null);
        setDelegateNotice(rebound ? "This task changed on disk - review and send again" : "This task no longer exists on disk - close this dialog and pick another task");
        return;
      }
      throw err;
    }
  };

  const closeDelegate = () => {
    setDelegating(null);
    setDelegateNotice(null);
    setDelegateMissing(false);
  };

  const delegatingProject = delegating ? (projects.find((item) => item.id === delegating.projectId) ?? null) : null;

  return (
    <>
      <BoardDrawer
        task={task}
        tasks={allTasks}
        project={project}
        breadcrumb={breadcrumbs.get(task.projectId) ?? task.projectId}
        pending={pending}
        organizing={organizing}
        suspended={delegating !== null || creating !== null || pickerTask !== null}
        levels={levels}
        inToday={focusIds.has(task.id)}
        todayCheckbox={null}
        addState={todayControls.addState}
        today={todayControls}
        finished={new Set<string>()}
        onSyncDaily={() => undefined}
        onUseDaily={() => undefined}
        noteActions={noteActions}
        organize={organize}
        onStatus={(target, status) => {
          if (target.status !== status) void write(target, { status });
        }}
        onRename={(target, title) => {
          if (target.title !== title) void write(target, { title });
        }}
        onReason={(target, reason) => void write(target, { reason })}
        onPriority={(target, priority) => {
          if (target.priority !== priority) void write(target, { priority });
        }}
        onDates={(target, change) => void write(target, change)}
        onDelegate={(target) => {
          setDelegateNotice(null);
          setDelegateMissing(false);
          setDelegating(target);
        }}
        onAddSubtask={(parent) => setCreating({ parent })}
        onAddToday={(target) => void scheduleHere(target)}
        onOpenObsidian={openInObsidian}
        onOpenEditor={openInEditor}
        onClose={onClose}
      />
      {picker?.kind === "parent" && pickerTask && (
        <BoardParentPickerDialog
          task={pickerTask}
          candidates={parentCandidates(allTasks, pickerTask.projectId, pickerTask)}
          levels={levels}
          busy={organizing}
          onCancel={() => setPicker(null)}
          onSubmit={(parent) =>
            void runOrganize(pickerTask, () => reparentBoardTask(targetOfTask(pickerTask), { line: parent.line, raw: parent.raw }), `Moved "${pickerTask.title}" under "${parent.title}"`)
          }
        />
      )}
      {picker?.kind === "project" && pickerTask && (
        <BoardMoveProjectDialog
          task={pickerTask}
          projects={moveTargetProjects(projects, pickerTask.projectId)}
          tasks={allTasks}
          busy={organizing}
          onCancel={() => setPicker(null)}
          onSubmit={(targetProjectId, parent) =>
            void runOrganize(
              pickerTask,
              () => moveBoardTaskToProject(targetOfTask(pickerTask), targetProjectId, parent ? { line: parent.line, raw: parent.raw } : null),
              `Moved "${pickerTask.title}" to ${breadcrumbs.get(targetProjectId) ?? targetProjectId}`,
            )
          }
        />
      )}
      {creating && (
        <BoardNewTaskDialog
          projects={projects}
          defaultProjectId={creating.parent.projectId}
          parent={creating.parent}
          levels={levels}
          onCancel={() => setCreating(null)}
          onSubmit={submitCreate}
        />
      )}
      {delegating && delegatingProject && (
        <BoardDelegateDialog
          task={delegating}
          project={delegatingProject}
          template={board.delegatePrompt}
          workspaces={workspaces}
          notice={delegateNotice}
          taskMissing={delegateMissing}
          onCancel={closeDelegate}
          onSubmit={submitDelegate}
        />
      )}
    </>
  );
}

export function TodayView({ settings, workspaces, onOpenSession, onOpenTask, subscribeDaily, subscribeBoard, onDelegated, onNotice, onError }: Props) {
  const [date, setDate] = useState(localDay);
  const [tab, setTabState] = useState<Tab>(readTab);
  const [data, setData] = useState<TodayData | null>(null);
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [entryInfo, setEntryInfo] = useState<DailyEntryInfo>({ exists: false, path: null });
  const [quick, setQuick] = useState<QuickAddState>(() => ({ projectId: readStored(QUICK_PROJECT_KEY), text: "", busy: false, error: null }));
  const [quickFocus, setQuickFocus] = useState(0);
  const [collapse, setCollapseState] = useState<FocusCollapse>(() => parseFocusCollapse(readStored(FOCUS_COLLAPSE_KEY)));
  const [creatingNote, setCreatingNote] = useState(false);
  const [forcedDate, setForcedDate] = useState<string | null>(null);
  const [modeSlot, setModeSlot] = useState<HTMLElement | null>(null);
  const [kept, setKept] = useState<string[]>(() => parseDismissedOutOfSync(readStored(KEPT_TASKS_KEY)));
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearUndo, setClearUndo] = useState<ClearUndo | null>(null);
  const narrow = useNarrow();

  const requestRef = useRef(0);
  const boardRef = useRef<BoardPayload | null>(null);
  const holdDrawer = useRef(false);
  const timerRef = useRef<number | null>(null);
  const quickInput = useRef<HTMLInputElement | null>(null);

  const enabled = settings?.features.daily === true;
  const tasksEnabled = settings?.features.tasks === true;
  const today = localDay();
  const isToday = date === today;
  const tomorrow = nextDay(date);
  const projectOrder = settings?.daily.projectOrder ?? [];
  const { sessions: dailySessions } = useDailySessions(enabled, date);

  const setTab = (next: Tab) => {
    setTabState(next);
    if (next !== "backlog") writeStored(TAB_KEY, next);
  };

  const refresh = useCallback(async (): Promise<BoardPayload | null> => {
    const id = requestRef.current + 1;
    requestRef.current = id;
    setRefreshing(true);
    try {
      const [nextToday, nextBoard] = await Promise.all([getToday(date), tasksEnabled ? getTasksBoard() : Promise.resolve(null)]);
      if (id !== requestRef.current) return nextBoard;
      const previous = boardRef.current;
      if (previous && nextBoard && !holdDrawer.current) setDrawerId((current) => (current === null ? null : remapTaskId(previous.tasks, nextBoard.tasks, current)));
      boardRef.current = nextBoard;
      setData(nextToday);
      setBoard(nextBoard);
      setFailure(null);
      return nextBoard;
    } catch (err) {
      if (id === requestRef.current) {
        setFailure({ kind: err instanceof TodayUnavailableError ? "unavailable" : "error", message: messageOf(err, "could not load Today") });
      }
      return null;
    } finally {
      if (id === requestRef.current) setRefreshing(false);
    }
  }, [date, tasksEnabled]);

  useEffect(() => {
    if (!enabled) return;
    setData(null);
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const typing = (): boolean => {
      const active = document.activeElement;
      return active instanceof HTMLInputElement && active.classList.contains("outliner__input");
    };
    const flush = () => {
      timerRef.current = null;
      if (typing()) {
        timerRef.current = window.setTimeout(flush, TYPING_RETRY_MS);
        return;
      }
      void refresh();
    };
    const schedule = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(flush, REFRESH_DELAY_MS);
    };
    const offDaily = subscribeDaily((event) => {
      if (event.recovered || event.date === date) schedule();
    });
    const offBoard = subscribeBoard(schedule);
    return () => {
      offDaily();
      offBoard();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [enabled, date, subscribeDaily, subscribeBoard, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const onRefresh = () => void refresh();
    const onPlan = () => setTab("note");
    const onStart = () => {
      setTab("today");
      setForcedDate(date);
    };
    window.addEventListener("cchub:daily-refresh", onRefresh);
    window.addEventListener("cchub:daily-plan-today", onPlan);
    window.addEventListener(START_DAY_EVENT, onStart);
    return () => {
      window.removeEventListener("cchub:daily-refresh", onRefresh);
      window.removeEventListener("cchub:daily-plan-today", onPlan);
      window.removeEventListener(START_DAY_EVENT, onStart);
    };
  });

  useEffect(() => {
    if (quickFocus > 0) quickInput.current?.focus();
  }, [quickFocus]);

  useEffect(() => {
    if (clearUndo === null) return;
    const timer = window.setTimeout(() => setClearUndo(null), CLEAR_UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [clearUndo]);

  const setCollapse = (next: FocusCollapse) => {
    setCollapseState(next);
    writeStored(FOCUS_COLLAPSE_KEY, serializeFocusCollapse(next));
  };

  const projects = board?.projects ?? [];
  const focus = data?.focus ?? [];
  const carried = data?.carriedOver ?? [];
  const boardTasks = board?.tasks ?? [];
  const noteActions = data !== null && data.focusSource === "scheduled" && tasksEnabled && date >= today;
  const sections = useMemo(() => (data === null ? null : noteSections(data, boardTasks, projects)), [data, boardTasks, projects]);
  const outOfSync = visibleOutOfSync(data?.outOfSync, kept);
  const groups: OutlineGroup[] = useMemo(() => outlineGroupsOf(focus), [focus]);
  const focusIds = useMemo(() => entryTaskIds(focus), [focus]);
  const excluded = useMemo(() => entryTaskIds(carried), [carried]);
  const openTasks = useMemo(() => flattenBoardTasks(boardTasks).filter(isFocusable), [boardTasks]);
  const quickOrder = effectiveProjectOrder(projects, projectOrder);
  const quickProject = projects.some((project) => project.id === quick.projectId) ? quick.projectId : (quickOrder[0] ?? projects[0]?.id ?? "");
  const canAddFromToday = tasksEnabled && board !== null && projects.length > 0;
  const drawerTask = drawerId === null || board === null ? null : findBoardTask(board.tasks, drawerId);

  useEffect(() => {
    if (board && drawerId !== null && drawerTask === null) setDrawerId(null);
  }, [board, drawerId, drawerTask]);

  useEffect(() => {
    if (data === null) return;
    setKept((current) => {
      const next = keepDismissed(current, data.outOfSync);
      if (next.length === current.length) return current;
      writeStored(KEPT_TASKS_KEY, JSON.stringify(next));
      return next;
    });
  }, [data]);

  const keepTask = (item: TodayOutOfSync) =>
    setKept((current) => {
      const next = [...current, outOfSyncKey(item)];
      writeStored(KEPT_TASKS_KEY, JSON.stringify(next));
      return next;
    });

  const applyNote = async (item: TodayOutOfSync, task: BoardTask) => {
    markBusy(task.id, true);
    try {
      await patchBoardItem(targetOfTask(task), { status: item.dailyCheckbox });
    } catch (err) {
      failWith(err, "could not update the task");
    } finally {
      markBusy(task.id, false);
      await refresh();
    }
  };

  const onLinkTick = async (key: string, item: { lineIndex: number; line: string }, target: LinkTarget | null) => {
    markBusy(key, true);
    try {
      await linkTick(date, linkTickInput(item, target));
    } catch (err) {
      failWith(err, target === null ? "could not ignore the line" : "could not link the line");
    } finally {
      markBusy(key, false);
      await refresh();
    }
  };

  const markBusy = (id: string, on: boolean) =>
    setBusyIds((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const withRefresh = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } finally {
      await refresh();
    }
  };

  const failWith = (err: unknown, fallback: string) => {
    if (err instanceof BoardConflictError) onError(CONFLICT_NOTICE);
    else onError(messageOf(err, fallback));
  };

  const scheduleTo = async (task: BoardTask, target: string | null) => {
    markBusy(task.id, true);
    try {
      await scheduleTask(date, { ...targetOfTask(task), date: target });
    } catch (err) {
      failWith(err, "could not schedule the task");
    } finally {
      markBusy(task.id, false);
      await refresh();
    }
  };

  const markDone = async (task: BoardTask) => {
    markBusy(task.id, true);
    try {
      const result = await patchBoardItem(targetOfTask(task), { status: "done" });
      if (result.recurred === true) onNotice(recurrenceNotice(result.task));
    } catch (err) {
      failWith(err, "could not complete the task");
    } finally {
      markBusy(task.id, false);
      await refresh();
    }
  };

  const bringAll = async () => {
    for (const entry of carried) {
      markBusy(entry.task.id, true);
      try {
        await scheduleTask(date, { ...targetOfTask(entry.task), date });
      } catch (err) {
        failWith(err, "could not bring the task");
        markBusy(entry.task.id, false);
        break;
      }
      markBusy(entry.task.id, false);
    }
    await refresh();
  };

  const addToFocus = async (tasks: readonly BoardTask[]) => {
    for (const task of tasks) {
      markBusy(task.id, true);
      try {
        await scheduleTask(date, { ...targetOfTask(task), date });
      } catch (err) {
        failWith(err, "could not add the task to focus");
        markBusy(task.id, false);
        break;
      }
      markBusy(task.id, false);
    }
    await refresh();
  };

  const targetOfNode = (node: OutlineNode): BoardTarget => ({ projectId: node.projectId, line: node.line, raw: node.raw });

  const onRename = (node: OutlineNode, title: string, fields: OutlineFields) =>
    withRefresh(async () => {
      const change: BoardChange = {};
      if (title !== node.title) change.title = title;
      if (fields.priority !== undefined) change.priority = fields.priority;
      if (fields.due !== undefined) change.due = fields.due;
      await patchBoardItem(targetOfNode(node), change);
    });

  const onCreateAfter = (node: OutlineNode, title: string, fields: OutlineFields) =>
    withRefresh(async () => {
      const parent = parentOfTask(boardTasks, node.id);
      const covered = parent !== null && focusIds.has(parent.id);
      const after = insertAnchorOf(boardTasks, node.id);
      await createBoardItem({
        projectId: node.projectId,
        title,
        ...(fields.priority !== undefined && fields.priority !== null ? { priority: fields.priority } : {}),
        ...(fields.due !== undefined && fields.due !== null ? { due: fields.due } : {}),
        ...(covered ? {} : { scheduled: date }),
        ...(parent ? { parentLine: parent.line, parentRaw: parent.raw } : {}),
        ...(after ? { after } : {}),
      });
    });

  const onIndent = (node: OutlineNode) =>
    withRefresh(async () => {
      const previous = previousSibling(groups, node);
      if (previous === null) return;
      await reparentBoardTask(targetOfNode(node), { line: previous.line, raw: previous.raw });
    });

  const onOutdent = (node: OutlineNode) =>
    withRefresh(async () => {
      const parent = parentOfTask(boardTasks, node.id);
      if (parent === null) return;
      const grand = parentOfTask(boardTasks, parent.id);
      const result = await reparentBoardTask(targetOfNode(node), grand ? { line: grand.line, raw: grand.raw } : null);
      if (grand === null || !focusIds.has(grand.id)) await scheduleTask(date, { ...targetOfTask(result.task), date });
    });

  const onMove = (node: OutlineNode, dir: "up" | "down") =>
    withRefresh(async () => {
      if (movesInNote(node)) {
        await reorderFocus(date, { ...targetOfNode(node), direction: dir });
        return;
      }
      const neighbour = dir === "up" ? previousSibling(groups, node) : nextSibling(groups, node);
      const steps = neighbour === null ? 1 : moveSteps(boardTasks, node.id, neighbour.id);
      let current = targetOfNode(node);
      for (let step = 0; step < steps; step += 1) {
        const result = await moveBoardItem(current, dir);
        current = targetOfTask(result.task);
      }
    });

  const onToggleDone = (node: OutlineNode) =>
    withRefresh(async () => {
      const result = await patchBoardItem(targetOfNode(node), { status: node.status === "done" ? "todo" : "done" });
      if (result.recurred === true) onNotice(recurrenceNotice(result.task));
    });

  const onToggleDoing = (node: OutlineNode) =>
    withRefresh(async () => {
      const next = doingTarget(node.status);
      if (next === null) return;
      await patchBoardItem(targetOfNode(node), { status: next });
    });

  const toggleDoing = async (task: BoardTask) => {
    const next = doingTarget(task.status);
    if (next === null) return;
    markBusy(task.id, true);
    try {
      await patchBoardItem(targetOfTask(task), { status: next });
    } catch (err) {
      failWith(err, "could not update the task");
    } finally {
      markBusy(task.id, false);
      await refresh();
    }
  };

  const onAddNote = (node: OutlineNode, text: string) =>
    withRefresh(async () => {
      await addBoardNote(targetOfNode(node), text);
    });

  const onShift = (node: OutlineNode, target: string | null) =>
    withRefresh(async () => {
      const root = rootNodeOf(groups, node);
      await scheduleTask(date, { ...targetOfNode(root), date: target });
    });

  const runClear = async () => {
    setConfirmClear(false);
    try {
      const result = await clearToday(date);
      setClearUndo({ date, token: result.token, text: clearedNotice(result, isToday) });
    } catch (err) {
      failWith(err, "could not clear the day");
    } finally {
      await refresh();
    }
  };

  const runUndoClear = async (undo: ClearUndo) => {
    setClearUndo(null);
    try {
      await undoClearToday(undo.date, undo.token);
    } catch (err) {
      failWith(err, "could not undo the clear");
    } finally {
      await refresh();
    }
  };

  const openNode = (node: OutlineNode) => setDrawerId(node.id);

  const onDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes(TODAY_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropOver(true);
  };

  const onDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setDropOver(false);
  };

  const onDrop = (event: ReactDragEvent<HTMLElement>) => {
    const payload = event.dataTransfer.getData(TODAY_DRAG_MIME);
    setDropOver(false);
    setDragging(false);
    if (payload === "") return;
    event.preventDefault();
    const target = decodeDragTarget(payload);
    if (target === null) return;
    void withRefresh(async () => {
      try {
        await scheduleTask(date, { ...target, date });
      } catch (err) {
        failWith(err, "could not schedule the task");
      }
    });
  };

  const openQuickAdd = () => {
    setTab("today");
    setQuickFocus((current) => current + 1);
  };

  const addFromToday = async (projectId: string, text: string): Promise<void> => {
    const plan = planFocusAdd(boardTasks, projectId, text, today, date, focusIds);
    if (plan === null) throw new Error("Type a task title");
    if (plan.kind === "already") {
      onNotice(`"${plan.task.title}" is already in focus`);
      return;
    }
    try {
      if (plan.kind === "schedule") {
        await scheduleTask(date, { ...targetOfTask(plan.task), date });
        onNotice(`Scheduled the existing task "${plan.task.title}"`);
      } else {
        await createBoardItem({
          projectId: plan.projectId,
          title: plan.input.title,
          scheduled: date,
          ...(plan.input.priority !== undefined ? { priority: plan.input.priority } : {}),
          ...(plan.input.due !== undefined ? { due: plan.input.due } : {}),
        });
      }
    } catch (err) {
      if (err instanceof BoardConflictError) throw new Error(CONFLICT_NOTICE);
      throw err;
    } finally {
      await refresh();
    }
  };

  const submitQuick = async () => {
    if (quick.text.trim() === "" || quickProject === "" || quick.busy) return;
    setQuick((current) => ({ ...current, busy: true, error: null }));
    try {
      await addFromToday(quickProject, quick.text);
      writeStored(QUICK_PROJECT_KEY, quickProject);
      setQuick((current) => ({ ...current, projectId: quickProject, text: "", busy: false }));
      quickInput.current?.focus();
    } catch (err) {
      setQuick((current) => ({ ...current, busy: false, error: messageOf(err, "could not add the task") }));
    }
  };

  const createFromNote = async (item: NoMatchItem, projectId: string): Promise<void> => {
    markBusy(item.key, true);
    try {
      await createBoardItem({ projectId, title: createTitleOf(item), scheduled: date });
      writeStored(QUICK_PROJECT_KEY, projectId);
      onNotice(`Created "${createTitleOf(item)}" for ${isToday ? "today" : date}`);
    } catch (err) {
      failWith(err, "could not create the task");
    } finally {
      markBusy(item.key, false);
      await refresh();
    }
  };

  const linkNoMatch = (item: NoMatchItem, target: LinkTarget | null) => {
    if (item.lineIndex === null) return;
    void onLinkTick(item.key, { lineIndex: item.lineIndex, line: item.line }, target);
  };

  const createNote = async () => {
    setCreatingNote(true);
    try {
      await createTodayNote(date);
      await refresh();
    } catch (err) {
      onError(messageOf(err, "could not create the note"));
    } finally {
      setCreatingNote(false);
    }
  };

  const submitCapture = async (text: string) => {
    await addCapture(date, text);
    await refresh();
  };

  const submitMeeting = async (text: string) => {
    await addMeeting(date, text);
    await refresh();
  };

  const promote = async (capture: TodayCapture, projectId: string, schedule: boolean) => {
    try {
      await promoteCapture(date, { line: capture.line, raw: capture.raw, projectId, schedule });
    } finally {
      await refresh();
    }
  };

  if (!enabled) {
    return (
      <div className="view">
        <p className="hint">Today is off. Turn on Daily in Settings › Plugins to keep a diary entry for each day in your second brain.</p>
      </div>
    );
  }

  const obsidianHref = entryInfo.path !== null ? obsidianUrl(entryInfo.path) : null;

  const openClassicPlanner = () => {
    setTab("note");
    window.dispatchEvent(new CustomEvent("cchub:daily-plan-today"));
  };

  const openRefine = () => {
    setTab("note");
    window.dispatchEvent(new CustomEvent(DAILY_REFINE_EVENT));
  };

  const menuItems: BoardMenuItem[] = [
    {
      id: "start",
      label: "Start the day",
      onSelect: () => {
        setTab("today");
        setForcedDate(date);
      },
    },
    { id: "plan", label: "Classic planner", onSelect: openClassicPlanner },
    { id: "organize", label: "Organize focus", title: "Group the focus items of the note by project", onSelect: () => window.dispatchEvent(new CustomEvent(DAILY_ORGANIZE_EVENT)) },
    {
      id: "refine",
      label: "Refine with assistant",
      disabled: !entryInfo.exists,
      onSelect: openRefine,
    },
    {
      id: "obsidian",
      label: "Open in Obsidian",
      disabled: obsidianHref === null,
      onSelect: () => {
        if (obsidianHref !== null) openExternal(obsidianHref).catch((err: unknown) => onError(`Could not open Obsidian: ${messageOf(err)}`));
      },
    },
    {
      id: "refresh",
      label: "Refresh",
      onSelect: () => {
        void refresh();
        window.dispatchEvent(new CustomEvent("cchub:daily-refresh"));
      },
    },
  ];

  const effectiveTab: Tab = !narrow && tab === "backlog" ? "today" : tab;
  const dailyExists = data?.dailyExists === true;
  const showStart = data !== null && (startPanelAuto(date, today, dailyExists) || forcedDate === date);
  const showMain = effectiveTab === "today";
  const showSide = tasksEnabled && (effectiveTab === "backlog" || (!narrow && effectiveTab === "today"));
  const tabs: { id: Tab; label: string }[] = narrow
    ? [
        { id: "today", label: "Today" },
        { id: "backlog", label: "Backlog" },
        { id: "note", label: "Note" },
      ]
    : [
        { id: "today", label: "Today" },
        { id: "note", label: "Note" },
      ];
  const sessionList = dailySessions;

  return (
    <div className="view view--today">
      <header className="today__head">
        <div className="today__nav">
          <button type="button" className="act" onClick={() => setDate(addDays(date, -1))}>
            ‹ Previous
          </button>
          <button type="button" className="act" disabled={isToday} onClick={() => setDate(today)}>
            Today
          </button>
          <button type="button" className="act" onClick={() => setDate(addDays(date, 1))}>
            Next ›
          </button>
          <input className="in daily__date" type="date" aria-label="Day" value={date} onChange={(event) => event.target.value && setDate(event.target.value)} />
          <span className="today__day muted small">{describeDay(date, today)}</span>
        </div>
        <span className="spacer" />
        {data !== null && !dailyExists && !showStart && (
          <button type="button" className="act act--focus" disabled={creatingNote} onClick={() => void createNote()}>
            {creatingNote ? "Creating…" : isToday ? "Create today's note" : "Create note"}
          </button>
        )}
        {data !== null && dailyExists && (
          <button type="button" className="act act--focus" disabled={!tasksEnabled || board === null} onClick={openQuickAdd}>
            Add task
          </button>
        )}
        <BoardActionsMenu label="More actions" items={menuItems} />
      </header>

      <div className="today__bar">
        <div className="today__tabs" role="tablist" aria-label="Today sections">
          {tabs.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={effectiveTab === item.id} className={`pill ${effectiveTab === item.id ? "pill--on" : ""}`} onClick={() => setTab(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        {effectiveTab === "note" && (
          <>
            <span className="today__sep" role="separator" aria-orientation="vertical" />
            <div className="today__modes" ref={setModeSlot} />
          </>
        )}
      </div>

      {failure !== null && (
        <div className="daily__banner" role="alert">
          <span>{failure.kind === "unavailable" ? "Today needs a newer hub. Update the desktop app or the dev server to pick up the new routes." : failure.message}</span>
          {failure.kind === "error" && (
            <button type="button" className="act" onClick={() => void refresh()}>
              Retry
            </button>
          )}
        </div>
      )}
      {data !== null && data.focusSource === "list" && (
        <p className="hint">Focus follows the list in the note (daily.focusSource is list), so scheduling does not change it.</p>
      )}
      {!tasksEnabled && <p className="hint">Turn on Tasks in Settings › Plugins to schedule project tasks into the day.</p>}

      <div className="today__note" hidden={effectiveTab !== "note"}>
        <DailyView
          settings={settings}
          onOpenSession={onOpenSession}
          onOpenTask={onOpenTask}
          subscribeDaily={subscribeDaily}
          subscribeBoard={subscribeBoard}
          embedded
          modeSlot={modeSlot}
          date={date}
          onEntryChange={setEntryInfo}
        />
      </div>

      {effectiveTab !== "note" && failure === null && data === null && <p className="muted">Loading…</p>}

      {effectiveTab !== "note" && data !== null && (
        <TodayColumns
          split={showMain && showSide}
          main={showMain ? (
            <div className="today__main">
              {showStart ? (
                <StartDayPanel
                  date={date}
                  isToday={isToday}
                  noteExists={dailyExists}
                  data={data}
                  tasks={boardTasks}
                  busyIds={busyIds}
                  onBring={(task) => void scheduleTo(task, date)}
                  onTomorrow={(task) => void scheduleTo(task, tomorrow)}
                  onDrop={(task) => void scheduleTo(task, null)}
                  onBringAll={() => void bringAll()}
                  onOpenTask={(task) => setDrawerId(task.id)}
                  onCreated={async () => {
                    setForcedDate(null);
                    await refresh();
                  }}
                  onRefine={openRefine}
                  onClassic={openClassicPlanner}
                  onClose={() => setForcedDate(null)}
                  onError={onError}
                />
              ) : (
                <CarriedStrip
                  entries={carried}
                  date={date}
                  isToday={isToday}
                  busyIds={busyIds}
                  onBring={(task) => void scheduleTo(task, date)}
                  onTomorrow={(task) => void scheduleTo(task, tomorrow)}
                  onDrop={(task) => void scheduleTo(task, null)}
                  onBringAll={() => void bringAll()}
                  onOpen={(task) => setDrawerId(task.id)}
                />
              )}

              <section
                className={`today__section today__focus ${dragging ? "today__focus--target" : ""} ${dropOver ? "today__focus--over" : ""}`}
                aria-label="Focus"
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
              >
                <header className="today__section-head">
                  <h3>
                    Focus <span className="today__count">{focus.length}</span>
                  </h3>
                  {groups.length > 0 && (
                    <BoardActionsMenu
                      label="Focus actions"
                      items={[
                        { id: "expand", label: "Expand all", disabled: isAllExpanded(collapse, groups), onSelect: () => setCollapse(expandAllFocus(collapse, groups)) },
                        { id: "collapse", label: "Collapse all", disabled: isAllCollapsed(collapse, groups), onSelect: () => setCollapse(collapseAllFocus(collapse, groups)) },
                        {
                          id: "clear",
                          label: isToday ? "Clear today" : "Clear this day",
                          title: "Remove the task lines from the focus of the note and their dates from the projects",
                          disabled: !noteActions || !dailyExists,
                          onSelect: () => setConfirmClear(true),
                        },
                      ]}
                    />
                  )}
                </header>
                {clearUndo !== null && clearUndo.date === date && (
                  <div className="today__undo" role="status">
                    <span className="today__undo-text">{clearUndo.text}</span>
                    <button type="button" className="act" onClick={() => void runUndoClear(clearUndo)}>
                      Undo
                    </button>
                    <button type="button" className="act act--icon" aria-label="Dismiss" onClick={() => setClearUndo(null)}>
                      <IconClose />
                    </button>
                  </div>
                )}
                {canAddFromToday && (
                  <div className="today__quick" role="group" aria-label="Add to focus">
                    <CountedProjectSelect
                      projects={projects}
                      tasks={openTasks}
                      value={quickProject}
                      label="Project for the task to add"
                      onChange={(projectId) => setQuick((current) => ({ ...current, projectId, error: null }))}
                    />
                    <input
                      ref={quickInput}
                      className="in today__quick-input"
                      type="text"
                      value={quick.text}
                      placeholder="Add to focus - reuses an open task with this text, else creates it"
                      aria-label="Add to focus"
                      title="Enter to add - #p1 due:tomorrow work too - Esc to clear"
                      autoComplete="off"
                      spellCheck={false}
                      readOnly={quick.busy}
                      onChange={(event) => setQuick((current) => ({ ...current, text: event.target.value, error: null }))}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void submitQuick();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setQuick((current) => ({ ...current, text: "", error: null }));
                        }
                      }}
                    />
                    {quick.text !== "" && (
                      <button type="button" className="act act--icon" aria-label="Clear" onClick={() => setQuick((current) => ({ ...current, text: "", error: null }))}>
                        <IconClose />
                      </button>
                    )}
                    {quick.error !== null && (
                      <span className="error small today__quick-error" role="alert">
                        {quick.error}
                      </span>
                    )}
                  </div>
                )}
                {groups.length === 0 ? (
                  <p className="today__empty">{showSide ? "Nothing in focus. Add a task or drag one from the backlog." : "Nothing in focus. Add a task."}</p>
                ) : (
                  <FocusOutliner
                    groups={groups}
                    today={today}
                    busy={refreshing}
                    onRename={onRename}
                    onCreateAfter={onCreateAfter}
                    onIndent={onIndent}
                    onOutdent={onOutdent}
                    onMove={onMove}
                    onToggleDone={onToggleDone}
                    onToggleDoing={onToggleDoing}
                    onAddNote={onAddNote}
                    onOpen={openNode}
                    onTomorrow={(node) => onShift(node, tomorrow)}
                    onUnschedule={(node) => onShift(node, null)}
                    collapse={collapse}
                    onCollapseChange={setCollapse}
                    onAddToProject={canAddFromToday ? addFromToday : undefined}
                  />
                )}
              </section>

              {outOfSync.length > 0 && (
                <section className="today__section" aria-label="Changed in the note">
                  <header className="today__section-head">
                    <h3>Changed in the note - check status</h3>
                  </header>
                  <ul className="today__plain">
                    {outOfSync.map((item) => {
                      const task = taskOfOutOfSync(boardTasks, item);
                      const busy = task !== null && busyIds.has(task.id);
                      const recurring = item.reason === "recurring-done";
                      return (
                        <li key={outOfSyncKey(item)} className="today__row">
                          <span className="today__text">
                            <InlineText text={lineContent(item.line)} />{" "}
                            <span className="muted small">
                              {recurring
                                ? `Recurring task "${item.taskTitle}" was already completed today; reopen it from Tasks if needed.`
                                : `Task "${item.taskTitle}" is ${item.projectStatus}, the note says ${item.dailyCheckbox}.`}
                            </span>
                          </span>
                          <span className="today__actions">
                            <button
                              type="button"
                              className="act"
                              disabled={task === null || busy || recurring}
                              onClick={() => {
                                if (task) void applyNote(item, task);
                              }}
                            >
                              Use note
                            </button>
                            <button type="button" className="act" disabled={busy} onClick={() => keepTask(item)}>
                              Keep task
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {sections !== null && (sections.noMatch.length > 0 || sections.ambiguous.length > 0) && (
                <NoMatchSection
                  items={sections.noMatch}
                  leftovers={sections.ambiguous}
                  tasks={boardTasks}
                  openTasks={openTasks}
                  projects={projects}
                  busyKeys={busyIds}
                  actions={noteActions}
                  onLink={linkNoMatch}
                  onCreate={createFromNote}
                />
              )}

              {sections !== null && sections.linked.length > 0 && (
                <AlsoInNote items={sections.linked} projects={projects} date={date} actions={noteActions} busyIds={busyIds} onAdd={(tasks) => void addToFocus(tasks)} />
              )}

              {dailyExists ? (
                <>
                  <section className="today__section" aria-label="Meetings">
                    <header className="today__section-head">
                      <h3>Meetings</h3>
                    </header>
                    {data.meetings.length > 0 && (
                      <ul className="today__plain">
                        {data.meetings.map((meeting, index) => (
                          <li key={`${index}:${meeting}`} className="today__text">
                            <InlineText text={meeting} />
                          </li>
                        ))}
                      </ul>
                    )}
                    <InlineAdd placeholder="Add meeting - Enter to save" label="Add meeting" onSubmit={submitMeeting} />
                  </section>
                  <section className="today__section" aria-label="Captures">
                    <header className="today__section-head">
                      <h3>Captures</h3>
                    </header>
                    {data.captures.length > 0 && (
                      <ul className="today__plain">
                        {data.captures.map((capture) => (
                          <CaptureItem key={`${capture.line}:${capture.raw}`} capture={capture} projects={projects} isToday={isToday} onPromote={promote} />
                        ))}
                      </ul>
                    )}
                    <InlineAdd placeholder="Capture a thought - Enter to save" label="Add capture" onSubmit={submitCapture} />
                  </section>
                </>
              ) : (
                !showStart && <p className="today__empty">No note for this day yet. Create it to add meetings and captures.</p>
              )}

              {data.summary !== null && data.summary.trim() !== "" && (
                <details className="today__disclosure">
                  <summary>Summary</summary>
                  <Markdown text={data.summary} />
                </details>
              )}

              <details className="today__disclosure">
                <summary>Sessions today ({sessionList.length})</summary>
                {sessionList.length === 0 && <p className="muted small">none yet</p>}
                {sessionList.length > 0 && (
                  <ul className="plainlist">
                    {sessionList.map((session) => {
                      const title = session.title ?? session.sessionId.slice(0, 8);
                      return (
                        <li key={session.sessionId} className="daily__session-row">
                          <button type="button" className="linklike daily__session-title" title={title} onClick={() => onOpenSession(session.sessionId)}>
                            {title}
                          </button>
                          <span className="daily__session-chips">
                            {session.client && <span className="chip">{session.client}</span>}
                            <span className="chip">{session.status}</span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </details>
            </div>
          ) : null}
          side={showSide ? (
            <aside className="today__side">
              <BacklogPanel
                tasks={boardTasks}
                projects={projects}
                projectOrder={projectOrder}
                excluded={excluded}
                inToday={focusIds}
                levels={settings?.tasks.priorityLevels}
                date={date}
                nextDate={tomorrow}
                today={today}
                busyIds={busyIds}
                onSchedule={(task, target) => void scheduleTo(task, target)}
                onDone={(task) => void markDone(task)}
                onDoing={(task) => void toggleDoing(task)}
                onOpen={(task) => setDrawerId(task.id)}
                onDragActive={(active) => {
                  setDragging(active);
                  if (!active) setDropOver(false);
                }}
              />
            </aside>
          ) : null}
        />
      )}

      {confirmClear && (
        <ConfirmDialog
          title={isToday ? "Clear today?" : "Clear this day?"}
          body={`Removes the ${focus.length === 1 ? "task line" : `${focus.length} task lines`} from the focus of the note, with the notes under them, and takes their ⏳ ${date} out of the projects. Free lines stay. You can undo right after.`}
          confirmLabel="Clear"
          danger
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => void runClear()}
        />
      )}

      {drawerTask && board && (
        <TaskDrawerHost
          board={board}
          task={drawerTask}
          settings={settings}
          workspaces={workspaces}
          date={date}
          focusIds={focusIds}
          hold={holdDrawer}
          refresh={refresh}
          onFollow={setDrawerId}
          onClose={() => setDrawerId(null)}
          onNotice={onNotice}
          onError={onError}
          onDelegated={onDelegated}
        />
      )}
    </div>
  );
}
