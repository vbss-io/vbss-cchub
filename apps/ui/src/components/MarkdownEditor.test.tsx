import { fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { fillHeight, MarkdownEditor } from "./MarkdownEditor";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  callback: () => void;

  constructor(callback: () => void) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.push(element);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeResizeObserver.instances.length = 0;
  document.body.innerHTML = "";
});

test("renders the text in an input over a highlighted mirror of the same text", () => {
  const { container } = render(<MarkdownEditor value={"# Title\n- [ ] task **bold**"} onChange={() => undefined} />);
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe("# Title\n- [ ] task **bold**");
  expect(textarea.getAttribute("spellcheck")).toBe("false");
  expect(textarea.className).toContain("mde__input");
  const pre = container.querySelector("pre.mde__pre") as HTMLElement;
  expect(pre.getAttribute("aria-hidden")).toBe("true");
  expect(pre.querySelector(".mde__heading")?.textContent).toBe("# Title");
  expect(pre.querySelector(".mde__task-open")?.textContent).toBe("[ ]");
  expect(pre.querySelector(".mde__bold")?.textContent).toBe("**bold**");
  expect(pre.textContent).toBe("# Title\n- [ ] task **bold**\n");
});

test("carriage returns are not shown in the mirror and lines stay aligned", () => {
  const { container } = render(<MarkdownEditor value={"a\r\nb\rc"} onChange={() => undefined} />);
  expect((container.querySelector("pre") as HTMLElement).textContent).toBe("a\nb\nc\n");
});

test("front matter, quotes and fenced code get their own token classes", () => {
  const { container } = render(<MarkdownEditor value={"---\ntype: x\n---\n> quote\n```\ncode\n```"} onChange={() => undefined} />);
  const pre = container.querySelector("pre") as HTMLElement;
  expect(pre.querySelectorAll(".mde__frontmatter")).toHaveLength(3);
  expect(pre.querySelector(".mde__quote")?.textContent).toBe("> quote");
  expect(pre.querySelectorAll(".mde__fence")).toHaveLength(2);
  expect(pre.querySelector(".mde__code")?.textContent).toBe("code");
});

test("extra props, the class name and the ref reach the textarea and typing reports changes", async () => {
  const ref = createRef<HTMLTextAreaElement>();
  const onChange = vi.fn();
  const { container } = render(<MarkdownEditor ref={ref} value="" className="extra" placeholder="Write" aria-label="Note" onChange={onChange} />);
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  expect(ref.current).toBe(textarea);
  expect(textarea.className).toBe("mde__input extra");
  expect(textarea.placeholder).toBe("Write");
  expect(textarea.getAttribute("aria-label")).toBe("Note");
  await userEvent.type(textarea, "a");
  expect(onChange).toHaveBeenCalledTimes(1);
});

test("without fill the frame has no fill class and no sizing", () => {
  const { container } = render(<MarkdownEditor value="x" onChange={() => undefined} />);
  const frame = container.querySelector(".mde") as HTMLElement;
  expect(frame.className.trim()).toBe("mde");
  expect(frame.style.height).toBe("");
});

test("fill sizes the frame to the viewport, follows resizes and disconnects on unmount", () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 100, toJSON: () => ({}) });
  const { container, unmount } = render(<MarkdownEditor value="x" fill onChange={() => undefined} />);
  const frame = container.querySelector(".mde") as HTMLElement;
  expect(frame.className).toContain("mde--fill");
  expect(frame.style.height).toBe("792px");
  expect(FakeResizeObserver.instances[0]?.observed).toEqual([document.body]);
  Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
  fireEvent(window, new Event("resize"));
  expect(frame.style.height).toBe("592px");
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  FakeResizeObserver.instances[0]?.callback();
  expect(frame.style.height).toBe("692px");
  unmount();
  expect(FakeResizeObserver.instances[0]?.disconnected).toBe(true);
  Object.defineProperty(window, "innerHeight", { value: 300, configurable: true });
  fireEvent(window, new Event("resize"));
  expect(frame.style.height).toBe("692px");
});

test("turning fill off after it was on stops resizing", () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const { rerender } = render(<MarkdownEditor value="x" fill onChange={() => undefined} />);
  rerender(<MarkdownEditor value="x" onChange={() => undefined} />);
  expect(FakeResizeObserver.instances[0]?.disconnected).toBe(true);
});

const layout = (): { frame: HTMLElement; main: HTMLElement; sibling: HTMLElement } => {
  document.body.innerHTML = `<div class="statusbar"></div><div class="outer"><div class="main"><div class="card"><div class="frame"></div><div class="below"></div><div class="hiddenbelow" hidden></div></div></div></div>`;
  const frame = document.querySelector(".frame") as HTMLElement;
  const main = document.querySelector(".main") as HTMLElement;
  const sibling = document.querySelector(".below") as HTMLElement;
  return { frame, main, sibling };
};

test("fillHeight subtracts the padding and borders of its ancestors up to .main, the siblings below and a small allowance", () => {
  const { frame, main, sibling } = layout();
  Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true });
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ top: 200 } as DOMRect);
  main.style.paddingBottom = "20px";
  main.style.borderBottomWidth = "2px";
  main.style.borderBottomStyle = "solid";
  (frame.parentElement as HTMLElement).style.paddingBottom = "10px";
  (frame.parentElement as HTMLElement).style.rowGap = "6px";
  (document.querySelector(".outer") as HTMLElement).style.paddingBottom = "500px";
  Object.defineProperty(sibling, "offsetHeight", { value: 40, configurable: true });
  Object.defineProperty(document.querySelector(".hiddenbelow"), "offsetHeight", { value: 999, configurable: true });
  expect(fillHeight(frame)).toBe(1000 - 200 - (10 + 20 + 2) - (40 + 6) - 8);
});

test("fillHeight also leaves room for a sticky status bar and never goes below the minimum", () => {
  const { frame } = layout();
  Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
  const bar = document.querySelector(".statusbar") as HTMLElement;
  bar.style.position = "sticky";
  Object.defineProperty(bar, "offsetHeight", { value: 30, configurable: true });
  expect(fillHeight(frame)).toBe(600 - 100 - 30 - 8);
  bar.style.position = "static";
  expect(fillHeight(frame)).toBe(492);
  Object.defineProperty(window, "innerHeight", { value: 200, configurable: true });
  expect(fillHeight(frame)).toBe(320);
});

test("fillHeight works for a frame without a parent and without a status bar", () => {
  const frame = document.createElement("div");
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  expect(fillHeight(frame)).toBe(792);
});
