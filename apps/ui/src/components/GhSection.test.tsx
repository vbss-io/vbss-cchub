import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGh } from "../review-api";
import type { GhRun, GhStatus } from "../types";
import { GhSection } from "./GhSection";

vi.mock("../review-api", () => ({ fetchGh: vi.fn() }));

const fetchGhMock = vi.mocked(fetchGh);

const run = (overrides: Partial<GhRun> = {}): GhRun => ({
  id: 1,
  title: "fix auth",
  workflow: "CI",
  status: "completed",
  conclusion: "success",
  url: "https://github.com/o/r/actions/runs/1",
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  branch: "main",
  event: "push",
  ...overrides,
});

const available = (overrides: Partial<Extract<GhStatus, { available: true }>> = {}): GhStatus => ({
  available: true,
  branch: "feat/x",
  pr: null,
  runs: [],
  fetchedAt: 1,
  ...overrides,
});

describe("GhSection", () => {
  beforeEach(() => {
    fetchGhMock.mockReset();
  });

  it("renders nothing when gh is not available", async () => {
    fetchGhMock.mockResolvedValue({ available: false, reason: "gh missing" });
    const { container } = render(<GhSection subject={{ kind: "task", id: "t1" }} />);
    await waitFor(() => expect(fetchGhMock).toHaveBeenCalled());
    expect(container.querySelector(".gh")).toBeNull();
  });

  it("renders nothing and stays quiet when the request fails", async () => {
    fetchGhMock.mockRejectedValue(new Error("boom"));
    const { container } = render(<GhSection subject={{ kind: "session", id: "s1" }} />);
    await waitFor(() => expect(fetchGhMock).toHaveBeenCalledWith({ kind: "session", id: "s1" }, expect.any(AbortSignal)));
    expect(container.querySelector(".gh")).toBeNull();
  });

  it("says there is no pull request for the branch", async () => {
    fetchGhMock.mockResolvedValue(available());
    render(<GhSection subject={{ kind: "task", id: "t1" }} />);
    expect(await screen.findByText("No pull request for feat/x")).toBeTruthy();
  });

  it("shows the pull request, its checks and the runs with safe links only", async () => {
    fetchGhMock.mockResolvedValue(
      available({
        pr: { number: 7, title: "Add thing", state: "OPEN", url: "https://github.com/o/r/pull/7", headRefName: "feat/x", isDraft: true, checks: { total: 4, passing: 3, failing: 1, pending: 0, state: "failing" } },
        runs: [run(), run({ id: null, title: "lint", workflow: null, status: "in_progress", conclusion: null, url: "http://insecure.test/run", createdAt: null })],
      }),
    );
    render(<GhSection subject={{ kind: "task", id: "t1" }} />);
    const link = await screen.findByRole("link", { name: "#7 Add thing" });
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/pull/7");
    expect(screen.getByText(/Draft/)).toBeTruthy();
    expect(screen.getByText(/1 of 4 checks failing/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "CI: fix auth" }).getAttribute("href")).toBe("https://github.com/o/r/actions/runs/1");
    expect(screen.queryByRole("link", { name: "lint" })).toBeNull();
    expect(screen.getByText("lint")).toBeTruthy();
    expect(screen.getByText("in progress")).toBeTruthy();
    expect(screen.getByText("success")).toBeTruthy();
  });

  it("refetches when the subject changes", async () => {
    fetchGhMock.mockResolvedValue(available());
    const { rerender } = render(<GhSection subject={{ kind: "task", id: "t1" }} />);
    await screen.findByText("No pull request for feat/x");
    rerender(<GhSection subject={{ kind: "task", id: "t2" }} />);
    await waitFor(() => expect(fetchGhMock).toHaveBeenCalledTimes(2));
    expect(fetchGhMock.mock.calls[1]?.[0]).toEqual({ kind: "task", id: "t2" });
  });
});
