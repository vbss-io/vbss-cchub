import { Router } from "express";
import { delegationGuard } from "./delegation-security.js";
import { getUiPrefs, updateUiPrefs } from "./delegation-store.js";
import {
  UI_KEY_RE,
  UI_LAYOUT_MAX_KEYS,
  UI_LAYOUT_MAX_SCREENS,
  UI_LAYOUT_MAX_WIDTH,
  UI_SIDEBAR_MAX_ITEMS,
  UI_WIDTH_KEY_RE,
  type UiLayoutPrefs,
  type UiPrefsPatch,
  type UiSidebarPrefs,
} from "./delegation-types.js";
import { broadcast } from "./sse.js";

class UiPrefsError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function viewKeys(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new UiPrefsError(`${field} must be an array`);
  if (value.length > UI_SIDEBAR_MAX_ITEMS) throw new UiPrefsError(`${field} accepts at most ${UI_SIDEBAR_MAX_ITEMS} items`);
  return value.map((item) => {
    if (typeof item !== "string" || !UI_KEY_RE.test(item)) throw new UiPrefsError(`${field} items must match ${UI_KEY_RE.source}`);
    return item;
  });
}

function parseSidebar(value: unknown): UiSidebarPrefs {
  if (!isRecord(value)) throw new UiPrefsError("sidebar must be an object or null");
  return { order: viewKeys(value.order, "sidebar.order"), pinned: viewKeys(value.pinned, "sidebar.pinned") };
}

function parseLayout(value: unknown, current: UiLayoutPrefs): UiLayoutPrefs {
  if (!isRecord(value)) throw new UiPrefsError("layout must be an object");
  const layout: UiLayoutPrefs = {};
  for (const [screen, widths] of Object.entries(value)) {
    if (!UI_KEY_RE.test(screen)) throw new UiPrefsError(`layout screen keys must match ${UI_KEY_RE.source}`);
    if (!isRecord(widths)) throw new UiPrefsError(`layout.${screen} must be an object`);
    const parsed: Record<string, number> = {};
    for (const [name, width] of Object.entries(widths)) {
      if (!UI_WIDTH_KEY_RE.test(name)) throw new UiPrefsError(`layout.${screen} keys must match ${UI_WIDTH_KEY_RE.source}`);
      if (typeof width !== "number" || !Number.isFinite(width) || width < 0 || width > UI_LAYOUT_MAX_WIDTH) {
        throw new UiPrefsError(`layout.${screen}.${name} must be a number between 0 and ${UI_LAYOUT_MAX_WIDTH}`);
      }
      parsed[name] = width;
    }
    if (Object.keys({ ...current[screen], ...parsed }).length > UI_LAYOUT_MAX_KEYS) {
      throw new UiPrefsError(`layout.${screen} accepts at most ${UI_LAYOUT_MAX_KEYS} keys`);
    }
    layout[screen] = parsed;
  }
  if (new Set([...Object.keys(current), ...Object.keys(layout)]).size > UI_LAYOUT_MAX_SCREENS) {
    throw new UiPrefsError(`layout accepts at most ${UI_LAYOUT_MAX_SCREENS} screens`);
  }
  return layout;
}

function parsePatch(body: unknown): UiPrefsPatch {
  if (!isRecord(body)) throw new UiPrefsError("body must be an object");
  const patch: UiPrefsPatch = {};
  if ("sidebar" in body) patch.sidebar = body.sidebar === null ? null : parseSidebar(body.sidebar);
  if ("layout" in body) patch.layout = parseLayout(body.layout, getUiPrefs().layout);
  return patch;
}

export function uiPrefsRouter(): Router {
  const router = Router();
  router.use(delegationGuard);

  router.get("/", (_req, res) => {
    try {
      res.json(getUiPrefs());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "ui prefs read failed" });
    }
  });

  router.put("/", (req, res) => {
    let patch: UiPrefsPatch;
    try {
      patch = parsePatch(req.body);
    } catch (error) {
      if (error instanceof UiPrefsError) {
        res.status(400).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : "ui prefs read failed" });
      return;
    }
    try {
      const updated = updateUiPrefs(patch);
      broadcast("ui-prefs", updated);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "ui prefs write failed" });
    }
  });

  return router;
}
