import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import "../outliner.css";
import { BOARD_STATUS_LABEL, dueTone, formatDayMonth } from "../board-model";
import {
  EXPANDED,
  focusGroupCounts,
  hasHiddenContent,
  headerKeyAction,
  hiddenSummary,
  isProjectCollapsed,
  isTaskCollapsed,
  rowCollapseKey,
  setProjectCollapsed,
  setTaskCollapsed,
  visibleFocusGroups,
  type FocusCollapse,
} from "../focus-collapse";
import { IconChevron, IconMore } from "../icons";
import { InlineText } from "../markdown";
import {
  canIndent,
  canMove,
  canOutdent,
  checkState,
  doingTarget,
  findNode,
  flattenNodes,
  flattenVisible,
  keyIntent,
  nextNode,
  parseInlineTokens,
  previousSibling,
  prevNode,
  subtreeEnd,
  type OutlineGroup,
  type OutlineIntent,
  type OutlineNode,
} from "../outliner-model";

export interface OutlineFields {
  priority?: number | null;
  due?: string | null;
}

export interface FocusOutlinerProps {
  groups: OutlineGroup[];
  today: string;
  busy?: boolean;
  onRename: (node: OutlineNode, title: string, fields: OutlineFields) => Promise<void>;
  onCreateAfter: (node: OutlineNode, title: string, fields: OutlineFields) => Promise<void>;
  onIndent: (node: OutlineNode) => Promise<void>;
  onOutdent: (node: OutlineNode) => Promise<void>;
  onMove: (node: OutlineNode, dir: "up" | "down") => Promise<void>;
  onToggleDone: (node: OutlineNode) => Promise<void>;
  onToggleDoing?: (node: OutlineNode) => Promise<void>;
  onAddNote: (node: OutlineNode, text: string) => Promise<void>;
  onOpen: (node: OutlineNode) => void;
  onTomorrow: (node: OutlineNode) => Promise<void>;
  onUnschedule: (node: OutlineNode) => Promise<void>;
  collapse?: FocusCollapse;
  onCollapseChange?: (next: FocusCollapse) => void;
  onAddToProject?: (projectId: string, text: string) => Promise<void>;
  subtaskPlan?: (node: OutlineNode) => { open: number; hidden: number } | null;
  onPlanSubtasks?: (node: OutlineNode) => void;
}

interface AddState {
  projectId: string;
  text: string;
}

interface EditState {
  id: string;
  text: string;
}

interface DraftState {
  anchorId: string;
  text: string;
  known: string[];
  created: boolean;
}

interface NoteState {
  id: string;
  text: string;
}

interface MenuAction {
  key: string;
  label: string;
  intent: OutlineIntent;
  disabled: boolean;
}

const DRAFT_ERROR_KEY = "draft";

const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

const messageOf = (error: unknown): string => (error instanceof Error && error.message !== "" ? error.message : "Something went wrong");

const priorityTone = (priority: number): number => Math.min(priority, 3);

function AutoInput({
  value,
  placeholder,
  label,
  focusKey,
  readOnly,
  onChange,
  onKeyDown,
  onBlur,
}: {
  value: string;
  placeholder: string;
  label: string;
  focusKey: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const input = ref.current;
    if (input === null) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [focusKey]);
  return (
    <input
      ref={ref}
      className="outliner__input"
      type="text"
      value={value}
      placeholder={placeholder}
      aria-label={label}
      readOnly={readOnly}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  );
}

