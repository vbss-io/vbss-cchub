import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  LIST_WINDOW,
  LOG_WINDOW,
  clampOverflows,
  countLines,
  logWindow,
  newItemIndex,
  revealedOffset,
  showMoreAll,
  showMoreLabels,
  showMoreNext,
  showMoreReveal,
  showMoreStart,
  showMoreSync,
  showMoreView,
  toggleKey,
  visibleRange,
  type ShowMoreOptions,
} from "./show-more";

const small: ShowMoreOptions = { initial: 3, step: 5, showAllUnder: 2 };

describe("showMoreView", () => {
  it("shows the first 20 of a long list and offers the next block of 50", () => {
    const view = showMoreView(showMoreStart("s", LIST_WINDOW), 704, LIST_WINDOW);
    assert.deepEqual(view, { shown: 20, hidden: 684, next: 50, all: 0 });
  });

  it("shows everything when the list fits the first window", () => {
    assert.deepEqual(showMoreView(showMoreStart("s", LIST_WINDOW), 12, LIST_WINDOW), { shown: 12, hidden: 0, next: 0, all: 0 });
    assert.deepEqual(showMoreView(showMoreStart("s", LIST_WINDOW), 0, LIST_WINDOW), { shown: 0, hidden: 0, next: 0, all: 0 });
  });

  it("offers a single Show all when the remainder is under the threshold", () => {
    assert.deepEqual(showMoreView(showMoreStart("s", LIST_WINDOW), 40, LIST_WINDOW), { shown: 20, hidden: 20, next: 0, all: 20 });
    assert.deepEqual(showMoreView(showMoreStart("s", LIST_WINDOW), 45, LIST_WINDOW), { shown: 20, hidden: 25, next: 0, all: 25 });
    assert.deepEqual(showMoreView(showMoreStart("s", LIST_WINDOW), 46, LIST_WINDOW), { shown: 20, hidden: 26, next: 26, all: 0 });
  });

  it("adds Show all next to Show more after the first click", () => {
    const once = showMoreNext(showMoreStart("s", LIST_WINDOW), 704, LIST_WINDOW);
    assert.deepEqual(showMoreView(once, 704, LIST_WINDOW), { shown: 70, hidden: 634, next: 50, all: 634 });
  });

  it("caps the next block at what is left", () => {
    const state = { key: "s", visible: 3, clicks: 0 };
    assert.deepEqual(showMoreView(state, 7, small), { shown: 3, hidden: 4, next: 4, all: 0 });
  });
});

describe("showMoreNext and showMoreAll", () => {
  it("adds one block per click", () => {
    const first = showMoreNext(showMoreStart("s", small), 20, small);
    assert.equal(first.visible, 8);
    assert.equal(first.clicks, 1);
    assert.equal(showMoreNext(first, 20, small).visible, 13);
  });

  it("shows everything when only the Show all action is left", () => {
    const state = showMoreNext(showMoreStart("s", small), 4, small);
    assert.equal(showMoreView(state, 4, small).hidden, 0);
    assert.equal(showMoreView(state, 400, small).hidden, 0);
  });

  it("keeps showing everything when the list grows after Show all", () => {
    const state = showMoreAll(showMoreStart("s", LIST_WINDOW));
    assert.deepEqual(showMoreView(state, 704, LIST_WINDOW), { shown: 704, hidden: 0, next: 0, all: 0 });
    assert.deepEqual(showMoreView(state, 900, LIST_WINDOW), { shown: 900, hidden: 0, next: 0, all: 0 });
  });
});

describe("showMoreSync", () => {
  it("keeps the window while the identity is the same", () => {
    const state = showMoreNext(showMoreStart("a", LIST_WINDOW), 704, LIST_WINDOW);
    assert.equal(showMoreSync(state, "a", LIST_WINDOW), state);
  });

  it("resets the window when the identity or filter changes", () => {
    const state = showMoreNext(showMoreStart("a", LIST_WINDOW), 704, LIST_WINDOW);
    assert.deepEqual(showMoreSync(state, "b", LIST_WINDOW), { key: "b", visible: 20, clicks: 0 });
  });
});

describe("visibleRange", () => {
  it("takes the head for lists read from the start", () => {
    assert.deepEqual(visibleRange(704, 20, "start"), { start: 0, end: 20 });
  });

  it("takes the tail for chronological lists read from the end", () => {
    assert.deepEqual(visibleRange(40, 20, "end"), { start: 20, end: 40 });
    assert.deepEqual(visibleRange(5, 20, "end"), { start: 0, end: 5 });
  });
});

describe("showMoreLabels", () => {
  it("names the next block and the remainder with counts", () => {
    assert.deepEqual(showMoreLabels({ shown: 70, hidden: 634, next: 50, all: 634 }, "start"), [
      { action: "more", label: "Show more (+50)", count: 50 },
      { action: "all", label: "Show all (+634)", count: 634 },
    ]);
  });

  it("says earlier for chronological lists and adds a unit", () => {
    assert.deepEqual(showMoreLabels({ shown: 500, hidden: 4504, next: 1000, all: 0 }, "end", "lines"), [{ action: "more", label: "Show earlier (+1000 lines)", count: 1000 }]);
  });

  it("is empty when nothing is hidden", () => {
    assert.deepEqual(showMoreLabels({ shown: 4, hidden: 0, next: 0, all: 0 }, "start"), []);
  });
});

