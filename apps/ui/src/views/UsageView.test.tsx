import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLimits, fetchUsage, refreshLimits, rescanUsage, type ClaudeLimits, type CodexLimits, type LimitsSnapshot } from "../delegation";
import { NOW, sessionRecord, usageReport, usageSession, usageSettings, usageTotals } from "../test-support/u4-fixtures";
import type { LimitsForecast } from "../types";
import { useLimitsForecast } from "../use-ops";
import { UsageView, type UsageEvent } from "./UsageView";

vi.mock("../delegation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../delegation")>()),
  fetchLimits: vi.fn(),
  fetchUsage: vi.fn(),
  refreshLimits: vi.fn(),
  rescanUsage: vi.fn(),
}));

vi.mock("../use-ops", () => ({ useLimitsForecast: vi.fn() }));

const usageMock = vi.mocked(fetchUsage);
const limitsMock = vi.mocked(fetchLimits);
const refreshMock = vi.mocked(refreshLimits);
const rescanMock = vi.mocked(rescanUsage);
const forecastMock = vi.mocked(useLimitsForecast);

let listeners: Set<(event: UsageEvent) => void>;

const flush = async (ms = 0): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStorage.clear();
  listeners = new Set();
  for (const mock of [usageMock, limitsMock, refreshMock, rescanMock, forecastMock]) mock.mockReset();
  usageMock.mockResolvedValue(usageReport());
  limitsMock.mockResolvedValue(null);
  forecastMock.mockReturnValue(null);
  rescanMock.mockResolvedValue({ files: 3 });
});

afterEach(() => {
  vi.useRealTimers();
});

type Props = Parameters<typeof UsageView>[0];

const baseProps = (): Props => ({
  settings: usageSettings(),
  sessions: {},
  onOpenSession: vi.fn(),
  subscribeUsage: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
});

const setup = async (overrides: Partial<Props> = {}) => {
  const props = { ...baseProps(), ...overrides };
  const view = render(<UsageView {...props} />);
  await flush();
  return { props, ...view };
};

const claude = (overrides: Partial<ClaudeLimits> = {}): ClaudeLimits => ({
  source: "api",
  fetchedAt: NOW - 120_000,
  fiveHour: { utilization: 42, resetsAt: NOW + 2 * 3_600_000 },
  sevenDay: { utilization: 95, resetsAt: NOW + 3 * 86_400_000 },
  models: [{ name: "Opus", utilization: 30, resetsAt: NOW + 86_400_000 }, { name: "Sonnet", utilization: 10, resetsAt: null }],
  extra: { enabled: true, utilization: 12.4 },
  error: null,
  ...overrides,
});

const codex = (overrides: Partial<CodexLimits> = {}): CodexLimits => ({
  source: "rollout",
  fetchedAt: NOW - 3_600_000,
  primary: { usedPercent: 75, resetsAt: NOW + 3_600_000 },
  secondary: { usedPercent: 5, resetsAt: null },
  planType: "plus",
  error: null,
  ...overrides,
});

const snapshot = (overrides: Partial<LimitsSnapshot> = {}): LimitsSnapshot => ({ updatedAt: NOW, claude: claude(), codex: codex(), ...overrides });

const menu = (label: string) => {
  if (!screen.queryByRole("menu")) fireEvent.click(screen.getByRole("button", { name: "Usage actions" }));
  return screen.getByRole("menuitem", { name: label });
};

