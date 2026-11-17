import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HubEvents } from "../../api";
import type { TrailStatus } from "../../delegation";
import { fullSettings } from "../../test-support/u5-fixtures";
import { TrailTab } from "./TrailTab";

const api = vi.hoisted(() => ({
  getTrail: vi.fn<() => Promise<unknown>>(),
  flushTrail: vi.fn<() => Promise<unknown>>(),
  subscribe: vi.fn<(handlers: unknown) => () => void>(),
}));

vi.mock("../../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../delegation")>()), getTrail: api.getTrail, flushTrail: api.flushTrail }));
vi.mock("../../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../api")>()), subscribe: api.subscribe }));

const status = (overrides: Partial<TrailStatus> = {}): TrailStatus => ({
  enabled: true,
  dir: "trail",
  detail: "medium",
  model: null,
  hubEvents: true,
  today: { path: "trail/2026-11-16.md", exists: true, sessions: 3, hubLines: 7 },
  queue: 2,
  running: null,
  lastError: null,
  ...overrides,
});

let handlers: HubEvents | null = null;
const unsubscribe = vi.fn();

beforeEach(() => {
  handlers = null;
  unsubscribe.mockReset();
  api.getTrail.mockReset().mockResolvedValue(status());
  api.flushTrail.mockReset().mockResolvedValue({ scheduled: 1 });
  api.subscribe.mockReset().mockImplementation((value) => {
    handlers = value as HubEvents;
    return unsubscribe;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const setup = (props: Partial<Parameters<typeof TrailTab>[0]> = {}) => {
  const onSaveSettings = vi.fn(async () => undefined);
  const view = render(<TrailTab enabled settings={fullSettings()} onSaveSettings={onSaveSettings} {...props} />);
  return { onSaveSettings, ...view };
};

const save = (): HTMLButtonElement => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const change = (element: HTMLElement, value: string): void => void fireEvent.change(element, { target: { value } });

test("shows the status line, the saved detail level and the folder", async () => {
  setup();
  expect(await screen.findByText("Today: 3 sessions · 7 hub lines · queue 2")).toBeTruthy();
  expect((screen.getByRole("radio", { name: /Medium/ }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByPlaceholderText("D:/vault/trail") as HTMLInputElement).value).toBe("trail");
  expect(save().disabled).toBe(true);
});

test("a running summary and the last error appear in the status line", async () => {
  api.getTrail.mockResolvedValue(status({ running: { sessionId: "abcdef1234567", since: 1 }, lastError: "model failed" }));
  setup();
  expect(await screen.findByText("Summarizing abcdef12…")).toBeTruthy();
  expect(screen.getByText("model failed")).toBeTruthy();
});

test("while the status is unavailable the line says so", async () => {
  api.getTrail.mockRejectedValue(new Error("down"));
  setup();
  expect(await screen.findByText("Status unavailable")).toBeTruthy();
});

test("without settings the form uses the light defaults", () => {
  setup({ settings: null });
  expect((screen.getByRole("radio", { name: /Light/ }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByPlaceholderText("<second brain>/trail")).toBeTruthy();
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
});

test("editing and saving sends the trail block with trimmed values", async () => {
  const { onSaveSettings } = setup();
  change(screen.getByPlaceholderText("D:/vault/trail"), " notes/trail ");
  await userEvent.click(screen.getByRole("radio", { name: /High/ }));
  change(screen.getByPlaceholderText("haiku"), " sonnet ");
  change(document.querySelector("textarea") as HTMLTextAreaElement, "Summarize");
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(save());
  expect(onSaveSettings).toHaveBeenCalledWith({ trail: { dir: "notes/trail", detail: "high", model: "sonnet", prompt: "Summarize", hubEvents: false } });
});

test("empty fields save as null", async () => {
  const { onSaveSettings } = setup();
  change(screen.getByPlaceholderText("D:/vault/trail"), "");
  await userEvent.click(screen.getByRole("radio", { name: /Light/ }));
  await userEvent.click(save());
  expect(onSaveSettings).toHaveBeenCalledWith({ trail: { dir: null, detail: "light", model: null, prompt: null, hubEvents: true } });
});

test("every field marks the form dirty and reverting it marks it clean", async () => {
  setup();
  const checks: [HTMLElement, string, string][] = [
    [screen.getByPlaceholderText("D:/vault/trail"), "x", "trail"],
    [screen.getByPlaceholderText("haiku"), "x", ""],
    [document.querySelector("textarea") as HTMLTextAreaElement, "x", ""],
  ];
  for (const [element, value, original] of checks) {
    change(element, value);
    expect(save().disabled).toBe(false);
    change(element, original);
    expect(save().disabled).toBe(true);
  }
  await userEvent.click(screen.getByRole("radio", { name: /High/ }));
  expect(save().disabled).toBe(false);
  await userEvent.click(screen.getByRole("radio", { name: /Medium/ }));
  await userEvent.click(screen.getByRole("checkbox"));
  expect(save().disabled).toBe(false);
});

test("Reset to default clears the prompt override and saves null for it only", async () => {
  const { onSaveSettings } = setup({ settings: fullSettings({ trail: { ...fullSettings().trail, prompt: "custom" } }) });
  expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("custom");
  await userEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  expect(onSaveSettings).toHaveBeenCalledWith({ trail: { prompt: null } });
  expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
});

test("Summarize now flushes the queue and refreshes the status", async () => {
  api.getTrail.mockResolvedValueOnce(status()).mockResolvedValueOnce(status({ queue: 0 }));
  setup();
  await screen.findByText(/queue 2/);
  await userEvent.click(screen.getByRole("button", { name: "Summarize now" }));
  expect(api.flushTrail).toHaveBeenCalledTimes(1);
  expect(await screen.findByText(/queue 0/)).toBeTruthy();
});

test("Summarize now survives a failing flush and unlocks the buttons again", async () => {
  api.flushTrail.mockRejectedValueOnce(new Error("busy"));
  setup();
  await screen.findByText(/queue 2/);
  await userEvent.click(screen.getByRole("button", { name: "Summarize now" }));
  await vi.waitFor(() => expect((screen.getByRole("button", { name: "Summarize now" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByText(/queue 2/)).toBeTruthy();
});

test("the status refreshes on the hub trail event and on a 30 second timer, and cleans up on unmount", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { unmount } = setup();
  await vi.waitFor(() => expect(api.getTrail).toHaveBeenCalledTimes(1));
  act(() => handlers?.onTrail?.({ date: "2026-11-16", sessionId: "s", bullets: 1 }));
  await vi.waitFor(() => expect(api.getTrail).toHaveBeenCalledTimes(2));
  await act(async () => vi.advanceTimersByTime(30_000));
  await vi.waitFor(() => expect(api.getTrail).toHaveBeenCalledTimes(3));
  unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(api.getTrail).toHaveBeenCalledTimes(3);
});

test("a status answer that arrives after unmount is ignored", async () => {
  let finish: (value: unknown) => void = () => undefined;
  api.getTrail.mockReturnValueOnce(new Promise((done) => (finish = done)));
  const { unmount } = setup();
  unmount();
  finish(status());
  await Promise.resolve();
  expect(document.body.textContent).toBe("");
});

test("controls are locked while the hub surface is off and the form follows settings updates", () => {
  const { rerender, onSaveSettings } = setup();
  rerender(<TrailTab enabled settings={fullSettings({ trail: { ...fullSettings().trail, dir: "other", detail: "high", model: "opus", hubEvents: false } })} onSaveSettings={onSaveSettings} />);
  expect((screen.getByPlaceholderText("D:/vault/trail") as HTMLInputElement).value).toBe("other");
  expect((screen.getByRole("radio", { name: /High/ }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByPlaceholderText("haiku") as HTMLInputElement).value).toBe("opus");
  rerender(<TrailTab enabled={false} settings={fullSettings()} onSaveSettings={onSaveSettings} />);
  expect((screen.getByPlaceholderText("D:/vault/trail") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Summarize now" }) as HTMLButtonElement).disabled).toBe(true);
});
