import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusCodexApp } from "../api";
import { codexRecord, NOW } from "../test-support/u4-fixtures";
import type { CodexSessionRecord } from "../types";
import { CodexCard } from "./CodexCard";

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), focusCodexApp: vi.fn().mockResolvedValue({ ok: true }) }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(focusCodexApp).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

const setup = (session: CodexSessionRecord, extra: Partial<Parameters<typeof CodexCard>[0]> = {}) => {
  const fns = { onOpen: vi.fn(), onRename: vi.fn(), onArchive: vi.fn(), onUnarchive: vi.fn(), onDelete: vi.fn() };
  const view = render(<CodexCard session={session} workspace={null} codexAppRunning={false} {...fns} {...extra} />);
  return { fns, ...view };
};

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));

describe("CodexCard", () => {
  it("renders the thread name, status, turns and opens on click", () => {
    const { fns } = setup(codexRecord(), { workspace: "api-ws" });
    expect(screen.getByText("Fix build")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("3 turns")).toBeTruthy();
    expect(screen.getByText("api-ws")).toBeTruthy();
    expect(screen.getByText("1m ago")).toBeTruthy();
    fireEvent.click(screen.getByText("Fix build"));
    expect(fns.onOpen).toHaveBeenCalledWith("codex-0001-aaaa");
  });

  it("uses singular turn, custom title and the waiting and idle labels", () => {
    const { unmount } = setup(codexRecord({ turns: 1, customTitle: "Custom", status: "waiting" }));
    expect(screen.getByText("Custom")).toBeTruthy();
    expect(screen.getByText("1 turn")).toBeTruthy();
    expect(screen.getByText("Waiting for input")).toBeTruthy();
    expect(screen.getByRole("article").className).toContain("card--tone-pend");
    unmount();
    setup(codexRecord({ status: "idle" }));
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(screen.getByRole("article").className).toContain("card--tone-muted");
  });

  it("labels the origin: via hub, known sources and unknown sources", () => {
    const { unmount } = setup(codexRecord({ origin: "hub" }));
    expect(screen.getByRole("note").getAttribute("title")).toBe("via hub");
    unmount();
    const second = setup(codexRecord({ threadSource: "voice_chat" }));
    expect(screen.getByRole("note").getAttribute("title")).toBe("voice chat");
    second.unmount();
    const third = setup(codexRecord({ threadSource: "some_new_kind" }));
    expect(screen.getByRole("note").getAttribute("title")).toBe("some new kind");
    third.unmount();
    setup(codexRecord());
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("shows Focus app only while the Codex app runs and calls the api without opening the drawer", () => {
    const { fns, unmount } = setup(codexRecord());
    expect(screen.queryByRole("button", { name: /Focus app/ })).toBeNull();
    unmount();
    const running = setup(codexRecord(), { codexAppRunning: true });
    fireEvent.click(screen.getByRole("button", { name: /Focus app/ }));
    expect(focusCodexApp).toHaveBeenCalledTimes(1);
    expect(running.fns.onOpen).not.toHaveBeenCalled();
    expect(fns.onOpen).not.toHaveBeenCalled();
  });

  it("walks the two-step delete of an archived thread", () => {
    const { fns } = setup(codexRecord({ archivedAt: 9 }));
    expect(screen.getByRole("article").className).toContain("card--archived");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fns.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(fns.onDelete).toHaveBeenCalledWith("codex-0001-aaaa");
    expect(fns.onOpen).not.toHaveBeenCalled();
  });

  it("archives from the menu and unarchives an archived thread", () => {
    const { fns, unmount } = setup(codexRecord());
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(fns.onArchive).toHaveBeenCalledWith("codex-0001-aaaa");
    unmount();
    const archived = setup(codexRecord({ archivedAt: 9 }));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Unarchive" }));
    expect(archived.fns.onUnarchive).toHaveBeenCalledWith("codex-0001-aaaa");
  });

  it("offers Open session only for a live thread", () => {
    const onOpenSession = vi.fn();
    const { unmount } = setup(codexRecord(), { onOpenSession });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open session" }));
    expect(onOpenSession).toHaveBeenCalledWith("codex-0001-aaaa");
    unmount();
    setup(codexRecord({ status: "ended" }), { onOpenSession });
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Open session" })).toBeNull();
  });

  it("renames on Enter, cancels on Escape, submits on blur and ignores the context menu inside the input", () => {
    const { fns } = setup(codexRecord());
    fireEvent.contextMenu(screen.getByText("Fix build"), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByDisplayValue("Fix build");
    expect(fireEvent.contextMenu(input)).toBe(true);
    fireEvent.click(input);
    expect(fns.onOpen).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: " Renamed " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fns.onRename).toHaveBeenLastCalledWith("codex-0001-aaaa", "Renamed");
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.keyDown(screen.getByPlaceholderText("codex-00"), { key: "Escape" });
    expect(screen.queryByPlaceholderText("codex-00")).toBeNull();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const again = screen.getByPlaceholderText("codex-00");
    fireEvent.change(again, { target: { value: "By blur" } });
    fireEvent.blur(again);
    expect(fns.onRename).toHaveBeenLastCalledWith("codex-0001-aaaa", "By blur");
  });
});