describe("UsageView loading and errors", () => {
  it("shows the scanning hint until the first report", async () => {
    usageMock.mockReturnValue(new Promise(() => undefined));
    await setup();
    expect(screen.getByText("Scanning transcripts...")).toBeTruthy();
  });

  it("reports an error and the missing hub message for a 404", async () => {
    usageMock.mockRejectedValue(new Error("failed (500)"));
    const first = await setup();
    expect(screen.getByText("Could not load usage: failed (500)")).toBeTruthy();
    first.unmount();
    usageMock.mockRejectedValue(new Error("not found (404)"));
    const second = await setup();
    expect(screen.getByText("Usage needs a newer hub.")).toBeTruthy();
    second.unmount();
    usageMock.mockRejectedValue("odd");
    await setup();
    expect(screen.getByText("Could not load usage: request failed")).toBeTruthy();
  });

  it("says there are no transcripts for an empty report", async () => {
    usageMock.mockResolvedValue(usageReport({ totals: usageTotals({ messages: 0 }) }));
    await setup();
    expect(screen.getByText("No transcripts in the last 7 days")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("polls while the server scans and shows the report when it finishes", async () => {
    usageMock.mockResolvedValueOnce({ scanning: true, startedAt: NOW, files: 1234 });
    await setup();
    expect(screen.getByRole("status").textContent).toContain("Scanning transcripts…");
    expect(screen.getByRole("status").textContent).toMatch(/1[.,]234 files/);
    usageMock.mockResolvedValue(usageReport());
    await flush(3000);
    expect(usageMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Scanning transcripts…/)).toBeNull();
    expect(document.querySelector(".usage__tiles")).toBeTruthy();
  });

  it("omits the file count when the scan does not report it", async () => {
    usageMock.mockResolvedValueOnce({ scanning: true, startedAt: null, files: null });
    await setup();
    expect(screen.getByRole("status").textContent).not.toContain("files");
  });

  it("ignores a response that was superseded by a newer request", async () => {
    let resolveFirst: (value: ReturnType<typeof usageReport>) => void = () => undefined;
    usageMock.mockReturnValueOnce(new Promise((done) => (resolveFirst = done)));
    const { props } = await setup();
    usageMock.mockResolvedValue(usageReport({ totals: usageTotals({ messages: 0 }) }));
    fireEvent.click(screen.getByRole("radio", { name: "14 days" }));
    await flush();
    resolveFirst(usageReport());
    await flush();
    expect(screen.getByText("No transcripts in the last 14 days")).toBeTruthy();
    expect(props.onOpenSession).not.toHaveBeenCalled();
  });
});

describe("UsageView period", () => {
  it("defaults from the settings, rounding up to an option", async () => {
    await setup({ settings: usageSettings({ days: 10 }) });
    expect(usageMock).toHaveBeenCalledWith(14);
    expect(screen.getByRole("radio", { name: "14 days" }).getAttribute("aria-checked")).toBe("true");
  });

  it("falls back to 7 days without settings and caps at 30", async () => {
    const first = await setup({ settings: null });
    expect(usageMock).toHaveBeenLastCalledWith(7);
    first.unmount();
    await setup({ settings: usageSettings({ days: 90 }) });
    expect(usageMock).toHaveBeenLastCalledWith(30);
  });

  it("falls back to 7 days for a non finite setting", async () => {
    await setup({ settings: usageSettings({ days: Number.NaN }) });
    expect(usageMock).toHaveBeenLastCalledWith(7);
  });

  it("changes the period, refetches and remembers the choice", async () => {
    const first = await setup();
    fireEvent.click(screen.getByRole("radio", { name: "30 days" }));
    await flush();
    expect(usageMock).toHaveBeenLastCalledWith(30);
    expect(localStorage.getItem("hub.usage.days")).toBe("30");
    first.unmount();
    await setup();
    expect(screen.getByRole("radio", { name: "30 days" }).getAttribute("aria-checked")).toBe("true");
  });

  it("ignores a stored period that is not an option and survives blocked storage", async () => {
    localStorage.setItem("hub.usage.days", "99");
    const first = await setup();
    expect(usageMock).toHaveBeenLastCalledWith(7);
    first.unmount();
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await setup();
    fireEvent.click(screen.getByRole("radio", { name: "14 days" }));
    await flush();
    expect(usageMock).toHaveBeenLastCalledWith(14);
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe("UsageView summary and chart", () => {
  it("shows the totals, the subagent share and the context percentiles", async () => {
    await setup();
    expect(screen.getByText("3.0M", { selector: ".usage__tile-v" })).toBeTruthy();
    expect(screen.getByText("Claude 2.0M · Codex 1.0M")).toBeTruthy();
    expect(screen.getByText("120k")).toBeTruthy();
    expect(screen.getByText("fresh input 150k")).toBeTruthy();
    expect(screen.getByText("360")).toBeTruthy();
    expect(screen.getByText("subagents: 25 %")).toBeTruthy();
    expect(screen.getByText("90k · 400k · 800k")).toBeTruthy();
    expect(screen.getByText("scanned 5m ago")).toBeTruthy();
  });

  it("marks a high p90 context with the warning tone and explains it", async () => {
    await setup();
    const tile = screen.getByText("90k · 400k · 800k").closest(".usage__tile") as HTMLElement;
    expect(tile.className).toContain("usage__tile--pend");
    fireEvent.click(screen.getByRole("button", { name: "About context per message" }));
    expect(screen.getByText(/12 messages above 300k · 3 above 600k/)).toBeTruthy();
  });

  it("uses the hold tone above 600k", async () => {
    usageMock.mockResolvedValue(usageReport({ context: { avgPerMessage: 1, p50: 1, p90: 700_000, max: 900_000, over300k: 1, over600k: 1 } }));
    await setup();
    expect((screen.getByText(/700k/, { selector: ".usage__tile-v" }).closest(".usage__tile") as HTMLElement).className).toContain("usage__tile--hold");
  });

  it("draws one bar per day with the provider split in the title", async () => {
    await setup();
    const columns = document.querySelectorAll(".usage__col");
    expect(columns).toHaveLength(2);
    expect(columns[0]?.getAttribute("title")).toBe("2026-11-14\nClaude 500k read, 10 msgs\nCodex 250k read, 5 msgs");
    expect(columns[0]?.querySelector(".usage__day")?.textContent).toBe("14");
    expect((columns[1]?.querySelector(".usage__seg--claude") as HTMLElement).style.height).toBe("100%");
    expect(screen.getByText("tokens read per day")).toBeTruthy();
  });

  it("draws an empty chart for no days", async () => {
    usageMock.mockResolvedValue(usageReport({ byDay: [] }));
    await setup();
    expect(document.querySelectorAll(".usage__col")).toHaveLength(0);
  });
});

describe("UsageView breakdown", () => {
  const rowsOf = (): string[][] => Array.from(document.querySelectorAll("tbody tr")).map((row) => Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent ?? ""));

  it("shows the model table first with tab counts", async () => {
    await setup();
    expect(screen.getByRole("tab", { name: /By model/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "By project2" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "By session2" })).toBeTruthy();
    const rows = rowsOf();
    expect(rows[0]?.[0]).toBe("claude-opus-4-7");
    expect(rows[0]).toEqual(expect.arrayContaining(["Claude", "2.0M"]));
  });

  it("sorts by a column, flips the direction and moves to another column", async () => {
    await setup();
    expect(rowsOf().map((row) => row[0])).toEqual(["claude-opus-4-7", "gpt-5"]);
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    expect(rowsOf().map((row) => row[0])).toEqual(["gpt-5", "claude-opus-4-7"]);
    expect(screen.getByRole("columnheader", { name: /Model/ }).getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    expect(rowsOf().map((row) => row[0])).toEqual(["claude-opus-4-7", "gpt-5"]);
    expect(screen.getByRole("columnheader", { name: /Model/ }).getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getByRole("columnheader", { name: /Provider/ }).getAttribute("aria-sort")).toBe("none");
  });

  it("shows the project table with the short project name and session counts", async () => {
    await setup();
    fireEvent.click(screen.getByRole("tab", { name: /By project/ }));
    expect(rowsOf()[0]?.[0]).toBe("api");
    expect(screen.getByTitle("C--Users-me-Projetos-api")).toBeTruthy();
    expect(rowsOf()[0]?.[5]).toBe("4");
  });

  it("shows the session table with titles, context tones and dates and opens known Claude sessions", async () => {
    const known = sessionRecord({ sessionId: "sess-0001-aaaa" });
    const { props } = await setup({ sessions: { "sess-0001-aaaa": known } });
    fireEvent.click(screen.getByRole("tab", { name: /By session/ }));
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    expect(rows[0]?.textContent).toContain("Refactor auth");
    expect(rows[0]?.textContent).toContain("11-10 09:05");
    expect(rows[0]?.textContent).toContain("11-15 18:30");
    expect(rows[0]?.querySelector(".usage__tone--go")).toBeTruthy();
    expect(rows[1]?.textContent).toContain("codex-99");
    expect(rows[1]?.querySelector(".usage__tone--hold")).toBeTruthy();
    expect(rows[0]?.className).toContain("usage__row--link");
    expect(rows[1]?.className).not.toContain("usage__row--link");
    fireEvent.click(rows[1] as Element);
    expect(props.onOpenSession).not.toHaveBeenCalled();
    fireEvent.click(rows[0] as Element);
    expect(props.onOpenSession).toHaveBeenCalledWith("sess-0001-aaaa");
  });

  it("does not open a session this hub does not know", async () => {
    const { props } = await setup();
    fireEvent.click(screen.getByRole("tab", { name: /By session/ }));
    fireEvent.click(document.querySelector("tbody tr") as Element);
    expect(props.onOpenSession).not.toHaveBeenCalled();
  });

  it("limits long tables to 12 rows and expands and collapses them", async () => {
    const many = Array.from({ length: 15 }, (_, index) => ({ ...usageTotals({ read: 1000 + index }), model: `model-${index}`, provider: "claude" as const }));
    usageMock.mockResolvedValue(usageReport({ byModel: many }));
    await setup();
    expect(rowsOf()).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Show all 15" }));
    expect(rowsOf()).toHaveLength(15);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(rowsOf()).toHaveLength(12);
  });

  it("says nothing to show for an empty breakdown", async () => {
    usageMock.mockResolvedValue(usageReport({ byProject: [] }));
    await setup();
    fireEvent.click(screen.getByRole("tab", { name: /By project/ }));
    expect(screen.getByText("Nothing to show.")).toBeTruthy();
  });

  it("moves between tabs with the arrow keys, Home and End and stores the choice", async () => {
    const first = await setup();
    const tablist = screen.getByRole("tablist", { name: "Usage breakdown" });
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /By project/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /By project/ }));
    fireEvent.keyDown(tablist, { key: "End" });
    expect(screen.getByRole("tab", { name: /By session/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    fireEvent.keyDown(tablist, { key: "Home" });
    expect(screen.getByRole("tab", { name: /By model/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tablist, { key: "x" });
    expect(screen.getByRole("tab", { name: /By model/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(localStorage.getItem("hub.usage.tab")).toBe("project");
    first.unmount();
    await setup();
    expect(screen.getByRole("tab", { name: /By project/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("survives blocked storage for the tab", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await setup();
    fireEvent.click(screen.getByRole("tab", { name: /By project/ }));
    expect(screen.getByRole("tab", { name: /By project/ }).getAttribute("aria-selected")).toBe("true");
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it("sorts every column of every table, largest first", async () => {
    const lowFirst = usageSession({ sessionId: "low-1", title: "Zulu", cwd: "C:/work/zulu", p90Context: 1000, firstAt: 1, lastAt: 2, read: 10, output: 1, messages: 1 });
    const highSecond = usageSession({ sessionId: "high-1", title: "Alpha", cwd: "C:/work/alpha", p90Context: 900_000, firstAt: 1_000_000_000_000, lastAt: 2_000_000_000_000, read: 20, output: 2, messages: 2 });
    usageMock.mockResolvedValue(
      usageReport({
        bySession: [lowFirst, highSecond],
        byModel: [
          { ...usageTotals({ read: 1, fresh: 1, cacheRead: 1, output: 1, messages: 1 }), model: "small", provider: "claude" },
          { ...usageTotals({ read: 9, fresh: 9, cacheRead: 9, output: 9, messages: 9 }), model: "large", provider: "codex" },
        ],
        byProject: [
          { ...usageTotals({ read: 1, output: 1, messages: 1 }), project: "aaa", provider: "claude", sessions: 1 },
          { ...usageTotals({ read: 9, output: 9, messages: 9 }), project: "zzz", provider: "codex", sessions: 9 },
        ],
      }),
    );
    await setup();
    const firstCell = (): string => document.querySelector("tbody tr td")?.textContent ?? "";
    for (const header of ["Fresh", "Cache read", "Output", "Messages", "Read"]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${header}`) }));
      expect(firstCell()).toBe("large");
    }
    fireEvent.click(screen.getByRole("button", { name: /^Provider/ }));
    expect(firstCell()).toBe("large");
    fireEvent.click(screen.getByRole("tab", { name: /By project/ }));
    for (const header of ["Sessions", "Messages", "Output", "Read", "Project", "Provider"]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${header}`) }));
      expect(firstCell()).toBe("zzz");
    }
    fireEvent.click(screen.getByRole("tab", { name: /By session/ }));
    for (const header of ["Context p50 / p90 / max", "First", "Last", "Read", "Output", "Messages"]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${header}`) }));
      expect(firstCell()).toBe("Alpha");
    }
    fireEvent.click(screen.getByRole("button", { name: /^Session/ }));
    expect(firstCell()).toBe("Zulu");
    fireEvent.click(screen.getByRole("button", { name: /^Project/ }));
    expect(firstCell()).toBe("Zulu");
    fireEvent.click(screen.getByRole("button", { name: /^Provider/ }));
    expect(screen.getByRole("columnheader", { name: /Provider/ }).getAttribute("aria-sort")).toBe("descending");
  });

  it("keeps the sort and expansion state per tab", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    fireEvent.click(screen.getByRole("tab", { name: /By project/ }));
    expect(rowsOf()[0]?.[0]).toBe("api");
    fireEvent.click(screen.getByRole("tab", { name: /By model/ }));
    expect(rowsOf()[0]?.[0]).toBe("gpt-5");
  });
});

describe("UsageView plan limits", () => {
  it("points to the settings when the limits feature is off", async () => {
    await setup();
    expect(screen.getByText(/Turn on Limits in/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings › Plugins" }).getAttribute("href")).toBe("#/settings/plugins");
    expect(limitsMock).not.toHaveBeenCalled();
  });

  it("says it is loading, then that the hub is too old when limits are null", async () => {
    limitsMock.mockReturnValue(new Promise(() => undefined));
    const first = await setup({ settings: usageSettings({ limits: true }) });
    expect(screen.getByText("Loading limits...")).toBeTruthy();
    first.unmount();
    limitsMock.mockResolvedValue(null);
    await setup({ settings: usageSettings({ limits: true }) });
    expect(screen.getByText("Limits need a newer hub.")).toBeTruthy();
  });

  it("says nothing is available when both providers are missing", async () => {
    limitsMock.mockResolvedValue(snapshot({ claude: null, codex: null }));
    await setup({ settings: usageSettings({ limits: true }) });
    expect(screen.getByText(/No plan limits available yet/)).toBeTruthy();
  });

  it("shows the Claude gauges, model chips, extra usage and freshness", async () => {
    limitsMock.mockResolvedValue(snapshot({ codex: null }));
    await setup({ settings: usageSettings({ limits: true }) });
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("95%")).toBeTruthy();
    expect(screen.getByText("resets in 2h")).toBeTruthy();
    expect(screen.getByText("resets in 3d")).toBeTruthy();
    expect(screen.getByText("Opus 30%").getAttribute("title")).toBe("Opus resets in 1d");
    expect(screen.getByText("Sonnet 10%").getAttribute("title")).toBe("Sonnet");
    expect(screen.getByText("Extra usage on: 12% used")).toBeTruthy();
    expect(screen.getByText("as of 2m ago")).toBeTruthy();
    expect(screen.getByText("live")).toBeTruthy();
    expect((document.querySelectorAll(".usage__meter-fill")[1] as HTMLElement).className).toContain("usage__meter-fill--hold");
  });

  it("shows extra usage without a percentage and hides it when off", async () => {
    limitsMock.mockResolvedValue(snapshot({ codex: null, claude: claude({ extra: { enabled: true, utilization: null }, models: [] }) }));
    const first = await setup({ settings: usageSettings({ limits: true }) });
    expect(screen.getByText("Extra usage on")).toBeTruthy();
    expect(document.querySelector(".usage__chips")).toBeNull();
    first.unmount();
    limitsMock.mockResolvedValue(snapshot({ codex: null, claude: claude({ extra: { enabled: false, utilization: 5 } }) }));
    await setup({ settings: usageSettings({ limits: true }) });
    expect(screen.queryByText(/Extra usage on/)).toBeNull();
  });

  it("shows the reset placeholder gauge and the error warning", async () => {
    limitsMock.mockResolvedValue(
      snapshot({ codex: null, claude: claude({ fiveHour: { utilization: 0, resetsAt: null, reset: true }, error: "rate limited", source: "cache" }) }),
    );
    await setup({ settings: usageSettings({ limits: true }) });
    expect(screen.getByText("reset · 0%")).toBeTruthy();
    expect(screen.getByText("rate limited")).toBeTruthy();
    expect(screen.getByText("from local cache")).toBeTruthy();
  });

  it("says no Claude login was found, with a default and a custom message", async () => {
    limitsMock.mockResolvedValue(snapshot({ codex: null, claude: claude({ source: "none", error: "" }) }));
    const first = await setup({ settings: usageSettings({ limits: true }) });
    expect(screen.getByText("no Claude Code login found")).toBeTruthy();
    first.unmount();
    limitsMock.mockResolvedValue(snapshot({ codex: null, claude: claude({ source: "none", error: "expired token" }) }));
    await setup({ settings: usageSettings({ limits: true }) });
    expect(screen.getByText("expired token")).toBeTruthy();
  });

  it("shows the Codex gauges, plan, unknown resets and the forecast", async () => {
    limitsMock.mockResolvedValue(snapshot({ claude: null }));
    const forecast: LimitsForecast = {
      claude: { fiveHour: null, sevenDay: null },
      codex: { primary: { series: "codex.primary", usedPercent: 75, ratePerHour: 10, exhaustsAt: NOW + 30 * 60_000, resetsAt: NOW + 3_600_000, exhaustsBeforeReset: true, samples: 5, spanMinutes: 60 }, secondary: null },
    };
    forecastMock.mockReturnValue(forecast);
    await setup({ settings: usageSettings({ limits: true }) });
    expect(screen.getByText("plus")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText("reset time unknown")).toBeTruthy();
    expect(screen.getByText(/At this pace the 5h window runs out at/)).toBeTruthy();
    expect(screen.getByText("from local session")).toBeTruthy();
  });

  it("shows the Claude forecast line and says no Codex session data when missing", async () => {
    limitsMock.mockResolvedValue(snapshot({ codex: codex({ source: "none", error: null, planType: null }) }));
    forecastMock.mockReturnValue({
      claude: { fiveHour: { series: "claude.fiveHour", usedPercent: 42, ratePerHour: 10, exhaustsAt: NOW + 30 * 60_000, resetsAt: NOW + 3_600_000, exhaustsBeforeReset: true, samples: 5, spanMinutes: 60 }, sevenDay: null },
      codex: { primary: null, secondary: null },
    });
    await setup({ settings: usageSettings({ limits: true }) });
    expect(screen.getByText("no Codex session data found")).toBeTruthy();
    expect(screen.getAllByText(/At this pace the 5h window/)).toHaveLength(1);
  });

  it("shows the refresh time after refreshing and hides it before", async () => {
    limitsMock.mockResolvedValue(snapshot());
    refreshMock.mockResolvedValue(snapshot({ updatedAt: NOW + 1 }));
    await setup({ settings: usageSettings({ limits: true }) });
    expect(screen.queryByText(/refreshed/)).toBeNull();
    fireEvent.click(menu("Refresh plan limits"));
    await flush();
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("refreshed just now")).toBeTruthy();
  });

  it("reports a refresh failure and re-enables the action", async () => {
    limitsMock.mockResolvedValue(snapshot());
    refreshMock.mockRejectedValueOnce(new Error("upstream 500"));
    await setup({ settings: usageSettings({ limits: true }) });
    fireEvent.click(menu("Refresh plan limits"));
    await flush();
    expect(screen.getByText("upstream 500")).toBeTruthy();
    expect((menu("Refresh plan limits") as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Refresh plan limits when the feature is off or the hub is too old", async () => {
    const first = await setup();
    expect((menu("Refresh plan limits") as HTMLButtonElement).disabled).toBe(true);
    expect(menu("Refresh plan limits").getAttribute("title")).toBe("Turn on Limits in Settings › Plugins first");
    first.unmount();
    limitsMock.mockResolvedValue(null);
    await setup({ settings: usageSettings({ limits: true }) });
    expect((menu("Refresh plan limits") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows Refreshing... while the refresh is running", async () => {
    limitsMock.mockResolvedValue(snapshot());
    refreshMock.mockReturnValue(new Promise(() => undefined));
    await setup({ settings: usageSettings({ limits: true }) });
    fireEvent.click(menu("Refresh plan limits"));
    await flush();
    expect(menu("Refreshing...")).toBeTruthy();
  });
});

describe("UsageView actions and live updates", () => {
  it("rescans the transcripts and reloads the report", async () => {
    await setup();
    fireEvent.click(menu("Rescan transcripts"));
    await flush();
    expect(rescanMock).toHaveBeenCalledTimes(1);
    expect(usageMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows Rescanning... while the rescan runs and reports a failure", async () => {
    let finish: () => void = () => undefined;
    rescanMock.mockReturnValueOnce(new Promise((done) => (finish = () => done({ files: 1 }))));
    await setup();
    fireEvent.click(menu("Rescan transcripts"));
    await flush();
    expect(screen.getByRole("status").textContent).toBe("Rescanning...");
    expect(menu("Rescanning...").hasAttribute("disabled")).toBe(true);
    finish();
    await flush();
    rescanMock.mockRejectedValueOnce(new Error("disk busy"));
    fireEvent.click(menu("Rescan transcripts"));
    await flush();
    expect(screen.getByText("Could not load usage: disk busy")).toBeTruthy();
  });

  it("reloads the report on a usage event and the limits on a limits event", async () => {
    limitsMock.mockResolvedValue(snapshot());
    await setup({ settings: usageSettings({ limits: true }) });
    act(() => listeners.forEach((listener) => listener("usage")));
    await flush();
    expect(usageMock).toHaveBeenCalledTimes(2);
    act(() => listeners.forEach((listener) => listener("limits")));
    await flush();
    expect(limitsMock).toHaveBeenCalledTimes(2);
  });

  it("ignores limits events when the feature is off", async () => {
    await setup();
    act(() => listeners.forEach((listener) => listener("limits")));
    await flush();
    expect(limitsMock).not.toHaveBeenCalled();
  });

  it("refreshes the relative times every 30 seconds", async () => {
    await setup();
    expect(screen.getByText("scanned 5m ago")).toBeTruthy();
    await flush(30_000);
    expect(screen.getByText("scanned 5m ago")).toBeTruthy();
    await flush(5 * 60_000);
    expect(screen.getByText("scanned 10m ago")).toBeTruthy();
  });

  it("opens a Claude session row only when sessions are provided", async () => {
    const rows = [usageSession({ sessionId: "known-1" }), usageSession({ sessionId: "unknown-1" })];
    usageMock.mockResolvedValue(usageReport({ bySession: rows }));
    const { props } = await setup({ sessions: { "known-1": sessionRecord({ sessionId: "known-1" }) } });
    fireEvent.click(screen.getByRole("tab", { name: /By session/ }));
    const links = document.querySelectorAll("tr.usage__row--link");
    expect(links).toHaveLength(1);
    fireEvent.click(links[0] as Element);
    expect(within(links[0] as HTMLElement).getByText("Refactor auth")).toBeTruthy();
    expect(props.onOpenSession).toHaveBeenCalledWith("known-1");
  });
});
