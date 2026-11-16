import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { LimitsPayload } from "../src/limits.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-forecast-"));
process.env.HUB_DATA_DIR = dataDir;

type Forecast = typeof import("../src/limits-forecast.js");
let forecast: Forecast;

before(async () => {
  forecast = await import("../src/limits-forecast.js");
});

after(async () => {
  (await import("../src/db.js")).db.close();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    void 0;
  }
});

const MIN = 60_000;
const T0 = 1_900_000_000_000;
const RESET = T0 + 4 * 60 * MIN;

describe("limit forecast", () => {
  it("returns nothing without enough samples", () => {
    assert.equal(forecast.forecastWindow("claude.fiveHour", [], T0), null);
    assert.equal(forecast.forecastWindow("claude.fiveHour", [{ at: T0, used: 10, resetsAt: RESET }, { at: T0 + 20 * MIN, used: 20, resetsAt: RESET }], T0 + 20 * MIN), null);
  });

  it("returns nothing when the samples span less than 10 minutes", () => {
    const samples = [0, 3, 6, 9].map((minute, index) => ({ at: T0 + minute * MIN, used: 10 + index, resetsAt: RESET }));
    assert.equal(forecast.forecastWindow("claude.fiveHour", samples, T0 + 9 * MIN), null);
  });

  it("returns nothing when usage is flat", () => {
    const samples = [0, 10, 20].map((minute) => ({ at: T0 + minute * MIN, used: 30, resetsAt: RESET }));
    assert.equal(forecast.forecastWindow("claude.fiveHour", samples, T0 + 20 * MIN), null);
  });

  it("projects when the window reaches 100% at the current pace", () => {
    const samples = [0, 10, 20].map((minute, index) => ({ at: T0 + minute * MIN, used: 40 + index * 10, resetsAt: RESET }));
    const result = forecast.forecastWindow("claude.fiveHour", samples, T0 + 20 * MIN);
    assert.ok(result);
    assert.equal(result.usedPercent, 60);
    assert.equal(result.ratePerHour, 60);
    assert.equal(result.exhaustsAt, T0 + 60 * MIN);
    assert.equal(result.exhaustsBeforeReset, true);
    assert.equal(result.samples, 3);
    assert.equal(result.spanMinutes, 20);
  });

  it("flags a pace that lasts past the reset", () => {
    const samples = [0, 10, 20].map((minute, index) => ({ at: T0 + minute * MIN, used: 10 + index, resetsAt: T0 + 30 * MIN }));
    assert.equal(forecast.forecastWindow("claude.fiveHour", samples, T0 + 20 * MIN)?.exhaustsBeforeReset, false);
  });

  it("uses only the current window: a new reset time or a drop starts over", () => {
    const old = [0, 10, 20].map((minute) => ({ at: T0 + minute * MIN, used: 80 + minute / 10, resetsAt: T0 - 60 * MIN }));
    const fresh = [30, 35].map((minute, index) => ({ at: T0 + minute * MIN, used: 1 + index, resetsAt: RESET }));
    assert.equal(forecast.forecastWindow("claude.fiveHour", [...old, ...fresh], T0 + 35 * MIN), null);
    const dropped = [
      { at: T0, used: 90, resetsAt: null },
      { at: T0 + 10 * MIN, used: 95, resetsAt: null },
      { at: T0 + 20 * MIN, used: 2, resetsAt: null },
      { at: T0 + 25 * MIN, used: 3, resetsAt: null },
    ];
    assert.deepEqual(forecast.currentWindowSamples(dropped).map((sample) => sample.used), [2, 3]);
  });

  it("records samples from live limits only and forecasts from the store", () => {
    const payload = (at: number, used: number): LimitsPayload => ({
      updatedAt: at,
      claude: { source: "statusline", fetchedAt: at, stale: false, fiveHour: { utilization: used, resetsAt: RESET, reset: false }, sevenDay: { utilization: 5, resetsAt: RESET + 1000, reset: false }, models: [], extra: null, error: null },
      codex: { source: "none", fetchedAt: null, stale: true, primary: { usedPercent: 0, resetsAt: null, reset: false }, secondary: { usedPercent: 0, resetsAt: null, reset: false }, planType: null, error: "no Codex session data found" },
    });
    assert.equal(forecast.recordLimitsPayload(payload(T0, 20), T0), 2);
    const empty = forecast.limitsForecast(payload(T0, 20), T0);
    assert.equal(empty.claude.fiveHour, null);
    forecast.recordLimitsPayload(payload(T0 + 10 * MIN, 30), T0 + 10 * MIN);
    forecast.recordLimitsPayload(payload(T0 + 10 * MIN, 30), T0 + 10 * MIN);
    forecast.recordLimitsPayload(payload(T0 + 20 * MIN, 40), T0 + 20 * MIN);
    const result = forecast.limitsForecast(payload(T0 + 20 * MIN, 40), T0 + 20 * MIN);
    assert.equal(result.claude.fiveHour?.samples, 3);
    assert.equal(result.claude.fiveHour?.exhaustsAt, T0 + 80 * MIN);
    assert.equal(result.claude.sevenDay, null);
    assert.equal(result.codex.primary, null);
    const live = payload(T0, 1);
    const cached: LimitsPayload = { ...live, claude: live.claude ? { ...live.claude, source: "cache" } : null };
    assert.equal(forecast.samplesFromPayload(cached).length, 0);
  });
});
