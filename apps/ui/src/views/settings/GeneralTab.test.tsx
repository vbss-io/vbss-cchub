import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { AutostartStatus } from "../../delegation";
import { fullSettings } from "../../test-support/u5-fixtures";
import { GeneralTab } from "./GeneralTab";

const autostart = (overrides: Partial<AutostartStatus> = {}): AutostartStatus => ({ supported: true, enabled: false, exe: "C:/app/cchub.exe", error: null, ...overrides });

const setup = (props: Partial<Parameters<typeof GeneralTab>[0]> = {}) => {
  const onSaveSettings = vi.fn(async () => undefined);
  const onAutostart = vi.fn(async () => undefined);
  const view = render(<GeneralTab enabled settings={fullSettings()} onSaveSettings={onSaveSettings} autostart={autostart()} onAutostart={onAutostart} {...props} />);
  return { onSaveSettings, onAutostart, ...view };
};

test("shows the saved autonomy, timeout and paths", () => {
  setup({ settings: fullSettings({ autonomy: "safe", runTimeoutMinutes: 90 }) });
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("safe");
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("90");
  expect((screen.getByPlaceholderText("folder holding your .code-workspace files") as HTMLInputElement).value).toBe("C:/work/workspaces");
  expect((screen.getByPlaceholderText("code") as HTMLInputElement).value).toBe("code");
  expect((screen.getByPlaceholderText("optional: vault root") as HTMLInputElement).value).toBe("D:/vault");
});

test("falls back to defaults when settings are not loaded", () => {
  setup({ settings: null, enabled: false });
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("full");
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("60");
  expect((screen.getByPlaceholderText("code") as HTMLInputElement).value).toBe("code");
  expect(screen.getByText(/hub surface \(workspaces, delegation, reports\) is off/)).toBeTruthy();
  expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Save paths" }) as HTMLButtonElement).disabled).toBe(true);
});

test("changing the autonomy saves it immediately", async () => {
  const { onSaveSettings } = setup();
  await userEvent.selectOptions(screen.getByRole("combobox"), "auto");
  expect(onSaveSettings).toHaveBeenCalledWith({ autonomy: "auto" });
});

test("the run timeout saves only valid values between 5 and 720", () => {
  const { onSaveSettings } = setup();
  const input = screen.getByRole("spinbutton");
  fireEvent.change(input, { target: { value: "120" } });
  expect(onSaveSettings).toHaveBeenLastCalledWith({ runTimeoutMinutes: 120 });
  fireEvent.change(input, { target: { value: "5" } });
  expect(onSaveSettings).toHaveBeenLastCalledWith({ runTimeoutMinutes: 5 });
  fireEvent.change(input, { target: { value: "720" } });
  expect(onSaveSettings).toHaveBeenLastCalledWith({ runTimeoutMinutes: 720 });
  onSaveSettings.mockClear();
  fireEvent.change(input, { target: { value: "4" } });
  fireEvent.change(input, { target: { value: "721" } });
  fireEvent.change(input, { target: { value: "" } });
  expect(onSaveSettings).not.toHaveBeenCalled();
});

test("Save paths stays disabled until a path changes, then saves the trimmed values", async () => {
  const { onSaveSettings } = setup();
  const save = screen.getByRole("button", { name: "Save paths" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  const root = screen.getByPlaceholderText("folder holding your .code-workspace files");
  await userEvent.clear(root);
  await userEvent.type(root, "  D:/new  ");
  expect(save.disabled).toBe(false);
  await userEvent.click(save);
  expect(onSaveSettings).toHaveBeenCalledWith({ workspacesRoot: "D:/new", editorCommand: "code", secondBrainRoot: "D:/vault" });
});

test("empty root and vault save as null and an empty editor falls back to code", async () => {
  const { onSaveSettings } = setup();
  await userEvent.clear(screen.getByPlaceholderText("folder holding your .code-workspace files"));
  await userEvent.clear(screen.getByPlaceholderText("code"));
  await userEvent.clear(screen.getByPlaceholderText("optional: vault root"));
  await userEvent.click(screen.getByRole("button", { name: "Save paths" }));
  expect(onSaveSettings).toHaveBeenCalledWith({ workspacesRoot: null, editorCommand: "code", secondBrainRoot: null });
});

test("editing the editor and vault fields marks the form dirty", async () => {
  setup();
  await userEvent.type(screen.getByPlaceholderText("code"), "-insiders");
  expect((screen.getByRole("button", { name: "Save paths" }) as HTMLButtonElement).disabled).toBe(false);
});

test("the form follows a settings update coming from the hub", () => {
  const { rerender, onSaveSettings, onAutostart } = setup();
  rerender(<GeneralTab enabled settings={fullSettings({ workspacesRoot: "E:/other", editorCommand: "cursor", secondBrainRoot: null })} onSaveSettings={onSaveSettings} autostart={autostart()} onAutostart={onAutostart} />);
  expect((screen.getByPlaceholderText("folder holding your .code-workspace files") as HTMLInputElement).value).toBe("E:/other");
  expect((screen.getByPlaceholderText("code") as HTMLInputElement).value).toBe("cursor");
  expect((screen.getByPlaceholderText("optional: vault root") as HTMLInputElement).value).toBe("");
});

test("Save paths is disabled while a save is running", async () => {
  let finish: () => void = () => undefined;
  const onSaveSettings = vi.fn(() => new Promise<void>((done) => (finish = done)));
  setup({ onSaveSettings });
  await userEvent.type(screen.getByPlaceholderText("code"), "x");
  await userEvent.click(screen.getByRole("button", { name: "Save paths" }));
  expect((screen.getByRole("button", { name: "Save paths" }) as HTMLButtonElement).disabled).toBe(true);
  finish();
  await screen.findByRole("button", { name: "Save paths" });
});

test("autostart toggles through the callback and locks while it runs", async () => {
  let finish: () => void = () => undefined;
  const onAutostart = vi.fn(() => new Promise<void>((done) => (finish = done)));
  setup({ onAutostart });
  const box = screen.getByRole("checkbox", { name: "Start with Windows" }) as HTMLInputElement;
  expect(box.checked).toBe(false);
  await userEvent.click(box);
  expect(onAutostart).toHaveBeenCalledWith(true);
  expect(box.disabled).toBe(true);
  finish();
  await vi.waitFor(() => expect(box.disabled).toBe(false));
});

test("autostart text explains each state", () => {
  const checking = setup({ autostart: null });
  expect(screen.getByText("checking…")).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "Start with Windows" }) as HTMLInputElement).disabled).toBe(true);
  checking.unmount();
  const errored = setup({ autostart: autostart({ error: "registry denied" }) });
  expect(screen.getByText("registry denied")).toBeTruthy();
  errored.unmount();
  const supported = setup({ autostart: autostart({ enabled: true }) });
  expect(screen.getByText(/user Run key \(C:\/app\/cchub\.exe\)/)).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "Start with Windows" }) as HTMLInputElement).checked).toBe(true);
  supported.unmount();
  setup({ autostart: autostart({ supported: false }) });
  expect(screen.getByText(/Available in the installed desktop app/)).toBeTruthy();
});
