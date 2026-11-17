import { expect, test } from "vitest";
import { highlightLines, joinHighlight } from "./md-highlight";

const kinds = (text: string, line: number): string[] => (highlightLines(text)[line] ?? []).map((token) => token.kind);

test("blank lines inside front matter and inside a fence produce no tokens", () => {
  const lines = highlightLines("---\n\na: 1\n---\n```\n\ncode\n```");
  expect(lines[1]).toEqual([]);
  expect(lines[5]).toEqual([]);
  expect(kinds("---\n\na: 1\n---\n```\n\ncode\n```", 6)).toEqual(["code"]);
});

test("a BOM before a heading, a fence or a list is kept as plain text", () => {
  expect(highlightLines("﻿# Title")[0]).toEqual([
    { kind: "plain", text: "﻿" },
    { kind: "heading", text: "# Title" },
  ]);
  const fenced = highlightLines("﻿```\ninside\n```");
  expect(fenced[0]).toEqual([
    { kind: "plain", text: "﻿" },
    { kind: "fence", text: "```" },
  ]);
  expect(fenced[1]?.[0]?.kind).toBe("code");
  expect(joinHighlight(fenced)).toBe("﻿```\ninside\n```");
});

test("rules, quotes, ordered items and every checkbox marker get their own kinds", () => {
  expect(kinds("---x", 0)).toEqual(["plain"]);
  expect(kinds("***", 0)).toEqual(["marker"]);
  expect(kinds("> quote", 0)).toEqual(["quote"]);
  expect(kinds("1. [ ] a", 0).slice(0, 4)).toEqual(["marker", "plain", "task-open", "plain"]);
  expect(kinds("- [-] a", 0)).toContain("task-doing");
  expect(kinds("- [x] a", 0)).toContain("task-done");
  expect(kinds("- [X] a", 0)).toContain("task-done");
  expect(kinds("  - plain item", 0)).toEqual(["plain", "marker", "plain", "plain"]);
});

test("a repeating rule inside a list-like line is not treated as a list", () => {
  expect(kinds("- - -", 0)).toEqual(["marker"]);
});

test("the line cache is cleared when it grows past its limit and tokens stay correct", () => {
  const text = Array.from({ length: 20_050 }, (_, index) => `line ${index}`).join("\n");
  const lines = highlightLines(text);
  expect(lines).toHaveLength(20_050);
  expect(joinHighlight(lines)).toBe(text);
  expect(joinHighlight(highlightLines("line 5\nline 20049"))).toBe("line 5\nline 20049");
});

test("text without a trailing newline and with carriage returns round-trips", () => {
  const text = "# a\r\n- [ ] b\r\nlast";
  expect(joinHighlight(highlightLines(text))).toBe(text);
  expect(highlightLines(text)[0]?.at(-1)).toEqual({ kind: "plain", text: "\r" });
});
