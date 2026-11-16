import type { CostTotals, RunCostFields } from "./types";

export type CostShape = Pick<CostTotals, "costUsd" | "tokensIn" | "tokensOut">;

export const emptyCost: CostTotals = { costUsd: null, tokensIn: null, tokensOut: null, runs: 0, pricedRuns: 0 };

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  if (value >= 100) return `$${Math.round(value).toLocaleString("en-US")}`;
  return `$${value.toFixed(2)}`;
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${trim(value / 1000)}k`;
  return `${trim(value / 1_000_000)}M`;
}

const trim = (value: number): string => {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return String(rounded);
};

export function tokensLabel(cost: Pick<CostTotals, "tokensIn" | "tokensOut">): string | null {
  const parts: string[] = [];
  if (cost.tokensIn !== null) parts.push(`${formatTokenCount(cost.tokensIn)} in`);
  if (cost.tokensOut !== null) parts.push(`${formatTokenCount(cost.tokensOut)} out`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function costLabel(cost: CostShape | null | undefined): string | null {
  if (!cost) return null;
  if (cost.costUsd !== null) return formatUsd(cost.costUsd);
  return tokensLabel(cost);
}

export function costTitle(cost: CostTotals | null | undefined): string | undefined {
  if (!cost || cost.runs === 0) return undefined;
  const lines = [`${cost.runs} run${cost.runs === 1 ? "" : "s"}`];
  if (cost.costUsd !== null) lines.push(cost.pricedRuns < cost.runs ? `${cost.pricedRuns} of ${cost.runs} priced` : "all priced");
  const tokens = tokensLabel(cost);
  if (tokens !== null) lines.push(`tokens ${tokens}`);
  return lines.join(" · ");
}

export function sumCosts(runs: readonly RunCostFields[]): CostTotals {
  let costUsd: number | null = null;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let pricedRuns = 0;
  for (const run of runs) {
    if (run.costUsd !== null) {
      costUsd = (costUsd ?? 0) + run.costUsd;
      pricedRuns += 1;
    }
    if (run.tokensIn !== null) tokensIn = (tokensIn ?? 0) + run.tokensIn;
    if (run.tokensOut !== null) tokensOut = (tokensOut ?? 0) + run.tokensOut;
  }
  return { costUsd, tokensIn, tokensOut, runs: runs.length, pricedRuns };
}

export const hasCost = (cost: CostShape | null | undefined): boolean => costLabel(cost) !== null;

export const mergeCostMaps = (previous: Readonly<Record<string, CostTotals>>, next: Readonly<Record<string, CostTotals>>): Record<string, CostTotals> => ({ ...previous, ...next });

export const missingCostIds = (ids: readonly string[], known: Readonly<Record<string, CostTotals>>): string[] => [...new Set(ids)].filter((id) => !Object.hasOwn(known, id));
