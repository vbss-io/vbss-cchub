import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HubRequestError } from "../hub-request";
import { copyText } from "../memory-clipboard";
import { fetchDiff, fetchGh, sendReview } from "../review-api";
import { diffFile, diffResult } from "../test-support/u4-fixtures";
import type { DiffFile, DiffResult } from "../types";
import { ReviewPanel } from "./ReviewPanel";

vi.mock("../review-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../review-api")>()),
  fetchDiff: vi.fn(),
  sendReview: vi.fn(),
  fetchGh: vi.fn(),
}));

vi.mock("../memory-clipboard", () => ({ copyText: vi.fn() }));

const fetchDiffMock = vi.mocked(fetchDiff);
const sendMock = vi.mocked(sendReview);
const copyMock = vi.mocked(copyText);

const task = { kind: "task", id: "t1" } as const;
const session = { kind: "session", id: "s1" } as const;

beforeEach(() => {
  fetchDiffMock.mockReset();
  sendMock.mockReset();
  copyMock.mockReset();
  vi.mocked(fetchGh).mockReset();
  vi.mocked(fetchGh).mockResolvedValue({ available: false, reason: "no gh" });
});

const setup = async (diff: DiffResult, extra: Partial<Parameters<typeof ReviewPanel>[0]> = {}) => {
  fetchDiffMock.mockResolvedValue(diff);
  const onError = vi.fn();
  const view = render(<ReviewPanel subject={task} running={false} refreshKey="done" onError={onError} {...extra} />);
  await waitFor(() => expect(fetchDiffMock).toHaveBeenCalled());
  return { onError, ...view };
};

const addComment = (lineLabel: string, text: string) => {
  fireEvent.click(screen.getByRole("button", { name: lineLabel }));
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /^(Add|Save) comment$/ }));
};

