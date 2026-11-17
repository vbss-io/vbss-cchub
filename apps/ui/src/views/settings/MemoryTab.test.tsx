import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import type { HistoryIndexStatus } from "../../types";
import { fullSettings } from "../../test-support/u5-fixtures";
import { MemoryTab } from "./MemoryTab";

const mocks = vi.hoisted(() => ({
  clearHistoryIndex: vi.fn<() => Promise<unknown>>(),
  rebuildHistoryIndex: vi.fn<() => Promise<unknown>>(),
  runHistoryIndex: vi.fn<() => Promise<unknown>>(),
  status: { current: null as unknown },
}));

vi.mock("../../memory-api", () => ({ clearHistoryIndex: mocks.clearHistoryIndex, rebuildHistoryIndex: mocks.rebuildHistoryIndex, runHistoryIndex: mocks.runHistoryIndex }));
vi.mock("../../use-history", () => ({ useHistoryStatus: () => mocks.status.current }));

const indexStatus = (overrides: Partial<HistoryIndexStatus> = {}): HistoryIndexStatus => ({
  enabled: true,
  engine: "fts",
  running: false,
  progress: null,
  files: 10,
  sessions: 1200,
  rows: 34000,
  textBytes: 1000,
  indexBytes: 2 * 1024 * 1024,
  indexBytesEstimated: false,
  lastBuildMs: 2500,
  lastBuildAt: 1,
  lastRun: null,
  lastError: null,
  roots: { claude: "c", codex: "x" },
  ...overrides,
});

beforeEach(() => {
  mocks.clearHistoryIndex.mockReset().mockResolvedValue(undefined);
  mocks.rebuildHistoryIndex.mockReset().mockResolvedValue(undefined);
  mocks.runHistoryIndex.mockReset().mockResolvedValue(undefined);
  mocks.status.current = indexStatus();
});

const setup = (props: Partial<Parameters<typeof MemoryTab>[0]> = {}) => {
  const onSaveSettings = vi.fn(async () => undefined);
  const view = render(<MemoryTab enabled settings={fullSettings()} onSaveSettings={onSaveSettings} subscribeHistory={() => () => undefined} {...props} />);
  return { onSaveSettings, ...view };
};

test("shows the index state and its statistics", () => {
  setup();
  expect(screen.getByRole("status").textContent).toBe("Ready");
  const stats = [...document.querySelectorAll(".mem__stats > div")].map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]);
  expect(stats).toEqual([
    ["Sessions", "1,200"],
    ["Messages", "34,000"],
    ["Index size", "2 MB"],
    ["Last full build", "2.5 s"],
  ]);
});

test("without a status the state is Checking and no statistics or Clear action are available", () => {
  mocks.status.current = null;
  setup();
  expect(screen.getByRole("status").textContent).toBe("Checking...");
  expect(document.querySelector(".mem__stats")).toBeNull();
  expect((screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement).disabled).toBe(true);
});

test("turning the index on saves the setting and starts a run, turning it off only saves", async () => {
  const off = setup({ settings: fullSettings({ memory: { historyIndex: false, handoffWorkspaces: [], summaryHeading: "Summary" } }) });
  await userEvent.click(screen.getByRole("checkbox", { name: "Index session history" }));
  expect(off.onSaveSettings).toHaveBeenCalledWith({ memory: { historyIndex: true } });
  await vi.waitFor(() => expect(mocks.runHistoryIndex).toHaveBeenCalledTimes(1));
  off.unmount();
  const on = setup();
  await userEvent.click(screen.getByRole("checkbox", { name: "Index session history" }));
  expect(on.onSaveSettings).toHaveBeenCalledWith({ memory: { historyIndex: false } });
  await vi.waitFor(() => expect(screen.getByRole("checkbox", { name: "Index session history" }).hasAttribute("disabled")).toBe(false));
  expect(mocks.runHistoryIndex).toHaveBeenCalledTimes(1);
});

test("a failing save surfaces its message in an alert and a generic one for odd errors", async () => {
  const { onSaveSettings } = setup();
  onSaveSettings.mockRejectedValueOnce(new Error("vault locked")).mockRejectedValueOnce("odd");
  await userEvent.click(screen.getByRole("checkbox", { name: "Index session history" }));
  expect((await screen.findByRole("alert")).textContent).toBe("vault locked");
  await userEvent.click(screen.getByRole("checkbox", { name: "Index session history" }));
  await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Something went wrong."));
});

test("Rebuild runs the rebuild and is disabled when the index is off or already running", async () => {
  const first = setup();
  await userEvent.click(screen.getByRole("button", { name: "Rebuild" }));
  expect(mocks.rebuildHistoryIndex).toHaveBeenCalledTimes(1);
  first.unmount();
  mocks.status.current = indexStatus({ running: true, progress: { done: 3, total: 9 } });
  const running = setup();
  expect((screen.getByRole("button", { name: "Rebuild" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("Building: 3 of 9 files");
  running.unmount();
  setup({ settings: fullSettings({ memory: { historyIndex: false, handoffWorkspaces: [], summaryHeading: "Summary" } }) });
  expect((screen.getByRole("button", { name: "Rebuild" }) as HTMLButtonElement).disabled).toBe(true);
});

test("Clear asks for confirmation, runs only after confirming and can be cancelled", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "Clear" }));
  const dialog = screen.getByRole("dialog", { name: "Clear the history index?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mocks.clearHistoryIndex).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Clear" }));
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await vi.waitFor(() => expect(mocks.clearHistoryIndex).toHaveBeenCalledTimes(1));
});

test("Clear is disabled when nothing is indexed", () => {
  mocks.status.current = indexStatus({ rows: 0, sessions: 0 });
  setup();
  expect((screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("Nothing indexed yet");
});

test("a disabled index shows Off and no statistics", () => {
  mocks.status.current = indexStatus({ enabled: false });
  setup();
  expect(screen.getByRole("status").textContent).toBe("Off");
  expect(document.querySelector(".mem__stats")).toBeNull();
});

test("the summary heading saves trimmed once changed and never empty", async () => {
  const { onSaveSettings } = setup();
  const save = screen.getByRole("button", { name: "Save heading" }) as HTMLButtonElement;
  const input = screen.getByRole("textbox") as HTMLInputElement;
  expect(input.value).toBe("Summary");
  expect(input.maxLength).toBe(80);
  expect(save.disabled).toBe(true);
  await userEvent.clear(input);
  expect(save.disabled).toBe(true);
  await userEvent.type(input, "  Day recap ");
  expect(save.disabled).toBe(false);
  await userEvent.click(save);
  expect(onSaveSettings).toHaveBeenCalledWith({ memory: { summaryHeading: "Day recap" } });
});

test("the heading follows a settings update from the hub", () => {
  const { rerender, onSaveSettings } = setup();
  rerender(<MemoryTab enabled settings={fullSettings({ memory: { historyIndex: true, handoffWorkspaces: [], summaryHeading: "Resumo" } })} onSaveSettings={onSaveSettings} subscribeHistory={() => () => undefined} />);
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Resumo");
});

test("everything is locked while the hub surface is off", () => {
  setup({ enabled: false, settings: null });
  expect((screen.getByRole("checkbox", { name: "Index session history" }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Rebuild" }) as HTMLButtonElement).disabled).toBe(true);
});
