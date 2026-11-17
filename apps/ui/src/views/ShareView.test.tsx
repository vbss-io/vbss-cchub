import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareStreamEvent } from "../api";
import {
  allowFirewall,
  createShare,
  deleteShare,
  getFirewall,
  getShareDoc,
  getTunnel,
  listShareFiles,
  listShareRequests,
  listShares,
  startTunnel,
  stopTunnel,
  updateShare,
  type ShareRecord,
  type WorkspaceRecord,
} from "../delegation";
import { firewallStatus, NOW, sessionRecord, shareRecord, shareRequest, tunnelStatus } from "../test-support/u4-fixtures";
import type { SessionRecord } from "../types";
import { ShareView } from "./ShareView";

vi.mock("../delegation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../delegation")>()),
  allowFirewall: vi.fn(),
  createShare: vi.fn(),
  deleteShare: vi.fn(),
  getFirewall: vi.fn(),
  getShareDoc: vi.fn(),
  getTunnel: vi.fn(),
  listShareFiles: vi.fn(),
  listShareRequests: vi.fn(),
  listShares: vi.fn(),
  startTunnel: vi.fn(),
  stopTunnel: vi.fn(),
  updateShare: vi.fn(),
}));

const listMock = vi.mocked(listShares);
const tunnelMock = vi.mocked(getTunnel);
const firewallMock = vi.mocked(getFirewall);
const allowMock = vi.mocked(allowFirewall);
const createMock = vi.mocked(createShare);
const updateMock = vi.mocked(updateShare);
const deleteMock = vi.mocked(deleteShare);
const requestsMock = vi.mocked(listShareRequests);
const filesMock = vi.mocked(listShareFiles);
const docMock = vi.mocked(getShareDoc);
const startMock = vi.mocked(startTunnel);
const stopMock = vi.mocked(stopTunnel);

const workspaces: WorkspaceRecord[] = [
  { name: "api-ws", file: "C:/ws/api.json", contextPath: "C:/ws/api", repos: [{ name: "api", path: "C:/work/api" }], error: null },
  { name: "web-ws", file: "C:/ws/web.json", contextPath: null, repos: [{ name: "web", path: "C:/work/web" }], error: null },
];

let writeText = vi.fn();
let host: HTMLElement;
let listeners: Set<(event: ShareStreamEvent) => void>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  location.hash = "";
  for (const mock of [listMock, tunnelMock, firewallMock, allowMock, createMock, updateMock, deleteMock, requestsMock, filesMock, docMock, startMock, stopMock]) mock.mockReset();
  listMock.mockResolvedValue([]);
  tunnelMock.mockResolvedValue(tunnelStatus());
  firewallMock.mockResolvedValue(firewallStatus());
  requestsMock.mockResolvedValue([]);
  filesMock.mockResolvedValue([]);
  updateMock.mockResolvedValue(shareRecord());
  deleteMock.mockResolvedValue({ ok: true });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  listeners = new Set();
});

afterEach(() => {
  host.remove();
  vi.useRealTimers();
});

type Props = Parameters<typeof ShareView>[0];

