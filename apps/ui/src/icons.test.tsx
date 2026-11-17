import { render } from "@testing-library/react";
import type { ComponentType } from "react";
import { expect, test } from "vitest";
import * as icons from "./icons";

type IconComponent = ComponentType<{ size?: number; filled?: boolean }>;

const entries: [string, IconComponent][] = Object.entries(icons as Record<string, unknown>).flatMap(([name, value]) => (typeof value === "function" ? [[name, value as IconComponent] as [string, IconComponent]] : []));

const svgOf = (Icon: IconComponent, props: { size?: number; filled?: boolean } = {}): SVGSVGElement => {
  const { container } = render(<Icon {...props} />);
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("icon did not render an svg");
  return svg;
};

test("the module exports the full icon set", () => {
  expect(entries.map(([name]) => name)).toEqual(
    expect.arrayContaining([
      "IconSessions",
      "IconUsage",
      "IconFlow",
      "IconTasks",
      "IconBoard",
      "IconWorkspaces",
      "IconReports",
      "IconSettings",
      "IconClose",
      "IconStar",
      "IconFocus",
      "IconSearch",
      "IconTerminal",
      "IconCode",
      "IconDesktop",
      "IconHub",
      "IconCodex",
      "IconChevron",
      "IconShare",
      "IconCopy",
      "IconExpand",
      "IconClaude",
      "IconOpenAI",
      "IconEdit",
      "IconCalendarPlus",
      "IconRepeat",
      "IconRun",
      "IconDetails",
      "IconMore",
      "IconSidebar",
    ]),
  );
  expect(entries.length).toBe(30);
});

test.each(entries)("%s renders a decorative 24x24 stroke svg with drawn shapes", (_name, Icon) => {
  const svg = svgOf(Icon);
  expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
  expect(svg.getAttribute("aria-hidden")).toBe("true");
  expect(svg.getAttribute("stroke")).toBe("currentColor");
  expect(svg.getAttribute("width")).toBe(svg.getAttribute("height"));
  expect(Number(svg.getAttribute("width"))).toBeGreaterThan(0);
  expect(svg.querySelectorAll("path, rect, circle, line, polyline").length).toBeGreaterThan(0);
});

test.each(entries)("%s honours a custom size", (_name, Icon) => {
  const svg = svgOf(Icon, { size: 33 });
  expect(svg.getAttribute("width")).toBe("33");
  expect(svg.getAttribute("height")).toBe("33");
});

test("default sizes follow the icon family: nav icons 20, controls 14 to 18", () => {
  expect(svgOf(icons.IconSessions).getAttribute("width")).toBe("20");
  expect(svgOf(icons.IconShare).getAttribute("width")).toBe("20");
  expect(svgOf(icons.IconClose).getAttribute("width")).toBe("18");
  expect(svgOf(icons.IconSidebar).getAttribute("width")).toBe("18");
  expect(svgOf(icons.IconStar).getAttribute("width")).toBe("16");
  expect(svgOf(icons.IconSearch).getAttribute("width")).toBe("16");
  expect(svgOf(icons.IconTerminal).getAttribute("width")).toBe("14");
  expect(svgOf(icons.IconRepeat).getAttribute("width")).toBe("12");
});

test("IconStar fills with the current colour only when filled", () => {
  expect(svgOf(icons.IconStar).getAttribute("fill")).toBe("none");
  expect(svgOf(icons.IconStar, { filled: true }).getAttribute("fill")).toBe("currentColor");
});

test("the Claude mark draws ten rays and the OpenAI mark six rotated arms", () => {
  expect(svgOf(icons.IconClaude).querySelectorAll("path")).toHaveLength(10);
  const arms = [...svgOf(icons.IconOpenAI).querySelectorAll("path")].map((path) => path.getAttribute("transform"));
  expect(arms).toEqual(["rotate(0 12 12)", "rotate(60 12 12)", "rotate(120 12 12)", "rotate(180 12 12)", "rotate(240 12 12)", "rotate(300 12 12)"]);
});
