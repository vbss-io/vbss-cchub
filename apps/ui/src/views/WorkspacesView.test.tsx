import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import type { WorkspaceRecord } from "../delegation";
import { fullSettings } from "../test-support/u5-fixtures";
import { WorkspacesView } from "./WorkspacesView";

const api = vi.hoisted(() => ({
  createWorkspace: vi.fn<(name: string, repos: string[]) => Promise<unknown>>(),
  updateWorkspace: vi.fn<(name: string, repos: string[]) => Promise<unknown>>(),
  deleteWorkspace: vi.fn<(name: string, deleteContext: boolean) => Promise<unknown>>(),
  openWorkspace: vi.fn<(name: string) => Promise<unknown>>(),
}));

vi.mock("../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../delegation")>()), ...api }));

vi.mock("../components/CardMenu", () => ({
  useCardMenu: () => ({ anchor: null, open: false, openAt: () => undefined, openFromButton: () => undefined, close: () => undefined }),
  CardMenu: ({ items, label }: { items: { key: string; label: string; onSelect: () => void }[]; label: string }) => (
    <div role="group" aria-label={label}>
      {items.map((item) => (
        <button key={item.key} role="menuitem" onClick={item.onSelect}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("../components/WorkspaceContext", () => ({
  WorkspaceContext: ({ name, enabled, onChanged }: { name: string; enabled: boolean; onChanged: (enabled: boolean) => void }) => (
    <div data-testid={`context-${name}`} data-enabled={String(enabled)}>
      <button onClick={() => onChanged(!enabled)}>flip {name}</button>
    </div>
  ),
}));

const workspace = (name: string, overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord => ({
  name,
  file: `C:/ws/${name}.code-workspace`,
  contextPath: `C:/ws/${name}`,
  repos: [{ name: "api", path: "C:/code/api" }],
  error: null,
  ...overrides,
});

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.createWorkspace.mockResolvedValue(workspace("fresh"));
  api.updateWorkspace.mockResolvedValue(workspace("vbss"));
  api.deleteWorkspace.mockResolvedValue({ file: "f", contextPath: null, contextDeleted: false });
  api.openWorkspace.mockResolvedValue({ ok: true, error: null, command: "code" });
});

const setup = (props: Partial<Parameters<typeof WorkspacesView>[0]> = {}) => {
  const handlers = { onChanged: vi.fn(async () => undefined), onOpenSettings: vi.fn(), onNotice: vi.fn(), onError: vi.fn() };
  const view = render(<WorkspacesView workspaces={[workspace("vbss"), workspace("space", { contextPath: null, repos: [{ name: "a", path: "C:/a" }, { name: "b", path: "C:/b" }], error: "bad file" })]} settings={fullSettings()} enabled {...handlers} {...props} />);
  return { ...handlers, ...view };
};

const row = (name: string): HTMLElement => {
  const node = [...document.querySelectorAll<HTMLElement>(".wsrow")].find((item) => item.querySelector(".wsrow__name")?.textContent?.startsWith(name));
  if (!node) throw new Error(`no row ${name}`);
  return node;
};

test("lists each workspace with its repo count, context and unreadable marker, plus the root", () => {
  setup();
  expect(screen.getByText("C:/work/workspaces")).toBeTruthy();
  expect(within(row("vbss")).getByText("1 repo")).toBeTruthy();
  expect(within(row("vbss")).getByText("C:/ws/vbss")).toBeTruthy();
  expect(within(row("space")).getByText("2 repos")).toBeTruthy();
  expect(within(row("space")).getByText("no context folder")).toBeTruthy();
  expect(within(row("space")).getByText("unreadable")).toBeTruthy();
  expect(within(row("vbss")).queryByText("unreadable")).toBeNull();
});

test("the search narrows the list and says when nothing matches", async () => {
  setup();
  await userEvent.type(screen.getByRole("textbox", { name: "Search workspaces" }), "SPA");
  expect(document.querySelectorAll(".wsrow")).toHaveLength(1);
  await userEvent.type(screen.getByRole("textbox", { name: "Search workspaces" }), "zzz");
  expect(screen.getByText("No workspace matches this search.")).toBeTruthy();
});

test("Open runs the workspace, refreshes and shows the command used", async () => {
  const { onChanged, onNotice } = setup();
  await userEvent.click(within(row("vbss")).getByRole("button", { name: "Open" }));
  expect(api.openWorkspace).toHaveBeenCalledWith("vbss");
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Opening vbss with code."));
  expect(onChanged).toHaveBeenCalledTimes(1);
});

test("Open that the hub refuses reports the hub message or a default", async () => {
  api.openWorkspace.mockResolvedValueOnce({ ok: false, error: "editor missing", command: "code" }).mockResolvedValueOnce({ ok: false, error: null, command: "code" }).mockRejectedValueOnce("odd");
  const { onError, onNotice } = setup();
  await userEvent.click(within(row("vbss")).getByRole("button", { name: "Open" }));
  await waitFor(() => expect(onError).toHaveBeenLastCalledWith("editor missing"));
  await userEvent.click(within(row("vbss")).getByRole("button", { name: "Open" }));
  await waitFor(() => expect(onError).toHaveBeenLastCalledWith("could not open"));
  await userEvent.click(within(row("vbss")).getByRole("button", { name: "Open" }));
  await waitFor(() => expect(onError).toHaveBeenLastCalledWith("action failed"));
  expect(onNotice).not.toHaveBeenCalled();
});

test("the buttons lock while an action is running", async () => {
  let finish: (value: unknown) => void = () => undefined;
  api.openWorkspace.mockReturnValueOnce(new Promise((done) => (finish = done)));
  setup();
  await userEvent.click(within(row("vbss")).getByRole("button", { name: "Open" }));
  expect((within(row("space")).getByRole("button", { name: "Open" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "New workspace" }) as HTMLButtonElement).disabled).toBe(true);
  finish({ ok: true, error: null, command: "code" });
  await waitFor(() => expect((within(row("space")).getByRole("button", { name: "Open" }) as HTMLButtonElement).disabled).toBe(false));
});

test("Edit repos shows the repos and the paths, saves the edited list and closes", async () => {
  const { onNotice, onChanged } = setup();
  await userEvent.click(within(row("vbss")).getByRole("menuitem", { name: "Edit repos" }));
  expect(within(row("vbss")).getByText("C:/ws/vbss.code-workspace")).toBeTruthy();
  const area = within(row("vbss")).getByRole("textbox") as HTMLTextAreaElement;
  expect(area.value).toBe("C:/code/api");
  await userEvent.clear(area);
  await userEvent.type(area, "C:/code/web{enter}C:/code/api");
  await userEvent.click(within(row("vbss")).getByRole("button", { name: "Save repos" }));
  expect(api.updateWorkspace).toHaveBeenCalledWith("vbss", ["C:/code/web", "C:/code/api"]);
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Workspace vbss updated."));
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(within(row("vbss")).queryByRole("button", { name: "Save repos" })).toBeNull();
});

test("the editor can be closed from its button and from the menu, and only one is open at a time", async () => {
  setup();
  await userEvent.click(within(row("vbss")).getByRole("menuitem", { name: "Edit repos" }));
  await userEvent.click(within(row("space")).getByRole("menuitem", { name: "Edit repos" }));
  expect(within(row("vbss")).queryByRole("button", { name: "Save repos" })).toBeNull();
  expect((within(row("space")).getByRole("textbox") as HTMLTextAreaElement).value).toBe("C:/a\nC:/b");
  await userEvent.click(within(row("space")).getByRole("button", { name: "Close" }));
  expect(within(row("space")).queryByRole("textbox")).toBeNull();
  await userEvent.click(within(row("vbss")).getByRole("menuitem", { name: "Edit repos" }));
  await userEvent.click(within(row("vbss")).getByRole("menuitem", { name: "Close repos editor" }));
  expect(within(row("vbss")).queryByRole("textbox")).toBeNull();
});

test("Session context toggles the context panel and reflects the hub's answer in the row", async () => {
  setup({ settings: fullSettings({ memory: { historyIndex: true, handoffWorkspaces: ["vbss"], summaryHeading: "Summary" } }) });
  expect(within(row("vbss")).getByText("session context on")).toBeTruthy();
  expect(within(row("space")).queryByText("session context on")).toBeNull();
  await userEvent.click(within(row("vbss")).getByRole("menuitem", { name: "Session context" }));
  expect(screen.getByTestId("context-vbss").getAttribute("data-enabled")).toBe("true");
  await userEvent.click(within(row("space")).getByRole("menuitem", { name: "Session context" }));
  expect(screen.queryByTestId("context-vbss")).toBeNull();
  await userEvent.click(within(row("space")).getByRole("button", { name: "flip space" }));
  expect(within(row("space")).getByText("session context on")).toBeTruthy();
  await userEvent.click(within(row("space")).getByRole("button", { name: "flip space" }));
  expect(within(row("space")).queryByText("session context on")).toBeNull();
  await userEvent.click(within(row("space")).getByRole("menuitem", { name: "Close session context" }));
  expect(screen.queryByTestId("context-space")).toBeNull();
});

test("the context list follows a settings update and treats missing settings as empty", () => {
  const { rerender, ...rest } = setup({ settings: null });
  expect(document.querySelector(".wsrow__main .muted.small")).not.toBeNull();
  expect(screen.queryByText("session context on")).toBeNull();
  rerender(<WorkspacesView workspaces={[workspace("vbss")]} settings={fullSettings({ memory: { historyIndex: true, handoffWorkspaces: ["vbss"], summaryHeading: "Summary" } })} enabled onChanged={rest.onChanged} onOpenSettings={rest.onOpenSettings} onNotice={rest.onNotice} onError={rest.onError} />);
  expect(screen.getByText("session context on")).toBeTruthy();
});

test("Delete asks first, can be cancelled, and deletes with or without the context folder", async () => {
  const { onNotice } = setup();
  await userEvent.click(within(row("vbss")).getByRole("menuitem", { name: "Delete" }));
  const dialog = screen.getByRole("dialog", { name: "Delete workspace vbss?" });
  expect(within(dialog).getByText("Removes C:/ws/vbss.code-workspace. Repos are never touched.")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(api.deleteWorkspace).not.toHaveBeenCalled();
  await userEvent.click(within(row("vbss")).getByRole("menuitem", { name: "Delete" }));
  api.deleteWorkspace.mockResolvedValueOnce({ file: "f", contextPath: "C:/ws/vbss", contextDeleted: true });
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("checkbox", { name: "Also delete the context folder C:/ws/vbss" }));
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
  expect(api.deleteWorkspace).toHaveBeenCalledWith("vbss", true);
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Workspace vbss deleted with its context folder."));
  await userEvent.click(within(row("space")).getByRole("menuitem", { name: "Delete" }));
  expect(within(screen.getByRole("dialog")).queryByRole("checkbox")).toBeNull();
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
  expect(api.deleteWorkspace).toHaveBeenLastCalledWith("space", false);
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Workspace space deleted."));
});

test("New workspace opens a form, Create needs a name, trims it and clears the form after", async () => {
  const { onNotice, onChanged } = setup();
  await userEvent.click(screen.getByRole("button", { name: "New workspace" }));
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  await userEvent.type(screen.getByPlaceholderText("letters, digits, dots, dashes"), "  fresh ");
  await userEvent.type(screen.getByPlaceholderText(/C:\\code\\api/), "C:/code/one{enter}{enter}C:/code/two");
  await userEvent.click(create);
  expect(api.createWorkspace).toHaveBeenCalledWith("fresh", ["C:/code/one", "C:/code/two"]);
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Workspace fresh created with its context folder."));
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("heading", { name: "New workspace" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "New workspace" }));
  expect((screen.getByPlaceholderText("letters, digits, dots, dashes") as HTMLInputElement).value).toBe("");
});

test("a failed create reports the error and keeps the form", async () => {
  api.createWorkspace.mockRejectedValueOnce(new Error("name taken"));
  const { onError } = setup();
  await userEvent.click(screen.getByRole("button", { name: "New workspace" }));
  await userEvent.type(screen.getByPlaceholderText("letters, digits, dots, dashes"), "dup");
  await userEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("name taken"));
  expect(screen.getByRole("heading", { name: "New workspace" })).toBeTruthy();
});

test("without a workspaces root the user is sent to the settings and cannot create", async () => {
  const { onOpenSettings } = setup({ settings: fullSettings({ workspacesRoot: null }), workspaces: [] });
  expect(screen.getByText(/No workspaces root yet/)).toBeTruthy();
  expect(screen.queryByText(/^Root:/)).toBeNull();
  expect((screen.getByRole("button", { name: "New workspace" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/No workspaces in this root yet/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Settings › Paths" }));
  expect(onOpenSettings).toHaveBeenCalledTimes(1);
});

test("with a root but no workspaces the empty state invites creating one", () => {
  setup({ workspaces: [] });
  expect(screen.getByText("No workspaces in this root yet: press New workspace.")).toBeTruthy();
});

test("when the hub surface is off a banner explains it and the empty hints stay hidden", () => {
  setup({ enabled: false, workspaces: [] });
  expect(screen.getByText(/The hub surface is off on this server/)).toBeTruthy();
  expect(screen.queryByText(/No workspaces in this root yet/)).toBeNull();
});

test("the help toggletip explains the workspace layout", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "About workspaces" }));
  expect(screen.getByRole("status").textContent).toContain("Delegated runs start in the context with every repo attached");
});

test("the focused workspace is highlighted and scrolled into view once", () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  const { rerender, ...rest } = setup({ focusName: "space" });
  expect(row("space").className).toContain("wsrow--focus");
  expect(row("space").getAttribute("aria-current")).toBe("true");
  expect(row("vbss").getAttribute("aria-current")).toBeNull();
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  rerender(<WorkspacesView workspaces={[workspace("vbss"), workspace("space")]} settings={fullSettings()} enabled focusName="space" onChanged={rest.onChanged} onOpenSettings={rest.onOpenSettings} onNotice={rest.onNotice} onError={rest.onError} />);
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  rerender(<WorkspacesView workspaces={[workspace("vbss"), workspace("space")]} settings={fullSettings()} enabled focusName={null} onChanged={rest.onChanged} onOpenSettings={rest.onOpenSettings} onNotice={rest.onNotice} onError={rest.onError} />);
  rerender(<WorkspacesView workspaces={[workspace("vbss"), workspace("space")]} settings={fullSettings()} enabled focusName="vbss" onChanged={rest.onChanged} onOpenSettings={rest.onOpenSettings} onNotice={rest.onNotice} onError={rest.onError} />);
  expect(scrollIntoView).toHaveBeenCalledTimes(2);
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

test("a focus name for a workspace that does not exist scrolls nothing and an encoded name is decoded", () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  const first = setup({ focusName: "missing" });
  expect(scrollIntoView).not.toHaveBeenCalled();
  first.unmount();
  setup({ focusName: "my%20ws", workspaces: [workspace("my ws")] });
  expect(row("my ws").className).toContain("wsrow--focus");
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});
