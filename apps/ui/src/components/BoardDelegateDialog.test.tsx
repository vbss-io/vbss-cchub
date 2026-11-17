import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeProject, makeTask, makeWorkspace } from "../test-support/u2-fixtures";
import { BoardDelegateDialog, type BoardDelegateRequest } from "./BoardDelegateDialog";

const task = makeTask("t1", { title: "Ship feature", status: "doing", priority: 1 });
const template = "Work on {{task}} ({{status}}, {{priority}}) in {{project}}";
const workspaces = [makeWorkspace("vbss", ["api", "web"]), makeWorkspace("space", ["core"])];

const setup = (props: Partial<Parameters<typeof BoardDelegateDialog>[0]> = {}) => {
  const onCancel = vi.fn();
  const onSubmit = vi.fn<(request: BoardDelegateRequest) => Promise<void>>(() => Promise.resolve());
  render(
    <BoardDelegateDialog
      task={task}
      project={makeProject("p1", { title: "Platform", workspace: "vbss", workspaceSource: "own" })}
      template={template}
      workspaces={workspaces}
      notice={null}
      taskMissing={false}
      onCancel={onCancel}
      onSubmit={onSubmit}
      {...props}
    />,
  );
  return { onCancel, onSubmit };
};

const delegateButton = () => screen.getByRole("button", { name: /^(Delegate|Delegating…)$/ }) as HTMLButtonElement;
const prompt = () => screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;

describe("BoardDelegateDialog", () => {
  it("preselects the workspace named by the project, ignoring case, and explains where it came from", () => {
    setup({ project: makeProject("p1", { workspace: "VBSS", workspaceSource: "inherited" }) });
    expect((screen.getByRole("combobox", { name: /^Workspace/ }) as HTMLSelectElement).value).toBe("vbss");
    expect(screen.getByText(/inherited from a parent project/)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Delegate task" })).toBeTruthy();
    expect(screen.getByText("Ship feature")).toBeTruthy();
  });

  it("states the project workspace came from its own notes", () => {
    setup();
    expect(screen.getByText("From the project notes.")).toBeTruthy();
  });

  it("selects the only workspace when the project names none", () => {
    setup({ project: makeProject("p1"), workspaces: [makeWorkspace("solo")] });
    expect((screen.getByRole("combobox", { name: /^Workspace/ }) as HTMLSelectElement).value).toBe("solo");
  });

  it("requires a choice when there are several workspaces and warns about an unregistered one", () => {
    setup({ project: makeProject("p1", { workspace: "ghost", workspaceSource: "own" }) });
    expect((screen.getByRole("combobox", { name: /^Workspace/ }) as HTMLSelectElement).value).toBe("");
    expect(screen.getByText(/which is not registered in the hub/)).toBeTruthy();
    expect(delegateButton().disabled).toBe(true);
  });

  it("renders the default prompt from the template and tracks edits and reset", async () => {
    const user = userEvent.setup();
    setup();
    expect(prompt().value).toBe("Work on Ship feature (doing, P1) in Platform");
    expect(screen.getByText("Runs the default prompt for this task.")).toBeTruthy();
    const reset = screen.getByRole("button", { name: "Reset prompt", hidden: true }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    await user.type(prompt(), "!");
    expect(screen.getByText("Runs your edited prompt.")).toBeTruthy();
    expect(reset.disabled).toBe(false);
    await user.click(reset);
    expect(prompt().value).toBe("Work on Ship feature (doing, P1) in Platform");
  });

  it("lists repositories of the chosen workspace and resets the repo when it changes", async () => {
    const user = userEvent.setup();
    setup();
    const repo = screen.getByRole("combobox", { name: "Repository (optional)", hidden: true }) as HTMLSelectElement;
    expect(Array.from(repo.options).map((option) => option.textContent)).toEqual(["whole workspace", "api", "web"]);
    await user.selectOptions(repo, "web");
    expect(repo.value).toBe("web");
    await user.selectOptions(screen.getByRole("combobox", { name: /^Workspace/ }), "space");
    expect(repo.value).toBe("");
    expect(Array.from(repo.options).map((option) => option.textContent)).toEqual(["whole workspace", "core"]);
  });

  it("disables the repository choice until a workspace is selected", () => {
    setup({ project: makeProject("p1") });
    expect((screen.getByRole("combobox", { name: "Repository (optional)", hidden: true }) as HTMLSelectElement).disabled).toBe(true);
  });

  it("submits the workspace, repo, runner and prompt", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Repository (optional)", hidden: true }), "api");
    await user.selectOptions(screen.getByRole("combobox", { name: "Runner", hidden: true }), "codex");
    await user.click(delegateButton());
    expect(onSubmit).toHaveBeenCalledWith({ workspace: "vbss", repo: "api", runner: "codex", prompt: "Work on Ship feature (doing, P1) in Platform" });
  });

  it("blocks delegation with an empty prompt", async () => {
    const user = userEvent.setup();
    setup();
    await user.clear(prompt());
    expect(delegateButton().disabled).toBe(true);
  });

  it("disables delegation and shows the notice when the task is gone", () => {
    setup({ taskMissing: true, notice: "This task no longer exists" });
    expect(delegateButton().disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("This task no longer exists");
  });

  it("shows the busy label and locks cancellation while submitting, then the error", async () => {
    const user = userEvent.setup();
    let fail: (error: unknown) => void = () => undefined;
    const pending = new Promise<void>((_, reject) => {
      fail = reject;
    });
    const { onCancel } = setup({ onSubmit: vi.fn(() => pending) });
    await user.click(delegateButton());
    expect(delegateButton().textContent).toBe("Delegating…");
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reset prompt", hidden: true }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(document.querySelector(".modal__overlay") as HTMLElement);
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => {
      fail(new Error("runner offline"));
      await pending.catch(() => undefined);
    });
    expect(screen.getByText("runner offline")).toBeTruthy();
    expect(delegateButton().textContent).toBe("Delegate");
  });

  it("falls back to a generic message for non-Error failures", async () => {
    const user = userEvent.setup();
    setup({ onSubmit: vi.fn(() => Promise.reject("boom")) });
    await user.click(delegateButton());
    expect(await screen.findByText("could not delegate")).toBeTruthy();
  });

  it("cancels with the button, Escape and the overlay but not from inside", async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "x" });
    fireEvent.click(screen.getByRole("dialog"));
    expect(onCancel).toHaveBeenCalledTimes(2);
    fireEvent.click(document.querySelector(".modal__overlay") as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(3);
  });
});
