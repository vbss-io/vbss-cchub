import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const run = promisify(execFile);

const ALLOWED_PREFIXES = ["vscode://anthropic.claude-code/open?", "codex://threads/"];

export interface OpenUrlResult {
  ok: boolean;
  url: string;
  reason?: string;
}

export const vscodeSessionUrl = (sessionId: string): string => `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`;

export const codexThreadUrl = (threadId: string): string => `codex://threads/${encodeURIComponent(threadId)}`;

function platformOpener(): string[] {
  if (process.platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler"];
  if (process.platform === "darwin") return ["open"];
  return ["xdg-open"];
}

export async function openUrl(url: string): Promise<OpenUrlResult> {
  if (!ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))) return { ok: false, url, reason: "link scheme not allowed" };
  const [bin, ...args] = config.urlOpener.length > 0 ? config.urlOpener : platformOpener();
  if (!bin) return { ok: false, url, reason: "no url opener" };
  try {
    await run(bin, [...args, url], { windowsHide: true, timeout: 10_000 });
    return { ok: true, url };
  } catch {
    return { ok: false, url, reason: "the link could not be opened" };
  }
}