describe("ReviewPanel loading", () => {
  it("shows a loading hint then the totals and file list", async () => {
    await setup(diffResult([diffFile()]));
    expect(await screen.findByText("vs HEAD")).toBeTruthy();
    expect(screen.getByText("1 file · +1 -1")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("No comments yet")).toBeTruthy();
  });

  it("shows the loading text while the diff is pending", () => {
    fetchDiffMock.mockReturnValue(new Promise(() => undefined));
    render(<ReviewPanel subject={task} running={false} refreshKey="x" onError={vi.fn()} />);
    expect(screen.getByText("Loading the diff...")).toBeTruthy();
  });

  it("reports an unavailable diff with its reason", async () => {
    await setup({ available: false, reason: "not a git repo" });
    expect(await screen.findByText("No diff to review: not a git repo.")).toBeTruthy();
  });

  it("shows the load failure as an alert and no file list", async () => {
    fetchDiffMock.mockRejectedValueOnce(new Error("hub down"));
    render(<ReviewPanel subject={task} running={false} refreshKey="x" onError={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toBe("hub down");
    expect(screen.queryByText("Loading the diff...")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("uses a fallback message for a non error failure", async () => {
    fetchDiffMock.mockRejectedValueOnce("x");
    render(<ReviewPanel subject={task} running={false} refreshKey="x" onError={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Could not load the diff.");
  });

  it("says there is nothing to review for an empty diff and refreshes on demand", async () => {
    await setup(diffResult([]));
    expect(await screen.findByText("No changes to review.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchDiffMock).toHaveBeenCalledTimes(2));
  });

  it("explains truncated lists and files", async () => {
    await setup(diffResult([diffFile({ truncated: true, totalLines: 5000, shownLines: 2000 })], { filesTruncated: true }));
    expect(await screen.findByText("The list is cut off: only the first files are shown")).toBeTruthy();
    expect(screen.getByText("Long files are cut off: use Show more inside the file")).toBeTruthy();
    expect(screen.getByText("Showing 2,000 of 5,000 lines")).toBeTruthy();
  });

  it("refetches when the refresh key changes", async () => {
    const { rerender } = await setup(diffResult([diffFile()]));
    await screen.findByText("vs HEAD");
    rerender(<ReviewPanel subject={task} running={false} refreshKey="running" onError={vi.fn()} />);
    await waitFor(() => expect(fetchDiffMock).toHaveBeenCalledTimes(2));
  });
});

describe("ReviewPanel files", () => {
  const many = (): DiffFile[] => ["a", "b", "c", "d"].map((name) => diffFile({ path: `src/${name}.ts` }));

  it("collapses files by default beyond three and toggles one", async () => {
    await setup(diffResult(many()));
    const head = await screen.findByRole("button", { name: /src\/a\.ts/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Comment on line 1" })).toBeNull();
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("button", { name: "Comment on line 1" })).toHaveLength(1);
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
  });

  it("labels renamed, binary and too large files", async () => {
    await setup(
      diffResult([
        diffFile({ path: "new.ts", oldPath: "old.ts", status: "renamed" }),
        diffFile({ path: "img.png", status: "added", binary: true, hunks: [] }),
        diffFile({ path: "big.sql", status: "added", tooLarge: true, hunks: [] }),
      ]),
    );
    expect(await screen.findByText("old.ts to new.ts")).toBeTruthy();
    expect(screen.getByText("Binary file, no text diff")).toBeTruthy();
    expect(screen.getByText("File too large to show")).toBeTruthy();
    expect(screen.getByTitle("renamed").textContent).toBe("R");
  });

  it("loads the whole file with Show more and merges it in", async () => {
    await setup(diffResult([diffFile({ truncated: true, totalLines: 10, shownLines: 3 })]));
    await screen.findByText("Showing 3 of 10 lines");
    const full = diffFile({ truncated: false, totalLines: 10, shownLines: 10 });
    let resolve: (value: DiffResult) => void = () => undefined;
    fetchDiffMock.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect((await screen.findByRole("button", { name: "Loading..." })).hasAttribute("disabled")).toBe(true);
    resolve(diffResult([full]));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Show more|Loading/ })).toBeNull());
    expect(fetchDiffMock.mock.calls.at(-1)?.[1]).toEqual({ file: "src/a.ts" });
    expect(screen.queryByText("Showing 3 of 10 lines")).toBeNull();
  });

  it("ignores an unavailable detail and reports a failed one", async () => {
    const { onError } = await setup(diffResult([diffFile({ truncated: true, totalLines: 10, shownLines: 3 })]));
    await screen.findByText("Showing 3 of 10 lines");
    fetchDiffMock.mockResolvedValueOnce({ available: false, reason: "gone" });
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy());
    expect(onError).not.toHaveBeenCalled();
    fetchDiffMock.mockRejectedValueOnce(new Error("slow disk"));
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("slow disk"));
    fetchDiffMock.mockResolvedValueOnce(diffResult([diffFile({ path: "other.ts" })]));
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(fetchDiffMock).toHaveBeenCalledTimes(4));
    expect(screen.getByText("Showing 3 of 10 lines")).toBeTruthy();
  });
});

describe("ReviewPanel comments", () => {
  it("adds, edits and removes a line comment and counts it on the file", async () => {
    await setup(diffResult([diffFile()]));
    fireEvent.click(await screen.findByRole("button", { name: "Comment on line 2" }));
    const save = screen.getByRole("button", { name: "Add comment" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "rename this" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(screen.getByText("rename this")).toBeTruthy();
    expect(screen.getByText("1 comment in 1 file")).toBeTruthy();
    expect(screen.getByRole("button", { name: /src\/a\.ts/ }).textContent).toContain("1");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("rename this");
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "rename that" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    expect(screen.getByText("rename that")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByText("rename that")).toBeNull();
    expect(screen.getByText("No comments yet")).toBeTruthy();
  });

  it("cancels an edit and comments on removed lines", async () => {
    await setup(diffResult([diffFile()]));
    fireEvent.click(await screen.findByRole("button", { name: "Comment on removed line 2" }));
    expect(screen.getByLabelText("Comment")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Comment")).toBeNull();
  });

  it("disables lines that cannot take a comment", async () => {
    await setup(diffResult([diffFile({ hunks: [{ header: "@@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ kind: "ctx", oldLine: null, newLine: null, text: "orphan" }] }] })]));
    const line = (await screen.findByText("orphan")).closest("button");
    expect(line?.hasAttribute("disabled")).toBe(true);
  });

  it("previews the composed review text with line context", async () => {
    await setup(diffResult([diffFile()]));
    await screen.findByText("vs HEAD");
    expect((screen.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(true);
    addComment("Comment on line 2", "use a constant");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const preview = document.querySelector(".rv__preview");
    expect(preview?.textContent).toContain("Review of your changes (1 comment).");
    expect(preview?.textContent).toContain("- src/a.ts:2");
    expect(preview?.textContent).toContain("> const b = 3;");
    expect(preview?.textContent).toContain("use a constant");
    expect(screen.getByRole("button", { name: "Preview" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("ReviewPanel Send review", () => {
  it("sends a task review as a follow-up, clears the comments and links the task", async () => {
    sendMock.mockResolvedValue({ mode: "continue", taskId: "t1", text: "t", task: {} });
    const onOpenTask = vi.fn();
    await setup(diffResult([diffFile()]), { onOpenTask });
    await screen.findByText("vs HEAD");
    addComment("Comment on line 2", "fix it");
    addComment("Comment on removed line 2", "why removed");
    expect(screen.getByText("2 comments in 1 file")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send review" }));
    expect((await screen.findByRole("status")).textContent).toContain("Review sent as a follow-up on this task.");
    expect(sendMock).toHaveBeenCalledWith(task, [
      { file: "src/a.ts", line: 2, side: "new", text: "fix it" },
      { file: "src/a.ts", line: 2, side: "old", text: "why removed" },
    ]);
    expect(screen.getByText("No comments yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open task" })).toBeNull();
  });

  it("offers to open the new task when the review started one", async () => {
    sendMock.mockResolvedValue({ mode: "new-task", taskId: "t2", text: "t", task: {} });
    const onOpenTask = vi.fn();
    await setup(diffResult([diffFile()]), { onOpenTask });
    await screen.findByText("vs HEAD");
    addComment("Comment on line 2", "fix it");
    fireEvent.click(screen.getByRole("button", { name: "Send review" }));
    expect((await screen.findByRole("status")).textContent).toContain("started a new task");
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    expect(onOpenTask).toHaveBeenCalledWith("t2");
  });

  it("disables Send review while a task is running", async () => {
    await setup(diffResult([diffFile()]), { running: true });
    await screen.findByText("vs HEAD");
    addComment("Comment on line 2", "fix it");
    const send = screen.getByRole("button", { name: "Send review" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toBe("Wait for the run to finish");
  });

  it("copies a session review to the clipboard and offers to open the session", async () => {
    sendMock.mockResolvedValue({ mode: "copy", sessionId: "s1", text: "REVIEW TEXT" });
    copyMock.mockResolvedValue(true);
    const onOpenSession = vi.fn();
    await setup(diffResult([diffFile()]), { subject: session, onOpenSession });
    await screen.findByText("vs HEAD");
    addComment("Comment on line 2", "fix it");
    fireEvent.click(screen.getByRole("button", { name: "Send review" }));
    expect((await screen.findByRole("status")).textContent).toContain("Review copied. Paste it into the session.");
    expect(copyMock).toHaveBeenCalledWith("REVIEW TEXT");
    expect(sendMock).toHaveBeenCalledWith(session, expect.any(Array));
    expect(screen.getByText("1 comment in 1 file")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
  });

  it("falls back to the preview when the clipboard refuses", async () => {
    sendMock.mockResolvedValue({ mode: "copy", sessionId: "s1", text: "REVIEW TEXT" });
    copyMock.mockResolvedValue(false);
    await setup(diffResult([diffFile()]), { subject: session });
    await screen.findByText("vs HEAD");
    addComment("Comment on line 2", "fix it");
    fireEvent.click(screen.getByRole("button", { name: "Send review" }));
    expect((await screen.findByRole("status")).textContent).toContain("Could not copy automatically. Use Preview and copy the text.");
    expect(document.querySelector(".rv__preview")).toBeTruthy();
  });

  it("reports a preview only result without clearing comments", async () => {
    sendMock.mockResolvedValue({ mode: "preview", taskId: "t1", text: "t" });
    await setup(diffResult([diffFile()]));
    await screen.findByText("vs HEAD");
    addComment("Comment on line 2", "fix it");
    fireEvent.click(screen.getByRole("button", { name: "Send review" }));
    expect((await screen.findByRole("status")).textContent).toContain("Preview only, nothing was sent.");
    expect(screen.getByText("1 comment in 1 file")).toBeTruthy();
  });

  it("explains a busy task and a generic send failure", async () => {
    const { onError } = await setup(diffResult([diffFile()]));
    await screen.findByText("vs HEAD");
    addComment("Comment on line 2", "fix it");
    sendMock.mockRejectedValueOnce(new HubRequestError("busy", 409, null));
    fireEvent.click(screen.getByRole("button", { name: "Send review" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("The task is still running. Send the review when it finishes."));
    sendMock.mockRejectedValueOnce(new Error("network"));
    fireEvent.click(screen.getByRole("button", { name: "Send review" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("network"));
    sendMock.mockRejectedValueOnce("odd");
    fireEvent.click(screen.getByRole("button", { name: "Send review" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not send the review."));
  });

  it("drops the draft comments when the subject changes", async () => {
    const { rerender } = await setup(diffResult([diffFile()]));
    await screen.findByText("vs HEAD");
    addComment("Comment on line 2", "fix it");
    expect(screen.getByText("1 comment in 1 file")).toBeTruthy();
    rerender(<ReviewPanel subject={{ kind: "task", id: "t9" }} running={false} refreshKey="done" onError={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("No comments yet")).toBeTruthy());
    expect(within(document.body).queryByText("fix it")).toBeNull();
  });
});
