import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BoardCreateInput } from "../delegation";
import { makeProject, makeTask } from "../test-support/u2-fixtures";
import { BoardNewTaskDialog } from "./BoardNewTaskDialog";

const projects = [makeProject("alpha", { title: "Alpha" }), makeProject("beta", { title: "Beta", parent: "alpha", depth: 1 })];

const setup = (props: Partial<Parameters<typeof BoardNewTaskDialog>[0]> = {}) => {
  const onCancel = vi.fn();
  const onSubmit = vi.fn<(body: BoardCreateInput) => Promise<void>>(() => Promise.resolve());
  render(<BoardNewTaskDialog projects={projects} defaultProjectId="alpha" parent={null} onCancel={onCancel} onSubmit={onSubmit} {...props} />);
  return { onCancel, onSubmit };
};

const createButton = () => screen.getByRole("button", { name: /^(Create|Creating…)$/ }) as HTMLButtonElement;

describe("BoardNewTaskDialog", () => {
  it("opens as a New task dialog with the default project shown as a hint", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "New task" })).toBeTruthy();
    expect(screen.getByText("In Alpha")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Title" }));
  });

  it("blocks creation with a reason until the title is filled", async () => {
    const user = userEvent.setup();
    setup();
    expect(createButton().disabled).toBe(true);
    expect(createButton().title).toBe("Give the task a title");
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Write docs");
    expect(createButton().disabled).toBe(false);
    expect(createButton().title).toBe("");
  });

  it("asks for a project in the main form when none is preselected", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ defaultProjectId: "" });
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Orphan");
    expect(createButton().title).toBe("Pick a project");
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "beta");
    await user.click(createButton());
    expect(onSubmit).toHaveBeenCalledWith({ projectId: "beta", title: "Orphan", status: "todo" });
  });

  it("submits the trimmed title with status, priority, due date and reason", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByRole("textbox", { name: "Title" }), "  Fix bug  ");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "blocked");
    await user.selectOptions(screen.getByRole("combobox", { name: "Priority" }), "1");
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-12-24" } });
    fireEvent.blur(screen.getByLabelText("Due date"));
    await user.type(screen.getByRole("textbox", { name: /Reason/ }), " vendor ");
    await user.click(createButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ projectId: "alpha", title: "Fix bug", status: "blocked", reason: "vendor", priority: 1, due: "2026-12-24" });
  });

  it("only offers the reason field for statuses that support it", async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.queryByRole("textbox", { name: /Reason/ })).toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "hold");
    expect(screen.getByRole("textbox", { name: /Reason/ })).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "doing");
    expect(screen.queryByRole("textbox", { name: /Reason/ })).toBeNull();
  });

  it("submits with Enter from the title and from the reason field", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByRole("textbox", { name: "Title" }), "One{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(createButton().disabled).toBe(false));
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "blocked");
    await user.type(screen.getByRole("textbox", { name: /Reason/ }), "why{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith({ projectId: "alpha", title: "One", status: "blocked", reason: "why" });
  });

  it("does not submit with Enter while the form is blocked", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByRole("textbox", { name: "Title" }), "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows the busy label while submitting and then the error when it fails", async () => {
    const user = userEvent.setup();
    let reject: (reason: unknown) => void = () => undefined;
    const pending = new Promise<void>((_, fail) => {
      reject = fail;
    });
    const { onCancel } = setup({ onSubmit: vi.fn(() => pending) });
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Slow");
    await user.click(createButton());
    expect(createButton().textContent).toBe("Creating…");
    expect(createButton().disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(document.querySelector(".modal__overlay") as HTMLElement);
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => {
      reject(new Error("disk full"));
      await pending.catch(() => undefined);
    });
    expect(screen.getByText("disk full")).toBeTruthy();
    expect(createButton().textContent).toBe("Create");
  });

  it("falls back to a generic error for non-Error rejections", async () => {
    const user = userEvent.setup();
    setup({ onSubmit: vi.fn(() => Promise.reject("nope")) });
    await user.type(screen.getByRole("textbox", { name: "Title" }), "X{Enter}");
    expect(await screen.findByText("could not create the task")).toBeTruthy();
  });

  it("cancels from the button, Escape and an overlay click but not from inside the dialog", async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "a" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onCancel).toHaveBeenCalledTimes(2);
    fireEvent.click(document.querySelector(".modal__overlay") as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it("creates a subtask under the parent with its position", async () => {
    const user = userEvent.setup();
    const parent = makeTask("parent", { projectId: "beta", title: "Parent task", line: 7, raw: "- [ ] Parent task" });
    const { onSubmit } = setup({ parent });
    expect(screen.getByRole("dialog", { name: "Add subtask" })).toBeTruthy();
    expect(screen.getByText(/Under "Parent task" in/).textContent).toContain("Alpha › Beta");
    expect(screen.queryByRole("combobox", { name: "Project" })).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Child{Enter}");
    expect(onSubmit).toHaveBeenCalledWith({ projectId: "beta", title: "Child", status: "todo", parentLine: 7, parentRaw: "- [ ] Parent task" });
  });

  it("blocks creation and opens the options when the due date is invalid", () => {
    setup();
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Dated" } });
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "1999-05-05" } });
    expect(createButton().disabled).toBe(true);
    expect(createButton().title).toBe("Fix the due date first");
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(document.querySelector("details.more-options")?.hasAttribute("open")).toBe(true);
  });

  it("clears the due date again when the date is emptied", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Dated");
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-12-01" } });
    fireEvent.blur(screen.getByLabelText("Due date"));
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "" } });
    fireEvent.blur(screen.getByLabelText("Due date"));
    await user.click(createButton());
    expect(onSubmit).toHaveBeenCalledWith({ projectId: "alpha", title: "Dated", status: "todo" });
  });

  it("lets the user change the project from the options when one is preselected", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "beta");
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Moved{Enter}");
    expect(onSubmit).toHaveBeenCalledWith({ projectId: "beta", title: "Moved", status: "todo" });
  });

  it("tracks the options panel open state through its toggle event", () => {
    setup();
    const details = document.querySelector("details.more-options") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(details.hasAttribute("open")).toBe(true);
    details.open = false;
    fireEvent(details, new Event("toggle"));
    expect(details.hasAttribute("open")).toBe(false);
  });
});
