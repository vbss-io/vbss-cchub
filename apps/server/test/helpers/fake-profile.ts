import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface FakeProfileEnv {
  LOCALAPPDATA: string;
  APPDATA: string;
  PSModuleAnalysisCachePath: string;
}

export function fakeProfileEnv(home: string): FakeProfileEnv {
  const local = join(home, "AppData", "Local");
  const roaming = join(home, "AppData", "Roaming");
  mkdirSync(local, { recursive: true });
  mkdirSync(roaming, { recursive: true });
  return { LOCALAPPDATA: local, APPDATA: roaming, PSModuleAnalysisCachePath: join(local, "PowerShell-ModuleAnalysisCache") };
}
