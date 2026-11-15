import { Router } from "express";
import { resolve } from "node:path";
import { listCodexSessions } from "./codex-store.js";
import { listClaims, listSessions } from "./db.js";
import { runtimeSnapshot } from "./runtimes.js";
import { getSettings, listReports, listTasks } from "./delegation-store.js";
import type { TaskRecord } from "./delegation-types.js";
import { discoverWorkspaces, workspaceFor } from "./workspaces.js";
import { sendError, clipText } from "./route-helpers.js";

export function overviewRouter(): Router {
  const router = Router();

  router.get("/overview", (_req, res) => {
    runtimeSnapshot()
      .then((runtimes) => {
        const workspaces = discoverWorkspaces(getSettings().workspacesRoot);
        const sessions = listSessions().filter((session) => session.archivedAt == null);
        const live = sessions.filter((session) => session.status !== "ended" && !session.stale);
        const counts = { active: 0, waiting: 0, idle: 0, stale: 0, ended: 0 };
        const byClient: Record<string, number> = {};
        for (const session of sessions) {
          if (session.status === "ended") counts.ended += 1;
          else if (session.stale) counts.stale += 1;
          else counts[session.status] += 1;
          if (session.status !== "ended" && !session.stale) {
            const key = session.client ?? "unknown";
            byClient[key] = (byClient[key] ?? 0) + 1;
          }
        }
        const brief = (session: (typeof sessions)[number]) => ({
          sessionId: session.sessionId,
          title: session.customTitle ?? session.title,
          status: session.status,
          client: session.client,
          workspace: workspaceFor(workspaces, session.cwd)?.name ?? null,
          cwd: session.cwd,
          source: session.source,
          model: session.model,
          lastMessage: session.lastMessage,
          agentsRunning: session.agentsRunning,
          agentsTotal: session.agentsTotal,
          updatedAt: session.updatedAt,
        });
        const tasks = listTasks({ limit: 100 });
        const taskBrief = (task: TaskRecord) => ({
          id: task.id,
          title: task.title,
          prompt: clipText(task.prompt, 200),
          workspace: task.workspace,
          repo: task.repo,
          runner: task.runner,
          status: task.status,
          sessionId: task.sessionId,
          createdBy: task.createdBy,
          originSessionId: task.originSessionId,
          originClient: task.originClient,
          isolation: task.isolation,
          branch: task.branch,
          lastError: task.lastError ? clipText(task.lastError, 300) : null,
          runsCount: task.runsCount,
          reposAttached: task.addDirs.length,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        });
        const crowd = new Map<string, { path: string; agents: number }>();
        const bump = (cwd: string | null): void => {
          if (!cwd) return;
          const key = process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
          const entry = crowd.get(key);
          if (entry) entry.agents += 1;
          else crowd.set(key, { path: cwd, agents: 1 });
        };
        for (const session of live) if (session.helperOf == null) bump(session.cwd);
        for (const task of tasks) {
          if ((task.status === "running" || task.status === "pending") && task.isolation === "shared") bump(task.cwd);
        }
        const crowdedFolders = [...crowd.values()].filter((folder) => folder.agents >= 2);
        res.json({
          runtimes,
          sessions: {
            counts,
            byClient,
            attention: live.filter((s) => s.status === "waiting" || s.status === "idle").slice(0, 20).map(brief),
            active: live.filter((s) => s.status === "active").slice(0, 20).map(brief),
            note: "counts ignore sessions whose Claude process died or that went silent for hours; stale ones are counted separately",
          },
          codexSessions: listCodexSessions()
            .filter((s) => s.status !== "ended")
            .slice(0, 20)
            .map((s) => ({ ...s, workspace: workspaceFor(workspaces, s.cwd)?.name ?? null })),
          tasks: {
            inFlight: tasks.filter((t) => t.status === "running" || t.status === "pending").map(taskBrief),
            attention: tasks.filter((t) => t.status === "attention" || t.status === "failed" || t.status === "interrupted").slice(0, 20).map(taskBrief),
            recent: tasks.slice(0, 10).map(taskBrief),
            note: "task entries are brief; use hub_task for the full prompt, run log and attached repos",
          },
          crowdedFolders,
          delegation: { autonomy: getSettings().autonomy, note: getSettings().autonomy === "full" ? "delegations run without permission prompts; do not pass permissionMode unless you want plan mode" : "delegations run with acceptEdits and can stop in Needs you; ask the owner to switch Autonomy to full in Settings" },
          claims: listClaims().map((claim) => ({
            id: claim.id,
            sessionTitle: claim.sessionTitle,
            repoPath: claim.repoPath,
            paths: claim.paths,
            note: claim.note,
            expiresAt: claim.expiresAt,
          })),
          reports: listReports({ limit: 10 }),
          workspaces: workspaces.map((w) => ({ name: w.name, repos: w.repos.length })),
        });
      })
      .catch((err: unknown) => sendError(res, err));
  });

  return router;
}
