import { afterEach, beforeEach, expect, test, vi } from "vitest";

const apiMock = vi.hoisted(() => ({ sendDesktopNotification: vi.fn() }));
const shellMock = vi.hoisted(() => ({ open: vi.fn(async () => undefined) }));
const pluginMock = vi.hoisted(() => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }));

vi.mock("./api", () => apiMock);
vi.mock("@tauri-apps/plugin-shell", () => shellMock);
vi.mock("@tauri-apps/plugin-notification", () => pluginMock);

type Notify = typeof import("./notify");

const load = async (): Promise<Notify> => {
  vi.resetModules();
  return import("./notify");
};

const setTauri = (on: boolean) => {
  const target = window as unknown as Record<string, unknown>;
  if (on) target.__TAURI_INTERNALS__ = {};
  else delete target.__TAURI_INTERNALS__;
};

interface FakeNode {
  connect: ReturnType<typeof vi.fn>;
  start?: ReturnType<typeof vi.fn>;
  stop?: ReturnType<typeof vi.fn>;
  type?: string;
  frequency?: { value: number };
  gain?: { setValueAtTime: ReturnType<typeof vi.fn>; exponentialRampToValueAtTime: ReturnType<typeof vi.fn> };
}

const makeContext = (state: "running" | "suspended") => {
  const oscillators: FakeNode[] = [];
  const context = {
    state,
    currentTime: 1,
    destination: {},
    resume: vi.fn(async () => {
      context.state = "running";
    }),
    createOscillator: vi.fn(() => {
      const node: FakeNode = { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), frequency: { value: 0 }, type: "sine" };
      oscillators.push(node);
      return node;
    }),
    createGain: vi.fn(() => ({
      connect: vi.fn(),
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    })),
  };
  return { context, oscillators };
};

const installAudio = (state: "running" | "suspended") => {
  const made = makeContext(state);
  const Ctor = vi.fn(function () {
    return made.context;
  });
  (window as unknown as { AudioContext: unknown }).AudioContext = Ctor;
  return { ...made, Ctor };
};

beforeEach(() => {
  apiMock.sendDesktopNotification.mockReset();
  shellMock.open.mockClear();
  pluginMock.isPermissionGranted.mockReset();
  pluginMock.requestPermission.mockReset();
  pluginMock.sendNotification.mockReset();
  setTauri(false);
});

afterEach(() => {
  setTauri(false);
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  vi.restoreAllMocks();
});

test("openExternal opens a new window in the browser", async () => {
  const { openExternal } = await load();
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await openExternal("https://example.com/a");
  expect(open).toHaveBeenCalledWith("https://example.com/a", "_blank", "noopener");
  expect(shellMock.open).not.toHaveBeenCalled();
});

test("openExternal delegates to the shell plugin inside the desktop app", async () => {
  setTauri(true);
  const { openExternal } = await load();
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await openExternal("https://example.com/b");
  expect(shellMock.open).toHaveBeenCalledWith("https://example.com/b");
  expect(open).not.toHaveBeenCalled();
});

test("notify reports hub when the hub delivered the notification", async () => {
  const { notify } = await load();
  apiMock.sendDesktopNotification.mockResolvedValue({ ok: true });
  expect(await notify("t", "b")).toBe("hub");
  expect(apiMock.sendDesktopNotification).toHaveBeenCalledWith("t", "b");
});

test("notify returns none outside the desktop app when the hub cannot deliver", async () => {
  const { notify } = await load();
  apiMock.sendDesktopNotification.mockResolvedValueOnce({ ok: false });
  expect(await notify("t", "b")).toBe("none");
  apiMock.sendDesktopNotification.mockRejectedValueOnce(new Error("offline"));
  expect(await notify("t", "b")).toBe("none");
  expect(pluginMock.sendNotification).not.toHaveBeenCalled();
});

