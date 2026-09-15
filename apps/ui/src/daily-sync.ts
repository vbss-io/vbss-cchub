import type { DailyStreamEvent } from "./api";

export interface DailyEventState {
  ownWriteIds: Set<string>;
  dirty: boolean;
  saving: boolean;
}

export type DailyEventDecision = "ignore" | "reload" | "conflict" | "defer";

export function decideDailyEvent(event: DailyStreamEvent, state: DailyEventState): DailyEventDecision {
  if (event.writeId !== null && state.ownWriteIds.has(event.writeId)) return "ignore";
  if (state.saving) return "defer";
  return state.dirty ? "conflict" : "reload";
}

const MAX_OWN_WRITE_IDS = 50;

export function rememberWriteId(ids: Set<string>, order: string[], writeId: string): void {
  ids.add(writeId);
  order.push(writeId);
  if (order.length > MAX_OWN_WRITE_IDS) {
    const oldest = order.shift();
    if (oldest !== undefined) ids.delete(oldest);
  }
}

export function generateWriteId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}
