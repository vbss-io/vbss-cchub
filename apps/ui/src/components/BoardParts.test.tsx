import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DATE_RANGE_MESSAGE, FINISHED_OCCURRENCE_HINT } from "../board-model";
import type { BoardTask } from "../delegation";
import { makeNote, makeTask } from "../test-support/u2-fixtures";
import {
  BoardBulkBar,
  BoardDateFields,
  BoardDateInput,
  BoardDatesReadOnly,
  BoardDoneStamp,
  BoardDueChip,
  BoardExpandButton,
  BoardNoteAdd,
  BoardNoteRow,
  BoardNotes,
  BoardOutOfSyncBadge,
  BoardPriorityBadge,
  BoardPriorityField,
  BoardPrioritySelect,
  BoardReason,
  BoardRepeatMark,
  BoardStatusChip,
  BoardStatusSelect,
  BoardSubtasks,
  BoardTitle,
  BoardTodayBadge,
  BoardTodayStatus,
  type BoardNoteActions,
  type BoardTodayControls,
} from "./BoardParts";

const noteActions = () => ({
  onAdd: vi.fn<BoardNoteActions["onAdd"]>(() => Promise.resolve(true)),
  onEdit: vi.fn<BoardNoteActions["onEdit"]>(),
  onDelete: vi.fn<BoardNoteActions["onDelete"]>(),
});

function TitleHarness({ task, onRename, disabled, readOnly }: { task: BoardTask; onRename: (title: string) => void; disabled?: boolean; readOnly?: boolean }) {
  const [editing, setEditing] = useState(false);
  return <BoardTitle task={task} editing={editing} disabled={disabled} readOnly={readOnly} onEditingChange={setEditing} onRename={onRename} />;
}

