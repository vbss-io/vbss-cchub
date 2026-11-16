import { existsSync, statSync } from "node:fs";
import { findCodexRollout } from "./codex-sessions.js";
import { deleteCodexRolloutMark, getCodexRolloutMark, saveCodexRolloutMark } from "./delegation-store.js";

interface RolloutState {
  file: string;
  size: number;
  mtimeMs: number;
}

function stateOf(file: string | null): RolloutState | null {
  if (!file || !existsSync(file)) return null;
  const stat = statSync(file);
  return { file, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
}

export function markCodexRolloutAfterRun(threadId: string | null): void {
  if (!threadId) return;
  try {
    const state = stateOf(findCodexRollout(threadId));
    if (state) saveCodexRolloutMark({ threadId, ...state });
    else deleteCodexRolloutMark(threadId);
  } catch (err) {
    console.error(`codex rollout mark for ${threadId} not recorded: ${String(err)}`);
  }
}

export function rolloutChangedSinceHubRun(threadId: string): boolean {
  const mark = getCodexRolloutMark(threadId);
  if (!mark) return false;
  const state = stateOf(existsSync(mark.file) ? mark.file : findCodexRollout(threadId));
  if (!state) return false;
  return state.size !== mark.size || state.mtimeMs !== mark.mtimeMs;
}
