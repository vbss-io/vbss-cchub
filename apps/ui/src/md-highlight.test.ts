import assert from "node:assert/strict";
import { test } from "vitest";
import { highlightLines, joinHighlight, type HighlightKind } from "./md-highlight";

const kindsOf = (text: string, line = 0): Array<[HighlightKind, string]> =>
  (highlightLines(text)[line] ?? []).map((token) => [token.kind, token.text]);

test("every token stream reproduces the input exactly", () => {
  const samples = [
    "",
    "\n",
    "plain",
    "---\ntype: diario\n---\n# Title\n\n> brief **bold** [[a|b]]\n- [ ] task #p1 ⏳ 2026-11-13\n```ts\nconst a = 1;\n```\n",
    "a\r\nb **c**\r\n- [x] done ✅ 2026-11-12\r\n",
    "\uFEFF---\r\ntype: x\r\n---\r\n# Hi\r\n",
    "* star *it* _it_ __b__ `c` [t](http://x/#y) → end",
    "unclosed ``` fence\nstill code?",
    "```\nopen",
    "🔁 every week ⏳ 2026-11-14 📅 2026-11-20 🛫 2026-11-10",
    "emoji 😀 and ⏳\uFE0F 2026-01-01 and [[x]]]",
  ];
  for (const sample of samples) assert.equal(joinHighlight(highlightLines(sample)), sample);
});

test("front matter is muted only when it is closed", () => {
  const closed = highlightLines("---\na: 1\n---\n# H");
  assert.deepEqual(closed.map((tokens) => tokens[0]?.kind), ["frontmatter", "frontmatter", "frontmatter", "heading"]);
  assert.deepEqual(kindsOf("---\n# H\nbody", 1), [["heading", "# H"]]);
});

test("front matter works after a BOM and with CRLF", () => {
  const lines = highlightLines("\uFEFF---\r\na: 1\r\n---\r\n# H\r\n");
  assert.equal(lines[0]?.[0]?.kind, "frontmatter");
  assert.equal(lines[1]?.[0]?.kind, "frontmatter");
  assert.equal(lines[3]?.[0]?.kind, "heading");
  assert.equal(lines[3]?.[lines[3].length - 1]?.text, "\r");
});

test("headings need a space and keep inline tokens", () => {
  assert.deepEqual(kindsOf("## Plan [[x]]"), [
    ["heading", "## Plan "],
    ["wikilink", "[[x]]"],
  ]);
  assert.deepEqual(kindsOf("#p1 note"), [
    ["tag", "#p1"],
    ["plain", " note"],
  ]);
});

test("bold, italic and code are recognised", () => {
  assert.deepEqual(kindsOf("a **b** c __d__ e *f* g _h_ i `j`"), [
    ["plain", "a "],
    ["bold", "**b**"],
    ["plain", " c "],
    ["bold", "__d__"],
    ["plain", " e "],
    ["italic", "*f*"],
    ["plain", " g "],
    ["italic", "_h_"],
    ["plain", " i "],
    ["code", "`j`"],
  ]);
});

test("snake_case words are not italic", () => {
  assert.deepEqual(kindsOf("some_snake_case_name"), [["plain", "some_snake_case_name"]]);
});

test("blockquote lines are yellow with inline overrides", () => {
  assert.deepEqual(kindsOf("> brief **x** now"), [
    ["quote", "> brief "],
    ["bold", "**x**"],
    ["quote", " now"],
  ]);
});

test("wikilinks with alias and markdown links", () => {
  assert.deepEqual(kindsOf("see [[note|alias]] and [site](https://a.b/c) ![[img.png]]"), [
    ["plain", "see "],
    ["wikilink", "[[note|alias]]"],
    ["plain", " and "],
    ["link", "[site](https://a.b/c)"],
    ["plain", " "],
    ["wikilink", "![[img.png]]"],
  ]);
});

test("list markers and task checkboxes", () => {
  assert.deepEqual(kindsOf("  - [ ] open"), [
    ["plain", "  "],
    ["marker", "-"],
    ["plain", " "],
    ["task-open", "[ ]"],
    ["plain", " open"],
  ]);
  assert.equal(kindsOf("- [-] doing")[2]?.[0], "task-doing");
  assert.equal(kindsOf("- [x] done")[2]?.[0], "task-done");
  assert.equal(kindsOf("- [X] done")[2]?.[0], "task-done");
  assert.deepEqual(kindsOf("12. item"), [
    ["marker", "12."],
    ["plain", " "],
    ["plain", "item"],
  ]);
  assert.equal(kindsOf("* star")[0]?.[0], "marker");
});

test("horizontal rules are markers", () => {
  assert.deepEqual(kindsOf("***"), [["marker", "***"]]);
  assert.deepEqual(kindsOf("- - -"), [["marker", "- - -"]]);
});

test("priority tags, other tags and tasks dates", () => {
  assert.deepEqual(kindsOf("- [ ] ship #p1 #area/work ⏳ 2026-11-13 🛫 2026-11-10 📅 2026-11-20 ✅ 2026-11-12"), [
    ["marker", "-"],
    ["plain", " "],
    ["task-open", "[ ]"],
    ["plain", " ship "],
    ["tag", "#p1"],
    ["plain", " "],
    ["tag", "#area/work"],
    ["plain", " "],
    ["date", "⏳ 2026-11-13"],
    ["plain", " "],
    ["date", "🛫 2026-11-10"],
    ["plain", " "],
    ["date", "📅 2026-11-20"],
    ["plain", " "],
    ["date", "✅ 2026-11-12"],
  ]);
});

test("recurrence tag swallows the rule text and stops at the next marker", () => {
  const tokens = kindsOf("🔁 every week ⏳ 2026-11-14");
  assert.deepEqual(tokens[0], ["date", "🔁 every week"]);
  assert.deepEqual(tokens[2], ["date", "⏳ 2026-11-14"]);
});

test("numeric hashes and url fragments are not tags", () => {
  assert.deepEqual(kindsOf("issue #123 at http://x/#frag"), [["plain", "issue #123 at http://x/#frag"]]);
});

test("arrows are muted tokens", () => {
  assert.deepEqual(kindsOf("a → b"), [
    ["plain", "a "],
    ["arrow", "→"],
    ["plain", " b"],
  ]);
});

test("fenced blocks colour the body as code and close properly", () => {
  const lines = highlightLines("```ts\nconst **a** = 1;\n```\n**after**");
  assert.equal(lines[0]?.[0]?.kind, "fence");
  assert.deepEqual(lines[1], [{ kind: "code", text: "const **a** = 1;" }]);
  assert.equal(lines[2]?.[0]?.kind, "fence");
  assert.equal(lines[3]?.[0]?.kind, "bold");
});

test("an unterminated fence colours the rest as code", () => {
  const lines = highlightLines("```\na\nb");
  assert.equal(lines[2]?.[0]?.kind, "code");
});

test("identical lines reuse the cached tokens", () => {
  const lines = highlightLines("- [ ] same\n- [ ] same");
  assert.equal(lines[0], lines[1]);
});

test("a few thousand lines tokenise quickly", () => {
  const row = "- [ ] task **bold** [[wiki|alias]] #p2 ⏳ 2026-11-13 → [l](http://a.b)";
  const text = Array.from({ length: 5000 }, (_, index) => `${row} ${index}`).join("\n");
  const started = performance.now();
  const lines = highlightLines(text);
  assert.equal(lines.length, 5000);
  assert.ok(performance.now() - started < 1500);
});
