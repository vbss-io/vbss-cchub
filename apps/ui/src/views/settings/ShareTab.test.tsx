import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { TunnelStatus } from "../../delegation";
import { fullSettings } from "../../test-support/u5-fixtures";
import { ShareTab } from "./ShareTab";

const tunnel = (overrides: Partial<TunnelStatus> = {}): TunnelStatus => ({
  state: "stopped",
  publicUrl: null,
  error: null,
  startedAt: null,
  binary: null,
  installed: false,
  authtokenSet: false,
  domain: null,
  lanUrl: "http://192.168.0.10:4318",
  localUrl: "http://127.0.0.1:4318",
  sharePort: 4318,
  endpointError: null,
  notice: null,
  ...overrides,
});

const setup = (props: Partial<Parameters<typeof ShareTab>[0]> = {}) => {
  const onSaveSettings = vi.fn(async () => undefined);
  const onTunnelSettings = vi.fn(async () => undefined);
  const view = render(<ShareTab enabled settings={fullSettings()} onSaveSettings={onSaveSettings} tunnel={tunnel()} onTunnelSettings={onTunnelSettings} {...props} />);
  return { onSaveSettings, onTunnelSettings, ...view };
};

const details = (): Record<string, string> => {
  const labels = [...document.querySelectorAll("dl.details dt")].map((node) => node.textContent ?? "");
  const values = [...document.querySelectorAll("dl.details dd")].map((node) => (node.textContent ?? "").trim());
  return Object.fromEntries(labels.map((label, index) => [label, values[index] ?? ""]));
};

test("shows the endpoints and the tunnel state", () => {
  setup();
  expect(details()).toMatchObject({
    "Share endpoint": "http://127.0.0.1:4318",
    "LAN address": "http://192.168.0.10:4318",
    ngrok: "not installed yet; Start tunnel downloads it into the hub data folder",
    Tunnel: "stopped",
  });
});

test("without a tunnel status the placeholders say unknown", () => {
  setup({ tunnel: null });
  expect(details()).toMatchObject({ "Share endpoint": "—", "LAN address": "no LAN address found", Tunnel: "unknown" });
});

test("a running tunnel shows its public URL and the installed binary", () => {
  setup({ tunnel: tunnel({ state: "running", publicUrl: "https://x.ngrok-free.app", installed: true, binary: "C:/hub/ngrok.exe" }) });
  expect(details().Tunnel).toContain("https://x.ngrok-free.app");
  expect(details().ngrok).toBe("C:/hub/ngrok.exe");
  expect(document.querySelector(".tag--go")?.textContent).toBe("running");
});

test("a tunnel error is shown, with a friendly explanation for ERR_NGROK_314", () => {
  const first = setup({ tunnel: tunnel({ state: "error", error: "boom" }) });
  expect(document.querySelector(".tag--hold")?.textContent).toBe("error");
  expect(screen.getByText("boom")).toBeTruthy();
  first.unmount();
  setup({ tunnel: tunnel({ state: "error", error: "failed: ERR_NGROK_314" }) });
  expect(screen.getByText(/ngrok refused the custom hostname/)).toBeTruthy();
});

test("the name field saves a changed, non-empty, trimmed value on blur", () => {
  const { onSaveSettings } = setup();
  const input = screen.getByDisplayValue("Vitor");
  fireEvent.change(input, { target: { value: "  Ana  " } });
  fireEvent.blur(input);
  expect(onSaveSettings).toHaveBeenCalledWith({ ownerName: "Ana" });
});

test("an unchanged or empty name is not saved", () => {
  const { onSaveSettings } = setup();
  const input = screen.getByDisplayValue("Vitor");
  fireEvent.blur(input);
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.blur(input);
  expect(onSaveSettings).not.toHaveBeenCalled();
});

test("the name starts empty when settings are not loaded", () => {
  setup({ settings: null });
  expect((screen.getByText("Your name (shown to askers)").parentElement?.querySelector("input") as HTMLInputElement).value).toBe("");
});

test("Save sends a trimmed token and domain, then clears the token field", async () => {
  const { onTunnelSettings } = setup({ tunnel: tunnel({ domain: "old.ngrok-free.app" }) });
  const token = screen.getByPlaceholderText("paste to replace") as HTMLInputElement;
  const domain = screen.getByPlaceholderText("your-name.ngrok-free.app") as HTMLInputElement;
  expect(domain.value).toBe("old.ngrok-free.app");
  await userEvent.type(token, "  secret  ");
  await userEvent.clear(domain);
  await userEvent.type(domain, " new.ngrok-free.app ");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onTunnelSettings).toHaveBeenCalledWith({ authtoken: "secret", domain: "new.ngrok-free.app" });
  await vi.waitFor(() => expect(token.value).toBe(""));
});

test("Save with an empty token keeps the saved one and an empty domain clears it", async () => {
  const { onTunnelSettings } = setup({ tunnel: tunnel({ domain: "old.ngrok-free.app" }) });
  await userEvent.clear(screen.getByPlaceholderText("your-name.ngrok-free.app"));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onTunnelSettings).toHaveBeenCalledWith({ authtoken: undefined, domain: null });
});

test("Forget saved authtoken only appears when a token is saved and clears it", async () => {
  const none = setup();
  expect(screen.queryByRole("button", { name: "Forget saved authtoken" })).toBeNull();
  expect(screen.getByText("Authtoken (using ngrok config)")).toBeTruthy();
  none.unmount();
  const { onTunnelSettings } = setup({ tunnel: tunnel({ authtokenSet: true }) });
  expect(screen.getByText("Authtoken (saved in the hub)")).toBeTruthy();
  await userEvent.type(screen.getByPlaceholderText("paste to replace"), "abc");
  await userEvent.click(screen.getByRole("button", { name: "Forget saved authtoken" }));
  expect(onTunnelSettings).toHaveBeenCalledWith({ authtoken: null });
  await vi.waitFor(() => expect((screen.getByPlaceholderText("paste to replace") as HTMLInputElement).value).toBe(""));
});

test("the buttons lock while a save is running", async () => {
  let finish: () => void = () => undefined;
  const onTunnelSettings = vi.fn(() => new Promise<void>((done) => (finish = done)));
  setup({ onTunnelSettings, tunnel: tunnel({ authtokenSet: true }) });
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Forget saved authtoken" }) as HTMLButtonElement).disabled).toBe(true);
  finish();
  await vi.waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
});

test("the domain field follows the tunnel status", () => {
  const { rerender, onSaveSettings, onTunnelSettings } = setup({ tunnel: tunnel({ domain: "a.ngrok-free.app" }) });
  rerender(<ShareTab enabled settings={fullSettings()} onSaveSettings={onSaveSettings} tunnel={tunnel({ domain: "b.ngrok-free.app" })} onTunnelSettings={onTunnelSettings} />);
  expect((screen.getByPlaceholderText("your-name.ngrok-free.app") as HTMLInputElement).value).toBe("b.ngrok-free.app");
});
