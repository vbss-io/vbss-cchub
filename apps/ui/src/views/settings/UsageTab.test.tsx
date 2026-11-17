import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import type { ClaudeLimitsSource } from "../../delegation";
import { fullSettings } from "../../test-support/u5-fixtures";
import { UsageTab } from "./UsageTab";

const api = vi.hoisted(() => ({
  fetchClaudeLimitsSource: vi.fn<() => Promise<unknown>>(),
  changeClaudeStatusline: vi.fn<(action: string) => Promise<unknown>>(),
  saveClaudeLimitsSource: vi.fn<(patch: unknown) => Promise<unknown>>(),
}));

vi.mock("../../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../delegation")>()), ...api }));

const source = (overrides: Partial<ClaudeLimitsSource> = {}, statusline: Partial<ClaudeLimitsSource["statusline"]> = {}): ClaudeLimitsSource => ({
  statusline: { state: "not-installed", installed: false, outdated: false, settingsPath: "C:/Users/x/.claude/settings.json", previousCommand: null, error: null, ...statusline },
  privateFallback: true,
  freshMinutes: 15,
  lastReportAt: null,
  ...overrides,
});

beforeEach(() => {
  api.fetchClaudeLimitsSource.mockReset().mockResolvedValue(source());
  api.changeClaudeStatusline.mockReset();
  api.saveClaudeLimitsSource.mockReset();
});

const setup = (props: Partial<Parameters<typeof UsageTab>[0]> = {}) => {
  const onSaveSettings = vi.fn(async () => undefined);
  const view = render(<UsageTab enabled settings={fullSettings()} onSaveSettings={onSaveSettings} usageOn limitsOn {...props} />);
  return { onSaveSettings, ...view };
};

test("each section only shows when its plugin is on", () => {
  const usageOnly = setup({ limitsOn: false });
  expect(document.getElementById("settings-usage")).not.toBeNull();
  expect(document.getElementById("settings-limits")).toBeNull();
  usageOnly.unmount();
  setup({ usageOn: false });
  expect(document.getElementById("settings-usage")).toBeNull();
  expect(document.getElementById("settings-limits")).not.toBeNull();
});

test("the usage window saves valid whole days between 1 and 30 only", () => {
  const { onSaveSettings } = setup({ limitsOn: false });
  const input = screen.getByRole("spinbutton");
  expect((input as HTMLInputElement).value).toBe("30");
  expect(screen.getByText("Window: 30 days")).toBeTruthy();
  fireEvent.change(input, { target: { value: "14" } });
  expect(onSaveSettings).toHaveBeenLastCalledWith({ usage: { days: 14 } });
  onSaveSettings.mockClear();
  for (const value of ["0", "31", "2.5", ""]) fireEvent.change(input, { target: { value } });
  expect(onSaveSettings).not.toHaveBeenCalled();
});

test("without settings the usage window defaults to 7 days", () => {
  setup({ settings: null, limitsOn: false, enabled: false });
  expect(screen.getByText("Window: 7 days")).toBeTruthy();
  expect((screen.getByRole("spinbutton") as HTMLInputElement).disabled).toBe(true);
});

