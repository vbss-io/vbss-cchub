import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { INITIAL_HISTORY_STATE, type HistoryState } from "../memory-model";
import type { PaletteItem } from "../palette-model";
import type { HistoryHit } from "../types";

const history = vi.hoisted(() => ({ useHistorySearch: vi.fn() }));

vi.mock("../use-history", () => history);

import { CommandPalette } from "./CommandPalette";

const item = (id: string, title: string, kind: PaletteItem["kind"] = "command", run: () => void = () => undefined, extra: Partial<PaletteItem> = {}): PaletteItem => ({ id, kind, title, run, ...extra });

const hit = (messageId: number, snippet: string): HistoryHit => ({
  messageId,
  sessionId: "s1",
  client: "claude",
  title: "T",
  cwd: null,
  workspace: null,
  role: "user",
  at: null,
  seq: 1,
  snippet,
  highlights: [[0, 2]],
  matches: 1,
});

const setHistory = (state: Partial<HistoryState>) => history.useHistorySearch.mockReturnValue({ state: { ...INITIAL_HISTORY_STATE, ...state }, more: vi.fn() });

beforeEach(() => {
  localStorage.clear();
  setHistory({});
  history.useHistorySearch.mockClear();
});

const input = () => screen.getByRole("combobox", { name: "Search" }) as HTMLInputElement;
const options = () => screen.getAllByRole("option");

test("renders nothing while closed", () => {
  const { container } = render(<CommandPalette open={false} items={[item("a", "Alpha")]} onClose={() => undefined} />);
  expect(container.firstChild).toBeNull();
});

test("opens focused on the search field and lists commands and views for an empty query", () => {
  render(
    <CommandPalette
      open
      items={[item("c1", "Backup now"), item("v1", "Sessions", "view"), item("s1", "Some session", "session")]}
      onClose={() => undefined}
    />,
  );
  expect(document.activeElement).toBe(input());
  expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  expect(options().map((option) => option.textContent)).toEqual([expect.stringContaining("Backup now"), expect.stringContaining("Sessions")]);
  expect(input().placeholder).toBe("Search sessions, workspaces, tasks and commands");
});

test("uses a custom placeholder and seeds the query", () => {
  render(<CommandPalette open items={[item("a", "Alpha note")]} onClose={() => undefined} placeholder="Find" initialQuery="alp" />);
  expect(input().placeholder).toBe("Find");
  expect(input().value).toBe("alp");
  expect(options()).toHaveLength(1);
});

test("typing filters the results and shows the empty message when nothing matches", async () => {
  const user = userEvent.setup();
  render(<CommandPalette open items={[item("a", "Alpha"), item("b", "Beta")]} onClose={() => undefined} />);
  await user.type(input(), "bet");
  expect(options().map((option) => option.textContent)).toEqual([expect.stringContaining("Beta")]);
  await user.clear(input());
  await user.type(input(), "zzzzqq");
  expect(screen.getByText("No matches")).toBeTruthy();
  expect(screen.queryAllByRole("option")).toHaveLength(0);
});

test("Enter runs the active item, closes, and remembers it as a recent", async () => {
  const user = userEvent.setup();
  const run = vi.fn();
  const onClose = vi.fn();
  render(<CommandPalette open items={[item("a", "Alpha", "command", run), item("b", "Beta")]} onClose={onClose} />);
  await user.type(input(), "alp{Enter}");
  expect(run).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(JSON.parse(localStorage.getItem("hub.palette.recent") ?? "[]")).toEqual(["a"]);
});

test("Enter with no results does nothing", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<CommandPalette open items={[item("a", "Alpha")]} onClose={onClose} />);
  await user.type(input(), "zzzzqq{Enter}");
  expect(onClose).not.toHaveBeenCalled();
});

