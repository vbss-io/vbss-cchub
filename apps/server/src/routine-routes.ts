import { Router, type Response } from "express";
import { isAbsolute } from "node:path";
import { BadRequestError, resolveWorkspaceTarget } from "./delegation-launch.js";
import { RUNNERS, type Runner } from "./delegation-types.js";
import { asString, sendError } from "./route-helpers.js";
import { parseSchedule, upcomingFires } from "./routine-schedule.js";
import {
  CATCH_UP_HOURS_MAX,
  CATCH_UP_HOURS_MIN,
  createRoutine,
  deleteRoutine,
  getRoutine,
  getRoutineRun,
  getRoutineSettings,
  lastRoutineRun,
  listInbox,
  listRoutineRuns,
  listRoutines,
  markAllInboxRead,
  markInboxRead,
  routineCost,
  runningRoutineRun,
  setRoutineSettings,
  unreadInboxCount,
  updateRoutine,
  type RoutineInput,
  type RoutineRecord,
} from "./routine-store.js";
import { fireRoutine, RoutineGateError, routinesGate, schedulerGate } from "./routines.js";
import { broadcast } from "./sse.js";
import { isDirectory } from "./workspaces.js";

const NAME_MAX = 80;
const PROMPT_MAX = 20_000;
const PREVIEW_COUNT = 5;

export function routineView(routine: RoutineRecord) {
  return {
    ...routine,
    running: runningRoutineRun(routine.id) !== null,
    lastRun: lastRoutineRun(routine.id),
    cost: routineCost(routine.id),
  };
}

