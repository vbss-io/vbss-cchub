import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import type { DailyStreamEvent, TasksBoardStreamEvent } from "../api";
import * as delegation from "../delegation";
import type { BoardPayload, BoardTask, DelegationSettings, WorkspaceRecord } from "../delegation";
import { BoardView } from "../views/BoardView";
import { makeNote, makePayload, makeProject, makeTask, makeToday, makeWorkspace } from "./u2-fixtures";

export const api = {
  board: vi.mocked(delegation.getTasksBoard),
  patch: vi.mocked(delegation.patchBoardItem),
  create: vi.mocked(delegation.createBoardItem),
  addNote: vi.mocked(delegation.addBoardNote),
  editNote: vi.mocked(delegation.editBoardNote),
  deleteNote: vi.mocked(delegation.deleteBoardNote),
  sweep: vi.mocked(delegation.sweepBoardDone),
  addToDaily: vi.mocked(delegation.addBoardTaskToDaily),
  syncDaily: vi.mocked(delegation.syncBoardTaskToDaily),
  delegate: vi.mocked(delegation.delegateBoardTask),
  move: vi.mocked(delegation.moveBoardItem),
  reparent: vi.mocked(delegation.reparentBoardTask),
  moveToProject: vi.mocked(delegation.moveBoardTaskToProject),
  openEditor: vi.mocked(delegation.openBoardProjectInEditor),
  settings: vi.mocked(delegation.getSettings),
};

export function resetApi(): void {
  for (const mock of Object.values(api)) mock.mockReset();
  api.settings.mockResolvedValue({ daily: { focusSource: "scheduled" } } as unknown as DelegationSettings);
}

export const subA = makeTask("t1.a", { projectId: "p1", line: 4, depth: 1, title: "Sub A", status: "doing", checkbox: "doing", raw: "  - [-] Sub A" });
export const subB = makeTask("t1.b", { projectId: "p1", line: 5, depth: 1, title: "Sub B", status: "done", checkbox: "done", raw: "  - [x] Sub B" });

export function makeBoardTasks(): BoardTask[] {
  return [
    makeTask("t1", { projectId: "p1", line: 3, title: "Write spec", status: "todo", priority: 0, due: "2020-01-01", noteItems: [makeNote(6, "spec note")], notes: ["spec note"], subtasks: [subA, subB], raw: "- [ ] Write spec" }),
    makeTask("t2", { projectId: "p2", line: 2, title: "Build API", status: "doing", checkbox: "doing", priority: 1, start: "2026-11-10", due: "2026-12-30", raw: "- [-] Build API" }),
    makeTask("t3", { projectId: "p1", line: 10, title: "Waiting", status: "blocked", reason: "vendor", raw: "- [ ] Waiting" }),
    makeTask("t4", { projectId: "p1", line: 20, title: "Shipped", status: "done", checkbox: "done", section: "done", doneAt: "2026-11-10", raw: "- [x] Shipped" }),
    makeTask("t5", { projectId: "p3", line: 1, title: "Parked", status: "hold", raw: "- [ ] Parked" }),
    makeTask("t6", { projectId: "p3", line: 2, title: "Old thing", status: "archived", raw: "- [ ] Old thing" }),
    makeTask("t7", { projectId: "p3", line: 3, title: "Plain task", status: "todo", raw: "- [ ] Plain task" }),
  ];
}

export function makeBoardPayload(patch: Partial<BoardPayload> = {}): BoardPayload {
  return makePayload({
    projects: [
      makeProject("p1", { title: "Platform", workspace: "vbss", workspaceSource: "own", path: "/vault/platform.md" }),
      makeProject("p2", { title: "API", parent: "p1", depth: 1, path: "/vault/platform/api.md" }),
      makeProject("p3", { title: "Garden", path: "/vault/garden.md" }),
    ],
    tasks: makeBoardTasks(),
    today: makeToday({ taskIds: ["t1", "t2"], states: { t1: "doing", t2: "doing" }, mismatch: ["t1"] }),
    ...patch,
  });
}

export const defaultSettings = { tasks: { doneSection: "## Done", priorityLevels: 4 }, daily: { projectOrder: [], focusSource: "scheduled" } } as unknown as DelegationSettings;

export function makeBus<T>() {
  const listeners = new Set<(event: T) => void>();
  return {
    subscribe: (listener: (event: T) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (event: T) => {
      for (const listener of [...listeners]) listener(event);
    },
    size: () => listeners.size,
  };
}

export interface BoardHarnessOptions {
  payload?: BoardPayload | null;
  settings?: DelegationSettings | null;
  workspaces?: WorkspaceRecord[];
  openTaskId?: string | null;
}

export function renderBoard(options: BoardHarnessOptions = {}) {
  const payload = options.payload === undefined ? makeBoardPayload() : options.payload;
  if (payload) api.board.mockResolvedValue(payload);
  const boardBus = makeBus<TasksBoardStreamEvent>();
  const dailyBus = makeBus<DailyStreamEvent>();
  const handlers = {
    onOpenSettings: vi.fn(),
    onOpenTaskHandled: vi.fn(),
    onDelegated: vi.fn(),
    onNotice: vi.fn(),
    onError: vi.fn(),
  };
  const view = render(
    <BoardView
      workspaces={options.workspaces ?? [makeWorkspace("vbss", ["api", "web"]), makeWorkspace("space")]}
      settings={options.settings === undefined ? defaultSettings : options.settings}
      subscribeBoard={boardBus.subscribe}
      subscribeDaily={dailyBus.subscribe}
      openTaskId={options.openTaskId ?? null}
      {...handlers}
    />,
  );
  return { ...handlers, ...view, boardBus, dailyBus };
}

export const cardOf = (title: string): HTMLElement => screen.getByText(title, { selector: ".board-card__title *, .board-card__title" }).closest("article") as HTMLElement;

export const column = (name: string): HTMLElement => screen.getByRole("region", { name });

export const dataTransfer = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" });