const baseProps = (): Props => ({
  enabled: true,
  workspaces,
  sessions: {},
  param: null,
  tick: 0,
  tunnel: tunnelStatus(),
  onTunnelChanged: vi.fn(),
  subscribeShareStream: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  onOpenSettings: vi.fn(),
  onOpenTask: vi.fn(),
  onNotice: vi.fn(),
  onError: vi.fn(),
  panelHost: host,
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const setup = async (overrides: Partial<Props> = {}, shares: ShareRecord[] = []) => {
  listMock.mockResolvedValue(shares);
  const props = { ...baseProps(), ...overrides };
  const view = render(<ShareView {...props} />);
  await flush();
  return { props, ...view };
};

const cardTitles = (): string[] => screen.queryAllByRole("article").map((card) => card.querySelector(".card__name")?.textContent ?? "");

const panel = () => within(host);

const emitStream = (event: ShareStreamEvent) => act(() => listeners.forEach((listener) => listener(event)));

describe("ShareView basics", () => {
  it("explains that sharing needs the hub surface when disabled", async () => {
    await setup({ enabled: false });
    expect(screen.getByText(/Sharing needs the hub surface/)).toBeTruthy();
    expect(listMock).not.toHaveBeenCalled();
  });

  it("loads shares and the tunnel status and reports it up", async () => {
    const { props } = await setup({}, [shareRecord()]);
    expect(cardTitles()).toEqual(["Ana doubts"]);
    expect(props.onTunnelChanged).toHaveBeenCalledWith(expect.objectContaining({ state: "stopped" }));
  });

  it("tells the user when there are no shares yet", async () => {
    await setup();
    expect(screen.getByText(/No shares yet/)).toBeTruthy();
  });

  it("reports a load failure and a non error failure", async () => {
    listMock.mockRejectedValueOnce(new Error("hub down"));
    const first = baseProps();
    const view = render(<ShareView {...first} />);
    await flush();
    expect(first.onError).toHaveBeenCalledWith("hub down");
    view.unmount();
    listMock.mockRejectedValueOnce("odd");
    const second = baseProps();
    render(<ShareView {...second} />);
    await flush();
    expect(second.onError).toHaveBeenCalledWith("could not load shares");
  });

  it("reloads when the tick changes", async () => {
    const { rerender, props } = await setup({}, [shareRecord()]);
    rerender(<ShareView {...props} tick={1} />);
    await flush();
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes the open file lists on reload", async () => {
    const share = shareRecord({ uses: 1 });
    const { rerender, props } = await setup({ param: share.id }, [share]);
    fireEvent.click(panel().getByRole("button", { name: "Details" }));
    filesMock.mockResolvedValue([{ name: "a.md", size: 1, modifiedAt: NOW, direction: "out" }]);
    fireEvent.click(panel().getByRole("button", { name: /Show files/ }));
    await flush();
    expect(screen.getByRole("link", { name: "a.md" })).toBeTruthy();
    filesMock.mockResolvedValue([{ name: "b.md", size: 1, modifiedAt: NOW, direction: "out" }]);
    rerender(<ShareView {...props} tick={2} />);
    await flush();
    expect(screen.getByRole("link", { name: "b.md" })).toBeTruthy();
  });
});

describe("ShareView filters", () => {
  const mixed = (): ShareRecord[] => [
    shareRecord({ id: "a", label: "Active one" }),
    shareRecord({ id: "p", label: "Paused one", state: "paused", paused: true, active: false }),
    shareRecord({ id: "e", label: "Expired one", state: "expired", active: false }),
    shareRecord({ id: "r", label: "Revoked one", state: "revoked", active: false, workspace: "web-ws" }),
  ];

  it("shows active shares by default with counts and switches filters, persisting the choice", async () => {
    await setup({}, mixed());
    expect(cardTitles()).toEqual(["Active one"]);
    expect(screen.getByRole("button", { name: /^Active1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^All4/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Paused/ }));
    expect(cardTitles()).toEqual(["Paused one"]);
    expect(localStorage.getItem("hub.share.filter")).toBe("paused");
    fireEvent.click(screen.getByRole("button", { name: /^Expired/ }));
    expect(cardTitles()).toEqual(["Expired one"]);
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(cardTitles()).toHaveLength(4);
  });

  it("restores the stored filter and ignores an invalid or unreadable one", async () => {
    localStorage.setItem("hub.share.filter", "paused");
    const first = await setup({}, mixed());
    expect(cardTitles()).toEqual(["Paused one"]);
    first.unmount();
    localStorage.setItem("hub.share.filter", "bogus");
    const second = await setup({}, mixed());
    expect(cardTitles()).toEqual(["Active one"]);
    second.unmount();
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await setup({}, mixed());
    expect(cardTitles()).toEqual(["Active one"]);
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(cardTitles()).toHaveLength(4);
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it("searches by label or workspace and says when nothing matches", async () => {
    await setup({}, mixed());
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    fireEvent.change(screen.getByLabelText("Search shares"), { target: { value: "web" } });
    expect(cardTitles()).toEqual(["Revoked one"]);
    fireEvent.change(screen.getByLabelText("Search shares"), { target: { value: "zzz" } });
    expect(screen.getByText("Nothing in this filter.")).toBeTruthy();
  });

  it("opens the new share form through the hash", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "New share" }));
    expect(location.hash).toBe("#/share/new");
  });

  it("opens a share through the hash from its card", async () => {
    await setup({}, [shareRecord()]);
    fireEvent.click(screen.getByText("Ana doubts"));
    expect(location.hash).toBe("#/share/share-1");
  });
});

