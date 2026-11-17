import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ReportRecord } from "../delegation";
import { ReportRow, ReportsView } from "./ReportsView";

vi.mock("../components/ShowMore", () => ({
  ClampText: ({ children, className }: { children: string; className: string }) => <p className={className}>{children}</p>,
  ShowMoreList: <T,>({ items, render, wrap }: { items: T[]; render: (item: T) => ReactNode; wrap: (rows: ReactNode) => ReactNode }) => <>{wrap(items.map(render))}</>,
}));

const NOW = new Date(2026, 10, 16, 15, 0).getTime();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

const report = (overrides: Partial<ReportRecord> = {}): ReportRecord => ({
  id: "rep1",
  taskId: null,
  sessionId: null,
  workspace: null,
  kind: "result",
  text: "Shipped the thing",
  source: null,
  createdAt: NOW - 5 * 60_000,
  ...overrides,
});

const reports = (): ReportRecord[] => [
  report({ id: "a", kind: "result", workspace: "vbss", text: "Shipped the export", taskId: "task12345678", source: "claude-code", sessionId: "sess12345678" }),
  report({ id: "b", kind: "blocked", workspace: "vbss", text: "Waiting on credentials" }),
  report({ id: "c", kind: "progress", workspace: "space", text: "Halfway there", createdAt: NOW - 3 * 3_600_000 }),
  report({ id: "d", kind: "note", workspace: null, text: "Loose note" }),
];

const setup = (props: Partial<Parameters<typeof ReportsView>[0]> = {}) => {
  const onOpenTask = vi.fn();
  const view = render(<ReportsView reports={reports()} enabled onOpenTask={onOpenTask} {...props} />);
  return { onOpenTask, ...view };
};

const cards = (): string[] => [...document.querySelectorAll(".rep-card__text")].map((node) => node.textContent ?? "");

test("lists every report as a card with its kind, workspace, relative time and source meta", () => {
  setup();
  expect(cards()).toEqual(["Shipped the export", "Waiting on credentials", "Halfway there", "Loose note"]);
  const first = document.querySelector(".rep-card") as HTMLElement;
  expect(within(first).getByText("result").className).toContain("tag--go");
  expect(within(first).getByText("vbss")).toBeTruthy();
  expect(within(first).getByText("5m ago")).toBeTruthy();
  expect(within(first).getByText("claude-code · session sess1234")).toBeTruthy();
  expect(screen.getByText("3h ago")).toBeTruthy();
});

test("kind chips filter the list and show their counts", async () => {
  setup();
  const kinds = within(screen.getByRole("group", { name: "Report kind" }));
  expect(kinds.getByRole("button", { name: /^All/ }).textContent).toContain("4");
  expect(kinds.getByRole("button", { name: /^blocked/ }).textContent).toContain("1");
  await userEvent.click(kinds.getByRole("button", { name: /^blocked/ }));
  expect(cards()).toEqual(["Waiting on credentials"]);
  expect(kinds.getByRole("button", { name: /^blocked/ }).getAttribute("aria-pressed")).toBe("true");
  await userEvent.click(kinds.getByRole("button", { name: /^All/ }));
  expect(cards()).toHaveLength(4);
});

test("the workspace picker filters, counts and includes the no-workspace bucket", async () => {
  setup();
  const picker = screen.getByRole("combobox", { name: "Workspace" }) as HTMLSelectElement;
  expect([...picker.options].map((option) => option.textContent)).toEqual(["All workspaces (4)", "space (1)", "vbss (2)", "No workspace (1)"]);
  await userEvent.selectOptions(picker, "vbss");
  expect(cards()).toEqual(["Shipped the export", "Waiting on credentials"]);
  const kinds = within(screen.getByRole("group", { name: "Report kind" }));
  expect(kinds.getByRole("button", { name: /^progress/ }).textContent).toContain("0");
  await userEvent.selectOptions(picker, "__none__");
  expect(cards()).toEqual(["Loose note"]);
});