describe("small status badges", () => {
  it("BoardExpandButton labels and toggles", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(<BoardExpandButton title="Ship it" expanded={false} onToggle={onToggle} />);
    await user.click(screen.getByRole("button", { name: "Show details of Ship it" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<BoardExpandButton title="Ship it" expanded onToggle={onToggle} />);
    const open = screen.getByRole("button", { name: "Hide details of Ship it" });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(open.className).toContain("board-expand--on");
  });

  it("BoardTodayBadge shows the daily checkbox state only when linked", () => {
    const { container, rerender } = render(<BoardTodayBadge inToday={false} checkbox="doing" />);
    expect(container.firstChild).toBeNull();
    rerender(<BoardTodayBadge inToday checkbox="doing" />);
    expect(screen.getByText("Today · Doing")).toBeTruthy();
    rerender(<BoardTodayBadge inToday checkbox={null} />);
    expect(screen.getByText("Today")).toBeTruthy();
  });

  it("BoardTodayStatus renders linked, out of sync and nothing", () => {
    const { container, rerender } = render(<BoardTodayStatus inToday={false} checkbox={null} outOfSync={false} />);
    expect(container.firstChild).toBeNull();
    rerender(<BoardTodayStatus inToday checkbox="done" outOfSync={false} />);
    expect(screen.getByText("Today · Done").className).toContain("board-today");
    rerender(<BoardTodayStatus inToday checkbox="done" outOfSync subtaskNames={["a"]} />);
    const badge = screen.getByText("Today · out of sync");
    expect(badge.className).toContain("board-sync");
    expect(badge.title).toContain("Subtask out of sync with the daily: a");
  });

  it("BoardOutOfSyncBadge renders only when out of sync", () => {
    const { container, rerender } = render(<BoardOutOfSyncBadge outOfSync={false} />);
    expect(container.firstChild).toBeNull();
    rerender(<BoardOutOfSyncBadge outOfSync />);
    expect(screen.getByText("Out of sync with today")).toBeTruthy();
  });

  it("BoardDoneStamp shows the done date or a generic label, and nothing for open tasks", () => {
    const { container, rerender } = render(<BoardDoneStamp task={makeTask("a")} />);
    expect(container.firstChild).toBeNull();
    rerender(<BoardDoneStamp task={makeTask("a", { section: "done", doneAt: "2026-11-10" })} />);
    expect(screen.getByText("Done 2026-11-10")).toBeTruthy();
    rerender(<BoardDoneStamp task={makeTask("a", { section: "done" })} />);
    expect(screen.getByText("Done section")).toBeTruthy();
  });

  it("BoardStatusChip shows the label with the finished hint", () => {
    render(<BoardStatusChip status="doing" />);
    const chip = screen.getByText("Doing");
    expect(chip.className).toContain("tag--board-doing");
    expect(chip.title).toBe(FINISHED_OCCURRENCE_HINT);
  });

  it("BoardStatusSelect lists every status and reports the choice", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BoardStatusSelect value="todo" label="Status of A" hint="why" onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "Status of A" }) as HTMLSelectElement;
    expect(select.title).toBe("why");
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["Blocked", "Hold", "To-Do", "Doing", "Done", "Archived"]);
    await user.selectOptions(select, "doing");
    expect(onChange).toHaveBeenCalledWith("doing");
  });

  it("BoardPriorityBadge renders the label and hides without a priority", () => {
    const { container, rerender } = render(<BoardPriorityBadge priority={null} />);
    expect(container.firstChild).toBeNull();
    rerender(<BoardPriorityBadge priority={1} levels={4} />);
    const badge = screen.getByText("P1");
    expect(badge.title).toBe("Priority P1");
    expect(badge.className).toContain("board-prio--1");
  });

  it("BoardPrioritySelect maps the empty option to null and numbers otherwise", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<BoardPrioritySelect value={null} label="Priority" onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "Priority" }) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["None", "P0", "P1", "P2", "P3"]);
    await user.selectOptions(select, "2");
    expect(onChange).toHaveBeenLastCalledWith(2);
    rerender(<BoardPrioritySelect value={2} label="Priority" compact levels={3} onChange={onChange} />);
    const compact = screen.getByRole("combobox", { name: "Priority" }) as HTMLSelectElement;
    expect(compact.className).toContain("board-prio-select--compact");
    expect(within(compact).getByRole("option", { name: "No priority" })).toBeTruthy();
    await user.selectOptions(compact, "");
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("BoardPriorityField renders a labelled select unless read only", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const task = makeTask("a", { title: "Alpha", priority: 1 });
    const { container, rerender } = render(<BoardPriorityField task={task} disabled={false} onChange={onChange} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Priority of Alpha" }), "0");
    expect(onChange).toHaveBeenCalledWith(0);
    rerender(<BoardPriorityField task={task} disabled={false} readOnly onChange={onChange} />);
    expect(container.firstChild).toBeNull();
  });

  it("BoardDueChip shows the tone and hides without a due date", () => {
    const { container, rerender } = render(<BoardDueChip task={makeTask("a")} today="2026-11-16" />);
    expect(container.firstChild).toBeNull();
    rerender(<BoardDueChip task={makeTask("a", { due: "2026-11-10" })} today="2026-11-16" />);
    const chip = screen.getByText("10/11");
    expect(chip.className).toContain("board-due--overdue");
    expect(chip.title).toBe("Due 10/11/2026 - overdue");
  });

  it("BoardRepeatMark names the rule", () => {
    const { container, rerender } = render(<BoardRepeatMark task={makeTask("a")} />);
    expect(container.firstChild).toBeNull();
    rerender(<BoardRepeatMark task={makeTask("a", { repeat: "every week" })} />);
    expect(screen.getByRole("img", { name: "Repeats: every week" })).toBeTruthy();
  });
});

