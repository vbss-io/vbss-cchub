import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDailyEntry } from "../delegation";
import { fetchDaySummary, MemoryApiError, writeDaySummary } from "../memory-api";
import type { DaySummary } from "../types";
import { DaySummaryDialog } from "./DaySummaryDialog";

vi.mock("../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../delegation")>()), getDailyEntry: vi.fn() }));
vi.mock("../memory-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../memory-api")>()), fetchDaySummary: vi.fn(), writeDaySummary: vi.fn() }));

const summaryOf = (patch: Partial<DaySummary> = {}): DaySummary => ({
  date: "2026-11-16",
  heading: "Day summary",
  sessions: [],
  tasks: [],
  reports: [],
  commits: [],
  empty: false,
  block: "block",
  digest: "digest-1",
  markdown: "Shipped the **outliner**",
  ...patch,
});

const fetchSummary = vi.mocked(fetchDaySummary);
const writeSummary = vi.mocked(writeDaySummary);
const dailyEntry = vi.mocked(getDailyEntry);

const entry = (exists: boolean, updatedAt: number | null = 100) => ({ date: "2026-11-16", path: "/d.md", exists, content: "", updatedAt });

const renderDialog = () => {
  const onClose = vi.fn();
  const onNotice = vi.fn();
  render(<DaySummaryDialog date="2026-11-16" onClose={onClose} onNotice={onNotice} />);
  return { onClose, onNotice };
};

const writeButton = () => screen.getByRole("button", { name: /Write to daily|Writing/ }) as HTMLButtonElement;

