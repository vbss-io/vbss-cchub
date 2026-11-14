import { isViewEnabled, pluginById, viewItem } from "./registry";
import type { FeatureFlags } from "./types";

export const disabledTarget = (view: string, features: FeatureFlags): string | null => {
  const item = viewItem(view);
  if (!item || isViewEnabled(view, features)) return null;
  return pluginById(item.pluginId)?.name ?? null;
};
