import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW, sessionRecord } from "../test-support/u4-fixtures";
import type { SessionRecord } from "../types";
import { contextLimitFor, prettyModel, SessionCard } from "./SessionCard";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const handlers = () => ({
  onOpen: vi.fn(),
  onArchive: vi.fn(),
  onDelete: vi.fn(),
  onFocus: vi.fn(),
  onRename: vi.fn(),
  onFavorite: vi.fn(),
});

const setup = (session: SessionRecord, extra: Partial<Parameters<typeof SessionCard>[0]> = {}) => {
  const fns = handlers();
  const view = render(<SessionCard session={session} workspace={null} showSource={false} {...fns} {...extra} />);
  return { fns, ...view };
};

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));

describe("prettyModel", () => {
  it("formats known families, keeps unknown ids and drops empty", () => {
    expect(prettyModel("claude-opus-4-7")).toBe("Opus 4.7");
    expect(prettyModel("claude-sonnet-4-5-20250101")).toBe("Sonnet 4.5");
    expect(prettyModel("gpt-5")).toBe("gpt-5");
    expect(prettyModel(null)).toBeNull();
    expect(prettyModel("")).toBeNull();
  });
});

describe("contextLimitFor", () => {
  it("uses 1M for opus and fable, 200k for sonnet, haiku and unknown models", () => {
    expect(contextLimitFor(10, "claude-opus-4-7")).toBe(1_000_000);
    expect(contextLimitFor(10, "fable-5-1")).toBe(1_000_000);
    expect(contextLimitFor(10, "claude-sonnet-4-5")).toBe(200_000);
    expect(contextLimitFor(10, "claude-haiku-4-5")).toBe(200_000);
    expect(contextLimitFor(10, "mystery")).toBe(200_000);
    expect(contextLimitFor(10, null)).toBe(200_000);
  });

  it("jumps to 1M when the tokens already exceed the model limit", () => {
    expect(contextLimitFor(250_000, "claude-sonnet-4-5")).toBe(1_000_000);
  });
});

