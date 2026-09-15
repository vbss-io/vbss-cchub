import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countTasks, Markdown, splitFrontmatter, toggleTaskLine } from "./markdown";

const render = (props: Parameters<typeof Markdown>[0]) => renderToStaticMarkup(createElement(Markdown, props) as never);

test("splitFrontmatter extracts the yaml block and reports the body offset", () => {
  const source = "---\ntype: diario\nupdated: 2026-09-14\n---\n# Today\n\nBody text.";
  const result = splitFrontmatter(source);
  assert.deepEqual(result.frontmatter, { type: "diario", updated: "2026-09-14" });
  assert.equal(result.body, "# Today\n\nBody text.");
  assert.equal(result.bodyOffset, 4);
});

test("splitFrontmatter returns null frontmatter when there is no leading delimiter", () => {
  const source = "# Today\n\nBody text.";
  const result = splitFrontmatter(source);
  assert.equal(result.frontmatter, null);
  assert.equal(result.body, source);
  assert.equal(result.bodyOffset, 0);
});

test("splitFrontmatter returns null frontmatter when the closing delimiter is missing", () => {
  const source = "---\ntype: diario\n# Today";
  const result = splitFrontmatter(source);
  assert.equal(result.frontmatter, null);
  assert.equal(result.body, source);
});

test("toggleTaskLine flips only the target line and keeps everything else, LF", () => {
  const source = "- [ ] one\n- [ ] two\n- [x] three";
  const next = toggleTaskLine(source, 1, true);
  assert.equal(next, "- [ ] one\n- [x] two\n- [x] three");
});

test("toggleTaskLine preserves CRLF line endings elsewhere in the file", () => {
  const source = "# Diary\r\n\r\n- [ ] one\r\n- [ ] two\r\n";
  const next = toggleTaskLine(source, 3, true);
  assert.equal(next, "# Diary\r\n\r\n- [ ] one\r\n- [x] two\r\n");
});

test("toggleTaskLine on an out-of-range index returns the source unchanged", () => {
  const source = "- [ ] one\n- [ ] two";
  assert.equal(toggleTaskLine(source, 9, true), source);
});

test("renders nested lists at least two levels deep", () => {
  const source = "- top\n  - mid\n    - deep";
  const html = render({ text: source });
  const topUl = (html.match(/<ul class="md__list">/g) ?? []).length;
  assert.ok(topUl >= 3, `expected 3 nested <ul>, saw markup: ${html}`);
  assert.ok(html.includes(">top<") || html.includes(">top"));
  assert.ok(html.includes("deep"));
});

test("renders a blockquote containing a paragraph and a list", () => {
  const source = "> Briefing text\n>\n> - point one\n> - point two";
  const html = render({ text: source });
  assert.match(html, /<blockquote class="md__quote">/);
  assert.match(html, /Briefing text/);
  assert.match(html, /point one/);
  const blockquoteIndex = html.indexOf("<blockquote");
  const listIndex = html.indexOf("point one");
  assert.ok(blockquoteIndex >= 0 && listIndex > blockquoteIndex);
});

test("renders a horizontal rule and a wikilink", () => {
  const source = "before\n\n---\n\nsee [[Second Brain|the vault]]";
  const html = render({ text: source });
  assert.match(html, /<hr class="md__hr"/);
  assert.match(html, /<span class="md__wikilink">the vault<\/span>/);
});

test("renders task list items as checkboxes reflecting their state", () => {
  const source = "- [ ] todo\n- [x] done";
  const html = render({ text: source });
  assert.match(html, /class="md__task"/);
  assert.match(html, /checked=""/);
});

test("frontmatter=chip shows a summary chip and hides the raw delimiters", () => {
  const source = "---\ntype: diario\nupdated: 2026-09-14\n---\n# Today";
  const html = render({ text: source, frontmatter: "chip" });
  assert.match(html, /class="chip md__frontmatter"/);
  assert.match(html, /diario · 2026-09-14/);
  assert.doesNotMatch(html, /---/);
});

test("frontmatter=hidden strips the yaml without rendering a chip", () => {
  const source = "---\ntype: diario\n---\n# Today";
  const html = render({ text: source, frontmatter: "hidden" });
  assert.doesNotMatch(html, /md__frontmatter/);
  assert.doesNotMatch(html, /---/);
  assert.match(html, /Today/);
});

test("a task item nests a 2-space sub-bullet and a 4-space sub-sub-bullet three levels deep", () => {
  const source = "- [ ] top task\n  - mid\n      - deep";
  const html = render({ text: source });
  const listCount = (html.match(/<ul class="md__list">/g) ?? []).length;
  assert.equal(listCount, 3, `expected 3 nested <ul>, saw markup: ${html}`);
  assert.match(
    html,
    /<ul class="md__list"><li class="md__task"><label>[\s\S]*?<\/label><ul class="md__list"><li>[\s\S]*?<ul class="md__list"><li>[\s\S]*?deep/,
  );
  assert.ok(html.indexOf("mid") < html.indexOf("deep"));
});

test("leading tabs are normalised to 4 spaces so nesting still resolves", () => {
  const source = "- top\n\t- mid\n\t\t- deep";
  const html = render({ text: source });
  const listCount = (html.match(/<ul class="md__list">/g) ?? []).length;
  assert.equal(listCount, 3, `expected 3 nested <ul>, saw markup: ${html}`);
});

test("a blank line between two sibling items marks the following one as loose", () => {
  const source = "- one\n\n- two";
  const html = render({ text: source });
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<li class="md__item--loose">two<\/li>/);
  const listCount = (html.match(/<ul class="md__list">/g) ?? []).length;
  assert.equal(listCount, 1, `blank line must not split the list: ${html}`);
});

test("taskFilter=open hides checked tasks together with their nested subtree", () => {
  const source = "- [ ] open task\n  - [x] nested done task\n- [x] done task";
  const html = render({ text: source, taskFilter: "open" });
  assert.match(html, /open task/);
  assert.doesNotMatch(html, /nested done task/);
  assert.doesNotMatch(html, />done task</);
});

test("taskFilter=done hides unchecked tasks together with their nested subtree", () => {
  const source = "- [ ] open task\n  - [x] nested done task\n- [x] done task";
  const html = render({ text: source, taskFilter: "done" });
  assert.doesNotMatch(html, /open task/);
  assert.doesNotMatch(html, /nested done task/);
  assert.match(html, />done task</);
});

test("countTasks counts open and done task lines, nested included", () => {
  const source = "- [ ] a\n  - [x] b\n- [x] c\n- [ ] d";
  assert.deepEqual(countTasks(source), { open: 2, done: 2 });
});
