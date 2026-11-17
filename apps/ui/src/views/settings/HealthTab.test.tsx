import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HealthItem, HealthReport } from "../../types";
import { HealthTab } from "./HealthTab";

const api = vi.hoisted(() => ({
  fetchHealthReport: vi.fn<() => Promise<unknown>>(),
  fetchForecast: vi.fn(),
  runFix: vi.fn<(plan: unknown) => Promise<void>>(),
}));

vi.mock("../../ops-api", () => api);
vi.mock("../../review-api", () => ({ fetchTaskCosts: vi.fn() }));

const item = (overrides: Partial<HealthItem>): HealthItem => ({ id: "claude-hooks", label: "Claude hooks", state: "ok", detail: "Installed", fixAction: null, ...overrides });

const report = (items: HealthItem[]): HealthReport => ({ checkedAt: Date.now(), state: "ok", items });

const noop = async () => undefined;

beforeEach(() => {
  api.fetchHealthReport.mockReset();
  api.runFix.mockReset().mockResolvedValue(undefined);
  window.location.hash = "";
});

afterEach(() => {
  window.location.hash = "";
});

test("shows the summary, the checked time and one row per check with its state and detail", async () => {
  api.fetchHealthReport.mockResolvedValue(report([item({}), item({ id: "mcp-codex", label: "Codex MCP", state: "warn", detail: "Not registered" }), item({ id: "share-tunnel", label: "Tunnel", state: "off", detail: "Stopped" })]));
  render(<HealthTab enabled settings={null} onSaveSettings={noop} />);
  expect(await screen.findByText("Claude hooks")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("1 needs attention");
  expect(screen.getByText(/^Checked /)).toBeTruthy();
  expect(screen.getByText("Attention").className).toContain("health__state--warn");
  expect(screen.getByText("Off")).toBeTruthy();
  expect(screen.getByText("Not registered")).toBeTruthy();
});

test("a fix with an API action runs it, refreshes the report and locks the buttons meanwhile", async () => {
  const fixable = item({ state: "warn", fixAction: { kind: "api", label: "Install hooks", method: "POST", path: "/delegation/hooks/install", body: { client: "claude" } } });
  api.fetchHealthReport.mockResolvedValueOnce(report([fixable])).mockResolvedValueOnce(report([item({})]));
  let finish: () => void = () => undefined;
  api.runFix.mockReturnValueOnce(new Promise<void>((done) => (finish = done)));
  render(<HealthTab enabled settings={null} onSaveSettings={noop} />);
  await userEvent.click(await screen.findByRole("button", { name: "Install hooks" }));
  expect(api.runFix).toHaveBeenCalledWith({ kind: "api", label: "Install hooks", method: "POST", path: "/delegation/hooks/install", body: { client: "claude" } });
  expect((screen.getByRole("button", { name: "Working..." }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement).disabled).toBe(true);
  finish();
  await vi.waitFor(() => expect(screen.getByRole("status").textContent).toBe("Everything works"));
  expect(api.fetchHealthReport).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "Install hooks" })).toBeNull();
});

test("a fix that fails shows the message in an alert, and a generic one for an unknown error", async () => {
  const fixable = item({ state: "error", fixAction: { kind: "api", label: "Repair", method: "POST", path: "/p" } });
  api.fetchHealthReport.mockResolvedValue(report([fixable]));
  api.runFix.mockRejectedValueOnce(new Error("permission denied")).mockRejectedValueOnce("odd");
  render(<HealthTab enabled settings={null} onSaveSettings={noop} />);
  await userEvent.click(await screen.findByRole("button", { name: "Repair" }));
  expect((await screen.findByRole("alert")).textContent).toBe("permission denied");
  await userEvent.click(screen.getByRole("button", { name: "Repair" }));
  expect((await screen.findByRole("alert")).textContent).toBe("The fix did not work.");
});

test("a navigate fix changes the location hash instead of calling the hub", async () => {
  api.fetchHealthReport.mockResolvedValue(report([item({ state: "off", fixAction: { kind: "navigate", label: "Open connections", hash: "#/settings/connections" } })]));
  render(<HealthTab enabled settings={null} onSaveSettings={noop} />);
  await userEvent.click(await screen.findByRole("button", { name: "Open connections" }));
  expect(window.location.hash).toBe("#/settings/connections");
  expect(api.runFix).not.toHaveBeenCalled();
});

test("Check again reloads the report", async () => {
  api.fetchHealthReport.mockResolvedValue(report([item({})]));
  render(<HealthTab enabled settings={null} onSaveSettings={noop} />);
  await screen.findByText("Claude hooks");
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(api.fetchHealthReport).toHaveBeenCalledTimes(2);
});

test("a load error is shown as an alert", async () => {
  api.fetchHealthReport.mockRejectedValue(new Error("hub down"));
  render(<HealthTab enabled settings={null} onSaveSettings={noop} />);
  expect((await screen.findByRole("alert")).textContent).toBe("hub down");
  expect(screen.queryByRole("list")).toBeNull();
});

test("when the hub is not reachable nothing is checked and the button is disabled", () => {
  render(<HealthTab enabled={false} settings={null} onSaveSettings={noop} />);
  expect(api.fetchHealthReport).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("The hub is not reachable, so there is nothing to check.")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Checking");
});
