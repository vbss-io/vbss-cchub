import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { EXPANDED, type FocusCollapse } from "../focus-collapse";
import type { OutlineGroup, OutlineNode } from "../outliner-model";
import { outlineGroup, outlineNode } from "../test-support/u1-fixtures";
import { FocusOutliner, type FocusOutlinerProps } from "./FocusOutliner";

const TODAY = "2026-11-16";

const a1a = outlineNode("a1a", { title: "Sub one", depth: 1, line: 3, raw: "  - [ ] Sub one" });
const a1 = outlineNode("a1", { title: "Alpha one", line: 2, children: [a1a], notes: [{ line: 4, raw: "  - remember", text: "remember the milk" }] });
const a2 = outlineNode("a2", { title: "Alpha two", line: 6, status: "doing", priority: 1, due: "2026-11-10" });
const a3 = outlineNode("a3", { title: "Alpha three", line: 7, status: "done" });
const b1 = outlineNode("b1", { projectId: "bravo", title: "Bravo one", line: 1, status: "blocked" });

const baseGroups = (): OutlineGroup[] => [outlineGroup("alpha", "Alpha", [a1, a2, a3]), outlineGroup("bravo", "Bravo", [b1])];

type Handlers = Pick<
  FocusOutlinerProps,
  "onRename" | "onCreateAfter" | "onIndent" | "onOutdent" | "onMove" | "onToggleDone" | "onToggleDoing" | "onAddNote" | "onOpen" | "onTomorrow" | "onUnschedule"
>;

const makeHandlers = () => {
  const ok = () => vi.fn().mockResolvedValue(undefined);
  return {
    onRename: ok(),
    onCreateAfter: ok(),
    onIndent: ok(),
    onOutdent: ok(),
    onMove: ok(),
    onToggleDone: ok(),
    onToggleDoing: ok(),
    onAddNote: ok(),
    onOpen: vi.fn<(node: OutlineNode) => void>(),
    onTomorrow: ok(),
    onUnschedule: ok(),
  } satisfies Record<keyof Handlers, ReturnType<typeof vi.fn>>;
};

interface MountOptions extends Partial<FocusOutlinerProps> {
  groups?: OutlineGroup[];
  initialCollapse?: FocusCollapse;
}

const mount = (options: MountOptions = {}) => {
  const handlers = makeHandlers();
  const onCollapseChange = vi.fn();
  const { initialCollapse, groups, ...rest } = options;
  function Harness() {
    const [collapse, setCollapse] = useState<FocusCollapse>(initialCollapse ?? EXPANDED);
    return (
      <FocusOutliner
        groups={groups ?? baseGroups()}
        today={TODAY}
        {...handlers}
        {...rest}
        collapse={collapse}
        onCollapseChange={(next) => {
          onCollapseChange(next);
          setCollapse(next);
        }}
      />
    );
  }
  const view = render(<Harness />);
  return { ...handlers, onCollapseChange, ...view };
};

const rowOf = (title: string): HTMLElement => screen.getByText(title).closest("[role=treeitem]") as HTMLElement;

const focusRowOf = (title: string): HTMLElement => {
  const row = rowOf(title);
  act(() => row.focus());
  return row;
};

