import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countTasks, InlineText, Markdown, renderInline, splitFrontmatter, toggleTaskLine } from "./markdown";

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

test("taskFilter=done hides an unchecked task that has no matching descendant", () => {
  const source = "- [ ] open task with no children\n- [x] done task";
  const html = render({ text: source, taskFilter: "done" });
  assert.doesNotMatch(html, /open task with no children/);
  assert.match(html, />done task</);
});

test("taskFilter=done keeps a matching nested task visible with its non-matching parent shown as context", () => {
  const source = "- [ ] open task\n  - [x] nested done task\n- [x] done task";
  const html = render({ text: source, taskFilter: "done" });
  assert.match(html, /nested done task/);
  assert.match(html, />done task</);
  assert.match(html, /md__item--context/);
  const openTaskIndex = html.indexOf("open task");
  assert.ok(openTaskIndex >= 0);
  const openTaskLiStart = html.lastIndexOf("<li", openTaskIndex);
  assert.match(html.slice(openTaskLiStart, openTaskIndex), /md__item--context/);
});

test("open sub-task under a done parent stays visible with the parent as md__item--context", () => {
  const source = "- [x] done parent\n  - [ ] open child\n- [x] unrelated done task";
  const html = render({ text: source, taskFilter: "open" });
  assert.match(html, /open child/);
  assert.match(html, /done parent/);
  const parentIndex = html.indexOf("done parent");
  const parentLiStart = html.lastIndexOf("<li", parentIndex);
  assert.match(html.slice(parentLiStart, parentIndex), /md__item--context/);
  assert.doesNotMatch(html, /unrelated done task/);
});

test("done parent with open child under taskFilter=done shows the parent and hides the open child", () => {
  const source = "- [x] done parent\n  - [ ] open child";
  const html = render({ text: source, taskFilter: "done" });
  assert.match(html, /done parent/);
  assert.doesNotMatch(html, /open child/);
  const parentIndex = html.indexOf("done parent");
  const parentLiStart = html.lastIndexOf("<li", parentIndex);
  assert.doesNotMatch(html.slice(parentLiStart, parentIndex), /md__item--context/);
});

test("the first visible item of a list is never loose when items before it were filtered out", () => {
  const source = "- [x] done one\n\n- [ ] open two";
  const html = render({ text: source, taskFilter: "open" });
  assert.match(html, /open two/);
  assert.doesNotMatch(html, /md__item--loose/);
});

test("countTasks counts open and done task lines, nested included", () => {
  const source = "- [ ] a\n  - [x] b\n- [x] c\n- [ ] d";
  assert.deepEqual(countTasks(source), { open: 2, done: 2 });
});

test("toggleTaskLine turns [-] into [x] when checking", () => {
  assert.equal(toggleTaskLine("- [ ] a\n- [-] b\n- [ ] c", 1, true), "- [ ] a\n- [x] b\n- [ ] c");
});

test("toggleTaskLine unchecking reopens [x] and never corrupts [-]", () => {
  assert.equal(toggleTaskLine("- [x] a\n- [-] b", 0, false), "- [ ] a\n- [-] b");
  assert.equal(toggleTaskLine("- [x] a\n- [-] b", 1, false), "- [x] a\n- [-] b");
});

test("toggleTaskLine only touches the leading checkbox of the line", () => {
  assert.equal(toggleTaskLine("- [-] fix [ ] literal", 0, true), "- [x] fix [ ] literal");
});

test("countTasks counts [-] as open", () => {
  assert.deepEqual(countTasks("- [ ] a\n- [-] b\n  - [x] c\n- [x] d"), { open: 2, done: 2 });
});

test("renders a [-] item as a task in the doing state", () => {
  const html = render({ text: "- [-] started\n- [ ] todo\n- [x] finished" });
  assert.match(html, /<li class="md__task md__task--doing"[^>]*>/);
  assert.match(html, /started/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3);
  assert.equal((html.match(/md__task--doing/g) ?? []).length, 1);
  assert.doesNotMatch(html, /\[-\]/);
});

test("the open task filter keeps [-] items and the done filter hides them", () => {
  const source = "- [-] started\n- [x] finished";
  const open = render({ text: source, taskFilter: "open" });
  assert.match(open, /started/);
  assert.doesNotMatch(open, /finished/);
  const done = render({ text: source, taskFilter: "done" });
  assert.doesNotMatch(done, /started/);
  assert.match(done, /finished/);
});

test("toggleTaskLine checks and unchecks every bullet marker", () => {
  assert.equal(toggleTaskLine("+ [ ] a", 0, true), "+ [x] a");
  assert.equal(toggleTaskLine("* [-] a", 0, true), "* [x] a");
  assert.equal(toggleTaskLine("+ [x] a", 0, false), "+ [ ] a");
});

