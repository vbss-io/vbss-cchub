import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import type { DesktopNotifyStatus } from "../../api";
import { NOTIF_EVENT_META } from "../../notifications";
import { NotificationsTab, NOTIF_CLIENTS, type NotifSettings } from "./NotificationsTab";

const mocks = vi.hoisted(() => ({
  getDesktopNotifyStatus: vi.fn<(force?: boolean) => Promise<unknown>>(),
  sendToast: vi.fn<(card: Record<string, unknown>) => Promise<void>>(),
  notify: vi.fn<(title: string, body: string) => Promise<string>>(),
  playSound: vi.fn<(kind: string) => Promise<void>>(),
}));

vi.mock("../../api", () => ({ getDesktopNotifyStatus: mocks.getDesktopNotifyStatus, sendToast: mocks.sendToast }));
vi.mock("../../notify", () => ({ notify: mocks.notify, playSound: mocks.playSound }));

const status = (overrides: Partial<DesktopNotifyStatus> = {}): DesktopNotifyStatus => ({ supported: true, appId: "io.vbss.cchub", toastsEnabled: true, appEnabled: true, registered: true, error: null, ...overrides });

const settings = (overrides: Partial<NotifSettings> = {}): NotifSettings => ({
  version: 1,
  enabled: true,
  desktop: true,
  sound: true,
  style: "cchub",
  events: Object.fromEntries(NOTIF_EVENT_META.map((meta) => [meta.kind, true])) as NotifSettings["events"],
  clients: Object.fromEntries(NOTIF_CLIENTS.map((client) => [client, client !== "claude-desktop"])) as NotifSettings["clients"],
  ...overrides,
});

beforeEach(() => {
  mocks.getDesktopNotifyStatus.mockReset().mockResolvedValue(status());
  mocks.sendToast.mockReset().mockResolvedValue(undefined);
  mocks.notify.mockReset().mockResolvedValue("hub");
  mocks.playSound.mockReset().mockResolvedValue(undefined);
});

const setup = (notif: NotifSettings = settings()) => {
  const onNotif = vi.fn();
  const view = render(<NotificationsTab notif={notif} onNotif={onNotif} />);
  return { onNotif, ...view };
};

test("the master switch and every channel checkbox report the new settings", async () => {
  const { onNotif } = setup();
  await userEvent.click(screen.getByRole("checkbox", { name: "Notifications on" }));
  expect(onNotif).toHaveBeenLastCalledWith({ ...settings(), enabled: false });
  await userEvent.click(screen.getByRole("checkbox", { name: "Desktop notification" }));
  expect(onNotif).toHaveBeenLastCalledWith({ ...settings(), desktop: false });
  await userEvent.click(screen.getByRole("checkbox", { name: "Sound" }));
  expect(onNotif).toHaveBeenLastCalledWith({ ...settings(), sound: false });
});

test("each notification style is selectable and the current one is checked", async () => {
  const { onNotif } = setup();
  const radios = screen.getAllByRole("radio") as HTMLInputElement[];
  expect(radios).toHaveLength(3);
  expect(radios.map((radio) => radio.checked)).toEqual([true, false, false]);
  await userEvent.click(radios[1] as HTMLInputElement);
  expect(onNotif).toHaveBeenLastCalledWith({ ...settings(), style: "windows" });
  await userEvent.click(radios[2] as HTMLInputElement);
  expect(onNotif).toHaveBeenLastCalledWith({ ...settings(), style: "both" });
});

test("styles and event toggles are locked while notifications are off", () => {
  setup(settings({ enabled: false }));
  for (const radio of screen.getAllByRole("radio")) expect((radio as HTMLInputElement).disabled).toBe(true);
  const eventBoxes = NOTIF_EVENT_META.map((meta) => screen.getByRole("checkbox", { name: meta.label }) as HTMLInputElement);
  expect(eventBoxes.every((box) => box.disabled)).toBe(true);
});

test("each event and each session source toggles on its own", async () => {
  const { onNotif } = setup();
  const first = NOTIF_EVENT_META[0];
  if (!first) throw new Error("no events");
  await userEvent.click(screen.getByRole("checkbox", { name: first.label }));
  expect(onNotif).toHaveBeenLastCalledWith({ ...settings(), events: { ...settings().events, [first.kind]: false } });
  const desktopBox = screen.getByRole("checkbox", { name: "Claude Desktop" }) as HTMLInputElement;
  expect(desktopBox.checked).toBe(false);
  await userEvent.click(desktopBox);
  expect(onNotif).toHaveBeenLastCalledWith({ ...settings(), clients: { ...settings().clients, "claude-desktop": true } });
});

