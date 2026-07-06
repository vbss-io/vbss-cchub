import { homedir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

const dataDir = process.env.HUB_DATA_DIR ?? join(homedir(), ".vbss-cchub");

export const config = {
  host: process.env.HUB_HOST ?? "0.0.0.0",
  port: Number(process.env.HUB_PORT ?? 4317),
  dataDir,
  dbPath: join(dataDir, "hub.db"),
  staticDir: process.env.HUB_STATIC_DIR ?? null,
  resourceDir: process.env.HUB_RESOURCE_DIR ?? null,
  nodeBin: execPath,
} as const;
