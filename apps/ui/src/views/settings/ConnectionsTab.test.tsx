import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { HooksStatus } from "../../api";
import type { CodexHooksStatus } from "../../types";
import { connectStatus, fullSettings, mcpStatus, shellStatus } from "../../test-support/u5-fixtures";
import { ConnectionsTab } from "./ConnectionsTab";

type Props = Parameters<typeof ConnectionsTab>[0];

const hooksStatus = (overrides: Partial<HooksStatus> = {}): HooksStatus => ({ installed: false, events: [], settingsPath: "C:/Users/x/.claude/settings.json", ...overrides });

const codexHooks = (overrides: Partial<CodexHooksStatus> = {}): CodexHooksStatus => ({
  path: "C:/Users/x/.codex/hooks.json",
  exists: true,
  installed: false,
  updateAvailable: false,
  events: [],
  missing: [],
  backupPath: "C:/Users/x/.codex/hooks.json.bak",
  hasBackup: false,
  error: null,
  trustNote: "Codex asks you to trust new hooks once.",
  ...overrides,
});

const setup = (props: Partial<Props> = {}) => {
  const handlers = {
    onToggleHooks: vi.fn(),
    onShell: vi.fn(async () => undefined),
    onMcp: vi.fn(async () => undefined),
    onSaveSettings: vi.fn(async () => undefined),
    onCodexHooks: vi.fn(async () => undefined),
  };
  const view = render(<ConnectionsTab enabled hubUrl="http://127.0.0.1:4317" connect={connectStatus()} hooks={hooksStatus()} hooksBusy={false} settings={fullSettings()} {...handlers} {...props} />);
  return { ...handlers, ...view };
};

const windowInput = (id: string): HTMLInputElement => section(id) as HTMLInputElement;

const section = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`no section ${id}`);
  return node;
};

test("Hooks: not installed offers Install hooks and toggles through the callback", async () => {
  const { onToggleHooks } = setup();
  const hooks = within(section("settings-hooks"));
  expect(hooks.getByText("not installed")).toBeTruthy();
  expect(hooks.getByText("C:/Users/x/.claude/settings.json")).toBeTruthy();
  await userEvent.click(hooks.getByRole("button", { name: "Install hooks" }));
  expect(onToggleHooks).toHaveBeenCalledTimes(1);
});

test("Hooks: installed shows the event count and WSL distros, and outdated offers an update", () => {
  const first = setup({ hooks: hooksStatus({ installed: true, events: ["a", "b", "c"], wsl: [{ distro: "Ubuntu", installed: true }, { distro: "Debian", outdated: true }, { distro: "Arch" }, { distro: "Alpine", error: "wsl.exe failed" }] }) });
  const hooks = within(section("settings-hooks"));
  expect(hooks.getByText("3 events · 1 WSL distro")).toBeTruthy();
  expect(hooks.getByRole("button", { name: "Remove hooks" })).toBeTruthy();
  const items = [...section("settings-hooks").querySelectorAll("li")].map((li) => li.textContent);
  expect(items).toEqual(["WSL Ubuntu: installed", "WSL Debian: update available", "WSL Arch: not installed", "WSL Alpine: wsl.exe failed"]);
  first.unmount();
  setup({ hooks: hooksStatus({ installed: true, events: ["a"], wsl: [{ distro: "A", installed: true }, { distro: "B", installed: true }] }) });
  expect(screen.getByText("1 events · 2 WSL distros")).toBeTruthy();
});