const press = (element: HTMLElement, key: string, init: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(element, { key, ...init });

const startEdit = (title: string): HTMLInputElement => {
  fireEvent.click(screen.getByText(title));
  return screen.getByLabelText(`Edit ${title}`) as HTMLInputElement;
};

describe("FocusOutliner rendering", () => {
  it("shows the empty state when there is nothing to list", () => {
    mount({ groups: [outlineGroup("alpha", "Alpha", [])] });
    expect(screen.getByText("Nothing in focus yet.")).toBeTruthy();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("renders every project with counts, done counts, chips, notes and status tags", () => {
    mount();
    expect(screen.getByRole("tree", { name: "Focus" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Alpha, 4 tasks, 1 done" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bravo, 1 task" })).toBeTruthy();
    expect(screen.getByText("P1").getAttribute("title")).toBe("Priority P1");
    expect(screen.getByTitle("Due 2026-11-10")).toBeTruthy();
    expect(screen.getByText("remember the milk")).toBeTruthy();
    expect(document.querySelector(".tag--board-doing")?.textContent).toBe("Doing");
    expect(document.querySelector(".tag--board-blocked")?.textContent).toBe("Blocked");
    expect(rowOf("Alpha three").className).toContain("outliner__row--done");
    expect(rowOf("Sub one").getAttribute("aria-level")).toBe("2");
  });

  it("marks the tree busy and gives the first row the tab stop", () => {
    mount({ busy: true });
    expect(screen.getByRole("tree").className).toContain("outliner--busy");
    expect(rowOf("Alpha one").getAttribute("tabindex")).toBe("0");
    expect(rowOf("Alpha two").getAttribute("tabindex")).toBe("-1");
  });

  it("labels the check box by state", () => {
    mount();
    expect(screen.getByRole("checkbox", { name: "Complete Alpha one" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Complete Alpha two (in progress)" }).getAttribute("aria-checked")).toBe("mixed");
    expect((screen.getByRole("checkbox", { name: "Reopen Alpha three" }) as HTMLInputElement).checked).toBe(true);
  });

  it("hides a project's rows when collapsed and skips groups with no tasks", () => {
    mount({ initialCollapse: { projects: ["bravo"], tasks: [] }, groups: [...baseGroups(), outlineGroup("empty", "Empty", [])] });
    expect(screen.queryByText("Bravo one")).toBeNull();
    expect(screen.getByRole("button", { name: "Bravo, 1 task" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /^Empty/ })).toBeNull();
  });
});

describe("FocusOutliner collapse", () => {
  it("collapses and expands a task from its twist and shows what is hidden", () => {
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Alpha one" }));
    expect(view.onCollapseChange).toHaveBeenLastCalledWith({ projects: [], tasks: ["alpha\u0000Alpha one"] });
    expect(screen.queryByText("Sub one")).toBeNull();
    expect(screen.getByText("1 subtask, 1 note")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand Alpha one" }));
    expect(view.onCollapseChange).toHaveBeenLastCalledWith({ projects: [], tasks: [] });
    expect(screen.getByText("Sub one")).toBeTruthy();
  });

  it("collapses and expands a task with the arrow keys and ignores rows with nothing hidden", () => {
    const view = mount();
    press(focusRowOf("Alpha two"), "ArrowLeft");
    expect(view.onCollapseChange).not.toHaveBeenCalled();
    const row = focusRowOf("Alpha one");
    press(row, "ArrowRight");
    expect(view.onCollapseChange).not.toHaveBeenCalled();
    press(row, "ArrowLeft");
    expect(view.onCollapseChange).toHaveBeenCalledTimes(1);
    expect(rowOf("Alpha one").getAttribute("aria-expanded")).toBe("false");
    press(rowOf("Alpha one"), "ArrowRight");
    expect(view.onCollapseChange).toHaveBeenCalledTimes(2);
    expect(rowOf("Alpha one").getAttribute("aria-expanded")).toBe("true");
  });

  it("toggles a project from the header with click and arrow keys", () => {
    const view = mount();
    const header = screen.getByRole("button", { name: "Alpha, 4 tasks, 1 done" });
    fireEvent.click(header);
    expect(view.onCollapseChange).toHaveBeenLastCalledWith({ projects: ["alpha"], tasks: [] });
    expect(screen.queryByText("Alpha two")).toBeNull();
    press(header, "ArrowRight");
    expect(screen.getByText("Alpha two")).toBeTruthy();
    press(header, "ArrowLeft");
    expect(screen.queryByText("Alpha two")).toBeNull();
  });

  it("ignores header keys with modifiers, toggle keys and unknown keys", () => {
    const view = mount();
    const header = screen.getByRole("button", { name: "Alpha, 4 tasks, 1 done" });
    press(header, "ArrowLeft", { ctrlKey: true });
    press(header, "Enter");
    press(header, "x");
    expect(view.onCollapseChange).not.toHaveBeenCalled();
  });

  it("moves focus to the first row of the project with ArrowDown on the header", () => {
    mount();
    const header = screen.getByRole("button", { name: "Alpha, 4 tasks, 1 done" });
    press(header, "ArrowDown");
    expect(document.activeElement).toBe(rowOf("Alpha one"));
  });

  it("does not move focus when the collapsed header has no rows", () => {
    mount({ initialCollapse: { projects: ["alpha"], tasks: [] } });
    const header = screen.getByRole("button", { name: "Alpha, 4 tasks, 1 done" });
    act(() => header.focus());
    press(header, "ArrowDown");
    expect(document.activeElement).toBe(header);
  });
});

describe("FocusOutliner row keys", () => {
  it("moves between rows with j/k and the arrow keys and up to the header", () => {
    mount();
    const first = focusRowOf("Alpha one");
    press(first, "j");
    expect(document.activeElement).toBe(rowOf("Sub one"));
    press(rowOf("Sub one"), "ArrowDown");
    expect(document.activeElement).toBe(rowOf("Alpha two"));
    press(rowOf("Alpha two"), "k");
    expect(document.activeElement).toBe(rowOf("Sub one"));
    press(rowOf("Sub one"), "ArrowUp");
    expect(document.activeElement).toBe(rowOf("Alpha one"));
    press(rowOf("Alpha one"), "k");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Alpha, 4 tasks, 1 done" }));
  });

  it("stays on the last row when moving down", () => {
    mount();
    const last = focusRowOf("Bravo one");
    press(last, "j");
    expect(document.activeElement).toBe(last);
  });

  it("ignores keys that come from inside the row", () => {
    const view = mount();
    focusRowOf("Alpha one");
    fireEvent.keyDown(screen.getByRole("checkbox", { name: "Complete Alpha one" }), { key: "o" });
    expect(view.onOpen).not.toHaveBeenCalled();
  });

  it("opens, sends to tomorrow and toggles done and doing from the keyboard", async () => {
    const view = mount();
    const row = focusRowOf("Alpha one");
    press(row, "o");
    expect(view.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
    press(row, "m");
    await waitFor(() => expect(view.onTomorrow).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" })));
    press(row, "Enter", { ctrlKey: true });
    await waitFor(() => expect(view.onToggleDone).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" })));
    press(row, "s");
    await waitFor(() => expect(view.onToggleDoing).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" })));
  });

  it("does not start a task that cannot be started and ignores s without a handler", () => {
    const view = mount();
    press(focusRowOf("Alpha three"), "s");
    press(focusRowOf("Bravo one"), "s");
    expect(view.onToggleDoing).not.toHaveBeenCalled();
    const bare = mount({ onToggleDoing: undefined });
    press(within(bare.container).getByText("Alpha one").closest("[role=treeitem]") as HTMLElement, "s");
    expect(bare.onToggleDoing).not.toHaveBeenCalled();
  });

  it("ignores row keys while a modifier is held, and keys without an intent", () => {
    const view = mount();
    const row = focusRowOf("Alpha one");
    press(row, "o", { ctrlKey: true });
    press(row, "q");
    expect(view.onOpen).not.toHaveBeenCalled();
  });

  it("indents under the previous sibling and outdents a nested task", async () => {
    const view = mount();
    press(focusRowOf("Alpha two"), "Tab");
    await waitFor(() => expect(view.onIndent).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" })));
    press(focusRowOf("Sub one"), "Tab", { shiftKey: true });
    await waitFor(() => expect(view.onOutdent).toHaveBeenCalledWith(expect.objectContaining({ id: "a1a" })));
  });

  it("ignores indent on a first sibling and outdent at the top level", () => {
    const view = mount();
    press(focusRowOf("Alpha one"), "Tab");
    press(focusRowOf("Alpha one"), "Tab", { shiftKey: true });
    expect(view.onIndent).not.toHaveBeenCalled();
    expect(view.onOutdent).not.toHaveBeenCalled();
  });

  it("moves a task up and down with Alt+arrows only where there is a neighbour", async () => {
    const view = mount();
    press(focusRowOf("Alpha one"), "ArrowUp", { altKey: true });
    expect(view.onMove).not.toHaveBeenCalled();
    press(focusRowOf("Alpha two"), "ArrowUp", { altKey: true });
    await waitFor(() => expect(view.onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }), "up"));
    press(focusRowOf("Alpha two"), "ArrowDown", { altKey: true });
    await waitFor(() => expect(view.onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }), "down"));
    press(focusRowOf("Alpha three"), "ArrowDown", { altKey: true });
    expect(view.onMove).toHaveBeenCalledTimes(2);
  });

  it("asks for confirmation before removing from today and confirms with Enter", async () => {
    const view = mount();
    const row = focusRowOf("Alpha two");
    press(row, "Delete");
    expect(within(row).getByRole("alert").textContent).toContain("Remove from today?");
    press(row, "o");
    expect(view.onOpen).not.toHaveBeenCalled();
    press(row, "Enter");
    await waitFor(() => expect(view.onUnschedule).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" })));
    expect(within(rowOf("Alpha two")).queryByText(/Remove from today\?/)).toBeNull();
  });

  it("cancels the removal with Escape or Keep and confirms with the button", async () => {
    const view = mount();
    const row = focusRowOf("Alpha two");
    press(row, "Backspace");
    press(row, "Escape");
    expect(within(row).queryByText(/Remove from today\?/)).toBeNull();
    press(row, "Delete");
    fireEvent.click(within(row).getByRole("button", { name: "Keep" }));
    expect(view.onUnschedule).not.toHaveBeenCalled();
    press(row, "Delete");
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(view.onUnschedule).toHaveBeenCalledTimes(1));
  });

  it("shows the failure of an action on the row and a generic text for non-errors", async () => {
    const view = mount();
    view.onToggleDone.mockRejectedValueOnce(new Error("nope"));
    const row = focusRowOf("Alpha one");
    press(row, "Enter", { ctrlKey: true });
    expect((await within(rowOf("Alpha one")).findByRole("alert")).textContent).toBe("nope");
    view.onToggleDone.mockRejectedValueOnce("x");
    press(rowOf("Alpha one"), "Enter", { ctrlKey: true });
    await waitFor(() => expect(within(rowOf("Alpha one")).getByRole("alert").textContent).toBe("Something went wrong"));
  });

  it("runs only one action at a time per row", async () => {
    const view = mount();
    let release: () => void = () => undefined;
    view.onToggleDone.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const row = focusRowOf("Alpha one");
    press(row, "Enter", { ctrlKey: true });
    await waitFor(() => expect(rowOf("Alpha one").getAttribute("aria-busy")).toBe("true"));
    press(rowOf("Alpha one"), "Enter", { ctrlKey: true });
    expect(view.onToggleDone).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await waitFor(() => expect(rowOf("Alpha one").getAttribute("aria-busy")).toBe("false"));
  });

  it("completes a task from its check box", async () => {
    const view = mount();
    fireEvent.click(screen.getByRole("checkbox", { name: "Complete Alpha one" }));
    await waitFor(() => expect(view.onToggleDone).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" })));
  });
});

describe("FocusOutliner editing", () => {
  it("renames a task on Enter and opens a draft below it", async () => {
    const view = mount();
    const input = startEdit("Alpha two");
    fireEvent.change(input, { target: { value: "Alpha 2 renamed" } });
    press(input, "Enter");
    await waitFor(() => expect(view.onRename).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }), "Alpha 2 renamed", {}));
    expect(await screen.findByLabelText("New task")).toBeTruthy();
    expect(screen.queryByLabelText("Edit Alpha two")).toBeNull();
  });

  it("parses priority and due tokens into fields and ignores unchanged ones", async () => {
    const view = mount();
    const input = startEdit("Alpha two");
    fireEvent.change(input, { target: { value: "Alpha two #p2 due:tomorrow" } });
    press(input, "s", { ctrlKey: true });
    await waitFor(() => expect(view.onRename).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }), "Alpha two", { priority: 2, due: "2026-11-17" }));
  });

  it("does not call rename when nothing changed", async () => {
    const view = mount();
    const input = startEdit("Alpha two");
    fireEvent.change(input, { target: { value: "Alpha two #p1 due:2026-11-10" } });
    press(input, "s", { ctrlKey: true });
    await waitFor(() => expect(screen.queryByLabelText("Edit Alpha two")).toBeNull());
    expect(view.onRename).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rowOf("Alpha two"));
  });

  it("refuses an empty title", async () => {
    const view = mount();
    const input = startEdit("Alpha two");
    fireEvent.change(input, { target: { value: "   " } });
    press(input, "Enter");
    expect((await screen.findByText("Title cannot be empty")).getAttribute("role")).toBe("alert");
    expect(view.onRename).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Edit Alpha two")).toBeTruthy();
  });

  it("keeps editing and shows the error when the rename fails", async () => {
    const view = mount();
    view.onRename.mockRejectedValue(new Error("conflict"));
    const input = startEdit("Alpha two");
    fireEvent.change(input, { target: { value: "Other" } });
    press(input, "Enter");
    expect((await screen.findByText("conflict")).getAttribute("role")).toBe("alert");
    expect(screen.getByLabelText("Edit Alpha two")).toBeTruthy();
  });

  it("cancels with Escape and restores focus to the row", () => {
    const view = mount();
    const input = startEdit("Alpha two");
    fireEvent.change(input, { target: { value: "Changed" } });
    press(input, "Escape");
    expect(screen.queryByLabelText("Edit Alpha two")).toBeNull();
    expect(view.onRename).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rowOf("Alpha two"));
  });

  it("commits on blur", async () => {
    const view = mount();
    const input = startEdit("Alpha two");
    fireEvent.change(input, { target: { value: "Blurred" } });
    fireEvent.blur(input);
    await waitFor(() => expect(view.onRename).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }), "Blurred", {}));
  });

  it("shows the editing hint and no row chips while editing", () => {
    mount();
    const input = startEdit("Alpha two");
    expect(screen.getByText(/Enter save and add below/)).toBeTruthy();
    expect(within(input.closest("[role=treeitem]") as HTMLElement).queryByText("P1")).toBeNull();
  });

  it("saves then toggles done with Ctrl+Enter while editing", async () => {
    const view = mount();
    const input = startEdit("Alpha two");
    fireEvent.change(input, { target: { value: "Edited" } });
    press(input, "Enter", { ctrlKey: true });
    await waitFor(() => expect(view.onToggleDone).toHaveBeenCalledTimes(1));
    expect(view.onRename).toHaveBeenCalledTimes(1);
  });

  it("does not toggle when saving fails during Ctrl+Enter", async () => {
    const view = mount();
    view.onRename.mockRejectedValue(new Error("bad"));
    const input = startEdit("Alpha two");
    fireEvent.change(input, { target: { value: "Edited" } });
    press(input, "Enter", { ctrlKey: true });
    await screen.findByText("bad");
    expect(view.onToggleDone).not.toHaveBeenCalled();
  });

  it("indents from edit mode after saving and keeps editing", async () => {
    const view = mount();
    const input = startEdit("Alpha two");
    fireEvent.change(input, { target: { value: "Edited" } });
    press(input, "Tab");
    await waitFor(() => expect(view.onIndent).toHaveBeenCalledTimes(1));
    expect(view.onRename).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Edit Alpha two")).toBeTruthy();
  });

  it("does not indent or move from edit mode when it is not possible", () => {
    const view = mount();
    const input = startEdit("Alpha one");
    press(input, "Tab");
    press(input, "Tab", { shiftKey: true });
    press(input, "ArrowUp", { altKey: true });
    expect(view.onIndent).not.toHaveBeenCalled();
    expect(view.onOutdent).not.toHaveBeenCalled();
    expect(view.onMove).not.toHaveBeenCalled();
  });

  it("outdents and moves from edit mode", async () => {
    const view = mount();
    const nested = startEdit("Sub one");
    press(nested, "Tab", { shiftKey: true });
    await waitFor(() => expect(view.onOutdent).toHaveBeenCalledTimes(1));
    const other = startEdit("Alpha two");
    press(other, "ArrowDown", { altKey: true });
    await waitFor(() => expect(view.onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }), "down"));
  });

  it("ignores edit keys while composing text and unknown keys", () => {
    const view = mount();
    const input = startEdit("Alpha two");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    press(input, "x");
    expect(view.onRename).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Edit Alpha two")).toBeTruthy();
  });

  it("adds a note from edit mode with Shift+Enter", async () => {
    const view = mount();
    const input = startEdit("Alpha one");
    press(input, "Enter", { shiftKey: true });
    const note = await screen.findByLabelText("New note for Alpha one");
    fireEvent.change(note, { target: { value: "  call them  " } });
    press(note, "Enter");
    await waitFor(() => expect(view.onAddNote).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), "call them"));
    await waitFor(() => expect(screen.queryByLabelText("New note for Alpha one")).toBeNull());
    expect(document.activeElement).toBe(rowOf("Alpha one"));
  });

  it("adds a note from the row with Shift+Enter and cancels or ignores empty notes", async () => {
    const view = mount();
    const row = focusRowOf("Alpha two");
    press(row, "Enter", { shiftKey: true });
    let note = await screen.findByLabelText("New note for Alpha two");
    fireEvent.keyDown(note, { key: "Enter", isComposing: true });
    press(note, "x");
    press(note, "Escape");
    expect(screen.queryByLabelText("New note for Alpha two")).toBeNull();
    press(rowOf("Alpha two"), "Enter", { shiftKey: true });
    note = await screen.findByLabelText("New note for Alpha two");
    press(note, "Enter");
    expect(screen.queryByLabelText("New note for Alpha two")).toBeNull();
    expect(view.onAddNote).not.toHaveBeenCalled();
  });

  it("keeps the note form open and shows the error when adding fails", async () => {
    const view = mount();
    view.onAddNote.mockRejectedValue(new Error("no write"));
    press(focusRowOf("Alpha two"), "Enter", { shiftKey: true });
    const note = await screen.findByLabelText("New note for Alpha two");
    fireEvent.change(note, { target: { value: "x" } });
    press(note, "Enter");
    expect((await screen.findByText("no write")).getAttribute("role")).toBe("alert");
    expect(screen.getByLabelText("New note for Alpha two")).toBeTruthy();
  });

  it("expands a collapsed task before adding a note", async () => {
    const view = mount({ initialCollapse: { projects: [], tasks: ["alpha\u0000Alpha one"] } });
    press(focusRowOf("Alpha one"), "Enter", { shiftKey: true });
    await screen.findByLabelText("New note for Alpha one");
    expect(view.onCollapseChange).toHaveBeenCalledWith({ projects: [], tasks: [] });
  });
});