describe("SessionCard", () => {
  it("renders the name, status, model and context meter and opens on click", () => {
    const { fns } = setup(sessionRecord(), { workspace: "api-ws" });
    expect(screen.getByText("Refactor auth")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Opus 4.7")).toBeTruthy();
    expect(screen.getByText("10%")).toBeTruthy();
    expect(screen.getByText("api-ws")).toBeTruthy();
    expect(screen.getByText("work/api")).toBeTruthy();
    expect(screen.getByText("1m ago")).toBeTruthy();
    fireEvent.click(screen.getByText("Refactor auth"));
    expect(fns.onOpen).toHaveBeenCalledWith("sess-0001-aaaa");
  });

  it("describes the context in the title with token counts", () => {
    setup(sessionRecord({ tokensIn: 999, tokensOut: 2_500_000, contextTokens: 5000, model: "claude-sonnet-4-5" }));
    expect(screen.getByText("Sonnet 4.5").getAttribute("title")).toBe("Sonnet 4.5 · context 5,000 / 200,000 tokens · ↓999 ↑2.5M");
  });

  it("formats missing and thousand token counts", () => {
    setup(sessionRecord({ tokensIn: null, tokensOut: 4200 }));
    expect(screen.getByText("Opus 4.7").getAttribute("title")).toContain("↓— ↑4k");
  });

  it("falls back to the short id and an unavailable context", () => {
    setup(sessionRecord({ title: null, model: null, contextTokens: null }));
    expect(screen.getByText("sess-000")).toBeTruthy();
    expect(screen.queryByText(/%$/)).toBeNull();
    expect(screen.queryByText("Opus 4.7")).toBeNull();
  });

  it("prefers the custom title and marks favorites", () => {
    setup(sessionRecord({ customTitle: "Mine", favoriteAt: 5 }));
    expect(screen.getByText("Mine")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Favorite" })).toBeTruthy();
  });

  it("says Finished for an unread idle session and Inactive for a stale one", () => {
    const { unmount } = setup(sessionRecord({ status: "idle", unread: true }));
    expect(screen.getByText("Finished")).toBeTruthy();
    unmount();
    setup(sessionRecord({ stale: true }), { stale: true });
    expect(screen.getByText("Inactive")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Focus/ })).toBeNull();
  });

  it("lists every extra fact in the more marker", () => {
    setup(
      sessionRecord({ source: "vscode", agentsRunning: 2, agentsTotal: 5, forkOf: "forkparent123", forksLive: 1, remoteAsks: 3, delegatedRunning: 2, helpersTotal: 2, helpers: 1, helperOf: "helperparent1" }),
      { showSource: true, peers: 2, claimsCount: 1, forkParentName: null },
    );
    const extras = screen.getByRole("note");
    const title = extras.getAttribute("title") ?? "";
    expect(title).toContain("from vscode");
    expect(title).toContain("2 subagents running · 5 spawned");
    expect(title).toContain("2 more here: other live agents share this folder");
    expect(title).toContain("claims 1 file");
    expect(title).toContain("fork of forkpare");
    expect(title).toContain("1 live fork · 3 asks");
    expect(title).toContain("2 delegated running");
    expect(title).toContain("1 helper folded in");
    expect(title).toContain("helper of helperpa");
  });

  it("uses singular wording and the parent name for forks", () => {
    setup(sessionRecord({ agentsRunning: 1, agentsTotal: 1, forkOf: "p", forksLive: 2, helpersTotal: 3, helpers: 2 }), { forkParentName: "Parent", claimsCount: 2 });
    const title = screen.getByRole("note").getAttribute("title") ?? "";
    expect(title).toContain("1 subagent running");
    expect(title).toContain("fork of Parent");
    expect(title).toContain("2 live forks");
    expect(title).toContain("2 helpers folded in");
    expect(title).toContain("claims 2 files");
  });

  it("focuses the session without opening the drawer", () => {
    const { fns } = setup(sessionRecord());
    fireEvent.click(screen.getByRole("button", { name: /Focus/ }));
    expect(fns.onFocus).toHaveBeenCalledWith("sess-0001-aaaa");
    expect(fns.onOpen).not.toHaveBeenCalled();
  });

  it("offers no focus for an ended session", () => {
    setup(sessionRecord({ status: "ended" }));
    expect(screen.queryByRole("button", { name: /Focus/ })).toBeNull();
  });

  it("walks the two-step delete on an archived session", () => {
    const { fns } = setup(sessionRecord({ archivedAt: 5 }));
    expect(screen.queryByRole("button", { name: /Focus/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fns.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(fns.onDelete).toHaveBeenCalledWith("sess-0001-aaaa");
    expect(fns.onOpen).not.toHaveBeenCalled();
  });

  it("archives and favorites from the menu", () => {
    const { fns } = setup(sessionRecord());
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(fns.onArchive).toHaveBeenCalledWith("sess-0001-aaaa");
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Favorite" }));
    expect(fns.onFavorite).toHaveBeenCalledWith("sess-0001-aaaa", true);
    expect(fns.onOpen).not.toHaveBeenCalled();
  });

  it("unfavorites and hides Archive for an archived session", () => {
    const { fns } = setup(sessionRecord({ archivedAt: 5, favoriteAt: 9 }));
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Unfavorite" }));
    expect(fns.onFavorite).toHaveBeenCalledWith("sess-0001-aaaa", false);
  });

  it("offers Open session only when it can be opened", () => {
    const onOpenSession = vi.fn();
    const { unmount } = setup(sessionRecord(), { onOpenSession });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open session" }));
    expect(onOpenSession).toHaveBeenCalledWith("sess-0001-aaaa");
    unmount();
    setup(sessionRecord({ status: "ended" }), { onOpenSession });
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Open session" })).toBeNull();
  });

  it("opens the menu on right click and ignores right click inside the rename input", () => {
    setup(sessionRecord());
    fireEvent.contextMenu(screen.getByText("Refactor auth"), { clientX: 20, clientY: 30 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByPlaceholderText("sess-000");
    expect(fireEvent.contextMenu(input)).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renames on Enter with the trimmed value", () => {
    const { fns } = setup(sessionRecord());
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByDisplayValue("Refactor auth");
    fireEvent.click(input);
    expect(fns.onOpen).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "  New name  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fns.onRename).toHaveBeenCalledWith("sess-0001-aaaa", "New name");
    expect(screen.queryByPlaceholderText("sess-000")).toBeNull();
  });

  it("cancels the rename on Escape and submits on blur", () => {
    const { fns } = setup(sessionRecord());
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.keyDown(screen.getByPlaceholderText("sess-000"), { key: "Escape" });
    expect(screen.getByText("Refactor auth")).toBeTruthy();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByPlaceholderText("sess-000");
    fireEvent.change(input, { target: { value: "Blurred" } });
    fireEvent.blur(input);
    expect(fns.onRename).toHaveBeenCalledWith("sess-0001-aaaa", "Blurred");
  });

  it("keeps the card actions inside the footer", () => {
    setup(sessionRecord());
    const card = screen.getByRole("article");
    expect(within(card).getByRole("button", { name: /Focus/ })).toBeTruthy();
  });
});
