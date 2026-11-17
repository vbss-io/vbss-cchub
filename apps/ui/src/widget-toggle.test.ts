import { beforeEach, expect, test, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  inTauri: vi.fn(() => true),
  getByLabel: vi.fn(),
  emit: vi.fn(async () => undefined),
}));

vi.mock("./sidecar", () => ({ inTauri: tauri.inTauri }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: { getByLabel: tauri.getByLabel } }));
vi.mock("@tauri-apps/api/event", () => ({ emit: tauri.emit }));

import { canToggleWidget, toggleWidgetWindow } from "./widget-toggle";

const widgetWindow = (visible: boolean) => ({ isVisible: vi.fn(async () => visible), hide: vi.fn(async () => undefined), show: vi.fn(async () => undefined) });

beforeEach(() => {
  tauri.getByLabel.mockReset();
  tauri.emit.mockClear();
});

test("canToggleWidget follows the desktop detection", () => {
  tauri.inTauri.mockReturnValueOnce(false);
  expect(canToggleWidget()).toBe(false);
  tauri.inTauri.mockReturnValueOnce(true);
  expect(canToggleWidget()).toBe(true);
});

test("hides a visible widget without announcing it", async () => {
  const win = widgetWindow(true);
  tauri.getByLabel.mockResolvedValue(win);
  await toggleWidgetWindow();
  expect(tauri.getByLabel).toHaveBeenCalledWith("widget");
  expect(win.hide).toHaveBeenCalledTimes(1);
  expect(win.show).not.toHaveBeenCalled();
  expect(tauri.emit).not.toHaveBeenCalled();
});

test("shows a hidden widget and emits widget:shown", async () => {
  const win = widgetWindow(false);
  tauri.getByLabel.mockResolvedValue(win);
  await toggleWidgetWindow();
  expect(win.show).toHaveBeenCalledTimes(1);
  expect(tauri.emit).toHaveBeenCalledWith("widget:shown");
});

test("rejects when the widget window does not exist", async () => {
  tauri.getByLabel.mockResolvedValue(null);
  await expect(toggleWidgetWindow()).rejects.toThrow("the widget window is not available");
});
