import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskRecord, WorkspaceRecord } from "./delegation";
import { buildFlow, fitNodeText, OUTSIDE_LABEL, relatives, type FlowInput } from "./flow-layout";
import type { AgentRecord, CodexSessionRecord, GroupRecord, SessionRecord, SessionStatus } from "./types";

const now = Date.now();

const session = (id: string, cwd: string | null, status: SessionStatus, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: id,
  status,
  cwd,
  source: null,
  hostPid: 100,
  client: "terminal",
  title: id,
  customTitle: null,
  lastMessage: null,
  model: "sonnet",
  tokensIn: 1,
  tokensOut: 1,
  contextTokens: 1,
  archivedAt: null,
  helperOf: null,
  agentsRunning: 0,
  agentsTotal: 0,
  startedAt: now,
  updatedAt: now,
  ...extra,
});

const workspace = (name: string, repoPath: string): WorkspaceRecord => ({
  name,
  file: `${name}.code-workspace`,
  contextPath: null,
  repos: [{ name: `${name}-repo`, path: repoPath }],
  error: null,
});

const agent = (id: string, sessionId: string, status: "running" | "ended"): AgentRecord => ({
  agentId: id,
  sessionId,
  agentType: "explore",
  status,
  transcriptPath: null,
  lastMessage: null,
  startedAt: now,
  updatedAt: now,
});

const task = (
  id: string,
  ws: string,
  sessionId: string | null,
  status: TaskRecord["status"],
  extra: Partial<TaskRecord> = {},
): TaskRecord => ({
  id,
  title: `task ${id}`,
  prompt: "",
  workspace: ws,
  repo: null,
  cwd: "/repo/alpha",
  addDirs: [],
  runner: "claude",
  requestedModel: null,
  permissionMode: null,
  sandbox: null,
  status,
  sessionId,
  createdBy: null,
  originSessionId: null,
  originClient: null,
  lastError: null,
  runsCount: 1,
  createdAt: now,
  updatedAt: now,
  ...extra,
});

const codex = (id: string, cwd: string | null): CodexSessionRecord => ({
  id,
  title: `codex ${id}`,
  cwd,
  originator: null,
  source: null,
  threadSource: null,
  client: "codex-app",
  status: "active",
  turns: 3,
  lastMessage: null,
  file: "rollout.jsonl",
  startedAt: now,
  updatedAt: now,
  origin: null,
  hubTaskId: null,
  customTitle: null,
  archivedAt: null,
  hidden: false,
});

const input = (over: Partial<FlowInput>): FlowInput => ({
  sessions: [],
  codex: [],
  tasks: [],
  workspaces: [],
  groups: [],
  agentsBySession: {},
  expandedSubagents: new Set(),
  expandedTaskGroups: new Set(),
  collapsedLanes: new Set(),
  orientation: "horizontal",
  ...over,
});

test("lanes: one per workspace plus Outside, hub present", () => {
  const graph = buildFlow(
    input({
      sessions: [session("a", "/repo/alpha", "active"), session("b", "/repo/beta", "idle"), session("c", "/somewhere/else", "active")],
      workspaces: [workspace("alpha", "/repo/alpha"), workspace("beta", "/repo/beta")],
    }),
  );
  const laneTitles = graph.nodes.filter((n) => n.kind === "workspace").map((n) => n.title);
  assert.ok(graph.nodes.some((n) => n.kind === "hub"));
  assert.ok(laneTitles.includes("alpha"));
  assert.ok(laneTitles.includes("beta"));
  assert.ok(laneTitles.includes(OUTSIDE_LABEL));
});

test("lane order follows groups then Outside last", () => {
  const groups: GroupRecord[] = [
    { id: "1", name: "beta", match: "/repo/beta", position: 0 },
    { id: "2", name: "alpha", match: "/repo/alpha", position: 1 },
  ];
  const graph = buildFlow(
    input({
      sessions: [session("a", "/repo/alpha", "active"), session("b", "/repo/beta", "active"), session("c", "/out/side", "active")],
      workspaces: [workspace("alpha", "/repo/alpha"), workspace("beta", "/repo/beta")],
      groups,
    }),
  );
  const lanes = graph.nodes.filter((n) => n.kind === "workspace").map((n) => n.title);
  assert.deepEqual(lanes, ["beta", "alpha", OUTSIDE_LABEL]);
});

test("helpers never appear", () => {
  const graph = buildFlow(
    input({
      sessions: [session("a", "/repo/alpha", "active"), session("h", "/x/scratch-workspaces/z", "active", { helperOf: "a", client: "claude-desktop" })],
      workspaces: [workspace("alpha", "/repo/alpha")],
    }),
  );
  assert.ok(!graph.nodes.some((n) => n.sessionId === "h"));
});