test("the limits checkboxes and the refresh interval save their own slice", async () => {
  const { onSaveSettings } = setup({ usageOn: false });
  await vi.waitFor(() => expect(api.fetchClaudeLimitsSource).toHaveBeenCalled());
  const limits = within(document.getElementById("settings-limits") as HTMLElement);
  await userEvent.click(limits.getByRole("checkbox", { name: /^Claude \(from the Claude Code status line/ }));
  expect(onSaveSettings).toHaveBeenLastCalledWith({ limits: { claude: false } });
  await userEvent.click(limits.getByRole("checkbox", { name: /^Codex \(from the local Codex session files\)/ }));
  expect(onSaveSettings).toHaveBeenLastCalledWith({ limits: { codex: false } });
  await userEvent.click(limits.getByRole("checkbox", { name: /^Codex live/ }));
  expect(onSaveSettings).toHaveBeenLastCalledWith({ limits: { codexLive: true } });
  fireEvent.change(limits.getByRole("spinbutton"), { target: { value: "10" } });
  expect(onSaveSettings).toHaveBeenLastCalledWith({ limits: { refreshMinutes: 10 } });
  onSaveSettings.mockClear();
  for (const value of ["0", "61", "1.5"]) fireEvent.change(limits.getByRole("spinbutton"), { target: { value } });
  expect(onSaveSettings).not.toHaveBeenCalled();
  expect(limits.getByText("Refresh every 5 minutes")).toBeTruthy();
});

test("the Claude source row is hidden when Claude limits are off and defaults are used without settings", () => {
  setup({ usageOn: false, settings: fullSettings({ limits: { claude: false, codex: false, codexLive: false, refreshMinutes: 5 } }) });
  expect(screen.queryByText(/Claude limits source/)).toBeNull();
  expect(api.fetchClaudeLimitsSource).not.toHaveBeenCalled();
});

test("limits defaults without settings: everything off and a 5 minute refresh", () => {
  setup({ usageOn: false, settings: null });
  for (const box of screen.getAllByRole("checkbox")) expect((box as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText("Refresh every 5 minutes")).toBeTruthy();
});

test("the Claude source row shows the statusline state and offers Install statusline", async () => {
  api.changeClaudeStatusline.mockResolvedValue(source({ lastReportAt: Date.now() - 120_000 }, { state: "installed", installed: true, previousCommand: "ccstatusline" }));
  setup({ usageOn: false });
  expect(screen.getByText("checking")).toBeTruthy();
  const install = await screen.findByRole("button", { name: "Install statusline" });
  expect(screen.getByText("C:/Users/x/.claude/settings.json")).toBeTruthy();
  await userEvent.click(install);
  expect(api.changeClaudeStatusline).toHaveBeenCalledWith("install");
  expect(await screen.findByRole("button", { name: "Remove statusline" })).toBeTruthy();
  expect(screen.getByText("chains ccstatusline")).toBeTruthy();
  expect(screen.getByText(/^last report /)).toBeTruthy();
});

test("an outdated statusline offers Update and Remove", async () => {
  api.fetchClaudeLimitsSource.mockResolvedValue(source({}, { state: "outdated", outdated: true }));
  api.changeClaudeStatusline.mockResolvedValue(source());
  setup({ usageOn: false });
  await userEvent.click(await screen.findByRole("button", { name: "Remove statusline" }));
  expect(api.changeClaudeStatusline).toHaveBeenCalledWith("uninstall");
  await screen.findByRole("button", { name: "Install statusline" });
});

test("a statusline action that fails shows its message, or a generic one", async () => {
  api.changeClaudeStatusline.mockRejectedValueOnce(new Error("settings locked")).mockRejectedValueOnce("odd");
  setup({ usageOn: false });
  await userEvent.click(await screen.findByRole("button", { name: "Install statusline" }));
  expect(await screen.findByText("settings locked")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Install statusline" }));
  expect(await screen.findByText("request failed")).toBeTruthy();
});

test("the private fallback checkbox reflects and saves the source setting", async () => {
  api.fetchClaudeLimitsSource.mockResolvedValue(source({ privateFallback: false, freshMinutes: 20 }));
  api.saveClaudeLimitsSource.mockResolvedValue(source({ privateFallback: true, freshMinutes: 20 }));
  setup({ usageOn: false });
  const box = (await screen.findByRole("checkbox", { name: /^Fall back to the private usage endpoint/ })) as HTMLInputElement;
  await vi.waitFor(() => expect(box.checked).toBe(false));
  expect(box.closest("label")?.textContent).toContain("has not reported for 20 minutes");
  await userEvent.click(box);
  expect(api.saveClaudeLimitsSource).toHaveBeenCalledWith({ privateFallback: true });
  await vi.waitFor(() => expect(box.checked).toBe(true));
});

test("the source row is inert while the hub surface is off", () => {
  setup({ usageOn: false, enabled: false });
  expect(api.fetchClaudeLimitsSource).not.toHaveBeenCalled();
  expect((screen.getByRole("checkbox", { name: /^Fall back to the private usage endpoint/ }) as HTMLInputElement).disabled).toBe(true);
});

test("the help toggletips explain the statusline and the fallback", async () => {
  setup({ usageOn: false });
  await userEvent.click(screen.getByRole("button", { name: "About the Claude limits source" }));
  expect(screen.getByRole("status").textContent).toContain("Removing it puts your previous statusline back exactly.");
  await userEvent.click(screen.getByRole("button", { name: "About the private fallback" }));
  expect(screen.getAllByRole("status").some((node) => (node.textContent ?? "").includes("Turn this off to use only the status line."))).toBe(true);
});

test("a source answer that arrives after unmount is dropped", async () => {
  let finish: (value: unknown) => void = () => undefined;
  api.fetchClaudeLimitsSource.mockReturnValueOnce(new Promise((done) => (finish = done)));
  const { unmount } = setup({ usageOn: false });
  unmount();
  finish(source());
  await Promise.resolve();
  expect(document.body.textContent).toBe("");
});