describe("BoardTitle", () => {
  it("renders read-only text with the finished hint and no controls", () => {
    render(<TitleHarness task={makeTask("a", { title: "Locked task" })} onRename={() => undefined} readOnly />);
    expect(screen.getByText("Locked task").closest(".board-title__text")?.getAttribute("title")).toBe(FINISHED_OCCURRENCE_HINT);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("enters edit mode by button or double click and renames with trimmed text on Enter", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(<TitleHarness task={makeTask("a", { title: "Old" })} onRename={onRename} />);
    await user.dblClick(screen.getByText("Old"));
    const input = screen.getByRole("textbox", { name: "Task title" });
    await user.clear(input);
    await user.type(input, "  New name {Enter}");
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("New name");
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Rename Old" }));
    expect(screen.getByRole("textbox", { name: "Task title" })).toBeTruthy();
  });

  it("cancels with Escape and does not rename on an empty or unchanged title", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(<TitleHarness task={makeTask("a", { title: "Same" })} onRename={onRename} />);
    await user.click(screen.getByRole("button", { name: "Rename Same" }));
    await user.type(screen.getByRole("textbox"), "x{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Rename Same" }));
    await user.click(document.body);
    expect(onRename).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Rename Same" }));
    await user.clear(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");
    expect(onRename).not.toHaveBeenCalled();
  });

  it("commits on blur", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(<TitleHarness task={makeTask("a", { title: "Old" })} onRename={onRename} />);
    await user.click(screen.getByRole("button", { name: "Rename Old" }));
    await user.type(screen.getByRole("textbox"), "er");
    await user.tab();
    expect(onRename).toHaveBeenCalledWith("Older");
  });

  it("blocks editing while disabled", async () => {
    const user = userEvent.setup();
    render(<TitleHarness task={makeTask("a", { title: "Busy" })} onRename={() => undefined} disabled />);
    await user.dblClick(screen.getByText("Busy"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect((screen.getByRole("button", { name: "Rename Busy" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("BoardReason", () => {
  it("renders nothing for statuses without a reason", () => {
    const { container } = render(<BoardReason task={makeTask("a", { status: "todo" })} onChange={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("read only shows the reason or nothing", () => {
    const { container, rerender } = render(<BoardReason task={makeTask("a", { status: "blocked", reason: null })} readOnly onChange={() => undefined} />);
    expect(container.firstChild).toBeNull();
    rerender(<BoardReason task={makeTask("a", { status: "blocked", reason: "waiting" })} readOnly onChange={() => undefined} />);
    expect(screen.getByText("waiting").title).toBe(FINISHED_OCCURRENCE_HINT);
  });

  it("adds a reason through the inline input and ignores an empty one", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BoardReason task={makeTask("a", { status: "hold", reason: null })} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Add reason" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "  vendor {Enter}");
    expect(onChange).toHaveBeenCalledWith("vendor");
    onChange.mockClear();
    await user.click(screen.getByRole("button", { name: "Add reason" }));
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("edits, clears and cancels an existing reason", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BoardReason task={makeTask("a", { title: "Task", status: "blocked", reason: "waiting" })} onChange={onChange} />);
    await user.dblClick(screen.getByText("waiting"));
    await user.clear(screen.getByRole("textbox", { name: "Reason" }));
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(null);
    await user.click(screen.getByRole("button", { name: "Edit the reason of Task" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "!{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Edit the reason of Task" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "!{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("waiting!");
  });

  it("does not open the editor while disabled", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<BoardReason task={makeTask("a", { status: "blocked", reason: "waiting" })} disabled onChange={() => undefined} />);
    await user.dblClick(screen.getByText("waiting"));
    expect(screen.queryByRole("textbox")).toBeNull();
    rerender(<BoardReason task={makeTask("a", { status: "blocked", reason: null })} disabled onChange={() => undefined} />);
    expect((screen.getByRole("button", { name: "Add reason" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("BoardDateInput", () => {
  const setDate = (value: string) => fireEvent.change(screen.getByLabelText("Due date"), { target: { value } });

  it("commits a new valid date once on Enter and not again on blur", () => {
    const onCommit = vi.fn();
    render(<BoardDateInput ariaLabel="Due date" value={null} onCommit={onCommit} />);
    setDate("2026-12-01");
    fireEvent.keyDown(screen.getByLabelText("Due date"), { key: "Enter" });
    fireEvent.blur(screen.getByLabelText("Due date"));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("2026-12-01");
  });

  it("commits null when an existing date is cleared and nothing when unchanged", () => {
    const onCommit = vi.fn();
    render(<BoardDateInput ariaLabel="Due date" value="2026-12-01" onCommit={onCommit} />);
    fireEvent.blur(screen.getByLabelText("Due date"));
    expect(onCommit).not.toHaveBeenCalled();
    setDate("");
    fireEvent.blur(screen.getByLabelText("Due date"));
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it("flags a date outside the supported range without committing", () => {
    const onCommit = vi.fn();
    const onInvalidChange = vi.fn();
    render(<BoardDateInput ariaLabel="Due date" value={null} onCommit={onCommit} onInvalidChange={onInvalidChange} />);
    expect(onInvalidChange).toHaveBeenLastCalledWith(false);
    setDate("1999-01-01");
    expect(screen.getByRole("alert").textContent).toBe(DATE_RANGE_MESSAGE);
    expect(screen.getByLabelText("Due date").getAttribute("aria-invalid")).toBe("true");
    expect(onInvalidChange).toHaveBeenLastCalledWith(true);
    fireEvent.blur(screen.getByLabelText("Due date"));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("explains an incomplete date only after the user tried to commit it", () => {
    const onCommit = vi.fn();
    render(<BoardDateInput ariaLabel="Due date" value={null} onCommit={onCommit} />);
    const input = screen.getByLabelText("Due date");
    fireEvent.change(input, { target: { value: "2026-12-01" } });
    Object.defineProperty(input, "validity", { configurable: true, value: { badInput: true } });
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe("Enter a complete date");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("reverts a dirty draft on Escape and lets Escape through when clean", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <BoardDateInput ariaLabel="Due date" value="2026-12-01" onCommit={() => undefined} />
      </div>,
    );
    const input = screen.getByLabelText("Due date") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
    outer.mockClear();
    setDate("2026-12-05");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
    expect(input.value).toBe("2026-12-01");
  });

  it("holds a commit while busy and sends it once idle", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<BoardDateInput ariaLabel="Due date" value={null} busy onCommit={onCommit} />);
    setDate("2026-12-02");
    fireEvent.keyDown(screen.getByLabelText("Due date"), { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    rerender(<BoardDateInput ariaLabel="Due date" value={null} busy={false} onCommit={onCommit} />);
    expect(onCommit).toHaveBeenCalledWith("2026-12-02");
    rerender(<BoardDateInput ariaLabel="Due date" value={null} busy onCommit={onCommit} />);
    rerender(<BoardDateInput ariaLabel="Due date" value={null} busy={false} onCommit={onCommit} />);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("follows the committed value when the prop changes", () => {
    const { rerender } = render(<BoardDateInput ariaLabel="Due date" value="2026-12-01" onCommit={() => undefined} />);
    rerender(<BoardDateInput ariaLabel="Due date" value="2026-12-09" onCommit={() => undefined} />);
    expect((screen.getByLabelText("Due date") as HTMLInputElement).value).toBe("2026-12-09");
  });
});

describe("BoardDatesReadOnly", () => {
  it("lists the dates and a dash for the empty ones", () => {
    render(<BoardDatesReadOnly task={makeTask("a", { start: "2026-11-01", due: "2026-11-30", repeat: "every week" })} />);
    expect(screen.getByText("2026-11-01")).toBeTruthy();
    expect(screen.getByText("2026-11-30")).toBeTruthy();
    expect(screen.getByText("every week")).toBeTruthy();
    expect(screen.getAllByText("-")).toHaveLength(1);
  });
});

describe("BoardDateFields", () => {
  const task = (patch: Partial<BoardTask> = {}) => makeTask("a", { title: "Plan", ...patch });

  it("changes a date and clears one through the explicit button", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BoardDateFields task={task({ due: "2026-12-01" })} disabled={false} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Start date of Plan"), { target: { value: "2026-11-20" } });
    fireEvent.blur(screen.getByLabelText("Start date of Plan"));
    expect(onChange).toHaveBeenCalledWith({ start: "2026-11-20" });
    expect(screen.queryByRole("button", { name: "Clear start date" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear due date" }));
    expect(onChange).toHaveBeenLastCalledWith({ due: null });
  });

  it("selects a preset repeat and clears it with None", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<BoardDateFields task={task()} disabled={false} onChange={onChange} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Repeat of Plan" }), "every week");
    expect(onChange).toHaveBeenLastCalledWith({ repeat: "every week" });
    rerender(<BoardDateFields task={task({ repeat: "every week" })} disabled={false} onChange={onChange} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Repeat of Plan" }), "");
    expect(onChange).toHaveBeenLastCalledWith({ repeat: null });
  });

  it("does not resend an unchanged repeat selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BoardDateFields task={task()} disabled={false} onChange={onChange} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Repeat of Plan" }), "");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers a custom rule input, committing on Enter and on blur once", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BoardDateFields task={task()} disabled={false} onChange={onChange} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Repeat of Plan" }), "__custom");
    const custom = screen.getByRole("textbox", { name: "Custom repeat rule of Plan" });
    await user.type(custom, "every 3 days{Enter}");
    expect(onChange).toHaveBeenCalledWith({ repeat: "every 3 days" });
    fireEvent.blur(custom);
    expect(onChange).toHaveBeenCalledTimes(1);
    await user.type(custom, "x");
    fireEvent.blur(custom);
    expect(onChange).toHaveBeenLastCalledWith({ repeat: "every 3 daysx" });
  });

  it("ignores an empty custom rule and resets the draft on Escape", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BoardDateFields task={task({ repeat: "every 3 days" })} disabled={false} onChange={onChange} />);
    const custom = screen.getByRole("textbox", { name: "Custom repeat rule of Plan" }) as HTMLInputElement;
    expect(custom.value).toBe("every 3 days");
    fireEvent.blur(custom);
    expect(onChange).not.toHaveBeenCalled();
    await user.type(custom, "!");
    await user.keyboard("{Escape}");
    expect(custom.value).toBe("every 3 days");
    await user.clear(custom);
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(custom, { key: "Escape" });
    fireEvent.keyDown(custom, { key: "a" });
  });

  it("returns to preset mode when another repeat option is chosen after custom", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BoardDateFields task={task()} disabled={false} onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "Repeat of Plan" });
    await user.selectOptions(select, "__custom");
    await user.selectOptions(select, "every month");
    expect(screen.queryByRole("textbox", { name: "Custom repeat rule of Plan" })).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ repeat: "every month" });
  });

  it("defers the custom repeat while disabled until idle", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<BoardDateFields task={task()} disabled={false} onChange={onChange} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Repeat of Plan" }), "__custom");
    await user.type(screen.getByRole("textbox", { name: "Custom repeat rule of Plan" }), "every 5 days");
    rerender(<BoardDateFields task={task()} disabled onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Custom repeat rule of Plan" }), { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    rerender(<BoardDateFields task={task()} disabled={false} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledWith({ repeat: "every 5 days" });
  });
});

describe("BoardNoteRow and BoardNoteAdd", () => {
  const note = makeNote(2, "remember");

  it("renders read only text without actions", () => {
    render(
      <ul>
        <BoardNoteRow task={makeTask("a")} note={note} disabled={false} readOnly actions={noteActions()} />
      </ul>,
    );
    expect(screen.getByText("remember").title).toBe(FINISHED_OCCURRENCE_HINT);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("edits a note and sends the trimmed text only when it changed", async () => {
    const user = userEvent.setup();
    const actions = noteActions();
    const task = makeTask("a");
    render(
      <ul>
        <BoardNoteRow task={task} note={note} disabled={false} actions={actions} />
      </ul>,
    );
    await user.click(screen.getByRole("button", { name: "Edit note remember" }));
    await user.type(screen.getByRole("textbox", { name: "Note" }), " more {Enter}");
    expect(actions.onEdit).toHaveBeenCalledWith(task, note, "remember more");
    await user.dblClick(screen.getByText("remember"));
    await user.keyboard("{Escape}");
    expect(actions.onEdit).toHaveBeenCalledTimes(1);
    await user.dblClick(screen.getByText("remember"));
    await user.keyboard("{Enter}");
    expect(actions.onEdit).toHaveBeenCalledTimes(1);
  });

  it("deletes a note and blocks the controls while disabled", async () => {
    const user = userEvent.setup();
    const actions = noteActions();
    const task = makeTask("a");
    const { rerender } = render(
      <ul>
        <BoardNoteRow task={task} note={note} disabled={false} actions={actions} />
      </ul>,
    );
    await user.click(screen.getByRole("button", { name: "Delete note remember" }));
    expect(actions.onDelete).toHaveBeenCalledWith(task, note);
    rerender(
      <ul>
        <BoardNoteRow task={task} note={note} disabled actions={actions} />
      </ul>,
    );
    await user.dblClick(screen.getByText("remember"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect((screen.getByRole("button", { name: "Edit note remember" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows move buttons with availability and reports the direction", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    const { rerender } = render(
      <ul>
        <BoardNoteRow task={makeTask("a")} note={note} disabled={false} actions={noteActions()} move={{ availability: { up: false, down: true }, onMove }} />
      </ul>,
    );
    const up = screen.getByRole("button", { name: "Move note up: remember" }) as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    expect(up.title).toBe("Already first");
    await user.click(screen.getByRole("button", { name: "Move note down: remember" }));
    expect(onMove).toHaveBeenCalledWith("down");
    rerender(
      <ul>
        <BoardNoteRow task={makeTask("a")} note={note} disabled={false} actions={noteActions()} move={{ availability: { up: true, down: false }, onMove }} />
      </ul>,
    );
    await user.click(screen.getByRole("button", { name: "Move note up: remember" }));
    expect(onMove).toHaveBeenLastCalledWith("up");
    expect((screen.getByRole("button", { name: "Move note down: remember" }) as HTMLButtonElement).title).toBe("Already last");
  });

  it("adds a note on Enter, clearing and refocusing on success", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn(() => Promise.resolve(true));
    const task = makeTask("a", { title: "Plan" });
    render(
      <ul>
        <BoardNoteAdd task={task} disabled={false} onAdd={onAdd} />
      </ul>,
    );
    const input = screen.getByRole("textbox", { name: "Add note to Plan" }) as HTMLInputElement;
    await user.type(input, "hello{Enter}");
    expect(onAdd).toHaveBeenCalledWith(task, "hello");
    await waitFor(() => expect(input.value).toBe(""));
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("keeps the draft when adding fails, and ignores blank input, Escape clears", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn(() => Promise.resolve(false));
    render(
      <ul>
        <BoardNoteAdd task={makeTask("a", { title: "Plan" })} disabled={false} onAdd={onAdd} />
      </ul>,
    );
    const input = screen.getByRole("textbox", { name: "Add note to Plan" }) as HTMLInputElement;
    await user.type(input, "   {Enter}");
    expect(onAdd).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "bad{Enter}");
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("bad");
    await user.keyboard("{Escape}");
    expect(input.value).toBe("");
  });

  it("does not submit while disabled", async () => {
    const onAdd = vi.fn(() => Promise.resolve(true));
    render(
      <ul>
        <BoardNoteAdd task={makeTask("a", { title: "Plan" })} disabled onAdd={onAdd} />
      </ul>,
    );
    const input = screen.getByRole("textbox", { name: "Add note to Plan" });
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).readOnly).toBe(true);
  });
});

describe("BoardNotes", () => {
  it("lists the notes and an add row, or nothing when read only and empty", () => {
    const task = makeTask("a", { noteItems: [makeNote(2, "one"), makeNote(3, "two")] });
    const { container, rerender } = render(<BoardNotes task={task} disabled={false} actions={noteActions()} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    rerender(<BoardNotes task={task} disabled={false} readOnly actions={noteActions()} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    rerender(<BoardNotes task={makeTask("a")} disabled={false} readOnly actions={noteActions()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("BoardSubtasks", () => {
  const todayControls = (overrides: Partial<BoardTodayControls> = {}): BoardTodayControls => ({
    isLinked: () => false,
    isOutOfSync: () => false,
    dailyState: () => null,
    addState: { visible: true, allowed: true, hint: "" },
    onAdd: vi.fn(),
    ...overrides,
  });

  const setup = (tasks: BoardTask[], extra: Partial<Parameters<typeof BoardSubtasks>[0]> = {}) => {
    const handlers = { onToggleId: vi.fn(), onStatus: vi.fn(), onRename: vi.fn(), onReason: vi.fn(), onPriority: vi.fn() };
    render(<BoardSubtasks tasks={tasks} pending={new Set()} expandedIds={new Set()} noteActions={noteActions()} {...handlers} {...extra} />);
    return handlers;
  };

  it("changes status, toggles details and shows priority", async () => {
    const user = userEvent.setup();
    const child = makeTask("c", { title: "Child", priority: 2 });
    const handlers = setup([child]);
    expect(screen.getByText("P2")).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Status of Child" }), "done");
    expect(handlers.onStatus).toHaveBeenCalledWith(child, "done");
    await user.click(screen.getByRole("button", { name: "Show details of Child" }));
    expect(handlers.onToggleId).toHaveBeenCalledWith("c");
  });

  it("renames a subtask through the title editor", async () => {
    const user = userEvent.setup();
    const child = makeTask("c", { title: "Child" });
    const handlers = setup([child]);
    await user.click(screen.getByRole("button", { name: "Rename Child" }));
    await user.type(screen.getByRole("textbox", { name: "Task title" }), "ish{Enter}");
    expect(handlers.onRename).toHaveBeenCalledWith(child, "Childish");
  });

  it("expands to priority, notes and nested subtasks and edits their priority", async () => {
    const user = userEvent.setup();
    const grand = makeTask("g", { title: "Grand" });
    const child = makeTask("c", { title: "Child", noteItems: [makeNote(2, "child note")], subtasks: [grand] });
    const handlers = setup([child], { expandedIds: new Set(["c", "g"]) });
    expect(screen.getByText("child note")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Status of Grand" })).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Priority of Child" }), "1");
    expect(handlers.onPriority).toHaveBeenCalledWith(child, 1);
  });

  it("does not render nested rows while collapsed", () => {
    const child = makeTask("c", { title: "Child", subtasks: [makeTask("g", { title: "Grand" })] });
    setup([child]);
    expect(screen.queryByText("Grand")).toBeNull();
  });

  it("marks done titles and shows reasons for blocked subtasks", async () => {
    const user = userEvent.setup();
    const done = makeTask("d", { title: "Finished", status: "done" });
    const blocked = makeTask("b", { title: "Stuck", status: "blocked", reason: "vendor" });
    const handlers = setup([done, blocked]);
    expect(screen.getByText("Finished").closest(".board-sub__title")?.className).toContain("board-sub__title--done");
    await user.dblClick(screen.getByText("vendor"));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "x{Enter}");
    expect(handlers.onReason).toHaveBeenCalledWith(blocked, "vendorx");
  });

  it("disables controls of subtasks that are pending", () => {
    setup([makeTask("c", { title: "Child" })], { pending: new Set(["c"]) });
    expect((screen.getByRole("combobox", { name: "Status of Child" }) as HTMLSelectElement).disabled).toBe(true);
  });

  it("renders finished occurrences read only", () => {
    const child = makeTask("c", { title: "Child", noteItems: [makeNote(2, "n")], status: "blocked", reason: "r" });
    setup([child], { finished: new Set(["c"]), expandedIds: new Set(["c"]), today: todayControls() });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Blocked").className).toContain("tag--board-blocked");
    expect(screen.queryByRole("button", { name: /Add subtask/ })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /Add note/ })).toBeNull();
  });

  it("offers adding a subtask to today when allowed and not linked", async () => {
    const user = userEvent.setup();
    const child = makeTask("c", { title: "Child" });
    const onAdd = vi.fn();
    setup([child], { today: todayControls({ onAdd }) });
    await user.click(screen.getByRole("button", { name: "Add subtask Child to today" }));
    expect(onAdd).toHaveBeenCalledWith(child);
  });

  it("hides or disables the add to today action by state", () => {
    const { unmount } = render(
      <BoardSubtasks
        tasks={[makeTask("c", { title: "Child" })]}
        pending={new Set()}
        expandedIds={new Set()}
        noteActions={noteActions()}
        onToggleId={() => undefined}
        onStatus={() => undefined}
        onRename={() => undefined}
        onReason={() => undefined}
        onPriority={() => undefined}
        today={todayControls({ addState: { visible: true, allowed: false, hint: "no daily" } })}
      />,
    );
    expect((screen.getByRole("button", { name: "Add subtask Child to today" }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    setup([makeTask("c", { title: "Child" })], { today: todayControls({ addState: { visible: false, allowed: true, hint: "" } }) });
    expect(screen.queryByRole("button", { name: "Add subtask Child to today" })).toBeNull();
  });

  it("flags a linked out of sync subtask and hides the add button for linked ones", () => {
    setup([makeTask("c", { title: "Child" })], { today: todayControls({ isLinked: () => true, isOutOfSync: () => true }) });
    expect(screen.getByText("Out of sync with today")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add subtask Child to today" })).toBeNull();
  });
});

describe("BoardBulkBar", () => {
  const projects = [
    { id: "p2", label: "Project Two", depth: 0 },
    { id: "p3", label: "Project Three", depth: 0 },
  ];

  const setup = (extra: Partial<Parameters<typeof BoardBulkBar>[0]> = {}) => {
    const handlers = { onStatus: vi.fn(), onPriority: vi.fn(), onMove: vi.fn(), onArchive: vi.fn(), onClear: vi.fn() };
    render(<BoardBulkBar count={3} busy={false} projects={projects} {...handlers} {...extra} />);
    return handlers;
  };

  it("shows the selection count and the status options without archived", () => {
    setup();
    expect(screen.getByRole("toolbar", { name: "Bulk actions" })).toBeTruthy();
    expect(screen.getByText("3 selected")).toBeTruthy();
    expect(within(screen.getByRole("combobox", { name: "Set status" })).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Set status…",
      "Blocked",
      "Hold",
      "To-Do",
      "Doing",
      "Done",
    ]);
  });

  it("reports status, priority (including none) and project choices", async () => {
    const user = userEvent.setup();
    const handlers = setup({ levels: 3 });
    await user.selectOptions(screen.getByRole("combobox", { name: "Set status" }), "doing");
    expect(handlers.onStatus).toHaveBeenCalledWith("doing");
    const priority = screen.getByRole("combobox", { name: "Set priority" });
    expect(within(priority).getAllByRole("option").map((option) => option.textContent)).toEqual(["Set priority…", "P0", "P1", "P2", "No priority"]);
    await user.selectOptions(priority, "1");
    expect(handlers.onPriority).toHaveBeenLastCalledWith(1);
    await user.selectOptions(priority, "none");
    expect(handlers.onPriority).toHaveBeenLastCalledWith(null);
    await user.selectOptions(screen.getByRole("combobox", { name: "Move to project" }), "p3");
    expect(handlers.onMove).toHaveBeenCalledWith("p3");
  });

  it("archives and clears", async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(handlers.onArchive).toHaveBeenCalledTimes(1);
    expect(handlers.onClear).toHaveBeenCalledTimes(1);
  });

  it("disables every control while busy", () => {
    setup({ busy: true });
    for (const control of [...screen.getAllByRole("combobox"), screen.getByRole("button", { name: "Archive" }), screen.getByRole("button", { name: "Clear" })]) {
      expect((control as HTMLButtonElement | HTMLSelectElement).disabled).toBe(true);
    }
  });
});
