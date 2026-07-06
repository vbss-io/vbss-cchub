import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";

export function ensureExtension(): void {
  if (!config.resourceDir) return;
  const src = join(config.resourceDir, "vscode-ext");
  const pkgPath = join(src, "package.json");
  const extRoot = join(homedir(), ".vscode", "extensions");
  if (!existsSync(pkgPath) || !existsSync(extRoot)) return;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      publisher: string;
      name: string;
      version: string;
    };
    const prefix = `${pkg.publisher}.${pkg.name}-`;
    const target = join(extRoot, `${prefix}${pkg.version}`);
    if (existsSync(target)) return;
    for (const dir of readdirSync(extRoot)) {
      if (dir.startsWith(prefix)) rmSync(join(extRoot, dir), { recursive: true, force: true });
    }
    mkdirSync(target, { recursive: true });
    cpSync(src, target, { recursive: true });
  } catch {
    /* best effort — extension focus is optional */
  }
}