test("notify falls back to the plugin when permission is already granted", async () => {
  setTauri(true);
  const { notify } = await load();
  apiMock.sendDesktopNotification.mockRejectedValue(new Error("offline"));
  pluginMock.isPermissionGranted.mockResolvedValue(true);
  expect(await notify("title", "body")).toBe("plugin");
  expect(pluginMock.requestPermission).not.toHaveBeenCalled();
  expect(pluginMock.sendNotification).toHaveBeenCalledWith({ title: "title", body: "body" });
});

test("notify asks for permission and sends only when granted", async () => {
  setTauri(true);
  const { notify } = await load();
  apiMock.sendDesktopNotification.mockResolvedValue({ ok: false });
  pluginMock.isPermissionGranted.mockResolvedValue(false);
  pluginMock.requestPermission.mockResolvedValueOnce("granted");
  expect(await notify("a", "b")).toBe("plugin");
  pluginMock.requestPermission.mockResolvedValueOnce("denied");
  expect(await notify("a", "b")).toBe("none");
  expect(pluginMock.sendNotification).toHaveBeenCalledTimes(1);
});

test("notify returns none when the plugin throws", async () => {
  setTauri(true);
  const { notify } = await load();
  apiMock.sendDesktopNotification.mockResolvedValue({ ok: false });
  pluginMock.isPermissionGranted.mockRejectedValue(new Error("plugin missing"));
  expect(await notify("a", "b")).toBe("none");
});

test("playSound does nothing when the browser has no audio support", async () => {
  const { playSound, unlockAudio } = await load();
  await expect(playSound("attention")).resolves.toBeUndefined();
  expect(() => unlockAudio()).not.toThrow();
});

test("playSound uses the webkit constructor when the standard one is missing", async () => {
  const made = makeContext("running");
  const Ctor = vi.fn(function () {
    return made.context;
  });
  (window as unknown as { webkitAudioContext: unknown }).webkitAudioContext = Ctor;
  const { playSound } = await load();
  await playSound("idle");
  expect(Ctor).toHaveBeenCalledTimes(1);
  expect(made.oscillators).toHaveLength(2);
  delete (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
});

test("each sound kind plays its own tone pattern on a shared context", async () => {
  const audio = installAudio("running");
  const { playSound } = await load();
  await playSound("attention");
  expect(audio.oscillators.map((node) => node.frequency?.value)).toEqual([784, 988]);
  expect(audio.oscillators.every((node) => node.type === "sine")).toBe(true);
  audio.oscillators.length = 0;
  await playSound("idle");
  expect(audio.oscillators.map((node) => node.frequency?.value)).toEqual([620, 466]);
  audio.oscillators.length = 0;
  await playSound("finished");
  expect(audio.oscillators.map((node) => node.frequency?.value)).toEqual([880, 660, 440]);
  expect(audio.oscillators.every((node) => node.type === "triangle")).toBe(true);
  expect(audio.Ctor).toHaveBeenCalledTimes(1);
  expect(audio.oscillators[0]?.start).toHaveBeenCalled();
  expect(audio.oscillators[0]?.stop).toHaveBeenCalled();
});

test("a suspended context is resumed before playing and by unlockAudio", async () => {
  const audio = installAudio("suspended");
  const { playSound, unlockAudio } = await load();
  await playSound("attention");
  expect(audio.context.resume).toHaveBeenCalled();
  expect(audio.oscillators).toHaveLength(2);
  audio.context.state = "suspended";
  audio.context.resume.mockClear();
  unlockAudio();
  expect(audio.context.resume).toHaveBeenCalled();
});

test("playSound still plays when resuming the context fails", async () => {
  const audio = installAudio("suspended");
  audio.context.resume.mockResolvedValueOnce(undefined);
  audio.context.resume.mockRejectedValue(new Error("blocked"));
  const { playSound } = await load();
  await playSound("idle");
  expect(audio.oscillators).toHaveLength(2);
});
