import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { HANDOFF_EXPLAIN } from "../memory-model";
import type { HandoffPreview, MemorySettings } from "../types";
import { WorkspaceContext } from "./WorkspaceContext";

const api = vi.hoisted(() => ({
  fetchHandoffPreview: vi.fn<(workspace: string) => Promise<unknown>>(),
  setHandoffWorkspace: vi.fn<(workspace: string, enabled: boolean) => Promise<unknown>>(),
}));

vi.mock("../memory-api", () => api);

const preview = (overrides: Partial<HandoffPreview> = {}): HandoffPreview => ({ workspace: "vbss", enabled: true, sessions: [], openLoops: [], text: "Recap line one", chars: 14, ...overrides });

beforeEach(() => {
  api.fetchHandoffPreview.mockReset().mockResolvedValue(preview());
  api.setHandoffWorkspace.mockReset().mockResolvedValue({ historyIndex: true, handoffWorkspaces: ["vbss"], summaryHeading: "Summary" } satisfies MemorySettings);
});

const setup = (props: Partial<Parameters<typeof WorkspaceContext>[0]> = {}) => {
  const onChanged = vi.fn();
  const view = render(<WorkspaceContext name="vbss" enabled={false} onChanged={onChanged} {...props} />);
  return { onChanged, ...view };
};

test("explains the feature and shows the preview of what a new session would receive", async () => {
  setup();
  expect(screen.getByText(HANDOFF_EXPLAIN)).toBeTruthy();
  expect(screen.getByText("Loading the preview...")).toBeTruthy();
  expect(await screen.findByText("Recap line one")).toBeTruthy();
  expect(screen.getByText(/Preview of what a new session would receive \(14 of \d+ characters\)/)).toBeTruthy();
  expect(api.fetchHandoffPreview).toHaveBeenCalledWith("vbss");
});

test("an empty preview says there is nothing to carry over", async () => {
  api.fetchHandoffPreview.mockResolvedValue(preview({ text: null, chars: 0 }));
  setup();
  expect(await screen.findByText("Nothing to carry over yet: this workspace has no recent sessions or open loops.")).toBeTruthy();
  expect(screen.getByText("Preview")).toBeTruthy();
  expect(document.querySelector(".mem__preview")).toBeNull();
});

test("a preview that fails to load shows the error and no loading note", async () => {
  api.fetchHandoffPreview.mockRejectedValueOnce(new Error("hub down"));
  setup();
  expect((await screen.findByRole("alert")).textContent).toBe("hub down");
  expect(screen.queryByText("Loading the preview...")).toBeNull();
  api.fetchHandoffPreview.mockRejectedValueOnce("odd");
  setup();
  await vi.waitFor(() => expect(screen.getAllByRole("alert").some((node) => node.textContent === "Something went wrong.")).toBe(true));
});

test("the checkbox reflects the setting and saves the flip, reporting the resulting state", async () => {
  const { onChanged } = setup({ enabled: false });
  const box = screen.getByRole("checkbox", { name: "Context for new sessions" }) as HTMLInputElement;
  expect(box.checked).toBe(false);
  await userEvent.click(box);
  expect(api.setHandoffWorkspace).toHaveBeenCalledWith("vbss", true);
  await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith(true));
});

test("the reported state follows the list the hub returns, not the click", async () => {
  api.setHandoffWorkspace.mockResolvedValue({ historyIndex: true, handoffWorkspaces: [], summaryHeading: "Summary" });
  const { onChanged } = setup({ enabled: true });
  await userEvent.click(screen.getByRole("checkbox"));
  expect(api.setHandoffWorkspace).toHaveBeenCalledWith("vbss", false);
  await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith(false));
});

test("the checkbox locks while saving and a failure is shown without calling onChanged", async () => {
  let fail: (reason: Error) => void = () => undefined;
  api.setHandoffWorkspace.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
  const { onChanged } = setup();
  await userEvent.click(screen.getByRole("checkbox"));
  expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  fail(new Error("not allowed"));
  expect((await screen.findByRole("alert")).textContent).toBe("not allowed");
  expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false);
  expect(onChanged).not.toHaveBeenCalled();
});

test("changing the workspace reloads the preview and a late answer for the old one is dropped", async () => {
  let finishOld: (value: unknown) => void = () => undefined;
  api.fetchHandoffPreview.mockReturnValueOnce(new Promise((done) => (finishOld = done)));
  const { rerender, onChanged } = setup({ name: "old" });
  api.fetchHandoffPreview.mockResolvedValueOnce(preview({ text: "New recap", chars: 9 }));
  rerender(<WorkspaceContext name="new" enabled={false} onChanged={onChanged} />);
  expect(await screen.findByText("New recap")).toBeTruthy();
  finishOld(preview({ text: "Old recap" }));
  await Promise.resolve();
  expect(screen.queryByText("Old recap")).toBeNull();
});

test("a failure for a workspace that was replaced is dropped", async () => {
  let failOld: (reason: Error) => void = () => undefined;
  api.fetchHandoffPreview.mockReturnValueOnce(new Promise((_, reject) => (failOld = reject)));
  const { rerender, onChanged } = setup({ name: "old" });
  rerender(<WorkspaceContext name="new" enabled={false} onChanged={onChanged} />);
  await screen.findByText("Recap line one");
  failOld(new Error("late"));
  await Promise.resolve();
  expect(screen.queryByRole("alert")).toBeNull();
});
