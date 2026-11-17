import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HubOfflineBanner } from "./HubOfflineBanner";

const sidecar = vi.hoisted(() => ({ inTauri: vi.fn(() => false), restartHub: vi.fn<() => Promise<void>>() }));

vi.mock("../sidecar", () => sidecar);

beforeEach(() => {
  sidecar.inTauri.mockReturnValue(false);
  sidecar.restartHub.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test("announces the outage without a restart button in the browser", () => {
  render(<HubOfflineBanner />);
  expect(screen.getByRole("status").textContent).toContain("Hub offline - reconnecting...");
  expect(screen.queryByRole("button", { name: "Restart hub" })).toBeNull();
});

test("restarts the hub inside the desktop app and re-enables the button after the retry window", async () => {
  vi.useFakeTimers();
  sidecar.inTauri.mockReturnValue(true);
  sidecar.restartHub.mockResolvedValue(undefined);
  render(<HubOfflineBanner />);
  await act(async () => {
    screen.getByRole("button", { name: "Restart hub" }).click();
  });
  expect(sidecar.restartHub).toHaveBeenCalledTimes(1);
  const busy = screen.getByRole("button", { name: "Restarting..." }) as HTMLButtonElement;
  expect(busy.disabled).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000);
  });
  const again = screen.getByRole("button", { name: "Restart hub" }) as HTMLButtonElement;
  expect(again.disabled).toBe(false);
});

test("shows a string failure from the restart command", async () => {
  sidecar.inTauri.mockReturnValue(true);
  sidecar.restartHub.mockRejectedValue("sidecar missing");
  render(<HubOfflineBanner />);
  await userEvent.click(screen.getByRole("button", { name: "Restart hub" }));
  expect(await screen.findByText("sidecar missing")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Restart hub" }) as HTMLButtonElement).disabled).toBe(false);
});

test("shows an Error message and a generic fallback for other failures", async () => {
  sidecar.inTauri.mockReturnValue(true);
  sidecar.restartHub.mockRejectedValueOnce(new Error("spawn failed"));
  render(<HubOfflineBanner />);
  await userEvent.click(screen.getByRole("button", { name: "Restart hub" }));
  expect(await screen.findByText("spawn failed")).toBeTruthy();
  sidecar.restartHub.mockRejectedValueOnce(42);
  await userEvent.click(screen.getByRole("button", { name: "Restart hub" }));
  expect(await screen.findByText("could not restart the hub")).toBeTruthy();
});

test("clears the pending retry timer on unmount", async () => {
  vi.useFakeTimers();
  sidecar.inTauri.mockReturnValue(true);
  sidecar.restartHub.mockResolvedValue(undefined);
  const view = render(<HubOfflineBanner />);
  await act(async () => {
    screen.getByRole("button", { name: "Restart hub" }).click();
  });
  const clear = vi.spyOn(window, "clearTimeout");
  view.unmount();
  expect(clear).toHaveBeenCalled();
  clear.mockRestore();
});
