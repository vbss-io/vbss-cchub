import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { claudeForecastLine, codexForecastLine, providerForecastLine, windowLine } from "./forecast-model";
import type { LimitsForecast, WindowForecast } from "./types";

const at = (hour: number, minute = 0): number => new Date(2026, 10, 16, hour, minute).getTime();

const window = (patch: Partial<WindowForecast> = {}): WindowForecast => ({
  series: "claude.fiveHour",
  usedPercent: 60,
  ratePerHour: 20,
  exhaustsAt: at(16, 42),
  resetsAt: at(18, 0),
  exhaustsBeforeReset: true,
  samples: 5,
  spanMinutes: 40,
  ...patch,
});

const forecast = (patch: Partial<LimitsForecast["claude"]> = {}, codex: Partial<LimitsForecast["codex"]> = {}): LimitsForecast => ({
  claude: { fiveHour: null, sevenDay: null, ...patch },
  codex: { primary: null, secondary: null, ...codex },
});

describe("windowLine", () => {
  const now = at(14, 0);

  it("says when the window runs out in local time", () => {
    assert.equal(windowLine(window(), "5h", now), "At this pace the 5h window runs out at 16:42");
  });

  it("shows nothing without a forecast", () => {
    assert.equal(windowLine(null, "5h", now), null);
    assert.equal(windowLine(undefined, "5h", now), null);
  });

  it("shows nothing when the window resets before it runs out", () => {
    assert.equal(windowLine(window({ exhaustsBeforeReset: false }), "5h", now), null);
  });

  it("shows nothing for a time already in the past", () => {
    assert.equal(windowLine(window({ exhaustsAt: at(13, 0) }), "5h", now), null);
  });
});

describe("provider lines", () => {
  const now = at(14, 0);

  it("reads the Claude five hour window only", () => {
    assert.equal(claudeForecastLine(forecast({ fiveHour: window() }), now), "At this pace the 5h window runs out at 16:42");
    assert.equal(claudeForecastLine(forecast({ sevenDay: window({ series: "claude.sevenDay" }) }), now), null);
  });

  it("reads the Codex primary window", () => {
    assert.equal(codexForecastLine(forecast({}, { primary: window({ series: "codex.primary", exhaustsAt: at(15, 5) }) }), now), "At this pace the 5h window runs out at 15:05");
    assert.equal(codexForecastLine(forecast(), now), null);
  });

  it("picks by provider and tolerates a missing forecast", () => {
    assert.equal(providerForecastLine("claude", null, now), null);
    assert.equal(providerForecastLine("codex", undefined, now), null);
    assert.equal(providerForecastLine("claude", forecast({ fiveHour: window() }), now)?.includes("16:42"), true);
  });
});
