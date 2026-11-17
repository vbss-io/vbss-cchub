import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRecord } from "../delegation";
import { fetchHistoryStatus, searchHistory } from "../memory-api";
import { historyHit, historyResult, historyStatus } from "../test-support/u4-fixtures";
import type { HitOpenResult } from "../memory-model";
import type { HistoryHit, HistoryIndexStatus } from "../types";
import { HistorySearchView } from "./HistorySearchView";

vi.mock("../memory-api", () => ({ fetchHistoryStatus: vi.fn(), searchHistory: vi.fn() }));

const statusMock = vi.mocked(fetchHistoryStatus);
const searchMock = vi.mocked(searchHistory);

const workspaces: WorkspaceRecord[] = [{ name: "api-ws", file: "C:/ws/api.json", contextPath: "C:/ws/api", repos: [{ path: "C:/work/api" }] as WorkspaceRecord["repos"], error: null }];

const flush = async (ms = 0): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

interface Harness {
  listeners: Set<(status: HistoryIndexStatus) => void>;
  subscribe: (listener: (status: HistoryIndexStatus) => void) => () => void;
}

const harness = (): Harness => {
  const listeners = new Set<(status: HistoryIndexStatus) => void>();
  return {
    listeners,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

const setup = async (overrides: { onOpenHit?: (hit: HistoryHit) => Promise<HitOpenResult>; onOpenSettings?: () => void } = {}) => {
  const bus = harness();
  const onOpenHit = overrides.onOpenHit ?? vi.fn().mockResolvedValue({ ok: true });
  const onOpenSettings = overrides.onOpenSettings ?? vi.fn();
  render(<HistorySearchView workspaces={workspaces} subscribeHistory={bus.subscribe} onOpenHit={onOpenHit} onOpenSettings={onOpenSettings} />);
  await flush();
  return { bus, onOpenHit, onOpenSettings };
};

const type = async (value: string): Promise<void> => {
  fireEvent.change(screen.getByLabelText("Search history"), { target: { value } });
  await flush(300);
};

beforeEach(() => {
  vi.useFakeTimers();
  statusMock.mockReset();
  searchMock.mockReset();
  statusMock.mockResolvedValue(historyStatus());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HistorySearchView", () => {
  it("shows the index state and asks for at least two letters before searching", async () => {
    await setup();
    expect(screen.getByRole("status").textContent).toBe("Ready");
    expect(screen.getByText("Type at least two letters to search what you and the assistants said.")).toBeTruthy();
    await type("a");
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("searches after the debounce and renders hits with highlight, headline and detail", async () => {
    searchMock.mockResolvedValue(historyResult([historyHit({ matches: 3 })]));
    await setup();
    await type("token");
    expect(searchMock).toHaveBeenCalledTimes(1);
    const query = searchMock.mock.calls[0]?.[0] ?? "";
    expect(query).toContain("q=token");
    expect(screen.getByText("rotate").tagName).toBe("MARK");
    expect(screen.getByText("Claude · Refactor auth · api-ws")).toBeTruthy();
    expect(screen.getByText("You · 2026-11-03 14:05 · 3 matches")).toBeTruthy();
  });

  it("debounces typing into a single request", async () => {
    searchMock.mockResolvedValue(historyResult([]));
    await setup();
    fireEvent.change(screen.getByLabelText("Search history"), { target: { value: "to" } });
    await flush(100);
    fireEvent.change(screen.getByLabelText("Search history"), { target: { value: "tok" } });
    await flush(300);
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0]?.[0]).toContain("q=tok");
    expect(screen.getByText('Nothing found for "tok".')).toBeTruthy();
  });

  it("sends the client, workspace, period, sort and group filters", async () => {
    searchMock.mockResolvedValue(historyResult([historyHit({ client: "codex", sessionId: null, title: null })]));
    await setup();
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "api-ws" } });
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "week" } });
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "recent" } });
    fireEvent.click(screen.getByLabelText("Group by session"));
    await type("token");
    const query = new URLSearchParams(searchMock.mock.calls.at(-1)?.[0]);
    expect(query.get("client")).toBe("codex");
    expect(query.get("sort")).toBe("recent");
    expect(query.get("group")).toBe("session");
    expect(query.get("workspace")).toBeTruthy();
    expect(query.get("from")).toBeTruthy();
    expect(screen.getByText("Codex · unknown session · api-ws")).toBeTruthy();
  });

  it("ignores an unknown client option value", async () => {
    await setup();
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "claude" } });
    expect((screen.getByLabelText("Client") as HTMLSelectElement).value).toBe("claude");
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "" } });
    expect((screen.getByLabelText("Client") as HTMLSelectElement).value).toBe("");
  });

  it("pages with Show more and appends without duplicates", async () => {
    searchMock.mockResolvedValueOnce(historyResult([historyHit({ messageId: 1 }), historyHit({ messageId: 2, snippet: "second hit here", highlights: [] })], { hasMore: true }));
    await setup();
    await type("token");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    searchMock.mockResolvedValueOnce(historyResult([historyHit({ messageId: 2 }), historyHit({ messageId: 3, snippet: "third hit here", highlights: [] })], { hasMore: false }));
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await flush();
    expect(new URLSearchParams(searchMock.mock.calls[1]?.[0]).get("offset")).toBe("2");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("disables Show more and says Loading while the next page is in flight", async () => {
    searchMock.mockResolvedValueOnce(historyResult([historyHit()], { hasMore: true }));
    await setup();
    await type("token");
    let resolve: (value: ReturnType<typeof historyResult>) => void = () => undefined;
    searchMock.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await flush();
    const button = screen.getByRole("button", { name: "Loading..." }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(searchMock).toHaveBeenCalledTimes(2);
    resolve(historyResult([], { hasMore: false }));
    await flush();
    expect(screen.queryByRole("button", { name: "Loading..." })).toBeNull();
  });

  it("shows the error text when the search fails and a fallback for non errors", async () => {
    searchMock.mockRejectedValueOnce(new Error("index locked"));
    await setup();
    await type("token");
    expect(screen.getByText("index locked")).toBeTruthy();
    searchMock.mockRejectedValueOnce("nope");
    await type("tokens");
    expect(screen.getByText("The search failed. Try again.")).toBeTruthy();
  });

  it("opens a hit and shows a failure with the session id and a copy button", async () => {
    searchMock.mockResolvedValue(historyResult([historyHit()]));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onOpenHit = vi.fn().mockResolvedValueOnce({ ok: false, reason: "Session file is gone" }).mockResolvedValueOnce({ ok: true });
    await setup({ onOpenHit });
    await type("token");
    fireEvent.click(screen.getByText("Claude · Refactor auth · api-ws"));
    await flush();
    expect(onOpenHit).toHaveBeenCalledWith(expect.objectContaining({ messageId: 1 }));
    expect(screen.getByRole("alert").textContent).toContain("Session file is gone");
    expect(screen.getByText("sess-aaaa-1111").tagName).toBe("CODE");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await flush();
    expect(writeText).toHaveBeenCalledWith("sess-aaaa-1111");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    await flush(1600);
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    fireEvent.click(screen.getByText("Claude · Refactor auth · api-ws"));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains a failure with no session id", async () => {
    searchMock.mockResolvedValue(historyResult([historyHit({ sessionId: null, title: null })]));
    const onOpenHit = vi.fn().mockResolvedValue({ ok: false, reason: "No session" });
    await setup({ onOpenHit });
    await type("token");
    fireEvent.click(screen.getByText(/unknown session/));
    await flush();
    expect(screen.getByText("No session id was recorded for this match.")).toBeTruthy();
  });

  it("does not mark the copy as done when the clipboard is unavailable", async () => {
    searchMock.mockResolvedValue(historyResult([historyHit()]));
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    const onOpenHit = vi.fn().mockResolvedValue({ ok: false, reason: "gone" });
    await setup({ onOpenHit });
    await type("token");
    fireEvent.click(screen.getByText("Claude · Refactor auth · api-ws"));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await flush();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("points to Memory settings when the index is off", async () => {
    statusMock.mockResolvedValue(historyStatus({ enabled: false }));
    const { onOpenSettings } = await setup();
    expect(screen.getByRole("status").textContent).toBe("Off");
    fireEvent.click(screen.getByRole("button", { name: "Open Memory settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("reports the build progress pushed over the status subscription", async () => {
    const { bus } = await setup();
    act(() => bus.listeners.forEach((listener) => listener(historyStatus({ running: true, progress: { done: 2, total: 9 } }))));
    expect(screen.getByRole("status").textContent).toBe("Building: 2 of 9 files");
    expect(screen.getByText("Building the index (2 of 9 files). You can search while it fills in.")).toBeTruthy();
  });

  it("keeps working when the status request fails", async () => {
    statusMock.mockRejectedValue(new Error("down"));
    await setup();
    expect(screen.getByRole("status").textContent).toBe("Checking...");
  });

  it("clears the results when the query drops under two letters", async () => {
    searchMock.mockResolvedValue(historyResult([historyHit()]));
    await setup();
    await type("token");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    await type("t");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});
