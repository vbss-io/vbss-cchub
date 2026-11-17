import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { BrandMark, Wordmark } from "./BrandMark";

test("BrandMark renders a decorative svg at the requested size", () => {
  const { container } = render(<BrandMark size={40} />);
  const svg = container.querySelector("svg");
  expect(svg?.getAttribute("width")).toBe("40");
  expect(svg?.getAttribute("height")).toBe("40");
  expect(svg?.getAttribute("aria-hidden")).toBe("true");
});

test("BrandMark defaults to 24px", () => {
  const { container } = render(<BrandMark />);
  expect(container.querySelector("svg")?.getAttribute("width")).toBe("24");
});

test("Wordmark spells the product name with the split V", () => {
  const { container } = render(<Wordmark />);
  expect(container.querySelector(".vsplit")?.textContent).toBe("V");
  expect(container.textContent).toBe("VBSS CCHUB");
});
