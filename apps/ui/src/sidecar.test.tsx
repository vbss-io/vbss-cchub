import { afterEach, expect, test, vi } from "vitest";
import { inTauri, restartHub } from "./sidecar";

const invoke = vi.fn(async (_command: string) => undefined);

vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string) => invoke(command) }));

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  invoke.mockClear();
});

test("inTauri is true only when the Tauri internals are present", () => {
  expect(inTauri()).toBe(false);
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  expect(inTauri()).toBe(true);
});

test("restartHub asks the desktop shell to restart the sidecar", async () => {
  await restartHub();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("restart_sidecar");
});
