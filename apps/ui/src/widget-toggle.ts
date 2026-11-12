import { inTauri } from "./sidecar";

export const canToggleWidget = (): boolean => inTauri();

export async function toggleWidgetWindow(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const widget = await WebviewWindow.getByLabel("widget");
  if (!widget) throw new Error("the widget window is not available");
  if (await widget.isVisible()) await widget.hide();
  else await widget.show();
}