test("the sound buttons play the matching sound", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "Test decision" }));
  await userEvent.click(screen.getByRole("button", { name: "Test idle" }));
  await userEvent.click(screen.getByRole("button", { name: "Test finish" }));
  expect(mocks.playSound.mock.calls.map((call) => call[0])).toEqual(["attention", "idle", "finished"]);
});

test("a test in the CC Hub style only sends the in-app toast", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "Send test notification" }));
  expect(mocks.sendToast).toHaveBeenCalledTimes(1);
  expect(mocks.sendToast.mock.calls[0]?.[0]).toMatchObject({ kind: "taskCompleted", title: "Test notification", body: "This is a CC Hub toast." });
  expect(mocks.notify).not.toHaveBeenCalled();
  expect(await screen.findByText("Sent to the CC Hub toast window (bottom-right).")).toBeTruthy();
});

test("a test in the Windows style goes through the hub and says where it was sent", async () => {
  setup(settings({ style: "windows" }));
  await userEvent.click(screen.getByRole("button", { name: "Send test notification" }));
  expect(mocks.sendToast).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledWith("VBSS CCHUB", expect.stringContaining("Test notification"));
  expect(mocks.getDesktopNotifyStatus).toHaveBeenLastCalledWith(true);
  expect(await screen.findByText(/Sent to Windows via the hub \(io\.vbss\.cchub\)\. It shows bottom-right unless Focus Assist is on\./)).toBeTruthy();
});

test("the both style sends the in-app toast and the Windows one, naming the desktop plugin when it was used", async () => {
  mocks.notify.mockResolvedValue("plugin");
  setup(settings({ style: "both" }));
  await userEvent.click(screen.getByRole("button", { name: "Send test notification" }));
  expect(mocks.sendToast).toHaveBeenCalledTimes(1);
  expect(mocks.notify).toHaveBeenCalledTimes(1);
  expect(await screen.findByText(/Sent to Windows via the desktop plugin\./)).toBeTruthy();
});

test("a test that no channel accepted reports the failure", async () => {
  mocks.notify.mockResolvedValue("none");
  setup(settings({ style: "windows" }));
  await userEvent.click(screen.getByRole("button", { name: "Send test notification" }));
  expect(await screen.findByText("Could not send: the hub did not accept the toast and the desktop plugin is not available.")).toBeTruthy();
});

test("a test that Windows will drop warns the user, using the fresh status", async () => {
  mocks.getDesktopNotifyStatus.mockResolvedValueOnce(status()).mockResolvedValueOnce(status({ toastsEnabled: false }));
  setup(settings({ style: "windows" }));
  await userEvent.click(screen.getByRole("button", { name: "Send test notification" }));
  expect(await screen.findByText(/but Windows is dropping notifications for this account or app/)).toBeTruthy();
  expect(screen.getByText(/Windows notifications are turned off for your account/)).toBeTruthy();
});

test("a failing status refresh after the test keeps the previous status", async () => {
  mocks.getDesktopNotifyStatus.mockResolvedValueOnce(status({ appEnabled: false })).mockRejectedValueOnce(new Error("down"));
  setup(settings({ style: "windows" }));
  expect(await screen.findByText(/Windows has notifications disabled for VBSS CCHUB/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Send test notification" }));
  expect(await screen.findByText(/Sent to Windows via the hub \(io\.vbss\.cchub\)/)).toBeTruthy();
  expect(screen.getByText(/Windows has notifications disabled for VBSS CCHUB/)).toBeTruthy();
});

test("the blocked-Windows warning only shows for Windows styles and supported hosts", async () => {
  mocks.getDesktopNotifyStatus.mockResolvedValue(status({ toastsEnabled: false }));
  const first = setup(settings({ style: "cchub" }));
  await vi.waitFor(() => expect(mocks.getDesktopNotifyStatus).toHaveBeenCalled());
  expect(screen.queryByText(/Windows notifications are turned off/)).toBeNull();
  first.unmount();
  mocks.getDesktopNotifyStatus.mockResolvedValue(status({ supported: false, toastsEnabled: false }));
  setup(settings({ style: "windows" }));
  await vi.waitFor(() => expect(mocks.getDesktopNotifyStatus).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(/Windows notifications are turned off/)).toBeNull();
});

test("an unreachable hub leaves the tab usable without a warning", async () => {
  mocks.getDesktopNotifyStatus.mockRejectedValue(new Error("down"));
  setup(settings({ style: "windows" }));
  await vi.waitFor(() => expect(mocks.getDesktopNotifyStatus).toHaveBeenCalled());
  expect(screen.queryByText(/Windows has notifications disabled/)).toBeNull();
  expect(screen.getByRole("button", { name: "Send test notification" })).toBeTruthy();
});
