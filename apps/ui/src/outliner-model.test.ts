import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  addDays,
  canIndent,
  canMove,
  canOutdent,
  checkState,
  doingTarget,
  findNode,
  flattenVisible,
  keyIntent,
  nextNode,
  parseInlineTokens,
  prevNode,
  siblingsOf,
  subtreeEnd,
  type KeyEventLike,
  type OutlineGroup,
  type OutlineNode,
} from "./outliner-model";

const TODAY = "2026-11-12";

const node = (id: string, projectId: string, depth: number, children: OutlineNode[] = []): OutlineNode => ({
  id,
  projectId,
  line: 0,
  raw: id,
  title: id,
  status: "todo",
  priority: null,
  due: null,
  notes: [],
  children,
  depth,
});

const groups = (): OutlineGroup[] => [
  {
    project: { id: "a", title: "Alpha" },
    items: [node("a1", "a", 0, [node("a1x", "a", 1), node("a1y", "a", 1)]), node("a2", "a", 0)],
  },
  { project: { id: "b", title: "Beta" }, items: [node("b1", "b", 0, [node("b1x", "b", 1)])] },
];

const key = (name: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: name,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("parseInlineTokens", () => {
  it("returns the trimmed text when no token is present", () => {
    assert.deepEqual(parseInlineTokens("  write the report  ", TODAY), { title: "write the report", priority: undefined, due: undefined });
  });

  it("extracts priority and removes it from the title", () => {
    assert.deepEqual(parseInlineTokens("fix login #p1", TODAY), { title: "fix login", priority: 1, due: undefined });
    assert.deepEqual(parseInlineTokens("#p0 fix login", TODAY), { title: "fix login", priority: 0, due: undefined });
    assert.equal(parseInlineTokens("fix #p9 login", TODAY).priority, 9);
  });

  it("accepts an uppercase priority token", () => {
    assert.deepEqual(parseInlineTokens("fix #P2", TODAY), { title: "fix", priority: 2, due: undefined });
  });

  it("extracts an explicit due date", () => {
    assert.deepEqual(parseInlineTokens("ship due:2026-12-01", TODAY), { title: "ship", priority: undefined, due: "2026-12-01" });
  });

  it("resolves relative words in English and Portuguese", () => {
    assert.equal(parseInlineTokens("a due:today", TODAY).due, "2026-11-12");
    assert.equal(parseInlineTokens("a due:tomorrow", TODAY).due, "2026-11-13");
    assert.equal(parseInlineTokens("a due:hoje", TODAY).due, "2026-11-12");
    assert.equal(parseInlineTokens("a due:amanha", TODAY).due, "2026-11-13");
    assert.equal(parseInlineTokens("a due:amanhã", TODAY).due, "2026-11-13");
    assert.equal(parseInlineTokens("a DUE:Amanhã", TODAY).due, "2026-11-13");
  });

  it("rolls tomorrow across month and year ends", () => {
    assert.equal(parseInlineTokens("a due:tomorrow", "2026-12-31").due, "2027-01-01");
    assert.equal(parseInlineTokens("a due:tomorrow", "2028-02-28").due, "2028-02-29");
  });

  it("keeps invalid dates as plain text", () => {
    assert.deepEqual(parseInlineTokens("call due:2026-13-45", TODAY), { title: "call due:2026-13-45", priority: undefined, due: undefined });
    assert.deepEqual(parseInlineTokens("call due:2026-02-30", TODAY), { title: "call due:2026-02-30", priority: undefined, due: undefined });
    assert.deepEqual(parseInlineTokens("call due:soon", TODAY), { title: "call due:soon", priority: undefined, due: undefined });
    assert.deepEqual(parseInlineTokens("call due:", TODAY), { title: "call due:", priority: undefined, due: undefined });
  });

  it("keeps lookalike priority tokens as text", () => {
    assert.deepEqual(parseInlineTokens("tag #p10 and #p and #pa", TODAY), { title: "tag #p10 and #p and #pa", priority: undefined, due: undefined });
  });

  it("keeps a valid token as text when it is glued to other characters", () => {
    assert.equal(parseInlineTokens("fix#p1 now", TODAY).priority, undefined);
    assert.equal(parseInlineTokens("fix #p1, now", TODAY).priority, undefined);
  });

  it("combines tokens and never leaves double spaces", () => {
    const result = parseInlineTokens("fix   #p2   login  due:tomorrow   today", TODAY);
    assert.deepEqual(result, { title: "fix login today", priority: 2, due: "2026-11-13" });
    assert.equal(result.title.includes("  "), false);
  });

  it("returns an empty title when only tokens are typed", () => {
    assert.deepEqual(parseInlineTokens("#p1 due:today", TODAY), { title: "", priority: 1, due: "2026-11-12" });
  });

  it("lets the last token win", () => {
    assert.equal(parseInlineTokens("a #p1 b #p3", TODAY).priority, 3);
    assert.equal(parseInlineTokens("a due:2026-11-20 due:2026-11-21", TODAY).due, "2026-11-21");
  });

  it("leaves relative words as text when today is not a valid day", () => {
    assert.deepEqual(parseInlineTokens("a due:today", "nope"), { title: "a due:today", priority: undefined, due: undefined });
    assert.equal(parseInlineTokens("a due:2026-11-20", "nope").due, "2026-11-20");
  });
});

describe("addDays", () => {
  it("adds days across boundaries", () => {
    assert.equal(addDays("2026-11-30", 1), "2026-12-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });
});

describe("doing helpers", () => {
  it("toggles only between todo and doing", () => {
    assert.equal(doingTarget("todo"), "doing");
    assert.equal(doingTarget("doing"), "todo");
    for (const status of ["done", "blocked", "hold", "archived"] as const) assert.equal(doingTarget(status), null, status);
  });

  it("maps statuses to the three checkbox states", () => {
    assert.equal(checkState("todo"), "unchecked");
    assert.equal(checkState("blocked"), "unchecked");
    assert.equal(checkState("hold"), "unchecked");
    assert.equal(checkState("doing"), "mixed");
    assert.equal(checkState("done"), "checked");
  });
});

describe("keyIntent in view mode", () => {
  it("maps navigation keys", () => {
    assert.equal(keyIntent(key("ArrowDown"), "view"), "next");
    assert.equal(keyIntent(key("j"), "view"), "next");
    assert.equal(keyIntent(key("ArrowUp"), "view"), "prev");
    assert.equal(keyIntent(key("k"), "view"), "prev");
  });

  it("maps editing and structure keys", () => {
    assert.equal(keyIntent(key("Enter"), "view"), "edit");
    assert.equal(keyIntent(key("Enter", { ctrlKey: true }), "view"), "toggle-done");
    assert.equal(keyIntent(key("Enter", { shiftKey: true }), "view"), "add-note");
    assert.equal(keyIntent(key("Tab"), "view"), "indent");
    assert.equal(keyIntent(key("Tab", { shiftKey: true }), "view"), "outdent");
    assert.equal(keyIntent(key("ArrowUp", { altKey: true }), "view"), "move-up");
    assert.equal(keyIntent(key("ArrowDown", { altKey: true }), "view"), "move-down");
  });

  it("maps action keys", () => {
    assert.equal(keyIntent(key("o"), "view"), "open");
    assert.equal(keyIntent(key("m"), "view"), "tomorrow");
    assert.equal(keyIntent(key("s"), "view"), "toggle-doing");
    assert.equal(keyIntent(key("Delete"), "view"), "unschedule");
    assert.equal(keyIntent(key("Backspace"), "view"), "unschedule");
  });

  it("treats Meta as Ctrl", () => {
    assert.equal(keyIntent(key("Enter", { metaKey: true }), "view"), "toggle-done");
  });

  it("ignores letter shortcuts with modifiers and unknown keys", () => {
    assert.equal(keyIntent(key("j", { ctrlKey: true }), "view"), null);
    assert.equal(keyIntent(key("m", { altKey: true }), "view"), null);
    assert.equal(keyIntent(key("o", { metaKey: true }), "view"), null);
    assert.equal(keyIntent(key("s", { ctrlKey: true }), "view"), null);
    assert.equal(keyIntent(key("s", { altKey: true }), "view"), null);
    assert.equal(keyIntent(key("s", { shiftKey: true }), "view"), null);
    assert.equal(keyIntent(key("Delete", { shiftKey: true }), "view"), null);
    assert.equal(keyIntent(key("x"), "view"), null);
    assert.equal(keyIntent(key("Escape"), "view"), null);
    assert.equal(keyIntent(key("ArrowDown", { shiftKey: true }), "view"), null);
  });
});

describe("keyIntent in edit mode", () => {
  it("maps Enter variants", () => {
    assert.equal(keyIntent(key("Enter"), "edit"), "save-and-new");
    assert.equal(keyIntent(key("Enter", { ctrlKey: true }), "edit"), "toggle-done");
    assert.equal(keyIntent(key("Enter", { metaKey: true }), "edit"), "toggle-done");
    assert.equal(keyIntent(key("Enter", { shiftKey: true }), "edit"), "add-note");
  });

  it("maps cancel, indent and move", () => {
    assert.equal(keyIntent(key("Escape"), "edit"), "cancel");
    assert.equal(keyIntent(key("Tab"), "edit"), "indent");
    assert.equal(keyIntent(key("Tab", { shiftKey: true }), "edit"), "outdent");
    assert.equal(keyIntent(key("ArrowUp", { altKey: true }), "edit"), "move-up");
    assert.equal(keyIntent(key("ArrowDown", { altKey: true }), "edit"), "move-down");
    assert.equal(keyIntent(key("ArrowDown", { altKey: true, metaKey: true }), "edit"), null);
  });

  it("maps Ctrl+S to save", () => {
    assert.equal(keyIntent(key("s", { ctrlKey: true }), "edit"), "save");
    assert.equal(keyIntent(key("s", { metaKey: true }), "edit"), "save");
  });

  it("leaves typing keys alone so the input behaves like text", () => {
    for (const name of ["j", "k", "o", "m", "s", "Delete", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "a"]) {
      assert.equal(keyIntent(key(name), "edit"), null, name);
    }
  });
});

describe("navigation", () => {
  it("flattens in visible order across groups", () => {
    assert.deepEqual(
      flattenVisible(groups()).map((item) => item.id),
      ["a1", "a1x", "a1y", "a2", "b1", "b1x"],
    );
  });

  it("moves to the next node across a group boundary", () => {
    assert.equal(nextNode(groups(), "a2")?.id, "b1");
    assert.equal(nextNode(groups(), "a1")?.id, "a1x");
  });

  it("moves to the previous node across a group boundary", () => {
    assert.equal(prevNode(groups(), "b1")?.id, "a2");
    assert.equal(prevNode(groups(), "a1x")?.id, "a1");
  });

  it("stops at the ends", () => {
    assert.equal(nextNode(groups(), "b1x"), null);
    assert.equal(prevNode(groups(), "a1"), null);
  });

  it("falls back to the first node for an unknown id", () => {
    assert.equal(nextNode(groups(), "gone")?.id, "a1");
    assert.equal(prevNode(groups(), "gone")?.id, "a1");
    assert.equal(nextNode([], "x"), null);
  });

  it("finds a node by id", () => {
    assert.equal(findNode(groups(), "b1x")?.projectId, "b");
    assert.equal(findNode(groups(), "zzz"), null);
  });

  it("computes the end of a subtree", () => {
    const flat = flattenVisible(groups());
    assert.equal(subtreeEnd(flat, 0), 3);
    assert.equal(subtreeEnd(flat, 3), 4);
    assert.equal(subtreeEnd(flat, 5), 6);
  });
});

describe("structure rules", () => {
  it("lists siblings at the same level", () => {
    const g = groups();
    assert.deepEqual(siblingsOf(g, g[0]!.items[0]!.children[0]!).map((item) => item.id), ["a1x", "a1y"]);
    assert.deepEqual(siblingsOf(g, g[0]!.items[1]!).map((item) => item.id), ["a1", "a2"]);
  });

  it("only indents when there is a previous sibling in the same project", () => {
    const g = groups();
    assert.equal(canIndent(g, g[0]!.items[0]!), false);
    assert.equal(canIndent(g, g[0]!.items[1]!), true);
    assert.equal(canIndent(g, g[1]!.items[0]!), false);
    assert.equal(canIndent(g, g[0]!.items[0]!.children[0]!), false);
    assert.equal(canIndent(g, g[0]!.items[0]!.children[1]!), true);
  });

  it("only outdents below depth zero", () => {
    const g = groups();
    assert.equal(canOutdent(g[0]!.items[0]!), false);
    assert.equal(canOutdent(g[0]!.items[0]!.children[0]!), true);
  });

  it("moves only when a sibling exists in that direction", () => {
    const g = groups();
    const first = g[0]!.items[0]!;
    const second = g[0]!.items[1]!;
    assert.equal(canMove(g, first, "up"), false);
    assert.equal(canMove(g, first, "down"), true);
    assert.equal(canMove(g, second, "up"), true);
    assert.equal(canMove(g, second, "down"), false);
  });
});