test("toggleTaskLine handles ordered list task lines", () => {
  assert.equal(toggleTaskLine("1. [ ] ordered", 0, true), "1. [x] ordered");
  assert.equal(toggleTaskLine("  12) [-] ordered", 0, true), "  12) [x] ordered");
  assert.equal(toggleTaskLine("1. [x] ordered", 0, false), "1. [ ] ordered");
  assert.equal(toggleTaskLine("1. [-] ordered", 0, false), "1. [-] ordered");
});

test("toggleTaskLine handles blockquote-prefixed task lines", () => {
  assert.equal(toggleTaskLine("> - [ ] quoted", 0, true), "> - [x] quoted");
  assert.equal(toggleTaskLine("> > - [-] nested", 0, true), "> > - [x] nested");
  assert.equal(toggleTaskLine("> 1. [x] quoted", 0, false), "> 1. [ ] quoted");
  assert.equal(toggleTaskLine(">> * [ ] tight", 0, true), ">> * [x] tight");
});

test("toggleTaskLine keeps only-leading-checkbox rule for ordered and quoted lines", () => {
  assert.equal(toggleTaskLine("1. [-] fix [ ] literal", 0, true), "1. [x] fix [ ] literal");
  assert.equal(toggleTaskLine("> - plain [ ] text", 0, true), "> - plain [ ] text");
});

test("countTasks counts +, ordered and blockquote-prefixed task lines like toggleTaskLine handles them", () => {
  const source = ["+ [ ] plus open", "1. [x] ordered done", "2) [-] ordered doing", "> - [ ] quoted open", "> > * [x] nested quote done"].join("\n");
  assert.deepEqual(countTasks(source), { open: 3, done: 2 });
});

test("countTasks ignores lines toggleTaskLine would not touch", () => {
  assert.deepEqual(countTasks("- [] none\n- plain\nnot - [ ] mid\n1.[ ] tight"), { open: 0, done: 0 });
});

test("countTasks handles CRLF sources", () => {
  assert.deepEqual(countTasks("- [ ] a\r\n1. [x] b\r\n"), { open: 1, done: 1 });
});

const inline = (text: string): string => renderToStaticMarkup(createElement("span", null, renderInline(text, "t")) as never);

test("renderInline renders bold, italic, code and strike", () => {
  const html = inline("**bold** and *it* and _also_ and `code` and ~~gone~~");
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<em>it</em>"));
  assert.ok(html.includes("<em>also</em>"));
  assert.ok(html.includes('<code class="md__inline">code</code>'));
  assert.ok(html.includes("<del>gone</del>"));
});

test("renderInline keeps identifiers with underscores and spaced asterisks as plain text", () => {
  assert.equal(inline("fix get_user_by_id now"), "<span>fix get_user_by_id now</span>");
  assert.equal(inline("math 2 * 3 * 4"), "<span>math 2 * 3 * 4</span>");
  assert.ok(inline("call __init__ first").includes("<strong>init</strong>"));
});

test("renderInline does not format inside code spans", () => {
  const html = inline("run `a **b** c` now");
  assert.ok(html.includes('<code class="md__inline">a **b** c</code>'));
  assert.ok(!html.includes("<strong>"));
});

test("renderInline shows a wikilink as its alias, or its target without one", () => {
  assert.ok(inline("see [[Roadmap Q4|the roadmap]] today").includes('<span class="md__wikilink">the roadmap</span>'));
  assert.ok(inline("see [[Roadmap Q4]] today").includes('<span class="md__wikilink">Roadmap Q4</span>'));
});

test("renderInline links only http(s) urls and nests formatting in the label", () => {
  const html = inline("[**docs**](https://example.com/a) and [bad](javascript:alert(1))");
  assert.ok(html.includes('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer"><strong>docs</strong></a>'));
  assert.ok(html.includes("[bad](javascript:alert(1))"));
});

function findAnchor(node: ReactNode): ReactElement<{ href: string; onClick?: (event: { preventDefault: () => void; stopPropagation: () => void }) => void }> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findAnchor(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ href?: string; children?: ReactNode; onClick?: never }>;
  if (element.type === "a") return element as never;
  return findAnchor(element.props.children);
}

test("renderInline hands link clicks to onOpenLink instead of navigating", () => {
  const opened: string[] = [];
  const node = renderInline("go [docs](https://example.com/x)", "t", { onOpenLink: (url) => opened.push(url) });
  const anchor = findAnchor(node);
  assert.ok(anchor?.props.onClick);
  let prevented = 0;
  let stopped = 0;
  anchor?.props.onClick?.({ preventDefault: () => (prevented += 1), stopPropagation: () => (stopped += 1) });
  assert.deepEqual(opened, ["https://example.com/x"]);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.equal(findAnchor(renderInline("go [docs](https://example.com/x)", "t"))?.props.onClick, undefined);
});

test("InlineText renders the same inline markup inside a span", () => {
  const html = renderToStaticMarkup(createElement(InlineText, { text: "ship **now**" }) as never);
  assert.equal(html, '<span class="inline-md">ship <strong>now</strong></span>');
});