describe("FocusOutliner drafts", () => {
  it("creates a task below the anchor with parsed fields and closes on an empty Enter", async () => {
    const view = mount();
    press(startEdit("Alpha two"), "Enter");
    const draft = await screen.findByLabelText("New task");
    fireEvent.change(draft, { target: { value: "Fresh #p3 due:today" } });
    press(draft, "Enter");
    await waitFor(() => expect(view.onCreateAfter).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }), "Fresh", { priority: 3, due: TODAY }));
    expect((screen.getByLabelText("New task") as HTMLInputElement).value).toBe("");
    press(screen.getByLabelText("New task"), "Enter");
    await waitFor(() => expect(screen.queryByLabelText("New task")).toBeNull());
    expect(document.activeElement).toBe(rowOf("Alpha two"));
  });

  it("cancels a draft with Escape and refuses a title made only of tokens", async () => {
    const view = mount();
    press(startEdit("Alpha two"), "Enter");
    const draft = await screen.findByLabelText("New task");
    fireEvent.change(draft, { target: { value: "#p1" } });
    press(draft, "Enter");
    expect((await screen.findByText("Title cannot be empty")).getAttribute("role")).toBe("alert");
    expect(view.onCreateAfter).not.toHaveBeenCalled();
    press(draft, "Escape");
    expect(screen.queryByLabelText("New task")).toBeNull();
    expect(screen.queryByText("Title cannot be empty")).toBeNull();
  });

  it("ignores unrelated and composing keys in the draft", async () => {
    const view = mount();
    press(startEdit("Alpha two"), "Enter");
    const draft = await screen.findByLabelText("New task");
    press(draft, "x");
    fireEvent.keyDown(draft, { key: "Enter", isComposing: true });
    expect(view.onCreateAfter).not.toHaveBeenCalled();
  });

  it("shows the creation error and keeps the typed text", async () => {
    const view = mount();
    view.onCreateAfter.mockRejectedValue(new Error("create failed"));
    press(startEdit("Alpha two"), "Enter");
    const draft = await screen.findByLabelText("New task");
    fireEvent.change(draft, { target: { value: "Fresh" } });
    press(draft, "Enter");
    expect((await screen.findByText("create failed")).getAttribute("role")).toBe("alert");
    expect((screen.getByLabelText("New task") as HTMLInputElement).value).toBe("Fresh");
  });

  it("closes an empty draft when another row takes focus", async () => {
    mount();
    press(startEdit("Alpha two"), "Enter");
    await screen.findByLabelText("New task");
    act(() => rowOf("Bravo one").focus());
    expect(screen.queryByLabelText("New task")).toBeNull();
  });

  it("follows the new task so the next draft anchors below it", async () => {
    const created: OutlineNode[] = [];
    const calls: string[] = [];
    function Growing() {
      const [items, setItems] = useState<OutlineNode[]>([a1, a2]);
      return (
        <FocusOutliner
          groups={[outlineGroup("alpha", "Alpha", items)]}
          today={TODAY}
          {...makeHandlers()}
          onCreateAfter={async (anchor, title) => {
            calls.push(`${anchor.id}:${title}`);
            const node = outlineNode(`n${created.length + 1}`, { title, line: 20 + created.length });
            created.push(node);
            setItems((current) => [...current, node]);
          }}
        />
      );
    }
    render(<Growing />);
    press(startEdit("Alpha two"), "Enter");
    const first = await screen.findByLabelText("New task");
    fireEvent.change(first, { target: { value: "Made one" } });
    press(first, "Enter");
    await screen.findByText("Made one");
    const second = screen.getByLabelText("New task");
    fireEvent.change(second, { target: { value: "Made two" } });
    press(second, "Enter");
    await screen.findByText("Made two");
    expect(calls).toEqual(["a2:Made one", "n1:Made two"]);
    await waitFor(() => {
      const items = screen.getAllByRole("treeitem");
      const draftIndex = items.findIndex((element) => element.querySelector("input[aria-label='New task']") !== null);
      expect(items[draftIndex - 1]?.textContent).toContain("Made two");
    });
  });

  it("drops the draft when its anchor disappears", async () => {
    const view = mount();
    press(startEdit("Alpha two"), "Enter");
    await screen.findByLabelText("New task");
    view.rerender(<FocusOutliner groups={[outlineGroup("alpha", "Alpha", [a1])]} today={TODAY} {...makeHandlers()} />);
    await waitFor(() => expect(screen.queryByLabelText("New task")).toBeNull());
  });
});