test("the search box filters by text and says when nothing matches", async () => {
  setup();
  await userEvent.type(screen.getByRole("textbox", { name: "Search reports" }), "halfway");
  expect(cards()).toEqual(["Halfway there"]);
  await userEvent.clear(screen.getByRole("textbox", { name: "Search reports" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Search reports" }), "zzz");
  expect(screen.getByText("No reports match these filters.")).toBeTruthy();
});

test("with no reports at all the empty state says so", () => {
  setup({ reports: [] });
  expect(screen.getByText("No reports yet.")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Workspace" }).textContent).toBe("All workspaces (0)");
});

test("a card with a task opens it by the first 8 characters label", async () => {
  const { onOpenTask } = setup();
  await userEvent.click(screen.getByRole("button", { name: "task task1234" }));
  expect(onOpenTask).toHaveBeenCalledWith("task12345678");
});

test("the hub-off banner shows only when the hub surface is off", () => {
  const first = setup({ enabled: false });
  expect(screen.getByText(/The hub surface is off on this server/)).toBeTruthy();
  first.unmount();
  setup();
  expect(screen.queryByText(/The hub surface is off on this server/)).toBeNull();
});

test("the help toggletip explains where reports come from", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "About reports" }));
  expect(screen.getByRole("status").textContent).toContain("hub_report");
});

test("the filters are remembered between visits", async () => {
  const first = setup();
  await userEvent.click(screen.getByRole("button", { name: /^note/ }));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Workspace" }), "space");
  expect(JSON.parse(localStorage.getItem("hub.reports.filters") ?? "{}")).toEqual({ kind: "note", workspace: "space" });
  first.unmount();
  setup();
  expect(screen.getByRole("button", { name: /^note/ }).getAttribute("aria-pressed")).toBe("true");
  expect((screen.getByRole("combobox", { name: "Workspace" }) as HTMLSelectElement).value).toBe("space");
});

test("a stored workspace that no longer exists falls back to all workspaces", () => {
  localStorage.setItem("hub.reports.filters", JSON.stringify({ kind: "all", workspace: "deleted" }));
  setup();
  expect((screen.getByRole("combobox", { name: "Workspace" }) as HTMLSelectElement).value).toBe("");
  expect(cards()).toHaveLength(4);
});

test("unreadable or unwritable storage does not break the view", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  setup();
  await userEvent.click(screen.getByRole("button", { name: /^note/ }));
  expect(cards()).toEqual(["Loose note"]);
});

test("ReportRow shows kind, source, workspace, task button, session and time", async () => {
  const onOpenTask = vi.fn();
  render(
    <ul>
      <ReportRow report={report({ kind: "progress", source: "codex", workspace: "vbss", taskId: "abcdef123456", sessionId: "zyxwvuts9999" })} onOpenTask={onOpenTask} />
    </ul>,
  );
  const row = document.querySelector(".report") as HTMLElement;
  expect(within(row).getByText("progress").className).toContain("tag--pend");
  expect(within(row).getByText("codex")).toBeTruthy();
  expect(within(row).getByText("vbss").className).toContain("chip--ws");
  expect(within(row).getByText("session zyxwvuts")).toBeTruthy();
  expect(within(row).getByText("5m ago")).toBeTruthy();
  await userEvent.click(within(row).getByRole("button", { name: "task abcdef12" }));
  expect(onOpenTask).toHaveBeenCalledWith("abcdef123456");
  expect(row.querySelector(".report__text")?.textContent).toBe("Shipped the thing");
});

test("ReportRow leaves out empty parts and the task button without a handler", () => {
  render(
    <ul>
      <ReportRow report={report({ taskId: "abcdef123456", kind: "blocked" })} />
    </ul>,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(document.querySelector(".chip")).toBeNull();
  expect(document.querySelector(".report__head .muted")).toBeNull();
  expect(screen.getByText("blocked").className).toContain("tag--hold");
});
