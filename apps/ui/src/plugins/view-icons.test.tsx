import { render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { START_DAY_EVENT } from "../today-model";
import { delegatedPlugin } from "./delegated";
import { flowPlugin } from "./flow";
import { limitsPlugin } from "./limits";
import { reportsPlugin } from "./reports";
import { sessionsPlugin } from "./sessions";
import { sharePlugin } from "./share";
import { tasksPlugin } from "./tasks";
import { todayPlugin } from "./today";
import { trailPlugin } from "./trail";
import { usagePlugin } from "./usage";
import { widgetPlugin } from "./widget";
import { workspacesPlugin } from "./workspaces";

const plugins = [sessionsPlugin, todayPlugin, tasksPlugin, flowPlugin, delegatedPlugin, usagePlugin, limitsPlugin, workspacesPlugin, reportsPlugin, sharePlugin, trailPlugin, widgetPlugin];

test("every plugin view renders an svg icon and has a label and subtitle", () => {
  const views = plugins.flatMap((plugin) => plugin.views);
  expect(views.length).toBeGreaterThanOrEqual(9);
  for (const view of views) {
    const { container, unmount } = render(<>{view.icon}</>);
    expect(container.querySelector("svg"), view.key).not.toBeNull();
    expect(view.label.length).toBeGreaterThan(0);
    expect(view.subtitle.length).toBeGreaterThan(0);
    unmount();
  }
});

test("the Today plugin icon is a calendar with a tick", () => {
  const view = todayPlugin.views[0];
  const { container } = render(<>{view?.icon}</>);
  const svg = container.querySelector("svg");
  expect(svg?.getAttribute("width")).toBe("20");
  expect(svg?.querySelectorAll("path")).toHaveLength(2);
  expect(svg?.querySelector("rect")?.getAttribute("rx")).toBe("2");
});

test("the Today palette commands dispatch the daily view events and start a capture", () => {
  const dispatch = vi.fn();
  const startCapture = vi.fn();
  const commands = todayPlugin.paletteCommands?.({ dispatch, startCapture, toggleWidget: null, openDelegated: vi.fn() });
  expect(commands).toBeDefined();
  commands?.startDay?.();
  commands?.planToday?.();
  commands?.refreshDaily?.();
  commands?.startCapture?.();
  expect(dispatch.mock.calls).toEqual([
    ["daily", START_DAY_EVENT],
    ["daily", "cchub:daily-plan-today"],
    ["daily", "cchub:daily-refresh"],
  ]);
  expect(startCapture).toHaveBeenCalledTimes(1);
});