test("arrow keys wrap around, mouse move activates and click chooses", async () => {
  const user = userEvent.setup();
  const runB = vi.fn();
  render(<CommandPalette open items={[item("a", "Alpha"), item("b", "Beta", "command", runB), item("c", "Gamma")]} onClose={() => undefined} />);
  expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{ArrowUp}");
  expect(options()[2]?.getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{ArrowDown}");
  expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
  expect(input().getAttribute("aria-activedescendant")).toBe(options()[0]?.id);
  fireEvent.mouseMove(options()[1] as HTMLElement);
  expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
  fireEvent.mouseMove(options()[1] as HTMLElement);
  await user.click(options()[1] as HTMLElement);
  expect(runB).toHaveBeenCalledTimes(1);
});

test("page keys move by a page, clamp at the ends and Home and End jump when the query is empty", async () => {
  const user = userEvent.setup();
  const many = Array.from({ length: 20 }, (_, index) => item(`c${index}`, `Command ${String(index).padStart(2, "0")}`));
  render(<CommandPalette open items={many} onClose={() => undefined} />);
  await user.keyboard("{PageDown}");
  expect(options()[8]?.getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{PageDown}{PageDown}{PageDown}");
  expect(options()[19]?.getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{PageUp}");
  expect(options()[11]?.getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{Home}");
  expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{End}");
  expect(options()[19]?.getAttribute("aria-selected")).toBe("true");
});

test("Home and End keep editing the query when the field has text", async () => {
  const user = userEvent.setup();
  render(<CommandPalette open items={[item("a", "Alpha one"), item("b", "Alpha two")]} onClose={() => undefined} />);
  await user.type(input(), "alpha");
  await user.keyboard("{ArrowDown}{Home}");
  expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{End}");
  expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
});

test("Escape closes without selecting and Tab keeps focus in the field", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<CommandPalette open items={[item("a", "Alpha")]} onClose={onClose} />);
  await user.tab();
  expect(document.activeElement).toBe(input());
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a press on the overlay closes but a press inside the dialog does not", () => {
  const onClose = vi.fn();
  render(<CommandPalette open items={[item("a", "Alpha")]} onClose={onClose} />);
  fireEvent.mouseDown(screen.getByRole("dialog"));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.mouseDown(document.querySelector(".palette__overlay") as Element);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("focus that escapes the dialog is pulled back to the search field", () => {
  render(
    <>
      <button>outside</button>
      <CommandPalette open items={[item("a", "Alpha")]} onClose={() => undefined} />
    </>,
  );
  screen.getByText("outside").focus();
  expect(document.activeElement).toBe(input());
});

test("restores focus to the opener when closed", () => {
  const view = render(<button>opener</button>);
  const opener = screen.getByText("opener");
  opener.focus();
  const palette = render(<CommandPalette open items={[item("a", "Alpha")]} onClose={() => undefined} />);
  expect(document.activeElement).toBe(input());
  input().blur();
  palette.unmount();
  expect(document.activeElement).toBe(opener);
  view.unmount();
});

test("query items come first and receive the current query", async () => {
  const user = userEvent.setup();
  const queryItems = vi.fn((query: string) => (query ? [item("q", `Capture: ${query}`, "command")] : []));
  render(<CommandPalette open items={[item("a", "Alpha")]} onClose={() => undefined} queryItems={queryItems} />);
  await user.type(input(), "al");
  expect(options()[0]?.textContent).toContain("Capture: al");
  expect(queryItems).toHaveBeenLastCalledWith("al");
});

test("shows subtitles and highlighted titles", () => {
  render(<CommandPalette open items={[item("a", "Alpha", "command", () => undefined, { subtitle: "first letter", titleRanges: [[0, 2]] })]} onClose={() => undefined} />);
  expect(screen.getByText("first letter")).toBeTruthy();
  expect(document.querySelector(".palette__title mark")).not.toBeNull();
});

test("history hits appear under a History section and open through the handler", async () => {
  const user = userEvent.setup();
  const onOpenHit = vi.fn();
  setHistory({ phase: "ready", hits: [hit(1, "deploy notes"), hit(2, "deploy plan")] });
  render(<CommandPalette open items={[item("a", "Alpha")]} onClose={() => undefined} onOpenHit={onOpenHit} />);
  expect(document.querySelectorAll(".palette__section")).toHaveLength(1);
  expect(document.querySelector(".palette__section")?.textContent).toBe("History");
  const list = screen.getByRole("listbox");
  const historyOptions = within(list).getAllByRole("option").filter((option) => option.textContent?.includes("History"));
  expect(historyOptions).toHaveLength(2);
  await user.click(historyOptions[0] as HTMLElement);
  expect(onOpenHit).toHaveBeenCalledWith(expect.objectContaining({ messageId: 1 }));
  expect(history.useHistorySearch).toHaveBeenCalledWith(expect.objectContaining({ q: "" }), expect.objectContaining({ enabled: true }));
});

test("history search is disabled for capture queries and without an open handler", () => {
  const capture = render(<CommandPalette open items={[item("a", "Alpha")]} onClose={() => undefined} initialQuery="capture buy milk" onOpenHit={() => undefined} />);
  expect(history.useHistorySearch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ enabled: false }));
  capture.unmount();
  render(<CommandPalette open items={[item("a", "Alpha")]} onClose={() => undefined} />);
  expect(history.useHistorySearch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ enabled: false }));
});

test("says it is searching history while the first page loads and there is nothing else", async () => {
  setHistory({ phase: "loading", hits: [] });
  const user = userEvent.setup();
  render(<CommandPalette open items={[item("a", "Alpha")]} onClose={() => undefined} onOpenHit={() => undefined} />);
  await user.type(input(), "zzzzqq");
  expect(screen.getByText("Searching history...")).toBeTruthy();
});