test("subagents collapse then expand caps at 12 + more", () => {
  const agents = Array.from({ length: 64 }, (_, i) => agent(`ag${i}`, "a", i < 3 ? "running" : "ended"));
  const parent = session("a", "/repo/alpha", "active", { agentsTotal: 64, agentsRunning: 3 });
  const collapsed = buildFlow(input({ sessions: [parent], workspaces: [workspace("alpha", "/repo/alpha")], agentsBySession: { a: agents } }));
  const sub = collapsed.nodes.find((n) => n.kind === "subagents");
  assert.equal(sub?.title, "3 running");
  assert.equal(sub?.subtitle, "of 64 subagents");
  assert.equal(collapsed.nodes.filter((n) => n.kind === "agent").length, 0);

  const runningOnly = buildFlow(
    input({ sessions: [parent], workspaces: [workspace("alpha", "/repo/alpha")], agentsBySession: { a: agents }, expandedSubagents: new Set(["a"]) }),
  );
  assert.equal(runningOnly.nodes.filter((n) => n.kind === "agent").length, 3);
  assert.equal(runningOnly.nodes.find((n) => n.kind === "more")?.title, "+61 ended");
  assert.equal(runningOnly.nodes.find((n) => n.kind === "more")?.subtitle, "double-click to list");

  const expanded = buildFlow(
    input({ sessions: [parent], workspaces: [workspace("alpha", "/repo/alpha")], agentsBySession: { a: agents }, expandedSubagents: new Set(["a"]), showEndedAgents: true }),
  );
  assert.equal(expanded.nodes.filter((n) => n.kind === "agent").length, 12);
  const more = expanded.nodes.find((n) => n.kind === "more");
  assert.equal(more?.title, "+52 more");
  const runningFirst = expanded.nodes.filter((n) => n.kind === "agent").slice(0, 3).every((n) => n.subtitle === "running");
  assert.ok(runningFirst);
});

test("task under its session, else no-live-session group", () => {
  const withSession = buildFlow(
    input({
      sessions: [session("a", "/repo/alpha", "active")],
      workspaces: [workspace("alpha", "/repo/alpha")],
      tasks: [task("t1", "alpha", "a", "running")],
    }),
  );
  const t1 = withSession.nodes.find((n) => n.taskId === "t1");
  assert.equal(t1?.parent, "s:a");

  const orphan = buildFlow(
    input({
      sessions: [session("a", "/repo/alpha", "active")],
      workspaces: [workspace("alpha", "/repo/alpha")],
      tasks: [task("t2", "alpha", "ghost", "running")],
    }),
  );
  const group = orphan.nodes.find((n) => n.kind === "taskgroup");
  assert.ok(group);
  assert.equal(orphan.nodes.filter((n) => n.kind === "task").length, 0);
  const expanded = buildFlow(
    input({
      sessions: [session("a", "/repo/alpha", "active")],
      workspaces: [workspace("alpha", "/repo/alpha")],
      tasks: [task("t2", "alpha", "ghost", "running")],
      expandedTaskGroups: new Set(["alpha"]),
    }),
  );
  assert.equal(expanded.nodes.filter((n) => n.taskId === "t2").length, 1);
});

test("origin session gets a dashed edge to a task it delegated", () => {
  const graph = buildFlow(
    input({
      sessions: [session("runner", "/repo/alpha", "active"), session("boss", "/repo/alpha", "active")],
      workspaces: [workspace("alpha", "/repo/alpha")],
      tasks: [task("t1", "alpha", "runner", "running", { originSessionId: "boss" })],
    }),
  );
  const t1 = graph.nodes.find((n) => n.taskId === "t1");
  assert.equal(t1?.parent, "s:runner");
  const origin = graph.edges.find((e) => e.origin);
  assert.ok(origin);
  assert.equal(origin?.from, "s:boss");
  assert.equal(origin?.to, "t:t1");

  const noEdge = buildFlow(
    input({
      sessions: [session("runner", "/repo/alpha", "active")],
      workspaces: [workspace("alpha", "/repo/alpha")],
      tasks: [task("t2", "alpha", "runner", "running", { originSessionId: "gone" })],
    }),
  );
  assert.ok(!noEdge.edges.some((e) => e.origin));
});

test("codex thread lands in its workspace lane", () => {
  const graph = buildFlow(input({ codex: [codex("cx", "/repo/alpha")], workspaces: [workspace("alpha", "/repo/alpha")] }));
  const node = graph.nodes.find((n) => n.codexId === "cx");
  assert.equal(node?.parent, "ws:alpha");
});