test("Hooks: an outdated install shows what is missing and the Update hooks action", () => {
  setup({ hooks: hooksStatus({ outdated: true, missing: ["Stop", "SessionEnd"] }) });
  expect(screen.getByText("update available")).toBeTruthy();
  expect(screen.getByText("missing Stop, SessionEnd")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Update hooks" })).toBeTruthy();
});

test("Hooks: the button is disabled and relabelled while busy or before the status arrives", () => {
  const busy = setup({ hooksBusy: true });
  expect((within(section("settings-hooks")).getByRole("button", { name: "Working…" }) as HTMLButtonElement).disabled).toBe(true);
  busy.unmount();
  setup({ hooks: null });
  expect(screen.getByText("checking")).toBeTruthy();
  expect((within(section("settings-hooks")).getByRole("button", { name: "Install hooks" }) as HTMLButtonElement).disabled).toBe(true);
});

test("Approvals: both windows show their hint and commit a valid number on blur and on Enter", async () => {
  const { onSaveSettings } = setup();
  const claude = windowInput("approvals-claude");
  const codex = windowInput("approvals-codex");
  expect(claude.value).toBe("120");
  expect(codex.value).toBe("90");
  expect(screen.getByText("Waits up to 2 minutes for your answer here.")).toBeTruthy();
  expect(screen.getByText("Waits up to 1 minute 30 s for your answer here.")).toBeTruthy();
  fireEvent.change(claude, { target: { value: "300" } });
  fireEvent.blur(claude);
  expect(onSaveSettings).toHaveBeenLastCalledWith({ approvals: { claudeWindowSec: 300 } });
  fireEvent.change(codex, { target: { value: "45" } });
  fireEvent.keyDown(codex, { key: "Enter" });
  expect(onSaveSettings).toHaveBeenLastCalledWith({ approvals: { codexWindowSec: 45 } });
});

test("Approvals: an invalid or unchanged window is not saved and shows the allowed range", () => {
  const { onSaveSettings } = setup();
  const claude = windowInput("approvals-claude");
  fireEvent.change(claude, { target: { value: "5000" } });
  fireEvent.blur(claude);
  expect(onSaveSettings).not.toHaveBeenCalled();
  expect(claude.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByText("Use a whole number from 0 to 1800.")).toBeTruthy();
  fireEvent.change(claude, { target: { value: "120" } });
  fireEvent.blur(claude);
  expect(onSaveSettings).not.toHaveBeenCalled();
  expect(claude.getAttribute("aria-invalid")).toBe("false");
  fireEvent.change(claude, { target: { value: "12" } });
  fireEvent.keyDown(claude, { key: "a" });
  expect(onSaveSettings).not.toHaveBeenCalled();
});

test("Approvals: a window of 0 explains that the hub only observes, and the field follows a settings update", () => {
  const { rerender, ...rest } = setup({ settings: fullSettings({ approvals: { claudeWindowSec: 0, codexWindowSec: 30 } }) });
  expect(screen.getByText(/^Off: the hook does not wait/)).toBeTruthy();
  expect(screen.getByText("Waits up to 30 seconds for your answer here.")).toBeTruthy();
  rerender(<ConnectionsTab enabled hubUrl="h" connect={connectStatus()} hooks={hooksStatus({ permissionTimeout: 180 })} hooksBusy={false} settings={fullSettings({ approvals: { claudeWindowSec: 600, codexWindowSec: 30 } })} onToggleHooks={rest.onToggleHooks} onShell={rest.onShell} onMcp={rest.onMcp} onSaveSettings={rest.onSaveSettings} onCodexHooks={rest.onCodexHooks} />);
  expect((windowInput("approvals-claude")).value).toBe("600");
  expect(screen.getByText(/\(hook timeout 180 s\)/)).toBeTruthy();
});

test("Approvals and the connection sections explain a hub that is off or still loading", () => {
  const off = setup({ enabled: false, settings: null, connect: null });
  expect(screen.getAllByText("Available once the hub surface is on.")).toHaveLength(4);
  expect(document.getElementById("approvals-claude")).toBeNull();
  off.unmount();
  setup({ settings: null, connect: null });
  expect(screen.getAllByText("Loading…").length).toBeGreaterThanOrEqual(3);
});

test("Codex hooks: not installed offers Install hooks and the install call runs through the busy lock", async () => {
  let finish: () => void = () => undefined;
  const onCodexHooks = vi.fn(() => new Promise<void>((done) => (finish = done)));
  setup({ connect: connectStatus({ codexHooks: codexHooks() }), onCodexHooks });
  const codex = within(section("settings-codex-hooks"));
  expect(codex.getByText("not installed")).toBeTruthy();
  expect(codex.getByText("Codex asks you to trust new hooks once.")).toBeTruthy();
  await userEvent.click(codex.getByRole("button", { name: "Install hooks" }));
  expect(onCodexHooks).toHaveBeenCalledWith("install");
  expect((codex.getByRole("button", { name: "Install hooks" }) as HTMLButtonElement).disabled).toBe(true);
  finish();
  await vi.waitFor(() => expect((codex.getByRole("button", { name: "Install hooks" }) as HTMLButtonElement).disabled).toBe(false));
});

test("Codex hooks: installed offers Remove hooks and shows the backup note", async () => {
  const { onCodexHooks } = setup({ connect: connectStatus({ codexHooks: codexHooks({ installed: true, events: ["a", "b"], hasBackup: true }) }) });
  const codex = within(section("settings-codex-hooks"));
  expect(codex.getByText("2 events")).toBeTruthy();
  expect(codex.getByText(/A copy of your hooks file from before the install is at C:\/Users\/x\/\.codex\/hooks\.json\.bak/)).toBeTruthy();
  expect(codex.queryByRole("button", { name: "Install hooks" })).toBeNull();
  await userEvent.click(codex.getByRole("button", { name: "Remove hooks" }));
  expect(onCodexHooks).toHaveBeenCalledWith("uninstall");
});

test("Codex hooks: an outdated file offers Update hooks and Remove hooks, and an unreadable one offers neither", async () => {
  const outdated = setup({ connect: connectStatus({ codexHooks: codexHooks({ updateAvailable: true, missing: ["Stop"] }) }) });
  const codex = within(section("settings-codex-hooks"));
  expect(codex.getByText("outdated Stop")).toBeTruthy();
  await userEvent.click(codex.getByRole("button", { name: "Update hooks" }));
  expect(outdated.onCodexHooks).toHaveBeenCalledWith("install");
  expect(codex.getByRole("button", { name: "Remove hooks" })).toBeTruthy();
  outdated.unmount();
  setup({ connect: connectStatus({ codexHooks: codexHooks({ error: "invalid json" }) }) });
  const broken = within(section("settings-codex-hooks"));
  expect(broken.getByText("unreadable")).toBeTruthy();
  expect(broken.getByText("invalid json")).toBeTruthy();
  expect(broken.queryByRole("button")).toBeNull();
});

test("MCP: a disconnected client offers Connect and runs it through the busy lock", async () => {
  let finish: () => void = () => undefined;
  const onMcp = vi.fn(() => new Promise<void>((done) => (finish = done)));
  setup({ onMcp });
  const mcp = within(section("settings-connect"));
  expect(mcp.getAllByText("not connected")).toHaveLength(3);
  await userEvent.click(mcp.getAllByRole("button", { name: "Connect" })[0] as HTMLElement);
  expect(onMcp).toHaveBeenCalledWith("claude-code", "install");
  for (const button of mcp.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
  finish();
  await vi.waitFor(() => expect((mcp.getAllByRole("button", { name: "Connect" })[0] as HTMLButtonElement).disabled).toBe(false));
});

test("MCP: connected clients offer Disconnect, with Update when the registered entry differs", async () => {
  const connect = connectStatus({
    mcp: {
      "claude-code": mcpStatus({ installed: true, inFile: true, updateAvailable: true, cli: "claude mcp" }),
      "claude-desktop": mcpStatus({ installed: true, inFile: false }),
      codex: mcpStatus({ installed: false, error: "codex not found" }),
    },
  });
  const { onMcp } = setup({ connect });
  const mcp = within(section("settings-connect"));
  expect(mcp.getByText("connected")).toBeTruthy();
  expect(mcp.getByText("connected · imported by the app")).toBeTruthy();
  expect(mcp.getByText("update available")).toBeTruthy();
  expect(mcp.getByText(/Update re-registers it with claude mcp; restart the client after\./)).toBeTruthy();
  expect(mcp.getByText("Claude Desktop moved the entry into its own settings after reading it; that is normal.")).toBeTruthy();
  expect(mcp.getByText("codex not found")).toBeTruthy();
  expect((mcp.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(mcp.getByRole("button", { name: "Update" }));
  expect(onMcp).toHaveBeenLastCalledWith("claude-code", "install");
  await userEvent.click(mcp.getAllByRole("button", { name: "Disconnect" })[1] as HTMLElement);
  expect(onMcp).toHaveBeenLastCalledWith("claude-desktop", "uninstall");
});

test("MCP: an update without a known CLI omits the CLI hint", () => {
  setup({ connect: connectStatus({ mcp: { "claude-code": mcpStatus({ installed: true, inFile: true, updateAvailable: true }), "claude-desktop": mcpStatus(), codex: mcpStatus() } }) });
  expect(screen.getByText("The registered cchub entry differs from this hub. Update re-registers it; restart the client after.")).toBeTruthy();
});

test("MCP: a missing server entry blocks Connect and Update and is explained", () => {
  const connect = connectStatus({
    mcpEntryExists: false,
    mcp: { "claude-code": mcpStatus({ installed: true, inFile: true, updateAvailable: true }), "claude-desktop": mcpStatus(), codex: mcpStatus() },
  });
  setup({ connect });
  expect(screen.getByText(/MCP entry missing at C:\/app\/mcp\.js/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Update" }) as HTMLButtonElement).disabled).toBe(true);
  for (const button of screen.getAllByRole("button", { name: "Connect" })) expect((button as HTMLButtonElement).disabled).toBe(true);
});

test("MCP: the manual entry snippet is the stdio server definition", () => {
  setup();
  const snippet = document.querySelector("pre.snippet")?.textContent ?? "";
  expect(JSON.parse(snippet)).toEqual({ mcpServers: { cchub: { command: "node", args: ["C:/app/mcp.js"], env: { HUB_URL: "http://127.0.0.1:4317" } } } });
});

test("Shell alias: install, remove and an alias the user already defines", async () => {
  const connect = connectStatus({ shell: { bash: shellStatus({ installed: true, path: "~/.bashrc" }), powershell: shellStatus({ external: true, path: "profile.ps1" }) } });
  const { onShell } = setup({ connect });
  const shell = within(section("settings-shell"));
  expect(shell.getByText("installed")).toBeTruthy();
  expect(shell.getByText("you already define wk")).toBeTruthy();
  expect((shell.getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(shell.getByRole("button", { name: "Remove" }));
  expect(onShell).toHaveBeenCalledWith("bash", "uninstall");
});

test("Shell alias: a plain not-installed shell can be installed", async () => {
  const { onShell } = setup();
  const shell = within(section("settings-shell"));
  expect(shell.getAllByText("not installed")).toHaveLength(2);
  await userEvent.click(shell.getAllByRole("button", { name: "Install" })[1] as HTMLElement);
  expect(onShell).toHaveBeenCalledWith("powershell", "install");
});

test("Shell alias: waits for the status, or says the hub surface is off", () => {
  const loading = setup({ connect: null });
  expect(within(section("settings-shell")).getByText("Loading…")).toBeTruthy();
  loading.unmount();
  setup({ connect: null, enabled: false });
  expect(within(section("settings-shell")).getByText("Available once the hub surface is on.")).toBeTruthy();
});
