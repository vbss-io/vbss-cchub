import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { InlineText, Markdown, renderInline } from "./markdown";

const openExternal = vi.fn(async (_url: string) => undefined);

vi.mock("./notify", () => ({ openExternal: (url: string) => openExternal(url) }));

beforeEach(() => {
  openExternal.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const html = (node: ReturnType<typeof Markdown>): HTMLElement => render(<>{node}</>).container;

test("InlineText opens safe links through the shell and stops the click", async () => {
  render(<InlineText text="see [docs](https://example.com/a) now" />);
  const link = screen.getByRole("link", { name: "docs" });
  expect(link.getAttribute("href")).toBe("https://example.com/a");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  await userEvent.click(link);
  expect(openExternal).toHaveBeenCalledWith("https://example.com/a");
});

test("InlineText survives a failing external open", async () => {
  openExternal.mockRejectedValueOnce(new Error("no shell"));
  render(<InlineText text="[x](https://example.com)" />);
  await userEvent.click(screen.getByRole("link", { name: "x" }));
  expect(openExternal).toHaveBeenCalledTimes(1);
});

test("renderInline leaves a link without a handler to the browser and keeps unsafe URLs as text", async () => {
  const { container } = render(<p>{renderInline("[a](https://a.dev) and [b](javascript:alert(1)) and [[folder/Note.md]] and [[x|Shown]]", "k")}</p>);
  const anchors = container.querySelectorAll("a");
  expect(anchors).toHaveLength(1);
  await userEvent.click(anchors[0] as Element);
  expect(openExternal).not.toHaveBeenCalled();
  expect(container.textContent).toContain("[b](javascript:alert(1))");
  const wikilinks = [...container.querySelectorAll(".md__wikilink")].map((node) => node.textContent);
  expect(wikilinks).toEqual(["Note", "Shown"]);
});

test("renderInline handles code, bold, italic, bold italic and strikethrough, including nesting", () => {
  const { container } = render(<p>{renderInline("`c` **b** __b2__ *i* _i2_ ***bi*** ~~gone~~", "k")}</p>);
  expect([...container.querySelectorAll("code")].map((node) => node.textContent)).toEqual(["c"]);
  expect([...container.querySelectorAll("strong")].map((node) => node.textContent)).toEqual(["b", "b2", "bi"]);
  expect([...container.querySelectorAll("em")].map((node) => node.textContent)).toEqual(["i", "i2", "bi"]);
  expect(container.querySelector("del")?.textContent).toBe("gone");
});

test("a fenced block renders as code with a copy button that writes to the clipboard", async () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const container = html(Markdown({ text: "```ts\nconst a = 1;\nconst b = 2;\n```\nafter" }));
  expect(container.querySelector("pre code")?.textContent).toBe("const a = 1;\nconst b = 2;");
  await userEvent.click(screen.getByRole("button", { name: "copy" }));
  expect(writeText).toHaveBeenCalledWith("const a = 1;\nconst b = 2;");
  expect(container.querySelector("p")?.textContent).toBe("after");
});

test("copy tolerates a rejected clipboard write and a missing clipboard", async () => {
  const writeText = vi.fn(() => Promise.reject(new Error("denied")));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  html(Markdown({ text: "```\nx\n```" }));
  await userEvent.click(screen.getByRole("button", { name: "copy" }));
  expect(writeText).toHaveBeenCalledTimes(1);
  vi.stubGlobal("navigator", {});
  await userEvent.click(screen.getByRole("button", { name: "copy" }));
  expect(writeText).toHaveBeenCalledTimes(1);
});

test("headings, rules, quotes and paragraphs render as their block elements", () => {
  const container = html(
    Markdown({ text: "# One\n\n###### Six\n\n---\n\n> quoted **bold**\n> second\n\nline a\nline b\n\n```\nunterminated" }),
  );
  expect(container.querySelector("h1")?.textContent).toBe("One");
  expect(container.querySelector("h6")?.textContent).toBe("Six");
  expect(container.querySelector("hr")).not.toBeNull();
  const quote = container.querySelector("blockquote");
  expect(quote?.querySelector("strong")?.textContent).toBe("bold");
  expect(quote?.textContent).toContain("second");
  expect(container.querySelector(".md > p")?.textContent).toBe("line a line b");
  expect(container.querySelector("pre code")?.textContent).toBe("unterminated");
});

test("bullet and numbered lists render nested items, tabs and loose spacing", () => {
  const container = html(Markdown({ text: "- a\n  - nested\n\n- b\n\t- tab nested\n\n1. first\n2. second\n\n* star" }));
  const lists = container.querySelectorAll("ul");
  expect(lists.length).toBeGreaterThanOrEqual(3);
  expect(container.querySelector("ol")?.querySelectorAll("li")).toHaveLength(2);
  expect(container.querySelector("li.md__item--loose")?.textContent).toContain("b");
  expect(container.textContent).toContain("nested");
  expect(container.textContent).toContain("tab nested");
});

test("task items expose their state and toggle through the callback with the source line number", async () => {
  const onToggleTask = vi.fn();
  const container = html(Markdown({ text: "intro\n- [ ] open\n- [x] finished\n- [-] working", onToggleTask }));
  const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
  expect(boxes.map((box) => box.checked)).toEqual([false, true, false]);
  expect(boxes[2]?.indeterminate).toBe(true);
  expect(boxes[2]?.title).toBe("In progress");
  expect(boxes[0]?.indeterminate).toBe(false);
  expect(container.querySelector(".md__task--doing")).not.toBeNull();
  await userEvent.click(boxes[0] as Element);
  expect(onToggleTask).toHaveBeenCalledWith(1, true);
  await userEvent.click(boxes[1] as Element);
  expect(onToggleTask).toHaveBeenCalledWith(2, false);
});

test("task checkboxes are disabled without a toggle callback", () => {
  html(Markdown({ text: "- [ ] only" }));
  expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
});

test("the open and done filters hide the other tasks but keep a parent that has a visible child", () => {
  const text = "- [x] done parent\n  - [ ] open child\n- [ ] open item\n- plain bullet\n- [x] done item";
  const open = html(Markdown({ text, taskFilter: "open" }));
  const openLabels = [...open.querySelectorAll("li")].map((li) => li.querySelector("span")?.textContent ?? li.textContent);
  expect(openLabels).toContain("open item");
  expect(open.textContent).not.toContain("done item");
  expect(open.querySelector(".md__item--context")).not.toBeNull();
  expect(open.textContent).toContain("plain bullet");
});

test("the done filter keeps only completed tasks", () => {
  const container = html(Markdown({ text: "- [x] done item\n- [ ] open item", taskFilter: "done" }));
  expect(container.textContent).toContain("done item");
  expect(container.textContent).not.toContain("open item");
});

test("a list with no matching task renders nothing", () => {
  const container = html(Markdown({ text: "- [ ] open one\n- [ ] open two", taskFilter: "done" }));
  expect(container.querySelector("ul")).toBeNull();
});

test("frontmatter is hidden, shown as a chip, or left in the text", () => {
  const text = "---\ntype: diario\nowner: vitor\nempty:\n---\n# Body";
  const hidden = html(Markdown({ text, frontmatter: "hidden" }));
  expect(hidden.querySelector(".md__frontmatter")).toBeNull();
  expect(hidden.querySelector("h1")?.textContent).toBe("Body");
  const chip = html(Markdown({ text, frontmatter: "chip" }));
  expect(chip.querySelector(".md__frontmatter")?.textContent).toBe("diario · vitor");
  const none = html(Markdown({ text: "plain", frontmatter: "chip" }));
  expect(none.querySelector(".md__frontmatter")).toBeNull();
  expect(none.querySelector("p")?.textContent).toBe("plain");
});

test("task line numbers account for the frontmatter offset", async () => {
  const onToggleTask = vi.fn();
  html(Markdown({ text: "---\na: 1\n---\n- [ ] first", frontmatter: "hidden", onToggleTask }));
  await userEvent.click(screen.getByRole("checkbox"));
  expect(onToggleTask).toHaveBeenCalledWith(3, true);
});