describe("FocusOutliner action menu", () => {
  const openMenu = (title: string): HTMLElement => {
    fireEvent.click(screen.getByRole("button", { name: `Actions for ${title}` }));
    return screen.getByRole("menu", { name: `Actions for ${title}` });
  };

  it("lists the actions with the right disabled state and focuses the first enabled one", () => {
    mount();
    const menu = openMenu("Alpha one");
    const items = within(menu).getAllByRole("menuitem") as HTMLButtonElement[];
    expect(items.map((item) => item.textContent)).toEqual(["Start", "Tomorrow", "Remove from today", "Add note", "Indent", "Outdent", "Move up", "Move down", "Open"]);
    const disabled = items.filter((item) => item.disabled).map((item) => item.textContent);
    expect(disabled).toEqual(["Indent", "Outdent", "Move up"]);
    expect(document.activeElement).toBe(items[0]);
  });

  it("offers Back to to-do for a task in progress and disables Start for a done task", () => {
    mount();
    expect(within(openMenu("Alpha two")).getByRole("menuitem", { name: "Back to to-do" })).toBeTruthy();
    expect((within(openMenu("Alpha three")).getByRole("menuitem", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("omits the toggle-doing action when there is no handler", () => {
    mount({ onToggleDoing: undefined });
    expect(within(openMenu("Alpha one")).queryByRole("menuitem", { name: "Start" })).toBeNull();
  });

  it("runs the chosen action and closes the menu", async () => {
    const view = mount();
    fireEvent.click(within(openMenu("Alpha two")).getByRole("menuitem", { name: "Tomorrow" }));
    await waitFor(() => expect(view.onTomorrow).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" })));
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(within(openMenu("Alpha two")).getByRole("menuitem", { name: "Open" }));
    expect(view.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }));
    fireEvent.click(within(openMenu("Alpha two")).getByRole("menuitem", { name: "Back to to-do" }));
    await waitFor(() => expect(view.onToggleDoing).toHaveBeenCalledTimes(1));
    fireEvent.click(within(openMenu("Alpha two")).getByRole("menuitem", { name: "Indent" }));
    await waitFor(() => expect(view.onIndent).toHaveBeenCalledTimes(1));
    fireEvent.click(within(openMenu("Alpha two")).getByRole("menuitem", { name: "Move down" }));
    await waitFor(() => expect(view.onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }), "down"));
    fireEvent.click(within(openMenu("Sub one")).getByRole("menuitem", { name: "Outdent" }));
    await waitFor(() => expect(view.onOutdent).toHaveBeenCalledTimes(1));
    fireEvent.click(within(openMenu("Alpha two")).getByRole("menuitem", { name: "Move up" }));
    await waitFor(() => expect(view.onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }), "up"));
  });

  it("opens the confirmation and the note form from the menu", async () => {
    mount();
    fireEvent.click(within(openMenu("Alpha two")).getByRole("menuitem", { name: "Remove from today" }));
    expect(within(rowOf("Alpha two")).getByRole("alert").textContent).toContain("Remove from today?");
    fireEvent.click(within(openMenu("Alpha two")).getByRole("menuitem", { name: "Add note" }));
    expect(await screen.findByLabelText("New note for Alpha two")).toBeTruthy();
  });

  it("toggles the menu from the more button", () => {
    mount();
    openMenu("Alpha two");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Alpha two" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("walks the items with the arrow keys and wraps around", () => {
    mount();
    const menu = openMenu("Alpha one");
    const enabled = within(menu).getAllByRole("menuitem").filter((item) => !(item as HTMLButtonElement).disabled);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(enabled[1]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(enabled[enabled.length - 1]);
    fireEvent.keyDown(menu, { key: "x" });
    expect(document.activeElement).toBe(enabled[enabled.length - 1]);
  });

  it("closes with Escape inside the menu and returns focus to the row", () => {
    mount();
    const menu = openMenu("Alpha one");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(rowOf("Alpha one"));
  });

  it("closes with Escape on the row and on a pointer press outside", () => {
    mount();
    openMenu("Alpha one");
    press(rowOf("Alpha one"), "Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    const menu = openMenu("Alpha one");
    fireEvent.pointerDown(menu);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("plans subtasks from the menu and from the hidden counter", () => {
    const onPlanSubtasks = vi.fn();
    mount({ subtaskPlan: (node) => (node.id === "a2" ? { open: 2, hidden: 1 } : null), onPlanSubtasks });
    fireEvent.click(screen.getByRole("button", { name: "Plan subtasks of Alpha two, 1 not in this day" }));
    expect(onPlanSubtasks).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }));
    fireEvent.click(within(openMenu("Alpha two")).getByRole("menuitem", { name: "Plan subtasks" }));
    expect(onPlanSubtasks).toHaveBeenCalledTimes(2);
    expect(within(openMenu("Alpha one")).queryByRole("menuitem", { name: "Plan subtasks" })).toBeNull();
  });

  it("hides the subtask plan when nothing is left to plan or no handler is given", () => {
    mount({ subtaskPlan: () => ({ open: 0, hidden: 0 }), onPlanSubtasks: vi.fn() });
    expect(screen.queryByRole("button", { name: /Plan subtasks of/ })).toBeNull();
    expect(within(openMenu("Alpha two")).queryByRole("menuitem", { name: "Plan subtasks" })).toBeNull();
  });
});

describe("FocusOutliner add to project", () => {
  it("does not offer the add button without a handler", () => {
    mount();
    expect(screen.queryByRole("button", { name: /Add a task to/ })).toBeNull();
  });

  it("adds a task to the project and keeps the form open for the next one", async () => {
    const onAddToProject = vi.fn().mockResolvedValue(undefined);
    mount({ onAddToProject });
    fireEvent.click(screen.getByRole("button", { name: "Add a task to Alpha for this day" }));
    const input = screen.getByLabelText("New task in Alpha") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Brand new  " } });
    press(input, "Enter");
    await waitFor(() => expect(onAddToProject).toHaveBeenCalledWith("alpha", "Brand new"));
    await waitFor(() => expect((screen.getByLabelText("New task in Alpha") as HTMLInputElement).value).toBe(""));
  });

  it("closes the form on Escape or an empty Enter and returns focus to the header", () => {
    mount({ onAddToProject: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Add a task to Alpha for this day" }));
    press(screen.getByLabelText("New task in Alpha"), "Enter");
    expect(screen.queryByLabelText("New task in Alpha")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Alpha, 4 tasks, 1 done" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a task to Alpha for this day" }));
    press(screen.getByLabelText("New task in Alpha"), "Escape");
    expect(screen.queryByLabelText("New task in Alpha")).toBeNull();
  });

  it("ignores unrelated and composing keys", () => {
    const onAddToProject = vi.fn();
    mount({ onAddToProject });
    fireEvent.click(screen.getByRole("button", { name: "Add a task to Alpha for this day" }));
    const input = screen.getByLabelText("New task in Alpha");
    fireEvent.change(input, { target: { value: "x" } });
    press(input, "a");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onAddToProject).not.toHaveBeenCalled();
  });

  it("shows the failure and keeps the text", async () => {
    const onAddToProject = vi.fn().mockRejectedValue(new Error("add failed"));
    mount({ onAddToProject });
    fireEvent.click(screen.getByRole("button", { name: "Add a task to Alpha for this day" }));
    const input = screen.getByLabelText("New task in Alpha") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Brand new" } });
    press(input, "Enter");
    expect((await screen.findByText("add failed")).getAttribute("role")).toBe("alert");
    expect(input.value).toBe("Brand new");
  });

  it("expands a collapsed project when adding to it", () => {
    const view = mount({ onAddToProject: vi.fn(), initialCollapse: { projects: ["alpha"], tasks: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Add a task to Alpha for this day" }));
    expect(view.onCollapseChange).toHaveBeenCalledWith({ projects: [], tasks: [] });
    expect(screen.getByLabelText("New task in Alpha")).toBeTruthy();
  });
});