test("orientation swaps the main axis", () => {
  const sessions = [session("a", "/repo/alpha", "active")];
  const ws = [workspace("alpha", "/repo/alpha")];
  const h = buildFlow(input({ sessions, workspaces: ws, orientation: "horizontal" }));
  const v = buildFlow(input({ sessions, workspaces: ws, orientation: "vertical" }));
  const hubH = h.nodes.find((n) => n.kind === "hub")!;
  const wsH = h.nodes.find((n) => n.kind === "workspace")!;
  const hubV = v.nodes.find((n) => n.kind === "hub")!;
  const wsV = v.nodes.find((n) => n.kind === "workspace")!;
  assert.ok(wsH.x > hubH.x);
  assert.ok(wsV.y > hubV.y);
});

test("relatives keeps ancestors and descendants only", () => {
  const graph = buildFlow(
    input({
      sessions: [session("a", "/repo/alpha", "active", { agentsTotal: 1, agentsRunning: 1 }), session("b", "/repo/alpha", "active")],
      workspaces: [workspace("alpha", "/repo/alpha")],
      agentsBySession: { a: [agent("ag0", "a", "running")] },
      expandedSubagents: new Set(["a"]),
    }),
  );
  const keep = relatives(graph.edges, "s:a");
  assert.ok(keep.has("hub"));
  assert.ok(keep.has("ws:alpha"));
  assert.ok(keep.has("sub:a"));
  assert.ok(!keep.has("s:b"));
});

test("idle sessions: unread is violet finished, seen is neutral, waiting and active keep their tones, red is never used", () => {
  const graph = buildFlow(
    input({
      sessions: [
        session("a", "/repo/alpha", "idle", { unread: true }),
        session("b", "/repo/alpha", "idle", { unread: false }),
        session("c", "/repo/alpha", "idle"),
        session("d", "/repo/alpha", "waiting"),
        session("e", "/repo/alpha", "active"),
        session("f", "/repo/alpha", "ended"),
      ],
      workspaces: [workspace("alpha", "/repo/alpha")],
    }),
  );
  const of = (id: string) => graph.nodes.find((n) => n.sessionId === id && n.kind === "session")!;
  assert.equal(of("a").tone, "unread");
  assert.equal(of("a").subtitle, "finished");
  assert.equal(of("b").tone, "seen");
  assert.equal(of("b").subtitle, "idle");
  assert.equal(of("c").tone, "seen");
  assert.equal(of("d").tone, "pend");
  assert.equal(of("e").tone, "go");
  assert.equal(of("f").tone, "muted");
  assert.ok(!graph.nodes.some((n) => n.kind === "session" && n.tone === "hold"));
});

test("delegated task tones follow the colour rule: running cyan, needs you yellow, failed red, rest grey", () => {
  const statuses: TaskRecord["status"][] = ["running", "pending", "attention", "failed", "interrupted", "completed", "cancelled"];
  const graph = buildFlow(
    input({
      sessions: [session("a", "/repo/alpha", "active")],
      workspaces: [workspace("alpha", "/repo/alpha")],
      tasks: statuses.map((status) => task(`t-${status}`, "alpha", "a", status)),
    }),
  );
  const toneOf = (status: string) => graph.nodes.find((n) => n.taskId === `t-${status}`)?.tone;
  assert.equal(toneOf("running"), "go");
  assert.equal(toneOf("pending"), "go");
  assert.equal(toneOf("attention"), "pend");
  assert.equal(toneOf("failed"), "hold");
  assert.equal(toneOf("interrupted"), "hold");
  assert.equal(toneOf("completed"), "muted");
  assert.equal(toneOf("cancelled"), "muted");
});

test("task group without a live session takes the most urgent tone of its tasks", () => {
  const groupTone = (statuses: TaskRecord["status"][]) =>
    buildFlow(
      input({
        sessions: [session("a", "/repo/alpha", "active")],
        workspaces: [workspace("alpha", "/repo/alpha")],
        tasks: statuses.map((status, index) => task(`g${index}`, "alpha", "ghost", status)),
      }),
    ).nodes.find((n) => n.kind === "taskgroup")?.tone;
  assert.equal(groupTone(["running", "completed"]), "go");
  assert.equal(groupTone(["running", "attention"]), "pend");
  assert.equal(groupTone(["completed", "failed"]), "hold");
  assert.equal(groupTone(["completed", "cancelled"]), "muted");
});