export function FocusOutliner({
  groups,
  today,
  busy = false,
  onRename,
  onCreateAfter,
  onIndent,
  onOutdent,
  onMove,
  onToggleDone,
  onToggleDoing,
  onAddNote,
  onOpen,
  onTomorrow,
  onUnschedule,
  collapse = EXPANDED,
  onCollapseChange,
  onAddToProject,
  subtaskPlan,
  onPlanSubtasks,
}: FocusOutlinerProps) {
  const shown = useMemo(() => visibleFocusGroups(groups, collapse), [groups, collapse]);
  const flat = useMemo(() => flattenVisible(shown), [shown]);
  const originals = useMemo(() => new Map(flattenVisible(groups).map((node) => [node.id, node])), [groups]);
  const [adding, setAdding] = useState<AddState | null>(null);
  const headerRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [editing, setEditingState] = useState<EditState | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [noteDraft, setNoteDraft] = useState<NoteState | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [, setTick] = useState(0);

  const rowRefs = useRef(new Map<string, HTMLElement>());
  const pendingFocus = useRef<string | null>(null);
  const lastIndex = useRef(0);
  const editingRef = useRef<EditState | null>(null);
  const inFlight = useRef(new Set<string>());
  const committing = useRef(false);

  const activeId = flat.some((node) => node.id === focusedId) ? focusedId : (flat[Math.min(lastIndex.current, flat.length - 1)]?.id ?? null);

  const setEditing = (next: EditState | null) => {
    editingRef.current = next;
    setEditingState(next);
  };

  useEffect(() => {
    const index = flat.findIndex((node) => node.id === activeId);
    if (index !== -1) lastIndex.current = index;
  });

  useEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    pendingFocus.current = null;
    const element = rowRefs.current.get(id);
    if (element !== undefined && document.activeElement !== element && editingRef.current === null) element.focus();
  });

  useEffect(() => {
    if (draft === null) return;
    if (!flat.some((node) => node.id === draft.anchorId)) {
      setDraft(null);
      return;
    }
    if (!draft.created) return;
    const known = new Set(draft.known);
    const added = flat.filter((node) => !known.has(node.id));
    if (added.length === 0) return;
    const anchor = findNode(groups, draft.anchorId);
    const created = added.find((node) => anchor !== null && node.projectId === anchor.projectId && node.depth === anchor.depth) ?? added[0];
    if (created === undefined) return;
    setDraft((current) => (current !== null && current.created ? { ...current, anchorId: created.id, known: flat.map((node) => node.id), created: false } : current));
  }, [flat, groups, draft]);

  useEffect(() => {
    if (menuId === null) return;
    const first = rowRefs.current.get(menuId)?.querySelector<HTMLButtonElement>(".outliner__menu button:not(:disabled)");
    first?.focus();
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".outliner__menu, .outliner__more") !== null) return;
      setMenuId(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuId]);

  const focusRow = (id: string) => {
    setFocusedId(id);
    pendingFocus.current = id;
    const element = rowRefs.current.get(id);
    if (element !== undefined && editingRef.current === null) element.focus();
    setTick((value) => value + 1);
  };

  const run = async (id: string, action: () => Promise<void>): Promise<boolean> => {
    if (inFlight.current.has(id)) return false;
    inFlight.current.add(id);
    setBusyIds((previous) => ({ ...previous, [id]: true }));
    setErrors((previous) => without(previous, id));
    try {
      await action();
      return true;
    } catch (error) {
      setErrors((previous) => ({ ...previous, [id]: messageOf(error) }));
      return false;
    } finally {
      inFlight.current.delete(id);
      setBusyIds((previous) => without(previous, id));
    }
  };

  const fullOf = (node: OutlineNode): OutlineNode => originals.get(node.id) ?? node;

  const setTaskOpen = (node: OutlineNode, open: boolean) => {
    const full = fullOf(node);
    if (!hasHiddenContent(full) || isTaskCollapsed(collapse, full) === !open) return;
    onCollapseChange?.(setTaskCollapsed(collapse, full, !open));
  };

  const setProjectOpen = (projectId: string, open: boolean) => {
    if (isProjectCollapsed(collapse, projectId) === !open) return;
    onCollapseChange?.(setProjectCollapsed(collapse, projectId, !open));
  };

  const openAdd = (projectId: string) => {
    setProjectOpen(projectId, true);
    setEditing(null);
    setDraft(null);
    setErrors((previous) => without(previous, `add:${projectId}`));
    setAdding({ projectId, text: "" });
  };

  const closeAdd = (projectId: string) => {
    setAdding(null);
    setErrors((previous) => without(previous, `add:${projectId}`));
    headerRefs.current.get(projectId)?.focus();
  };

  const submitAdd = async (current: AddState) => {
    if (onAddToProject === undefined) return;
    const text = current.text.trim();
    if (text === "") {
      closeAdd(current.projectId);
      return;
    }
    const ok = await run(`add:${current.projectId}`, () => onAddToProject(current.projectId, text));
    if (ok) setAdding((latest) => (latest !== null && latest.projectId === current.projectId ? { ...latest, text: "" } : latest));
  };

  const onAddKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>, current: AddState) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void submitAdd(current);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeAdd(current.projectId);
    }
  };

  const onHeaderKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, group: OutlineGroup) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const action = headerKeyAction(event.key);
    if (action === null || action === "toggle") return;
    event.preventDefault();
    if (action === "collapse") setProjectOpen(group.project.id, false);
    else if (action === "expand") setProjectOpen(group.project.id, true);
    else {
      const first = shown.find((item) => item.project.id === group.project.id)?.items[0];
      if (first !== undefined) focusRow(first.id);
    }
  };

  const startEdit = (node: OutlineNode) => {
    setMenuId(null);
    setConfirmId(null);
    setNoteDraft(null);
    setFocusedId(node.id);
    setEditing({ id: node.id, text: node.title });
  };

  const cancelEdit = (node: OutlineNode) => {
    setEditing(null);
    setErrors((previous) => without(previous, node.id));
    focusRow(node.id);
  };

  const commitEdit = async (node: OutlineNode, keepEditing: boolean): Promise<boolean> => {
    const current = editingRef.current;
    if (current === null || current.id !== node.id) return true;
    if (committing.current) return false;
    const parsed = parseInlineTokens(current.text, today);
    if (parsed.title === "") {
      setErrors((previous) => ({ ...previous, [node.id]: "Title cannot be empty" }));
      return false;
    }
    const fields: OutlineFields = {};
    if (parsed.priority !== undefined && parsed.priority !== node.priority) fields.priority = parsed.priority;
    if (parsed.due !== undefined && parsed.due !== node.due) fields.due = parsed.due;
    const changed = parsed.title !== node.title || Object.keys(fields).length > 0;
    if (changed) {
      committing.current = true;
      const ok = await run(node.id, () => onRename(node, parsed.title, fields));
      committing.current = false;
      if (!ok) return false;
    }
    if (keepEditing) setEditing({ id: node.id, text: parsed.title });
    else setEditing(null);
    return true;
  };

  const openDraft = (node: OutlineNode) => {
    setEditing(null);
    setDraft({ anchorId: node.id, text: "", known: flat.map((item) => item.id), created: false });
  };

  const openNote = (node: OutlineNode) => {
    setEditing(null);
    setConfirmId(null);
    setNoteDraft({ id: node.id, text: "" });
    setFocusedId(node.id);
  };

  const perform = async (intent: OutlineIntent, node: OutlineNode, fromEdit: boolean): Promise<void> => {
    switch (intent) {
      case "next": {
        const target = nextNode(shown, node.id);
        if (target !== null) focusRow(target.id);
        return;
      }
      case "prev": {
        const target = prevNode(shown, node.id);
        if (target !== null) focusRow(target.id);
        else headerRefs.current.get(node.projectId)?.focus();
        return;
      }
      case "edit":
        startEdit(node);
        return;
      case "cancel":
        cancelEdit(node);
        return;
      case "open":
        onOpen(node);
        return;
      case "unschedule":
        setMenuId(null);
        setConfirmId(node.id);
        focusRow(node.id);
        return;
      case "save":
        if (await commitEdit(node, false)) focusRow(node.id);
        return;
      case "save-and-new":
        if (await commitEdit(node, false)) openDraft(node);
        return;
      case "add-note":
        if (!fromEdit || (await commitEdit(node, false))) {
          setTaskOpen(node, true);
          openNote(node);
        }
        return;
      case "toggle-done":
        if (fromEdit && !(await commitEdit(node, false))) return;
        await run(node.id, () => onToggleDone(node));
        focusRow(node.id);
        return;
      case "toggle-doing":
        setMenuId(null);
        if (onToggleDoing !== undefined && doingTarget(node.status) !== null) await run(node.id, () => onToggleDoing(node));
        focusRow(node.id);
        return;
      case "tomorrow":
        setMenuId(null);
        await run(node.id, () => onTomorrow(node));
        return;
      case "indent":
      case "outdent":
      case "move-up":
      case "move-down": {
        if (intent === "indent" && !canIndent(groups, node)) return;
        if (intent === "outdent" && !canOutdent(node)) return;
        if (intent === "move-up" && !canMove(groups, node, "up")) return;
        if (intent === "move-down" && !canMove(groups, node, "down")) return;
        setMenuId(null);
        if (fromEdit && !(await commitEdit(node, true))) return;
        if (intent === "indent") {
          const parent = previousSibling(groups, node);
          if (parent !== null) setTaskOpen(parent, true);
        }
        const action =
          intent === "indent"
            ? () => onIndent(node)
            : intent === "outdent"
              ? () => onOutdent(node)
              : () => onMove(node, intent === "move-up" ? "up" : "down");
        await run(node.id, action);
        if (!fromEdit) focusRow(node.id);
        return;
      }
    }
  };

  const confirmUnschedule = async (node: OutlineNode) => {
    setConfirmId(null);
    await run(node.id, () => onUnschedule(node));
    focusRow(node.id);
  };

  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLElement>, node: OutlineNode) => {
    if (event.target !== event.currentTarget) return;
    if (confirmId === node.id) {
      if (event.key === "Enter") {
        event.preventDefault();
        void confirmUnschedule(node);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setConfirmId(null);
      }
      return;
    }
    if (event.key === "Escape" && menuId === node.id) {
      setMenuId(null);
      return;
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const full = fullOf(node);
      const toggle = rowCollapseKey(event.key, isTaskCollapsed(collapse, full), hasHiddenContent(full));
      if (toggle !== null) {
        event.preventDefault();
        setTaskOpen(node, toggle === "expand");
        return;
      }
    }
    const intent = keyIntent(event, "view");
    if (intent === null) return;
    if (intent === "indent" && !canIndent(groups, node)) return;
    if (intent === "outdent" && !canOutdent(node)) return;
    if (intent === "toggle-doing" && (onToggleDoing === undefined || doingTarget(node.status) === null)) return;
    event.preventDefault();
    void perform(intent, node, false);
  };

  const onEditKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>, node: OutlineNode) => {
    if (event.nativeEvent.isComposing) return;
    const intent = keyIntent(event, "edit");
    if (intent === null) return;
    event.preventDefault();
    void perform(intent, node, true);
  };

  const submitDraft = async (anchor: OutlineNode, current: DraftState) => {
    if (current.text.trim() === "") {
      setDraft(null);
      focusRow(anchor.id);
      return;
    }
    const parsed = parseInlineTokens(current.text, today);
    if (parsed.title === "") {
      setErrors((previous) => ({ ...previous, [DRAFT_ERROR_KEY]: "Title cannot be empty" }));
      return;
    }
    const fields: OutlineFields = {};
    if (parsed.priority !== undefined) fields.priority = parsed.priority;
    if (parsed.due !== undefined) fields.due = parsed.due;
    const ok = await run(DRAFT_ERROR_KEY, () => onCreateAfter(anchor, parsed.title, fields));
    if (ok) setDraft((latest) => (latest === null ? latest : { ...latest, text: "", created: true }));
  };

  const onDraftKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>, anchor: OutlineNode, current: DraftState) => {
    if (event.nativeEvent.isComposing) return;
    const intent = keyIntent(event, "edit");
    if (intent === null) return;
    event.preventDefault();
    if (intent === "save-and-new" || intent === "save") void submitDraft(anchor, current);
    else if (intent === "cancel") {
      setErrors((previous) => without(previous, DRAFT_ERROR_KEY));
      setDraft(null);
      focusRow(anchor.id);
    }
  };

  const submitNote = async (node: OutlineNode, current: NoteState) => {
    const text = current.text.trim();
    if (text === "") {
      setNoteDraft(null);
      focusRow(node.id);
      return;
    }
    const ok = await run(node.id, () => onAddNote(node, text));
    if (ok) {
      setNoteDraft(null);
      focusRow(node.id);
    }
  };

  const onNoteKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>, node: OutlineNode, current: NoteState) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void submitNote(node, current);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setNoteDraft(null);
      setErrors((previous) => without(previous, node.id));
      focusRow(node.id);
    }
  };

  const menuActions = (node: OutlineNode): MenuAction[] => [
    ...(onToggleDoing === undefined
      ? []
      : [
          {
            key: "toggle-doing",
            label: node.status === "doing" ? "Back to to-do" : "Start",
            intent: "toggle-doing" as const,
            disabled: doingTarget(node.status) === null,
          },
        ]),
    { key: "tomorrow", label: "Tomorrow", intent: "tomorrow", disabled: false },
    { key: "unschedule", label: "Remove from today", intent: "unschedule", disabled: false },
    { key: "add-note", label: "Add note", intent: "add-note", disabled: false },
    { key: "indent", label: "Indent", intent: "indent", disabled: !canIndent(groups, node) },
    { key: "outdent", label: "Outdent", intent: "outdent", disabled: !canOutdent(node) },
    { key: "move-up", label: "Move up", intent: "move-up", disabled: !canMove(groups, node, "up") },
    { key: "move-down", label: "Move down", intent: "move-down", disabled: !canMove(groups, node, "down") },
    { key: "open", label: "Open", intent: "open", disabled: false },
  ];

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, node: OutlineNode) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMenuId(null);
      focusRow(node.id);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    if (items.length === 0) return;
    const index = items.findIndex((item) => item === document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  };

  const renderChips = (node: OutlineNode): ReactNode => {
    const tone = dueTone(node.due, node.status, today);
    const showStatus = node.status !== "todo" && node.status !== "done";
    return (
      <span className="outliner__meta">
        <span className="outliner__chips">
          {node.priority !== null && (
            <span className={`chip board-prio board-prio--${priorityTone(node.priority)}`} title={`Priority P${node.priority}`}>
              P{node.priority}
            </span>
          )}
          {node.due !== null && tone !== null && (
            <span className={`chip board-due board-due--${tone}`} title={`Due ${node.due}`}>
              {formatDayMonth(node.due)}
            </span>
          )}
        </span>
        <span className="outliner__status">{showStatus && <span className={`tag tag--board-${node.status}`}>{BOARD_STATUS_LABEL[node.status]}</span>}</span>
      </span>
    );
  };

  const renderRow = (node: OutlineNode): ReactNode => {
    const active = node.id === activeId;
    const isEditing = editing !== null && editing.id === node.id;
    const rowBusy = busyIds[node.id] === true;
    const error = errors[node.id];
    const note = noteDraft !== null && noteDraft.id === node.id ? noteDraft : null;
    const done = node.status === "done";
    const state = checkState(node.status);
    const checkLabel = done ? `Reopen ${node.title}` : state === "mixed" ? `Complete ${node.title} (in progress)` : `Complete ${node.title}`;
    const plan = onPlanSubtasks === undefined || subtaskPlan === undefined ? null : subtaskPlan(node);
    const full = fullOf(node);
    const expandable = hasHiddenContent(full);
    const collapsed = expandable && isTaskCollapsed(collapse, full);
    return (
      <div
        key={node.id}
        ref={(element) => {
          if (element === null) rowRefs.current.delete(node.id);
          else rowRefs.current.set(node.id, element);
        }}
        role="treeitem"
        tabIndex={active ? 0 : -1}
        aria-level={node.depth + 1}
        aria-selected={active}
        aria-expanded={expandable ? !collapsed : undefined}
        aria-busy={rowBusy}
        className={`outliner__row ${active ? "outliner__row--active" : ""} ${rowBusy ? "outliner__row--busy" : ""} ${done ? "outliner__row--done" : ""}`}
        style={{ ["--depth" as string]: node.depth }}
        onKeyDown={(event) => onRowKeyDown(event, node)}
        onFocus={() => {
          setFocusedId(node.id);
          setDraft((current) => (current !== null && current.text === "" && !current.created ? null : current));
        }}
      >
        <div className="outliner__main">
          {expandable ? (
            <button
              type="button"
              className={`outliner__twist ${collapsed ? "" : "outliner__twist--open"}`}
              tabIndex={-1}
              aria-label={collapsed ? `Expand ${node.title}` : `Collapse ${node.title}`}
              title={collapsed ? "Expand" : "Collapse"}
              onClick={() => {
                setTaskOpen(node, collapsed);
                focusRow(node.id);
              }}
            >
              <IconChevron size={12} />
            </button>
          ) : (
            <span className="outliner__twist outliner__twist--none" aria-hidden="true" />
          )}
          <input
            type="checkbox"
            className="outliner__check"
            ref={(element) => {
              if (element !== null) element.indeterminate = state === "mixed";
            }}
            checked={done}
            disabled={rowBusy}
            tabIndex={-1}
            aria-checked={state === "mixed" ? "mixed" : done}
            aria-label={checkLabel}
            onChange={() => void perform("toggle-done", node, isEditing)}
          />
          {isEditing ? (
            <AutoInput
              value={editing.text}
              placeholder="Task title - #p1 due:tomorrow"
              label={`Edit ${node.title}`}
              focusKey={node.id}
              readOnly={rowBusy}
              onChange={(text) => setEditing({ id: node.id, text })}
              onKeyDown={(event) => onEditKeyDown(event, node)}
              onBlur={() => void commitEdit(node, false)}
            />
          ) : (
            <span className="outliner__title" onClick={() => startEdit(node)}>
              <InlineText text={node.title} />
              {collapsed && <span className="outliner__hidden">{hiddenSummary(full)}</span>}
            </span>
          )}
          {!isEditing && plan !== null && plan.hidden > 0 && (
            <button
              type="button"
              className="outliner__plan"
              tabIndex={-1}
              title="Plan subtasks"
              aria-label={`Plan subtasks of ${node.title}, ${plan.hidden} not in this day`}
              onClick={() => onPlanSubtasks?.(node)}
            >
              +{plan.hidden}
            </button>
          )}
          {!isEditing && renderChips(node)}
          <button
            type="button"
            className={`act act--icon outliner__more ${menuId === node.id ? "outliner__more--on" : ""}`}
            aria-label={`Actions for ${node.title}`}
            aria-haspopup="menu"
            aria-expanded={menuId === node.id}
            tabIndex={-1}
            onClick={() => {
              setConfirmId(null);
              setMenuId(menuId === node.id ? null : node.id);
            }}
          >
            <IconMore />
          </button>
        </div>
        {menuId === node.id && (
          <div className="outliner__menu" role="menu" aria-label={`Actions for ${node.title}`} onKeyDown={(event) => onMenuKeyDown(event, node)}>
            {menuActions(node).map((action) => (
              <button
                key={action.key}
                type="button"
                role="menuitem"
                className="outliner__menuitem"
                disabled={action.disabled}
                onClick={() => {
                  setMenuId(null);
                  focusRow(node.id);
                  void perform(action.intent, node, false);
                }}
              >
                {action.label}
              </button>
            ))}
            {plan !== null && plan.open > 0 && (
              <button
                type="button"
                role="menuitem"
                className="outliner__menuitem"
                onClick={() => {
                  setMenuId(null);
                  onPlanSubtasks?.(node);
                }}
              >
                Plan subtasks
              </button>
            )}
          </div>
        )}
        {isEditing && (
          <div className="outliner__hint">Enter save and add below - Tab indent - Shift+Enter note - Ctrl+Enter done - Esc cancel</div>
        )}
        {node.notes.length > 0 && (
          <ul className="outliner__notes">
            {node.notes.map((item) => (
              <li key={`${item.line}:${item.raw}`} className="outliner__note">
                <InlineText text={item.text} />
              </li>
            ))}
          </ul>
        )}
        {note !== null && (
          <div className="outliner__noteform">
            <AutoInput
              value={note.text}
              placeholder="Add a note - Enter to save, Esc to cancel"
              label={`New note for ${node.title}`}
              focusKey={`note:${node.id}`}
              readOnly={rowBusy}
              onChange={(text) => setNoteDraft({ id: node.id, text })}
              onKeyDown={(event) => onNoteKeyDown(event, node, note)}
            />
          </div>
        )}
        {confirmId === node.id && (
          <div className="outliner__confirm" role="alert">
            <span>Remove from today? Enter/Esc</span>
            <button type="button" className="act act--danger" tabIndex={-1} onClick={() => void confirmUnschedule(node)}>
              Remove
            </button>
            <button type="button" className="act" tabIndex={-1} onClick={() => setConfirmId(null)}>
              Keep
            </button>
          </div>
        )}
        {error !== undefined && (
          <div className="outliner__error" role="alert">
            {error}
          </div>
        )}
      </div>
    );
  };

  const renderDraft = (anchor: OutlineNode, current: DraftState): ReactNode => {
    const rowBusy = busyIds[DRAFT_ERROR_KEY] === true;
    const error = errors[DRAFT_ERROR_KEY];
    return (
      <div key="draft" role="treeitem" aria-level={anchor.depth + 1} aria-selected={false} aria-busy={rowBusy} tabIndex={-1} className="outliner__row outliner__row--draft" style={{ ["--depth" as string]: anchor.depth }}>
        <div className="outliner__main">
          <span className="outliner__twist outliner__twist--none" aria-hidden="true" />
          <span className="outliner__check outliner__check--ghost" aria-hidden="true" />
          <AutoInput
            value={current.text}
            placeholder="New task - Enter to add, empty Enter to finish"
            label="New task"
            focusKey={current.anchorId}
            readOnly={rowBusy}
            onChange={(text) => setDraft((latest) => (latest === null ? latest : { ...latest, text }))}
            onKeyDown={(event) => onDraftKeyDown(event, anchor, current)}
          />
        </div>
        {error !== undefined && (
          <div className="outliner__error" role="alert">
            {error}
          </div>
        )}
      </div>
    );
  };

  const renderAdd = (current: AddState, title: string): ReactNode => {
    const key = `add:${current.projectId}`;
    const rowBusy = busyIds[key] === true;
    const error = errors[key];
    return (
      <div key="add" role="treeitem" aria-level={1} aria-selected={false} aria-busy={rowBusy} tabIndex={-1} className="outliner__row outliner__row--draft outliner__row--add">
        <div className="outliner__main">
          <span className="outliner__twist outliner__twist--none" aria-hidden="true" />
          <span className="outliner__check outliner__check--ghost" aria-hidden="true" />
          <AutoInput
            value={current.text}
            placeholder={`New task in ${title} - Enter to add, Esc to cancel`}
            label={`New task in ${title}`}
            focusKey={key}
            readOnly={rowBusy}
            onChange={(text) => setAdding((latest) => (latest === null ? latest : { ...latest, text }))}
            onKeyDown={(event) => onAddKeyDown(event, current)}
          />
        </div>
        {error !== undefined && (
          <div className="outliner__error" role="alert">
            {error}
          </div>
        )}
      </div>
    );
  };

  if (flattenVisible(groups).length === 0) {
    return <p className="outliner__empty">Nothing in focus yet.</p>;
  }

  return (
    <div className={`outliner ${busy ? "outliner--busy" : ""}`} role="tree" aria-label="Focus" aria-busy={busy}>
      {shown.map((group) => {
        const original = groups.find((item) => item.project.id === group.project.id) ?? group;
        const counts = focusGroupCounts(original);
        if (counts.tasks === 0) return null;
        const open = !isProjectCollapsed(collapse, group.project.id);
        const nodes = flattenNodes(group.items);
        const anchorIndex = draft === null ? -1 : nodes.findIndex((node) => node.id === draft.anchorId);
        const draftAt = anchorIndex === -1 ? -1 : subtreeEnd(nodes, anchorIndex);
        const anchor = anchorIndex === -1 ? null : (nodes[anchorIndex] ?? null);
        const rows: ReactNode[] = [];
        for (let index = 0; index <= nodes.length; index += 1) {
          if (index === draftAt && anchor !== null && draft !== null) rows.push(renderDraft(anchor, draft));
          const node = nodes[index];
          if (node !== undefined) rows.push(renderRow(node));
        }
        if (open && adding !== null && adding.projectId === group.project.id) rows.push(renderAdd(adding, group.project.title));
        const doneLabel = counts.done > 0 ? `, ${counts.done} done` : "";
        return (
          <div key={group.project.id} className={`outliner__group ${open ? "" : "outliner__group--closed"}`} role="group" aria-label={group.project.title}>
            <div className="outliner__project">
              <button
                ref={(element) => {
                  if (element === null) headerRefs.current.delete(group.project.id);
                  else headerRefs.current.set(group.project.id, element);
                }}
                type="button"
                className="outliner__toggle"
                aria-expanded={open}
                aria-label={`${group.project.title}, ${counts.tasks} task${counts.tasks === 1 ? "" : "s"}${doneLabel}`}
                title={open ? "Collapse (Left arrow)" : "Expand (Right arrow)"}
                onClick={() => setProjectOpen(group.project.id, !open)}
                onKeyDown={(event) => onHeaderKeyDown(event, group)}
              >
                <span className={`outliner__twist ${open ? "outliner__twist--open" : ""}`} aria-hidden="true">
                  <IconChevron size={12} />
                </span>
                <span className="outliner__project-title">{group.project.title}</span>
                <span className="outliner__count">{counts.tasks}</span>
                {counts.done > 0 && <span className="outliner__done-count">{counts.done} done</span>}
              </button>
              {onAddToProject !== undefined && (
                <button type="button" className="act outliner__add" aria-label={`Add a task to ${group.project.title} for this day`} onClick={() => openAdd(group.project.id)}>
                  + Add
                </button>
              )}
            </div>
            {rows}
          </div>
        );
      })}
    </div>
  );
}