describe("DaySummaryDialog", () => {
  beforeEach(() => {
    fetchSummary.mockReset();
    writeSummary.mockReset();
    dailyEntry.mockReset();
    dailyEntry.mockResolvedValue(entry(true));
  });

  it("builds the summary, previews it and enables the write button", async () => {
    fetchSummary.mockResolvedValue(summaryOf());
    renderDialog();
    expect(screen.getByText("Building the summary...")).toBeTruthy();
    expect(await screen.findByText("outliner")).toBeTruthy();
    expect(fetchSummary).toHaveBeenCalledWith("2026-11-16");
    expect(dailyEntry).toHaveBeenCalledWith("2026-11-16");
    await waitFor(() => expect(writeButton().disabled).toBe(false));
    expect(screen.getByRole("dialog", { name: "Day summary" })).toBeTruthy();
  });

  it("writes the digest with the daily base time and closes with the outcome notice", async () => {
    fetchSummary.mockResolvedValue(summaryOf());
    writeSummary.mockResolvedValue({ date: "2026-11-16", path: "/d.md", updatedAt: 200, changed: true, summary: summaryOf() });
    const { onClose, onNotice } = renderDialog();
    await waitFor(() => expect(writeButton().disabled).toBe(false));
    fireEvent.click(writeButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(writeSummary).toHaveBeenCalledWith("2026-11-16", "digest-1", 100, expect.any(String));
    expect(onNotice).toHaveBeenCalledWith('Written to the daily under "Day summary".');
  });

  it("reports an unchanged write", async () => {
    fetchSummary.mockResolvedValue(summaryOf());
    writeSummary.mockResolvedValue({ date: "2026-11-16", path: "/d.md", updatedAt: 200, changed: false, summary: summaryOf() });
    const { onNotice } = renderDialog();
    await waitFor(() => expect(writeButton().disabled).toBe(false));
    fireEvent.click(writeButton());
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("The daily already has this summary."));
  });

  it("explains an empty day and keeps writing disabled", async () => {
    fetchSummary.mockResolvedValue(summaryOf({ empty: true, markdown: "" }));
    renderDialog();
    expect(await screen.findByText(/Nothing to summarize for this day yet/)).toBeTruthy();
    expect(writeButton().disabled).toBe(true);
  });

  it("explains a missing daily note and keeps writing disabled", async () => {
    dailyEntry.mockResolvedValue(entry(false, null));
    fetchSummary.mockResolvedValue(summaryOf());
    renderDialog();
    expect(await screen.findByText(/There is no daily note for this day yet/)).toBeTruthy();
    expect(writeButton().disabled).toBe(true);
  });

  it("assumes the daily exists when reading it fails", async () => {
    dailyEntry.mockRejectedValue(new Error("boom"));
    fetchSummary.mockResolvedValue(summaryOf());
    renderDialog();
    await waitFor(() => expect(writeButton().disabled).toBe(false));
  });

  it("shows the api error of a failed summary", async () => {
    fetchSummary.mockRejectedValue(new MemoryApiError("The daily feature is disabled", 400, null));
    renderDialog();
    expect((await screen.findByRole("alert")).textContent).toContain("The daily feature is off");
    expect(writeButton().disabled).toBe(true);
  });

  it("shows the message of a plain error", async () => {
    fetchSummary.mockRejectedValue(new Error("offline"));
    renderDialog();
    expect((await screen.findByRole("alert")).textContent).toBe("offline");
  });

  it("uses a generic text when the rejection is not an error", async () => {
    fetchSummary.mockRejectedValue("nope");
    renderDialog();
    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong.");
  });

  it("on a conflict keeps the failure, offers Reload and refreshes the base time", async () => {
    fetchSummary.mockResolvedValue(summaryOf());
    writeSummary.mockRejectedValue(new MemoryApiError("changed", 409, { updatedAt: 300 }));
    renderDialog();
    await waitFor(() => expect(writeButton().disabled).toBe(false));
    fireEvent.click(writeButton());
    expect((await screen.findByRole("alert")).textContent).toBe("The daily changed, reload");
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("on a conflict without a usable time keeps the previous base", async () => {
    fetchSummary.mockResolvedValue(summaryOf());
    writeSummary.mockRejectedValueOnce(new MemoryApiError("changed", 409, null));
    renderDialog();
    await waitFor(() => expect(writeButton().disabled).toBe(false));
    fireEvent.click(writeButton());
    await screen.findByRole("button", { name: "Reload" });
    writeSummary.mockResolvedValue({ date: "2026-11-16", path: "/d.md", updatedAt: 200, changed: true, summary: summaryOf() });
    await waitFor(() => expect(writeButton().disabled).toBe(false));
    fireEvent.click(writeButton());
    await waitFor(() => expect(writeSummary).toHaveBeenCalledTimes(2));
    expect(writeSummary.mock.calls[1]?.[2]).toBe(100);
  });

  it("swaps in the fresh summary when the write says it changed", async () => {
    fetchSummary.mockResolvedValue(summaryOf());
    const fresh = summaryOf({ digest: "digest-2", markdown: "Fresh text", block: "b2" });
    writeSummary.mockRejectedValueOnce(new MemoryApiError("changed", 409, { code: "summary-changed", summary: fresh }));
    renderDialog();
    await waitFor(() => expect(writeButton().disabled).toBe(false));
    fireEvent.click(writeButton());
    expect(await screen.findByText("Fresh text")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("The summary changed, review it again");
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    writeSummary.mockResolvedValue({ date: "2026-11-16", path: "/d.md", updatedAt: 200, changed: true, summary: fresh });
    fireEvent.click(writeButton());
    await waitFor(() => expect(writeSummary).toHaveBeenCalledTimes(2));
    expect(writeSummary.mock.calls[1]?.[1]).toBe("digest-2");
  });

  it("reloads the summary when the changed error carries no fresh copy", async () => {
    fetchSummary.mockResolvedValue(summaryOf());
    writeSummary.mockRejectedValue(new MemoryApiError("changed", 409, { code: "summary-changed" }));
    renderDialog();
    await waitFor(() => expect(writeButton().disabled).toBe(false));
    fireEvent.click(writeButton());
    await waitFor(() => expect(fetchSummary).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert").textContent).toBe("The summary changed, review it again");
  });

  it("shows other write failures without reloading", async () => {
    fetchSummary.mockResolvedValue(summaryOf());
    writeSummary.mockRejectedValue(new MemoryApiError("disk full", 500, null));
    renderDialog();
    await waitFor(() => expect(writeButton().disabled).toBe(false));
    fireEvent.click(writeButton());
    expect((await screen.findByRole("alert")).textContent).toBe("disk full");
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("does nothing when write is triggered before the summary loads", () => {
    fetchSummary.mockReturnValue(new Promise(() => undefined));
    renderDialog();
    expect(writeButton().disabled).toBe(true);
    fireEvent.click(writeButton());
    expect(writeSummary).not.toHaveBeenCalled();
  });

  it("closes from Escape, Close and the overlay but not from inside the dialog", async () => {
    fetchSummary.mockResolvedValue(summaryOf());
    const { onClose } = renderDialog();
    await screen.findByText("outliner");
    fireEvent.keyDown(window, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(document.querySelector(".modal__overlay") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