describe("countLines", () => {
  it("counts lines the way a log renders them", () => {
    assert.equal(countLines(""), 1);
    assert.equal(countLines("one"), 1);
    assert.equal(countLines("one\ntwo\nthree"), 3);
  });
});

describe("logWindow", () => {
  const line = (key: string, text: string) => ({ key, kind: "text", text });
  const many = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

  it("keeps a short log untouched", () => {
    const lines = [line("a", "one"), line("b", "two\nthree")];
    assert.deepEqual(logWindow(lines, 500), { items: lines, hiddenLines: 0, totalLines: 3 });
  });

  it("renders only the last lines of a 5,000-line output", () => {
    const window = logWindow([line("a", "status"), line("b", many(5000)), line("c", "done")], LOG_WINDOW.initial);
    assert.equal(window.totalLines, 5002);
    assert.equal(window.hiddenLines, 4502);
    assert.equal(window.items.length, 2);
    assert.equal(window.items[0]?.key, "b");
    assert.equal(countLines(window.items[0]?.text ?? ""), 499);
    assert.ok(window.items[0]?.text.startsWith("line 4502\n"));
    assert.ok(window.items[0]?.text.endsWith("line 5000"));
    assert.equal(window.items[1]?.text, "done");
  });

  it("drops whole entries before the window", () => {
    const lines = Array.from({ length: 10 }, (_, index) => line(String(index), `entry ${index}`));
    const window = logWindow(lines, 4);
    assert.deepEqual(
      window.items.map((item) => item.key),
      ["6", "7", "8", "9"],
    );
    assert.equal(window.hiddenLines, 6);
  });

  it("shows everything for an unbounded window", () => {
    const lines = [line("a", many(3000))];
    assert.deepEqual(logWindow(lines, Number.POSITIVE_INFINITY), { items: lines, hiddenLines: 0, totalLines: 3000 });
  });
});

describe("clampOverflows", () => {
  it("only reports overflow beyond a one-pixel rounding slack", () => {
    assert.equal(clampOverflows(120, 120), false);
    assert.equal(clampOverflows(121, 120), false);
    assert.equal(clampOverflows(160, 120), true);
  });
});

describe("toggleKey", () => {
  it("opens and closes one item without touching the others", () => {
    const start = new Set(["a"]);
    const opened = toggleKey(start, "b");
    assert.deepEqual([...opened].sort(), ["a", "b"]);
    assert.deepEqual([...toggleKey(opened, "a")], ["b"]);
    assert.deepEqual([...start], ["a"]);
  });
});

describe("newItemIndex", () => {
  it("finds the last item that was not in the previous list", () => {
    assert.equal(newItemIndex(["a", "b", "c"], ["a", "b", "c", "d"]), 3);
    assert.equal(newItemIndex(["a", "b", "c"], ["a", "x", "b", "c"]), 1);
    assert.equal(newItemIndex(["a", "b"], ["y", "a", "b", "z"]), 3);
  });

  it("counts repeated keys so a duplicate text is still new", () => {
    assert.equal(newItemIndex(["n:todo", "n:todo"], ["n:todo", "n:todo", "n:todo"]), 2);
  });

  it("returns -1 when nothing was added", () => {
    assert.equal(newItemIndex(["a", "b"], ["a", "b"]), -1);
    assert.equal(newItemIndex(["a", "b"], ["b"]), -1);
    assert.equal(newItemIndex(["a", "b"], ["b", "a"]), -1);
  });
});

describe("showMoreReveal", () => {
  const options: ShowMoreOptions = { initial: 50, step: 50, showAllUnder: 25 };

  it("grows a list read from the start until the item is shown", () => {
    const start = showMoreStart("k", options);
    const revealed = showMoreReveal(start, 50, 51, "start");
    assert.equal(revealed.visible, 51);
    assert.equal(showMoreView(revealed, 51, options).hidden, 0);
    assert.equal(visibleRange(51, showMoreView(revealed, 51, options).shown, "start").end, 51);
  });

  it("grows a list read from the end until the item is shown", () => {
    const start = showMoreStart("k", options);
    const revealed = showMoreReveal(start, 2, 80, "end");
    assert.equal(revealed.visible, 78);
    assert.equal(visibleRange(80, showMoreView(revealed, 80, options).shown, "end").start, 2);
  });

  it("keeps the state when the item is already visible", () => {
    const start = showMoreStart("k", options);
    assert.equal(showMoreReveal(start, 10, 60, "start"), start);
    assert.equal(showMoreReveal(start, 30, 60, "end"), start);
    assert.equal(showMoreReveal(start, -1, 60, "start"), start);
  });
});

describe("revealedOffset", () => {
  it("points at the first newly revealed row of a list read from the start", () => {
    assert.equal(revealedOffset({ start: 0, end: 20 }, { start: 0, end: 70 }, "start"), 20);
  });

  it("points at the top row of a list read from the end", () => {
    assert.equal(revealedOffset({ start: 50, end: 70 }, { start: 0, end: 70 }, "end"), 0);
    assert.equal(revealedOffset({ start: 50, end: 70 }, { start: 30, end: 70 }, "end"), 0);
  });

  it("returns null when nothing new is shown", () => {
    assert.equal(revealedOffset({ start: 0, end: 20 }, { start: 0, end: 20 }, "start"), null);
    assert.equal(revealedOffset({ start: 10, end: 30 }, { start: 10, end: 30 }, "end"), null);
  });
});