function fail(res: Response, err: unknown): void {
  if (err instanceof RoutineGateError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  sendError(res, err);
}

const field = (body: Record<string, unknown>, key: string): string | null | undefined => (key in body ? (asString(body[key])?.trim() ?? null) : undefined);

function parseTarget(body: Record<string, unknown>, current: RoutineRecord | null): Pick<RoutineInput, "workspace" | "repo" | "cwd"> {
  const bodyWorkspace = field(body, "workspace");
  const bodyRepo = field(body, "repo");
  const bodyCwd = field(body, "cwd");
  if (bodyWorkspace && bodyCwd) throw new BadRequestError("give either workspace (with optional repo) or cwd, not both");
  if (bodyCwd) {
    if (!isAbsolute(bodyCwd) || !isDirectory(bodyCwd)) throw new BadRequestError("cwd must be an existing absolute directory");
    return { workspace: null, repo: null, cwd: bodyCwd };
  }
  const workspace = bodyWorkspace !== undefined ? bodyWorkspace : (current?.workspace ?? null);
  if (workspace) {
    const switched = bodyWorkspace !== undefined && bodyWorkspace !== current?.workspace;
    const repo = bodyRepo !== undefined ? bodyRepo : switched ? null : (current?.repo ?? null);
    const target = resolveWorkspaceTarget(workspace, repo);
    return { workspace: target.workspace, repo: target.repo, cwd: null };
  }
  if (bodyCwd === undefined && current?.cwd) {
    if (bodyRepo) throw new BadRequestError("repo needs a workspace");
    return { workspace: null, repo: null, cwd: current.cwd };
  }
  throw new BadRequestError("workspace or cwd required");
}

function parseRoutineBody(body: Record<string, unknown>, current: RoutineRecord | null): Partial<RoutineInput> {
  const patch: Partial<RoutineInput> = {};
  if (!current || "name" in body) {
    const name = asString(body.name)?.trim() ?? "";
    if (!name || name.length > NAME_MAX || /[\r\n]/.test(name)) throw new BadRequestError(`name must be 1-${NAME_MAX} characters on one line`);
    patch.name = name;
  }
  if (!current || "prompt" in body) {
    const prompt = asString(body.prompt)?.trim() ?? "";
    if (!prompt || prompt.length > PROMPT_MAX) throw new BadRequestError(`prompt must be 1-${PROMPT_MAX} characters`);
    patch.prompt = prompt;
  }
  if (!current || "runner" in body) {
    const runner = body.runner === undefined || body.runner === null ? "claude" : asString(body.runner);
    if (!runner || !(RUNNERS as readonly string[]).includes(runner)) throw new BadRequestError(`runner must be one of: ${RUNNERS.join(", ")}`);
    patch.runner = runner as Runner;
  }
  if (!current || "model" in body) patch.model = asString(body.model)?.trim() ?? null;
  if (!current || "schedule" in body) {
    const schedule = parseSchedule(body.schedule);
    if (typeof schedule === "string") throw new BadRequestError(schedule);
    patch.schedule = schedule;
  }
  if (!current || "enabled" in body) {
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new BadRequestError("enabled must be a boolean");
    patch.enabled = body.enabled !== false;
  }
  const targetTouched = !current || "workspace" in body || "repo" in body || "cwd" in body;
  if (targetTouched) Object.assign(patch, parseTarget(body, current));
  return patch;
}

function changed(): void {
  broadcast("routines", { changedAt: Date.now() });
}

export function routinesRouter(): Router {
  const router = Router();

  router.get("/routines", (_req, res) => {
    res.json({ routines: listRoutines().map(routineView), gate: routinesGate(), schedulerGate: schedulerGate(), unread: unreadInboxCount() });
  });

  router.get("/routines/settings", (_req, res) => {
    res.json(getRoutineSettings());
  });

  router.put("/routines/settings", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const hours = body.catchUpHours;
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < CATCH_UP_HOURS_MIN || hours > CATCH_UP_HOURS_MAX) {
      res.status(400).json({ error: `catchUpHours must be an integer between ${CATCH_UP_HOURS_MIN} and ${CATCH_UP_HOURS_MAX}` });
      return;
    }
    const settings = setRoutineSettings({ catchUpHours: hours });
    changed();
    res.json(settings);
  });

  router.post("/routines/schedule/preview", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const schedule = parseSchedule(body.schedule);
    if (typeof schedule === "string") {
      res.status(400).json({ error: schedule });
      return;
    }
    const now = Date.now();
    res.json({ next: upcomingFires(schedule, now, now, PREVIEW_COUNT) });
  });

  router.get("/routines/inbox", (req, res) => {
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const unreadOnly = req.query.unread === "1" || req.query.unread === "true";
    res.json({ unread: unreadInboxCount(), items: listInbox({ unreadOnly, limit: Number.isFinite(limit) ? limit : undefined }) });
  });

  router.post("/routines/inbox/read-all", (_req, res) => {
    const changedCount = markAllInboxRead();
    const unread = unreadInboxCount();
    broadcast("routines-inbox", { unread });
    res.json({ changed: changedCount, unread });
  });

  const setRead = (read: boolean) => (req: { params: Record<string, string> }, res: Response) => {
    const id = req.params.id ?? "";
    if (!getRoutineRun(id)) {
      res.status(404).json({ error: "inbox item not found" });
      return;
    }
    const item = markInboxRead(id, read);
    if (!item) {
      res.status(409).json({ error: "the routine run is still in progress" });
      return;
    }
    const unread = unreadInboxCount();
    broadcast("routines-inbox", { unread });
    res.json({ item, unread });
  };

  router.post("/routines/inbox/:id/read", setRead(true));
  router.post("/routines/inbox/:id/unread", setRead(false));

  router.post("/routines", (req, res) => {
    try {
      const patch = parseRoutineBody(req.body as Record<string, unknown>, null) as RoutineInput;
      const routine = createRoutine(patch);
      changed();
      res.status(201).json(routineView(routine));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/routines/:id", (req, res) => {
    const routine = getRoutine(req.params.id);
    if (!routine) {
      res.status(404).json({ error: "routine not found" });
      return;
    }
    res.json({ ...routineView(routine), runs: listRoutineRuns(routine.id) });
  });

  router.get("/routines/:id/runs", (req, res) => {
    const routine = getRoutine(req.params.id);
    if (!routine) {
      res.status(404).json({ error: "routine not found" });
      return;
    }
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
    res.json(listRoutineRuns(routine.id, Number.isFinite(limit) ? limit : 50));
  });

  router.patch("/routines/:id", (req, res) => {
    const current = getRoutine(req.params.id);
    if (!current) {
      res.status(404).json({ error: "routine not found" });
      return;
    }
    try {
      const updated = updateRoutine(current.id, parseRoutineBody(req.body as Record<string, unknown>, current));
      changed();
      res.json(updated ? routineView(updated) : null);
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete("/routines/:id", (req, res) => {
    const routine = getRoutine(req.params.id);
    if (!routine) {
      res.status(404).json({ error: "routine not found" });
      return;
    }
    if (runningRoutineRun(routine.id)) {
      res.status(409).json({ error: "the routine is running; cancel its task first" });
      return;
    }
    deleteRoutine(routine.id);
    changed();
    broadcast("routines-inbox", { unread: unreadInboxCount() });
    res.json({ ok: true });
  });

  router.post("/routines/:id/run", (req, res) => {
    const routine = getRoutine(req.params.id);
    if (!routine) {
      res.status(404).json({ error: "routine not found" });
      return;
    }
    try {
      res.status(201).json(fireRoutine(routine, { trigger: "manual", dueAt: null }));
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
