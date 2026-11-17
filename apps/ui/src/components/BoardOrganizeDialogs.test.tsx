import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ParentCandidate } from "../board-model";
import { makeTask } from "../test-support/u2-fixtures";
import { BoardMoveProjectDialog, BoardParentPickerDialog } from "./BoardOrganizeDialogs";

const task = makeTask("t1", { title: "Move me" });
const parentA = makeTask("a", { title: "Parent A", line: 3, priority: 1 });
const parentB = makeTask("b", { title: "Archived leftovers", line: 8, section: "done" });
const candidates: ParentCandidate[] = [
  { task: parentA, level: 0 },
  { task: parentB, level: 1 },
];

describe("BoardParentPickerDialog", () => {
  const setup = (props: Partial<Parameters<typeof BoardParentPickerDialog>[0]> = {}) => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    render(<BoardParentPickerDialog task={task} candidates={candidates} busy={false} onCancel={onCancel} onSubmit={onSubmit} {...props} />);
    return { onCancel, onSubmit };
  };

  it("lists the candidates as radios with priority and a done-section hint", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Make subtask of" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "New parent task" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByText("P1")).toBeTruthy();
    expect(screen.getByText("Archived leftovers (done section)")).toBeTruthy();
    expect(screen.getByText("Move me")).toBeTruthy();
  });

  it("enables the action only after choosing and submits the chosen parent", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    const action = screen.getByRole("button", { name: "Make subtask" }) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    await user.click(screen.getByRole("radio", { name: /Archived leftovers/ }));
    expect(action.disabled).toBe(false);
    expect(screen.getByRole("radio", { name: /Archived leftovers/ }).closest("label")?.className).toContain("board-pick__item--on");
    await user.click(action);
    expect(onSubmit).toHaveBeenCalledWith(parentB);
  });

  it("explains when there is no valid parent", () => {
    setup({ candidates: [] });
    expect(screen.getByText("No other task in this project can become its parent.")).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect((screen.getByRole("button", { name: "Make subtask" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("locks the dialog while busy", () => {
    const { onCancel } = setup({ busy: true });
    expect(screen.getByRole("button", { name: "Moving…" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("radio")[0] as HTMLInputElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(document.querySelector(".modal__overlay") as HTMLElement);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels with the button, Escape and the overlay but not from inside", async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "q" });
    fireEvent.click(screen.getByRole("dialog"));
    expect(onCancel).toHaveBeenCalledTimes(2);
    fireEvent.click(document.querySelector(".modal__overlay") as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(3);
  });
});

describe("BoardMoveProjectDialog", () => {
  const projects = [
    { id: "p2", label: "Project Two", depth: 0 },
    { id: "p3", label: "Project Three", depth: 0 },
  ];
  const tasks = [makeTask("x", { projectId: "p2", title: "Existing", line: 5 }), makeTask("y", { projectId: "p3", title: "Elsewhere", line: 2 })];

  const setup = (props: Partial<Parameters<typeof BoardMoveProjectDialog>[0]> = {}) => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    render(<BoardMoveProjectDialog task={task} projects={projects} tasks={tasks} busy={false} onCancel={onCancel} onSubmit={onSubmit} {...props} />);
    return { onCancel, onSubmit };
  };

  it("requires a target project and keeps the placement disabled until then", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Move to project" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Parent task in the target project") as HTMLSelectElement).disabled).toBe(true);
  });

  it("moves to the top level of the chosen project", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.selectOptions(screen.getByLabelText("Target project"), "p2");
    await user.click(screen.getByRole("button", { name: "Move" }));
    expect(onSubmit).toHaveBeenCalledWith("p2", null);
  });

  it("offers the tasks of the target as parents and moves under the chosen one", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.selectOptions(screen.getByLabelText("Target project"), "p2");
    const parent = screen.getByLabelText("Parent task in the target project") as HTMLSelectElement;
    expect(Array.from(parent.options).map((option) => option.textContent)).toEqual(["Top level", "Existing"]);
    await user.selectOptions(parent, "x");
    await user.click(screen.getByRole("button", { name: "Move" }));
    expect(onSubmit).toHaveBeenCalledWith("p2", tasks[0]);
  });

  it("clears the chosen parent when the target project changes", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.selectOptions(screen.getByLabelText("Target project"), "p2");
    await user.selectOptions(screen.getByLabelText("Parent task in the target project"), "x");
    await user.selectOptions(screen.getByLabelText("Target project"), "p3");
    expect((screen.getByLabelText("Parent task in the target project") as HTMLSelectElement).value).toBe("");
    await user.click(screen.getByRole("button", { name: "Move" }));
    expect(onSubmit).toHaveBeenCalledWith("p3", null);
  });

  it("locks the dialog while busy", () => {
    const { onCancel } = setup({ busy: true });
    expect(screen.getByRole("button", { name: "Moving…" })).toBeTruthy();
    expect((screen.getByLabelText("Target project") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(document.querySelector(".modal__overlay") as HTMLElement);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels with the button, Escape and the overlay", async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("dialog"));
    expect(onCancel).toHaveBeenCalledTimes(2);
    fireEvent.click(document.querySelector(".modal__overlay") as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(3);
  });
});