test("a finished worktree task waiting to merge is violet on the map, like in the list", () => {
  const ready = { ...task("t-ready", "alpha", "a", "completed"), isolation: "worktree" as const, worktreePath: "/w/t-ready", mergedAt: null };
  const graph = buildFlow(
    input({
      sessions: [session("a", "/repo/alpha", "active")],
      workspaces: [workspace("alpha", "/repo/alpha")],
      tasks: [ready],
    }),
  );
  assert.equal(graph.nodes.find((n) => n.taskId === "t-ready")?.tone, "unread");
});

test("failed delegated task keeps the red tone", () => {
  const graph = buildFlow(
    input({
      sessions: [session("a", "/repo/alpha", "active")],
      workspaces: [workspace("alpha", "/repo/alpha")],
      tasks: [task("t1", "alpha", "a", "failed")],
    }),
  );
  assert.equal(graph.nodes.find((n) => n.taskId === "t1")?.tone, "hold");
});

test("null-safe edges: parents always exist for edges", () => {
  const graph = buildFlow(
    input({ sessions: [session("a", "/repo/alpha", "active")], workspaces: [workspace("alpha", "/repo/alpha")] }),
  );
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.from));
    assert.ok(ids.has(edge.to));
  }
});

const withSubagents = (running: number, ended: number, over: Partial<FlowInput> = {}) => {
  const agents = [
    ...Array.from({ length: running }, (_, i) => agent(`r${i}`, "s1", "running")),
    ...Array.from({ length: ended }, (_, i) => agent(`e${i}`, "s1", "ended")),
  ];
  return buildFlow(
    input({
      sessions: [session("s1", "/repo/alpha", "active", { agentsRunning: running, agentsTotal: running + ended })],
      workspaces: [workspace("alpha", "/repo/alpha")],
      agentsBySession: { s1: agents },
      expandedSubagents: new Set(["s1"]),
      ...over,
    }),
  );
};

test("hidden ended subagents get their own node that lists them for that session only", () => {
  const collapsed = withSubagents(1, 9);
  const endedNode = collapsed.nodes.find((n) => n.kind === "more" && n.moreKind === "ended");
  assert.equal(endedNode?.title, "+9 ended");
  assert.equal(collapsed.nodes.filter((n) => n.kind === "agent").length, 1);
  const listed = withSubagents(1, 9, { endedAgentsFor: new Set(["s1"]) });
  assert.equal(listed.nodes.filter((n) => n.kind === "agent").length, 10);
  assert.equal(listed.nodes.some((n) => n.kind === "more"), false);
});

test("more than the map can hold becomes an overflow node that opens the session", () => {
  const graph = withSubagents(15, 0);
  assert.equal(graph.nodes.filter((n) => n.kind === "agent").length, 12);
  const overflow = graph.nodes.find((n) => n.kind === "more" && n.moreKind === "overflow");
  assert.equal(overflow?.title, "+3 more");
});

test("every node's drawn subtitle fits inside the box", () => {
  const graph = withSubagents(1, 9);
  for (const node of graph.nodes) {
    assert.ok(node.h >= 44 || node.kind === "hub" || node.subtitle === "", `${node.kind} too short for a subtitle`);
    const drawn = fitNodeText(node).subtitle;
    assert.ok(drawn.length * 6.2 <= node.w - 44, `${node.kind} subtitle too long: ${drawn}`);
  }
});

test("nodes keep their full subtitle for the inspector and only the drawing clips it", () => {
  const sessions = Array.from({ length: 12 }, (_, i) => session(`s${i}`, `C:/somewhere/very/deep/inside/a-folder-with-a-long-name-${i}`, "active"));
  const graph = buildFlow(input({ sessions, codex: [codex("cx1", null), codex("cx2", null), codex("cx3", null)] }));
  const hub = graph.nodes.find((n) => n.kind === "hub");
  assert.equal(hub?.subtitle, "12 live · 3 codex · 0 tasks");
  assert.notEqual(fitNodeText(hub!).subtitle, hub?.subtitle);
  const outside = graph.nodes.find((n) => n.kind === "workspace" && n.title === OUTSIDE_LABEL);
  assert.ok(outside);
  assert.equal(outside.subtitle.endsWith("…"), false);
  assert.ok(fitNodeText(outside).subtitle.length <= outside.subtitle.length);
});

test("fitNodeText clips title and subtitle to the node width, leaving room for the badge", () => {
  const fitted = fitNodeText({ w: 196, title: "A very long subagent title that never ends", subtitle: "turn on show ended to list everything here", badge: "3 running" });
  assert.ok(fitted.title.endsWith("…"));
  assert.ok(fitted.subtitle.endsWith("…"));
  assert.ok(fitted.subtitle.length * 6.2 <= 196 - 44);
  assert.deepEqual(fitNodeText({ w: 268, title: "Short", subtitle: "ok", badge: null }), { title: "Short", subtitle: "ok" });
});
