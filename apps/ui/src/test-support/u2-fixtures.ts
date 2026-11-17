import type { BoardNoteItem, BoardPayload, BoardProject, BoardTask, BoardToday, WorkspaceRecord } from "../delegation";

export function makeTask(id: string, patch: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    projectId: "p1",
    line: 1,
    raw: `- [ ] ${id}`,
    depth: 0,
    checkbox: "todo",
    prefix: null,
    status: "todo",
    title: id,
    reason: null,
    section: "open",
    doneAt: null,
    group: null,
    priority: null,
    notes: [],
    noteItems: [],
    subtasks: [],
    ...patch,
  };
}

export function makeNote(line: number, text: string): BoardNoteItem {
  return { line, raw: `  - ${text}`, text };
}

export function makeProject(id: string, patch: Partial<BoardProject> = {}): BoardProject {
  return { id, name: id, title: id, parent: null, depth: 0, path: `/vault/${id}.md`, workspace: null, workspaceSource: null, ...patch };
}

export function makeToday(patch: Partial<BoardToday> = {}): BoardToday {
  return { date: "2026-11-16", exists: true, taskIds: [], states: {}, ...patch };
}

export function makePayload(patch: Partial<BoardPayload> = {}): BoardPayload {
  return {
    enabled: true,
    root: "/vault",
    configured: true,
    delegatePrompt: "Do {{task}} in {{project}}",
    projects: [],
    tasks: [],
    errors: [],
    today: null,
    ...patch,
  };
}

export function makeWorkspace(name: string, repos: string[] = []): WorkspaceRecord {
  return {
    name,
    file: `/ws/${name}.json`,
    contextPath: null,
    repos: repos.map((repo) => ({ name: repo, path: `/ws/${name}/${repo}` })) as WorkspaceRecord["repos"],
    error: null,
  };
}
