import { Router } from "express";
import { getSettings } from "./delegation-store.js";
import { createWorkspace, deleteWorkspace, discoverWorkspaces, findWorkspace, openWorkspace, updateWorkspace } from "./workspaces.js";
import { asString, asStringArray } from "./route-helpers.js";

export function workspacesRouter(): Router {
  const router = Router();

  router.get("/workspaces", (_req, res) => {
    res.json(discoverWorkspaces(getSettings().workspacesRoot));
  });

  router.post("/workspaces", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const root = getSettings().workspacesRoot;
    const name = asString(body.name);
    if (!root) {
      res.status(400).json({ error: "set the workspaces root first" });
      return;
    }
    if (!name) {
      res.status(400).json({ error: "name required" });
      return;
    }
    try {
      res.status(201).json(createWorkspace(root, name.trim(), asStringArray(body.repos)));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "could not create workspace" });
    }
  });

  router.put("/workspaces/:name", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const root = getSettings().workspacesRoot;
    if (!root) {
      res.status(400).json({ error: "set the workspaces root first" });
      return;
    }
    try {
      res.json(updateWorkspace(root, req.params.name, asStringArray(body.repos)));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "could not update workspace" });
    }
  });

  router.delete("/workspaces/:name", (req, res) => {
    const root = getSettings().workspacesRoot;
    if (!root) {
      res.status(400).json({ error: "set the workspaces root first" });
      return;
    }
    try {
      res.json(deleteWorkspace(root, req.params.name, req.query.context === "1" || req.query.context === "true"));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "could not delete workspace" });
    }
  });

  router.post("/workspaces/:name/open", (req, res) => {
    const settings = getSettings();
    const workspace = findWorkspace(settings.workspacesRoot, req.params.name);
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }
    const outcome = openWorkspace(workspace.file, settings.editorCommand);
    res.status(outcome.ok ? 200 : 500).json(outcome);
  });

  return router;
}