describe("ShareView reach line", () => {
  it("shows the LAN, firewall and internet status", async () => {
    await setup({ tunnel: tunnelStatus({ state: "running", publicUrl: "https://abc.ngrok.app" }) });
    const status = screen.getByRole("list", { name: "Sharing reach" });
    expect(within(status).getByText("192.168.0.5:4318")).toBeTruthy();
    expect(within(status).getByText("ok")).toBeTruthy();
    expect(within(status).getByText("abc.ngrok.app")).toBeTruthy();
  });

  it("falls back to an unsupported firewall when the check fails", async () => {
    firewallMock.mockRejectedValue(new Error("x"));
    await setup();
    const status = screen.getByRole("list", { name: "Sharing reach" });
    expect(within(status).queryByText("Firewall")).toBeNull();
  });

  it("shows tunnel problems and notices", async () => {
    await setup({ tunnel: tunnelStatus({ state: "error", error: "ngrok failed", endpointError: "port busy", notice: "heads up" }) });
    expect(screen.getByText(/Share endpoint down: port 4318 could not be opened \(port busy\)/)).toBeTruthy();
    expect(screen.getByText("ngrok failed", { selector: "p" })).toBeTruthy();
    expect(screen.getByText("heads up")).toBeTruthy();
  });

  it("starts the tunnel and reports the public URL", async () => {
    startMock.mockResolvedValue(tunnelStatus({ state: "running", publicUrl: "https://abc.ngrok.app" }));
    const { props } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Sharing connection actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Start tunnel" }));
    await flush();
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(props.onNotice).toHaveBeenCalledWith("tunnel on: https://abc.ngrok.app");
    expect(props.onTunnelChanged).toHaveBeenCalledWith(expect.objectContaining({ state: "running" }));
  });

  it("stops a running tunnel", async () => {
    stopMock.mockResolvedValue(tunnelStatus());
    await setup({ tunnel: tunnelStatus({ state: "running", publicUrl: "https://abc.ngrok.app" }) });
    fireEvent.click(screen.getByRole("button", { name: "Sharing connection actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop tunnel" }));
    await flush();
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it("reports a tunnel that ends in error, with and without a message, and a thrown error", async () => {
    const { props } = await setup();
    startMock.mockResolvedValueOnce(tunnelStatus({ state: "error", error: "no authtoken" }));
    fireEvent.click(screen.getByRole("button", { name: "Sharing connection actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Start tunnel" }));
    await flush();
    expect(props.onError).toHaveBeenCalledWith("no authtoken");
    startMock.mockResolvedValueOnce(tunnelStatus({ state: "error", error: null }));
    fireEvent.click(screen.getByRole("button", { name: "Sharing connection actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Start tunnel" }));
    await flush();
    expect(props.onError).toHaveBeenCalledWith("tunnel failed");
    startMock.mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(screen.getByRole("button", { name: "Sharing connection actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Start tunnel" }));
    await flush();
    expect(props.onError).toHaveBeenCalledWith("boom");
    startMock.mockRejectedValueOnce("odd");
    fireEvent.click(screen.getByRole("button", { name: "Sharing connection actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Start tunnel" }));
    await flush();
    expect(props.onError).toHaveBeenLastCalledWith("tunnel failed");
  });

  it("allows LAN access through the firewall and reports the outcome", async () => {
    firewallMock.mockResolvedValue(firewallStatus({ allowed: false }));
    allowMock.mockResolvedValueOnce(firewallStatus({ allowed: true }));
    const { props } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Sharing connection actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Allow LAN (admin)" }));
    await flush();
    expect(props.onNotice).toHaveBeenCalledWith("Windows Firewall now allows LAN access to the share port");
    expect(allowMock).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole("list", { name: "Sharing reach" })).getByText("ok")).toBeTruthy();
  });

  it("reports a firewall rule that was not created and a thrown error", async () => {
    firewallMock.mockResolvedValue(firewallStatus({ allowed: false }));
    allowMock.mockResolvedValueOnce(firewallStatus({ allowed: false, error: "denied" }));
    const { props } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Sharing connection actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Allow LAN (admin)" }));
    await flush();
    expect(props.onError).toHaveBeenCalledWith("denied");
    allowMock.mockResolvedValueOnce(firewallStatus({ allowed: false, error: null }));
    fireEvent.click(screen.getByRole("button", { name: "Sharing connection actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Allow LAN (admin)" }));
    await flush();
    expect(props.onError).toHaveBeenCalledWith("the firewall rule was not created");
    allowMock.mockRejectedValueOnce(new Error("uac cancelled"));
    fireEvent.click(screen.getByRole("button", { name: "Sharing connection actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Allow LAN (admin)" }));
    await flush();
    expect(props.onError).toHaveBeenCalledWith("uac cancelled");
    allowMock.mockRejectedValueOnce("odd");
    fireEvent.click(screen.getByRole("button", { name: "Sharing connection actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Allow LAN (admin)" }));
    await flush();
    expect(props.onError).toHaveBeenLastCalledWith("firewall change failed");
  });

  it("opens the sharing settings", async () => {
    const { props } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Sharing connection actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings › Sharing" }));
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe("ShareView create form", () => {
  it("creates a share with the chosen options and opens it", async () => {
    createMock.mockResolvedValue(shareRecord({ id: "new-1" }));
    const { props } = await setup({ param: "new" });
    const form = panel();
    expect(form.getByRole("dialog", { name: "New share" })).toBeTruthy();
    fireEvent.change(form.getByPlaceholderText("Will · nexus doubts"), { target: { value: "  Will  " } });
    fireEvent.change(form.getByLabelText("Workspace"), { target: { value: "api-ws" } });
    fireEvent.change(form.getByLabelText("Repository (optional)"), { target: { value: "api" } });
    fireEvent.click(form.getByRole("button", { name: "High" }));
    expect(form.getByText(/Edits and runs safe commands/)).toBeTruthy();
    fireEvent.change(form.getByLabelText("Expires"), { target: { value: "168" } });
    fireEvent.change(form.getByPlaceholderText(/Context the asker should know/), { target: { value: "  about auth  " } });
    fireEvent.click(form.getByRole("button", { name: "Create link" }));
    await flush();
    expect(createMock).toHaveBeenCalledWith({ label: "Will", workspace: "api-ws", repo: "api", trust: "high", sessionId: null, note: "about auth", expiresInHours: 168 });
    expect(props.onNotice).toHaveBeenCalledWith("share link created");
    expect(location.hash).toBe("#/share/new-1");
  });

  it("uses a default label, never expiry and null repo and note", async () => {
    createMock.mockResolvedValue(shareRecord({ id: "new-2" }));
    await setup({ param: "new" });
    fireEvent.change(panel().getByLabelText("Expires"), { target: { value: "never" } });
    fireEvent.click(panel().getByRole("button", { name: "Create link" }));
    await flush();
    const body = createMock.mock.calls[0]?.[0];
    expect(body?.label).toContain("api-ws · ");
    expect(body?.expiresInHours).toBeNull();
    expect(body?.repo).toBeNull();
    expect(body?.note).toBeNull();
  });

  it("reports a create failure and a non error failure and re-enables the button", async () => {
    createMock.mockRejectedValueOnce(new Error("quota"));
    const { props } = await setup({ param: "new" });
    fireEvent.click(panel().getByRole("button", { name: "Create link" }));
    await flush();
    expect(props.onError).toHaveBeenCalledWith("quota");
    createMock.mockRejectedValueOnce("odd");
    fireEvent.click(panel().getByRole("button", { name: "Create link" }));
    await flush();
    expect(props.onError).toHaveBeenLastCalledWith("could not create the share");
    expect((panel().getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Create without any workspace", async () => {
    await setup({ param: "new", workspaces: [] });
    expect((panel().getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("picks the first workspace when they load after the form opened", async () => {
    const props = baseProps();
    const view = render(<ShareView {...props} workspaces={[]} param="new" />);
    await flush();
    view.rerender(<ShareView {...props} workspaces={workspaces} param="new" />);
    await flush();
    expect((panel().getByLabelText("Workspace") as HTMLSelectElement).value).toBe("api-ws");
  });

  it("offers the live sessions of the workspace and a pinned session", async () => {
    const inside = sessionRecord({ sessionId: "s-in", title: "Inside", cwd: "C:/work/api/src" });
    const outside = sessionRecord({ sessionId: "s-out", title: "Outside", cwd: "C:/other" });
    const ended = sessionRecord({ sessionId: "s-end", title: "Ended", cwd: "C:/work/api", status: "ended" });
    const sessions: Record<string, SessionRecord> = { "s-in": inside, "s-out": outside, "s-end": ended, "s-ctx": sessionRecord({ sessionId: "s-ctx", title: "Ctx", cwd: "C:/ws/api/notes" }) };
    await setup({ param: "new", sessions });
    const options = within(panel().getByLabelText(/^Answer from a session/)).getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["fresh context of the workspace", "Inside", "Ctx"]);
  });

  it("prefills the form from a session and pins it even when it is not listed", async () => {
    const session = sessionRecord({ sessionId: "s-pin", title: "Pinned", customTitle: "Mine", cwd: "C:/work/api", status: "ended" });
    await setup({ param: "new:s-pin", sessions: { "s-pin": session } });
    const form = panel();
    expect((form.getByPlaceholderText("Will · nexus doubts") as HTMLInputElement).value).toBe("Mine");
    expect((form.getByLabelText("Workspace") as HTMLSelectElement).value).toBe("api-ws");
    expect((form.getByLabelText(/^Answer from a session/) as HTMLSelectElement).value).toBe("s-pin");
    expect(within(form.getByLabelText(/^Answer from a session/)).getByRole("option", { name: "Mine" })).toBeTruthy();
  });

  it("warns when the session runs outside every workspace", async () => {
    const session = sessionRecord({ sessionId: "s-out", title: "Outside", cwd: "C:/elsewhere" });
    const { props } = await setup({ param: "new:s-out", sessions: { "s-out": session } });
    expect(props.onError).toHaveBeenCalledWith("that session runs outside every workspace; share a workspace instead");
    expect((panel().getByPlaceholderText("Will · nexus doubts") as HTMLInputElement).value).toBe("");
  });

  it("waits for an unknown session and workspaces before prefilling", async () => {
    const props = baseProps();
    const view = render(<ShareView {...props} param="new:later" sessions={{}} />);
    await flush();
    expect((panel().getByPlaceholderText("Will · nexus doubts") as HTMLInputElement).value).toBe("");
    view.rerender(<ShareView {...props} param="new:later" sessions={{ later: sessionRecord({ sessionId: "later", title: "Later", cwd: "C:/work/web" }) }} />);
    await flush();
    expect((panel().getByPlaceholderText("Will · nexus doubts") as HTMLInputElement).value).toBe("Later");
    expect((panel().getByLabelText("Workspace") as HTMLSelectElement).value).toBe("web-ws");
  });

  it("closes the panel on Escape, outside click and the close button", async () => {
    await setup({ param: "new" });
    location.hash = "#/share/new";
    fireEvent.keyDown(window, { key: "Escape" });
    expect(location.hash).toBe("#/share");
    location.hash = "#/share/new";
    fireEvent.mouseDown(panel().getByRole("dialog"));
    expect(location.hash).toBe("#/share/new");
    fireEvent.mouseDown(document.body);
    expect(location.hash).toBe("#/share");
    location.hash = "#/share/new";
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.click(panel().getByRole("button", { name: "Close" }));
    expect(location.hash).toBe("#/share");
  });

  it("renders no panel without a host", async () => {
    await setup({ param: "new", panelHost: null });
    expect(screen.queryByRole("dialog", { name: "New share" })).toBeNull();
  });
});

describe("ShareView details", () => {
  const withLinks = (overrides: Partial<ShareRecord> = {}): ShareRecord =>
    shareRecord({ links: { local: "http://127.0.0.1:4318/s/share-1?key=k-secret", lan: null, public: null }, ...overrides });

  it("shows the activity with the requests, the answer, the error and the open task link", async () => {
    requestsMock.mockResolvedValue([
      shareRequest({ id: "r1", prompt: "How does auth work?", answer: "With **tokens**.", taskId: "t9", remote: "10.0.0.2", forkSessionId: "forkabcdef12", kind: "implement" }),
      shareRequest({ id: "r2", prompt: "Boom?", answer: null, error: "worker died", asker: null, label: "Guest", status: "failed" }),
    ]);
    const { props } = await setup({ param: "share-1" }, [withLinks()]);
    expect(panel().getByRole("dialog", { name: "Ana doubts" })).toBeTruthy();
    expect(panel().getByText("How does auth work?")).toBeTruthy();
    expect(panel().getByText("tokens").tagName).toBe("STRONG");
    expect(panel().getByText(/requested .* · from 10\.0\.0\.2 · fork forkabcd/)).toBeTruthy();
    expect(panel().getByText("worker died")).toBeTruthy();
    expect(panel().getByText("Guest")).toBeTruthy();
    fireEvent.click(panel().getByRole("button", { name: "open task" }));
    expect(props.onOpenTask).toHaveBeenCalledWith("t9");
  });

  it("shows the empty hint and survives a failing requests call", async () => {
    requestsMock.mockRejectedValue(new Error("x"));
    await setup({ param: "share-1" }, [withLinks()]);
    expect(panel().getByText(/Questions and requests that arrive through this share/)).toBeTruthy();
  });

  it("streams the live text of a running request and clears it when it finishes", async () => {
    requestsMock.mockResolvedValue([shareRequest({ id: "r1", status: "running", answer: null, finishedAt: null })]);
    await setup({ param: "share-1" }, [withLinks()]);
    emitStream({ requestId: "r1", shareId: "share-1", kind: "text", text: "thinking " });
    emitStream({ requestId: "r1", shareId: "share-1", kind: "text", text: "hard" });
    expect(panel().getByText("thinking hard")).toBeTruthy();
    emitStream({ requestId: "r1", shareId: "share-1", kind: "tool", text: "Bash" });
    expect(panel().getByText("thinking hard")).toBeTruthy();
    emitStream({ requestId: "r1", shareId: "share-1", kind: "status", text: "running" });
    expect(panel().getByText("thinking hard")).toBeTruthy();
    listMock.mockClear();
    emitStream({ requestId: "r1", shareId: "share-1", kind: "status", text: "finished" });
    await flush();
    expect(panel().queryByText("thinking hard")).toBeNull();
    expect(listMock).toHaveBeenCalled();
    emitStream({ requestId: "r1", shareId: "share-1", kind: "text", text: "again" });
    emitStream({ requestId: "r1", shareId: "share-1", kind: "status", text: "error: boom" });
    await flush();
    expect(panel().queryByText("again")).toBeNull();
  });

  it("shows the link masked, copies it and the prompt, and the metadata", async () => {
    const share = withLinks({ repo: "api", sessionId: "s-1", note: "be kind", trust: "medium", expiresAt: null });
    const { props } = await setup({ param: share.id, sessions: { "s-1": sessionRecord({ sessionId: "s-1", title: "Origin run" }) } }, [share]);
    fireEvent.click(panel().getByRole("button", { name: "Details" }));
    expect(panel().getByText("http://127.0.0.1:4318/s/share-1?key=••••••••")).toBeTruthy();
    expect(panel().getByText("Medium · edits, no shell", { selector: "dd" })).toBeTruthy();
    expect(panel().getByText("api-ws / api", { selector: "dd" })).toBeTruthy();
    expect(panel().getByText("never (until revoked)")).toBeTruthy();
    expect(panel().getByText("Origin run")).toBeTruthy();
    expect(panel().getByText("be kind")).toBeTruthy();
    fireEvent.click(panel().getByRole("button", { name: /Copy$/ }));
    await flush();
    expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:4318/s/share-1?key=k-secret");
    expect(props.onNotice).toHaveBeenCalledWith("local link copied");
  });

  it("copies the prompt and reports it", async () => {
    const { props } = await setup({ param: "share-1" }, [withLinks()]);
    fireEvent.click(panel().getByRole("button", { name: "Details" }));
    fireEvent.click(panel().getByRole("button", { name: /Copy prompt/ }));
    await flush();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Trust is read-only"));
    expect(props.onNotice).toHaveBeenCalledWith("prompt copied");
    const textarea = panel().getByDisplayValue(/Trust is read-only/) as HTMLTextAreaElement;
    fireEvent.focus(textarea);
  });

  it("shows fallbacks for an unknown origin session and no note", async () => {
    await setup({ param: "share-1" }, [withLinks({ sessionId: "unknown-session-id" })]);
    fireEvent.click(panel().getByRole("button", { name: "Details" }));
    expect(panel().getByText("unknown-")).toBeTruthy();
    expect(panel().getByText("—")).toBeTruthy();
  });

  it("answers from a fresh context when no session is pinned", async () => {
    await setup({ param: "share-1" }, [withLinks()]);
    fireEvent.click(panel().getByRole("button", { name: "Details" }));
    expect(panel().getByText("fresh context of the workspace", { selector: "dd" })).toBeTruthy();
  });

  it("falls back to a manual copy dialog when the clipboard fails", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    await setup({ param: "share-1" }, [withLinks()]);
    fireEvent.click(panel().getByRole("button", { name: "Details" }));
    fireEvent.click(panel().getByRole("button", { name: /Copy$/ }));
    await flush();
    const dialog = screen.getByRole("dialog", { name: "Copy manually" });
    expect(within(dialog).getByText("http://127.0.0.1:4318/s/share-1?key=k-secret")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Copy manually" })).toBeNull();
    fireEvent.click(panel().getByRole("button", { name: /Copy$/ }));
    await flush();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Copy manually" })).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Copy manually" })).toBeNull();
  });

  it("lists, hides and reports errors for the files", async () => {
    filesMock.mockResolvedValueOnce([{ name: "a.md", size: 2048, modifiedAt: NOW, direction: "out" }]);
    const { props } = await setup({ param: "share-1" }, [withLinks()]);
    fireEvent.click(panel().getByRole("button", { name: "Details" }));
    fireEvent.click(panel().getByRole("button", { name: "Show files" }));
    await flush();
    expect(panel().getByRole("button", { name: "Hide files (1)" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "a.md" })).toBeTruthy();
    fireEvent.click(panel().getByRole("button", { name: /Hide files/ }));
    expect(screen.queryByRole("link", { name: "a.md" })).toBeNull();
    filesMock.mockRejectedValueOnce(new Error("no folder"));
    fireEvent.click(panel().getByRole("button", { name: "Show files" }));
    await flush();
    expect(props.onError).toHaveBeenCalledWith("no folder");
    filesMock.mockRejectedValueOnce("odd");
    fireEvent.click(panel().getByRole("button", { name: /Show files|Hide files/ }));
    await flush();
  });

  it("loads the handoff document, copies it and reports a failure", async () => {
    docMock.mockResolvedValueOnce("# Handoff text");
    const { props } = await setup({ param: "share-1" }, [withLinks()]);
    fireEvent.click(panel().getByRole("button", { name: "Details" }));
    fireEvent.click(panel().getByRole("button", { name: "Load handoff .md" }));
    await flush();
    const area = panel().getByDisplayValue("# Handoff text") as HTMLTextAreaElement;
    fireEvent.focus(area);
    fireEvent.click(panel().getByRole("button", { name: /Copy handoff/ }));
    await flush();
    expect(writeText).toHaveBeenCalledWith("# Handoff text");
    expect(props.onNotice).toHaveBeenCalledWith("handoff copied");
    docMock.mockRejectedValueOnce(new Error("expired"));
    fireEvent.click(panel().getByRole("button", { name: "Load handoff .md" }));
    await flush();
    expect(props.onError).toHaveBeenCalledWith("expired");
    docMock.mockRejectedValueOnce("odd");
    fireEvent.click(panel().getByRole("button", { name: "Load handoff .md" }));
    await flush();
    expect(props.onError).toHaveBeenLastCalledWith("handoff unavailable");
  });

  it("disables copy and handoff for an inactive share", async () => {
    await setup({ param: "share-1" }, [withLinks({ active: false, state: "paused", paused: true })]);
    fireEvent.click(panel().getByRole("button", { name: "Details" }));
    expect((panel().getByRole("button", { name: /Copy$/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((panel().getByRole("button", { name: "Load handoff .md" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows no panel when the param points at an unknown share", async () => {
    await setup({ param: "ghost" }, [withLinks()]);
    expect(host.querySelector("[role='dialog']")).toBeNull();
  });
});

describe("ShareView actions", () => {
  const openActions = async (share: ShareRecord) => {
    const view = await setup({ param: share.id }, [share]);
    fireEvent.click(panel().getByRole("button", { name: "Actions" }));
    return view;
  };

  it("pauses an active share and reloads", async () => {
    const { props } = await openActions(shareRecord());
    fireEvent.click(panel().getByRole("button", { name: "Pause" }));
    await flush();
    expect(updateMock).toHaveBeenCalledWith("share-1", { paused: true });
    expect(props.onNotice).toHaveBeenCalledWith("share paused");
  });

  it("resumes a paused share", async () => {
    const { props } = await openActions(shareRecord({ state: "paused", paused: true, active: false }));
    fireEvent.click(panel().getByRole("button", { name: "Resume" }));
    await flush();
    expect(updateMock).toHaveBeenCalledWith("share-1", { paused: false });
    expect(props.onNotice).toHaveBeenCalledWith("share resumed");
  });

  it("rotates the key after confirming", async () => {
    const { props } = await openActions(shareRecord());
    fireEvent.click(panel().getByRole("button", { name: "New key" }));
    const dialog = screen.getByRole("dialog", { name: "Rotate the key for Ana doubts?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(updateMock).not.toHaveBeenCalled();
    fireEvent.click(panel().getByRole("button", { name: "New key" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Rotate the key for Ana doubts?" })).getByRole("button", { name: "Rotate key" }));
    await flush();
    expect(updateMock).toHaveBeenCalledWith("share-1", { rotate: true });
    expect(props.onNotice).toHaveBeenCalledWith("new key generated; the old link no longer works");
  });

  it("revokes with an inline confirmation and can cancel", async () => {
    const { props } = await openActions(shareRecord());
    fireEvent.click(panel().getByRole("button", { name: "Revoke" }));
    fireEvent.click(panel().getByRole("button", { name: "Cancel" }));
    expect(updateMock).not.toHaveBeenCalled();
    fireEvent.click(panel().getByRole("button", { name: "Revoke" }));
    fireEvent.click(panel().getByRole("button", { name: "Confirm revoke" }));
    await flush();
    expect(updateMock).toHaveBeenCalledWith("share-1", { revoke: true });
    expect(props.onNotice).toHaveBeenCalledWith("share revoked");
  });

  it("deletes a revoked share with an inline confirmation, closes the panel and reloads", async () => {
    const { props } = await openActions(shareRecord({ state: "revoked", active: false }));
    fireEvent.click(panel().getByRole("button", { name: "Delete" }));
    fireEvent.click(panel().getByRole("button", { name: "Cancel" }));
    expect(deleteMock).not.toHaveBeenCalled();
    fireEvent.click(panel().getByRole("button", { name: "Delete" }));
    fireEvent.click(panel().getByRole("button", { name: "Confirm delete" }));
    await flush();
    expect(deleteMock).toHaveBeenCalledWith("share-1");
    expect(props.onNotice).toHaveBeenCalledWith("share deleted");
    expect(location.hash).toBe("#/share");
  });

  it("reports update and delete failures", async () => {
    updateMock.mockRejectedValueOnce(new Error("conflict"));
    const { props } = await openActions(shareRecord());
    fireEvent.click(panel().getByRole("button", { name: "Pause" }));
    await flush();
    expect(props.onError).toHaveBeenCalledWith("conflict");
    updateMock.mockRejectedValueOnce("odd");
    fireEvent.click(panel().getByRole("button", { name: "Pause" }));
    await flush();
    expect(props.onError).toHaveBeenLastCalledWith("update failed");
  });

  it("reports delete failures from the panel", async () => {
    deleteMock.mockRejectedValueOnce(new Error("locked"));
    const { props } = await openActions(shareRecord({ state: "expired", active: false }));
    fireEvent.click(panel().getByRole("button", { name: "Delete" }));
    fireEvent.click(panel().getByRole("button", { name: "Confirm delete" }));
    await flush();
    expect(props.onError).toHaveBeenCalledWith("locked");
    deleteMock.mockRejectedValueOnce("odd");
    fireEvent.click(panel().getByRole("button", { name: "Delete" }));
    fireEvent.click(panel().getByRole("button", { name: "Confirm delete" }));
    await flush();
    expect(props.onError).toHaveBeenLastCalledWith("delete failed");
  });

  it("resets the inline confirmation when the share changes state", async () => {
    const props = baseProps();
    listMock.mockResolvedValue([shareRecord()]);
    const view = render(<ShareView {...props} param="share-1" />);
    await flush();
    fireEvent.click(panel().getByRole("button", { name: "Actions" }));
    fireEvent.click(panel().getByRole("button", { name: "Revoke" }));
    expect(panel().getByRole("button", { name: "Confirm revoke" })).toBeTruthy();
    listMock.mockResolvedValue([shareRecord({ state: "paused", paused: true, active: false })]);
    view.rerender(<ShareView {...props} param="share-1" tick={1} />);
    await flush();
    expect(panel().queryByRole("button", { name: "Confirm revoke" })).toBeNull();
    expect(panel().getByRole("button", { name: "Resume" })).toBeTruthy();
  });
});

describe("ShareView card actions", () => {
  const openCardMenu = () => fireEvent.click(screen.getByRole("button", { name: /^Actions for Ana doubts/ }));

  it("pauses and resumes from the card", async () => {
    const view = await setup({}, [shareRecord()]);
    openCardMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause" }));
    await flush();
    expect(updateMock).toHaveBeenCalledWith("share-1", { paused: true });
    view.unmount();
    await setup({}, [shareRecord({ state: "paused", paused: true, active: false })]);
    fireEvent.click(screen.getByRole("button", { name: /^Paused/ }));
    openCardMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Resume" }));
    await flush();
    expect(updateMock).toHaveBeenLastCalledWith("share-1", { paused: false });
  });

  it("asks for confirmation before revoking, rotating or deleting from the card", async () => {
    await setup({}, [shareRecord()]);
    openCardMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Revoke" }));
    const dialog = screen.getByRole("dialog", { name: "Revoke Ana doubts?" });
    expect(within(dialog).getByText("Stops the link right away. It cannot be undone.")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Revoke Ana doubts?" })).toBeNull();
    openCardMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Revoke" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Revoke Ana doubts?" })).getByRole("button", { name: "Revoke" }));
    await flush();
    expect(updateMock).toHaveBeenCalledWith("share-1", { revoke: true });
    openCardMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rotate key" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Rotate the key for Ana doubts?" })).getByRole("button", { name: "Rotate key" }));
    await flush();
    expect(updateMock).toHaveBeenCalledWith("share-1", { rotate: true });
  });

  it("deletes an expired share from the card after confirming", async () => {
    await setup({}, [shareRecord({ state: "expired", active: false })]);
    fireEvent.click(screen.getByRole("button", { name: /^Expired/ }));
    openCardMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: "Delete Ana doubts?" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete Ana doubts?" })).getByRole("button", { name: "Delete" }));
    await flush();
    expect(deleteMock).toHaveBeenCalledWith("share-1");
  });

  it("copies the link from the card and tells the user, or opens the manual dialog", async () => {
    const { props } = await setup({}, [shareRecord()]);
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));
    await flush();
    expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:4318/s/share-1?key=k-secret");
    expect(props.onNotice).toHaveBeenCalledWith("local link copied");
    writeText.mockRejectedValue(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));
    await flush();
    expect(screen.getByRole("dialog", { name: "Copy manually" })).toBeTruthy();
  });
});

