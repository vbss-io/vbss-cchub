import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Highlighted } from "./Highlighted";

const parts = (container: HTMLElement): { text: string; hit: boolean }[] =>
  [...container.childNodes].map((node) => ({ text: node.textContent ?? "", hit: node instanceof HTMLElement && node.tagName === "MARK" }));

test("wraps each range in a mark and leaves the rest as plain text", () => {
  const { container } = render(<Highlighted text="the quick brown fox" ranges={[[4, 9], [16, 19]]} />);
  expect(parts(container)).toEqual([
    { text: "the ", hit: false },
    { text: "quick", hit: true },
    { text: " brown ", hit: false },
    { text: "fox", hit: true },
  ]);
  expect(container.querySelector("mark")?.className).toBe("hl");
});

test("overlapping and out-of-bounds ranges are merged and clamped", () => {
  const { container } = render(<Highlighted text="abcdef" ranges={[[1, 3], [2, 5], [4, 99]]} />);
  expect(parts(container)).toEqual([
    { text: "a", hit: false },
    { text: "bcdef", hit: true },
  ]);
});

test("no ranges renders the text untouched", () => {
  const { container } = render(<Highlighted text="plain text" ranges={[]} />);
  expect(container.querySelector("mark")).toBeNull();
  expect(container.textContent).toBe("plain text");
});

test("empty ranges are ignored", () => {
  const { container } = render(<Highlighted text="abc" ranges={[[2, 2]]} />);
  expect(container.querySelector("mark")).toBeNull();
  expect(container.textContent).toBe("abc");
});
