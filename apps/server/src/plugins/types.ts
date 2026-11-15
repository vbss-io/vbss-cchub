import type { Router } from "express";
import type { DelegationFeatures } from "../delegation-types.js";

export type ServerPluginId = "core" | "today" | "tasks" | "delegated" | "usage" | "limits" | "workspaces" | "reports" | "share" | "trail";

export type FeatureKey = keyof DelegationFeatures;

export interface PluginManifest {
  id: ServerPluginId;
  name: string;
  featureKey: FeatureKey | null;
  tools: readonly string[];
}

export interface PluginRoute {
  order: number;
  mount: string;
  router: (plugins: readonly PluginManifest[]) => Router;
}

export interface ServerPlugin extends PluginManifest {
  routes: readonly PluginRoute[];
}

export interface PluginView {
  id: ServerPluginId;
  name: string;
  enabled: boolean;
  tools: string[];
}
