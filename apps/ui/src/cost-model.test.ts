import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { costLabel, costTitle, formatTokenCount, formatUsd, hasCost, mergeCostMaps, missingCostIds, sumCosts, tokensLabel } from "./cost-model";
import type { CostTotals, RunCostFields } from "./types";

const run = (patch: Partial<RunCostFields> = {}): RunCostFields => ({ costUsd: null, tokensIn: null, tokensOut: null, startCommit: null, ...patch });

const totals = (patch: Partial<CostTotals> = {}): CostTotals => ({ costUsd: null, tokensIn: null, tokensOut: null, runs: 0, pricedRuns: 0, ...patch });

describe("formatUsd", () => {
  it("shows cents for normal amounts", () => {
    assert.equal(formatUsd(0.4231), "$0.42");
    assert.equal(formatUsd(12.5), "$12.50");
  });

  it("marks tiny amounts and rounds big ones", () => {
    assert.equal(formatUsd(0.004), "<$0.01");
    assert.equal(formatUsd(1234.6), "$1,235");
  });

  it("shows zero for zero and bad numbers", () => {
    assert.equal(formatUsd(0), "$0.00");
    assert.equal(formatUsd(Number.NaN), "$0.00");
  });
});

describe("formatTokenCount", () => {
  it("scales to k and M", () => {
    assert.equal(formatTokenCount(999), "999");
    assert.equal(formatTokenCount(1500), "1.5k");
    assert.equal(formatTokenCount(48_000), "48k");
    assert.equal(formatTokenCount(1_250_000), "1.3M");
    assert.equal(formatTokenCount(250_000), "250k");
  });
});

describe("costLabel", () => {
  it("prefers USD when the run has a price", () => {
    assert.equal(costLabel(totals({ costUsd: 0.42, tokensIn: 1000, tokensOut: 500, runs: 1, pricedRuns: 1 })), "$0.42");
  });

  it("falls back to tokens when there is no price", () => {
    assert.equal(costLabel(totals({ tokensIn: 12_300, tokensOut: 4500, runs: 1 })), "12.3k in · 4.5k out");
    assert.equal(costLabel(totals({ tokensOut: 800, runs: 1 })), "800 out");
  });

  it("is empty without any data", () => {
    assert.equal(costLabel(totals({ runs: 2 })), null);
    assert.equal(costLabel(null), null);
    assert.equal(costLabel(undefined), null);
    assert.equal(hasCost(totals()), false);
    assert.equal(hasCost(totals({ costUsd: 0.1, runs: 1, pricedRuns: 1 })), true);
  });
});

describe("tokensLabel", () => {
  it("lists only the known sides", () => {
    assert.equal(tokensLabel({ tokensIn: 2000, tokensOut: null }), "2k in");
    assert.equal(tokensLabel({ tokensIn: null, tokensOut: null }), null);
  });
});

describe("sumCosts", () => {
  it("adds USD and tokens across runs and counts priced runs", () => {
    const sum = sumCosts([run({ costUsd: 0.5, tokensIn: 1000, tokensOut: 100 }), run({ costUsd: 0.25, tokensIn: 500, tokensOut: 50 }), run({ tokensIn: 200 })]);
    assert.deepEqual(sum, { costUsd: 0.75, tokensIn: 1700, tokensOut: 150, runs: 3, pricedRuns: 2 });
  });

  it("keeps USD empty when no run has a price (Codex)", () => {
    const sum = sumCosts([run({ tokensIn: 100, tokensOut: 10 }), run({ tokensIn: 50, tokensOut: 5 })]);
    assert.deepEqual(sum, { costUsd: null, tokensIn: 150, tokensOut: 15, runs: 2, pricedRuns: 0 });
    assert.equal(costLabel(sum), "150 in · 15 out");
  });

  it("sums an empty list to an empty total", () => {
    assert.deepEqual(sumCosts([]), { costUsd: null, tokensIn: null, tokensOut: null, runs: 0, pricedRuns: 0 });
  });
});

describe("costTitle", () => {
  it("explains partial pricing and tokens", () => {
    assert.equal(costTitle(totals({ costUsd: 1, tokensIn: 3000, tokensOut: 400, runs: 3, pricedRuns: 2 })), "3 runs · 2 of 3 priced · tokens 3k in · 400 out");
    assert.equal(costTitle(totals({ costUsd: 1, runs: 1, pricedRuns: 1 })), "1 run · all priced");
  });

  it("has no title for an empty total", () => {
    assert.equal(costTitle(totals()), undefined);
    assert.equal(costTitle(null), undefined);
  });
});

describe("cost maps", () => {
  it("merges new totals over old ones", () => {
    const merged = mergeCostMaps({ a: totals({ runs: 1 }), b: totals({ runs: 1 }) }, { b: totals({ runs: 2 }) });
    assert.equal(merged.a?.runs, 1);
    assert.equal(merged.b?.runs, 2);
  });

  it("asks only for task ids it does not know yet, once each", () => {
    assert.deepEqual(missingCostIds(["a", "b", "b", "c"], { a: totals() }), ["b", "c"]);
  });
});
