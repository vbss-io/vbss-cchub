import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = process.env.HUB_DATA_DIR ?? join(homedir(), ".vbss-cchub");

export const config = {
  host: process.env.HUB_HOST ?? "0.0.0.0",
  port: Number(process.env.HUB_PORT ?? 4317),
  dataDir,
  dbPath: join(dataDir, "hub.db"),
  staticDir: process.env.HUB_STATIC_DIR ?? null,
} as const;
